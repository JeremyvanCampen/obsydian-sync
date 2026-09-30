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
  pushed: number;
  pulled: number;
  /** Files moved to local trash because the vault records them as deleted. */
  deletedLocally: number;
  /** Deletions journalled for other devices. Counted separately from `pushed`:
   * lumping them in would hide them, and leaving them uncounted made a sync
   * that propagated only deletions report doing nothing at all. */
  pushedDeletions: number;
}

/** Mutates `base` in place; the caller persists it. */
export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  const { adapter, api, keys, deviceId, base, plan } = opts;
  const result: ApplyResult = { pushed: 0, pulled: 0, deletedLocally: 0, pushedDeletions: 0 };

  // The plan's own notes are emitted by the caller, which owns reporting.
  // Emitting them here as well logged every reconciler decision twice.

  // Journal entries are collected and appended in one batch at the end.
  //
  // Ordering matters: every blob must be on the server before the entry that
  // references it, or another device could pull an entry whose content does not
  // exist yet. Local writes happen first for the same reason in reverse — we
  // only record a pull in base once the file is really on disk.
  const pending: JournalPayload[] = [];

  /**
   * The one execution-time check. Reconcile recorded what each file looked
   * like when it decided; if the file has changed since, acting now would
   * overwrite, trash or mis-publish an edit that nothing has journalled.
   * Skip it — the next sync sees the change and decides afresh.
   */
  const unchanged = async (
    action: Extract<Action, { expect: unknown }>,
    current: Bytes | null,
  ): Promise<boolean> => {
    const ok =
      action.expect === "absent"
        ? current === null
        : current !== null && (await blobIdFor(keys, current)) === action.expect.blobId;
    if (!ok) {
      opts.onNote?.({
        level: "warn",
        path: action.path,
        message: "changed during sync; leaving it for the next run",
      });
    }
    return ok;
  };

  for (const action of plan.actions) {
    switch (action.kind) {
      case "push-put": {
        // The bytes checked are the bytes uploaded, so there is no window in
        // which an edit could slip between the check and the upload. Uploading
        // edited bytes under the scan-time blobId would poison the store:
        // every device would resolve that id to the wrong content forever, and
        // since the AAD is only the blobId, decryption would still succeed.
        const content = await readLocal(adapter, action.path);
        if (!(await unchanged(action, content))) continue;

        await uploadBlob(api, keys, action.local.blobId, content!);
        const { blobId, size, mtime } = action.local;
        pending.push({ op: "put", path: action.path, blobId, size, mtime });
        base.set(action.path, { blobId, size, mtime });
        result.pushed++;
        break;
      }

      case "push-delete": {
        // A file restored between scan and apply must not be deleted everywhere.
        if (!(await unchanged(action, await readLocal(adapter, action.path)))) continue;
        pending.push({ op: "delete", path: action.path, mtime: action.mtime });
        base.delete(action.path);
        result.pushedDeletions++;
        break;
      }

      case "pull-put":
      case "copy-remote": {
        // Download first, check last: the check sits immediately before the
        // write, keeping the window for an edit to slip in as short as it can be.
        const content = await downloadBlob(api, keys, action.remote.blobId);
        if (!(await unchanged(action, await readLocal(adapter, action.path)))) continue;

        await writeLocal(adapter, action.path, content);
        const stat = await adapter.stat(action.path);
        // Record what the filesystem actually gave the file: the next scan's
        // fast path compares (mtime, size) against what it will see on disk,
        // and a mismatch re-hashes the file on every sync without converging.
        const entry = {
          blobId: action.remote.blobId,
          size: content.length,
          mtime: stat?.mtime ?? action.remote.mtime,
        };
        base.set(action.path, entry);
        result.pulled++;

        if (action.kind === "copy-remote") {
          // Reuses the blob the server already holds; nothing to upload.
          pending.push({ op: "put", path: action.path, ...entry });
          result.pushed++;
        }
        break;
      }

      case "pull-delete": {
        const current = await readLocal(adapter, action.path);
        if (current !== null) {
          if (!(await unchanged(action, current))) break;
          // Always to the trash, never a hard remove. If the reconciler is
          // ever wrong, this is the difference between an annoyance and a loss.
          await adapter.trashLocal(action.path);
        }
        base.delete(action.path);
        result.deletedLocally++;
        break;
      }

      case "adopt-base": {
        base.set(action.path, { blobId: action.blobId, size: action.size, mtime: action.mtime });
        break;
      }

      case "drop-base": {
        base.delete(action.path);
        break;
      }
    }
  }

  if (pending.length > 0) {
    await api.appendJournal(await Promise.all(pending.map((p) => prepareEntry(p, keys, deviceId))));
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

/**
 * Below this size, PUT straight away: an edited note almost never exists on the
 * server already, so asking first costs a round-trip to learn "no". PUT is
 * idempotent server-side, so a blob that does exist is simply not rewritten.
 * Above it, the HEAD pays for itself — a multi-megabyte plugin bundle that
 * another device already uploaded is not sent again.
 */
export const HEAD_BEFORE_PUT_BYTES = 256 * 1024;

async function uploadBlob(
  api: SyncApi,
  keys: VaultKeys,
  blobId: string,
  content: Bytes,
): Promise<void> {
  if (content.length >= HEAD_BEFORE_PUT_BYTES && (await api.hasBlob(blobId))) return;
  await api.putBlob(blobId, await seal(keys.content, content, aadForBlob(blobId)));
}

async function downloadBlob(api: SyncApi, keys: VaultKeys, blobId: string): Promise<Bytes> {
  const sealed = await api.getBlob(blobId);
  // AAD binds the ciphertext to this blobId, so a server that served the wrong
  // blob produces a decryption failure rather than a wrong file on disk.
  return unseal(keys.content, sealed, aadForBlob(blobId));
}
