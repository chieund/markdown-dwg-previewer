import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyMatches, nextHiddenLayers, regionViewBox, unknownLayers } from '../src/webview/agent';

const ALL = ['Walls', 'Doors', 'Piles', 'Text'];

test('show removes layers from the hidden set', () => {
  const next = nextHiddenLayers(ALL, new Set(['Walls', 'Doors']), { show: ['Doors'] });
  assert.deepEqual([...next], ['Walls']);
});

test('hide adds layers to the hidden set', () => {
  const next = nextHiddenLayers(ALL, new Set(), { hide: ['Text', 'Walls'] });
  assert.deepEqual([...next].sort(), ['Text', 'Walls']);
});

test('only hides every other layer, and wins over show and hide', () => {
  const next = nextHiddenLayers(ALL, new Set(), { only: ['Piles'], show: ['Walls'], hide: ['Piles'] });
  assert.deepEqual([...next].sort(), ['Doors', 'Text', 'Walls']);
});

test('unknown names change nothing and are reported', () => {
  const req = { show: ['Nope'], hide: ['Ghost', 'Text'] };
  assert.deepEqual([...nextHiddenLayers(ALL, new Set(), req)], ['Text']);
  assert.deepEqual(unknownLayers(ALL, req), ['Nope', 'Ghost']);
});

test('layer names are matched without regard to case or accents', () => {
  assert.deepEqual([...nextHiddenLayers(ALL, new Set(['Walls']), { show: ['WALLS'] })], []);
  assert.deepEqual([...nextHiddenLayers(ALL, new Set(), { hide: ['piles'] })], ['Piles']);
  assert.deepEqual([...nextHiddenLayers(ALL, new Set(), { only: ['PILES'] })].sort(), ['Doors', 'Text', 'Walls']);
  assert.deepEqual(unknownLayers(['Tường'], { hide: ['TUONG'] }), []);
});

test('only with no known layer would blank the page, so it is ignored', () => {
  const next = nextHiddenLayers(ALL, new Set(['Text']), { only: ['Nope'] });
  assert.deepEqual([...next], ['Text']);
  assert.deepEqual(unknownLayers(ALL, { only: ['Nope'] }), ['Nope']);
});

test('the input set is not mutated; no request keeps the layers', () => {
  const hidden = new Set(['Walls']);
  nextHiddenLayers(ALL, hidden, { hide: ['Text'] });
  assert.deepEqual([...hidden], ['Walls']);
  assert.deepEqual([...nextHiddenLayers(ALL, hidden, undefined)], ['Walls']);
});

test('regionViewBox flips y and adds no padding', () => {
  assert.deepEqual(regionViewBox({ minX: 10, minY: 20, maxX: 110, maxY: 70 }), { x: 10, y: -70, w: 100, h: 50 });
});

test('regionViewBox gives a degenerate region a unit size', () => {
  assert.deepEqual(regionViewBox({ minX: 5, minY: 5, maxX: 5, maxY: 5 }), { x: 5, y: -5, w: 1, h: 1 });
});

test('keyMatches needs a loaded drawing with the same path, mtime and size', () => {
  const key = { path: '/a.dwg', mtimeMs: 10, size: 99 };
  assert.equal(keyMatches(undefined, key), false);
  assert.equal(keyMatches({ ...key }, key), true);
  assert.equal(keyMatches({ ...key, mtimeMs: 11 }, key), false);
  assert.equal(keyMatches({ ...key, size: 100 }, key), false);
  assert.equal(keyMatches({ ...key, path: '/b.dwg' }, key), false);
});

import { parseAgentMessage, planShow, planSnapshot, CHANGED_MESSAGE, waitUntilDrawn } from '../src/webview/agent';

const KEY = { path: '/a.dwg', mtimeMs: 10, size: 99 };

test('parseAgentMessage ignores non-agent and id-less messages', () => {
  assert.equal(parseAgentMessage(null), null);
  assert.equal(parseAgentMessage('x'), null);
  assert.equal(parseAgentMessage({ type: 'DXF_DATA' }), null);
  assert.equal(parseAgentMessage({ type: 'AGENT_SHOW', key: KEY }), null);
  assert.equal(parseAgentMessage({ type: 'AGENT_SHOW', requestId: '', key: KEY }), null);
});

test('parseAgentMessage answers malformed messages with a reason', () => {
  const bad = (m: object) => {
    const parsed = parseAgentMessage({ requestId: 'r', ...m });
    assert.ok(parsed && 'invalid' in parsed, JSON.stringify(m));
    assert.equal(parsed.invalid.requestId, 'r');
    assert.ok(parsed.invalid.message.length > 0);
  };
  bad({ type: 'AGENT_SHOW' });
  bad({ type: 'AGENT_SHOW', key: { path: 1, mtimeMs: 1, size: 1 } });
  bad({ type: 'AGENT_SHOW', key: KEY, objects: 'x' });
  bad({ type: 'AGENT_SHOW', key: KEY, objects: [1, 'a'] });
  bad({ type: 'AGENT_SHOW', key: KEY, layers: 'x' });
  bad({ type: 'AGENT_SHOW', key: KEY, layers: { show: 'Walls' } });
  bad({ type: 'AGENT_SHOW', key: KEY, layers: { hide: [1] } });
  bad({ type: 'AGENT_SHOW', key: KEY, page: 'a' });
  bad({ type: 'AGENT_SNAPSHOT', key: KEY });
  bad({ type: 'AGENT_SNAPSHOT', key: KEY, page: 0, region: { minX: 0 } });
  bad({ type: 'AGENT_SNAPSHOT', key: KEY, page: 0, region: null, around: 'x' });
});

test('parseAgentMessage accepts well-formed requests', () => {
  const show = parseAgentMessage({ type: 'AGENT_SHOW', requestId: 'r', key: KEY, objects: [1], layers: { hide: ['A'] }, fit: true });
  assert.ok(show && 'request' in show && show.request.kind === 'show');
  const snap = parseAgentMessage({ type: 'AGENT_SNAPSHOT', requestId: 'r', key: KEY, page: 1, region: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
  assert.ok(snap && 'request' in snap && snap.request.kind === 'snapshot');
});

const state = { loaded: true, rendering: false, drawingKey: KEY };
const scene = {
  pageNames: ['Model', 'Sheet'],
  pageIndex: 0,
  layersOfPage: [['Walls', 'Doors'], ['Frame']],
  hidden: new Set<string>(),
  objectPages: [0, 0, 1, 0],
};

test('planShow refuses when not loaded, still drawing, or the key differs', () => {
  const p = (s: object, k = KEY) => planShow({ ...state, ...s }, scene, k, { fit: true });
  assert.deepEqual(p({ loaded: false }), { ok: false, message: 'The drawing is not loaded yet; try again in a moment.' });
  assert.deepEqual(p({ rendering: true }), { ok: false, message: 'The preview is still drawing; try again in a moment.' });
  assert.deepEqual(p({}, { ...KEY, size: 1 }), { ok: false, message: CHANGED_MESSAGE });
  assert.deepEqual(p({ drawingKey: undefined }), { ok: false, message: CHANGED_MESSAGE });
});

test('planShow highlights valid ids on the page and reports the rest', () => {
  const plan = planShow(state, scene, KEY, { objects: [0, 3, 2, 99, -1, 0] });
  assert.ok(plan.ok);
  assert.deepEqual(plan.highlight, [0, 3]);
  assert.match(plan.message, /Highlighted 2 objects on Model and zoomed to them\./);
  assert.match(plan.message, /Ignored 2 invalid object ids\./);
  assert.match(plan.message, /1 object not on this page was not highlighted\./);
});

test('planShow judges ids against the page it switches to', () => {
  const plan = planShow(state, scene, KEY, { page: 1, objects: [2, 0] });
  assert.ok(plan.ok);
  assert.equal(plan.page, 1);
  assert.deepEqual(plan.highlight, [2]);
  assert.match(plan.message, /on Sheet/);
});

test('planShow fails when nothing could be highlighted and nothing else was asked', () => {
  const plan = planShow(state, scene, KEY, { objects: [2] });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /No object to highlight/);
});

test('planShow rejects a page that does not exist', () => {
  const plan = planShow(state, scene, KEY, { page: 5 });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /no page 5/);
});

test('planShow reports unknown layers and yields the new hidden set', () => {
  const plan = planShow(state, scene, KEY, { layers: { hide: ['Walls', 'Ghost'] } });
  assert.ok(plan.ok);
  assert.deepEqual([...(plan.hiddenLayers ?? [])], ['Walls']);
  assert.match(plan.message, /Unknown layers ignored: Ghost\./);
  const none = planShow(state, scene, KEY, { layers: { only: ['Ghost'] } });
  assert.ok(none.ok);
  assert.match(none.message, /left as they were/);
});

test('planShow shows a hidden layer so the highlighted object is visible', () => {
  const withLayers = {
    ...scene,
    hidden: new Set(['Walls']),
    objectLayers: ['Walls', 'Doors', 'Frame', 'Text'],
  };
  const plan = planShow(state, withLayers, KEY, { objects: [0] });
  assert.ok(plan.ok);
  assert.deepEqual([...(plan.hiddenLayers ?? [])], []);
  assert.match(plan.message, /Also showed 1 layer \(Walls\)/);
});

test('planShow with only a page or fit asks for a fit', () => {
  const plan = planShow(state, scene, KEY, { page: 1 });
  assert.ok(plan.ok && plan.fit && plan.highlight === undefined);
  assert.match(plan.message, /Showing Sheet/);
});

test('planSnapshot refuses like planShow but may run while drawing', () => {
  const bounds = [{ minX: 0, minY: 0, maxX: 10, maxY: 10 }, null];
  const snap = { page: 0 };
  assert.equal(planSnapshot({ ...state, loaded: false }, { ...scene, pageBounds: bounds }, KEY, snap).ok, false);
  assert.deepEqual(planSnapshot(state, { ...scene, pageBounds: bounds }, { ...KEY, size: 2 }, snap), { ok: false, message: CHANGED_MESSAGE });
  const ok = planSnapshot({ ...state, rendering: true }, { ...scene, pageBounds: bounds }, KEY, snap);
  assert.ok(ok.ok);
  assert.deepEqual(ok.bounds, bounds[0]);
  assert.equal(planSnapshot(state, { ...scene, pageBounds: bounds }, KEY, { page: 1 }).ok, false);
  assert.equal(planSnapshot(state, { ...scene, pageBounds: bounds }, KEY, { page: 7 }).ok, false);
});

/** A fake preview: drawing until `finish()`, waking whoever waits. */
function drawingPreview(drawing = true) {
  let isDrawing = drawing;
  const waiters = new Set<() => void>();
  return {
    isDrawing: () => isDrawing,
    onDrawn: (cb: () => void) => { waiters.add(cb); return () => waiters.delete(cb); },
    finish: () => { isDrawing = false; for (const w of [...waiters]) w(); },
    waiting: () => waiters.size,
  };
}

test('waitUntilDrawn: at once when nothing is drawing', async () => {
  const p = drawingPreview(false);
  assert.equal(await waitUntilDrawn(p.isDrawing, p.onDrawn, 1000), true);
  assert.equal(p.waiting(), 0);
});

test('waitUntilDrawn: a show queued behind the batches proceeds when they finish', async () => {
  const p = drawingPreview();
  const waited = waitUntilDrawn(p.isDrawing, p.onDrawn, 1000);
  await new Promise((r) => setTimeout(r, 10));
  p.finish();
  assert.equal(await waited, true);
  assert.equal(p.waiting(), 0);
  // and the plan then succeeds where it would have been refused
  assert.equal(planShow({ ...state, rendering: p.isDrawing() }, scene, KEY, { fit: true }).ok, true);
});

test('waitUntilDrawn: gives up after the limit; planShow then refuses as still drawing', async () => {
  const p = drawingPreview();
  assert.equal(await waitUntilDrawn(p.isDrawing, p.onDrawn, 20), false);
  assert.equal(p.waiting(), 0);
  const plan = planShow({ ...state, rendering: p.isDrawing() }, scene, KEY, { fit: true });
  assert.deepEqual(plan, { ok: false, message: 'The preview is still drawing; try again in a moment.' });
});

test('waitUntilDrawn: a new drawing that starts its own batches keeps the show waiting', async () => {
  const p = drawingPreview();
  let again = true;
  const waited = waitUntilDrawn(() => p.isDrawing() || again, p.onDrawn, 1000);
  p.finish(); // first drawing done, but a reload is drawing again
  await new Promise((r) => setTimeout(r, 5));
  again = false;
  p.finish();
  assert.equal(await waited, true);
});
