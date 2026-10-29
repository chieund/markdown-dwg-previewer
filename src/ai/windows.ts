import * as fs from 'node:fs';
import * as path from 'node:path';

const FRESH_MS = 60_000;
const FUTURE_MS = 5_000;
const MAX_BYTES = 64 * 1024;
let counter = 0;

/** One JSON file per VS Code window: { folders, updated }. */
export class WindowRegistry {
  private readonly file: string;
  private readonly fileName: string;

  constructor(private readonly dir: string, id: string) {
    this.fileName = id.replace(/[^A-Za-z0-9_-]/g, '_') + '.json';
    this.file = path.join(dir, this.fileName);
  }

  async publish(folders: string[]): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${++counter}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ folders, updated: Date.now() }), { mode: 0o600 });
    await fs.promises.rename(tmp, this.file);
  }

  /** Union of the folders of every window that published within the last 60 s. */
  async folders(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const out = new Set<string>();
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const file = path.join(this.dir, name);
        if ((await fs.promises.stat(file)).size > MAX_BYTES) continue;
        const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (typeof data?.updated !== 'number' || now - data.updated > FRESH_MS || data.updated > now + FUTURE_MS) continue;
        if (!Array.isArray(data.folders)) continue;
        for (const f of data.folders) if (typeof f === 'string' && path.isAbsolute(f)) out.add(f);
      } catch {
        // corrupt or half-written file: ignore
      }
    }
    return [...out];
  }

  async dispose(): Promise<void> {
    await fs.promises.rm(this.file, { force: true });
  }
}
