import { describe, expect, it } from "vitest";
import { SECRET_IDS, type SecretStore, migrateLegacySecrets, readSecret } from "../src/secrets.ts";

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  setSecret(id: string, secret: string): void {
    this.values.set(id, secret);
  }
}

describe("migrating credentials out of data.json", () => {
  it("moves both credentials into the store and removes them from data.json", () => {
    const store = new MemoryStore();
    const result = migrateLegacySecrets(store, {
      serverUrl: "http://100.x.y.z:8787",
      token: "device-token",
      passphrase: "correct horse battery staple",
    });

    expect(result.migrated.sort()).toEqual(["passphrase", "token"]);
    expect(result.failed).toEqual([]);
    expect(readSecret(store, "passphrase")).toBe("correct horse battery staple");
    expect(readSecret(store, "token")).toBe("device-token");

    // Nothing sensitive is left to persist, and other settings are untouched.
    expect(result.data).toEqual({ serverUrl: "http://100.x.y.z:8787" });
  });

  it("keeps the plaintext when the store throws, so nothing is lost", () => {
    const store: SecretStore = {
      getSecret: () => null,
      setSecret: () => {
        throw new Error("no keyring available");
      },
    };
    const result = migrateLegacySecrets(store, { passphrase: "irreplaceable" });

    expect(result.migrated).toEqual([]);
    expect(result.failed[0]?.name).toBe("passphrase");
    expect(result.data.passphrase).toBe("irreplaceable");
  });

  it("keeps the plaintext when a write silently does not persist", () => {
    // The dangerous case: no error, but the value is not actually there. Deleting
    // the only copy on the strength of a write that "succeeded" would lock the
    // user out of their vault.
    const store: SecretStore = { getSecret: () => null, setSecret: () => {} };
    const result = migrateLegacySecrets(store, { passphrase: "irreplaceable" });

    expect(result.failed[0]?.error).toMatch(/did not read back/);
    expect(result.data.passphrase).toBe("irreplaceable");
  });

  it("never overwrites a value already in the store", () => {
    const store = new MemoryStore();
    store.setSecret(SECRET_IDS.passphrase, "set after upgrading");

    const result = migrateLegacySecrets(store, { passphrase: "stale from data.json" });

    expect(readSecret(store, "passphrase")).toBe("set after upgrading");
    expect(result.data.passphrase).toBeUndefined();
  });

  it("drops empty legacy fields rather than migrating them", () => {
    const store = new MemoryStore();
    const result = migrateLegacySecrets(store, { passphrase: "", token: "" });

    expect(result.migrated).toEqual([]);
    expect(store.values.size).toBe(0);
    expect(result.data).toEqual({});
  });

  it("uses ids SecretStorage accepts", () => {
    // Lowercase alphanumeric with dashes; setSecret throws on anything else.
    for (const id of Object.values(SECRET_IDS)) expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
