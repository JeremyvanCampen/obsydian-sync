use crate::error::ApiResult;
use crate::ids::validate_id;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Content-addressed store of sealed blobs.
///
/// Every id reaching this module has passed `validate_id`, so it is exactly 32
/// lowercase hex characters and cannot escape the store directory.
pub struct BlobStore {
    root: PathBuf,
    /// Uploads take this shared, a sweep exclusive, so no blob is written into a
    /// directory the sweep has already walked past. Owned by the store rather
    /// than by the HTTP layer so every caller of `put` and `gc` is covered, not
    /// just the routes that remembered to take it.
    sweep: RwLock<()>,
}

pub enum PutOutcome {
    Stored,
    AlreadyPresent,
}

#[derive(Debug, Default)]
pub struct GcOutcome {
    pub removed: usize,
    /// Unreferenced but too young to delete safely.
    pub spared: usize,
}

impl BlobStore {
    pub fn new(data_dir: &Path) -> std::io::Result<Self> {
        let root = data_dir.join("blobs");
        std::fs::create_dir_all(&root)?;
        Ok(Self { root, sweep: RwLock::new(()) })
    }

    /// Two levels of 2-hex-character fanout: 256 dirs of 256 dirs, so no
    /// directory grows large enough to slow down on any common filesystem.
    fn path_for(&self, id: &str) -> PathBuf {
        self.root.join(&id[0..2]).join(&id[2..4]).join(id)
    }

    pub fn has(&self, id: &str) -> ApiResult<bool> {
        validate_id(id, "blobId")?;
        Ok(self.path_for(id).exists())
    }

    pub fn get(&self, id: &str) -> ApiResult<Option<Vec<u8>>> {
        validate_id(id, "blobId")?;
        match std::fs::read(self.path_for(id)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Idempotent. An existing blob is left byte-for-byte alone: content
    /// addressing means a re-PUT carries the same bytes, and rewriting it could
    /// only ever turn a good blob into a torn one.
    pub fn put(&self, id: &str, bytes: &[u8]) -> ApiResult<PutOutcome> {
        validate_id(id, "blobId")?;
        let _upload = self.sweep.read().expect("blob sweep lock poisoned");
        let path = self.path_for(id);
        if path.exists() {
            return Ok(PutOutcome::AlreadyPresent);
        }
        let dir = path.parent().expect("blob path always has a parent");
        std::fs::create_dir_all(dir)?;

        // Write-then-rename: a reader never observes a partially written blob.
        let tmp = dir.join(format!(".{id}.tmp"));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
        Ok(PutOutcome::Stored)
    }

    /// Deletes every blob not named in `live`, except those younger than
    /// `grace`. See PROTOCOL.md §4 — liveness cannot be computed server-side,
    /// so the client supplies the set.
    ///
    /// The grace period closes an otherwise unfixable race. A client uploads a
    /// blob and only then appends the journal entry referencing it; a GC landing
    /// between those two requests would see an unreferenced blob and delete
    /// content that is about to become live. The journal-head check in the
    /// route cannot catch that, because the head has not moved yet. Skipping
    /// recently-written blobs does.
    pub fn gc(
        &self,
        live: &std::collections::HashSet<String>,
        grace: std::time::Duration,
    ) -> ApiResult<GcOutcome> {
        let _sweep = self.sweep.write().expect("blob sweep lock poisoned");
        let now = std::time::SystemTime::now();
        let mut outcome = GcOutcome::default();

        for blob in self.blob_files()? {
            let Some(name) = blob.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if live.contains(name) {
                continue;
            }
            let young = blob
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age < grace);
            if young {
                outcome.spared += 1;
                continue;
            }
            std::fs::remove_file(&blob)?;
            outcome.removed += 1;
        }
        Ok(outcome)
    }

    /// Counts real blobs, excluding interrupted uploads.
    pub fn count(&self) -> ApiResult<usize> {
        Ok(self.blob_files()?.len())
    }

    /// Every stored blob, excluding interrupted uploads. `gc` and `count` both
    /// go through this, so they agree on what a blob is by construction — if
    /// they disagreed, the empty-live-set guard could refuse a legitimate GC
    /// on a vault whose only remaining files are stale temporaries.
    fn blob_files(&self) -> std::io::Result<Vec<PathBuf>> {
        let mut out = Vec::new();
        for outer in read_subdirs(&self.root)? {
            for inner in read_subdirs(&outer)? {
                out.extend(read_dir_or_empty(&inner)?.into_iter().filter(|p| !is_temp(p)));
            }
        }
        Ok(out)
    }
}

/// True for the `.{id}.tmp` files `put` uses, which are not blobs.
fn is_temp(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_none_or(|n| n.starts_with('.'))
}

fn read_dir_or_empty(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    match std::fs::read_dir(path) {
        Ok(entries) => entries.map(|e| e.map(|e| e.path())).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Subdirectories only. A stray file at a fan-out level (a .gitkeep, a
/// misplaced temp) must not abort a sweep over the whole store.
fn read_subdirs(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    Ok(read_dir_or_empty(path)?
        .into_iter()
        .filter(|p| p.is_dir())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, BlobStore) {
        let dir = tempfile::TempDir::new().unwrap();
        let store = BlobStore::new(dir.path()).unwrap();
        (dir, store)
    }

    const ID_A: &str = "0123456789abcdef0123456789abcdef";
    const ID_B: &str = "fedcba9876543210fedcba9876543210";

    #[test]
    fn round_trips_bytes() {
        let (_d, store) = temp_store();
        store.put(ID_A, b"sealed bytes").unwrap();
        assert_eq!(store.get(ID_A).unwrap().unwrap(), b"sealed bytes");
        assert!(store.has(ID_A).unwrap());
    }

    #[test]
    fn reports_a_missing_blob_as_none_rather_than_erroring() {
        let (_d, store) = temp_store();
        assert!(store.get(ID_A).unwrap().is_none());
        assert!(!store.has(ID_A).unwrap());
    }

    #[test]
    fn put_is_idempotent_and_does_not_rewrite() {
        let (_d, store) = temp_store();
        assert!(matches!(store.put(ID_A, b"first").unwrap(), PutOutcome::Stored));
        assert!(matches!(store.put(ID_A, b"first").unwrap(), PutOutcome::AlreadyPresent));
        assert_eq!(store.get(ID_A).unwrap().unwrap(), b"first");
    }

    #[test]
    fn rejects_an_invalid_id_before_touching_the_filesystem() {
        let (_d, store) = temp_store();
        assert!(store.put("../escape", b"x").is_err());
        assert!(store.get("../escape").is_err());
    }

    #[test]
    fn gc_removes_only_blobs_absent_from_the_live_set() {
        let (_d, store) = temp_store();
        store.put(ID_A, b"keep").unwrap();
        store.put(ID_B, b"drop").unwrap();

        let live = std::collections::HashSet::from([ID_A.to_string()]);
        let out = store.gc(&live, std::time::Duration::ZERO).unwrap();
        assert_eq!(out.removed, 1);

        assert!(store.has(ID_A).unwrap());
        assert!(!store.has(ID_B).unwrap());
        assert_eq!(store.count().unwrap(), 1);
    }

    #[test]
    fn gc_spares_blobs_younger_than_the_grace_period() {
        let (_d, store) = temp_store();
        store.put(ID_A, b"just uploaded, journal entry still in flight").unwrap();

        let out = store
            .gc(&std::collections::HashSet::new(), std::time::Duration::from_secs(3600))
            .unwrap();

        assert_eq!(out.removed, 0);
        assert_eq!(out.spared, 1);
        assert!(store.has(ID_A).unwrap(), "an in-flight upload must survive gc");
    }

    #[test]
    fn count_ignores_interrupted_uploads() {
        let (dir, store) = temp_store();
        store.put(ID_A, b"real").unwrap();
        let stale = dir.path().join("blobs").join("ff").join("ee");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join(".{id}.tmp"), b"interrupted").unwrap();

        assert_eq!(store.count().unwrap(), 1, "temp files are not blobs");
    }

    #[test]
    fn a_stray_file_at_a_fanout_level_does_not_abort_the_sweep() {
        let (dir, store) = temp_store();
        store.put(ID_A, b"real").unwrap();
        std::fs::write(dir.path().join("blobs").join(".gitkeep"), b"").unwrap();

        assert_eq!(store.count().unwrap(), 1);
        let live = std::collections::HashSet::from([ID_A.to_string()]);
        assert!(store.gc(&live, std::time::Duration::ZERO).is_ok());
    }
}
