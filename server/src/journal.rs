use crate::error::ApiResult;
use crate::ids::validate_id;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// One journal entry as stored and served. `payload` is opaque ciphertext;
/// the server has no way to read it and never tries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub seq: u64,
    pub device_id: String,
    pub entry_id: String,
    pub payload: String,
}

/// Append-only NDJSON log.
///
/// NDJSON rather than a database: appending a line is a single small write, a
/// truncated final line is detectable and discardable, and the file diffs
/// sanely in the git mirror.
pub struct Journal {
    path: PathBuf,
    state: std::sync::Mutex<State>,
}

struct State {
    head: u64,
    /// entryId -> seq, so a retried batch returns the original seq instead of
    /// appending a duplicate.
    seen: HashMap<String, u64>,
}

/// Serialised straight into the append response; it is exactly that shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appended {
    pub entry_id: String,
    pub seq: u64,
}

impl Journal {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let path = data_dir.join("journal.ndjson");
        let mut head = 0u64;
        let mut seen = HashMap::new();

        if path.exists() {
            let file = std::fs::File::open(&path)
                .with_context(|| format!("opening {}", path.display()))?;

            // Collect the non-empty lines first so "is this the last line?" is a
            // property of the data rather than a second pass over the file that
            // could count lines differently than this one did.
            let lines: Vec<String> = BufReader::new(file)
                .lines()
                .collect::<std::io::Result<Vec<_>>>()?
                .into_iter()
                .filter(|l| !l.trim().is_empty())
                .collect();

            let last = lines.len().saturating_sub(1);
            for (i, line) in lines.iter().enumerate() {
                match serde_json::from_str::<Entry>(line) {
                    Ok(entry) => {
                        head = head.max(entry.seq);
                        seen.insert(entry.entry_id, entry.seq);
                    }
                    Err(e) => {
                        // A torn *final* line is the expected shape of a crash
                        // mid-append: drop it and carry on. A corrupt line
                        // anywhere earlier means the journal has a hole, which
                        // is data loss — fail loudly rather than serve it.
                        anyhow::ensure!(
                            i == last,
                            "journal line {} is corrupt and is not the final line: {e}",
                            i + 1
                        );
                        tracing::warn!(line = i + 1, "discarding torn final journal line");
                    }
                }
            }
        }

        tracing::info!(head, entries = seen.len(), "journal opened");
        Ok(Self { path, state: std::sync::Mutex::new(State { head, seen }) })
    }

    pub fn head(&self) -> u64 {
        self.state.lock().expect("journal mutex poisoned").head
    }

    /// Appends a batch atomically with respect to other appends: seq numbers
    /// are assigned under one lock, so they are dense and strictly increasing.
    ///
    /// Note there is no compare-and-swap and no client-supplied expected head.
    /// The log is append-only and all conflict resolution is client-side
    /// (PROTOCOL.md §6), so two devices appending at once is not a conflict —
    /// each simply sees the other's entries on its next pull.
    pub fn append(&self, device_id: &str, entries: &[(String, String)]) -> ApiResult<Vec<Appended>> {
        for (entry_id, _) in entries {
            validate_id(entry_id, "entryId")?;
        }

        let mut state = self.state.lock().expect("journal mutex poisoned");

        let mut assigned = Vec::with_capacity(entries.len());
        let mut to_write = Vec::new();
        let mut next = state.head;
        // Ids assigned earlier in *this* batch. Without this, a batch carrying
        // the same entryId twice would append it twice and leave the on-disk
        // idempotency index pointing at the later of two seqs.
        let mut in_batch: HashMap<&str, u64> = HashMap::new();

        for (entry_id, payload) in entries {
            if let Some(&seq) = state.seen.get(entry_id).or_else(|| in_batch.get(entry_id.as_str())) {
                assigned.push(Appended { entry_id: entry_id.clone(), seq });
                continue;
            }
            next += 1;
            in_batch.insert(entry_id.as_str(), next);
            let entry = Entry {
                seq: next,
                device_id: device_id.to_owned(),
                entry_id: entry_id.clone(),
                payload: payload.clone(),
            };
            assigned.push(Appended { entry_id: entry_id.clone(), seq: next });
            to_write.push(entry);
        }

        if !to_write.is_empty() {
            let mut buf = Vec::new();
            for entry in &to_write {
                serde_json::to_writer(&mut buf, entry)?;
                buf.push(b'\n');
            }

            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;

            // Remember where the file ended, so a partial write can be undone.
            // Leaving partial bytes behind would let the next append reuse those
            // seq numbers, producing two entries with the same seq.
            let offset = file.metadata()?.len();

            if let Err(e) = file.write_all(&buf).and_then(|()| file.sync_data()) {
                tracing::error!(error = %e, offset, "append failed; truncating back");
                file.set_len(offset)?;
                let _ = file.sync_all();
                return Err(e.into());
            }

            // Only mutate in-memory state once the bytes are durably on disk,
            // so the journal and its index always agree.
            for entry in to_write {
                state.seen.insert(entry.entry_id, entry.seq);
                state.head = state.head.max(entry.seq);
            }
        }

        Ok(assigned)
    }

    /// Entries with `seq > since`, ascending, at most `limit`.
    ///
    /// This rescans the file each call. For a vault of this size that is
    /// microseconds, and it keeps the on-disk format the only source of truth.
    /// If it ever matters, the fix is an offset index, not a database.
    pub fn read_since(&self, since: u64, limit: usize) -> ApiResult<(Vec<Entry>, bool)> {
        let file = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
            Err(e) => return Err(e.into()),
        };

        let mut out = Vec::new();
        let mut more = false;
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Entry>(&line) else {
                continue; // torn final line; already warned about at open()
            };
            if entry.seq <= since {
                continue;
            }
            if out.len() == limit {
                more = true;
                break;
            }
            out.push(entry);
        }

        Ok((out, more))
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> String {
        format!("{:02x}{}", n, "0".repeat(30))
    }

    fn batch(ids: &[u8]) -> Vec<(String, String)> {
        ids.iter().map(|&n| (id(n), format!("payload-{n}"))).collect()
    }

    #[test]
    fn assigns_dense_increasing_sequence_numbers() {
        let dir = tempfile::TempDir::new().unwrap();
        let journal = Journal::open(dir.path()).unwrap();

        let a = journal.append("macbook", &batch(&[1, 2])).unwrap();
        assert_eq!(a.iter().map(|x| x.seq).collect::<Vec<_>>(), vec![1, 2]);

        let b = journal.append("iphone", &batch(&[3])).unwrap();
        assert_eq!(b[0].seq, 3);
        assert_eq!(journal.head(), 3);
    }

    #[test]
    fn a_retried_entry_id_returns_the_original_seq_and_appends_nothing() {
        let dir = tempfile::TempDir::new().unwrap();
        let journal = Journal::open(dir.path()).unwrap();

        journal.append("macbook", &batch(&[1, 2])).unwrap();
        let retry = journal.append("macbook", &batch(&[2, 3])).unwrap();

        assert_eq!(retry[0].seq, 2, "already-seen entry keeps its seq");
        assert_eq!(retry[1].seq, 3, "new entry gets the next seq");
        assert_eq!(journal.head(), 3, "no duplicate was appended");

        let (entries, _) = journal.read_since(0, 100).unwrap();
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn read_since_returns_only_later_entries_in_order() {
        let dir = tempfile::TempDir::new().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        journal.append("macbook", &batch(&[1, 2, 3])).unwrap();

        let (entries, more) = journal.read_since(1, 100).unwrap();
        assert_eq!(entries.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(!more);
    }

    #[test]
    fn read_since_pages_and_reports_more() {
        let dir = tempfile::TempDir::new().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        journal.append("macbook", &batch(&[1, 2, 3])).unwrap();

        let (entries, more) = journal.read_since(0, 2).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(more);

        let (rest, more) = journal.read_since(entries.last().unwrap().seq, 2).unwrap();
        assert_eq!(rest.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![3]);
        assert!(!more);
    }

    #[test]
    fn reading_an_empty_journal_yields_nothing_rather_than_failing() {
        let dir = tempfile::TempDir::new().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let (entries, more) = journal.read_since(0, 100).unwrap();
        assert!(entries.is_empty());
        assert!(!more);
        assert_eq!(journal.head(), 0);
    }

    #[test]
    fn state_survives_reopening() {
        let dir = tempfile::TempDir::new().unwrap();
        {
            let journal = Journal::open(dir.path()).unwrap();
            journal.append("macbook", &batch(&[1, 2])).unwrap();
        }
        let reopened = Journal::open(dir.path()).unwrap();
        assert_eq!(reopened.head(), 2);

        // The idempotency index must survive too, or a retry after a restart
        // would duplicate the entry.
        let retry = reopened.append("macbook", &batch(&[2])).unwrap();
        assert_eq!(retry[0].seq, 2);
        assert_eq!(reopened.head(), 2);
    }

    #[test]
    fn a_torn_final_line_is_discarded_on_open() {
        let dir = tempfile::TempDir::new().unwrap();
        {
            let journal = Journal::open(dir.path()).unwrap();
            journal.append("macbook", &batch(&[1])).unwrap();
        }
        // Simulate a crash midway through writing the second entry.
        let path = dir.path().join("journal.ndjson");
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(br#"{"seq":2,"deviceId":"iph"#).unwrap();
        drop(f);

        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.head(), 1, "torn line ignored");

        // And the next append reuses seq 2, since nothing valid claimed it.
        let next = journal.append("iphone", &batch(&[2])).unwrap();
        assert_eq!(next[0].seq, 2);
    }

    #[test]
    fn a_duplicate_entry_id_within_one_batch_is_appended_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let journal = Journal::open(dir.path()).unwrap();

        let dup = vec![(id(1), "a".to_string()), (id(1), "b".to_string()), (id(2), "c".to_string())];
        let out = journal.append("macbook", &dup).unwrap();

        assert_eq!(out[0].seq, 1);
        assert_eq!(out[1].seq, 1, "the repeat resolves to the same seq");
        assert_eq!(out[2].seq, 2);
        assert_eq!(journal.head(), 2);

        let (entries, _) = journal.read_since(0, 100).unwrap();
        assert_eq!(entries.len(), 2, "only two lines were written");

        // And the on-disk index must agree after a restart, or a later retry
        // would resolve to the wrong seq.
        assert_eq!(Journal::open(dir.path()).unwrap().head(), 2);
    }

    #[test]
    fn a_corrupt_line_that_is_not_last_is_fatal() {
        let dir = tempfile::TempDir::new().unwrap();
        {
            let journal = Journal::open(dir.path()).unwrap();
            journal.append("macbook", &batch(&[1, 2])).unwrap();
        }
        // Corrupt the *first* line: a hole in the middle of the log, not a
        // torn tail. Serving this would silently drop an operation.
        let path = dir.path().join("journal.ndjson");
        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<&str> = text.lines().collect();
        lines[0] = "{ truncated garbage";
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let err = match Journal::open(dir.path()) {
            Err(e) => e,
            Ok(_) => panic!("a hole in the middle of the log must not open cleanly"),
        };
        assert!(
            err.to_string().contains("not the final line"),
            "expected a fatal corruption error, got: {err}"
        );
    }

    #[test]
    fn blank_lines_do_not_make_a_corrupt_middle_line_look_final() {
        let dir = tempfile::TempDir::new().unwrap();
        {
            let journal = Journal::open(dir.path()).unwrap();
            journal.append("macbook", &batch(&[1, 2, 3])).unwrap();
        }
        let path = dir.path().join("journal.ndjson");
        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
        lines.insert(0, String::new());
        lines[2] = "{ corrupt".to_string();
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        assert!(
            Journal::open(dir.path()).is_err(),
            "a corrupt middle line must not be mistaken for a torn tail"
        );
    }

    #[test]
    fn rejects_a_malformed_entry_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let bad = vec![("../traversal".to_string(), "payload".to_string())];
        assert!(journal.append("macbook", &bad).is_err());
    }
}
