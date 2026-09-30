/**
 * The base state: what this device last successfully synced.
 *
 * This file is the reason deletions do not resurrect. Without a persisted
 * record of the last sync, "gone locally because I deleted it" and "new
 * remotely because someone added it" are the same observation.
 *
 * It lives inside the plugin's own folder, which is excluded from sync — a
 * synced base state would describe another device's history and corrupt this
 * one's reconciliation.
 */

import type { VaultAdapter } from "./adapter.ts";
import { type VaultLayout, statePath } from "./layout.ts";
import type { BaseFile, BaseState, RemoteEntry } from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";

// Paths come from the layout: see layout.ts for why they cannot be constants.

export function emptyState(vaultId: string, deviceId: string): BaseState {
  return { protocol: PROTOCOL_VERSION, vaultId, deviceId, lastSeq: 0, files: {}, remote: {} };
}




/**
 * Reads the base state, or returns null when there is none to read.
 *
 * A malformed or unreadable state file also returns null rather than throwing.
 * That is deliberate: losing base state costs one full rescan and possibly some
 * conflict files, whereas refusing to start leaves the vault unsyncable. The
 * caller is told so it can warn.
 */
export async function loadState(
  adapter: VaultAdapter,
  layout: VaultLayout,
): Promise<{ state: BaseState | null; problem?: string }> {
  const STATE_PATH = statePath(layout);
  const PREVIOUS_PATH = `${STATE_PATH}.prev`;
  // Try the current file, then the one saveState renames aside. The fallback
  // covers a file that is *unusable*, not merely absent: a crash or a truncated
  // write can leave a corrupt STATE_PATH sitting next to a perfectly good
  // .prev, and losing base state is what trips the mass-deletion guard.
  const main = await tryLoad(adapter, STATE_PATH);
  if (main.state) return { state: main.state };

  const previous = await tryLoad(adapter, PREVIOUS_PATH);
  if (previous.state) {
    return {
      state: previous.state,
      problem: main.problem
        ? `${main.problem}; recovered the previous sync state instead`
        : "recovered the previous sync state after an interrupted write",
    };
  }

  return { state: null, problem: main.problem };
}

async function tryLoad(
  adapter: VaultAdapter,
  path: string,
): Promise<{ state: BaseState | null; problem?: string }> {
  if (!(await adapter.exists(path))) return { state: null };

  let raw: string;
  try {
    raw = await adapter.read(path);
  } catch (e) {
    return { state: null, problem: `could not read ${path}: ${String(e)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: null, problem: `${path} is not valid JSON` };
  }

  const problem = validate(parsed);
  if (problem) return { state: null, problem };

  return { state: parsed as BaseState };
}

function validate(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "state file is not an object";
  const s = value as Partial<BaseState>;

  if (s.protocol !== PROTOCOL_VERSION) {
    return `state file is protocol ${String(s.protocol)}, expected ${PROTOCOL_VERSION}`;
  }
  if (typeof s.vaultId !== "string" || typeof s.deviceId !== "string") {
    return "state file is missing vaultId or deviceId";
  }
  if (typeof s.lastSeq !== "number" || !Number.isInteger(s.lastSeq) || s.lastSeq < 0) {
    return "state file has an invalid lastSeq";
  }
  if (typeof s.files !== "object" || s.files === null) return "state file has no files map";
  if (typeof s.remote !== "object" || s.remote === null) return "state file has no remote index";

  for (const [path, entry] of Object.entries(s.remote as Record<string, unknown>)) {
    const e = entry as Partial<RemoteEntry> & { state?: string };
    if (e?.state === "present") {
      if (typeof e.blobId !== "string" || typeof e.seq !== "number") {
        return `state file has a malformed remote entry for ${path}`;
      }
    } else if (e?.state !== "deleted" || typeof e.seq !== "number") {
      return `state file has a malformed remote entry for ${path}`;
    }
  }

  for (const [path, file] of Object.entries(s.files as Record<string, unknown>)) {
    const f = file as Partial<BaseFile>;
    if (typeof f?.blobId !== "string" || typeof f.size !== "number" || typeof f.mtime !== "number") {
      return `state file has a malformed entry for ${path}`;
    }
  }
  return undefined;
}


/**
 * Writes the state so that *some* valid state file exists at every instant.
 *
 * The obvious sequence — remove the old file, rename the new one into place —
 * has a window with no state file at all. A crash or a mobile app suspension
 * inside it loses the base state, and losing base state is exactly what makes
 * every path untracked and trips the mass-deletion guard. So the old file is
 * renamed aside rather than removed, and `loadState` recovers from it.
 */
export async function saveState(
  adapter: VaultAdapter,
  layout: VaultLayout,
  state: BaseState,
): Promise<void> {
  const STATE_PATH = statePath(layout);
  const TMP_PATH = `${STATE_PATH}.tmp`;
  const PREVIOUS_PATH = `${STATE_PATH}.prev`;
  await ensureDir(adapter, layout.pluginDir);
  await adapter.write(TMP_PATH, JSON.stringify(state));

  if (await adapter.exists(STATE_PATH)) {
    if (await adapter.exists(PREVIOUS_PATH)) await adapter.remove(PREVIOUS_PATH);
    await adapter.rename(STATE_PATH, PREVIOUS_PATH);
  }
  await adapter.rename(TMP_PATH, STATE_PATH);

  if (await adapter.exists(PREVIOUS_PATH)) await adapter.remove(PREVIOUS_PATH);
}

export async function ensureDir(adapter: VaultAdapter, dir: string): Promise<void> {
  if (!dir || dir === "." || dir === "/") return;
  if (await adapter.exists(dir)) return;

  // Create parents first; mkdir is not recursive on all platforms.
  //
  // The cut must be checked explicitly: `lastIndexOf` returns -1 for a
  // top-level folder, and `slice(0, -1)` would then drop the last *character*
  // rather than the last segment — creating J, Je, Jer, ... in the vault root.
  const cut = dir.lastIndexOf("/");
  const parent = cut === -1 ? "" : dir.slice(0, cut);
  if (parent) await ensureDir(adapter, parent);
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
}
