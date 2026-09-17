/**
 * Client-side cryptography. See ../../protocol/PROTOCOL.md §3 — that document
 * is the contract, and `protocol/vectors.json` is how both implementations
 * prove they still agree.
 *
 * Everything here runs on WebCrypto, which Obsidian provides identically on
 * desktop and mobile.
 */

import type { KdfParams } from "./types.ts";

const SUBTLE = globalThis.crypto.subtle;

/**
 * TypeScript 5.7 split `Uint8Array` over its backing buffer, and WebCrypto's
 * `BufferSource` accepts only the `ArrayBuffer`-backed form. Naming it once
 * keeps every signature below assignable without casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** AES-GCM IV length in bytes. Never reuse an IV under one key. */
export const IV_BYTES = 12;

/** AES-GCM authentication tag, appended by WebCrypto. */
const TAG_BYTES = 16;

/** blobId is a 128-bit HMAC in lowercase hex. */
const BLOB_ID_BYTES = 16;

const INFO = {
  content: "obsydian-sync/v1/content",
  meta: "obsydian-sync/v1/meta",
  id: "obsydian-sync/v1/id",
  check: "obsydian-sync/v1/kdfcheck",
} as const;

/** The literal sealed by `kdfCheck`, used to verify a passphrase. */
const KDF_CHECK_PLAINTEXT = "obsydian-sync-kdf-check";

/** HKDF salt: 32 zero bytes, matching the spec and Rust's `Hkdf::new(None)`. */
const HKDF_SALT: Bytes = new Uint8Array(32);

export interface VaultKeys {
  content: CryptoKey;
  meta: CryptoKey;
  /** An HMAC signing key: used to derive blob ids, never to encrypt. */
  id: CryptoKey;
  check: CryptoKey;
}

// --- encoding helpers -----------------------------------------------------

const encoder = new TextEncoder();
const utf8 = { encode: (s: string): Bytes => encoder.encode(s) as Bytes };
const utf8Decode = new TextDecoder();

export function toBase64(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(b64: string): Bytes {
  const binary = atob(b64);
  const out: Bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- key derivation -------------------------------------------------------

/**
 * PBKDF2 over the passphrase. The passphrase is NFC-normalized first: the same
 * characters typed on macOS and on Linux must produce the same key, and macOS
 * hands back decomposed forms.
 */
export async function deriveMasterKey(
  passphrase: string,
  kdf: KdfParams,
): Promise<Bytes> {
  if (kdf.alg !== "PBKDF2-HMAC-SHA256") {
    throw new Error(`unsupported KDF: ${kdf.alg}`);
  }
  const material = await SUBTLE.importKey(
    "raw",
    utf8.encode(passphrase.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await SUBTLE.deriveBits(
    {
      name: "PBKDF2",
      salt: fromBase64(kdf.salt),
      iterations: kdf.iterations,
      hash: "SHA-256",
    },
    material,
    256,
  );
  return new Uint8Array(bits) as Bytes;
}

async function hkdf(master: Bytes, info: string, usages: KeyUsage[], algorithm: "AES-GCM" | "HMAC"): Promise<CryptoKey> {
  const material = await SUBTLE.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  const bits = await SUBTLE.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: utf8.encode(info) },
    material,
    256,
  );
  const params = algorithm === "HMAC" ? { name: "HMAC", hash: "SHA-256" } : { name: "AES-GCM" };
  return SUBTLE.importKey("raw", bits, params, false, usages);
}

/** Raw subkey bytes. Exposed for the test vectors; normal code uses `deriveKeys`. */
export async function deriveSubkeyBytes(master: Bytes, info: string): Promise<Bytes> {
  const material = await SUBTLE.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  const bits = await SUBTLE.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: utf8.encode(info) },
    material,
    256,
  );
  return new Uint8Array(bits) as Bytes;
}

export const SUBKEY_INFO = INFO;

/**
 * One key per purpose. A key is never reused across two of these — separation
 * is what stops a chosen-ciphertext game in one context from touching another.
 */
export async function deriveKeys(master: Bytes): Promise<VaultKeys> {
  const [content, meta, id, check] = await Promise.all([
    hkdf(master, INFO.content, ["encrypt", "decrypt"], "AES-GCM"),
    hkdf(master, INFO.meta, ["encrypt", "decrypt"], "AES-GCM"),
    hkdf(master, INFO.id, ["sign"], "HMAC"),
    hkdf(master, INFO.check, ["encrypt", "decrypt"], "AES-GCM"),
  ]);
  return { content, meta, id, check };
}

// --- associated data ------------------------------------------------------
//
// AAD binds each ciphertext to its identity, so a server that swapped one valid
// ciphertext for another would produce a decryption failure rather than a
// silently wrong result.

export function aadForBlob(blobId: string): string {
  return `v1/blob|${blobId}`;
}

/**
 * Note this uses entryId, not seq: seq is assigned server-side after the client
 * has already encrypted, so it cannot be bound in.
 */
export function aadForJournal(deviceId: string, entryId: string): string {
  return `v1/journal|${deviceId}|${entryId}`;
}

export function aadForKdfCheck(vaultId: string): string {
  return `v1/kdfcheck|${vaultId}`;
}

// --- sealing --------------------------------------------------------------

/**
 * `iv || AES-256-GCM(plaintext) || tag`. WebCrypto appends the 128-bit tag, so
 * only the IV prefix is assembled by hand.
 */
export async function seal(key: CryptoKey, plaintext: Bytes, aad: string): Promise<Bytes> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  return sealWithIv(key, plaintext, aad, iv);
}

/** Deterministic form, for test vectors only. Production code must use `seal`. */
export async function sealWithIv(
  key: CryptoKey,
  plaintext: Bytes,
  aad: string,
  iv: Bytes,
): Promise<Bytes> {
  if (iv.length !== IV_BYTES) throw new Error(`iv must be ${IV_BYTES} bytes`);
  const ct = await SUBTLE.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(aad), tagLength: 128 },
    key,
    plaintext,
  );
  const out: Bytes = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

export async function unseal(key: CryptoKey, sealed: Bytes, aad: string): Promise<Bytes> {
  // Strictly less-than: an empty file seals to exactly IV + tag = 28 bytes,
  // which is a legitimate value. Obsidian creates empty notes routinely, and
  // rejecting them here would fail the sync and, worse, abort a restore.
  if (sealed.length < IV_BYTES + TAG_BYTES) {
    throw new Error("sealed value is too short to contain an IV and a tag");
  }
  const plain = await SUBTLE.decrypt(
    {
      name: "AES-GCM",
      iv: sealed.subarray(0, IV_BYTES),
      additionalData: utf8.encode(aad),
      tagLength: 128,
    },
    key,
    sealed.subarray(IV_BYTES),
  );
  return new Uint8Array(plain) as Bytes;
}

// --- blob identity --------------------------------------------------------

/**
 * `blobId = HMAC-SHA256(k_id, plaintext)[0..16]`, lowercase hex.
 *
 * An HMAC rather than a bare hash: content still dedupes and re-uploads stay
 * idempotent, but the server cannot confirm a guess about what a blob holds.
 */
export async function blobIdFor(keys: VaultKeys, plaintext: Bytes): Promise<string> {
  const mac = await SUBTLE.sign("HMAC", keys.id, plaintext);
  return toHex(new Uint8Array(mac, 0, BLOB_ID_BYTES));
}

// --- passphrase verification ---------------------------------------------

export async function makeKdfCheck(keys: VaultKeys, vaultId: string): Promise<string> {
  const sealed = await seal(keys.check, utf8.encode(KDF_CHECK_PLAINTEXT), aadForKdfCheck(vaultId));
  return toBase64(sealed);
}

/**
 * Verifies a passphrase before any data is written. Getting this wrong once
 * would fill the vault with blobs nothing can ever decrypt.
 */
export async function verifyKdfCheck(
  keys: VaultKeys,
  vaultId: string,
  kdfCheckB64: string,
): Promise<boolean> {
  try {
    const plain = await unseal(keys.check, fromBase64(kdfCheckB64), aadForKdfCheck(vaultId));
    return utf8Decode.decode(plain) === KDF_CHECK_PLAINTEXT;
  } catch {
    // A wrong passphrase fails the AEAD tag; that is the expected path here,
    // not an error worth propagating.
    return false;
  }
}

export const KDF_CHECK_LITERAL = KDF_CHECK_PLAINTEXT;
