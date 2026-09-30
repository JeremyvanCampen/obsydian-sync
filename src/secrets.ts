/**
 * Credentials live in Obsidian's SecretStorage (the OS keychain on desktop),
 * not in data.json.
 *
 * data.json sits inside the vault. This plugin never syncs it, but other things
 * do: a vault kept in iCloud, Obsidian Sync, or any sync plugin with a
 * "sync config folder" option would carry a plaintext passphrase along with it.
 * The passphrase is the one secret that decrypts the whole server copy, so it
 * should not be a readable file inside the thing being synced.
 */

/** The slice of Obsidian's SecretStorage this plugin uses — testable without Obsidian. */
export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export const SECRET_NAMES = ["passphrase", "token"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Ids carry a per-vault namespace, stored in that vault's data.json.
 *
 * SecretStorage may be shared by every vault on the device — its typings do not
 * say. Fixed ids would then let two vaults, each pointed at a different server,
 * silently overwrite each other's token and passphrase. The namespace makes the
 * ids distinct either way. Lowercase alphanumeric with dashes, as required.
 */
export function secretId(namespace: string, name: SecretName): string {
  return `obsydian-sync-${namespace}-${name}`;
}

export function isValidNamespace(ns: unknown): ns is string {
  return typeof ns === "string" && /^[a-z0-9]{8,32}$/.test(ns);
}

/**
 * Reads and writes credentials, falling back to values held in memory when the
 * store cannot be used.
 *
 * The fallback exists so that a device whose keychain will not accept writes
 * keeps syncing on the credentials it already had, rather than silently going
 * dark after an upgrade. It is only ever populated from a migration that failed,
 * and it is never written anywhere.
 */
export class Credentials {
  private readonly store: SecretStore;
  private readonly namespace: string;
  private readonly fallback: Partial<Record<SecretName, string>>;

  // Fields written out rather than as parameter properties, which Node's
  // type-stripping does not support (see ApiError in api.ts).
  constructor(store: SecretStore, namespace: string, fallback: Partial<Record<SecretName, string>> = {}) {
    this.store = store;
    this.namespace = namespace;
    this.fallback = fallback;
  }

  get(name: SecretName): string {
    let stored: string | null = null;
    try {
      stored = this.store.getSecret(secretId(this.namespace, name));
    } catch {
      // A store that cannot be read is treated like one holding nothing; the
      // fallback, if any, still applies.
    }
    return stored || this.fallback[name] || "";
  }

  /** Throws if the store refuses. The caller must tell the user. */
  set(name: SecretName, value: string): void {
    this.store.setSecret(secretId(this.namespace, name), value);
  }
}

export interface MigrationResult {
  /** Settings with every legacy credential removed. Persist when `changed`. */
  data: Record<string, unknown>;
  /**
   * Whether `data` differs from what was loaded, and so must be written back.
   *
   * Not the same as "something migrated". A legacy value can also be dropped
   * because the store already holds it — after a crash between the store write
   * and the file save, say — and that plaintext must still leave the file.
   */
  changed: boolean;
  migrated: SecretName[];
  /** Left in data.json because the store would not hold them. Nothing is lost. */
  failed: Array<{ name: SecretName; error: string }>;
  /** Values the store refused, for Credentials to fall back on. */
  fallback: Partial<Record<SecretName, string>>;
}

/**
 * Moves credentials that an earlier version saved in data.json into the store.
 *
 * Each value is removed from data.json only after reading it back from the
 * store and confirming it matches. A write that throws, or one that silently
 * does not persist, leaves the plaintext where it was — a credential that is
 * still exposed is recoverable; one that has been deleted from both places is
 * a vault nobody can open.
 */
export function migrateLegacySecrets(
  store: SecretStore,
  saved: Record<string, unknown>,
  namespace: string,
): MigrationResult {
  const data = { ...saved };
  const result: MigrationResult = { data, changed: false, migrated: [], failed: [], fallback: {} };
  const credentials = new Credentials(store, namespace);

  const drop = (name: SecretName) => {
    if (name in data) {
      delete data[name];
      result.changed = true;
    }
  };

  for (const name of SECRET_NAMES) {
    const legacy = data[name];
    if (typeof legacy !== "string" || legacy === "") {
      drop(name);
      continue;
    }

    try {
      // A value already in the store is newer than one in data.json: the user
      // set it after upgrading. Never overwrite it — but the stale plaintext
      // still has to go.
      if (credentials.get(name) !== "") {
        drop(name);
        continue;
      }

      credentials.set(name, legacy);
      if (credentials.get(name) !== legacy) {
        throw new Error("the stored value did not read back");
      }
      drop(name);
      result.migrated.push(name);
    } catch (e) {
      result.failed.push({ name, error: e instanceof Error ? e.message : String(e) });
      result.fallback[name] = legacy;
    }
  }

  return result;
}
