import { describe, expect, it } from "vitest";
import {
  Credentials,
  SECRET_NAMES,
  type SecretStore,
  isValidNamespace,
  migrateLegacySecrets,
  secretId,
} from "../src/secrets.ts";

const NS = "a1b2c3d4e5f6";

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
    const result = migrateLegacySecrets(
      store,
      { serverUrl: "http://100.x.y.z:8787", token: "device-token", passphrase: "correct horse" },
      NS,
    );

    expect(result.migrated.sort()).toEqual(["passphrase", "token"]);
    expect(result.failed).toEqual([]);
    expect(result.changed).toBe(true);
    const creds = new Credentials(store, NS);
    expect(creds.get("passphrase")).toBe("correct horse");
    expect(creds.get("token")).toBe("device-token");
    expect(result.data).toEqual({ serverUrl: "http://100.x.y.z:8787" });
  });

  it("still rewrites data.json when the store already holds the value", () => {
    // After a crash between the store write and the file save, the next load
    // finds the value in both places. Nothing "migrates", but the plaintext in
    // data.json must still go — which means the file must be rewritten.
    const store = new MemoryStore();
    store.setSecret(secretId(NS, "passphrase"), "already stored");

    const result = migrateLegacySecrets(store, { passphrase: "already stored" }, NS);

    expect(result.migrated).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.data.passphrase).toBeUndefined();
  });

  it("does not ask for a rewrite when there was nothing to remove", () => {
    const result = migrateLegacySecrets(new MemoryStore(), { serverUrl: "x" }, NS);
    expect(result.changed).toBe(false);
  });

  it("never overwrites a value already in the store", () => {
    const store = new MemoryStore();
    store.setSecret(secretId(NS, "passphrase"), "set after upgrading");

    migrateLegacySecrets(store, { passphrase: "stale from data.json" }, NS);

    expect(new Credentials(store, NS).get("passphrase")).toBe("set after upgrading");
  });

  it("keeps the plaintext, and keeps syncing, when the store throws", () => {
    const store: SecretStore = {
      getSecret: () => null,
      setSecret: () => {
        throw new Error("no keyring available");
      },
    };
    const result = migrateLegacySecrets(store, { passphrase: "irreplaceable" }, NS);

    expect(result.failed[0]?.name).toBe("passphrase");
    expect(result.data.passphrase).toBe("irreplaceable");
    // The plugin reads through the fallback rather than going silently dark.
    expect(new Credentials(store, NS, result.fallback).get("passphrase")).toBe("irreplaceable");
  });

  it("keeps the plaintext when a write silently does not persist", () => {
    // The dangerous case: no error, but the value is not there. Deleting the
    // only copy on the strength of that write would lock the user out.
    const store: SecretStore = { getSecret: () => null, setSecret: () => {} };
    const result = migrateLegacySecrets(store, { passphrase: "irreplaceable" }, NS);

    expect(result.failed[0]?.error).toMatch(/did not read back/);
    expect(result.data.passphrase).toBe("irreplaceable");
  });

  it("does not fail plugin load when the store cannot even be read", () => {
    const store: SecretStore = {
      getSecret: () => {
        throw new Error("keychain locked");
      },
      setSecret: () => {
        throw new Error("keychain locked");
      },
    };
    expect(() => migrateLegacySecrets(store, { passphrase: "p", token: "t" }, NS)).not.toThrow();
    expect(() => new Credentials(store, NS).get("passphrase")).not.toThrow();
  });

  it("drops empty legacy fields", () => {
    const store = new MemoryStore();
    const result = migrateLegacySecrets(store, { passphrase: "", token: "" }, NS);
    expect(store.values.size).toBe(0);
    expect(result.data).toEqual({});
    expect(result.changed).toBe(true);
  });
});

describe("secret ids", () => {
  it("keep two vaults' credentials apart on a shared store", () => {
    // If SecretStorage is shared across vaults on a device, fixed ids would let
    // one vault overwrite another's token and passphrase.
    const store = new MemoryStore();
    new Credentials(store, "vaultone0001").set("token", "for server A");
    new Credentials(store, "vaulttwo0002").set("token", "for server B");

    expect(new Credentials(store, "vaultone0001").get("token")).toBe("for server A");
    expect(new Credentials(store, "vaulttwo0002").get("token")).toBe("for server B");
  });

  it("are in the form SecretStorage accepts", () => {
    for (const name of SECRET_NAMES) expect(secretId(NS, name)).toMatch(/^[a-z0-9-]+$/);
  });

  it("reject a namespace that would produce an invalid id", () => {
    expect(isValidNamespace(NS)).toBe(true);
    for (const bad of ["", "UPPER", "has space", "a-b", 42, undefined]) {
      expect(isValidNamespace(bad), String(bad)).toBe(false);
    }
  });
});
