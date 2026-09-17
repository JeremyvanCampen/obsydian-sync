/**
 * Wire types for the Obsydian Sync protocol.
 * The authority for all of this is ../../protocol/PROTOCOL.md — if the two
 * disagree, the spec wins and this file is a bug.
 */

export const PROTOCOL_VERSION = 1;

// --- Server: GET /v1/meta -------------------------------------------------

export interface KdfParams {
  /** Named so the KDF can be replaced (Argon2id in v2) without a protocol break. */
  alg: "PBKDF2-HMAC-SHA256";
  /** base64, 32 bytes */
  salt: string;
  iterations: number;
}

export interface VaultMeta {
  protocol: number;
  /** Lets a client refuse to merge two unrelated vault histories. */
  vaultId: string;
  kdf: KdfParams;
  /**
   * base64 sealed; decrypting it proves the passphrase is right.
   * null on a fresh vault — the first client sets it via POST /v1/meta/init.
   */
  kdfCheck: string | null;
  head: number;
  /** Assigned by the server from the bearer token; never asserted by the client. */
  yourDeviceId: string;
}

// --- Server: journal ------------------------------------------------------

/** An entry as stored and returned by the server. Payload is opaque to it. */
export interface JournalEntry {
  seq: number;
  deviceId: string;
  /** Client-generated 128-bit hex. AAD binding and idempotency key. */
  entryId: string;
  /** base64 sealed JournalPayload */
  payload: string;
}

export interface JournalPage {
  entries: JournalEntry[];
  head: number;
  more: boolean;
}

export interface JournalAppendRequest {
  entries: Array<{ entryId: string; payload: string }>;
}

export interface JournalAppendResponse {
  assigned: Array<{ entryId: string; seq: number }>;
  head: number;
}

// --- Journal payloads (plaintext, v1 has exactly two ops) -----------------

export interface PutOp {
  op: "put";
  path: string;
  blobId: string;
  /** Plaintext length. Advisory: used for display and the scan fast-path. */
  size: number;
  mtime: number;
}

export interface DeleteOp {
  op: "delete";
  path: string;
  mtime: number;
}

/** Renames are put + delete; see PROTOCOL.md §5. */
export type JournalPayload = PutOp | DeleteOp;

// --- Replayed remote index ------------------------------------------------

export type RemoteEntry =
  /**
   * `deviceId` is which device wrote this version. It names conflict files, so
   * the name says where the content came from rather than which device happened
   * to notice the conflict. Optional because state files written before it
   * existed do not carry it.
   */
  | { state: "present"; blobId: string; size: number; mtime: number; seq: number; deviceId?: string }
  /** Tombstones are retained: a local delete requires an explicit one. */
  | { state: "deleted"; mtime: number; seq: number; deviceId?: string };

export type RemoteIndex = Map<string, RemoteEntry>;

// --- Client base state ----------------------------------------------------

export interface BaseFile {
  /**
   * The content's blobId. Deliberately the same value the remote index carries,
   * so base and remote compare directly with no second digest to keep in sync.
   * This is the authoritative change signal — mtime is only a fast path.
   */
  blobId: string;
  size: number;
  mtime: number;
}

export interface BaseState {
  protocol: number;
  vaultId: string;
  deviceId: string;
  /**
   * The journal position `remote` was replayed to. The next sync pulls only
   * entries after this.
   */
  lastSeq: number;
  /** What this device last successfully synced: the "base" of the three-way merge. */
  files: Record<string, BaseFile>;
  /**
   * The replayed journal index, cached so a sync does not re-download the whole
   * journal every time. Purely derived: if it is missing or unusable the client
   * replays from seq 0 and rebuilds it.
   */
  remote: Record<string, RemoteEntry>;
}

export type BaseIndex = Map<string, BaseFile>;

/** A remote entry narrowed to the present case. */
export type RemotePresent = Extract<RemoteEntry, { state: "present" }>;
export type RemoteTombstone = Extract<RemoteEntry, { state: "deleted" }>;

/** A file as found on disk during a vault scan. */
export interface LocalFile {
  path: string;
  /** blobId of the current contents. Same space as BaseFile and RemoteEntry. */
  blobId: string;
  size: number;
  mtime: number;
}

export type LocalIndex = Map<string, LocalFile>;

// --- Errors ---------------------------------------------------------------

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "internal";

export interface ApiError {
  error: { code: ErrorCode; message: string };
}
