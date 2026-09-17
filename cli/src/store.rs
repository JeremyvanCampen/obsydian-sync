//! Reading a server data directory directly off disk.
//!
//! Deliberately does not speak HTTP: the whole point of this tool is to work
//! when the server does not — from a filesystem backup, a git checkout of the
//! GitLab mirror, or a copied folder.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub alg: String,
    pub salt: String,
    pub iterations: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub protocol: u32,
    pub vault_id: String,
    pub kdf: KdfParams,
    pub kdf_check: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub seq: u64,
    pub device_id: String,
    pub entry_id: String,
    pub payload: String,
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let meta = root.join("meta.json");
        if !meta.exists() {
            bail!(
                "{} does not look like a vault store: no meta.json.\n\
                 Point --data-dir at the server's data directory, or at a checkout of the mirror.",
                root.display()
            );
        }
        Ok(Self { root })
    }

    pub fn meta(&self) -> Result<Meta> {
        let path = self.root.join("meta.json");
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let meta: Meta =
            serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        anyhow::ensure!(
            meta.protocol == 1,
            "vault uses protocol {}, this tool understands 1",
            meta.protocol
        );
        Ok(meta)
    }

    /// Reads the journal in sequence order.
    ///
    /// A torn final line is dropped with a warning — that is what a crash
    /// mid-append leaves behind. A corrupt line anywhere earlier is fatal: it
    /// means an operation is missing, and a restore that silently skips one is
    /// worse than a restore that refuses.
    pub fn journal(&self) -> Result<Vec<Entry>> {
        let path = self.root.join("journal.ndjson");
        if !path.exists() {
            // Not the same as an empty vault. A store with meta.json but no
            // journal is a half-copied backup, and reporting "0 files, all
            // good" for one is how a broken backup passes a drill.
            bail!(
                "{} has meta.json but no journal.ndjson — the store is incomplete.\n\
                 An empty vault would still have the file.",
                self.root.display()
            );
        }

        let file = std::fs::File::open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        let lines: Vec<String> = BufReader::new(file)
            .lines()
            .collect::<std::io::Result<Vec<_>>>()?
            .into_iter()
            .filter(|l| !l.trim().is_empty())
            .collect();

        let last = lines.len().saturating_sub(1);
        let mut entries = Vec::with_capacity(lines.len());

        for (i, line) in lines.iter().enumerate() {
            match serde_json::from_str::<Entry>(line) {
                Ok(e) => entries.push(e),
                Err(e) => {
                    anyhow::ensure!(
                        i == last,
                        "journal line {} is corrupt and is not the final line: {e}",
                        i + 1
                    );
                    eprintln!("warning: ignoring torn final journal line");
                }
            }
        }

        entries.sort_by_key(|e| e.seq);
        Ok(entries)
    }

    pub fn blob(&self, blob_id: &str) -> Result<Option<Vec<u8>>> {
        anyhow::ensure!(
            blob_id.len() == 32 && blob_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "malformed blobId {blob_id:?}"
        );
        let path = self
            .root
            .join("blobs")
            .join(&blob_id[0..2])
            .join(&blob_id[2..4])
            .join(blob_id);

        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }
}

/// A decrypted journal operation. See PROTOCOL.md §5.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Payload {
    #[serde(rename_all = "camelCase")]
    Put {
        path: String,
        blob_id: String,
        size: u64,
        mtime: i64,
    },
    #[serde(rename_all = "camelCase")]
    Delete { path: String, mtime: i64 },
}

#[derive(Debug, Clone)]
pub struct FileState {
    pub blob_id: String,
    pub size: u64,
    pub mtime: i64,
    pub seq: u64,
}

/// Replays entries into the set of files present at that point.
///
/// Tombstones remove the path rather than being retained: unlike the plugin,
/// this tool only ever asks "what did the vault contain", never "what changed".
pub fn replay(entries: &[Entry], keys: &crate::crypto::VaultKeys, up_to: Option<u64>) -> Result<HashMap<String, FileState>> {
    let mut index: HashMap<String, FileState> = HashMap::new();

    for entry in entries {
        if let Some(limit) = up_to {
            if entry.seq > limit {
                break;
            }
        }

        let payload = decode(entry, keys)
            .with_context(|| format!("journal entry {} (from {})", entry.seq, entry.device_id))?;

        match payload {
            Payload::Put { path, blob_id, size, mtime } => {
                index.insert(path, FileState { blob_id, size, mtime, seq: entry.seq });
            }
            Payload::Delete { path, .. } => {
                index.remove(&path);
            }
        }
    }

    Ok(index)
}

pub fn decode(entry: &Entry, keys: &crate::crypto::VaultKeys) -> Result<Payload> {
    use base64::Engine as _;

    let sealed = base64::engine::general_purpose::STANDARD
        .decode(&entry.payload)
        .context("payload is not valid base64")?;

    let plain = crate::crypto::unseal(
        &keys.meta,
        &sealed,
        &crate::crypto::aad_for_journal(&entry.device_id, &entry.entry_id),
    )
    .context("could not decrypt — wrong passphrase, or the entry has been tampered with")?;

    serde_json::from_slice(&plain).context("decrypted payload is not a known operation")
}

/// Rejects anything that could escape the output directory.
///
/// Paths come from decrypted data, so they are as trustworthy as the vault
/// itself — but a restore writes wherever it is told, and "as trustworthy as"
/// is not a reason to skip the check.
pub fn safe_relative_path(path: &str) -> Result<PathBuf> {
    anyhow::ensure!(!path.is_empty(), "empty path in journal");
    anyhow::ensure!(!path.starts_with('/'), "absolute path in journal: {path}");
    anyhow::ensure!(!path.contains('\0'), "illegal NUL in path: {path}");

    let mut out = PathBuf::new();
    for part in path.split('/') {
        anyhow::ensure!(part != ".." && part != "." && !part.is_empty(), "unsafe path: {path}");
        // A backslash is an ordinary filename character on Linux and macOS, so
        // it must not be rejected outright — but it *is* a separator on
        // Windows, where it could carry a traversal through a single segment.
        #[cfg(windows)]
        anyhow::ensure!(
            !part.contains('\\'),
            "path segment would be a separator on this platform: {path}"
        );
        out.push(part);
    }
    Ok(out)
}

pub fn is_under(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_vault_paths() {
        assert!(safe_relative_path("Work/Meetings/Standup.md").is_ok());
        assert!(safe_relative_path("note.md").is_ok());
        assert!(safe_relative_path(".obsidian/app.json").is_ok());
    }

    #[test]
    fn rejects_escapes() {
        assert!(safe_relative_path("../outside.md").is_err());
        assert!(safe_relative_path("a/../../b.md").is_err());
        assert!(safe_relative_path("/etc/passwd").is_err());
        assert!(safe_relative_path("").is_err());
        assert!(safe_relative_path("a//b.md").is_err());
    }

    #[test]
    fn rejects_nulls() {
        assert!(safe_relative_path("a\0b.md").is_err());
    }

    #[test]
    fn allows_a_backslash_where_it_is_an_ordinary_character() {
        // Rejecting it outright would abort a whole restore over one oddly
        // named note. On Windows, where it is a separator, it is still refused.
        let result = safe_relative_path("notes/a\\b.md");
        if cfg!(windows) {
            assert!(result.is_err());
        } else {
            assert!(result.is_ok());
        }
    }
}
