/**
 * In-memory doubles for the two things a sync touches: the vault filesystem and
 * the server.
 *
 * The server double mirrors the Rust implementation's *semantics* — entryId
 * idempotency, tombstone-free opaque storage, content-addressed blobs — so an
 * integration test here exercises the real client against a faithful peer. It
 * is not a mock: nothing is stubbed per-test, and the client cannot tell it
 * from the real one.
 */

import type { VaultAdapter } from "../src/adapter.ts";
import { type HttpRequest, type HttpResponse, SyncApi, type Transport } from "../src/api.ts";
import { type VaultKeys, deriveKeys, deriveMasterKey, makeKdfCheck } from "../src/crypto.ts";
import { replay } from "../src/journal.ts";
import type { KdfParams } from "../src/types.ts";

/**
 * The KDF parameters the fake server advertises. Exported so tests derive keys
 * from what the server says rather than from their own copy of it — otherwise
 * changing the fake's salt would leave every test passing against keys this
 * "server" could never have produced. Low iterations keep the suite fast.
 */
export const FAKE_KDF: KdfParams = {
  alg: "PBKDF2-HMAC-SHA256",
  salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  iterations: 1000,
};

// --- vault ----------------------------------------------------------------

interface FakeFile {
  data: Uint8Array;
  mtime: number;
}

export class FakeAdapter implements VaultAdapter {
  readonly files = new Map<string, FakeFile>();
  readonly folders = new Set<string>();
  /** Everything ever trashed, so tests can assert nothing was hard-deleted. */
  readonly trashed = new Map<string, FakeFile>();
  clock = 1_000_000;

  constructor(private readonly encoder = new TextEncoder()) {}

  tick(by = 1000): number {
    this.clock += by;
    return this.clock;
  }

  /** Test helper: write a file as a user would, advancing the clock. */
  put(path: string, content: string | Uint8Array): void {
    const data = typeof content === "string" ? this.encoder.encode(content) : content;
    this.files.set(path, { data, mtime: this.tick() });
    this.addParents(path);
  }

  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.data) : undefined;
  }

  private addParents(path: string): void {
    let i = path.indexOf("/");
    while (i !== -1) {
      this.folders.add(path.slice(0, i));
      i = path.indexOf("/", i + 1);
    }
  }

  async read(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBinary(path).then((b) => new Uint8Array(b)));
  }

  async write(path: string, data: string): Promise<void> {
    await this.writeBinary(path, this.encoder.encode(data).buffer as ArrayBuffer);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.data.slice().buffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, { data: new Uint8Array(data), mtime: this.tick() });
    this.addParents(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path === "" ? "" : `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();

    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest === "" || rest.includes("/")) {
        const head = rest.slice(0, rest.indexOf("/"));
        if (head) folders.add(`${prefix}${head}`);
        continue;
      }
      files.push(p);
    }
    for (const f of this.folders) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (rest && !rest.includes("/")) folders.add(f);
    }
    return { files, folders: [...folders] };
  }

  async stat(path: string): Promise<{ type: "file" | "folder"; mtime: number; size: number } | null> {
    const f = this.files.get(path);
    if (f) return { type: "file", mtime: f.mtime, size: f.data.length };
    if (this.folders.has(path)) return { type: "folder", mtime: 0, size: 0 };
    return null;
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async trashLocal(path: string): Promise<void> {
    const f = this.files.get(path);
    if (f) this.trashed.set(path, f);
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (!f) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, f);
    this.files.delete(from);
    this.addParents(to);
  }
}

// --- server ---------------------------------------------------------------

interface StoredEntry {
  seq: number;
  deviceId: string;
  entryId: string;
  payload: string;
}

export class FakeServer {
  readonly journal: StoredEntry[] = [];
  readonly blobs = new Map<string, Uint8Array>();
  private readonly seen = new Map<string, number>();
  kdfCheck: string | null = null;
  readonly vaultId = "1600203ea33bc4d1be6641c1546be18b";
  /** Requests served, so tests can assert on retry and paging behaviour. */
  readonly log: string[] = [];
  /** Set to fail the next N requests, to exercise retry. */
  failNext = 0;

  constructor(private readonly tokens: Record<string, string> = { "device-token": "macbook" }) {}

  transportFor(token: string): Transport {
    return async (req) => this.handle(req, token);
  }

  /** Everything the server holds, as one string — for leak assertions. */
  dump(): string {
    const entries = this.journal.map((e) => JSON.stringify(e)).join("\n");
    const blobs = [...this.blobs.entries()]
      .map(([id, bytes]) => `${id}:${Buffer.from(bytes).toString("base64")}`)
      .join("\n");
    return `${entries}\n${blobs}`;
  }

  private handle(req: HttpRequest, token: string): HttpResponse {
    this.log.push(`${req.method} ${req.url}`);

    if (this.failNext > 0) {
      this.failNext--;
      return json(503, { error: { code: "internal", message: "simulated failure" } });
    }

    const deviceId = this.tokens[token];
    if (!deviceId) return json(401, { error: { code: "unauthorized", message: "bad token" } });

    const url = new URL(req.url, "http://fake");
    const path = url.pathname;

    if (path === "/v1/meta" && req.method === "GET") {
      return json(200, {
        protocol: 1,
        vaultId: this.vaultId,
        kdf: FAKE_KDF,
        kdfCheck: this.kdfCheck,
        head: this.head(),
        yourDeviceId: deviceId,
      });
    }

    if (path === "/v1/meta/init" && req.method === "POST") {
      if (this.kdfCheck !== null) {
        return json(409, { error: { code: "conflict", message: "already initialized" } });
      }
      this.kdfCheck = JSON.parse(String(req.body)).kdfCheck;
      return json(204, {});
    }

    if (path === "/v1/journal" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 500);
      const all = this.journal.filter((e) => e.seq > since);
      const page = all.slice(0, limit);
      return json(200, { entries: page, head: this.head(), more: all.length > page.length });
    }

    if (path === "/v1/journal" && req.method === "POST") {
      const body = JSON.parse(String(req.body)) as {
        entries: Array<{ entryId: string; payload: string }>;
      };
      const assigned: Array<{ entryId: string; seq: number }> = [];
      const inBatch = new Map<string, number>();

      for (const e of body.entries) {
        const existing = this.seen.get(e.entryId) ?? inBatch.get(e.entryId);
        if (existing !== undefined) {
          assigned.push({ entryId: e.entryId, seq: existing });
          continue;
        }
        const seq = this.head() + 1 + inBatch.size;
        inBatch.set(e.entryId, seq);
        this.journal.push({ seq, deviceId, entryId: e.entryId, payload: e.payload });
        assigned.push({ entryId: e.entryId, seq });
      }
      for (const [id, seq] of inBatch) this.seen.set(id, seq);
      return json(200, { assigned, head: this.head() });
    }

    const blobMatch = /^\/v1\/blob\/([0-9a-f]{32})$/.exec(path);
    if (blobMatch) {
      const id = blobMatch[1]!;
      if (req.method === "HEAD") {
        return this.blobs.has(id) ? raw(204, new Uint8Array()) : json(404, { error: { code: "not_found", message: "no" } });
      }
      if (req.method === "GET") {
        const b = this.blobs.get(id);
        return b ? raw(200, b) : json(404, { error: { code: "not_found", message: "no" } });
      }
      if (req.method === "PUT") {
        const bytes = new Uint8Array(req.body as ArrayBuffer);
        if (this.blobs.has(id)) return raw(200, new Uint8Array());
        this.blobs.set(id, bytes);
        return raw(201, new Uint8Array());
      }
    }

    return json(404, { error: { code: "not_found", message: `no route for ${path}` } });
  }

  private head(): number {
    return this.journal.length === 0 ? 0 : this.journal[this.journal.length - 1]!.seq;
  }
}

function json(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return { status, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

function raw(status: number, bytes: Uint8Array): HttpResponse {
  return { status, text: "", arrayBuffer: bytes.slice().buffer };
}

/** A fake server already initialised with a passphrase, and the keys for it. */
export async function initializedFakeVault(
  passphrase = "correct horse battery staple",
  tokens: Record<string, string> = { "token-a": "macbook", "token-b": "iphone" },
): Promise<{ server: FakeServer; keys: VaultKeys }> {
  const server = new FakeServer(tokens);
  const keys = await deriveKeys(await deriveMasterKey(passphrase, FAKE_KDF));
  server.kdfCheck = await makeKdfCheck(keys, server.vaultId);
  return { server, keys };
}

/** A client for the fake server, with retries that do not actually wait. */
export function fakeApi(server: FakeServer, token: string): SyncApi {
  return new SyncApi({ baseUrl: "http://fake", token, transport: server.transportFor(token), sleep: async () => {} });
}

/**
 * Every path the server has ever been told about, decrypted. The only sound way
 * to ask "did a device publish this?": another device's view of the vault
 * applies its own exclusions, so it can hide exactly the leak being tested for.
 */
export async function publishedPaths(server: FakeServer, keys: VaultKeys): Promise<string[]> {
  const { index } = await replay(server.journal, keys);
  return [...index.keys()].sort();
}
