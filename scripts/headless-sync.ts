/**
 * Syncs a directory as if it were a device, without Obsidian.
 *
 *   node scripts/headless-sync.ts <vault-dir> <server-url> <token> <passphrase>
 *
 * Useful as a second device when testing: you can drive it while a real
 * Obsidian sits on the other side, which is how the deletion and conflict paths
 * were first exercised against a real client.
 */

import { SyncApi, type Transport } from "../src/api.ts";
import { deriveKeys, deriveMasterKey } from "../src/crypto.ts";
import { runSync } from "../src/sync.ts";
import { NodeAdapter } from "../test/node-adapter.ts";

const [vault, baseUrl, token, passphrase] = process.argv.slice(2);
if (!vault || !baseUrl || !token || !passphrase) {
  console.error("usage: node scripts/headless-sync.ts <vault-dir> <server-url> <token> <passphrase>");
  process.exit(2);
}

const transport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as BodyInit),
  });
  const buf = await res.arrayBuffer();
  return { status: res.status, text: new TextDecoder().decode(buf), arrayBuffer: buf };
};

const api = new SyncApi({ baseUrl, token, transport });
const meta = await api.meta();
const keys = await deriveKeys(await deriveMasterKey(passphrase, meta.kdf));

const s = await runSync({
  adapter: new NodeAdapter(vault),
  api,
  keys,
  includeVaultConfig: true,
  onNote: (n) => console.log(`  [${n.level}] ${n.path || "-"}: ${n.message}`),
});

console.log(
  `pushed ${s.pushed}, pulled ${s.pulled}, trashed ${s.deletedLocally}, ` +
    `deletions sent ${s.pushedDeletions}, scanned ${s.scanned}, lastSeq ${s.lastSeq}` +
    (s.blocked ? `\nBLOCKED: ${s.blocked.reason}` : ""),
);
