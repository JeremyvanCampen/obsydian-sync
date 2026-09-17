/**
 * Keeps manifest.json and versions.json in step with package.json.
 *
 * Run automatically by `npm version` via the "version" lifecycle script. Without
 * it `npm version patch` bumps package.json alone, the release workflow's
 * tag/manifest check fails, no release is published, and BRAT users see nothing
 * — which looks like the release simply not happening.
 */

import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;
if (!version) {
  console.error("npm_package_version is not set; run this through `npm version`");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

// versions.json maps each plugin version to the minimum Obsidian version it
// needs. Obsidian uses it to offer the newest release a given install can run.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`manifest.json and versions.json set to ${version} (minAppVersion ${manifest.minAppVersion})`);
