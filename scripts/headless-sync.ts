/**
 * Syncs a directory as if it were a device, without Obsidian.
 *
 *   node scripts/headless-sync.ts <vault-dir> <server-url> <token> <passphrase>
 *
 * Useful as a second device when testing: you can drive it while a real
 * Obsidian sits on the other side, which is how the deletion and conflict paths
 * were first exercised against a real client.
 */

import { SyncApi } from "../src/api.ts";
import { deriveKeys, deriveMasterKey } from "../src/crypto.ts";
import { runSync } from "../src/sync.ts";
import { NodeAdapter, nodeTransport } from "../test/node-adapter.ts";

const [vault, baseUrl, token, passphrase] = process.argv.slice(2);
if (!vault || !baseUrl || !token || !passphrase) {
  console.error("usage: node scripts/headless-sync.ts <vault-dir> <server-url> <token> <passphrase>");
  process.exit(2);
}

const api = new SyncApi({ baseUrl, token, transport: nodeTransport });
const meta = await api.meta();
const keys = await deriveKeys(await deriveMasterKey(passphrase, meta.kdf));

const s = await runSync({
  adapter: new NodeAdapter(vault),
  api,
  keys,
  meta,
  includeVaultConfig: true,
  onNote: (n) => console.log(`  [${n.level}] ${n.path || "-"}: ${n.message}`),
});

console.log(
  `pushed ${s.pushed}, pulled ${s.pulled}, trashed ${s.deletedLocally}, ` +
    `deletions sent ${s.pushedDeletions}, scanned ${s.scanned}, lastSeq ${s.lastSeq}` +
    (s.blocked ? `\nBLOCKED: ${s.blocked.reason}` : ""),
);
