import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { DrawingKey, ParsedDxf } from '../shared/types';
import { CACHE_FORMAT, sameKey } from './drawingStore';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** Parsed drawings on disk, one gzipped JSON file per drawing path, for the AI side only. */
export class DiskCache {
  private tmpCounter = 0;

  constructor(
    private readonly dir: string,
    private readonly limits: { entries: number; bytes: number } = { entries: 30, bytes: 500 * 1024 * 1024 }
  ) {}

  private fileFor(key: DrawingKey): string {
    return path.join(this.dir, createHash('sha256').update(key.path).digest('hex') + '.json.gz');
  }

  async read(key: DrawingKey): Promise<ParsedDxf | undefined> {
    const file = this.fileFor(key);
    let raw: Buffer;
    try {
      raw = await fs.readFile(file);
    } catch {
      return undefined;
    }
    try {
      const body = JSON.parse((await gunzip(raw)).toString('utf-8'));
      if (body?.format !== CACHE_FORMAT || !body.key || !body.parsed) throw new Error('format');
      if (!sameKey(body.key, key)) return undefined; // another version of this drawing; the next write replaces it
      return body.parsed as ParsedDxf;
    } catch {
      await fs.rm(file, { force: true });
      return undefined;
    }
  }

  async write(key: DrawingKey, parsed: ParsedDxf): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileFor(key);
    const tmp = `${file}.${process.pid}.${this.tmpCounter++}.tmp`;
    const data = await gzip(Buffer.from(JSON.stringify({ format: CACHE_FORMAT, key, parsed }), 'utf-8'));
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await this.evict();
  }

  async clear(): Promise<number> {
    let removed = 0;
    for (const f of await this.files()) {
      await fs.rm(path.join(this.dir, f.name), { force: true });
      removed++;
    }
    return removed;
  }

  private async files(): Promise<{ name: string; mtimeMs: number; size: number }[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: { name: string; mtimeMs: number; size: number }[] = [];
    for (const name of names) {
      if (!name.endsWith('.json.gz')) continue;
      try {
        const s = await fs.stat(path.join(this.dir, name));
        out.push({ name, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // removed meanwhile
      }
    }
    return out;
  }

  /** Drop the oldest files (by mtime) until within both limits. */
  private async evict(): Promise<void> {
    const files = (await this.files()).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    for (let i = 0; i < files.length; i++) {
      bytes += files[i].size;
      if (i >= this.limits.entries || (bytes > this.limits.bytes && i > 0)) {
        await fs.rm(path.join(this.dir, files[i].name), { force: true });
      }
    }
  }
}

/**
 * Deletes the drawing cache folder, whether or not the AI side is on (a cache left from when it was
 * on must still be removable). Returns how many cached drawings it held.
 */
export async function clearDrawingCache(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return names.filter((n) => n.endsWith('.json.gz')).length;
}
