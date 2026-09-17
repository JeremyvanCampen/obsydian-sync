/**
 * Executes a reconciliation plan against the vault and the server.
 *
 * There are no decisions in this file. Every choice was made in `reconcile.ts`;
 * this only carries them out. If you find yourself adding an `if` about *what
 * should happen*, it belongs in the reconciler where it can be tested.
 */

import type { VaultAdapter } from "./adapter.ts";
import type { SyncApi } from "./api.ts";
import { type Bytes, type VaultKeys, aadForBlob, blobIdFor, seal, unseal } from "./crypto.ts";
import { prepareEntry } from "./journal.ts";
import type { Action, Note, Plan } from "./reconcile.ts";
import { ensureDir } from "./state.ts";
import type { BaseIndex, JournalPayload } from "./types.ts";

export interface ApplyOptions {
  adapter: VaultAdapter;
  api: SyncApi;
  keys: VaultKeys;
  deviceId: string;
  base: BaseIndex;
  plan: Plan;
  onNote?: (note: Note) => void;
}

export interface ApplyResult {
  /** Mutated in place and returned: the caller persists this. */
  base: BaseIndex;
  pushed: number;
  pulled: number;
  /** Files moved to local trash because the vault records them as deleted. */
  deletedLocally: number;
  /** Deletions journalled for other devices. Counted separately from `pushed`:
   * lumping them in would hide them, and leaving them uncounted made a sync
   * that propagated only deletions report doing nothing at all. */
  pushedDeletions: number;
  /** Sequence numbers assigned to everything we appended. */
  highestSeqWritten: number;
}

export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  const { adapter, api, keys, deviceId, base, plan } = opts;

  const result: ApplyResult = {
    base,
    pushed: 0,
    pulled: 0,
    deletedLocally: 0,
    pushedDeletions: 0,
    highestSeqWritten: 0,
  };

  // The plan's own notes are emitted by the caller, which owns reporting.
  // Emitting them here as well logged every reconciler decision twice, halving
  // the useful history in a capped log exactly when it is being read.
  // Notes raised *below* are this module's own and are not in plan.notes.

  // Journal entries are collected and appended in one batch at the end.
  //
  // Ordering matters: every blob must be on the server before the entry that
  // references it, or another device could pull an entry whose content does not
  // exist yet. Local writes happen first for the same reason in reverse — we
  // only record a pull in base once the file is really on disk.
  const pending: JournalPayload[] = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case "push-put": {
        const content = await readLocal(adapter, action.path);
        if (!content) {
          // The file vanished between scan and apply. Skip it; the next sync
          // sees the deletion properly rather than pushing a half-truth.
          opts.onNote?.({
            level: "warn",
            path: action.path,
            message: "disappeared during sync; leaving it for the next run",
          });
          continue;
        }

        // The bytes on disk now may not be the bytes the scan hashed —
        // autosave fires while a sync runs. Uploading these bytes under the
        // scan-time blobId would poison the content-addressed store: every
        // device would forever resolve that id to the wrong content, and
        // because the AAD is only the blobId, decryption would still succeed.
        //
        // This re-hashes content the scan already hashed. The cost is accepted:
        // the file has to be read here anyway to upload it, HMAC-SHA256 over
        // bytes already in memory is cheap next to that read, and it only
        // applies to files actually being pushed — the scan's fast path means
        // a steady-state sync reads almost nothing.
        const actual = await blobIdFor(keys, content);
        if (actual !== action.local.blobId) {
          opts.onNote?.({
            level: "info",
            path: action.path,
            message: "changed during sync; leaving it for the next run",
          });
          continue;
        }

        await uploadBlob(api, keys, action.local.blobId, content);
        pending.push({
          op: "put",
          path: action.path,
          blobId: action.local.blobId,
          size: action.local.size,
          mtime: action.local.mtime,
        });
        base.set(action.path, {
          blobId: action.local.blobId,
          size: action.local.size,
          mtime: action.local.mtime,
        });
        result.pushed++;
        break;
      }

      case "push-copy": {
        // The server already holds this blob (a conflict copy reuses the
        // remote's). Journal the path; upload nothing.
        //
        // If a pull-put earlier in this plan already wrote the file, keep the
        // mtime it recorded from the filesystem. Overwriting it with "now"
        // would mismatch what the next scan sees on disk, re-hashing the file
        // on every sync forever without ever converging.
        // Take both halves of the fast-path key from whatever pull-put just
        // recorded off the filesystem. Mixing one from disk and one from the
        // remote journal leaves the pair unable to match, and the file is
        // re-hashed on every sync forever — the failure this exists to avoid.
        const existing = base.get(action.path);
        const reuse = existing?.blobId === action.blobId;
        const mtime = reuse ? existing.mtime : action.mtime;
        const size = reuse ? existing.size : action.size;

        pending.push({ op: "put", path: action.path, blobId: action.blobId, size, mtime });
        base.set(action.path, { blobId: action.blobId, size, mtime });
        result.pushed++;
        break;
      }

      case "push-delete": {
        pending.push({ op: "delete", path: action.path, mtime: action.mtime });
        base.delete(action.path);
        result.pushedDeletions++;
        break;
      }

      case "pull-put": {
        const content = await downloadBlob(api, keys, action.remote.blobId);
        await writeLocal(adapter, action.path, content);
        const stat = await adapter.stat(action.path);
        base.set(action.path, {
          blobId: action.remote.blobId,
          size: content.length,
          // Record the mtime the filesystem actually gave the file, not the
          // one the remote reported: the next scan's fast path compares
          // against what it will see on disk.
          mtime: stat?.mtime ?? action.remote.mtime,
        });
        result.pulled++;
        break;
      }

      case "pull-delete": {
        const current = await readLocal(adapter, action.path);
        if (current) {
          // The reconciler authorised this at scan time. If the file changed
          // since, that change has never been journalled anywhere, and trashing
          // it would discard the only copy.
          const previous = base.get(action.path);

          if (previous) {
            // Tracked: authorised because the content matched the last sync.
            const actual = await blobIdFor(keys, current);
            if (actual !== previous.blobId) {
              opts.onNote?.({
                level: "warn",
                path: action.path,
                message: "edited during sync; not trashing it, and pushing the edit next run",
              });
              break;
            }
          } else {
            // Untracked: authorised only because the file looked older than the
            // tombstone — a judgement on timestamps alone, and the weakest
            // ground on which anything here deletes. Re-apply that test with
            // fresh data rather than trusting a reading from before the sync.
            const stat = await adapter.stat(action.path);
            if (!stat || stat.mtime > action.remote.mtime) {
              opts.onNote?.({
                level: "warn",
                path: action.path,
                message: "changed during sync and is now newer than the deletion; keeping it",
              });
              break;
            }
          }
          // Always to the trash, never a hard remove. If the reconciler is
          // ever wrong, this is the difference between an annoyance and a loss.
          await adapter.trashLocal(action.path);
        }
        base.delete(action.path);
        result.deletedLocally++;
        break;
      }

      case "adopt-base": {
        base.set(action.path, {
          blobId: action.blobId,
          size: action.size,
          mtime: action.mtime,
        });
        break;
      }

      case "drop-base": {
        base.delete(action.path);
        break;
      }

    }
  }

  if (pending.length > 0) {
    const prepared = await Promise.all(pending.map((p) => prepareEntry(p, keys, deviceId)));
    const response = await api.appendJournal(prepared);
    for (const a of response.assigned) {
      result.highestSeqWritten = Math.max(result.highestSeqWritten, a.seq);
    }
  }

  return result;
}

async function readLocal(adapter: VaultAdapter, path: string): Promise<Bytes | null> {
  if (!(await adapter.exists(path))) return null;
  return new Uint8Array(await adapter.readBinary(path)) as Bytes;
}

async function writeLocal(adapter: VaultAdapter, path: string, content: Bytes): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) await ensureDir(adapter, path.slice(0, slash));
  await adapter.writeBinary(path, content.slice().buffer);
}

async function uploadBlob(
  api: SyncApi,
  keys: VaultKeys,
  blobId: string,
  content: Bytes,
): Promise<void> {
  // Content addressing makes this cheap: a renamed or copied file, or a note
  // reverted to an earlier state, uploads nothing.
  if (await api.hasBlob(blobId)) return;
  await api.putBlob(blobId, await seal(keys.content, content, aadForBlob(blobId)));
}

async function downloadBlob(api: SyncApi, keys: VaultKeys, blobId: string): Promise<Bytes> {
  const sealed = await api.getBlob(blobId);
  // AAD binds the ciphertext to this blobId, so a server that served the wrong
  // blob produces a decryption failure rather than a wrong file on disk.
  return unseal(keys.content, sealed, aadForBlob(blobId));
}

export type { Action };
