/**
 * The whole system, end to end: a real vault on disk, the real client, the real
 * server binary, and the real restore CLI — then a byte-for-byte comparison.
 *
 * This is the closest thing to the drill SETUP.md asks you to run by hand, and
 * it is the only test where a mistake anywhere in the chain shows up as a
 * difference in the files you would actually get back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncApi, type Transport } from "../src/api.ts";
import { type VaultKeys, deriveKeys, deriveMasterKey, makeKdfCheck } from "../src/crypto.ts";
import { runSync } from "../src/sync.ts";
import { NodeAdapter } from "./node-adapter.ts";

const SERVER = fileURLToPath(new URL("../target/debug/obsydian-sync-server", import.meta.url));
const RESTORE = fileURLToPath(new URL("../target/debug/obsydian-restore", import.meta.url));
const TOKEN = "fullstack-token";
const PASSPHRASE = "a real passphrase with ünïcode";
// A fresh port per run. A fixed one collides with a previous run whose server
// has exited but whose port the OS still holds, which shows up as an
// intermittent, baffling failure rather than an obvious one.
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;
let root: string;
let vault: string;
let store: string;
let api: SyncApi;
let keys: VaultKeys;

const transport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as BodyInit),
  });
  const buf = await res.arrayBuffer();
  return { status: res.status, text: new TextDecoder().decode(buf), arrayBuffer: buf };
};

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

  // A vault exercising the things that actually break: nesting, non-ASCII
  // names, an empty file, binary content, and a file with no extension.
  const files: Array<[string, string | Uint8Array]> = [
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
  for (const [path, content] of files) {
    const abs = join(vault, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : Buffer.from(content));
  }

  const digest = execFileSync(SERVER, ["--hash-token"], { input: TOKEN, encoding: "utf8" }).trim();
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    [`bind = "127.0.0.1:${PORT}"`, `data_dir = "${store}"`, "", "[[devices]]", 'id = "desktop"', `token_sha256 = "${digest}"`, ""].join("\n"),
  );

  server = spawn(SERVER, [configPath], { stdio: "ignore" });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  api = new SyncApi({ baseUrl: BASE, token: TOKEN, transport, sleep: async () => {} });
  const meta = await api.meta();
  keys = await deriveKeys(await deriveMasterKey(PASSPHRASE, meta.kdf));
  await api.initMeta(await makeKdfCheck(keys, meta.vaultId));

  await runSync({ adapter: new NodeAdapter(vault), api, keys, includeVaultConfig: false });
}, 60_000);

afterAll(() => {
  server?.kill("SIGTERM");
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
    // Literal comparison, not a regex: a '.' in a pattern matches any byte and
    // will happily "find" .md inside base64, which makes the check meaningless.
    let everything = "";
    for (const bytes of snapshot(store).values()) everything += bytes.toString("binary");

    for (const secret of [
      ".md", "Standup", "Work", "Groceries", "Café", "niños",
      "milk", "brood", "TICKET-123", "LICENSE", "Media", "png", "Deeply",
    ]) {
      expect(everything.includes(secret), `server holds the plaintext "${secret}"`).toBe(false);
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
