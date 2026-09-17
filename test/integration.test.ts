/**
 * The real TypeScript client against the real Rust server, over real HTTP.
 *
 * Everything else in this suite talks to an in-memory double. That proves the
 * client's logic but not that the two *implementations* agree: field casing,
 * status codes, base64 framing, binary bodies, paging, idempotency. Those seams
 * have two authors and one spec, and until this test existed nothing checked
 * that they met.
 *
 * Requires `cargo build --package obsydian-sync-server` first.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncApi, type Transport } from "../src/api.ts";
import {
  type Bytes,
  type VaultKeys,
  aadForBlob,
  blobIdFor,
  deriveKeys,
  deriveMasterKey,
  makeKdfCheck,
  seal,
  unseal,
  verifyKdfCheck,
} from "../src/crypto.ts";
import { prepareEntry, replay } from "../src/journal.ts";
import { type RunningServer, startServer } from "./server-harness.ts";

const BIN = fileURLToPath(new URL("../target/debug/obsydian-sync-server", import.meta.url));
const TOKEN = "integration-test-token";

let server: RunningServer;
let dataDir: string;
let api: SyncApi;
let keys: VaultKeys;

/**
 * Mirrors `requestUrl`'s contract: no throwing on non-2xx, and both a text and
 * an arrayBuffer view of the body. If this diverges from Obsidian's behaviour
 * the test stops being evidence, so it is kept deliberately thin.
 */
const nodeTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as BodyInit),
  });
  const buf = await res.arrayBuffer();
  return {
    status: res.status,
    text: new TextDecoder().decode(buf),
    arrayBuffer: buf,
  };
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "obsydian-integration-"));
  server = await startServer({
    binary: BIN,
    dataDir: join(dataDir, "data"),
    configDir: dataDir,
    devices: { macbook: TOKEN },
  });

  api = new SyncApi({
    baseUrl: server.baseUrl,
    token: TOKEN,
    transport: nodeTransport,
    sleep: async () => {},
  });

  const meta = await api.meta();
  keys = await deriveKeys(await deriveMasterKey("integration passphrase", meta.kdf));
  await api.initMeta(await makeKdfCheck(keys, meta.vaultId));
}, 30_000);

afterAll(async () => {
  await server?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("meta", () => {
  it("parses every field the client relies on", async () => {
    const meta = await api.meta();

    // Field casing is the classic two-implementations bug: serde's
    // rename_all="camelCase" has to line up with the TypeScript interface.
    expect(meta.protocol).toBe(1);
    expect(meta.vaultId).toMatch(/^[0-9a-f]{32}$/);
    expect(meta.kdf.alg).toBe("PBKDF2-HMAC-SHA256");
    expect(meta.kdf.iterations).toBe(600_000);
    expect(meta.yourDeviceId).toBe("macbook");
    expect(typeof meta.head).toBe("number");
  });

  it("round-trips the passphrase check the client wrote", async () => {
    const meta = await api.meta();
    expect(meta.kdfCheck).not.toBeNull();
    expect(await verifyKdfCheck(keys, meta.vaultId, meta.kdfCheck!)).toBe(true);
  });

  it("refuses a second initialization", async () => {
    await expect(api.initMeta("c2Vjb25k")).rejects.toThrow();
  });
});

describe("blobs", () => {
  it("stores and returns sealed bytes unchanged", async () => {
    const content = new TextEncoder().encode("# Standup\n\n- one\n") as Bytes;
    const id = await blobIdFor(keys, content);
    const sealed = await seal(keys.content, content, aadForBlob(id));

    expect(await api.hasBlob(id)).toBe(false);
    await api.putBlob(id, sealed);
    expect(await api.hasBlob(id)).toBe(true);

    const back = await api.getBlob(id);
    expect([...back]).toEqual([...sealed]);
    expect(new TextDecoder().decode(await unseal(keys.content, back, aadForBlob(id)))).toBe(
      "# Standup\n\n- one\n",
    );
  });

  it("round-trips bytes that are not valid UTF-8", async () => {
    // The PNG path. A text-mode body anywhere in the chain mangles these.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]) as Bytes;
    const id = await blobIdFor(keys, png);
    await api.putBlob(id, await seal(keys.content, png, aadForBlob(id)));

    const back = await unseal(keys.content, await api.getBlob(id), aadForBlob(id));
    expect([...back]).toEqual([...png]);
  });

  it("round-trips an empty file", async () => {
    // 28 bytes sealed: the minimum legal value, and the boundary that was
    // wrong in both implementations until the M2 review.
    const empty = new Uint8Array(0) as Bytes;
    const id = await blobIdFor(keys, empty);
    const sealed = await seal(keys.content, empty, aadForBlob(id));
    expect(sealed.length).toBe(28);

    await api.putBlob(id, sealed);
    const back = await unseal(keys.content, await api.getBlob(id), aadForBlob(id));
    expect(back.length).toBe(0);
  });

  it("survives a blob larger than one TCP segment", async () => {
    const big = new Uint8Array(512 * 1024) as Bytes;
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;

    const id = await blobIdFor(keys, big);
    await api.putBlob(id, await seal(keys.content, big, aadForBlob(id)));

    const back = await unseal(keys.content, await api.getBlob(id), aadForBlob(id));
    expect(back.length).toBe(big.length);
    expect([...back.subarray(0, 64)]).toEqual([...big.subarray(0, 64)]);
    expect([...back.subarray(-64)]).toEqual([...big.subarray(-64)]);
  });

  it("treats a missing blob as absent rather than an error", async () => {
    expect(await api.hasBlob("f".repeat(32))).toBe(false);
  });

  it("rejects a malformed id", async () => {
    await expect(api.getBlob("NOT-HEX")).rejects.toThrow();
  });
});

describe("journal", () => {
  it("seals, appends, pulls back and decrypts a payload", async () => {
    const meta = await api.meta();
    const entry = await prepareEntry(
      { op: "put", path: "Work/Meetings/Standup.md", blobId: "a".repeat(32), size: 17, mtime: 1757400000000 },
      keys,
      meta.yourDeviceId,
    );

    const before = (await api.meta()).head;
    const appended = await api.appendJournal([entry]);
    expect(appended.assigned[0]?.seq).toBe(before + 1);

    const page = await api.journalSince(before);
    const { index } = await replay(page.entries, keys, new Map(), before);

    const found = index.get("Work/Meetings/Standup.md");
    expect(found?.state).toBe("present");
    // The AAD is built from the deviceId the *server* assigned, so this also
    // proves the client is binding against the right identity.
    expect(found && found.state === "present" ? found.blobId : null).toBe("a".repeat(32));
  });

  it("returns the original seq for a resubmitted entryId", async () => {
    const meta = await api.meta();
    const entry = await prepareEntry(
      { op: "delete", path: "Gone.md", mtime: 1757400001000 },
      keys,
      meta.yourDeviceId,
    );

    const first = await api.appendJournal([entry]);
    const second = await api.appendJournal([entry]);

    expect(second.assigned[0]?.seq).toBe(first.assigned[0]?.seq);
    expect(second.head).toBe(first.head);
  });

  it("appends a duplicated entryId within one batch only once", async () => {
    // Distinct from the retry case above: there the entry arrives in a second
    // request, here twice in the same body. They take different paths through
    // the server, and only one of them was covered.
    const meta = await api.meta();
    const entry = await prepareEntry(
      { op: "put", path: "Duplicated.md", blobId: "c".repeat(32), size: 3, mtime: 4000 },
      keys,
      meta.yourDeviceId,
    );
    const other = await prepareEntry(
      { op: "put", path: "Alongside.md", blobId: "d".repeat(32), size: 3, mtime: 4001 },
      keys,
      meta.yourDeviceId,
    );

    const before = meta.head;
    const result = await api.appendJournal([entry, entry, other]);

    expect(result.assigned).toHaveLength(3);
    expect(result.assigned[0]?.seq).toBe(before + 1);
    expect(result.assigned[1]?.seq).toBe(before + 1);
    expect(result.assigned[2]?.seq).toBe(before + 2);
    expect(result.head).toBe(before + 2);

    const page = await api.journalSince(before);
    const ids = page.entries.map((e) => e.entryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pages through a journal larger than one response", async () => {
    const meta = await api.meta();
    const batch = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        prepareEntry(
          { op: "put", path: `bulk/${i}.md`, blobId: "b".repeat(32), size: 1, mtime: 1000 + i },
          keys,
          meta.yourDeviceId,
        ),
      ),
    );
    await api.appendJournal(batch);

    // journalAll must follow `more` correctly; a paging bug here silently
    // truncates the remote index and looks like missing files.
    //
    // The page limit is forced down to 5: at the default of 500 this journal
    // fits in one response, the loop body runs once, and the cursor-advance and
    // stall guard inside journalAll are never executed at all.
    const small = new SyncApi({
      baseUrl: server.baseUrl,
      token: TOKEN,
      transport: nodeTransport,
      sleep: async () => {},
      pageLimit: 5,
    });
    const page = await small.journalSince(0);
    expect(page.more).toBe(true);
    expect(page.entries).toHaveLength(5);

    const all = await small.journalAll(0);
    expect(all.length).toBe((await small.meta()).head);
    expect(new Set(all.map((e) => e.seq)).size).toBe(all.length);

    const { index } = await replay(all, keys);
    expect(index.get("bulk/24.md")?.state).toBe("present");
  });

  it("replays a delete into a tombstone", async () => {
    const meta = await api.meta();
    const entry = await prepareEntry(
      { op: "delete", path: "Tombstoned.md", mtime: 1757400009000 },
      keys,
      meta.yourDeviceId,
    );
    await api.appendJournal([entry]);

    const { index } = await replay(await api.journalAll(0), keys);
    expect(index.get("Tombstoned.md")?.state).toBe("deleted");
  });
});

describe("errors the client has to interpret", () => {
  it("surfaces the server's error code on a bad token", async () => {
    const bad = new SyncApi({
      baseUrl: server.baseUrl,
      token: "not-a-real-token",
      transport: nodeTransport,
      sleep: async () => {},
    });

    await expect(bad.meta()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("does not retry a 4xx", async () => {
    let attempts = 0;
    const counting = new SyncApi({
      baseUrl: server.baseUrl,
      token: "not-a-real-token",
      sleep: async () => {},
      transport: async (req) => {
        attempts++;
        return nodeTransport(req);
      },
    });

    await expect(counting.meta()).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("garbage collection", () => {
  it("refuses a live set computed against a stale head", async () => {
    await expect(api.gc([], 0)).rejects.toMatchObject({ status: 409 });
  });

  it("spares blobs younger than the grace period", async () => {
    // Seeded here rather than relying on an earlier describe having uploaded.
    const content = new TextEncoder().encode("gc fixture") as Bytes;
    const id = await blobIdFor(keys, content);
    await api.putBlob(id, await seal(keys.content, content, aadForBlob(id)));

    const head = (await api.meta()).head;
    // Every blob here was written seconds ago, so the default 24h grace must
    // hold all of them regardless of the live set.
    const result = (await api.gc([], head, true)) as { removed: number; spared: number };
    expect(result.removed).toBe(0);
    expect(result.spared).toBeGreaterThan(0);
  });
});
