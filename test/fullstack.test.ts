/**
 * The whole system, end to end: a real vault on disk, the real client, the real
 * server binary, and the real restore CLI — then a byte-for-byte comparison.
 *
 * This is the closest thing to the drill SETUP.md asks you to run by hand, and
 * it is the only test where a mistake anywhere in the chain shows up as a
 * difference in the files you would actually get back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncApi } from "../src/api.ts";
import { type VaultKeys, deriveKeys, deriveMasterKey, makeKdfCheck } from "../src/crypto.ts";
import { DEFAULT_LAYOUT } from "../src/layout.ts";
import { runSync } from "../src/sync.ts";
import { NodeAdapter, nodeTransport } from "./node-adapter.ts";
import { type RunningServer, startServer } from "./server-harness.ts";

const SERVER = fileURLToPath(new URL("../target/debug/obsydian-sync-server", import.meta.url));
const RESTORE = fileURLToPath(new URL("../target/debug/obsydian-restore", import.meta.url));
const TOKEN = "fullstack-token";
const PASSPHRASE = "a real passphrase with ünïcode";

// A vault exercising the things that actually break: nesting, non-ASCII
// names, an empty file, binary content, and a file with no extension.
const FILES: Array<[string, string | Uint8Array]> = [
  ["Root note.md", "# Root\n\nplain content\n"],
  ["Work/Meetings/Standup.md", "- ship the thing\n- review PR\n"],
  ["Home/Groceries.md", "milk\nbread\n"],
  ["Home/Café niños.md", "unicode in the filename\n"],
  ["Deeply/nested/three/levels/deep.md", "deep\n"],
  ["Empty.md", ""],
  ["LICENSE", "no extension\n"],
  ["Media/shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0x7f])],
  ["Media/large.bin", new Uint8Array(200 * 1024).map((_, i) => (i * 37) & 0xff)],
];

let server: RunningServer;
let root: string;
let vault: string;
let store: string;
let api: SyncApi;
let keys: VaultKeys;

/** Every file under `dir`, as path -> bytes. */
function snapshot(dir: string, skip: (rel: string) => boolean = () => false): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const abs = join(current, name);
      const rel = relative(dir, abs).split("\\").join("/");
      if (skip(rel)) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(rel, readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  for (const bin of [SERVER, RESTORE]) {
    if (!existsSync(bin)) {
      throw new Error(`Missing ${bin}. Run: cargo build --package obsydian-sync-server --package obsydian-restore`);
    }
  }

  root = mkdtempSync(join(tmpdir(), "obsydian-fullstack-"));
  vault = join(root, "vault");
  store = join(root, "store");
  mkdirSync(vault, { recursive: true });

  const files = FILES;
  for (const [path, content] of files) {
    const abs = join(vault, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : Buffer.from(content));
  }

  server = await startServer({
    binary: SERVER,
    dataDir: store,
    configDir: root,
    devices: { desktop: TOKEN },
  });

  api = new SyncApi({ baseUrl: server.baseUrl, token: TOKEN, transport: nodeTransport, sleep: async () => {} });
  const meta = await api.meta();
  keys = await deriveKeys(await deriveMasterKey(PASSPHRASE, meta.kdf));
  await api.initMeta(await makeKdfCheck(keys, meta.vaultId));

  await runSync({ adapter: new NodeAdapter(vault), api, keys, layout: DEFAULT_LAYOUT, includeVaultConfig: false });
}, 60_000);

afterAll(async () => {
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a real vault through the real stack", () => {
  it("pushes every file", async () => {
    const meta = await api.meta();
    expect(meta.head).toBe(9);
  });

  it("restores byte-for-byte", () => {
    const out = join(root, "restored");
    execFileSync(RESTORE, ["--data-dir", store, "restore", "--out", out], {
      env: { ...process.env, OBSYDIAN_PASSPHRASE: PASSPHRASE },
    });

    // The plugin's own folder is excluded from sync by design, so it is the one
    // thing legitimately absent from a restore.
    const original = snapshot(vault, (rel) => rel === ".obsidian" || rel.startsWith(".obsidian/"));
    const restored = snapshot(out);

    expect([...restored.keys()].sort()).toEqual([...original.keys()].sort());
    for (const [path, bytes] of original) {
      expect(restored.get(path)?.equals(bytes), `${path} differs`).toBe(true);
    }
  }, 30_000);

  it("verifies clean", () => {
    const output = execFileSync(RESTORE, ["--data-dir", store, "verify"], {
      env: { ...process.env, OBSYDIAN_PASSPHRASE: PASSPHRASE },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).not.toContain("MISSING");
  }, 30_000);

  it("leaks no plaintext to the server", () => {
    // Needles are taken from the fixture itself — every path, and the content
    // of every text file — so the check cannot fall out of step with what the
    // vault actually holds.
    //
    // Two ways this check used to be wrong:
    //  - Short needles. Sealed data is uniformly random, so any 3-byte string
    //    such as "png" appears in it by chance roughly one run in ten, and the
    //    test "found" a leak that was not there. Six bytes makes a chance match
    //    vanishingly unlikely in the few hundred KB a test store holds.
    //  - Searching a latin1-decoded string. Paths are stored as UTF-8, so an
    //    "é" on disk decodes as "Ã©" and a non-ASCII needle could never match
    //    a real leak. Comparing bytes to bytes has neither problem.
    const MIN_NEEDLE_BYTES = 6;
    const store_bytes = Buffer.concat([...snapshot(store).values()]);

    // Every whole path, every folder and file name within it, each file name
    // without its extension, and every line of text content. A server that
    // leaked only "Standup" or "Meetings" — not the full path — must fail too.
    const needles = [
      ...new Set(
        FILES.flatMap(([path, content]) => {
          const segments = path.split("/");
          const stems = segments.map((s) => s.replace(/\.[^.]+$/, ""));
          const lines = typeof content === "string" ? content.split("\n") : [];
          return [path, ...segments, ...stems, ...lines];
        })
          .map((n) => n.trim())
          .filter((n) => Buffer.byteLength(n, "utf8") >= MIN_NEEDLE_BYTES),
      ),
    ];

    // Guard against the check silently shrinking to nothing.
    expect(needles.length).toBeGreaterThanOrEqual(20);
    // The name-only needles are the point of the extra coverage; be sure they
    // are really in the set rather than filtered out by the length floor.
    for (const name of ["Standup", "Meetings", "Groceries", "Café niños"]) expect(needles).toContain(name);

    for (const needle of needles) {
      expect(store_bytes.includes(Buffer.from(needle, "utf8")), `server holds the plaintext "${needle}"`).toBe(false);
    }
  });

  it("restores an earlier state with --at-seq", () => {
    const out = join(root, "restored-early");
    execFileSync(RESTORE, ["--data-dir", store, "--at-seq", "3", "restore", "--out", out], {
      env: { ...process.env, OBSYDIAN_PASSPHRASE: PASSPHRASE },
    });
    expect(snapshot(out).size).toBe(3);
  }, 30_000);
});
