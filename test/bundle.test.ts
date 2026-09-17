/**
 * Loads the built bundle the way Obsidian will.
 *
 * Everything else tests the sources. This is the only check that the artifact
 * actually shipped to a device parses, evaluates, and exposes a plugin class —
 * an esbuild misconfiguration or a stray top-level side effect would otherwise
 * surface as "plugin failed to load" on the phone with no further explanation.
 */

import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundlePath = fileURLToPath(new URL("../main.js", import.meta.url));
const manifestPath = fileURLToPath(new URL("../manifest.json", import.meta.url));

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("the shipped bundle", () => {
  it("exists — run `npm run build` first", () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("loads against a stub of the Obsidian API and exports a plugin class", () => {
    // Obsidian injects its own module at runtime; the bundle marks it external.
    // Standing up a stub proves the bundle asks for nothing else.
    const dir = mkdtempSync(join(tmpdir(), "obsydian-bundle-"));
    temps.push(dir);
    mkdirSync(join(dir, "node_modules", "obsidian"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "obsidian", "package.json"),
      JSON.stringify({ name: "obsidian", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(
      join(dir, "node_modules", "obsidian", "index.js"),
      `class Plugin { constructor() {} }
       class PluginSettingTab { constructor() {} }
       class Setting { constructor() {} }
       class Notice { constructor() {} }
       module.exports = {
         Plugin, PluginSettingTab, Setting, Notice,
         requestUrl: async () => ({ status: 200, text: "", arrayBuffer: new ArrayBuffer(0) }),
       };`,
    );
    copyFileSync(bundlePath, join(dir, "main.js"));

    const require = createRequire(join(dir, "main.js"));
    const loaded = require(join(dir, "main.js")) as Record<string, unknown>;

    // esbuild's CJS output puts a default export on `.default`.
    const PluginClass = (loaded.default ?? loaded) as new () => unknown;
    expect(typeof PluginClass).toBe("function");
    expect(typeof (PluginClass as { prototype: Record<string, unknown> }).prototype.onload).toBe(
      "function",
    );
    expect(typeof (PluginClass as { prototype: Record<string, unknown> }).prototype.onunload).toBe(
      "function",
    );
  });

  it("bundles no import of anything but obsidian", () => {
    // A stray `require("node:fs")` works on desktop and breaks on mobile — the
    // hardest kind of bug to find, because it only appears on the device you
    // can least easily debug.
    const source = readFileSync(bundlePath, "utf8");
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    expect([...new Set(requires)]).toEqual(["obsidian"]);
  });

  it("has a manifest Obsidian will accept, and is not desktop-only", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.id).toBe("obsydian-sync");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The whole point is mobile. A true here would silently hide the plugin.
    expect(manifest.isDesktopOnly).toBe(false);
  });
});
