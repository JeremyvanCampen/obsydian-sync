//! End-to-end test of the restore path, against a store built from scratch.
//!
//! This is the drill the project depends on: if this test fails, an encrypted
//! vault is unrecoverable, and every other guarantee stops mattering.

use std::path::Path;
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_obsydian-restore");
const PASSPHRASE: &str = "correct horse battery staple";

/// Builds a vault store on disk the way the server would have written one.
mod fixture {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;

    const B64: base64::engine::general_purpose::GeneralPurpose =
        base64::engine::general_purpose::STANDARD;

    // The same code the CLI uses to read a store, used here to write one.
    pub use obsydian_restore::crypto::*;

    pub struct Built {
        pub dir: tempfile::TempDir,
    }

    /// The fixture's KDF parameters, named once: `keys()` and `build()` must
    /// agree, or a test forging a blob seals it under keys that do not open the
    /// store and fails for the wrong reason.
    const SALT: [u8; 32] = [7u8; 32];
    const ITERATIONS: u32 = 1000;

    /// The same keys the fixture sealed with, for tests that need to forge a blob.
    pub fn keys() -> VaultKeys {
        derive_keys(&derive_master_key(PASSPHRASE, &SALT, ITERATIONS))
    }

    pub fn build(files: &[(&str, &[u8])], deletions: &[&str]) -> Built {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();

        let (salt, iterations) = (SALT, ITERATIONS);
        let vault_id = "1600203ea33bc4d1be6641c1546be18b";
        let keys = keys();

        let check = seal_with_iv(
            &keys.check,
            KDF_CHECK_LITERAL.as_bytes(),
            &aad_for_kdf_check(vault_id),
            &[1u8; 12],
        )
        .unwrap();

        std::fs::write(
            root.join("meta.json"),
            serde_json::to_vec_pretty(&json!({
                "protocol": 1,
                "vaultId": vault_id,
                "kdf": { "alg": "PBKDF2-HMAC-SHA256", "salt": B64.encode(salt), "iterations": iterations },
                "kdfCheck": B64.encode(&check),
            }))
            .unwrap(),
        )
        .unwrap();

        let mut journal = String::new();
        let mut seq = 0u64;
        let mut iv_seed = 0u8;

        let append = |journal: &mut String, seq: &mut u64, iv_seed: &mut u8, payload: serde_json::Value| {
            *seq += 1;
            *iv_seed = iv_seed.wrapping_add(1);
            let entry_id = format!("{:032x}", *seq);
            let sealed = seal_with_iv(
                &keys.meta,
                serde_json::to_string(&payload).unwrap().as_bytes(),
                &aad_for_journal("macbook", &entry_id),
                &[*iv_seed; 12],
            )
            .unwrap();
            journal.push_str(&serde_json::to_string(&json!({
                "seq": *seq,
                "deviceId": "macbook",
                "entryId": entry_id,
                "payload": B64.encode(&sealed),
            }))
            .unwrap());
            journal.push('\n');
        };

        for (path, content) in files {
            let id = blob_id(&keys, content);
            let sealed = seal_with_iv(&keys.content, content, &aad_for_blob(&id), &[9u8; 12]).unwrap();

            // Through the CLI's own layout helper, so the fixture cannot drift.
            let blob_file = obsydian_restore::store::blob_path(root, &id).unwrap();
            std::fs::create_dir_all(blob_file.parent().unwrap()).unwrap();
            std::fs::write(&blob_file, &sealed).unwrap();

            append(
                &mut journal,
                &mut seq,
                &mut iv_seed,
                json!({ "op": "put", "path": path, "blobId": id, "size": content.len(), "mtime": 1757400000000i64 }),
            );
        }

        for path in deletions {
            append(
                &mut journal,
                &mut seq,
                &mut iv_seed,
                json!({ "op": "delete", "path": path, "mtime": 1757400001000i64 }),
            );
        }

        std::fs::write(root.join("journal.ndjson"), journal).unwrap();
        Built { dir }
    }
}

fn run(data_dir: &Path, args: &[&str], passphrase: Option<&str>) -> (bool, String, String) {
    let mut cmd = Command::new(BIN);
    cmd.arg("--data-dir").arg(data_dir).args(args);
    if let Some(p) = passphrase {
        cmd.env("OBSYDIAN_PASSPHRASE", p);
    }
    let out = cmd.stdin(Stdio::null()).output().expect("running obsydian-restore");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn restores_a_vault_to_plain_files() {
    let built = fixture::build(
        &[
            ("Work/Meetings/Standup.md", b"- TICKET-123 blocked\n"),
            ("Media/shot.png", &[0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]),
        ],
        &[],
    );
    let out = built.dir.path().join("restored");

    let (ok, _, stderr) = run(
        built.dir.path(),
        &["restore", "--out", out.to_str().unwrap()],
        Some(PASSPHRASE),
    );
    assert!(ok, "restore failed: {stderr}");

    assert_eq!(
        std::fs::read_to_string(out.join("Work/Meetings/Standup.md")).unwrap(),
        "- TICKET-123 blocked\n"
    );
    // Binary content must survive byte-for-byte: the vault holds PNGs.
    assert_eq!(
        std::fs::read(out.join("Media/shot.png")).unwrap(),
        vec![0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]
    );
}

#[test]
fn restores_an_empty_file() {
    // 28 bytes sealed: a 12-byte IV and a 16-byte tag with nothing between.
    // Rejecting that boundary would abort the restore of any vault holding an
    // empty note — the day-you-need-it failure this tool exists to prevent.
    let built = fixture::build(&[("empty.md", b""), ("other.md", b"content")], &[]);
    let out = built.dir.path().join("restored");

    let (ok, _, stderr) = run(built.dir.path(), &["restore", "--out", out.to_str().unwrap()], Some(PASSPHRASE));
    assert!(ok, "{stderr}");

    assert!(out.join("empty.md").exists());
    assert_eq!(std::fs::read(out.join("empty.md")).unwrap().len(), 0);
    assert_eq!(std::fs::read_to_string(out.join("other.md")).unwrap(), "content");
}

#[test]
fn verify_accepts_an_empty_file() {
    let built = fixture::build(&[("empty.md", b"")], &[]);
    let (ok, stdout, stderr) = run(built.dir.path(), &["verify"], Some(PASSPHRASE));
    assert!(ok, "stdout: {stdout}\nstderr: {stderr}");
}

#[test]
fn refuses_a_kdf_it_does_not_implement() {
    // An older CLI against a future Argon2id vault must say so, not report a
    // correct passphrase as wrong in the middle of a recovery.
    let built = fixture::build(&[("a.md", b"one")], &[]);
    let meta_path = built.dir.path().join("meta.json");
    let text = std::fs::read_to_string(&meta_path).unwrap();
    std::fs::write(&meta_path, text.replace("PBKDF2-HMAC-SHA256", "Argon2id")).unwrap();

    let (ok, _, stderr) = run(built.dir.path(), &["list"], Some(PASSPHRASE));
    assert!(!ok);
    assert!(stderr.contains("Argon2id"), "got: {stderr}");
    assert!(stderr.contains("newer obsydian-restore"), "got: {stderr}");
}

#[test]
fn a_deleted_file_is_absent_from_the_restore() {
    let built = fixture::build(
        &[("keep.md", b"kept"), ("gone.md", b"deleted later")],
        &["gone.md"],
    );
    let out = built.dir.path().join("restored");

    let (ok, _, stderr) = run(built.dir.path(), &["restore", "--out", out.to_str().unwrap()], Some(PASSPHRASE));
    assert!(ok, "{stderr}");

    assert!(out.join("keep.md").exists());
    assert!(!out.join("gone.md").exists(), "a deleted note must not come back in a restore");
}

#[test]
fn at_seq_reconstructs_an_earlier_state() {
    // The case a mirror cannot serve: stepping back to before a deletion.
    let built = fixture::build(&[("keep.md", b"kept"), ("gone.md", b"deleted later")], &["gone.md"]);
    let out = built.dir.path().join("restored");

    let (ok, _, stderr) = run(
        built.dir.path(),
        &["--at-seq", "2", "restore", "--out", out.to_str().unwrap()],
        Some(PASSPHRASE),
    );
    assert!(ok, "{stderr}");

    assert!(out.join("gone.md").exists(), "at seq 2 the file still existed");
    assert_eq!(std::fs::read_to_string(out.join("gone.md")).unwrap(), "deleted later");
}

#[test]
fn verify_passes_on_a_healthy_store() {
    let built = fixture::build(&[("a.md", b"one"), ("b.md", b"two")], &[]);
    let (ok, _, stderr) = run(built.dir.path(), &["verify"], Some(PASSPHRASE));
    assert!(ok, "{stderr}");
    assert!(stderr.contains("All files decrypt"));
}

#[test]
fn verify_reports_a_missing_blob_rather_than_claiming_success() {
    let built = fixture::build(&[("a.md", b"one")], &[]);

    // Simulate bit-rot or a GC that removed too much.
    let blobs = built.dir.path().join("blobs");
    for entry in walk(&blobs) {
        std::fs::remove_file(entry).unwrap();
    }

    let (ok, stdout, _) = run(built.dir.path(), &["verify"], Some(PASSPHRASE));
    assert!(!ok, "verify must fail when content is missing");
    assert!(stdout.contains("MISSING BLOB"));
}

#[test]
fn a_wrong_passphrase_is_refused_clearly() {
    let built = fixture::build(&[("a.md", b"one")], &[]);
    let (ok, _, stderr) = run(built.dir.path(), &["list"], Some("wrong passphrase"));

    assert!(!ok);
    assert!(stderr.contains("does not open this vault"), "got: {stderr}");
    assert!(stderr.contains("no recovery path"), "the message must be honest about this");
}

#[test]
fn info_works_without_the_passphrase() {
    let built = fixture::build(&[("a.md", b"one"), ("b.md", b"two")], &[]);
    let (ok, stdout, stderr) = run(built.dir.path(), &["info"], None);

    assert!(ok, "{stderr}");
    assert!(stdout.contains("entries:     2"));
    assert!(stdout.contains("initialized: yes"));
    // And it must not leak what it cannot read.
    assert!(!stdout.contains("a.md"));
}

#[test]
fn refuses_to_restore_into_a_non_empty_directory() {
    let built = fixture::build(&[("a.md", b"one")], &[]);
    let out = built.dir.path().join("restored");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("existing.txt"), "do not clobber me").unwrap();

    let (ok, _, stderr) = run(built.dir.path(), &["restore", "--out", out.to_str().unwrap()], Some(PASSPHRASE));
    assert!(!ok);
    assert!(stderr.contains("not empty"));
    assert_eq!(std::fs::read_to_string(out.join("existing.txt")).unwrap(), "do not clobber me");
}

#[test]
fn verify_fails_when_a_blob_decrypts_to_the_wrong_size() {
    // Bit-rot that still decrypts: the exit status is what a scripted drill
    // checks, so a size mismatch has to reach it.
    let built = fixture::build(&[("a.md", b"one")], &[]);

    // Replace the blob with a *valid* sealing of different content under the
    // same id. It decrypts cleanly, so only the length check can catch it.
    let keys = fixture::keys();
    let id = fixture::blob_id(&keys, b"one");
    let forged = fixture::seal_with_iv(
        &keys.content,
        b"a much longer body than the journal records",
        &fixture::aad_for_blob(&id),
        &[3u8; 12],
    )
    .unwrap();
    let blob_path = obsydian_restore::store::blob_path(built.dir.path(), &id).unwrap();
    std::fs::write(&blob_path, forged).unwrap();

    let (ok, stdout, _) = run(built.dir.path(), &["verify"], Some(PASSPHRASE));
    assert!(!ok, "a size mismatch must fail the drill");
    assert!(stdout.contains("SIZE MISMATCH"));
}

#[test]
fn restores_the_recorded_modification_time() {
    // Otherwise every restored file carries the restore's wall-clock time,
    // losing real history and defeating the plugin's scan fast path.
    let built = fixture::build(&[("a.md", b"one")], &[]);
    let out = built.dir.path().join("restored");

    let (ok, _, stderr) = run(built.dir.path(), &["restore", "--out", out.to_str().unwrap()], Some(PASSPHRASE));
    assert!(ok, "{stderr}");

    let mtime = std::fs::metadata(out.join("a.md")).unwrap().modified().unwrap();
    let millis = mtime.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    assert_eq!(millis, 1757400000000i64);
}

#[test]
fn a_store_without_a_journal_is_reported_as_incomplete() {
    // "0 files, all good" on a half-copied backup is how a broken backup
    // passes a drill.
    let built = fixture::build(&[("a.md", b"one")], &[]);
    std::fs::remove_file(built.dir.path().join("journal.ndjson")).unwrap();

    let (ok, _, stderr) = run(built.dir.path(), &["verify"], Some(PASSPHRASE));
    assert!(!ok);
    assert!(stderr.contains("incomplete"), "got: {stderr}");
}

#[test]
fn one_unrestorable_file_does_not_abandon_the_rest() {
    let built = fixture::build(&[("a.md", b"one"), ("b.md", b"two"), ("c.md", b"three")], &[]);

    // Remove exactly one blob.
    let victim = walk(&built.dir.path().join("blobs")).into_iter().next().unwrap();
    std::fs::remove_file(&victim).unwrap();

    let out = built.dir.path().join("restored");
    let (ok, _, stderr) = run(built.dir.path(), &["restore", "--out", out.to_str().unwrap()], Some(PASSPHRASE));

    assert!(!ok, "the run must report failure");
    assert!(stderr.contains("could not be restored"));
    // ...but the other two files are on disk.
    assert_eq!(walk(&out).len(), 2);
}

#[test]
fn reports_a_directory_that_is_not_a_vault_store() {
    let dir = tempfile::TempDir::new().unwrap();
    let (ok, _, stderr) = run(dir.path(), &["info"], None);
    assert!(!ok);
    assert!(stderr.contains("does not look like a vault store"));
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}
