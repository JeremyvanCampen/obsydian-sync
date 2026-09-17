import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  type Bytes,
  aadForBlob,
  aadForJournal,
  aadForKdfCheck,
  blobIdFor,
  deriveKeys,
  deriveMasterKey,
  deriveSubkeyBytes,
  fromBase64,
  makeKdfCheck,
  seal,
  sealWithIv,
  toBase64,
  toHex,
  unseal,
  verifyKdfCheck,
} from "../src/crypto.ts";

const vectors = JSON.parse(
  readFileSync(new URL("../protocol/vectors.json", import.meta.url), "utf8"),
);

const utf8 = new TextEncoder();
const fromHex = (hex: string): Bytes =>
  new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16))) as Bytes;

const master = await deriveMasterKey(vectors.passphrase.nfc, vectors.kdf);
const keys = await deriveKeys(master);
const keyFor = (role: string): CryptoKey => {
  const k = (keys as unknown as Record<string, CryptoKey | undefined>)[role];
  if (!k) throw new Error(`unknown key role ${role}`);
  return k;
};

describe("key derivation", () => {
  it("matches the master key vector", async () => {
    expect(toHex(master)).toBe(vectors.passphrase.masterKeyHex);
  });

  it("derives the same key from NFC and NFD forms of one passphrase", async () => {
    // macOS reports filenames and text decomposed; without normalization the
    // same passphrase typed on the MacBook and on Linux would open different
    // vaults.
    const fromNfd = await deriveMasterKey(vectors.passphrase.nfd, vectors.kdf);
    expect(toHex(fromNfd)).toBe(vectors.passphrase.masterKeyHex);
  });

  it("honours the iteration count from meta rather than a hardcoded one", async () => {
    const other = await deriveMasterKey(vectors.passphrase.nfc, {
      ...vectors.kdf,
      iterations: vectors.kdf.iterations + 1,
    });
    expect(toHex(other)).not.toBe(vectors.passphrase.masterKeyHex);
  });

  it("matches every subkey vector", async () => {
    const info = vectors.subkeys.info;
    expect(toHex(await deriveSubkeyBytes(master, info.content))).toBe(vectors.subkeys.contentHex);
    expect(toHex(await deriveSubkeyBytes(master, info.meta))).toBe(vectors.subkeys.metaHex);
    expect(toHex(await deriveSubkeyBytes(master, info.id))).toBe(vectors.subkeys.idHex);
    expect(toHex(await deriveSubkeyBytes(master, info.check))).toBe(vectors.subkeys.checkHex);
  });

  it("gives every purpose a distinct key", () => {
    const all = [
      vectors.subkeys.contentHex,
      vectors.subkeys.metaHex,
      vectors.subkeys.idHex,
      vectors.subkeys.checkHex,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("blob identity", () => {
  for (const c of vectors.blobIds.cases) {
    it(`matches the ${c.name} vector`, async () => {
      expect(await blobIdFor(keys, fromBase64(c.plaintextB64))).toBe(c.blobId);
    });
  }

  it("is deterministic, so identical content dedupes", async () => {
    const content = utf8.encode("same bytes") as Bytes;
    expect(await blobIdFor(keys, content)).toBe(await blobIdFor(keys, content));
  });

  it("is 32 lowercase hex characters, as the server validates", async () => {
    const id = await blobIdFor(keys, utf8.encode("x") as Bytes);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("sealing", () => {
  for (const c of vectors.seal.cases) {
    it(`reproduces the ${c.name} vector byte-for-byte`, async () => {
      const sealed = await sealWithIv(
        keyFor(c.key),
        fromBase64(c.plaintextB64),
        c.aad,
        fromHex(c.ivHex),
      );
      expect(toBase64(sealed)).toBe(c.sealedB64);
    });

    it(`opens the ${c.name} vector`, async () => {
      const plain = await unseal(keyFor(c.key), fromBase64(c.sealedB64), c.aad);
      expect(toBase64(plain)).toBe(c.plaintextB64);
    });
  }

  it("uses a fresh IV per seal, so the same plaintext never repeats a ciphertext", async () => {
    const plain = utf8.encode("identical") as Bytes;
    const a = await seal(keys.content, plain, aadForBlob("a".repeat(32)));
    const b = await seal(keys.content, plain, aadForBlob("a".repeat(32)));
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it("rejects a ciphertext opened under the wrong AAD", async () => {
    // This is what stops a server swapping one valid blob for another: the
    // ciphertext is bound to the identity it was stored under.
    const plain = utf8.encode("bound to its id") as Bytes;
    const sealed = await seal(keys.content, plain, aadForBlob("a".repeat(32)));
    await expect(unseal(keys.content, sealed, aadForBlob("b".repeat(32)))).rejects.toThrow();
  });

  it("rejects a ciphertext opened under the wrong key", async () => {
    const plain = utf8.encode("content key only") as Bytes;
    const aad = aadForBlob("a".repeat(32));
    const sealed = await seal(keys.content, plain, aad);
    await expect(unseal(keys.meta, sealed, aad)).rejects.toThrow();
  });

  it("rejects a tampered ciphertext", async () => {
    const aad = aadForJournal("macbook", "0".repeat(32));
    const sealed = await seal(keys.meta, utf8.encode("payload") as Bytes, aad);
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 0x01;
    await expect(unseal(keys.meta, sealed, aad)).rejects.toThrow();
  });

  it("rejects a value too short to hold an IV and a tag", async () => {
    await expect(
      unseal(keys.content, new Uint8Array(12) as Bytes, aadForBlob("a".repeat(32))),
    ).rejects.toThrow(/too short/);
  });
});

describe("passphrase verification", () => {
  const { vaultId } = vectors.identifiers;

  it("accepts the right passphrase", async () => {
    expect(await verifyKdfCheck(keys, vaultId, await makeKdfCheck(keys, vaultId))).toBe(true);
  });

  it("rejects a wrong passphrase instead of corrupting the vault", async () => {
    const check = await makeKdfCheck(keys, vaultId);
    const wrong = await deriveKeys(await deriveMasterKey("not the passphrase", vectors.kdf));
    expect(await verifyKdfCheck(wrong, vaultId, check)).toBe(false);
  });

  it("rejects a check value from a different vault", async () => {
    const check = await makeKdfCheck(keys, vaultId);
    expect(await verifyKdfCheck(keys, "f".repeat(32), check)).toBe(false);
  });

  it("opens the kdfCheck vector", async () => {
    const c = vectors.seal.cases.find((x: { name: string }) => x.name === "kdfCheck");
    expect(c).toBeDefined();
    expect(await verifyKdfCheck(keys, vaultId, c!.sealedB64)).toBe(true);
  });
});

describe("associated data format", () => {
  it("matches the spec strings", () => {
    const { vaultId, deviceId, entryId } = vectors.identifiers;
    expect(aadForBlob("abc")).toBe("v1/blob|abc");
    expect(aadForJournal(deviceId, entryId)).toBe(`v1/journal|${deviceId}|${entryId}`);
    expect(aadForKdfCheck(vaultId)).toBe(`v1/kdfcheck|${vaultId}`);
  });
});
