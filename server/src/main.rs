mod auth;
mod blobs;
mod config;
mod error;
mod gitmirror;
mod ids;
mod journal;
mod meta;
mod routes;

use anyhow::{Context, Result};
use config::Config;
use std::sync::{Arc, RwLock};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "obsydian_sync_server=info,tower_http=warn".into()),
        )
        .init();

    let mut args = std::env::args().skip(1);
    let config_path = match args.next() {
        Some(p) if p == "--hash-token" => {
            // Operator helper: turn a token into the digest for the config file.
            // Read from stdin rather than argv — an argument is visible in `ps`
            // to every local user and lands in shell history, which defeats the
            // point of storing only the digest.
            eprintln!("Reading token from stdin...");
            let mut token = String::new();
            std::io::stdin()
                .read_line(&mut token)
                .context("reading token from stdin")?;
            let token = token.trim_end_matches(['\n', '\r']);
            anyhow::ensure!(!token.is_empty(), "no token on stdin");
            println!("{}", auth::token_digest(token));
            return Ok(());
        }
        Some(p) => std::path::PathBuf::from(p),
        None => std::path::PathBuf::from("config.toml"),
    };

    let config = Config::load(&config_path)?;
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("creating data dir {}", config.data_dir.display()))?;

    let meta = meta::Meta::load_or_init(&config.data_dir)?;
    if meta.kdf_check.is_none() {
        tracing::warn!("vault is not initialized; the first client to connect will set the passphrase");
    }

    let journal = journal::Journal::open(&config.data_dir)?;
    let blobs = blobs::BlobStore::new(&config.data_dir)?;
    let bind = config.bind;

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding {bind}"))?;

    // Only once the port is ours. Started any earlier, a startup that is about
    // to fail spawns `git init` and then drops the runtime under it — which is
    // exactly how a deployment ended up with an empty `.git` and a mirror that
    // never committed.
    let git = gitmirror::GitMirror::start(&config.data_dir, &config.git);

    let state = Arc::new(routes::AppState {
        config,
        meta: RwLock::new(meta),
        journal,
        blobs,
        git,
    });

    let shutdown_state = state.clone();
    let app = routes::router(state).layer(tower_http::trace::TraceLayer::new_for_http());

    // The *resolved* address, not the configured one. With port 0 the config
    // says "0" and only the OS knows the answer, so logging the config value
    // would leave a caller no way to find the server it just started.
    let local = listener.local_addr().unwrap_or(bind);
    tracing::info!(%local, "obsydian-sync-server listening");

    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    // Requests have finished; commit anything still inside the debounce window.
    // Runs even when serve returned an error — that is a window's worth of
    // writes too, and `?` here would have discarded them.
    shutdown_state.git.flush().await;
    served?;
    Ok(())
}

/// Waits for SIGINT or SIGTERM.
///
/// SIGTERM is the one that matters in a container: `docker stop` sends it, the
/// process is PID 1 under an exec-form ENTRYPOINT, and Linux silently discards
/// signals PID 1 has no handler for. Without this, every restart waits out the
/// stop timeout and is then SIGKILLed — potentially mid-append, mid-rename, and
/// always discarding a pending git commit.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "could not listen for SIGTERM");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => tracing::info!("SIGINT; shutting down"),
            _ = term.recv() => tracing::info!("SIGTERM; shutting down"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutting down");
    }
}
