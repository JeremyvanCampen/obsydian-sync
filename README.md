# Obsydian Sync

Self-hosted, end-to-end encrypted Obsidian vault sync across macOS, iOS,
Android, Windows and Linux.

You run a small server. It stores your notes as ciphertext and **cannot read
them** — not the contents, not the filenames, not your folder structure. Your
passphrase never leaves your devices.

> **Status: early.** It works, and it is tested hard (see below), but it has
> been in real use for a short time on a handful of devices. Do not point it at
> a vault you have no backup of, and run the restore drill before you trust it.

## Why this exists

It was built to fix two specific failures of a Dropbox-backed sync plugin:

1. **Deletions came back.** Delete a note on one device, another pushes it back.
2. **Syncing had to be triggered by hand.**

The first is not a setting you can change. If a client only compares *local
files* against *remote files*, then "this file is gone because I deleted it" and
"this file is new because someone else added it" are the same observation — a
missing local file. Without a record of what was last synced, it comes back.

The fix is the design: every device remembers what it last synced, and a
deletion is an explicit event in a shared log rather than an absence. There is
an end-to-end test that deletes a note on one device and asserts the second and
third syncs on the other device do nothing at all. That second sync is where the
old plugin failed.

## How it works

```
 your devices ──HTTPS + bearer token──▶ obsydian-sync-server
   AES-256-GCM                            assigns sequence numbers
   before anything leaves                 stores opaque blobs
                                          CANNOT decrypt anything
                                                │
                                                ▼
                                      a plain git repo on disk
                                      (mirror it off-site if you like)
```

The server keeps an **append-only journal** of encrypted change records and a
content-addressed store of encrypted blobs. Clients replay the journal to learn
what the vault contains, compare it against what they last synced and what is on
disk, and reconcile the three. **No device ever runs git.**

Full details: [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md).

## Install

The plugin is not in the community store. Install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install **BRAT** from Community plugins.
2. Command palette → *BRAT: Add a beta plugin for testing*
3. Paste `JeremyvanCampen/obsydian-sync`

BRAT keeps it updated, and works on iOS and Android where copying files by hand
does not.

You will also need to run the server — see [`SETUP.md`](SETUP.md).

## What it does and does not do

**Does:** notes, attachments and vault settings; automatic syncing on startup,
on change, on app focus and on an interval; conflict copies that keep both
versions; deletions that stay deleted; a CLI that decrypts a server snapshot
back to plain files.

**Does not:** merge conflicting edits (it keeps both and lets you decide); sync
while your server is unreachable (it catches up later); protect you if you lose
your passphrase — nothing can, by design.

## Layout

| Path | |
|---|---|
| `src/`, `manifest.json` | the Obsidian plugin (TypeScript) |
| `server/` | the sync server (Rust, axum) |
| `cli/` | `obsydian-restore` — decrypts a snapshot to plain files |
| `protocol/` | the wire and crypto spec, plus cross-language test vectors |
| `docker/` | container build, compose fragment, mirror push script |

## Development

```sh
npm install
npm run build          # -> main.js
npm test               # builds the server binary first
cargo test --workspace
npm run vectors        # regenerate protocol/vectors.json
```

### What the tests cover

| Layer | What it proves |
|---|---|
| Unit | The reconciler's matrix, the scheduler, state handling — pure functions, no mocks. |
| Integration (fakes) | The whole sync loop, two simulated devices against an in-memory server. |
| Integration (real) | The real TypeScript client against the real Rust server binary, over HTTP. |
| **Full stack** | A real vault on disk → client → server → `obsydian-restore`, compared byte for byte. |
| Bundle | Loads `main.js` the way Obsidian will, against a stub of the Obsidian API. |

The last two matter most. Cross-language crypto vectors prove the two
implementations agree on *encryption*; the HTTP tests prove they agree on the
*protocol*; only the full-stack test answers the question the whole project
rests on — with everything encrypted, do the files actually come back?

## Security

Content is sealed with AES-256-GCM before it leaves the device. Keys come from
your passphrase via PBKDF2-HMAC-SHA256, with separate subkeys per purpose
derived through HKDF. File paths are inside the encrypted payload, so the server
learns entry counts, sizes and timing — not names. Blob ids are keyed HMACs, so
identical content still deduplicates without the server being able to confirm a
guess about what a blob holds.

**Losing your passphrase loses the vault.** There is no recovery path and none
can be added without undoing the above. This is why `obsydian-restore` exists,
and why you should run it as a drill before trusting the system.

Found a security problem? Open an issue describing the class of the problem
without a working exploit, or contact the author directly.

## Licence

MIT — see [LICENSE](LICENSE).
