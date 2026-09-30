/**
 * Where this vault keeps its configuration, and where this plugin lives in it.
 *
 * Neither is fixed. Obsidian lets the config folder be overridden (Settings →
 * Files and links), and a separate one per device — `.obsidian` on the desktop,
 * `.obsidian-mobile` on the phone — is a common setup. The plugin folder is
 * wherever the plugin was actually installed.
 *
 * Getting this wrong is not cosmetic. The plugin's own folder holds this
 * device's base state and must never sync; hardcoding `.obsidian` meant that on
 * a vault with any other config folder the plugin excluded nothing of its own,
 * published its state, and wrote that state somewhere Obsidian never looks.
 *
 * It is a required input everywhere it matters, rather than a default, so the
 * compiler — not a reviewer — makes sure the real layout is passed in.
 */

export const PLUGIN_ID = "obsydian-sync";

export interface VaultLayout {
  /** Vault-relative, e.g. `.obsidian`. */
  readonly configDir: string;
  /** Vault-relative, e.g. `.obsidian/plugins/obsydian-sync`. */
  readonly pluginDir: string;
}

/** Vault-relative and slash-normalized: no leading or trailing separators. */
function tidy(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function vaultLayout(configDir: string, pluginDir?: string): VaultLayout {
  const config = tidy(configDir);
  if (!config) throw new Error("the vault's config folder is empty");
  return {
    configDir: config,
    pluginDir: pluginDir ? tidy(pluginDir) : `${config}/plugins/${PLUGIN_ID}`,
  };
}

/**
 * Obsidian's default layout — for code that runs outside Obsidian (tests, the
 * headless sync script), which has no configuration of its own to ask.
 */
export const DEFAULT_LAYOUT: VaultLayout = vaultLayout(".obsidian");

export function statePath(layout: VaultLayout): string {
  return `${layout.pluginDir}/state.json`;
}
