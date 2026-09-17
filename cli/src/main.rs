//! obsydian-restore — decrypt a vault store back into plain files.
//!
//! This is the safety net that makes end-to-end encryption acceptable. Without
//! it, a plugin bug or a lost laptop turns the vault into noise. It reads the
//! server's data directory directly, so it works when the server does not: from
//! a filesystem backup, a git checkout of the GitLab mirror, or a copied folder.
//!
//! Run it as a drill from time to time. An untested backup is not a backup.

use obsydian_restore::{crypto, store};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(name = "obsydian-restore", about = "Decrypt an Obsydian Sync vault store", version)]
struct Cli {
    /// The server's data directory: the one holding meta.json and journal.ndjson.
    #[arg(long, global = true, default_value = ".")]
    data_dir: PathBuf,

    /// Reconstruct the vault as it was at this journal sequence number.
    #[arg(long, global = true)]
    at_seq: Option<u64>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List the files the vault contains, without writing anything.
    List,
    /// Write the decrypted vault into a directory.
    Restore {
        /// Destination. Must be empty or not exist, unless --force.
        #[arg(long)]
        out: PathBuf,
        /// Write into a directory that already has contents.
        #[arg(long)]
        force: bool,
    },
    /// Check every file decrypts, without writing. The restore drill.
    Verify,
    /// Show what the store holds, without needing the passphrase.
    Info,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let store = store::Store::open(&cli.data_dir)?;
    let meta = store.meta()?;

    if matches!(cli.command, Command::Info) {
        let entries = store.journal()?;
        println!("vault id:    {}", meta.vault_id);
        println!("protocol:    {}", meta.protocol);
        println!("kdf:         {} x{}", meta.kdf.alg, meta.kdf.iterations);
        println!("initialized: {}", if meta.kdf_check.is_some() { "yes" } else { "no" });
        println!("entries:     {}", entries.len());
        println!("head seq:    {}", entries.last().map(|e| e.seq).unwrap_or(0));
        let devices: std::collections::BTreeSet<_> =
            entries.iter().map(|e| e.device_id.as_str()).collect();
        println!("devices:     {}", devices.into_iter().collect::<Vec<_>>().join(", "));
        return Ok(());
    }

    let Some(kdf_check) = meta.kdf_check.as_deref() else {
        bail!("this vault was never initialized: there is no passphrase and nothing to decrypt");
    };

    crypto::check_kdf_supported(&meta.kdf.alg)?;

    let passphrase = read_passphrase()?;

    use base64::Engine as _;
    let salt = base64::engine::general_purpose::STANDARD
        .decode(&meta.kdf.salt)
        .context("meta.json has a malformed kdf salt")?;

    eprintln!("Deriving key ({} iterations)...", meta.kdf.iterations);
    let master = crypto::derive_master_key(&passphrase, &salt, meta.kdf.iterations);
    let keys = crypto::derive_keys(&master);

    if !crypto::verify_kdf_check(&keys, &meta.vault_id, kdf_check)? {
        bail!(
            "that passphrase does not open this vault.\n\
             There is no recovery path: the passphrase is the only thing that can decrypt it."
        );
    }

    let entries = store.journal()?;
    let index = store::replay(&entries, &keys, cli.at_seq)?;

    let mut paths: Vec<_> = index.iter().collect();
    paths.sort_by(|a, b| a.0.cmp(b.0));

    match cli.command {
        Command::Info => unreachable!("handled above"),

        Command::List => {
            for (path, state) in &paths {
                println!("{:>10}  seq {:<6}  {}", state.size, state.seq, path);
            }
            eprintln!("\n{} files", paths.len());
        }

        Command::Verify => {
            let mut missing = 0usize;
            let mut undecryptable = 0usize;
            let mut mismatched = 0usize;

            for (path, state) in &paths {
                match store.blob(&state.blob_id)? {
                    None => {
                        println!("MISSING BLOB  {path}");
                        missing += 1;
                    }
                    Some(sealed) => {
                        match crypto::unseal(
                            &keys.content,
                            &sealed,
                            &crypto::aad_for_blob(&state.blob_id),
                        ) {
                            Ok(plain) => {
                                if plain.len() as u64 != state.size {
                                    println!(
                                        "SIZE MISMATCH {path} (journal says {}, blob is {})",
                                        state.size,
                                        plain.len()
                                    );
                                    mismatched += 1;
                                }
                            }
                            Err(e) => {
                                println!("CANNOT DECRYPT {path}: {e}");
                                undecryptable += 1;
                            }
                        }
                    }
                }
            }

            eprintln!("\n{} files checked", paths.len());
            if missing > 0 || undecryptable > 0 || mismatched > 0 {
                // The exit status is what a scripted drill checks, so every
                // kind of damage has to reach it.
                bail!("{missing} missing, {undecryptable} undecryptable, {mismatched} wrong size");
            }
            eprintln!("All files decrypt and match their recorded size.");
        }

        Command::Restore { out, force } => {
            if out.exists() && !force {
                let empty = std::fs::read_dir(&out)?.next().is_none();
                anyhow::ensure!(
                    empty,
                    "{} is not empty. Restore into a scratch directory, or pass --force.",
                    out.display()
                );
            }
            std::fs::create_dir_all(&out)
                .with_context(|| format!("creating {}", out.display()))?;
            let out = out.canonicalize()?;

            let mut written = 0usize;
            let mut failed: Vec<String> = Vec::new();

            for (path, state) in &paths {
                // One unrestorable file must not cost the other 999. Collect
                // the failures and report them all at the end.
                match restore_one(&store, &keys, &out, path, state) {
                    Ok(()) => written += 1,
                    Err(e) => failed.push(format!("{path}: {e:#}")),
                }
            }

            eprintln!("Restored {written} files to {}", out.display());
            if !failed.is_empty() {
                eprintln!("\n{} files could not be restored:", failed.len());
                for f in &failed {
                    eprintln!("  {f}");
                }
                bail!("{} of {} files could not be restored", failed.len(), paths.len());
            }
        }
    }

    Ok(())
}

fn restore_one(
    store: &store::Store,
    keys: &crypto::VaultKeys,
    out: &Path,
    path: &str,
    state: &store::FileState,
) -> Result<()> {
    let relative = store::safe_relative_path(path)?;
    let target = out.join(&relative);

    let parent = target.parent().unwrap_or(out);
    std::fs::create_dir_all(parent)?;

    // Resolve the parent before writing. The component-by-component check
    // cannot see a symlink that already exists inside --out (possible under
    // --force), and a lexical comparison would happily follow it out of the
    // directory.
    let resolved = parent
        .canonicalize()
        .with_context(|| format!("resolving {}", parent.display()))?;
    anyhow::ensure!(
        store::is_under(out, &resolved),
        "path escapes the output directory via a symlink: {path}"
    );

    let sealed = store
        .blob(&state.blob_id)?
        .with_context(|| format!("blob {} is missing from the store", state.blob_id))?;
    let plain = crypto::unseal(&keys.content, &sealed, &crypto::aad_for_blob(&state.blob_id))
        .context("decrypting")?;

    std::fs::write(&target, &plain).with_context(|| format!("writing {}", target.display()))?;

    // Carry the recorded mtime across. Without it every restored file carries
    // the restore's wall-clock time, which loses real history and defeats the
    // plugin's (mtime, size) fast path on the next scan.
    if state.mtime > 0 {
        if let Ok(file) = std::fs::File::options().write(true).open(&target) {
            let when = std::time::UNIX_EPOCH + std::time::Duration::from_millis(state.mtime as u64);
            let _ = file.set_modified(when);
        }
    }

    Ok(())
}

/// Reads the passphrase without echoing it, or from stdin when piped.
fn read_passphrase() -> Result<String> {
    if let Ok(value) = std::env::var("OBSYDIAN_PASSPHRASE") {
        return Ok(value);
    }
    if std::io::stdin().is_terminal() {
        rpassword::prompt_password("Vault passphrase: ").context("reading passphrase")
    } else {
        // Piped: read one line, so `echo pw | obsydian-restore ...` works in a
        // scripted drill.
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        Ok(line.trim_end_matches(['\n', '\r']).to_string())
    }
}
