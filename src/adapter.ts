/**
 * The slice of Obsidian's `DataAdapter` this plugin uses.
 *
 * Declared as our own interface for two reasons: it is the exact surface we
 * depend on, and it lets every module that touches files be tested against an
 * in-memory fake rather than a running Obsidian.
 *
 * The adapter is used rather than the `Vault` API because `.obsidian/` is not
 * visible through `Vault`, and vault settings are in scope for v1.
 */
export interface VaultAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ type: "file" | "folder"; mtime: number; size: number } | null>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Moves into the vault's `.trash`, so a wrong decision stays recoverable. */
  trashLocal(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
