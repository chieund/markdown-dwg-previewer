import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DrawingStore, type LoadStage } from '../src/ai/drawingStore';
import { DiskCache, clearDrawingCache } from '../src/ai/diskCache';
import type { ParsedDxf } from '../src/shared/types';

const fakeParsed = (tag: string) => ({ tag }) as unknown as ParsedDxf;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-store-'));

function setup(opts: { disk?: DiskCache; statFn?: () => { mtimeMs: number; size: number } } = {}) {
  const state = { mtimeMs: 1, size: 10, parses: 0 };
  const store = new DrawingStore({
    stat: async () => (opts.statFn ? opts.statFn() : { mtimeMs: state.mtimeMs, size: state.size }),
    parse: async (_p, progress) => {
      state.parses++;
      progress('reading');
      await new Promise((r) => setImmediate(r));
      progress('parsing');
      return fakeParsed('v' + state.parses);
    },
    disk: opts.disk,
    capacity: 4,
  });
  return { state, store };
}

test('a second question on an unchanged file does not parse again', async () => {
  const { state, store } = setup();
  await store.get('/a.dxf');
  await store.get('/a.dxf');
  assert.equal(state.parses, 1);
});

test('a changed mtime or size parses again', async () => {
  const { state, store } = setup();
  await store.get('/a.dxf');
  state.mtimeMs = 2;
  await store.get('/a.dxf');
  state.size = 11;
  await store.get('/a.dxf');
  assert.equal(state.parses, 3);
});

test('persisted drawings load from disk in a new store without parsing', async () => {
  const dir = tmp();
  const a = setup({ disk: new DiskCache(dir) });
  await a.store.get('/a.dxf', { persist: true });
  const b = setup({ disk: new DiskCache(dir) });
  const got = await b.store.get('/a.dxf', { persist: true });
  assert.equal(b.state.parses, 0);
  assert.deepEqual(got.parsed, fakeParsed('v1'));
});

test('the preview path never touches the disk', async () => {
  const dir = tmp();
  const { store } = setup({ disk: new DiskCache(dir) });
  await store.get('/a.dxf');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a cache file from another CACHE_FORMAT or a corrupt file is ignored and removed', async () => {
  const dir = tmp();
  const disk = new DiskCache(dir);
  const a = setup({ disk });
  await a.store.get('/a.dxf', { persist: true });
  const [file] = fs.readdirSync(dir);
  fs.writeFileSync(path.join(dir, file), 'garbage');
  const b = setup({ disk });
  await b.store.get('/a.dxf', { persist: true });
  assert.equal(b.state.parses, 1);
  assert.deepEqual(fs.readdirSync(dir), [file]);
  assert.notEqual(fs.readFileSync(path.join(dir, file)).toString(), 'garbage');
  // a valid gzip with another format number
  const zlib = await import('node:zlib');
  const key = { path: '/a.dxf', mtimeMs: 1, size: 10 };
  fs.writeFileSync(
    path.join(dir, file),
    zlib.gzipSync(JSON.stringify({ format: 999, key, parsed: fakeParsed('old') }))
  );
  assert.equal(await disk.read(key), undefined);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a file changed during parsing is not cached', async () => {
  // Stats: before=1, after=2 (changed mid-parse), then back to 1. A wrongly cached entry under mtime 1 would be served.
  const seq = [1, 2, 1, 1];
  let calls = 0;
  const { state, store } = setup({ statFn: () => ({ mtimeMs: seq[Math.min(calls++, seq.length - 1)], size: 10 }) });
  await store.get('/a.dxf');
  await store.get('/a.dxf');
  assert.equal(state.parses, 2);
});

test('a file changed during parsing is not written to disk either', async () => {
  const dir = tmp();
  const seq = [1, 2];
  let calls = 0;
  const { store } = setup({
    disk: new DiskCache(dir),
    statFn: () => ({ mtimeMs: seq[Math.min(calls++, seq.length - 1)], size: 10 }),
  });
  await store.get('/a.dxf', { persist: true });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the byte limit keeps the newest files within budget, and always the newest', async () => {
  const writeAll = async (dir: string, bytes: number) => {
    const disk = new DiskCache(dir, { entries: Infinity, bytes });
    const base = Date.now() - 100_000;
    const stamped = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await disk.write({ path: `/f${i}.dxf`, mtimeMs: 1, size: 1 }, fakeParsed('same-length-' + i));
      for (const f of fs.readdirSync(dir)) {
        if (!stamped.has(f)) {
          const t = new Date(base + i * 1000);
          fs.utimesSync(path.join(dir, f), t, t);
          stamped.add(f);
        }
      }
    }
    return disk;
  };
  const probe = tmp();
  await writeAll(probe, Infinity);
  const one = fs.statSync(path.join(probe, fs.readdirSync(probe)[0])).size;

  const two = tmp();
  const diskTwo = await writeAll(two, Math.floor(one * 2.5));
  assert.equal(fs.readdirSync(two).length, 2);
  assert.ok(await diskTwo.read({ path: '/f3.dxf', mtimeMs: 1, size: 1 }));
  assert.ok(await diskTwo.read({ path: '/f2.dxf', mtimeMs: 1, size: 1 }));

  const tiny = tmp();
  const diskTiny = await writeAll(tiny, 1);
  assert.equal(fs.readdirSync(tiny).length, 1);
  assert.ok(await diskTiny.read({ path: '/f3.dxf', mtimeMs: 1, size: 1 }));
});

test('eviction keeps the newest 30 files', async () => {
  const dir = tmp();
  const disk = new DiskCache(dir, { entries: 3, bytes: Infinity });
  const stamped = new Set<string>();
  const base = Date.now() - 100_000;
  for (let i = 0; i < 5; i++) {
    // A fresh file has the real "now" mtime, newer than every stamped one, so it is always the newest.
    await disk.write({ path: `/f${i}.dxf`, mtimeMs: 1, size: 1 }, fakeParsed('x' + i));
    const t = new Date(base + i * 1000);
    for (const f of fs.readdirSync(dir)) {
      if (!stamped.has(f)) {
        fs.utimesSync(path.join(dir, f), t, t);
        stamped.add(f);
      }
    }
  }
  assert.equal(fs.readdirSync(dir).length, 3);
  assert.ok(await disk.read({ path: '/f4.dxf', mtimeMs: 1, size: 1 }));
  assert.equal(await disk.read({ path: '/f0.dxf', mtimeMs: 1, size: 1 }), undefined);
  assert.equal(await disk.clear(), 3);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('concurrent gets share one parse and both see progress', async () => {
  const { state, store } = setup();
  const seenA: LoadStage[] = [];
  const seenB: LoadStage[] = [];
  const [a, b] = await Promise.all([
    store.get('/a.dxf', { progress: (s) => seenA.push(s) }),
    store.get('/a.dxf', { progress: (s) => seenB.push(s) }),
  ]);
  assert.equal(state.parses, 1);
  assert.equal(a.parsed, b.parsed);
  assert.ok(seenA.includes('parsing'));
  assert.ok(seenB.includes('parsing'));
});

test('a deleted drawing gives a clear error', async () => {
  const store = new DrawingStore({
    stat: async () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    },
    parse: async () => fakeParsed('x'),
    capacity: 4,
  });
  await assert.rejects(store.get('/gone/a.dxf'), /\/gone\/a\.dxf/);
});

test('setDisk attaches and detaches the disk cache on a live store', async () => {
  const dir = tmp();
  const disk = new DiskCache(dir);
  const { state, store } = setup();
  await store.get('/a.dxf', { persist: true });
  assert.deepEqual(fs.readdirSync(dir), []);

  store.setDisk(disk);
  await store.get('/a.dxf', { persist: true }); // already in memory, now written
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(state.parses, 1);

  assert.equal(await disk.clear(), 1);
  store.setDisk(undefined);
  await store.get('/b.dxf', { persist: true });
  assert.deepEqual(fs.readdirSync(dir), []);

  store.setDisk(new DiskCache(dir)); // enabling again builds a new cache
  await store.get('/a.dxf', { persist: true }); // memory entry was written to the old cache, since cleared
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('a parse that finishes after the disk cache was detached writes nothing to disk', async () => {
  const dir = tmp();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const store = new DrawingStore({
    stat: async () => ({ mtimeMs: 1, size: 10 }),
    parse: async () => { await gate; return fakeParsed('late'); },
    capacity: 2,
    disk: new DiskCache(dir),
  });
  const pending = store.get('/a.dxf', { persist: true });
  await new Promise((r) => setImmediate(r));
  store.setDisk(undefined); // AI turned off while the parse runs
  release();
  await pending;
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('clearDrawingCache removes the whole folder and counts the drawings, with or without a live cache', async () => {
  const root = tmp();
  const dir = path.join(root, 'drawing-cache');
  const disk = new DiskCache(dir);
  await disk.write({ path: '/a.dxf', mtimeMs: 1, size: 1 }, fakeParsed('a'));
  await disk.write({ path: '/b.dxf', mtimeMs: 1, size: 1 }, fakeParsed('b'));
  fs.writeFileSync(path.join(dir, 'x.json.gz.1.2.tmp'), 'partial');
  assert.equal(await clearDrawingCache(dir), 2);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await clearDrawingCache(dir), 0); // nothing there: no error
});
