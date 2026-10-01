//! Commits the data directory to git after writes settle.
//!
//! The point is off-site durability with history: each commit is a recoverable
//! snapshot of the whole store, so an old commit can be checked out and handed
//! to `obsydian-restore` as a data directory. (Point-in-time recovery *within*
//! a snapshot comes from the append-only journal and `--at-seq`, not from git.)
//!
//! Pushing to the GitLab mirror is a separate cron job, deliberately: a network
//! failure must never be able to fail a sync.

use crate::config::GitConfig;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};

const IGNORE_MARKER: &str = "# --- obsydian-sync (managed) ---";
const IGNORE_END_MARKER: &str = "# --- end obsydian-sync ---";
/// The rules that actually matter. Checked individually, because a marker
/// comment surviving a hand edit says nothing about whether the rules did.
const REQUIRED_RULES: [&str; 2] = [".*.tmp", "*.tmp"];

/// The managed .gitignore block, built from the constants above so the markers
/// and rules it writes cannot drift from the ones the repair checks for.
/// Appended rather than written wholesale, so an operator's own rules survive.
fn ignore_block() -> String {
    format!(
        "{IGNORE_MARKER}\n\
         # Interrupted blob uploads. Staging one would commit a partial file, and git\n\
         # history is immutable — a single interrupted 100 MiB upload would live in the\n\
         # repository and in the GitLab mirror forever.\n\
         {}\n\
         {IGNORE_END_MARKER}\n",
        REQUIRED_RULES.join("\n"),
    )
}

struct Inner {
    dir: PathBuf,
    /// Set once the repository is known good. Until then there is nothing safe
    /// to commit into — and committing in an un-initialized directory that sits
    /// inside an enclosing work tree would stage the whole vault into *that*
    /// repository.
    ready: AtomicBool,
    /// Set at shutdown so the debounce task does not start a commit that the
    /// runtime is about to be dropped out from under.
    stopping: AtomicBool,
    /// Serializes every git invocation. Two concurrent `git add` runs collide
    /// on `.git/index.lock`, and a lock left behind by a killed child disables
    /// the mirror permanently while syncs keep succeeding.
    lock: Mutex<()>,
}

/// `None` when mirroring is off, so the rest of the server never branches on it.
pub struct GitMirror(Option<(mpsc::Sender<()>, Arc<Inner>)>);

impl GitMirror {
    pub fn start(data_dir: &Path, config: &GitConfig) -> Self {
        if !config.enabled {
            return Self(None);
        }

        // Capacity 1: the message means "something changed", and a queue of
        // those carries no more information than one of them.
        let (tx, mut rx) = mpsc::channel::<()>(1);
        let inner = Arc::new(Inner {
            dir: data_dir.to_path_buf(),
            ready: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            lock: Mutex::new(()),
        });

        let task_inner = Arc::clone(&inner);
        let debounce = Duration::from_secs(config.debounce_secs);

        tokio::spawn(async move {
            {
                let _guard = task_inner.lock.lock().await;
                if let Err(e) = ensure_repo(&task_inner.dir).await {
                    tracing::error!(error = %e, "git mirror disabled: could not initialize the repository");
                    return;
                }
                tidy_repo(&task_inner.dir).await;
            }
            task_inner.ready.store(true, Ordering::SeqCst);

            while rx.recv().await.is_some() {
                // Let a burst of appends settle into one commit rather than
                // one commit per request.
                tokio::time::sleep(debounce).await;
                while rx.try_recv().is_ok() {}

                let _guard = task_inner.lock.lock().await;
                // Read under the lock: checking first and locking second leaves
                // a window where flush() has already returned and the runtime is
                // about to be dropped, killing this commit part-way and leaving
                // a stale .git/index.lock that disables the mirror for good.
                if task_inner.stopping.load(Ordering::SeqCst) {
                    return;
                }

                match commit(&task_inner.dir).await {
                    Ok(true) => tracing::info!("committed vault changes"),
                    Ok(false) => tracing::debug!("nothing to commit"),
                    Err(e) => tracing::error!(error = %e, "git commit failed"),
                }
            }
        });

        Self(Some((tx, inner)))
    }

    /// Signals that the data directory changed.
    ///
    /// Never blocks and never fails a request: a full channel already means a
    /// commit is coming, and a broken mirror must not stop the vault working.
    pub fn notify(&self) {
        if let Some((tx, _)) = &self.0 {
            let _ = tx.try_send(());
        }
    }

    /// Commits immediately, for shutdown.
    ///
    /// Without this, anything written inside the debounce window is lost when
    /// the container stops — and docker's default 10s stop timeout is shorter
    /// than the 30s debounce, so that is the common case rather than a rare one.
    pub async fn flush(&self) {
        let Some((_, inner)) = &self.0 else { return };

        inner.stopping.store(true, Ordering::SeqCst);

        // Take the lock first. The task holds it while initializing, so this
        // also waits out ensure_repo — otherwise a SIGTERM arriving during
        // startup would read ready == false and silently skip the commit.
        let _guard = inner.lock.lock().await;

        if !inner.ready.load(Ordering::SeqCst) {
            // The repository genuinely never initialized; nothing to commit into.
            return;
        }

        match commit(&inner.dir).await {
            Ok(true) => tracing::info!("committed pending changes before shutdown"),
            Ok(false) => {}
            Err(e) => tracing::error!(error = %e, "final commit failed"),
        }
    }
}

async fn ensure_repo(dir: &Path) -> anyhow::Result<()> {
    if is_repo(dir).await {
        return Ok(());
    }

    let git_dir = dir.join(".git");
    if git_dir.exists() {
        // Checking that `.git` *exists* is not enough. An interrupted `git init`
        // — a startup that fails moments after spawning it — leaves an empty
        // `.git` behind, and a check for existence then skips the init and lets
        // every commit fail forever, visible only in the logs.
        //
        // Empty is safe to redo: there is nothing in it to lose. Anything else
        // that is not a valid repository is left alone, because it might be
        // someone's data, and deleting it to make room is not this code's call.
        let empty = std::fs::read_dir(&git_dir)?.next().is_none();
        anyhow::ensure!(
            empty,
            "{} exists but is not a git repository; leaving it alone. Move it aside to let the mirror start.",
            git_dir.display()
        );
        tracing::warn!(dir = %git_dir.display(), "found an empty .git left by an interrupted init; re-initializing");
        std::fs::remove_dir(&git_dir)?;
    }

    run(dir, &["init", "--quiet", "--initial-branch=main"]).await?;
    tracing::info!(dir = %dir.display(), "initialized the mirror repository");
    Ok(())
}

async fn is_repo(dir: &Path) -> bool {
    git(dir)
        .args(["rev-parse", "--git-dir"])
        .output()
        .await
        .is_ok_and(|o| o.status.success())
}

/// A git command bound to the store's own repository.
///
/// GIT_DIR and GIT_WORK_TREE are explicit so git never goes looking upward. With
/// discovery left on, a store without a valid `.git` that happened to sit inside
/// some other repository would commit the whole encrypted vault into *that* one.
fn git(dir: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(dir)
        .env("GIT_DIR", dir.join(".git"))
        .env("GIT_WORK_TREE", dir);
    cmd
}

/// Best-effort housekeeping on an existing repository.
///
/// Deliberately infallible: a root-owned .gitignore restored from a backup must
/// not disable mirroring altogether, because `notify()` would keep succeeding
/// and nothing would ever say the mirror had stopped advancing.
async fn tidy_repo(dir: &Path) {
    let ignore = dir.join(".gitignore");
    let current = std::fs::read_to_string(&ignore).unwrap_or_default();

    // Keyed on the rules, not just the marker: a hand edit or a bad merge can
    // leave the header in place with the rules gone, and then interrupted
    // uploads start landing in immutable history.
    let rules_present = REQUIRED_RULES
        .iter()
        .all(|rule| current.lines().any(|line| line.trim() == *rule));

    if !rules_present {
        let lines: Vec<&str> = current.lines().collect();

        // Drop a previous managed block so repeated repairs do not stack up —
        // but only if it is *complete*. A header whose end marker was lost to a
        // hand edit must not swallow every rule after it, which is precisely
        // the file this repair exists to rescue.
        let start = lines.iter().position(|l| l.trim() == IGNORE_MARKER);
        let end = start.and_then(|s| {
            lines[s..]
                .iter()
                .position(|l| l.trim() == IGNORE_END_MARKER)
                .map(|offset| s + offset)
        });

        let mut next = String::new();
        for (i, line) in lines.iter().enumerate() {
            if let (Some(s), Some(e)) = (start, end) {
                if i >= s && i <= e {
                    continue;
                }
            }
            next.push_str(line);
            next.push('\n');
        }
        next.push_str(&ignore_block());

        if let Err(e) = std::fs::write(&ignore, next) {
            tracing::warn!(error = %e, "could not update .gitignore; temp files may be committed");
        }
    }

    // An ignore rule does not untrack a file that is already tracked, so a temp
    // file committed by an earlier version would keep being pushed forever.
    //
    // `-z` because git C-quotes non-ASCII paths by default and splits on
    // newlines, and a path that survives neither would silently never be
    // untracked — which is the one thing this block exists to prevent.
    if let Ok(output) = git(dir)
        .args(["ls-files", "-z", "--", "*.tmp", ".*.tmp"])
        .output()
        .await
    {
        // Kept as raw bytes: a filename is not required to be UTF-8, and
        // lossy-decoding one turns it into U+FFFD, which then matches nothing
        // and fails the whole batch — leaving the temp file tracked forever.
        let tracked: Vec<std::ffi::OsString> = output
            .stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(os_string_from_bytes)
            .collect();

        if !tracked.is_empty() {
            tracing::warn!(count = tracked.len(), "untracking temp files committed by an earlier run");
            let status = git(dir)
                .args(["rm", "--cached", "--quiet", "--"])
                .args(&tracked)
                .output()
                .await;

            match status {
                Ok(out) if !out.status.success() => tracing::warn!(
                    stderr = %String::from_utf8_lossy(&out.stderr).trim(),
                    "could not untrack temp files"
                ),
                Err(e) => tracing::warn!(error = %e, "could not untrack temp files"),
                Ok(_) => {}
            }
        }
    }
}

#[cfg(unix)]
fn os_string_from_bytes(bytes: &[u8]) -> std::ffi::OsString {
    use std::os::unix::ffi::OsStringExt;
    std::ffi::OsString::from_vec(bytes.to_vec())
}

#[cfg(not(unix))]
fn os_string_from_bytes(bytes: &[u8]) -> std::ffi::OsString {
    std::ffi::OsString::from(String::from_utf8_lossy(bytes).into_owned())
}

/// Returns whether a commit was actually created.
async fn commit(dir: &Path) -> anyhow::Result<bool> {
    run(dir, &["add", "-A"]).await?;

    let status = git(dir)
        .args(["diff", "--cached", "--quiet"])
        .status()
        .await?;

    // `--quiet` exits 1 when there *are* staged changes.
    if status.success() {
        return Ok(false);
    }

    let message = format!(
        "sync {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );
    // Identity passed per-invocation rather than stored in the repo config, so
    // a repository created by anything other than this code still commits. A
    // missing identity would otherwise fail every commit while syncs kept
    // succeeding, and the mirror would silently never advance.
    run(
        dir,
        &[
            "-c",
            "user.email=obsydian-sync@localhost",
            "-c",
            "user.name=Obsydian Sync",
            "commit",
            "--quiet",
            "-m",
            &message,
        ],
    )
    .await?;
    Ok(true)
}

async fn run(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
    let output = git(dir)
        .args(args)
        .output()
        .await?;

    anyhow::ensure!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initializes_a_store_with_no_repository() {
        let dir = tempfile::TempDir::new().unwrap();
        ensure_repo(dir.path()).await.unwrap();
        assert!(is_repo(dir.path()).await);
    }

    #[tokio::test]
    async fn recovers_an_empty_git_dir_left_by_an_interrupted_init() {
        // The production failure: a startup that failed seconds after spawning
        // `git init` left `.git` created but empty, and every commit after that
        // failed with "not a git repository".
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();

        ensure_repo(dir.path()).await.unwrap();

        assert!(is_repo(dir.path()).await);
        std::fs::write(dir.path().join("journal.ndjson"), "{}\n").unwrap();
        assert!(commit(dir.path()).await.unwrap(), "a commit must now succeed");
    }

    #[tokio::test]
    async fn leaves_a_non_empty_invalid_git_dir_alone() {
        let dir = tempfile::TempDir::new().unwrap();
        let git_dir = dir.path().join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(git_dir.join("not-ours"), "something that should not be deleted").unwrap();

        assert!(ensure_repo(dir.path()).await.is_err());
        assert!(git_dir.join("not-ours").exists(), "must not delete what it does not understand");
    }

    #[tokio::test]
    async fn never_commits_into_an_enclosing_repository() {
        // A store inside another repository, with no repository of its own yet.
        let outer = tempfile::TempDir::new().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(outer.path())
            .status()
            .unwrap()
            .success());
        let store = outer.path().join("store");
        std::fs::create_dir(&store).unwrap();

        // Without explicit GIT_DIR, git would find the outer repository here.
        assert!(!is_repo(&store).await);

        ensure_repo(&store).await.unwrap();
        std::fs::write(store.join("journal.ndjson"), "{}\n").unwrap();
        commit(&store).await.unwrap();

        let outer_log = std::process::Command::new("git")
            .args(["log", "--oneline"])
            .current_dir(outer.path())
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&outer_log.stdout).trim().is_empty(),
            "the enclosing repository must have received no commits"
        );
    }
}
