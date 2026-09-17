/**
 * Client side of the journal: turning entries into a remote index, and turning
 * local decisions into entries.
 */

import {
  type Bytes,
  type VaultKeys,
  aadForJournal,
  fromBase64,
  seal,
  toBase64,
  unseal,
} from "./crypto.ts";
import type { JournalEntry, JournalPayload, RemoteIndex } from "./types.ts";

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

export interface ReplayResult {
  index: RemoteIndex;
  lastSeq: number;
}

/**
 * Replays entries in sequence order into a remote index.
 *
 * A `delete` leaves a **tombstone** rather than removing the path. That
 * distinction is what lets the reconciler tell "the vault deleted this" from
 * "the server has never heard of this", and only the first may delete a local
 * file.
 */
export async function replay(
  entries: JournalEntry[],
  keys: VaultKeys,
  into?: RemoteIndex,
  fromSeq = 0,
): Promise<ReplayResult> {
  const index: RemoteIndex = into ?? new Map();
  let lastSeq = fromSeq;

  // Defensive: the server returns ascending order, but the index is only
  // correct if later entries genuinely win.
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);

  for (const entry of ordered) {
    if (entry.seq <= lastSeq) continue;

    const payload = await decodeEntry(entry, keys);

    if (payload.op === "put") {
      index.set(payload.path, {
        state: "present",
        blobId: payload.blobId,
        size: payload.size,
        mtime: payload.mtime,
        seq: entry.seq,
        deviceId: entry.deviceId,
      });
    } else {
      index.set(payload.path, {
        state: "deleted",
        mtime: payload.mtime,
        seq: entry.seq,
        deviceId: entry.deviceId,
      });
    }

    lastSeq = entry.seq;
  }

  return { index, lastSeq };
}

/**
 * Decrypts and validates one entry.
 *
 * Any failure here aborts the sync rather than skipping the entry. Skipping is
 * not a safe degradation: dropping a `delete` op silently resurrects a note,
 * which is the exact bug this project exists to fix.
 */
export async function decodeEntry(entry: JournalEntry, keys: VaultKeys): Promise<JournalPayload> {
  let plain: Bytes;
  try {
    plain = await unseal(
      keys.meta,
      fromBase64(entry.payload),
      aadForJournal(entry.deviceId, entry.entryId),
    );
  } catch (e) {
    throw new Error(
      `journal entry ${entry.seq} (from ${entry.deviceId}) could not be decrypted — ` +
        `wrong passphrase, or the entry has been tampered with: ${String(e)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode.decode(plain));
  } catch {
    throw new Error(`journal entry ${entry.seq} decrypted to something that is not JSON`);
  }

  const payload = parsed as Partial<JournalPayload>;
  if (payload.op === "put") {
    if (
      typeof payload.path !== "string" ||
      typeof payload.blobId !== "string" ||
      typeof payload.size !== "number" ||
      typeof payload.mtime !== "number"
    ) {
      throw new Error(`journal entry ${entry.seq} is a malformed put`);
    }
    return payload as JournalPayload;
  }
  if (payload.op === "delete") {
    if (typeof payload.path !== "string" || typeof payload.mtime !== "number") {
      throw new Error(`journal entry ${entry.seq} is a malformed delete`);
    }
    return payload as JournalPayload;
  }
  throw new Error(`journal entry ${entry.seq} has unknown op ${String(payload.op)}`);
}

/** A sealed entry, ready to POST. `entryId` is also the idempotency key. */
export interface PreparedEntry {
  entryId: string;
  payload: string;
}

export async function prepareEntry(
  payload: JournalPayload,
  keys: VaultKeys,
  deviceId: string,
): Promise<PreparedEntry> {
  const entryId = randomHex(16);
  const sealed = await seal(
    keys.meta,
    utf8.encode(JSON.stringify(payload)) as Bytes,
    aadForJournal(deviceId, entryId),
  );
  return { entryId, payload: toBase64(sealed) };
}

export function randomHex(bytes: number): string {
  const buf = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
