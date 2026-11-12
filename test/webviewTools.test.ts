import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastOnCanvas, legibleColor } from '../src/webview/contrast';
import { rulerBetween, snapPoint } from '../src/webview/measureTool';
import type { DxfEntity } from '../src/shared/types';

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

test('colours that already stand out on the canvas are left alone', () => {
  for (const c of ['#ffffff', '#ff0000', '#ffcc00', '#808080', '#00ff00']) assert.equal(legibleColor(c), c);
});

test('dark colours are lightened until they can be seen, keeping their hue', () => {
  for (const c of ['#800000', '#000080', '#0000ff', '#000000', '#1e1e1e', '#404040']) {
    const out = legibleColor(c);
    assert.notEqual(out, c);
    assert.ok(contrastOnCanvas(rgb(out)) >= 3, `${c} → ${out}`);
  }
  const [r, g, b] = rgb(legibleColor('#800000'));
  assert.ok(r > g && g === b, 'dark red stays red');
  const [r2, , b2] = rgb(legibleColor('#000080'));
  assert.ok(b2 > r2, 'navy stays blue');
});

test('short hex is understood and anything else passes through', () => {
  assert.equal(legibleColor('#fff'), '#fff');
  assert.ok(contrastOnCanvas(rgb(legibleColor('#008'))) >= 3);
  assert.equal(legibleColor('red'), 'red');
  assert.equal(legibleColor(''), '');
});

const base = { color: '#fff' };
const ENTITIES: DxfEntity[] = [
  { ...base, layer: 'WALL', type: 'LINE', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
  { ...base, layer: 'COL', type: 'CIRCLE', center: { x: 50, y: 50 }, radius: 5 },
  { ...base, layer: 'HIDDEN', type: 'POINT', position: { x: 3, y: 3 } },
];

test('a click near a corner locks onto it', () => {
  assert.deepEqual(snapPoint(ENTITIES, new Set(), { x: 98, y: 1.5 }, 5), { point: { x: 100, y: 0 }, snapped: true });
  assert.deepEqual(snapPoint(ENTITIES, new Set(), { x: 51, y: 49 }, 5).point, { x: 50, y: 50 });
});

test('a click away from every corner stays where it is', () => {
  assert.deepEqual(snapPoint(ENTITIES, new Set(), { x: 50, y: 1 }, 5), { point: { x: 50, y: 1 }, snapped: false });
});

test('the nearest corner wins, and hidden layers do not attract', () => {
  assert.deepEqual(snapPoint(ENTITIES, new Set(), { x: 2, y: 2 }, 5).point, { x: 3, y: 3 });
  assert.deepEqual(snapPoint(ENTITIES, new Set(['HIDDEN']), { x: 2, y: 2 }, 5).point, { x: 0, y: 0 });
});

test('a ruler gives the distance and its two legs', () => {
  assert.deepEqual(rulerBetween({ x: 0, y: 0 }, { x: -3, y: 4 }), { distance: 5, dx: 3, dy: 4 });
});
