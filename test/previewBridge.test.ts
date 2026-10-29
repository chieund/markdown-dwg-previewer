import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewBridge, type PanelLike } from '../src/ai/previewBridge';
import { SHOW_DRAWN_WAIT_MS, type DrawingKey } from '../src/shared/types';
import type { StoredDrawing } from '../src/ai/drawingStore';

const KEY: DrawingKey = { path: '/d/a.dwg', mtimeMs: 1, size: 2 };

function fakePanel(active = true) {
  const posted: any[] = [];
  const revealed = { n: 0 };
  const panel: PanelLike = {
    active,
    visible: active,
    postMessage: async (m) => {
      posted.push(m);
      return true;
    },
    reveal() {
      revealed.n++;
    },
  };
  return { panel, posted, revealed };
}

const tick = () => new Promise((r) => setImmediate(r));

function bridge(extra: Partial<ConstructorParameters<typeof PreviewBridge>[0]> = {}) {
  return new PreviewBridge({ open: async () => {}, load: async () => { throw new Error('no load'); }, ...extra });
}

test('routes each result to its request by requestId', async () => {
  const b = bridge();
  const { panel, posted } = fakePanel();
  const reg = b.register('/d/a.dwg', panel, () => KEY);
  reg.loaded();
  const p1 = b.show('/d/a.dwg', KEY, { fit: true });
  const p2 = b.show('/d/a.dwg', KEY, { objects: [1] });
  await tick();
  assert.equal(posted.length, 2);
  assert.equal(posted[0].type, 'AGENT_SHOW');
  b.receive({ type: 'AGENT_RESULT', requestId: posted[1].requestId, ok: true, message: 'two' });
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: 'one' });
  assert.equal(await p1, 'one');
  assert.equal(await p2, 'two');
});

test('ok:false rejects with the webview message; snapshot resolves to the png', async () => {
  const b = bridge();
  const { panel, posted } = fakePanel();
  b.register('/d/a.dwg', panel, () => KEY).loaded();
  const p = b.show('/d/a.dwg', KEY, {});
  await tick();
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: false, message: 'still drawing' });
  await assert.rejects(p, /still drawing/);
  const s = b.snapshot('/d/a.dwg', KEY, { page: 0, region: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
  await tick();
  assert.equal(posted[1].type, 'AGENT_SNAPSHOT');
  b.receive({ type: 'AGENT_RESULT', requestId: posted[1].requestId, ok: true, message: 'm', png: 'QUJD' });
  assert.equal(await s, 'QUJD');
  const s2 = b.snapshot('/d/a.dwg', KEY, { page: 0 });
  await tick();
  b.receive({ type: 'AGENT_RESULT', requestId: posted[2].requestId, ok: true, message: 'm' });
  await assert.rejects(s2, /no image/i);
});

test('unknown and repeated results are ignored', () => {
  const b = bridge();
  b.receive({ type: 'AGENT_RESULT', requestId: 'nope', ok: true, message: '' });
});

test('times out when the webview never answers, and cleans up', async () => {
  const b = bridge({ resultTimeoutMs: 20, showTimeoutMs: 20 });
  const { panel, posted } = fakePanel();
  b.register('/d/a.dwg', panel, () => KEY).loaded();
  await assert.rejects(b.show('/d/a.dwg', KEY, {}), /did not answer/);
  // a late answer is harmless
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: 'late' });
});

test('a panel showing another version rejects with the drawing-changed message', async () => {
  const b = bridge();
  const { panel, posted } = fakePanel();
  b.register('/d/a.dwg', panel, () => ({ ...KEY, mtimeMs: 99 })).loaded();
  await assert.rejects(b.show('/d/a.dwg', KEY, {}), /The drawing changed since it was read; read it again\./);
  assert.equal(posted.length, 0);
});

test('no panel: opens one, waits for it to register and load', async () => {
  const opened: string[] = [];
  const { panel, posted } = fakePanel();
  let reg: ReturnType<PreviewBridge['register']> | undefined;
  const b = bridge({
    open: async (p) => {
      opened.push(p);
      setTimeout(() => {
        reg = b.register(p, panel, () => KEY);
        setTimeout(() => reg!.loaded(), 5);
      }, 5);
    },
  });
  const p = b.show('/d/a.dwg', KEY, {});
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(opened, ['/d/a.dwg']);
  assert.equal(posted.length, 1);
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: 'ok' });
  assert.equal(await p, 'ok');
});

test('open wait times out when no panel ever loads', async () => {
  const b = bridge({ openTimeoutMs: 20 });
  await assert.rejects(b.show('/d/a.dwg', KEY, {}), /did not open/);
});

test('prefers the active panel, else the most recent', async () => {
  const b = bridge();
  const a = fakePanel(false), c = fakePanel(true), d = fakePanel(false);
  for (const x of [a, c, d]) b.register('/d/a.dwg', x.panel, () => KEY).loaded();
  const p = b.show('/d/a.dwg', KEY, {});
  await tick();
  assert.equal(c.posted.length, 1);
  b.receive({ type: 'AGENT_RESULT', requestId: c.posted[0].requestId, ok: true, message: 'x' });
  await p;
  c.panel.active = false;
  c.panel.visible = false;
  const q = b.show('/d/a.dwg', KEY, {});
  await tick();
  assert.equal(d.posted.length, 1);
  b.receive({ type: 'AGENT_RESULT', requestId: d.posted[0].requestId, ok: true, message: 'x' });
  await q;
  assert.deepEqual(b.openPaths(), ['/d/a.dwg']);
});

test('disposing a panel rejects its pending requests and unregisters it', async () => {
  const b = bridge();
  const { panel } = fakePanel();
  const reg = b.register('/d/a.dwg', panel, () => KEY);
  reg.loaded();
  const p = b.show('/d/a.dwg', KEY, {});
  await tick();
  reg.dispose();
  await assert.rejects(p, /closed/);
  assert.deepEqual(b.openPaths(), []);
});

function stored(bounds: Record<number, any>): StoredDrawing {
  return { key: KEY, parsed: { pages: [], objects: [], __b: bounds } as any };
}

test('snapshot around an object becomes a region (default margin 1.5x largest side)', async () => {
  const b = bridge({
    load: async () => stored({}),
    boundsOf: () => ({ minX: 10, minY: 20, maxX: 14, maxY: 22 }),
  });
  const { panel, posted } = fakePanel();
  b.register('/d/a.dwg', panel, () => KEY).loaded();
  const p = b.snapshot('/d/a.dwg', KEY, { page: 0, around: 5 });
  await tick(); await tick();
  assert.deepEqual(posted[0].region, { minX: 4, minY: 14, maxX: 20, maxY: 28 });
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: '', png: 'x' });
  await p;
  const q = b.snapshot('/d/a.dwg', KEY, { page: 0, around: 5, margin: 1 });
  await tick(); await tick();
  assert.deepEqual(posted[1].region, { minX: 9, minY: 19, maxX: 15, maxY: 23 });
  b.receive({ type: 'AGENT_RESULT', requestId: posted[1].requestId, ok: true, message: '', png: 'x' });
  await q;
});

test('rejects a reversed region and an around object without geometry', async () => {
  const b = bridge({ load: async () => stored({}), boundsOf: () => undefined });
  const { panel } = fakePanel();
  b.register('/d/a.dwg', panel, () => KEY).loaded();
  await assert.rejects(b.snapshot('/d/a.dwg', KEY, { page: 0, region: { minX: 5, minY: 0, maxX: 1, maxY: 1 } }), /minX/);
  await assert.rejects(b.snapshot('/d/a.dwg', KEY, { page: 0, around: 3 }), /no geometry/);
});

test('a failed first load rejects the open-waiter at once with the load error', async () => {
  const { panel } = fakePanel();
  let reg: ReturnType<PreviewBridge['register']> | undefined;
  const b = bridge({
    open: async (p) => {
      setTimeout(() => {
        reg = b.register(p, panel, () => undefined);
        setTimeout(() => reg!.failed('Cannot read drawing'), 5);
      }, 5);
    },
  });
  const t = Date.now();
  await assert.rejects(b.show('/d/a.dwg', KEY, {}), /Cannot read drawing/);
  assert.ok(Date.now() - t < 1000);
});

test('a failed reload gives requests the error until a load succeeds', async () => {
  const b = bridge();
  const { panel, posted } = fakePanel();
  const reg = b.register('/d/a.dwg', panel, () => KEY);
  reg.loaded();
  reg.failed('parse broke');
  await assert.rejects(b.show('/d/a.dwg', KEY, {}), /parse broke/);
  reg.loaded();
  const p = b.show('/d/a.dwg', KEY, {});
  await tick();
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: 'fine' });
  assert.equal(await p, 'fine');
});

test('disposing while waiting for the panel to load rejects promptly', async () => {
  const { panel } = fakePanel();
  let reg: ReturnType<PreviewBridge['register']> | undefined;
  const b = bridge({ open: async (p) => { reg = b.register(p, panel, () => KEY); } });
  const p = b.show('/d/a.dwg', KEY, {});
  await tick(); await tick();
  reg!.dispose();
  await assert.rejects(p, /closed/);
});

test('a late result after the timeout does not change the outcome', async () => {
  const b = bridge({ resultTimeoutMs: 10, showTimeoutMs: 10 });
  const { panel, posted } = fakePanel();
  b.register('/d/a.dwg', panel, () => KEY).loaded();
  const p = b.show('/d/a.dwg', KEY, {});
  await assert.rejects(p, /did not answer/);
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: 'late' });
  await assert.rejects(p, /did not answer/);
});

test('panel choice: active, else visible, else most recent; show reveals, snapshot does not', async () => {
  const b = bridge();
  const a = fakePanel(false), c = fakePanel(false), d = fakePanel(false);
  c.panel.visible = true;
  for (const x of [a, c, d]) b.register('/d/a.dwg', x.panel, () => KEY).loaded();
  const p = b.show('/d/a.dwg', KEY, {});
  await tick();
  assert.equal(c.posted.length, 1);
  assert.equal(c.revealed.n, 1);
  b.receive({ type: 'AGENT_RESULT', requestId: c.posted[0].requestId, ok: true, message: 'x' });
  await p;
  const s = b.snapshot('/d/a.dwg', KEY, { page: 0 });
  await tick();
  assert.equal(c.revealed.n, 1);
  b.receive({ type: 'AGENT_RESULT', requestId: c.posted[1].requestId, ok: true, message: 'x', png: 'p' });
  await s;
});

test('a drawing opened through a symlink matches the tools real-path key', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DrawingStore } = await import('../src/ai/drawingStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwgbridge-'));
  try {
    const file = path.join(dir, 'a.dxf');
    fs.writeFileSync(file, 'x');
    const link = path.join(dir, 'link.dxf');
    fs.symlinkSync(file, link);
    const real = fs.realpathSync.native(link);
    const store = new DrawingStore({
      stat: async (p) => ({ mtimeMs: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }),
      parse: async () => ({ pages: [], objects: [] }) as any,
      capacity: 2,
    });
    // The tools key by the real path; the provider must load by the same one.
    const toolKey = (await store.get(real)).key;
    const panelKey = (await store.get(fs.realpathSync.native(link))).key;
    const b = bridge();
    const { panel, posted } = fakePanel();
    b.register(real, panel, () => panelKey).loaded();
    const p = b.show(real, toolKey, {});
    await tick();
    b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: 'ok' });
    assert.equal(await p, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('show allows for the preview finishing its drawing first; snapshot does not wait', async () => {
  const b = bridge({ resultTimeoutMs: 20, showTimeoutMs: 300 });
  const { panel, posted } = fakePanel();
  b.register('/d/a.dwg', panel, () => KEY).loaded();
  const show = b.show('/d/a.dwg', KEY, { fit: true });
  const snap = b.snapshot('/d/a.dwg', KEY, { page: 0 });
  const snapRejected = assert.rejects(snap, /did not answer/);
  await new Promise((r) => setTimeout(r, 60)); // longer than the result timeout
  b.receive({ type: 'AGENT_RESULT', requestId: posted[0].requestId, ok: true, message: 'shown after drawing' });
  assert.equal(await show, 'shown after drawing');
  await snapRejected;
});

test('by default show waits the drawing wait (20 s) on top of the result timeout', () => {
  assert.equal(SHOW_DRAWN_WAIT_MS, 20_000);
});
