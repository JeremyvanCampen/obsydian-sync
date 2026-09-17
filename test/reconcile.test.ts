import { describe, expect, it } from "vitest";
import {
  type Action,
  type Plan,
  UNTRACKED_DELETE_LIMIT,
  allocateConflictPath,
  reconcile,
} from "../src/reconcile.ts";
import type { BaseFile, BaseIndex, LocalFile, LocalIndex, RemoteEntry, RemoteIndex } from "../src/types.ts";

const NOW = new Date(2026, 8, 13, 14, 2); // 2026-09-13 14.02 local
const DEVICE = "macbook";

const baseFile = (blobId: string, mtime = 1000): BaseFile => ({ blobId, size: blobId.length, mtime });
const localFile = (path: string, blobId: string, mtime = 1000): LocalFile => ({
  path,
  blobId,
  size: blobId.length,
  mtime,
});
const present = (blobId: string, seq = 1, mtime = 1000, deviceId = "iphone"): RemoteEntry => ({
  state: "present",
  blobId,
  size: blobId.length,
  mtime,
  seq,
  deviceId,
});
const tombstone = (seq = 1, mtime = 1000): RemoteEntry => ({ state: "deleted", mtime, seq });

function run(opts: {
  base?: Record<string, BaseFile>;
  local?: Record<string, LocalFile>;
  remote?: Record<string, RemoteEntry>;
}): Plan {
  const base: BaseIndex = new Map(Object.entries(opts.base ?? {}));
  const local: LocalIndex = new Map(Object.entries(opts.local ?? {}));
  const remote: RemoteIndex = new Map(Object.entries(opts.remote ?? {}));
  return reconcile({ base, local, remote, deviceId: DEVICE, now: NOW });
}

const kinds = (plan: Plan): string[] => plan.actions.map((a) => a.kind);
const only = (plan: Plan): Action => {
  expect(plan.actions).toHaveLength(1);
  return plan.actions[0]!;
};

describe("tracked paths: the full matrix", () => {
  it("same / same -> nothing", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "aa") },
      remote: { "a.md": present("aa") },
    });
    expect(plan.actions).toHaveLength(0);
  });

  it("same / modified -> pull", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "aa") },
      remote: { "a.md": present("bb") },
    });
    expect(only(plan)).toMatchObject({ kind: "pull-put", path: "a.md" });
  });

  it("same / deleted -> delete locally, and say so in the log", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "aa") },
      remote: { "a.md": tombstone() },
    });
    expect(only(plan)).toMatchObject({ kind: "pull-delete", path: "a.md" });
    // The one action that destroys local data must never be silent.
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]?.path).toBe("a.md");
  });

  it("modified / same -> push", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "bb") },
      remote: { "a.md": present("aa") },
    });
    expect(only(plan)).toMatchObject({ kind: "push-put", path: "a.md" });
  });

  it("modified / modified to the same content -> adopt base, no transfer", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "cc") },
      remote: { "a.md": present("cc") },
    });
    expect(only(plan)).toMatchObject({ kind: "adopt-base", path: "a.md", blobId: "cc" });
  });

  it("modified / modified differently -> conflict, nothing discarded", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "bb") },
      remote: { "a.md": present("cc") },
    });
    const CONFLICT = "a (conflict from iphone 2026-09-13 14.02).md";

    // A conflict is three primitive actions, not one compound one: write the
    // remote version beside the local one, journal it, and push the local one.
    expect(plan.actions).toEqual([
      { kind: "pull-put", path: CONFLICT, remote: present("cc") },
      { kind: "push-copy", path: CONFLICT, blobId: "cc", size: 2, mtime: NOW.getTime() },
      { kind: "push-put", path: "a.md", local: localFile("a.md", "bb") },
    ]);
    expect(plan.notes[0]?.level).toBe("warn");
  });

  it("a conflict converges: the next sync sees two ordinary files", () => {
    // The failure this guards against is a conflict copy being created on
    // every sync forever, because base was never advanced and nothing pushed.
    const CONFLICT = "a (conflict from iphone 2026-09-13 14.02).md";

    const first = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "bb") },
      remote: { "a.md": present("cc") },
    });

    // Apply it: local keeps "bb" at a.md and gains "cc" at the sidecar; both
    // paths are pushed, so base and remote end up agreeing on both.
    expect(first.actions).toHaveLength(3);

    const second = run({
      base: { "a.md": baseFile("bb"), [CONFLICT]: baseFile("cc") },
      local: { "a.md": localFile("a.md", "bb"), [CONFLICT]: localFile(CONFLICT, "cc") },
      remote: { "a.md": present("bb", 3), [CONFLICT]: present("cc", 4) },
    });

    expect(second.actions).toHaveLength(0);
  });

  it("modified / deleted -> the local edit wins and is logged", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "bb") },
      remote: { "a.md": tombstone() },
    });
    expect(only(plan)).toMatchObject({ kind: "push-put", path: "a.md" });
    expect(plan.notes[0]?.message).toMatch(/local edit wins/);
  });

  it("deleted / same -> push the deletion, stamped with the deletion time", () => {
    const plan = run({
      base: { "a.md": baseFile("aa", 1000) },
      remote: { "a.md": present("aa") },
    });
    // Not the content's mtime: a content timestamp is older than every copy of
    // that file on every other device, which would make each of them re-push it.
    expect(only(plan)).toEqual({ kind: "push-delete", path: "a.md", mtime: NOW.getTime() });
  });

  it("deleted / modified -> the remote edit wins and is logged", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      remote: { "a.md": present("bb") },
    });
    expect(only(plan)).toMatchObject({ kind: "pull-put", path: "a.md" });
    expect(plan.notes[0]?.message).toMatch(/remote edit wins/);
  });

  it("deleted / deleted -> forget it", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      remote: { "a.md": tombstone() },
    });
    expect(only(plan)).toMatchObject({ kind: "drop-base", path: "a.md" });
  });
});

describe("the safety invariant: no local delete without a tombstone", () => {
  it("re-pushes rather than deleting when the remote has no record at all", () => {
    // A wiped server, a truncated journal, or a client aimed at a fresh vault.
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "aa") },
      remote: {},
    });
    expect(only(plan)).toMatchObject({ kind: "push-put", path: "a.md" });
    expect(plan.notes[0]?.level).toBe("warn");
  });

  it("an entirely empty remote index cannot empty the vault", () => {
    const plan = run({
      base: { "a.md": baseFile("aa"), "b.md": baseFile("bb"), "c.md": baseFile("cc") },
      local: {
        "a.md": localFile("a.md", "aa"),
        "b.md": localFile("b.md", "bb"),
        "c.md": localFile("c.md", "cc"),
      },
      remote: {},
    });
    expect(kinds(plan)).toEqual(["push-put", "push-put", "push-put"]);
    expect(kinds(plan)).not.toContain("pull-delete");
  });

  it("stops tracking a path that is gone from both sides", () => {
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: {},
      remote: { "a.md": tombstone() },
    });
    expect(only(plan)).toMatchObject({ kind: "drop-base", path: "a.md" });
  });

  it("records a local deletion even when the remote has no record of the path", () => {
    // "Unknown" can mean an incomplete index rather than a truly absent path.
    // Dropping base here would leave the deletion unrecorded, and the next
    // complete index would pull the file straight back.
    const plan = run({ base: { "a.md": baseFile("aa") }, local: {}, remote: {} });
    expect(only(plan)).toMatchObject({ kind: "push-delete", path: "a.md" });
    expect(plan.notes[0]?.level).toBe("warn");
  });
});

describe("untracked paths", () => {
  it("a new local file is pushed", () => {
    const plan = run({ local: { "new.md": localFile("new.md", "aa") } });
    expect(only(plan)).toMatchObject({ kind: "push-put", path: "new.md" });
  });

  it("a new remote file is pulled", () => {
    const plan = run({ remote: { "new.md": present("aa") } });
    expect(only(plan)).toMatchObject({ kind: "pull-put", path: "new.md" });
  });

  it("a tombstone for a file this device never had is already satisfied", () => {
    const plan = run({ remote: { "gone.md": tombstone() } });
    expect(plan.actions).toHaveLength(0);
  });

  it("identical content on both sides needs no transfer", () => {
    const plan = run({
      local: { "a.md": localFile("a.md", "aa") },
      remote: { "a.md": present("aa") },
    });
    expect(only(plan)).toMatchObject({ kind: "adopt-base" });
  });

  it("different content on both sides conflicts rather than picking one", () => {
    const plan = run({
      local: { "a.md": localFile("a.md", "aa") },
      remote: { "a.md": present("bb") },
    });
    expect(kinds(plan)).toEqual(["pull-put", "push-copy", "push-put"]);
    // The local version stays exactly where it was.
    expect(plan.actions.find((a) => a.kind === "push-put")?.path).toBe("a.md");
  });

  describe("stale-copy protection", () => {
    it("applies a remote deletion that postdates an untracked local copy", () => {
      // A device set up from an old backup must not resurrect everything the
      // vault has legitimately deleted.
      const plan = run({
        local: { "old.md": localFile("old.md", "aa", 1000) },
        remote: { "old.md": tombstone(5, 2000) },
      });
      expect(only(plan)).toMatchObject({ kind: "pull-delete", path: "old.md" });
    });

    it("keeps an untracked local file that is newer than the deletion", () => {
      const plan = run({
        local: { "old.md": localFile("old.md", "aa", 3000) },
        remote: { "old.md": tombstone(5, 2000) },
      });
      expect(only(plan)).toMatchObject({ kind: "push-put", path: "old.md" });
      expect(plan.notes[0]?.level).toBe("warn");
    });
  });
});

describe("the scenario this project exists for", () => {
  // Device B deletes a note. Device A must lose it and must not push it back —
  // not on the next sync, and not on the one after that.
  it("a deletion propagates once and never resurrects", () => {
    const PATH = "Test.md";
    const BLOB = "aaaa";

    // Device A, in sync at seq 1.
    let baseA: Record<string, BaseFile> = { [PATH]: baseFile(BLOB) };
    let localA: Record<string, LocalFile> = { [PATH]: localFile(PATH, BLOB) };

    // Device B deleted it; the journal carries a tombstone at seq 2.
    const remote: Record<string, RemoteEntry> = { [PATH]: tombstone(2) };

    // First sync after the deletion: A removes the file.
    const first = run({ base: baseA, local: localA, remote });
    expect(only(first)).toMatchObject({ kind: "pull-delete", path: PATH });

    // Apply it: the file is gone locally and base no longer tracks it.
    localA = {};
    baseA = {};

    // Second sync — the step remotely-save fails. Nothing to do, and crucially
    // no push-put that would resurrect the note on device B.
    const second = run({ base: baseA, local: localA, remote });
    expect(second.actions).toHaveLength(0);

    // Third sync, same.
    const third = run({ base: baseA, local: localA, remote });
    expect(third.actions).toHaveLength(0);
  });

  it("the deleting device does not re-push either", () => {
    // Device B after its own deletion synced: no base, no local, its own tombstone.
    const plan = run({ remote: { "Test.md": tombstone(2) } });
    expect(plan.actions).toHaveLength(0);
  });
});

describe("conflict filenames", () => {
  const taken = () => new Set<string>();

  it("keeps the folder and the extension", () => {
    expect(allocateConflictPath("Work/Meetings/Standup.md", "iphone", NOW, taken())).toBe(
      "Work/Meetings/Standup (conflict from iphone 2026-09-13 14.02).md",
    );
  });

  it("keeps compound extensions in the stem", () => {
    // Excalidraw files are `.excalidraw.md`; splitting on the first dot would
    // mangle them.
    expect(allocateConflictPath("Drawing.excalidraw.md", "iphone", NOW, taken())).toBe(
      "Drawing.excalidraw (conflict from iphone 2026-09-13 14.02).md",
    );
  });

  it("handles a file with no extension", () => {
    expect(allocateConflictPath("LICENSE", "iphone", NOW, taken())).toBe(
      "LICENSE (conflict from iphone 2026-09-13 14.02)",
    );
  });

  it("handles a dotfile without treating it as all-extension", () => {
    expect(allocateConflictPath(".gitignore", "iphone", NOW, taken())).toBe(
      ".gitignore (conflict from iphone 2026-09-13 14.02)",
    );
  });

  it("avoids colliding with an existing file", () => {
    const existing = new Set(["a (conflict from iphone 2026-09-13 14.02).md"]);
    expect(allocateConflictPath("a.md", "iphone", NOW, existing)).toBe(
      "a (conflict from iphone 2026-09-13 14.02) 2.md",
    );
  });

  it("is named after the device the content came from, not the local one", () => {
    // The file holds the remote version. Naming it after the local device says
    // the opposite of the truth to whoever opens it.
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "bb") },
      remote: { "a.md": present("cc", 1, 1000, "iphone") },
    });
    const copy = plan.actions.find((a) => a.kind === "push-copy");
    expect(copy?.path).toContain("conflict from iphone");
    expect(copy?.path).not.toContain("macbook");
  });

  it("falls back gracefully when the origin device is unknown", () => {
    // State files written before deviceId was recorded have no origin.
    const plan = run({
      base: { "a.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "bb") },
      remote: { "a.md": { state: "present", blobId: "cc", size: 2, mtime: 1000, seq: 1 } },
    });
    const copy = plan.actions.find((a) => a.kind === "push-copy");
    expect(copy?.path).toContain("conflict from another device");
  });

  it("avoids colliding with another conflict in the same run", () => {
    const plan = run({
      base: { "a.md": baseFile("aa"), "b.md": baseFile("aa") },
      local: { "a.md": localFile("a.md", "bb"), "b.md": localFile("b.md", "bb") },
      remote: { "a.md": present("cc"), "b.md": present("cc") },
    });
    const names = plan.actions.filter((a) => a.kind === "push-copy").map((a) => a.path);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("keeps the name within the filesystem limit for a very long title", () => {
    // Obsidian will happily make a note title out of a whole first line.
    const stem = "x".repeat(300);
    const result = allocateConflictPath(`${stem}.md`, "macbook", NOW, new Set());
    const name = result.slice(result.lastIndexOf("/") + 1);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(result.endsWith(".md")).toBe(true);
    expect(result).toContain("(conflict from macbook");
  });

  it("keeps multi-byte characters intact when truncating", () => {
    const result = allocateConflictPath(`${"é".repeat(200)}.md`, "macbook", NOW, new Set());
    const name = result.slice(result.lastIndexOf("/") + 1);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name).not.toContain("\uFFFD");
  });

  it("uses dots in the time, since colons are illegal on Windows", () => {
    expect(allocateConflictPath("a.md", "iphone", NOW, taken())).not.toContain(":");
  });
});

describe("mass-deletion guard", () => {
  // Losing base state makes every path untracked at once, and the untracked
  // tombstone rule then judges each on timestamps alone — a weak signal for a
  // destructive act.
  const staleCopy = (n: number) => {
    const local: Record<string, LocalFile> = {};
    const remote: Record<string, RemoteEntry> = {};
    for (let i = 0; i < n; i++) {
      local[`n${i}.md`] = localFile(`n${i}.md`, `b${i}`, 1000);
      remote[`n${i}.md`] = tombstone(i + 1, 2000);
    }
    return { local, remote };
  };

  it("asks before trashing many untracked files", () => {
    const plan = run(staleCopy(40));
    expect(plan.needsConfirmation).toBeDefined();
    expect(plan.needsConfirmation?.deletions).toBe(40);
  });

  it("does not ask for a handful", () => {
    const plan = run(staleCopy(UNTRACKED_DELETE_LIMIT));
    expect(plan.needsConfirmation).toBeUndefined();
  });

  it("scales the threshold with vault size", () => {
    // 8 deletions out of 200 files is routine housekeeping, not a lost state file.
    const { local, remote } = staleCopy(8);
    for (let i = 0; i < 200; i++) local[`keep${i}.md`] = localFile(`keep${i}.md`, `k${i}`);
    expect(run({ local, remote }).needsConfirmation).toBeUndefined();
  });

  it("warns on every such deletion, not just in aggregate", () => {
    const plan = run(staleCopy(3));
    expect(plan.notes.filter((n) => n.level === "warn")).toHaveLength(3);
  });
});

describe("determinism", () => {
  it("orders actions by path, so two runs of the same input agree", () => {
    const input = {
      local: {
        "z.md": localFile("z.md", "aa"),
        "a.md": localFile("a.md", "bb"),
        "m.md": localFile("m.md", "cc"),
      },
    };
    const paths = run(input).actions.map((a) => a.path);
    expect(paths).toEqual(["a.md", "m.md", "z.md"]);
    expect(run(input)).toEqual(run(input));
  });
});
