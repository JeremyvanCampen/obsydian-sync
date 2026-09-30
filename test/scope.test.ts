import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, vaultLayout } from "../src/layout.ts";
import { syncScope } from "../src/scan.ts";

const CONFIG_DIR = DEFAULT_LAYOUT.configDir;
const layout = DEFAULT_LAYOUT;

describe("sync scope", () => {
  it("always excludes per-device state and the plugin's own folder", () => {
    const scope = syncScope({ layout, includeVaultConfig: true });
    expect(scope.includes(`${CONFIG_DIR}/workspace.json`)).toBe(false);
    expect(scope.includes(`${CONFIG_DIR}/plugins/obsydian-sync/data.json`)).toBe(false);
    expect(scope.includes(".trash/old.md")).toBe(false);
    expect(scope.includes(`${CONFIG_DIR}/app.json`)).toBe(true);
    expect(scope.includes("note.md")).toBe(true);
  });

  it("drops the whole config folder when vault config is off", () => {
    const scope = syncScope({ layout, includeVaultConfig: false });
    expect(scope.includes(`${CONFIG_DIR}/app.json`)).toBe(false);
    expect(scope.descends(CONFIG_DIR)).toBe(false);
    expect(scope.includes("note.md")).toBe(true);
  });

  it("excludes the contents of an excluded folder, not just the folder", () => {
    // The mass-deletion bug: a pruned folder's children must read as excluded,
    // not as deleted.
    const scope = syncScope({ layout, includeVaultConfig: true, exclude: ["Work/Private"] });
    expect(scope.descends("Work/Private")).toBe(false);
    expect(scope.includes("Work/Private/deep/secret.md")).toBe(false);
    expect(scope.includes("Work/public.md")).toBe(true);
  });

  it("agrees with itself: nothing it descends past is included, and vice versa", () => {
    const scope = syncScope({ layout, includeVaultConfig: false, exclude: ["Archive/", "*.tmp", "Drafts"] });
    for (const folder of ["Archive", "Drafts", CONFIG_DIR, "Notes"]) {
      const child = `${folder}/x.md`;
      if (!scope.descends(folder)) expect(scope.includes(child), child).toBe(false);
    }
  });

  it("normalises patterns saved before normalisation existed", () => {
    // Settings written by an earlier version were stored raw.
    const scope = syncScope({ layout, includeVaultConfig: true, exclude: ["/Work/", "  Drafts  "] });
    expect(scope.includes("Work/a.md")).toBe(false);
    expect(scope.includes("Drafts/b.md")).toBe(false);
  });
});

describe("a vault whose config folder is not .obsidian", () => {
  // A separate config folder per device (".obsidian-mobile" on the phone) is a
  // common setup. Hardcoding ".obsidian" meant that on such a vault the plugin
  // excluded nothing of its own.
  const mobile = vaultLayout(".obsidian-mobile", ".obsidian-mobile/plugins/obsydian-sync");

  it("excludes its own plugin folder and per-device workspace files there", () => {
    const scope = syncScope({ layout: mobile, includeVaultConfig: true });
    expect(scope.includes(".obsidian-mobile/plugins/obsydian-sync/state.json")).toBe(false);
    expect(scope.includes(".obsidian-mobile/plugins/obsydian-sync/data.json")).toBe(false);
    expect(scope.includes(".obsidian-mobile/workspace-mobile.json")).toBe(false);
    expect(scope.includes(".obsidian-mobile/app.json")).toBe(true);
  });

  it("drops that folder, not .obsidian, when vault config is off", () => {
    const scope = syncScope({ layout: mobile, includeVaultConfig: false });
    expect(scope.descends(".obsidian-mobile")).toBe(false);
    expect(scope.includes(".obsidian-mobile/app.json")).toBe(false);
  });

  it("uses the folder the plugin was actually installed in", () => {
    // manifest.dir, e.g. a plugin folder named differently by an installer.
    const renamed = vaultLayout(".obsidian", ".obsidian/plugins/obsydian-sync-beta");
    const scope = syncScope({ layout: renamed, includeVaultConfig: true });
    expect(scope.includes(".obsidian/plugins/obsydian-sync-beta/state.json")).toBe(false);
  });
});

describe("vaultLayout", () => {
  it("derives the plugin folder when Obsidian does not report one", () => {
    expect(vaultLayout(".obsidian-mobile").pluginDir).toBe(".obsidian-mobile/plugins/obsydian-sync");
  });

  it("normalises separators so paths compare with scanned ones", () => {
    const l = vaultLayout("/.config/", ".config\\plugins\\obsydian-sync\\");
    expect(l).toEqual({ configDir: ".config", pluginDir: ".config/plugins/obsydian-sync" });
  });

  it("refuses an empty config folder rather than excluding the whole vault", () => {
    expect(() => vaultLayout("/")).toThrow();
  });
});
