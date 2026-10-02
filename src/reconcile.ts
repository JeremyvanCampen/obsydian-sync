/**
 * The three-way merge. See ../../protocol/PROTOCOL.md §6.
 *
 * This module is deliberately **pure**: no filesystem, no network, no clock of
 * its own. Every decision the sync makes is taken here, so every decision is
 * testable without mocks — and the parts that touch the world (`apply.ts`)
 * contain no decisions at all.
 */

import type {
  BaseFile,
  BaseIndex,
  LocalFile,
  LocalIndex,
  RemoteIndex,
  RemotePresent,
  RemoteTombstone,
} from "./types.ts";

/**
 * The local file as reconcile saw it when it made the decision.
 *
 * The vault can change between the scan and the moment apply acts — autosave
 * fires while a sync runs. Every action that touches a local file carries what
 * it expects to find, and apply refuses to act if the file no longer matches.
 * One rule for every action, rather than a separate guard per action kind,
 * each written after the race it covers was found.
 */
export type Expect = { blobId: string } | "absent";

export type Action =
  /** Upload local content (if the server lacks it) and journal a `put`. */
  | { kind: "push-put"; path: string; local: LocalFile; expect: Expect }
  /** Journal a `delete`. `mtime` is the time of *deletion*, not of the content. */
  | { kind: "push-delete"; path: string; mtime: number; expect: Expect }
  /** Download and write the remote content. */
  | { kind: "pull-put"; path: string; remote: RemotePresent; expect: Expect }
  /**
   * Both sides changed `path` to different content. Keep the local version at
   * `path`, write the remote version to `copyPath`, and journal both.
   *
   * One action because its two halves must happen together or not at all.
   * Split in two, a refused copy (something appeared at `copyPath` mid-sync)
   * would still let the push go ahead — replacing the remote version at `path`,
   * which the other device then pulls as an ordinary edit, overwriting its own.
   * `expect` is for `path`; `copyPath` must not exist.
   */
  | {
      kind: "conflict";
      path: string;
      copyPath: string;
      local: LocalFile;
      remote: RemotePresent;
      expect: Expect;
    }
  /**
   * Replace an untracked local file with the vault's version, moving the local
   * one to `.trash` first. Only for vault settings: see `isVaultConfig`.
   */
  | { kind: "replace-local"; path: string; remote: RemotePresent; expect: Expect }
  /** Move the local file to `.trash` — only ever against a real tombstone. */
  | { kind: "pull-delete"; path: string; remote: RemoteTombstone; expect: Expect }
  /** Both sides already agree; record it in base and touch nothing. */
  | { kind: "adopt-base"; path: string; blobId: string; size: number; mtime: number }
  /** Both sides deleted it; forget it. */
  | { kind: "drop-base"; path: string };

export interface Note {
  level: "info" | "warn";
  path: string;
  message: string;
}

export interface Plan {
  actions: Action[];
  /** Decisions worth surfacing: resurrections, tombstones applied, conflicts. */
  notes: Note[];
  /**
   * Set when the plan would delete a suspicious number of untracked files.
   *
   * Losing base state — a plugin reinstall, a cleared state file, a vault
   * copied to a new device — makes *every* path untracked at once, and the
   * untracked tombstone rule then judges each one on timestamps alone. That is
   * a weak signal for a destructive act, so past a threshold the plan refuses
   * to run unattended and asks.
   */
  needsConfirmation?: {
    reason: string;
    deletions: number;
    localFiles: number;
  };
}

export interface ReconcileInput {
  base: BaseIndex;
  local: LocalIndex;
  remote: RemoteIndex;
  /** Injected so conflict filenames are deterministic under test. */
  now: Date;
  /**
   * Whether a path is excluded from sync.
   *
   * This must be asked, not inferred. An excluded path is simply absent from
   * the scan, which is indistinguishable from a local deletion — so adding a
   * folder to the exclude list, or turning off config-folder syncing, would
   * otherwise push a tombstone per path and move those files to trash on every
   * other device.
   */
  isExcluded?: (path: string) => boolean;
  /**
   * Whether a path is vault settings (inside a config folder).
   *
   * A device joining the vault arrives with settings Obsidian generated for
   * it: a default `app.json`, a `community-plugins.json` listing only what was
   * installed to get the sync running. Treated like notes, each of those is a
   * first-sync conflict that keeps the *device's* defaults in place and pushes
   * them to every other device — so setting up a laptop switched plugins off on
   * the desktop. For settings, the vault's version is the one that counts.
   *
   * Only while the device is *joining* — no sync history at all. An untracked
   * setting on a device that does have history (config sync switched on late,
   * or off and on again) may be its real settings, and still conflicts.
   */
  isVaultConfig?: (path: string) => boolean;
}

/** How the local file compares to what we last synced. */
type LocalRel = "same" | "modified" | "deleted" | "added";

/** How the remote entry compares to what we last synced. */
type RemoteRel = "same" | "modified" | "deleted" | "added" | "unknown";

/**
 * Untracked deletions allowed before the plan asks for confirmation: a few are
 * normal housekeeping, dozens mean the base state was lost.
 */
export const UNTRACKED_DELETE_LIMIT = 5;
const UNTRACKED_DELETE_FRACTION = 0.1;

export function reconcile(input: ReconcileInput): Plan {
  const { base, local, remote, now } = input;
  const actions: Action[] = [];
  const notes: Note[] = [];
  let untrackedDeletions = 0;
  // No history at all: a new device, or one whose state was lost entirely.
  // Either way it has nothing of its own that the vault has not seen.
  const joining = base.size === 0;

  const paths = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()]);

  // Conflict filenames must not collide with anything that already exists, nor
  // with another conflict produced in this same run.
  const taken = new Set<string>([...local.keys(), ...remote.keys()]);

  for (const path of [...paths].sort()) {
    if (input.isExcluded?.(path)) {
      // Stop tracking it locally, but journal nothing: the file still belongs
      // to whoever else is syncing it.
      if (base.has(path)) {
        actions.push({ kind: "drop-base", path });
        notes.push({
          level: "info",
          path,
          message: "now excluded from sync; forgetting it locally without deleting it anywhere",
        });
      }
      continue;
    }

    const b = base.get(path);
    const l = local.get(path);
    const r = remote.get(path);

    if (b) {
      handleTracked(path, b, l, r);
    } else {
      handleUntracked(path, l, r);
    }
  }

  const plan: Plan = { actions, notes };

  const allowed = Math.max(UNTRACKED_DELETE_LIMIT, Math.floor(local.size * UNTRACKED_DELETE_FRACTION));
  if (untrackedDeletions > allowed) {
    plan.needsConfirmation = {
      reason:
        `${untrackedDeletions} files would be moved to trash because the vault records them as ` +
        `deleted and this device has no sync history for them. That usually means the base state ` +
        `was lost rather than that the files should go.`,
      deletions: untrackedDeletions,
      localFiles: local.size,
    };
  }

  return plan;

  // --- a path we have synced before --------------------------------------

  function handleTracked(
    path: string,
    b: BaseFile,
    l: LocalFile | undefined,
    r: ReturnType<RemoteIndex["get"]>,
  ): void {
    const localRel: LocalRel = !l ? "deleted" : l.blobId === b.blobId ? "same" : "modified";
    const remoteRel: RemoteRel = !r
      ? "unknown"
      : r.state === "deleted"
        ? "deleted"
        : r.blobId === b.blobId
          ? "same"
          : "modified";

    // A path absent from the remote index entirely — a wiped server, a
    // truncated journal, a client aimed at a fresh vault. Never a reason to
    // touch local data.
    if (remoteRel === "unknown") {
      if (localRel === "deleted") {
        // "Unknown" can mean the index is incomplete, not that the path is
        // really gone from the vault. Dropping base here would leave the
        // deletion unrecorded, and the next complete index would pull the file
        // straight back — a resurrection by another route. Record it instead;
        // a tombstone for a path the server does not know is harmless.
        actions.push({ kind: "push-delete", path, mtime: now.getTime(), expect: "absent" });
        notes.push({
          level: "warn",
          path,
          message:
            "deleted here, and the remote has no record of the path; recording the deletion anyway",
        });
      } else {
        actions.push({ kind: "push-put", path, local: l!, expect: { blobId: l!.blobId } });
        notes.push({
          level: "warn",
          path,
          message: "remote has no record of this path; re-pushing rather than deleting locally",
        });
      }
      return;
    }

    switch (`${localRel}:${remoteRel}`) {
      case "same:same":
        return; // nothing to do

      case "same:modified":
        actions.push({ kind: "pull-put", path, remote: r as RemotePresent, expect: { blobId: l!.blobId } });
        return;

      case "same:deleted":
        // The only route by which a local file is deleted: an explicit
        // tombstone, against local content we have not touched since syncing.
        actions.push({
          kind: "pull-delete",
          path,
          remote: r as RemoteTombstone,
          expect: { blobId: l!.blobId },
        });
        notes.push({
          level: "info",
          path,
          message: "deleted in the vault; moving the local copy to trash",
        });
        return;

      case "modified:same":
        actions.push({ kind: "push-put", path, local: l!, expect: { blobId: l!.blobId } });
        return;

      case "modified:modified": {
        if (l!.blobId === (r as RemotePresent).blobId) {
          // Both sides landed on identical content independently.
          actions.push({
            kind: "adopt-base",
            path,
            blobId: l!.blobId,
            size: l!.size,
            mtime: l!.mtime,
          });
          return;
        }
        emitConflict(path, l!, r as RemotePresent, "both sides changed");
        return;
      }

      case "modified:deleted":
        // Local work exists that the deleting device never saw. Losing an edit
        // is worse than an unwanted file returning, and the return is visible
        // while the lost edit would not be.
        actions.push({ kind: "push-put", path, local: l!, expect: { blobId: l!.blobId } });
        notes.push({
          level: "warn",
          path,
          message: "deleted remotely but edited here; the local edit wins and the file is restored",
        });
        return;

      case "deleted:same":
        // The tombstone is stamped with *now*, not with the content's mtime.
        // A content timestamp is by construction older than every copy of that
        // file on every other device, which would make the untracked-tombstone
        // rule below re-push all of them.
        actions.push({ kind: "push-delete", path, mtime: now.getTime(), expect: "absent" });
        return;

      case "deleted:modified":
        // Mirror of the case above: someone edited it after we deleted it.
        actions.push({ kind: "pull-put", path, remote: r as RemotePresent, expect: "absent" });
        notes.push({
          level: "warn",
          path,
          message: "deleted here but edited remotely; the remote edit wins and the file is restored",
        });
        return;

      case "deleted:deleted":
        actions.push({ kind: "drop-base", path });
        return;

      default:
        throw new Error(`unhandled reconcile case ${localRel}:${remoteRel} for ${path}`);
    }
  }

  // --- a path we have never synced ---------------------------------------

  function handleUntracked(
    path: string,
    l: LocalFile | undefined,
    r: ReturnType<RemoteIndex["get"]>,
  ): void {
    if (l && !r) {
      actions.push({ kind: "push-put", path, local: l, expect: { blobId: l.blobId } });
      return;
    }

    if (!l && r) {
      if (r.state === "present") {
        actions.push({ kind: "pull-put", path, remote: r, expect: "absent" });
      }
      // A tombstone for a file this device never had is already satisfied.
      return;
    }

    if (l && r) {
      if (r.state === "present") {
        if (l.blobId === r.blobId) {
          actions.push({ kind: "adopt-base", path, blobId: l.blobId, size: l.size, mtime: l.mtime });
          return;
        }
        if (joining && input.isVaultConfig?.(path)) {
          actions.push({ kind: "replace-local", path, remote: r, expect: { blobId: l.blobId } });
          notes.push({
            level: "warn",
            path,
            message:
              "first sync of this setting: the vault's version replaces this device's, which is in .trash",
          });
          return;
        }
        emitConflict(path, l, r, "first sync found different content on both sides");
        return;
      }

      // Local file, remote tombstone, and no base to say which came first.
      //
      // This is the stale-copy case: a device set up from an old backup would
      // otherwise resurrect everything the vault has legitimately deleted —
      // the very bug this project exists to fix, wearing a different hat. The
      // only evidence available is the timestamps, so use them, and prefer
      // deleting (recoverable from .trash) over resurrecting (silent).
      if (l.mtime > r.mtime) {
        actions.push({ kind: "push-put", path, local: l, expect: { blobId: l.blobId } });
        notes.push({
          level: "warn",
          path,
          message: "deleted remotely, but the local file is newer than the deletion; keeping it",
        });
      } else {
        // Expecting the scanned content: if it is untouched when apply runs,
        // the timestamp judgement above still holds. If it changed, apply keeps
        // it — no second copy of this rule is needed there.
        actions.push({ kind: "pull-delete", path, remote: r, expect: { blobId: l.blobId } });
        untrackedDeletions++;
        notes.push({
          // A warning, not an informational note: this deletes a file on
          // evidence no stronger than a timestamp.
          level: "warn",
          path,
          message: "no sync history for this path and the vault records it as deleted; moving to trash",
        });
      }
    }
  }

  /**
   * Both sides changed to different content. Keep the local version where it
   * is, write the remote version beside it, and push both — so the other
   * device receives this edit and the conflict copy, and the next sync sees
   * two ordinary converged files rather than conflicting again forever.
   */
  function emitConflict(path: string, l: LocalFile, r: RemotePresent, why: string): void {
    // Named after the device the conflicting version came from, not this one.
    // The file holds the *remote* content, so naming it after the local device
    // tells the reader the opposite of the truth.
    const origin = r.deviceId ?? "another device";
    const conflictPath = allocateConflictPath(path, origin, now, taken);

    actions.push({
      kind: "conflict",
      path,
      copyPath: conflictPath,
      local: l,
      remote: r,
      expect: { blobId: l.blobId },
    });

    notes.push({ level: "warn", path, message: `${why}; remote version kept as "${conflictPath}"` });
  }
}

/**
 * Most filesystems cap a single name component at 255 bytes. Leave headroom for
 * a `` 2`` disambiguator and for the difference between characters and bytes.
 */
const MAX_NAME_BYTES = 200;

/**
 * `Standup (conflict from iphone 2026-09-09 14.02).md`, with a numeric suffix
 * if that name is somehow taken. Registers the result so two conflicts in one
 * run cannot pick the same name.
 *
 * The stem is truncated if needed. Obsidian happily makes a note title out of
 * a whole first line, so a long title plus the conflict label can exceed the
 * filesystem limit — which would turn a recoverable conflict into a failed sync.
 */
export function allocateConflictPath(
  path: string,
  deviceId: string,
  now: Date,
  taken: Set<string>,
): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);

  // Treat only a trailing extension as the extension, so `notes.excalidraw.md`
  // keeps `.excalidraw` in its stem rather than losing it.
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? "" : name.slice(dot);

  const stamp = formatStamp(now);
  const suffix = ` (conflict from ${deviceId} ${stamp})`;
  const budget = MAX_NAME_BYTES - byteLength(suffix) - byteLength(ext);
  const label = `${truncateToBytes(stem, Math.max(budget, 8))}${suffix}`;

  let candidate = `${dir}${label}${ext}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${dir}${label} ${n}${ext}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Truncates on a character boundary so the UTF-8 encoding stays valid. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/** `YYYY-MM-DD HH.mm` in local time — dots because `:` is illegal on Windows. */
function formatStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}.${p(now.getMinutes())}`
  );
}
