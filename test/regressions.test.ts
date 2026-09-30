/**
 * One test per defect found reviewing M4. Each fails against the code as it
 * was written; none of them were caught by the original suite.
 */

import { describe, expect, it } from "vitest";
import { SyncApi } from "../src/api.ts";
import { applyPlan } from "../src/apply.ts";
import { type VaultKeys, blobIdFor, deriveKeys, deriveMasterKey, makeKdfCheck } from "../src/crypto.ts";
import type { Bytes } from "../src/crypto.ts";
import { ensureDir, loadState, saveState, STATE_PATH } from "../src/state.ts";
import { runSync } from "../src/sync.ts";
import type { BaseIndex, BaseState } from "../src/types.ts";
import { FakeAdapter, FakeServer } from "./fakes.ts";

const KDF = { alg: "PBKDF2-HMAC-SHA256" as const, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", iterations: 1000 };
const utf8 = new TextEncoder();

async function vault() {
  const server = new FakeServer({ "token-a": "macbook", "token-b": "iphone" });
  const keys = await deriveKeys(await deriveMasterKey("pw", KDF));
  server.kdfCheck = await makeKdfCheck(keys, server.vaultId);
  return { server, keys };
}

function device(server: FakeServer, keys: VaultKeys, token: string, exclude: string[] = [], includeVaultConfig = false) {
  const adapter = new FakeAdapter();
  const api = new SyncApi({ baseUrl: "http://fake", token, transport: server.transportFor(token), sleep: async () => {} });
  return {
    adapter,
    api,
    sync: () => runSync({ adapter, api, keys, includeVaultConfig, exclude }),
  };
}

describe("1: ensureDir created a folder per path prefix", () => {
  it("creates only real parents", async () => {
    const adapter = new FakeAdapter();
    await ensureDir(adapter, "Work/Meetings/Deep");
    expect([...adapter.folders].sort()).toEqual(["Work", "Work/Meetings", "Work/Meetings/Deep"]);
  });

  it("does not litter the vault root when pulling a new top-level folder", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    const b = device(server, keys, "token-b");

    a.adapter.put("Work/Meetings/Standup.md", "x");
    await a.sync();
    await b.sync();

    const junk = [...b.adapter.folders].filter((f) => "Work".startsWith(f) && f !== "Work");
    expect(junk).toEqual([]);
  });
});

describe("2: a file edited mid-sync was uploaded under the old blobId", () => {
  it("skips the push rather than poisoning the content-addressed store", async () => {
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = new SyncApi({ baseUrl: "http://fake", token: "token-a", transport: server.transportFor("token-a"), sleep: async () => {} });

    adapter.put("note.md", "original");
    const scanned = {
      path: "note.md",
      blobId: await blobIdFor(keys, utf8.encode("original") as Bytes),
      size: 8,
      mtime: adapter.clock,
    };

    // The user edits the note after the scan but before apply runs.
    adapter.put("note.md", "edited after the scan");

    const base: BaseIndex = new Map();
    const result = await applyPlan({
      adapter,
      api,
      keys,
      deviceId: "macbook",
      base,
      plan: { actions: [{ kind: "push-put", path: "note.md", local: scanned }], notes: [] },
    });

    expect(result.pushed).toBe(0);
    expect(server.blobs.size).toBe(0);
    // Crucially, base must not claim the scanned blobId was stored.
    expect(base.has("note.md")).toBe(false);
  });
});

describe("3: adding an exclusion deleted the files on every other device", () => {
  it("forgets excluded paths locally without journalling a deletion", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    const b = device(server, keys, "token-b");

    a.adapter.put("Work/secret.md", "confidential");
    a.adapter.put("keep.md", "fine");
    await a.sync();
    await b.sync();
    expect(b.adapter.text("Work/secret.md")).toBe("confidential");

    // A now excludes that folder.
    const aExcluding = {
      adapter: a.adapter,
      sync: () => runSync({ adapter: a.adapter, api: a.api, keys, includeVaultConfig: false, exclude: ["Work/"] }),
    };
    await aExcluding.sync();

    // No tombstone was written...
    const deletes = server.journal.length;
    await b.sync();

    // ...so B still has the file.
    expect(b.adapter.text("Work/secret.md")).toBe("confidential");
    expect(server.journal.length).toBe(deletes);
  });

  it("turning off vault-config sync does not delete .obsidian everywhere", async () => {
    const { server, keys } = await vault();
    const withConfig = device(server, keys, "token-a", [], true);
    const b = device(server, keys, "token-b", [], true);

    withConfig.adapter.put(".obsidian/app.json", "{}");
    withConfig.adapter.put("note.md", "x");
    await withConfig.sync();
    await b.sync();
    expect(b.adapter.text(".obsidian/app.json")).toBe("{}");

    // Same device, config syncing now off.
    await runSync({ adapter: withConfig.adapter, api: withConfig.api, keys, includeVaultConfig: false });
    await b.sync();

    expect(b.adapter.text(".obsidian/app.json")).toBe("{}");
  });
});

describe("0a: every reconciler decision was logged twice", () => {
  it("emits each plan note once", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    const b = device(server, keys, "token-b");

    a.adapter.put("doomed.md", "x");
    await a.sync();
    await b.sync();
    await a.adapter.trashLocal("doomed.md");
    await a.sync();

    const seen: string[] = [];
    await runSync({
      adapter: b.adapter,
      api: b.api,
      keys,
      includeVaultConfig: false,
      onNote: (n) => seen.push(`${n.path}|${n.message}`),
    });

    const trashNotes = seen.filter((m) => m.includes("moving the local copy to trash"));
    expect(trashNotes).toHaveLength(1);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("0: a sync that only propagated deletions reported doing nothing", () => {
  it("counts pushed deletions", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    const b = device(server, keys, "token-b");

    a.adapter.put("doomed.md", "x");
    await a.sync();
    await b.sync();

    await a.adapter.trashLocal("doomed.md");
    const pushing = await a.sync();

    // Was 0 before: push-delete incremented no counter, so the status bar and
    // the log both claimed nothing had happened.
    expect(pushing.pushedDeletions).toBe(1);
    expect(pushing.pushed).toBe(0);

    const receiving = await b.sync();
    expect(receiving.deletedLocally).toBe(1);
  });
});

describe("1b: an exclusion only matched the path itself, not its contents", () => {
  // The scan prunes a whole folder when a pattern matches it, so its children
  // are absent from `local`. Unless reconcile is told they are excluded, they
  // look deleted — and every other device trashes them.
  it("a folder pattern without a trailing slash does not delete the contents", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    const b = device(server, keys, "token-b");

    a.adapter.put("Work/Private/secret.md", "confidential");
    a.adapter.put("keep.md", "fine");
    await a.sync();
    await b.sync();
    expect(b.adapter.text("Work/Private/secret.md")).toBe("confidential");

    const before = server.journal.length;
    await runSync({
      adapter: a.adapter,
      api: a.api,
      keys,
      includeVaultConfig: false,
      exclude: ["Work/Private"], // no trailing slash
    });
    await b.sync();

    expect(b.adapter.text("Work/Private/secret.md")).toBe("confidential");
    expect(server.journal.length).toBe(before);
  });

  it("a deeply nested file under an excluded ancestor is also spared", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    const b = device(server, keys, "token-b");

    a.adapter.put("Archive/2024/q1/notes/deep.md", "old");
    await a.sync();
    await b.sync();

    await runSync({
      adapter: a.adapter,
      api: a.api,
      keys,
      includeVaultConfig: false,
      exclude: ["Archive"],
    });
    await b.sync();

    expect(b.adapter.text("Archive/2024/q1/notes/deep.md")).toBe("old");
  });
});

describe("2b: the untracked delete guard was skipped where it mattered most", () => {
  it("keeps an untracked file edited between scan and apply", async () => {
    // These deletions are decided on timestamps alone, with no base entry —
    // the weakest ground on which anything here deletes.
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = new SyncApi({ baseUrl: "http://fake", token: "token-a", transport: server.transportFor("token-a"), sleep: async () => {} });

    adapter.put("stale.md", "from an old backup");
    const tombstoneMtime = adapter.clock + 1000;

    // The user edits it after the plan was made, making it newer than the
    // deletion — which flips the reconciler's own test.
    adapter.clock = tombstoneMtime + 1000;
    adapter.put("stale.md", "actually I still want this");

    const notes: string[] = [];
    await applyPlan({
      adapter,
      api,
      keys,
      deviceId: "macbook",
      base: new Map(),
      plan: {
        actions: [{ kind: "pull-delete", path: "stale.md", remote: { state: "deleted", mtime: tombstoneMtime, seq: 2 } }],
        notes: [],
      },
      onNote: (n) => notes.push(n.message),
    });

    expect(adapter.text("stale.md")).toBe("actually I still want this");
    expect(adapter.trashed.has("stale.md")).toBe(false);
    expect(notes.some((m) => m.includes("newer than the deletion"))).toBe(true);
  });
});

describe("3b: a corrupt state file ignored a perfectly good previous one", () => {
  it("recovers from .prev when the main file will not parse", async () => {
    const adapter = new FakeAdapter();
    const good: BaseState = {
      protocol: 1, vaultId: "v", deviceId: "macbook", lastSeq: 9,
      files: { "a.md": { blobId: "aa", size: 2, mtime: 1 } }, remote: {},
    };
    await saveState(adapter, good);
    await adapter.write(`${STATE_PATH}.prev`, JSON.stringify(good));
    await adapter.write(STATE_PATH, "{ truncated");

    const loaded = await loadState(adapter);
    expect(loaded.state?.lastSeq).toBe(9);
    expect(loaded.problem).toMatch(/recovered/);
  });
});

describe("4: a crash mid-save left no state file at all", () => {
  it("recovers the previous state when the main file is missing", async () => {
    const adapter = new FakeAdapter();
    const state: BaseState = {
      protocol: 1,
      vaultId: "v",
      deviceId: "macbook",
      lastSeq: 7,
      files: { "a.md": { blobId: "aa", size: 2, mtime: 1 } },
      remote: {},
    };
    await saveState(adapter, state);

    // Simulate a crash between the two renames: main gone, previous present.
    await adapter.rename(STATE_PATH, `${STATE_PATH}.prev`);

    const loaded = await loadState(adapter);
    expect(loaded.state?.lastSeq).toBe(7);
    expect(loaded.problem).toMatch(/recovered/);
  });

  it("leaves no stray files behind on a normal save", async () => {
    const adapter = new FakeAdapter();
    const state: BaseState = { protocol: 1, vaultId: "v", deviceId: "d", lastSeq: 1, files: {}, remote: {} };
    await saveState(adapter, state);
    await saveState(adapter, state);

    const stray = [...adapter.files.keys()].filter((p) => p.endsWith(".tmp") || p.endsWith(".prev"));
    expect(stray).toEqual([]);
  });
});

describe("5: hasBlob bypassed the retry layer", () => {
  it("retries a transient failure on the existence check", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    a.adapter.put("note.md", "content");

    // Let meta and journal through, then fail the HEAD.
    let seen = 0;
    const inner = server.transportFor("token-a");
    const api = new SyncApi({
      baseUrl: "http://fake",
      token: "token-a",
      sleep: async () => {},
      transport: async (req) => {
        if (req.method === "HEAD" && seen++ === 0) {
          return { status: 503, text: "{}", arrayBuffer: new ArrayBuffer(0) };
        }
        return inner(req);
      },
    });

    const summary = await runSync({ adapter: a.adapter, api, keys, includeVaultConfig: false });
    expect(summary.pushed).toBe(1);
  });
});

describe("6: a conflict copy was re-hashed on every sync forever", () => {
  it("keeps the mtime the file actually has on disk", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    const b = device(server, keys, "token-b");

    a.adapter.put("note.md", "original");
    await a.sync();
    await b.sync();

    a.adapter.put("note.md", "edit A");
    b.adapter.put("note.md", "edit B");
    await a.sync();
    await b.sync();

    const sidecar = [...b.adapter.files.keys()].find((p) => p.includes("conflict from"))!;
    expect(sidecar).toBeDefined();

    // A later sync must take the fast path for that file, not re-read it.
    const after = await b.sync();
    expect(after.hashed).toBe(0);
  });
});

describe("7: a file edited mid-sync could be trashed", () => {
  it("keeps an edit made between scan and apply", async () => {
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = new SyncApi({ baseUrl: "http://fake", token: "token-a", transport: server.transportFor("token-a"), sleep: async () => {} });

    adapter.put("note.md", "original");
    const originalId = await blobIdFor(keys, utf8.encode("original") as Bytes);
    const base: BaseIndex = new Map([["note.md", { blobId: originalId, size: 8, mtime: adapter.clock }]]);

    // The plan says trash it — and then the user types.
    adapter.put("note.md", "rescued edit");

    const notes: string[] = [];
    await applyPlan({
      adapter,
      api,
      keys,
      deviceId: "macbook",
      base,
      plan: {
        actions: [{ kind: "pull-delete", path: "note.md", remote: { state: "deleted", mtime: 1, seq: 2 } }],
        notes: [],
      },
      onNote: (n) => notes.push(n.message),
    });

    expect(adapter.text("note.md")).toBe("rescued edit");
    expect(adapter.trashed.has("note.md")).toBe(false);
    expect(notes.some((m) => m.includes("edited during sync"))).toBe(true);
  });
});

describe("user-typed exclusion patterns are normalized like scanned paths", () => {
  it("matches regardless of leading slash, backslashes, or Unicode form", async () => {
    const { normalizeExcludePattern, isExcludedPath } = await import("../src/scan.ts");
    const scanned = "Work/Café/notes.md".normalize("NFC");

    for (const typed of ["/Work/", "Work\\\\", "  Work/  ", "Work//", "Work/Café/".normalize("NFD")]) {
      const pattern = normalizeExcludePattern(typed);
      expect(isExcludedPath(scanned, [pattern]), `pattern typed as ${JSON.stringify(typed)}`).toBe(true);
    }
  });

  it("keeps the trailing slash that means 'this folder'", async () => {
    const { normalizeExcludePattern } = await import("../src/scan.ts");
    expect(normalizeExcludePattern("/Archive/")).toBe("Archive/");
    expect(normalizeExcludePattern("*.tmp")).toBe("*.tmp");
  });
});
