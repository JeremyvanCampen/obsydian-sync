/**
 * Walks the vault and produces the "local" input to reconciliation.
 *
 * Two things here are load-bearing:
 *
 *  - **Exclusions.** Getting these wrong corrupts the plugin mid-sync, or
 *    fights another device over per-device state that should never travel.
 *  - **Change detection by content, not timestamp.** `(mtime, size)` is only a
 *    fast path allowing a re-hash to be skipped; any mismatch triggers a real
 *    read. Mobile filesystems report timestamps too unreliably to trust.
 */

import type { VaultAdapter } from "./adapter.ts";
import type { Bytes, VaultKeys } from "./crypto.ts";
import { blobIdFor } from "./crypto.ts";
import type { BaseIndex, LocalFile, LocalIndex } from "./types.ts";
import { PLUGIN_DIR } from "./state.ts";

/**
 * Paths never synced, whatever the settings say.
 *
 * - `workspace.json` / `workspace-mobile.json` are per-device pane layout and
 *   change on almost every interaction; syncing them means a permanent
 *   conflict and a phone dictating a laptop's window arrangement.
 * - The plugin's own folder holds this device's base state and its passphrase.
 *   Syncing it would overwrite a device's history with another's, and would
 *   rewrite the running plugin's code underneath itself.
 * - `.trash` is where a wrong deletion goes to stay recoverable. Syncing it
 *   would propagate the deletion it exists to protect against.
 */
export const ALWAYS_EXCLUDED: readonly string[] = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  `${PLUGIN_DIR}/`,
  ".trash/",
  ".git/",
  ".DS_Store",
  "*.tmp",
];

export interface ScanOptions {
  adapter: VaultAdapter;
  keys: VaultKeys;
  /** Previous sync's state, used only to skip re-hashing unchanged files. */
  base: BaseIndex;
  /** Extra user patterns, same syntax as ALWAYS_EXCLUDED. */
  exclude?: readonly string[];
  /** Whether to descend into `.obsidian` at all. */
  includeVaultConfig: boolean;
  /** Reports files that could not be read, rather than failing the whole scan. */
  onProblem?: (path: string, error: unknown) => void;
}

export interface ScanResult {
  local: LocalIndex;
  /** Files whose content had to be read and hashed. Useful for the sync log. */
  hashed: number;
  /** Files skipped because (mtime, size) still matched base. */
  reused: number;
}

/**
 * Matches a path against one pattern. Three forms, chosen because they cover
 * the real cases without pulling in a glob library:
 *
 *  - `dir/`      — the directory and everything under it
 *  - `*.ext`     — any file whose name ends in `.ext`
 *  - `some/path` — that exact path
 */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path === pattern.slice(0, -1) || path.startsWith(pattern);
  if (pattern.startsWith("*.")) return path.endsWith(pattern.slice(1));
  if (!pattern.includes("/")) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name === pattern;
  }
  return path === pattern;
}

export function isExcluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(path, p));
}

/**
 * Whether a path is excluded, either directly or because an ancestor folder is.
 *
 * The scan prunes a folder and never descends, so its children are simply
 * absent from the local index. Anything asking "is this path excluded?" — the
 * reconciler above all — has to answer the same way, or those children look
 * deleted rather than excluded, and every other device trashes them.
 */
export function isExcludedPath(path: string, patterns: readonly string[]): boolean {
  if (isExcluded(path, patterns)) return true;

  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const ancestor = path.slice(0, i);
    if (isExcluded(ancestor, patterns) || isExcluded(`${ancestor}/`, patterns)) return true;
  }
  return false;
}

export async function scanVault(opts: ScanOptions): Promise<ScanResult> {
  const { adapter, keys, base, includeVaultConfig, onProblem } = opts;
  const patterns = [...ALWAYS_EXCLUDED, ...(opts.exclude ?? [])];

  const local: LocalIndex = new Map();
  let hashed = 0;
  let reused = 0;

  const queue: string[] = [""];
  const seenFolders = new Set<string>();

  while (queue.length > 0) {
    const folder = queue.pop()!;

    let listing: { files: string[]; folders: string[] };
    try {
      listing = await adapter.list(folder);
    } catch (e) {
      onProblem?.(folder, e);
      continue;
    }

    for (const sub of listing.folders) {
      const normalized = normalizePath(sub);
      if (!includeVaultConfig && normalized === ".obsidian") continue;
      if (isExcluded(`${normalized}/`, patterns) || isExcluded(normalized, patterns)) continue;
      // Guard against a symlink loop reported by the adapter.
      if (seenFolders.has(normalized)) continue;
      seenFolders.add(normalized);
      queue.push(normalized);
    }

    for (const file of listing.files) {
      const path = normalizePath(file);
      if (isExcluded(path, patterns)) continue;

      let stat: Awaited<ReturnType<VaultAdapter["stat"]>>;
      try {
        stat = await adapter.stat(path);
      } catch (e) {
        onProblem?.(path, e);
        continue;
      }
      if (!stat || stat.type !== "file") continue;

      const previous = base.get(path);
      if (previous && previous.mtime === stat.mtime && previous.size === stat.size) {
        // Fast path only. The content is *assumed* unchanged because both
        // timestamp and size match what we last hashed.
        local.set(path, { path, blobId: previous.blobId, size: stat.size, mtime: stat.mtime });
        reused++;
        continue;
      }

      let content: Bytes;
      try {
        content = new Uint8Array(await adapter.readBinary(path)) as Bytes;
      } catch (e) {
        // A file that cannot be read must not remove it from the index, or the
        // reconciler would read the absence as a deletion.
        onProblem?.(path, e);
        if (previous) {
          local.set(path, { path, blobId: previous.blobId, size: previous.size, mtime: previous.mtime });
        }
        continue;
      }

      const entry: LocalFile = {
        path,
        blobId: await blobIdFor(keys, content),
        size: content.length,
        mtime: stat.mtime,
      };
      local.set(path, entry);
      hashed++;
    }
  }

  return { local, hashed, reused };
}

/**
 * Canonical form for the wire: forward slashes, no leading slash, NFC.
 *
 * NFC is not cosmetic. macOS reports filenames decomposed, Linux and Android
 * pass the bytes through. Without this, `Café.md` created on the MacBook and
 * the same name created on Linux are two different paths, and the vault grows
 * a duplicate that never converges.
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
}
