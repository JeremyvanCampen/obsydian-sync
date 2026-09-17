/**
 * End-to-end: the real client against a faithful in-memory server, with two
 * simulated devices sharing one vault.
 *
 * This is the closest thing to the real system that can run without Obsidian,
 * and it is where the project's central claim is actually proved.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SyncApi } from "../src/api.ts";
import { type VaultKeys, deriveKeys, deriveMasterKey, makeKdfCheck } from "../src/crypto.ts";
import { runSync } from "../src/sync.ts";
import type { SyncSummary } from "../src/sync.ts";
import { FakeAdapter, FakeServer } from "./fakes.ts";

const KDF = { alg: "PBKDF2-HMAC-SHA256" as const, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", iterations: 1000 };

let server: FakeServer;
let keys: VaultKeys;

async function setup(): Promise<void> {
  server = new FakeServer({ "token-a": "macbook", "token-b": "iphone" });
  keys = await deriveKeys(await deriveMasterKey("correct horse battery staple", KDF));
  server.kdfCheck = await makeKdfCheck(keys, server.vaultId);
}

class Device {
  readonly adapter = new FakeAdapter();
  private readonly api: SyncApi;

  constructor(token: string, clockOffset = 0) {
    this.api = new SyncApi({
      baseUrl: "http://fake",
      token,
      transport: server.transportFor(token),
      sleep: async () => {},
    });
    this.adapter.clock += clockOffset;
  }

  sync(opts: { confirmMassDeletion?: boolean } = {}): Promise<SyncSummary> {
    return runSync({
      adapter: this.adapter,
      api: this.api,
      keys,
      includeVaultConfig: false,
      confirmMassDeletion: opts.confirmMassDeletion,
    });
  }
}

beforeEach(setup);

describe("the scenario this project exists for", () => {
  it("a deletion propagates once and never resurrects", async () => {
    const a = new Device("token-a");
    const b = new Device("token-b");

    // 1. Device A creates a note and syncs.
    a.adapter.put("Test.md", "hello from A");
    expect((await a.sync()).pushed).toBe(1);

    // 2. Device B syncs and receives it.
    expect((await b.sync()).pulled).toBe(1);
    expect(b.adapter.text("Test.md")).toBe("hello from A");

    // 3. Device B deletes it and syncs.
    await b.adapter.trashLocal("Test.md");
    await b.sync();

    // 4. Device A syncs: the note is gone.
    const fourth = await a.sync();
    expect(fourth.deletedLocally).toBe(1);
    expect(a.adapter.files.has("Test.md")).toBe(false);

    // 5. Device A syncs AGAIN. This is the step remotely-save fails: with no
    //    memory of the last sync, the missing file looks like a new remote
    //    file and gets pushed back.
    const fifth = await a.sync();
    expect(fifth.pushed).toBe(0);
    expect(fifth.pulled).toBe(0);
    expect(a.adapter.files.has("Test.md")).toBe(false);

    // 6. And device B still does not have it.
    await b.sync();
    expect(b.adapter.files.has("Test.md")).toBe(false);

    // Exactly one delete op was ever written.
    expect(server.journal).toHaveLength(2); // one put, one delete
  });

  it("the deleted file is recoverable from trash, never hard-removed", async () => {
    const a = new Device("token-a");
    const b = new Device("token-b");

    a.adapter.put("Test.md", "precious");
    await a.sync();
    await b.sync();

    await b.adapter.trashLocal("Test.md");
    await b.sync();
    await a.sync();

    expect(a.adapter.files.has("Test.md")).toBe(false);
    expect(a.adapter.trashed.has("Test.md")).toBe(true);
  });
});

describe("ordinary two-device operation", () => {
  it("propagates creates, edits and nested folders", async () => {
    const a = new Device("token-a");
    const b = new Device("token-b");

    a.adapter.put("Work/Meetings/Standup.md", "- item one");
    a.adapter.put("Home/Groceries.md", "milk");
    await a.sync();
    await b.sync();

    expect(b.adapter.text("Work/Meetings/Standup.md")).toBe("- item one");
    expect(b.adapter.text("Home/Groceries.md")).toBe("milk");

    b.adapter.put("Work/Meetings/Standup.md", "- item one\n- item two");
    await b.sync();
    await a.sync();

    expect(a.adapter.text("Work/Meetings/Standup.md")).toBe("- item one\n- item two");
  });

  it("a second sync with nothing changed does nothing at all", async () => {
    const a = new Device("token-a");
    a.adapter.put("a.md", "x");
    await a.sync();

    const before = server.journal.length;
    const again = await a.sync();

    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(server.journal).toHaveLength(before);
  });

  it("syncs an empty note", async () => {
    // An empty file seals to exactly IV + tag, the minimum legal sealed value.
    // Ctrl+N in Obsidian makes one, so this is a common case, not an edge one.
    const a = new Device("token-a");
    const b = new Device("token-b");

    a.adapter.put("Empty.md", "");
    expect((await a.sync()).pushed).toBe(1);
    await b.sync();

    expect(b.adapter.files.has("Empty.md")).toBe(true);
    expect(b.adapter.text("Empty.md")).toBe("");
  });

  it("round-trips binary content byte-for-byte", async () => {
    const a = new Device("token-a");
    const b = new Device("token-b");

    // A PNG header plus bytes that are not valid UTF-8.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
    a.adapter.put("Media/shot.png", png);
    await a.sync();
    await b.sync();

    expect([...b.adapter.files.get("Media/shot.png")!.data]).toEqual([...png]);
  });

  it("uploads nothing for a file copied to a second path", async () => {
    const a = new Device("token-a");
    a.adapter.put("one.md", "identical content");
    await a.sync();
    const blobsAfterFirst = server.blobs.size;

    a.adapter.put("two.md", "identical content");
    await a.sync();

    // Content addressing means the second path reuses the first blob.
    expect(server.blobs.size).toBe(blobsAfterFirst);
    expect(server.journal.filter((e) => e.deviceId === "macbook")).toHaveLength(2);
  });
});

describe("conflicts", () => {
  it("keeps both versions and converges on the next sync", async () => {
    const a = new Device("token-a");
    const b = new Device("token-b");

    a.adapter.put("note.md", "original");
    await a.sync();
    await b.sync();

    // Both edit while unaware of each other.
    a.adapter.put("note.md", "edited on A");
    b.adapter.put("note.md", "edited on B");

    await a.sync(); // A pushes first and wins the plain path
    const bSummary = await b.sync();

    // B keeps its own text where it was, and gains A's beside it.
    expect(b.adapter.text("note.md")).toBe("edited on B");
    const sidecar = [...b.adapter.files.keys()].find((p) => p.includes("conflict from"));
    expect(sidecar).toBeDefined();
    expect(b.adapter.text(sidecar!)).toBe("edited on A");
    expect(bSummary.notes.some((n) => n.message.includes("both sides changed"))).toBe(true);

    // The next syncs settle: no new conflict copies, ever.
    await b.sync();
    await a.sync();
    await b.sync();

    const copies = [...b.adapter.files.keys()].filter((p) => p.includes("conflict from"));
    expect(copies).toHaveLength(1);
    expect(a.adapter.text(copies[0]!)).toBe("edited on A");
    expect(a.adapter.text("note.md")).toBe("edited on B");
  });
});

describe("the server learns nothing", () => {
  it("holds no plaintext path or content", async () => {
    const a = new Device("token-a");
    a.adapter.put("Work/Sensitive note.md", "something private");
    await a.sync();

    const everything = server.dump();
    expect(everything).not.toContain("Sensitive");
    expect(everything).not.toContain("onderhandeling");
    expect(everything).not.toContain("Jeremy");
    expect(everything).not.toContain("vraag om");
    expect(everything).not.toContain(".md");
  });

  it("refuses to sync against a vault whose passphrase does not match", async () => {
    const a = new Device("token-a");
    keys = await deriveKeys(await deriveMasterKey("the wrong passphrase", KDF));

    await expect(a.sync()).rejects.toThrow(/passphrase does not match/);
  });
});

describe("resilience", () => {
  it("retries a transient server failure rather than failing the sync", async () => {
    const a = new Device("token-a");
    a.adapter.put("a.md", "x");

    server.failNext = 2;
    const summary = await a.sync();

    expect(summary.pushed).toBe(1);
  });

  it("does not delete anything when the journal is empty but base says otherwise", async () => {
    const a = new Device("token-a");
    a.adapter.put("a.md", "x");
    a.adapter.put("b.md", "y");
    await a.sync();

    // Simulate a wiped server: journal and blobs gone, same vault id.
    server.journal.length = 0;
    server.blobs.clear();

    const summary = await a.sync();

    expect(a.adapter.files.has("a.md")).toBe(true);
    expect(a.adapter.files.has("b.md")).toBe(true);
    expect(summary.deletedLocally).toBe(0);
  });

  it("stops and asks before trashing a vault's worth of untracked files", async () => {
    const a = new Device("token-a");
    const b = new Device("token-b");

    for (let i = 0; i < 20; i++) a.adapter.put(`note${i}.md`, `content ${i}`);
    await a.sync();
    await b.sync();

    // B deletes everything and syncs: 20 tombstones.
    for (let i = 0; i < 20; i++) await b.adapter.trashLocal(`note${i}.md`);
    await b.sync();

    // A new device arrives holding a stale copy and no sync history.
    const c = new Device("token-a");
    for (let i = 0; i < 20; i++) c.adapter.put(`note${i}.md`, `content ${i}`);

    const blocked = await c.sync();
    expect(blocked.blocked).toBeDefined();
    expect(blocked.deletedLocally).toBe(0);
    const notes = () => [...c.adapter.files.keys()].filter((p) => p.startsWith("note"));
    expect(notes()).toHaveLength(20);

    // Only once the user confirms does it proceed.
    const confirmed = await c.sync({ confirmMassDeletion: true });
    expect(confirmed.deletedLocally).toBe(20);
    expect(notes()).toHaveLength(0);
    expect(c.adapter.trashed.size).toBe(20);
  });
});
