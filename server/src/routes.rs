use crate::auth::authenticate;
use crate::blobs::{BlobStore, PutOutcome};
use crate::config::Config;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::ids::validate_id;
use crate::gitmirror::GitMirror;
use crate::journal::Journal;
use crate::meta::Meta;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};

pub struct AppState {
    pub config: Config,
    pub meta: RwLock<Meta>,
    pub journal: Journal,
    pub blobs: BlobStore,
    pub git: GitMirror,
}

pub type Shared = Arc<AppState>;

pub fn router(state: Shared) -> Router {
    let limits = &state.config.limits;
    let max_blob = limits.max_blob_bytes;

    // axum defaults to a 2 MB body limit, well under a legal maximum batch.
    // Without this, an oversized batch is rejected by the Json extractor with a
    // plain-text 413 that clients cannot parse, before max_batch_entries or
    // max_payload_bytes is ever consulted.
    let max_journal_body = limits
        .max_batch_entries
        .saturating_mul(limits.max_payload_bytes)
        .saturating_add(64 * 1024); // JSON framing around the payloads

    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/meta", get(get_meta))
        .route("/v1/meta/init", post(init_meta))
        .route(
            "/v1/journal",
            get(get_journal).post(post_journal)
                .layer(axum::extract::DefaultBodyLimit::max(max_journal_body)),
        )
        .route(
            "/v1/blob/{id}",
            get(get_blob).head(head_blob).put(put_blob)
                .layer(axum::extract::DefaultBodyLimit::max(max_blob)),
        )
        .route("/v1/gc", post(post_gc))
        .with_state(state)
}

// --- meta -----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetaResponse {
    protocol: u32,
    vault_id: String,
    kdf: crate::meta::KdfParams,
    kdf_check: Option<String>,
    head: u64,
    your_device_id: String,
}

async fn get_meta(State(state): State<Shared>, headers: HeaderMap) -> ApiResult<Json<MetaResponse>> {
    let device_id = authenticate(&state.config, &headers)?;
    let meta = state.meta.read().expect("meta lock poisoned").clone();
    Ok(Json(MetaResponse {
        protocol: meta.protocol,
        vault_id: meta.vault_id,
        kdf: meta.kdf,
        kdf_check: meta.kdf_check,
        head: state.journal.head(),
        your_device_id: device_id,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitRequest {
    kdf_check: String,
}

/// Sets the passphrase check value, once, for the life of the vault.
///
/// There is deliberately no route that replaces it. Doing so would orphan every
/// blob already encrypted under the old key while appearing to succeed.
async fn init_meta(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<InitRequest>,
) -> ApiResult<StatusCode> {
    authenticate(&state.config, &headers)?;

    if req.kdf_check.is_empty() {
        return Err(ApiError::bad_request("kdfCheck must not be empty"));
    }

    let mut meta = state.meta.write().expect("meta lock poisoned");
    if meta.kdf_check.is_some() {
        return Err(ApiError::conflict(
            "vault is already initialized; kdfCheck cannot be replaced",
        ));
    }

    // Persist first, adopt second. If the write fails and we had already
    // mutated the guard, the running server would advertise a kdfCheck that is
    // not on disk — and after a restart the vault would look uninitialized
    // again, letting a second client initialize it under a *different*
    // passphrase and silently orphan everything written under the first.
    let mut updated = meta.clone();
    updated.kdf_check = Some(req.kdf_check);
    updated.save(&state.config.data_dir)?;
    *meta = updated;
    state.git.notify();

    tracing::info!("vault initialized by client");
    Ok(StatusCode::NO_CONTENT)
}

// --- journal --------------------------------------------------------------

#[derive(Deserialize)]
struct JournalQuery {
    #[serde(default)]
    since: u64,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct JournalPage {
    entries: Vec<crate::journal::Entry>,
    head: u64,
    more: bool,
}

async fn get_journal(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<JournalQuery>,
) -> ApiResult<Json<JournalPage>> {
    authenticate(&state.config, &headers)?;
    let limit = q.limit.unwrap_or(500).clamp(1, 1000);
    let (entries, more) = state.journal.read_since(q.since, limit)?;
    Ok(Json(JournalPage { entries, head: state.journal.head(), more }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendRequest {
    entries: Vec<AppendEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendEntry {
    entry_id: String,
    payload: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppendResponse {
    assigned: Vec<crate::journal::Appended>,
    head: u64,
}

async fn post_journal(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<AppendRequest>,
) -> ApiResult<Json<AppendResponse>> {
    let device_id = authenticate(&state.config, &headers)?;
    let limits = &state.config.limits;

    if req.entries.len() > limits.max_batch_entries {
        return Err(ApiError::new(
            ErrorCode::PayloadTooLarge,
            format!("batch exceeds {} entries", limits.max_batch_entries),
        ));
    }
    for e in &req.entries {
        if e.payload.len() > limits.max_payload_bytes {
            return Err(ApiError::new(
                ErrorCode::PayloadTooLarge,
                format!("payload exceeds {} bytes", limits.max_payload_bytes),
            ));
        }
    }

    let pairs: Vec<(String, String)> = req
        .entries
        .into_iter()
        .map(|e| (e.entry_id, e.payload))
        .collect();

    let assigned = state.journal.append(&device_id, &pairs)?;
    state.git.notify();

    Ok(Json(AppendResponse {
        assigned,
        head: state.journal.head(),
    }))
}

// --- blobs ----------------------------------------------------------------

async fn head_blob(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    authenticate(&state.config, &headers)?;
    if state.blobs.has(&id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found())
    }
}

async fn get_blob(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    authenticate(&state.config, &headers)?;

    // Blobs run to max_blob_bytes (100 MiB by default). Reading one inline
    // would park a runtime worker for the whole transfer.
    let bytes = blocking(&state, move |s| s.blobs.get(&id)).await?;
    let bytes = bytes.ok_or_else(ApiError::not_found)?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    ))
}

/// Runs a filesystem operation off the async runtime.
///
/// Used for work proportional to a *blob* — reading or writing up to
/// max_blob_bytes, or sweeping the whole store. Small, bounded operations (a
/// journal line, meta.json, an existence check) stay inline: for a single-user
/// server a thread hop costs more than they do.
async fn blocking<T, F>(state: &Shared, f: F) -> ApiResult<T>
where
    F: FnOnce(&AppState) -> ApiResult<T> + Send + 'static,
    T: Send + 'static,
{
    let state = state.clone();
    tokio::task::spawn_blocking(move || f(&state))
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "blocking task panicked");
            ApiError::new(ErrorCode::Internal, "internal error")
        })?
}

async fn put_blob(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> ApiResult<StatusCode> {
    authenticate(&state.config, &headers)?;
    validate_id(&id, "blobId")?;

    if body.is_empty() {
        // A sealed blob is at minimum a 12-byte IV plus a 16-byte tag, so an
        // empty body is always a client bug rather than an empty file.
        return Err(ApiError::bad_request("blob body must not be empty"));
    }

    let outcome = blocking(&state, move |s| {
        s.blobs.put(&id, &body)
    })
    .await?;

    match outcome {
        PutOutcome::Stored => {
            state.git.notify();
            Ok(StatusCode::CREATED)
        }
        PutOutcome::AlreadyPresent => Ok(StatusCode::OK),
    }
}

// --- gc -------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GcRequest {
    live: Vec<String>,
    /// The journal head the live set was computed against. If the journal has
    /// moved on, the set is stale and may omit a blob that is now referenced.
    expected_head: u64,
}

#[derive(Deserialize)]
struct GcQuery {
    #[serde(default)]
    force: bool,
}

#[derive(Serialize)]
struct GcResponse {
    removed: usize,
    spared: usize,
    remaining: usize,
}

async fn post_gc(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<GcQuery>,
    Json(req): Json<GcRequest>,
) -> ApiResult<Json<GcResponse>> {
    authenticate(&state.config, &headers)?;

    for id in &req.live {
        validate_id(id, "blobId")?;
    }

    let expected_head = req.expected_head;
    let force = q.force;
    let live: HashSet<String> = req.live.into_iter().collect();

    let (outcome, remaining) = blocking(&state, move |s| {
        // A live set computed against an older journal cannot know about blobs
        // referenced by entries appended since. Deleting one is unrecoverable,
        // so refuse rather than guess.
        let head = s.journal.head();
        if expected_head != head {
            return Err(ApiError::conflict(format!(
                "live set was computed against head {expected_head} but the journal is at {head}; recompute and retry"
            )));
        }

        // An empty live set is far more often a client that failed to build its
        // index than a real instruction to delete every blob in the vault.
        if live.is_empty() && s.blobs.count()? > 0 && !force {
            return Err(ApiError::bad_request(
                "refusing to gc against an empty live set; pass ?force=true if this is intended",
            ));
        }

        let grace = std::time::Duration::from_secs(s.config.limits.gc_grace_secs);
        let outcome = s.blobs.gc(&live, grace)?;
        let remaining = s.blobs.count()?;
        Ok((outcome, remaining))
    })
    .await?;
    // A sweep changes the tree as much as an append does; without this the
    // mirror keeps claiming blobs the server has deleted until the next write.
    state.git.notify();
    tracing::info!(
        removed = outcome.removed,
        spared = outcome.spared,
        remaining,
        "gc complete"
    );
    Ok(Json(GcResponse {
        removed: outcome.removed,
        spared: outcome.spared,
        remaining,
    }))
}
