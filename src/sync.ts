/**
 * One sync run: pull, scan, reconcile, apply, persist.
 *
 * The ordering is not arbitrary. The journal is pulled *before* the vault is
 * scanned so that a file changed during the sync is caught by the next run
 * rather than being reconciled against a stale remote index; and base state is
 * written last, so a crash anywhere in between costs a rescan rather than
 * leaving base claiming things that never happened.
 */

import type { VaultAdapter } from "./adapter.ts";
import type { SyncApi } from "./api.ts";
import { applyPlan } from "./apply.ts";
import { type VaultKeys, verifyKdfCheck } from "./crypto.ts";
import { replay } from "./journal.ts";
import { type Note, type Plan, reconcile } from "./reconcile.ts";
import { scanVault, syncScope } from "./scan.ts";
import { emptyState, loadState, saveState } from "./state.ts";
import type { BaseIndex, BaseState, RemoteIndex, VaultMeta } from "./types.ts";

export interface SyncOptions {
  adapter: VaultAdapter;
  api: SyncApi;
  keys: VaultKeys;
  includeVaultConfig: boolean;
  exclude?: readonly string[];
  /**
   * Proceed even when the plan would trash many untracked files. Set only
   * after the user has been shown what would happen and agreed.
   */
  confirmMassDeletion?: boolean;
  /**
   * Meta the caller already fetched, to derive keys. Passing it saves a round
   * trip on every sync — the caller needs meta before it can have keys at all.
   */
  meta?: VaultMeta;
  onNote?: (note: Note) => void;
}

export interface SyncSummary {
  pushed: number;
  pulled: number;
  deletedLocally: number;
  pushedDeletions: number;
  scanned: number;
  hashed: number;
  lastSeq: number;
  notes: Note[];
  /** Set when the run stopped short and is waiting on the user. */
  blocked?: { reason: string; deletions: number; localFiles: number };
}

export class SyncError extends Error {}

export async function runSync(opts: SyncOptions): Promise<SyncSummary> {
  const { adapter, api, keys } = opts;
  const meta = opts.meta ?? (await api.meta());

  if (meta.kdfCheck === null) {
    throw new SyncError(
      "this vault has no passphrase set yet — run the setup command first, and make sure " +
        "this is the server you meant to point at",
    );
  }
  if (!(await verifyKdfCheck(keys, meta.vaultId, meta.kdfCheck))) {
    throw new SyncError(
      "the passphrase does not match this vault; refusing to sync rather than writing data " +
        "that nothing can decrypt",
    );
  }

  const loaded = await loadState(adapter);
  if (loaded.problem) {
    opts.onNote?.({ level: "warn", path: "", message: loaded.problem });
  }

  let state: BaseState = loaded.state ?? emptyState(meta.vaultId, meta.yourDeviceId);

  if (state.vaultId !== meta.vaultId) {
    // Two unrelated histories must never be merged: every path would look like
    // a conflict, and the base state describes a vault that is not this one.
    throw new SyncError(
      `this device is set up for vault ${state.vaultId} but the server hosts ${meta.vaultId}. ` +
        `If the change is intentional, reset the plugin's sync state first.`,
    );
  }

  // The device id comes from the server, derived from our token.
  state = { ...state, deviceId: meta.yourDeviceId };

  // --- pull ---------------------------------------------------------------

  let remote: RemoteIndex = new Map(Object.entries(state.remote));
  let fromSeq = state.lastSeq;

  if (remote.size === 0 && state.lastSeq > 0) {
    // A cached index that went missing: rebuild it from the whole journal
    // rather than trusting a position with nothing behind it.
    opts.onNote?.({
      level: "warn",
      path: "",
      message: "cached remote index is missing; replaying the journal from the start",
    });
    fromSeq = 0;
  }

  // meta.head says where the journal ends. Already there means the pull is
  // guaranteed empty — skip the round trip, which is most syncs: focus and
  // interval triggers usually find nothing new.
  const entries = fromSeq >= meta.head ? [] : await api.journalAll(fromSeq);
  const replayed = await replay(entries, keys, remote, fromSeq);

  // --- scan ---------------------------------------------------------------

  const base: BaseIndex = new Map(Object.entries(state.files));
  const scope = syncScope(opts);
  const scan = await scanVault({
    adapter,
    keys,
    base,
    scope,
    onProblem: (path, error) =>
      opts.onNote?.({ level: "warn", path, message: `could not read: ${String(error)}` }),
  });

  // --- reconcile ----------------------------------------------------------

  const plan: Plan = reconcile({
    base,
    local: scan.local,
    remote: replayed.index,
    now: new Date(),
    // The same scope the scan used, so reconcile can tell "excluded" from
    // "deleted" rather than reading a settings change as a mass deletion.
    isExcluded: (path) => !scope.includes(path),
  });

  for (const note of plan.notes) opts.onNote?.(note);

  if (plan.needsConfirmation && !opts.confirmMassDeletion) {
    // Persist the pulled journal position anyway: the pull really happened, and
    // re-downloading it on every attempt helps nobody. Base is untouched, so
    // nothing has been decided.
    await saveState(adapter, {
      ...state,
      lastSeq: replayed.lastSeq,
      remote: Object.fromEntries(replayed.index),
    });

    return {
      pushed: 0,
      pulled: 0,
      deletedLocally: 0,
      pushedDeletions: 0,
      scanned: scan.local.size,
      hashed: scan.hashed,
      lastSeq: replayed.lastSeq,
      notes: plan.notes,
      blocked: plan.needsConfirmation,
    };
  }

  // --- apply --------------------------------------------------------------

  const applied = await applyPlan({
    adapter,
    api,
    keys,
    deviceId: state.deviceId,
    base,
    plan,
    onNote: opts.onNote,
  });

  // Entries we appended are deliberately *not* folded into the cached index or
  // into lastSeq. The next pull returns them and replays them through exactly
  // the same path as any other device's writes — one code path instead of two,
  // at the cost of re-reading our own entries once.
  const next: BaseState = {
    ...state,
    files: Object.fromEntries(base),
    lastSeq: replayed.lastSeq,
    remote: Object.fromEntries(replayed.index),
  };
  await saveState(adapter, next);

  return {
    pushed: applied.pushed,
    pulled: applied.pulled,
    deletedLocally: applied.deletedLocally,
    pushedDeletions: applied.pushedDeletions,
    scanned: scan.local.size,
    hashed: scan.hashed,
    lastSeq: replayed.lastSeq,
    notes: plan.notes,
  };
}
