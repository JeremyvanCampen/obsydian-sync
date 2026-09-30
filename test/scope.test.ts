import { describe, expect, it } from "vitest";
import { CONFIG_DIR, syncScope } from "../src/scan.ts";

describe("sync scope", () => {
  it("always excludes per-device state and the plugin's own folder", () => {
    const scope = syncScope({ includeVaultConfig: true });
    expect(scope.includes(`${CONFIG_DIR}/workspace.json`)).toBe(false);
    expect(scope.includes(`${CONFIG_DIR}/plugins/obsydian-sync/data.json`)).toBe(false);
    expect(scope.includes(".trash/old.md")).toBe(false);
    expect(scope.includes(`${CONFIG_DIR}/app.json`)).toBe(true);
    expect(scope.includes("note.md")).toBe(true);
  });

  it("drops the whole config folder when vault config is off", () => {
    const scope = syncScope({ includeVaultConfig: false });
    expect(scope.includes(`${CONFIG_DIR}/app.json`)).toBe(false);
    expect(scope.descends(CONFIG_DIR)).toBe(false);
    expect(scope.includes("note.md")).toBe(true);
  });

  it("excludes the contents of an excluded folder, not just the folder", () => {
    // The mass-deletion bug: a pruned folder's children must read as excluded,
    // not as deleted.
    const scope = syncScope({ includeVaultConfig: true, exclude: ["Work/Private"] });
    expect(scope.descends("Work/Private")).toBe(false);
    expect(scope.includes("Work/Private/deep/secret.md")).toBe(false);
    expect(scope.includes("Work/public.md")).toBe(true);
  });

  it("agrees with itself: nothing it descends past is included, and vice versa", () => {
    const scope = syncScope({ includeVaultConfig: false, exclude: ["Archive/", "*.tmp", "Drafts"] });
    for (const folder of ["Archive", "Drafts", CONFIG_DIR, "Notes"]) {
      const child = `${folder}/x.md`;
      if (!scope.descends(folder)) expect(scope.includes(child), child).toBe(false);
    }
  });

  it("normalises patterns saved before normalisation existed", () => {
    // Settings written by an earlier version were stored raw.
    const scope = syncScope({ includeVaultConfig: true, exclude: ["/Work/", "  Drafts  "] });
    expect(scope.includes("Work/a.md")).toBe(false);
    expect(scope.includes("Drafts/b.md")).toBe(false);
  });
});
