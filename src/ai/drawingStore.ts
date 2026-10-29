import { LruCache } from '../dwg/cache';
import type { DrawingKey, ParsedDxf } from '../shared/types';
import type { DiskCache } from './diskCache';

export type { DrawingKey };

/** Bump whenever parser output changes, so stale disk caches are ignored. */
export const CACHE_FORMAT = 1;

export interface StoredDrawing {
  key: DrawingKey;
  parsed: ParsedDxf;
}

export type LoadStage = 'reading' | 'converting' | 'parsing';

export interface StoreDeps {
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  parse(path: string, progress: (s: LoadStage) => void): Promise<ParsedDxf>;
  disk?: DiskCache;
  /** In-memory entries. */
  capacity: number;
}

export function sameKey(a: DrawingKey, b: DrawingKey): boolean {
  return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

interface Entry extends StoredDrawing {
  /** The disk cache this entry is already in (or was read from), so a persisting get need not write it. */
  onDisk?: DiskCache;
}

interface Pending {
  result: Promise<Entry>;
  listeners: Set<(s: LoadStage) => void>;
}

/**
 * Parsed drawings shared by the preview and the AI side: parse once, answer
 * later questions from memory (and, for the AI side, from disk), parse again
 * only when the file's mtime or size changes.
 */
export class DrawingStore {
  private readonly memory: LruCache<string, Entry>;
  private readonly inFlight = new Map<string, Pending>();

  private disk: DiskCache | undefined;

  constructor(private readonly deps: StoreDeps) {
    this.memory = new LruCache(deps.capacity);
    this.disk = deps.disk;
  }

  /** Attach or detach the disk cache; persisting reads and writes happen only while one is attached. */
  setDisk(disk: DiskCache | undefined): void {
    this.disk = disk;
  }

  async get(
    path: string,
    opts: { progress?: (s: LoadStage) => void; persist?: boolean } = {}
  ): Promise<StoredDrawing> {
    const disk = opts.persist ? this.disk : undefined;
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await this.deps.stat(path);
    } catch (err) {
      throw new Error(`Cannot read drawing ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const key: DrawingKey = { path, mtimeMs: stat.mtimeMs, size: stat.size };

    const cached = this.memory.get(path);
    if (cached && sameKey(cached.key, key)) {
      if (disk && cached.onDisk !== disk && this.disk === disk) {
        await disk.write(key, cached.parsed).catch(() => {});
        cached.onDisk = disk;
      }
      return { key: cached.key, parsed: cached.parsed };
    }

    const flightId = `${path}\0${key.mtimeMs}\0${key.size}\0${disk ? 1 : 0}`;
    let pending = this.inFlight.get(flightId);
    const progress = opts.progress;
    if (pending) {
      if (progress) pending.listeners.add(progress);
    } else {
      const listeners = new Set<(s: LoadStage) => void>();
      if (progress) listeners.add(progress);
      const result = this.load(key, disk, (s) => listeners.forEach((l) => l(s)));
      result.then(
        () => this.inFlight.delete(flightId),
        () => this.inFlight.delete(flightId)
      );
      pending = { result, listeners };
      this.inFlight.set(flightId, pending);
    }
    try {
      const entry = await pending.result;
      return { key: entry.key, parsed: entry.parsed };
    } finally {
      if (progress) pending.listeners.delete(progress);
    }
  }

  forget(path: string): void {
    this.memory.delete(path);
  }

  private async load(
    key: DrawingKey,
    disk: DiskCache | undefined,
    progress: (s: LoadStage) => void
  ): Promise<Entry> {
    let entry: Entry | undefined;
    const fromDisk = disk ? await disk.read(key).catch(() => undefined) : undefined;
    if (fromDisk) {
      entry = { key, parsed: fromDisk, onDisk: disk };
    } else {
      const parsed = await this.deps.parse(key.path, progress);
      entry = { key, parsed };
    }
    // The file may have been saved while we parsed; then the result is for an older version.
    let after: { mtimeMs: number; size: number } | undefined;
    try {
      after = await this.deps.stat(key.path);
    } catch {
      after = undefined;
    }
    if (after && after.mtimeMs === key.mtimeMs && after.size === key.size) {
      // Not if the cache was detached (AI turned off) or replaced while this parse ran.
      if (disk && entry.onDisk !== disk && this.disk === disk) {
        await disk.write(key, entry.parsed).catch(() => {});
        entry.onDisk = disk;
      }
      this.memory.set(key.path, entry);
    }
    return entry;
  }
}
