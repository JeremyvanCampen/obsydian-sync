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

/** Lowercase alphanumeric with dashes, as SecretStorage requires. */
export const SECRET_IDS = {
  passphrase: "obsydian-sync-passphrase",
  token: "obsydian-sync-token",
} as const;

export type SecretName = keyof typeof SECRET_IDS;

export function readSecret(store: SecretStore, name: SecretName): string {
  return store.getSecret(SECRET_IDS[name]) ?? "";
}

export function writeSecret(store: SecretStore, name: SecretName, value: string): void {
  store.setSecret(SECRET_IDS[name], value);
}

export interface MigrationResult {
  /** Settings with any migrated credentials removed; safe to persist. */
  data: Record<string, unknown>;
  migrated: SecretName[];
  /** Left in place because the store would not hold them. Nothing is lost. */
  failed: Array<{ name: SecretName; error: string }>;
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
): MigrationResult {
  const data = { ...saved };
  const migrated: SecretName[] = [];
  const failed: MigrationResult["failed"] = [];

  for (const name of Object.keys(SECRET_IDS) as SecretName[]) {
    const legacy = data[name];
    if (typeof legacy !== "string" || legacy === "") {
      delete data[name];
      continue;
    }

    // A value already in the store is newer than one in data.json only if the
    // user set it through the settings tab after upgrading. Never overwrite it.
    const existing = readSecret(store, name);
    if (existing !== "") {
      delete data[name];
      continue;
    }

    try {
      writeSecret(store, name, legacy);
      if (readSecret(store, name) !== legacy) {
        throw new Error("the stored value did not read back");
      }
      delete data[name];
      migrated.push(name);
    } catch (e) {
      failed.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { data, migrated, failed };
}
