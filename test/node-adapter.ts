/**
 * A `VaultAdapter` over the real filesystem.
 *
 * Lets the real client sync a real directory without Obsidian, which is what
 * makes the full-stack test possible. It mirrors what Obsidian's `DataAdapter`
 * does; where the two could differ (trashLocal, rename across directories) it
 * follows Obsidian's documented behaviour rather than the most convenient one.
 */
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { VaultAdapter } from "../src/adapter.ts";

export class NodeAdapter implements VaultAdapter {
  root: string;
  constructor(root: string) { this.root = root; }
  abs(p: string) { return join(this.root, p); }

  async read(p: string) { return fs.readFile(this.abs(p), "utf8"); }
  async write(p: string, d: string) {
    await fs.mkdir(dirname(this.abs(p)), { recursive: true });
    await fs.writeFile(this.abs(p), d);
  }
  async readBinary(p: string) {
    const b = await fs.readFile(this.abs(p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  async writeBinary(p: string, d: ArrayBuffer) {
    await fs.mkdir(dirname(this.abs(p)), { recursive: true });
    await fs.writeFile(this.abs(p), Buffer.from(d));
  }
  async exists(p: string) { try { await fs.stat(this.abs(p)); return true; } catch { return false; } }
  async list(p: string) {
    const dir = p === "" ? this.root : this.abs(p);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = []; const folders: string[] = [];
    for (const e of entries) {
      const rel = relative(this.root, join(dir, e.name)).split("\\").join("/");
      (e.isDirectory() ? folders : files).push(rel);
    }
    return { files, folders };
  }
  async stat(p: string) {
    try {
      const s = await fs.stat(this.abs(p));
      return { type: (s.isDirectory() ? "folder" : "file") as "file" | "folder", mtime: Math.floor(s.mtimeMs), size: s.size };
    } catch { return null; }
  }
  async mkdir(p: string) { await fs.mkdir(this.abs(p), { recursive: true }); }
  async remove(p: string) { await fs.rm(this.abs(p), { force: true }); }
  async trashLocal(p: string) {
    const dest = join(this.root, ".trash", p);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(this.abs(p), dest);
  }
  async rename(a: string, b: string) {
    await fs.mkdir(dirname(this.abs(b)), { recursive: true });
    await fs.rename(this.abs(a), this.abs(b));
  }
}
