/**
 * Behaviours that each broke once and were caught by review rather than by the
 * suite. Every test here fails against the code as it was before its fix, and
 * is named for what it protects so it still reads sensibly without that history.
 */

import { describe, expect, it } from "vitest";
import { SyncApi } from "../src/api.ts";
import { HEAD_BEFORE_PUT_BYTES, applyPlan } from "../src/apply.ts";
import { type VaultKeys, aadForBlob, blobIdFor, seal } from "../src/crypto.ts";
import type { Bytes } from "../src/crypto.ts";
import { ensureDir, loadState, saveState } from "../src/state.ts";
import { DEFAULT_LAYOUT, statePath, vaultLayout } from "../src/layout.ts";

const STATE_PATH = statePath(DEFAULT_LAYOUT);
import { runSync } from "../src/sync.ts";
import type { BaseIndex, BaseState } from "../src/types.ts";
import { FakeAdapter, type FakeServer, fakeApi, initializedFakeVault, publishedPaths } from "./fakes.ts";

const utf8 = new TextEncoder();
const vault = () => initializedFakeVault("pw");

function device(server: FakeServer, keys: VaultKeys, token: string, exclude: string[] = [], includeVaultConfig = false) {
  const adapter = new FakeAdapter();
  const api = fakeApi(server, token);
  return {
    adapter,
    api,
    sync: () => runSync({ adapter, api, keys, layout: DEFAULT_LAYOUT, includeVaultConfig, exclude }),
  };
}

describe("creating a folder creates only its real parents", () => {
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

describe("a push never uploads bytes under a blobId they do not hash to", () => {
  it("skips the push rather than poisoning the content-addressed store", async () => {
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = fakeApi(server, "token-a");

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
      plan: {
        actions: [{ kind: "push-put", path: "note.md", local: scanned, expect: { blobId: scanned.blobId } }],
        notes: [],
      },
    });

    expect(result.pushed).toBe(0);
    expect(server.blobs.size).toBe(0);
    // Crucially, base must not claim the scanned blobId was stored.
    expect(base.has("note.md")).toBe(false);
  });
});

describe("excluding a path forgets it locally without deleting it anywhere", () => {
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
      sync: () => runSync({ adapter: a.adapter, api: a.api, keys, layout: DEFAULT_LAYOUT, includeVaultConfig: false, exclude: ["Work/"] }),
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
    await runSync({ adapter: withConfig.adapter, api: withConfig.api, keys, layout: DEFAULT_LAYOUT, includeVaultConfig: false });
    await b.sync();

    expect(b.adapter.text(".obsidian/app.json")).toBe("{}");
  });
});

describe("each reconciler decision is logged once", () => {
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
      layout: DEFAULT_LAYOUT,
      includeVaultConfig: false,
      onNote: (n) => seen.push(`${n.path}|${n.message}`),
    });

    const trashNotes = seen.filter((m) => m.includes("moving the local copy to trash"));
    expect(trashNotes).toHaveLength(1);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("a sync reports the deletions it sends", () => {
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

describe("excluding a folder excludes everything inside it", () => {
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
      layout: DEFAULT_LAYOUT,
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
      layout: DEFAULT_LAYOUT,
      includeVaultConfig: false,
      exclude: ["Archive"],
    });
    await b.sync();

    expect(b.adapter.text("Archive/2024/q1/notes/deep.md")).toBe("old");
  });
});

describe("an untracked file edited during a sync is not trashed", () => {
  it("keeps an untracked file edited between scan and apply", async () => {
    // These deletions are decided on timestamps alone, with no base entry —
    // the weakest ground on which anything here deletes.
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = fakeApi(server, "token-a");

    adapter.put("stale.md", "from an old backup");
    const scannedId = await blobIdFor(keys, utf8.encode("from an old backup") as Bytes);
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
        actions: [
          {
            kind: "pull-delete",
            path: "stale.md",
            remote: { state: "deleted", mtime: tombstoneMtime, seq: 2 },
            expect: { blobId: scannedId },
          },
        ],
        notes: [],
      },
      onNote: (n) => notes.push(n.message),
    });

    expect(adapter.text("stale.md")).toBe("actually I still want this");
    expect(adapter.trashed.has("stale.md")).toBe(false);
    expect(notes.some((m) => m.includes("changed during sync"))).toBe(true);
  });
});

describe("a corrupt state file falls back to the previous one", () => {
  it("recovers from .prev when the main file will not parse", async () => {
    const adapter = new FakeAdapter();
    const good: BaseState = {
      protocol: 1, vaultId: "v", deviceId: "macbook", lastSeq: 9,
      files: { "a.md": { blobId: "aa", size: 2, mtime: 1 } }, remote: {},
    };
    await saveState(adapter, DEFAULT_LAYOUT, good);
    await adapter.write(`${STATE_PATH}.prev`, JSON.stringify(good));
    await adapter.write(STATE_PATH, "{ truncated");

    const loaded = await loadState(adapter, DEFAULT_LAYOUT);
    expect(loaded.state?.lastSeq).toBe(9);
    expect(loaded.problem).toMatch(/recovered/);
  });
});

describe("a crash while saving state never leaves no state at all", () => {
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
    await saveState(adapter, DEFAULT_LAYOUT, state);

    // Simulate a crash between the two renames: main gone, previous present.
    await adapter.rename(STATE_PATH, `${STATE_PATH}.prev`);

    const loaded = await loadState(adapter, DEFAULT_LAYOUT);
    expect(loaded.state?.lastSeq).toBe(7);
    expect(loaded.problem).toMatch(/recovered/);
  });

  it("leaves no stray files behind on a normal save", async () => {
    const adapter = new FakeAdapter();
    const state: BaseState = { protocol: 1, vaultId: "v", deviceId: "d", lastSeq: 1, files: {}, remote: {} };
    await saveState(adapter, DEFAULT_LAYOUT, state);
    await saveState(adapter, DEFAULT_LAYOUT, state);

    const stray = [...adapter.files.keys()].filter((p) => p.endsWith(".tmp") || p.endsWith(".prev"));
    expect(stray).toEqual([]);
  });
});

describe("the blob existence check is retried like every other request", () => {
  it("retries a transient failure on the existence check", async () => {
    const { server, keys } = await vault();
    const a = device(server, keys, "token-a");
    // Large enough to take the HEAD-before-PUT path; small blobs skip the HEAD
    // entirely, and a small file here would make this test pass without
    // exercising the existence check at all.
    a.adapter.put("big.bin", new Uint8Array(HEAD_BEFORE_PUT_BYTES + 1));

    // Let meta and journal through, then fail the HEAD.
    let seen = 0;
    let heads = 0;
    const inner = server.transportFor("token-a");
    const api = new SyncApi({
      baseUrl: "http://fake",
      token: "token-a",
      sleep: async () => {},
      transport: async (req) => {
        if (req.method === "HEAD") heads++;
        if (req.method === "HEAD" && seen++ === 0) {
          return { status: 503, text: "{}", arrayBuffer: new ArrayBuffer(0) };
        }
        return inner(req);
      },
    });

    const summary = await runSync({ adapter: a.adapter, api, keys, layout: DEFAULT_LAYOUT, includeVaultConfig: false });
    expect(summary.pushed).toBe(1);
    // The failed HEAD was retried, not skipped.
    expect(heads).toBe(2);
  });
});

describe("a conflict copy takes the scan fast path afterwards", () => {
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

describe("a tracked file edited during a sync is not trashed", () => {
  it("keeps an edit made between scan and apply", async () => {
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = fakeApi(server, "token-a");

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
        actions: [
          {
            kind: "pull-delete",
            path: "note.md",
            remote: { state: "deleted", mtime: 1, seq: 2 },
            expect: { blobId: originalId },
          },
        ],
        notes: [],
      },
      onNote: (n) => notes.push(n.message),
    });

    expect(adapter.text("note.md")).toBe("rescued edit");
    expect(adapter.trashed.has("note.md")).toBe(false);
    expect(notes.some((m) => m.includes("changed during sync"))).toBe(true);
  });
});

describe("user-typed exclusion patterns match however they were typed", () => {
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


describe("every action that touches a file re-checks it immediately before acting", () => {
  // One rule for every action kind, so no kind is left without a guard. Before,
  // each kind had its own check written after its race was found — and
  // pull-put and push-delete had none.

  async function setup() {
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = fakeApi(server, "token-a");
    return { server, keys, adapter, api };
  }

  it("a pull does not overwrite a local edit made after the scan", async () => {
    const { server, keys, adapter, api } = await setup();
    const remoteBytes = utf8.encode("the remote version") as Bytes;
    const remoteId = await blobIdFor(keys, remoteBytes);
    await api.putBlob(remoteId, await seal(keys.content, remoteBytes, aadForBlob(remoteId)));

    adapter.put("note.md", "as scanned");
    const scannedId = await blobIdFor(keys, utf8.encode("as scanned") as Bytes);
    adapter.put("note.md", "typed during the sync"); // after the scan

    await applyPlan({
      adapter,
      api,
      keys,
      deviceId: "macbook",
      base: new Map(),
      plan: {
        actions: [
          {
            kind: "pull-put",
            path: "note.md",
            remote: { state: "present", blobId: remoteId, size: remoteBytes.length, mtime: 1, seq: 1 },
            expect: { blobId: scannedId },
          },
        ],
        notes: [],
      },
    });

    expect(adapter.text("note.md")).toBe("typed during the sync");
    void server;
  });

  it("a deletion is not published for a file restored after the scan", async () => {
    const { server, keys, adapter, api } = await setup();
    adapter.put("note.md", "restored from trash during the sync");

    const base: BaseIndex = new Map([["note.md", { blobId: "a".repeat(32), size: 1, mtime: 1 }]]);
    await applyPlan({
      adapter,
      api,
      keys,
      deviceId: "macbook",
      base,
      plan: { actions: [{ kind: "push-delete", path: "note.md", mtime: 1, expect: "absent" }], notes: [] },
    });

    expect(server.journal).toHaveLength(0);
    expect(base.has("note.md")).toBe(true);
  });
});

describe("a conflict applies all of its effects or none of them", () => {
  // Split into two actions, a refused conflict copy still let the push through:
  // the local version replaced the remote one at the original path, the other
  // device pulled it as an ordinary edit, and its own version was overwritten.

  async function conflictPlan() {
    const { server, keys } = await vault();
    const adapter = new FakeAdapter();
    const api = fakeApi(server, "token-a");

    const remoteBytes = utf8.encode("the other device's version") as Bytes;
    const remoteId = await blobIdFor(keys, remoteBytes);
    await api.putBlob(remoteId, await seal(keys.content, remoteBytes, aadForBlob(remoteId)));

    adapter.put("note.md", "this device's version");
    const localId = await blobIdFor(keys, utf8.encode("this device's version") as Bytes);

    const action = {
      kind: "conflict" as const,
      path: "note.md",
      copyPath: "note (conflict from iphone).md",
      local: { path: "note.md", blobId: localId, size: 21, mtime: adapter.clock },
      remote: { state: "present" as const, blobId: remoteId, size: remoteBytes.length, mtime: 1, seq: 1, deviceId: "iphone" },
      expect: { blobId: localId },
    };
    return { server, keys, adapter, api, action };
  }

  it("pushes nothing when something appears at the copy path mid-sync", async () => {
    const { server, keys, adapter, api, action } = await conflictPlan();
    adapter.put(action.copyPath, "an unrelated file that landed on that name"); // after the scan

    const base: BaseIndex = new Map();
    const result = await applyPlan({ adapter, api, keys, deviceId: "macbook", base, plan: { actions: [action], notes: [] } });

    // Nothing journalled: the remote version is still the live one at note.md.
    expect(server.journal).toHaveLength(0);
    expect(result.pushed).toBe(0);
    expect(base.size).toBe(0);
    // And nothing local was touched.
    expect(adapter.text("note.md")).toBe("this device's version");
    expect(adapter.text(action.copyPath)).toBe("an unrelated file that landed on that name");
  });

  it("pushes nothing when the local file changed after the scan", async () => {
    const { server, keys, adapter, api, action } = await conflictPlan();
    adapter.put("note.md", "typed during the sync");

    await applyPlan({ adapter, api, keys, deviceId: "macbook", base: new Map(), plan: { actions: [action], notes: [] } });

    expect(server.journal).toHaveLength(0);
    expect(adapter.files.has(action.copyPath)).toBe(false);
  });

  it("does both halves when nothing changed", async () => {
    const { server, keys, adapter, api, action } = await conflictPlan();
    await applyPlan({ adapter, api, keys, deviceId: "macbook", base: new Map(), plan: { actions: [action], notes: [] } });

    expect(server.journal).toHaveLength(2);
    expect(adapter.text(action.copyPath)).toBe("the other device's version");
    expect(adapter.text("note.md")).toBe("this device's version");
  });
});

describe("no device's private config files are ever published", () => {
  // Assertions are on what the server received, decrypted — not on another
  // device's view, which applies its own exclusions and so could hide a leak.
  const mobile = vaultLayout(".obsidian-mobile");
  const PRIVATE = /(^|\/)workspace(-mobile)?\.json$|plugins\/obsydian-sync\//;

  it("a phone on a custom config folder publishes none of its own", async () => {
    const { server, keys } = await vault();
    const phone = new FakeAdapter();
    phone.put("note.md", "hello");
    phone.put(".obsidian-mobile/app.json", "{}");
    phone.put(".obsidian-mobile/workspace-mobile.json", "{}");
    phone.put(".obsidian-mobile/plugins/obsydian-sync/data.json", "{}");

    await runSync({ adapter: phone, api: fakeApi(server, "token-a"), keys, layout: mobile, includeVaultConfig: true });
    await runSync({ adapter: phone, api: fakeApi(server, "token-a"), keys, layout: mobile, includeVaultConfig: true });

    const published = await publishedPaths(server, keys);
    expect(published).toEqual([".obsidian-mobile/app.json", "note.md"]);
    // State lands in the plugin's real folder, where the next load finds it.
    expect(phone.files.has(statePath(mobile))).toBe(true);
  });

  it("never publishes a leftover copy of this plugin in another config folder", async () => {
    // e.g. state left under .obsidian by an earlier setup, on a device that has
    // since moved to .obsidian-mobile. Before, only the device's *own* plugin
    // folder was excluded, so this was ordinary content and would be pushed.
    const { server, keys } = await vault();
    const phone = new FakeAdapter();
    phone.put(".obsidian/plugins/obsydian-sync/state.json", "{\"stale\":true}");
    phone.put(".obsidian/plugins/obsydian-sync/data.json", "{}");
    phone.put(".obsidian/workspace.json", "{}");
    phone.put("note.md", "hello");

    await runSync({ adapter: phone, api: fakeApi(server, "token-a"), keys, layout: mobile, includeVaultConfig: true });

    const published = await publishedPaths(server, keys);
    expect(published.filter((p) => PRIVATE.test(p))).toEqual([]);
    expect(published).toContain("note.md");
  });

  it("with vault settings off, a phone keeps the desktop's config folder out too", async () => {
    // Desktop on .obsidian with vault settings on; phone on .obsidian-mobile
    // with them off. The phone must not download the desktop's plugin code,
    // hotkeys and other plugins' data as if they were notes.
    const { server, keys } = await vault();
    const desktop = new FakeAdapter();
    desktop.put(".obsidian/app.json", "{}");
    desktop.put(".obsidian/plugins/other-plugin/data.json", "{}");
    desktop.put("note.md", "hello");
    await runSync({ adapter: desktop, api: fakeApi(server, "token-a"), keys, layout: DEFAULT_LAYOUT, includeVaultConfig: true });

    const phone = new FakeAdapter();
    await runSync({ adapter: phone, api: fakeApi(server, "token-b"), keys, layout: mobile, includeVaultConfig: false });

    expect(phone.text("note.md")).toBe("hello");
    expect([...phone.files.keys()].filter((p) => p.startsWith(".obsidian/"))).toEqual([]);
  });
});
