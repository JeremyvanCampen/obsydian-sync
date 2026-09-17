# Obsydian Sync — Protocol & Crypto Specification

**Protocol version:** `1`
**Status:** draft, implemented by `plugin/` (TypeScript) and `server/` + `cli/` (Rust)

This document is the contract between the client and the server. Two languages
implement it; where this document and an implementation disagree, this document
wins and the implementation is a bug.

Keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used in the RFC 2119 sense.

---

## 1. Model

The server is a **zero-knowledge append-only store**. It holds two kinds of object:

- **Blobs** — encrypted file contents, addressed by an opaque `blobId`.
- **Journal entries** — an append-only, totally ordered log of encrypted change
  records. The server assigns each entry a monotonically increasing `seq`.

The server never possesses a key and **MUST NOT** be able to decrypt either. It
learns: how many entries exist, their approximate sizes, their timing, and which
device token submitted each one. It does **not** learn file paths, file names,
folder structure, or contents.

Clients derive all state by replaying the journal. Conflict resolution is
**entirely client-side**; this is what allows the server to need no locking and
no compare-and-swap.

---

## 2. Conventions

- All JSON is UTF-8. All request and response bodies are JSON unless stated
  otherwise (blob bodies are raw octets).
- Binary values inside JSON are **standard base64 with padding** (RFC 4648 §4),
  never base64url.
- Hex values are **lowercase**.
- Timestamps (`mtime`) are integer **milliseconds since the Unix epoch**.
- `seq` is a positive integer starting at `1`. `seq: 0` is the sentinel meaning
  "I have replayed nothing".

### 2.1 Path canonicalization

A `path` is a vault-relative path. Clients **MUST** canonicalize before it goes
on the wire:

1. Forward slashes `/` as the separator. No leading slash, no trailing slash.
2. No `.` or `..` segments.
3. **Unicode NFC normalization.** This is not optional: macOS reports filenames
   in NFD, Linux and Android pass bytes through unchanged. Without NFC, a note
   named `Café.md` created on the MacBook and one created on Linux are different
   paths and will duplicate.
4. Paths are compared **case-sensitively**. Note that macOS and Windows have
   case-insensitive filesystems, so two paths differing only in case cannot
   coexist there; clients **SHOULD** warn rather than fail if they detect this.

Servers **MUST** reject a path that fails validation. Servers never see paths,
so this validation is client-side only — it is stated here because both the
plugin and the restore CLI must agree.

---

## 3. Cryptography

### 3.1 Master key derivation

```
masterKey = PBKDF2-HMAC-SHA256(
    password   = passphrase (UTF-8, NFC-normalized, not trimmed),
    salt       = meta.kdf.salt        (32 random bytes, base64 in meta)
    iterations = meta.kdf.iterations  (default 600000)
    dkLen      = 32
)
```

The KDF is named in `meta.kdf.alg` (`"PBKDF2-HMAC-SHA256"`) so it can be
replaced — Argon2id is the intended v2 upgrade — without a protocol break. A
client **MUST** refuse an `alg` it does not implement, rather than falling back
to one it does: deriving a PBKDF2 key from an Argon2id vault produces "wrong
passphrase", which during a recovery is the worst possible way to be wrong.

**Minimums.** The KDF parameters come from the server, and a client
initializing a vault is the one moment they are not yet pinned by an existing
`kdfCheck`. At that moment a client **MUST** refuse fewer than **100000**
iterations or a salt shorter than **16 bytes** — otherwise a rolled-back or
hostile `meta` could weaken every key the vault will ever use, permanently.
After initialization no check is needed: `kdfCheck` was sealed under the
original parameters, so altered ones simply fail to verify.

### 3.2 Subkey derivation

All subkeys are 32 bytes from HKDF-SHA256 with an **empty salt** (32 zero bytes)
and a distinct `info` string:

| Subkey | `info` | Used for |
|---|---|---|
| `k_content` | `obsydian-sync/v1/content` | encrypting blob contents |
| `k_meta` | `obsydian-sync/v1/meta` | encrypting journal payloads |
| `k_id` | `obsydian-sync/v1/id` | computing `blobId` |
| `k_check` | `obsydian-sync/v1/kdfcheck` | the passphrase check value |

Separate keys per purpose; a key **MUST NOT** be reused across two of these.

### 3.3 Blob identity

```
blobId = lowercase_hex( HMAC-SHA256(k_id, plaintext)[0..16] )     // 32 hex chars
```

An HMAC rather than a bare hash: identical content still dedupes and re-uploads
stay idempotent, but the server cannot confirm a guess about a blob's contents
without `k_id`.

Truncation to 128 bits is deliberate. Collision resistance at 64 bits of
birthday bound is ample for a single-user vault, and it halves the id size in
every journal entry.

### 3.4 Authenticated encryption

Every ciphertext in this protocol has the same shape:

```
sealed = iv (12 bytes) || AES-256-GCM ciphertext || tag (16 bytes)
```

- IV is 12 fresh random bytes per encryption. An IV **MUST NOT** be reused
  under the same key.
- The GCM tag is 128 bits and is appended by all standard AEAD APIs
  (WebCrypto and the `aes-gcm` crate both do this), so implementations
  concatenate nothing by hand except the IV prefix.

**Associated data (AAD)** binds each ciphertext to its identity, so a malicious
or buggy server cannot swap one valid ciphertext for another. AAD is the UTF-8
bytes of:

| Object | Key | AAD |
|---|---|---|
| Blob | `k_content` | `v1/blob\|<blobId>` |
| Journal payload | `k_meta` | `v1/journal\|<deviceId>\|<entryId>` |
| kdfCheck | `k_check` | `v1/kdfcheck\|<vaultId>` |

> **Note.** The journal AAD uses the client-generated `entryId`, **not** `seq`.
> `seq` is assigned by the server after the client has already encrypted, so it
> is not available at encryption time and cannot appear in AAD.

### 3.5 Passphrase verification

`meta.kdfCheck` is the sealed form of the ASCII bytes `obsydian-sync-kdf-check`
under `k_check` with the AAD above. A client **MUST** verify it before its first
write. A wrong passphrase then fails immediately, instead of silently filling
the vault with undecryptable data.

---

## 4. Server API

Base path `/v1`. Every route requires:

```
Authorization: Bearer <device-token>
```

The token identifies the device. The server maps token → `deviceId`; a client
**MUST NOT** assert its own `deviceId` and the server **MUST** ignore any
attempt to. A device learns its id from `GET /v1/meta`.

Errors are `{"error": {"code": "...", "message": "..."}}` with codes
`bad_request`, `unauthorized`, `not_found`, `payload_too_large`, `rate_limited`,
`internal`.

### `GET /v1/meta`

```jsonc
{
  "protocol": 1,
  "vaultId": "c1f0…",              // random hex, fixed at server init
  "kdf": { "alg": "PBKDF2-HMAC-SHA256", "salt": "<base64>", "iterations": 600000 },
  "kdfCheck": "<base64 sealed>",   // null until the vault is initialized
  "head": 412,                     // highest assigned seq, 0 if empty
  "yourDeviceId": "macbook"
}
```

`vaultId` lets a client notice it has been pointed at a different vault and
refuse to sync rather than merge two unrelated histories.

The server generates `vaultId` and `kdf.salt` itself at first startup — both are
public random values. It **cannot** generate `kdfCheck`, which requires the
passphrase. So a fresh vault reports `"kdfCheck": null`, and the first client to
set up derives the value and submits it:

### `POST /v1/meta/init`

```jsonc
{ "kdfCheck": "<base64 sealed>" }
```

Permitted **only** while `kdfCheck` is null; afterwards the server **MUST**
reject with `409 conflict`. This is what makes the passphrase permanent for the
life of the vault: there is no route that replaces `kdfCheck`, because doing so
would silently orphan every blob already encrypted under the old key.

A client seeing `"kdfCheck": null` **MUST** confirm with the user before
initializing — it means either a genuinely new vault or, more alarmingly, that
they are pointed at the wrong server.

### `GET /v1/journal?since=<seq>&limit=<n>`

Entries with `seq > since`, ascending. `limit` defaults to 500, max 1000.

```jsonc
{
  "entries": [
    { "seq": 411, "deviceId": "iphone", "entryId": "0f8c…", "payload": "<base64 sealed>" }
  ],
  "head": 412,
  "more": false
}
```

`more` is true when entries remain beyond the returned page; the client pages by
calling again with `since` set to the last `seq` it received.

### `POST /v1/journal`

```jsonc
{ "entries": [ { "entryId": "0f8c…", "payload": "<base64 sealed>" } ] }
```

`entryId` is a client-generated 128-bit random value, lowercase hex. It is the
AAD binding and makes retries idempotent: if a client resubmits an `entryId` the
server already holds, the server **MUST** return the existing `seq` rather than
appending a duplicate.

Response: `{ "assigned": [ { "entryId": "0f8c…", "seq": 413 } ], "head": 413 }`

Max 1000 entries per batch; max 64 KiB per payload.

### `HEAD /v1/blob/<blobId>`

`204` if present, `404` if not. Lets a client skip uploading content the server
already has — the common case for a rename or a file copied between folders.

### `PUT /v1/blob/<blobId>`

Body is the raw sealed bytes, `Content-Type: application/octet-stream`.
Idempotent: re-PUTting an existing `blobId` **MUST** succeed without modifying
stored bytes. `201` on store, `200` if already present.

Max size configurable, default 100 MiB.

### `GET /v1/blob/<blobId>`

Raw sealed bytes, or `404`.

### `POST /v1/gc`

```jsonc
{ "live": ["9f2c…", "a13b…"], "expectedHead": 412 }
```

Deletes every blob whose id is not in `live`. GC **must** be client-driven: the
server cannot compute reachability over a journal it cannot read. `blobId` is
opaque to the server, so sending the live set leaks nothing.

Deleting a referenced blob is unrecoverable — the file is then lost on every
device — so three guards apply, each covering a race the others do not:

- **`expectedHead`.** The journal head the live set was computed against. If the
  journal has advanced, the set may omit a blob referenced by an entry appended
  since, and the server **MUST** reject with `409 conflict`. The client
  recomputes and retries.
- **A grace period.** Blobs written more recently than `gc_grace_secs`
  (default 24h) are never collected, whatever `live` says. A client uploads a
  blob and only *then* appends the entry referencing it; a sweep landing between
  those two requests would otherwise delete content that is about to become
  live, and `expectedHead` cannot detect this because the head has not moved yet.
- **Exclusion against uploads.** A sweep and a blob `PUT` never overlap, so a
  blob cannot be written into a directory the sweep has already walked past.

The server **MUST** also refuse the request if `live` is empty while blobs
exist, unless `?force=true` — the empty set is far more likely to be a client
bug than a real instruction to delete everything.

Response: `{ "removed": 3, "spared": 1, "remaining": 61 }`, where `spared`
counts unreferenced blobs held back by the grace period.

---

## 5. Journal payloads

Decrypted, a payload is one of exactly two operations in v1.

```jsonc
{ "op": "put",    "path": "Work/Meetings/Standup.md",
  "blobId": "9f2c…", "size": 4211, "mtime": 1757400000000 }

{ "op": "delete", "path": "Home/Old note.md", "mtime": 1757400001000 }
```

`size` is the length of the **plaintext**, used for display and for the
scan fast-path; it is not authoritative.

**Renames are `put` + `delete`.** There is no `rename` op in v1. Because blobs
dedupe by content, a rename uploads nothing — the `put` at the new path reuses
the existing `blobId`. Adding a real `rename` op would require a protocol bump;
it buys intent-preservation in history and nothing else, and it doubles the
number of replay cases every implementation must get right.

### 5.1 Replay

Replay in ascending `seq`. Later entries win. The resulting **remote index** is
`path → RemoteEntry`:

```ts
type RemoteEntry =
  | { state: "present"; blobId: string; size: number; mtime: number; seq: number }
  | { state: "deleted"; mtime: number; seq: number }              // tombstone
```

**Tombstones are retained in the index.** A `delete` does not remove the path
from the index; it replaces the entry with a tombstone. This distinction is
load-bearing — see §6.

---

## 6. Client reconciliation

The client holds three inputs:

- **Base** — persisted state from the last successful sync:
  `path → { hash, size, mtime }`, plus `lastSeq`.
- **Local** — the current vault on disk.
- **Remote** — the replayed index from §5.1.

For each path in `Base ∪ Local ∪ Remote`, compare Local-vs-Base and
Remote-vs-Base:

| Local | Remote | Action |
|---|---|---|
| unchanged | unchanged | nothing |
| changed | unchanged | push local (a local deletion pushes a `delete` op) |
| unchanged | changed | apply remote (a tombstone deletes the local file) |
| changed | changed, same content | converged — advance base only |
| deleted | deleted | advance base, drop the entry |
| deleted | modified | **remote wins** — file is restored, and this is logged |
| modified | deleted | **local wins** — file is re-pushed, and this is logged |
| modified | modified, differs | **conflict** — see below |

Three invariants that the implementation must not quietly break:

1. **Modification beats deletion.** Losing an edit is worse than an unwanted
   file reappearing, and the reappearance is visible while the lost edit is not.
2. **A local file is deleted only against an explicit tombstone.** A path that
   is simply *absent* from the remote index — a wiped server, a truncated
   journal, a client pointed at a fresh vault — is treated as unknown, and the
   local file is pushed. A fresh server can therefore never empty a vault.
3. **An excluded path is not a deleted path.** Exclusions make a path absent
   from the scan, which is otherwise indistinguishable from a local deletion.
   A client **MUST** know which paths it excludes and drop them from base
   without journalling anything — otherwise adding a folder to the exclude
   list, or stopping syncing `.obsidian`, would write a tombstone per path and
   delete those files on every other device.

### 6.1 Untracked paths

A path with no base entry has never been synced by this device. With no base,
there is no evidence of what changed:

- **Local file, remote present, same content** — converged; adopt it.
- **Local file, remote present, different content** — conflict (§6.2).
- **Local file, remote tombstone** — the stale-copy case. A device set up from
  an old backup would otherwise resurrect everything the vault has legitimately
  deleted. With no better evidence available, compare timestamps: keep the file
  only if it is newer than the deletion.
- **No local file, remote tombstone** — already satisfied; do nothing.

Because timestamps are a weak signal for a destructive act — and because losing
base state makes *every* path untracked at once — a client **MUST** count the
deletions arising from that third case and stop for confirmation past a
threshold that scales with vault size, rather than trashing a vault unattended.

Content comparison is by **hash, never mtime**. `(mtime, size)` matching Base is
only a fast path permitting the client to skip re-hashing; any mismatch triggers
a real hash. Mobile filesystems report timestamps too unreliably to trust as
a change signal.

### 6.2 Conflicts

When both sides changed a path to different content, the client **MUST NOT**
discard either version. It:

1. leaves the local file untouched at `path`;
2. writes the remote version beside it as
   `<stem> (conflict from <deviceId> <YYYY-MM-DD HH.mm>).<ext>`;
3. pushes **both** paths.

Step 3 is not optional. Without it base is never advanced and neither side
learns of the other, so the same path conflicts again on the next sync, and the
next — producing a new copy forever. The sidecar reuses the remote's `blobId`,
so it costs no upload.

The name uses dots in the time because `:` is illegal in a Windows path, keeps
compound extensions in the stem (`.excalidraw.md`), and truncates the stem on a
character boundary to stay inside the filesystem's 255-byte limit — a note title
long enough to exceed it would otherwise turn a recoverable conflict into a
failed sync.

A conflict is therefore always recoverable by hand and never silent. A merge UI
is deliberately deferred until the real conflict rate is known.

---

## 7. Server storage layout

```
<data-dir>/
  meta.json                  # vaultId, kdf params, kdfCheck
  journal.ndjson             # one JSON object per line, append-only, ascending seq
  blobs/<aa>/<bb>/<blobId>   # sealed bytes; aa,bb = first 2 and next 2 hex chars
```

`journal.ndjson` lines are `{"seq":413,"deviceId":"macbook","entryId":"0f8c…","payload":"…"}`.
NDJSON because appending a line is atomic enough under `O_APPEND` for a
single-writer process, it survives a truncated final line (drop it and continue),
and it diffs sanely in git.

The data directory **is** a git repository. The server commits after a debounce
following each successful append; a cron pushes to the GitLab mirror. A failed
push **MUST NOT** fail a sync.

---

## 8. Threat model

**Protected against:** a reader of the server's disk, of the GitLab mirror, or
of the network learns nothing about note contents, names, or folder structure.
A tampered ciphertext fails AEAD verification and is rejected, not silently
accepted.

**Not protected against:** a compromised *device* — the passphrase and plaintext
live there. The server also learns metadata: entry count, entry and blob sizes,
sync timing, and which device did what. Traffic analysis over that metadata is
out of scope for v1.

**Consequence of the design:** losing the passphrase loses the vault. There is
no recovery path and none can be added without weakening the above. This is why
`cli/obsydian-restore` is a required deliverable rather than a convenience.

---

## 9. Test vectors

`protocol/vectors.json` holds fixed inputs and expected outputs for every
primitive in §3. Both the TypeScript and the Rust test suites **MUST** assert
against it. It is the only thing standing between "both sides work" and "both
sides work *together*", and the day it matters is the day you need a restore.
