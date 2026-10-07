import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickObject } from '../src/webview/pick';
import type { DxfEntity, DxfPage } from '../src/shared/types';

const base = { layer: '0', color: '#fff' };
const page = (entities: DxfEntity[], viewports: DxfPage['viewports'] = []): DxfPage => ({
  name: 'P', entities, bounds: null, layers: [], viewports,
});
const none = new Set<string>();

test('a click within tolerance of a line picks it', () => {
  const p = page([{ ...base, type: 'LINE', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, obj: 4 }]);
  assert.equal(pickObject(p, { x: 5, y: 0.4 }, 0.5, none), 4);
  assert.equal(pickObject(p, { x: 5, y: 0.6 }, 0.5, none), undefined);
  // Past the end of the segment does not count
  assert.equal(pickObject(p, { x: 10.8, y: 0 }, 0.5, none), undefined);
});

test('the nearest object wins', () => {
  const p = page([
    { ...base, type: 'LINE', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, obj: 1 },
    { ...base, type: 'LINE', start: { x: 0, y: 1 }, end: { x: 10, y: 1 }, obj: 2 },
  ]);
  assert.equal(pickObject(p, { x: 5, y: 0.7 }, 1, none), 2);
});

test('circles, arcs and polylines are picked on their outline', () => {
  const p = page([
    { ...base, type: 'CIRCLE', center: { x: 0, y: 0 }, radius: 5, obj: 1 },
    { ...base, type: 'ARC', center: { x: 20, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2, obj: 2 },
    { ...base, type: 'POLYLINE', points: [{ x: 40, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 }], closed: false, obj: 3 },
  ]);
  assert.equal(pickObject(p, { x: 5.2, y: 0 }, 0.5, none), 1);
  assert.equal(pickObject(p, { x: 0, y: 0 }, 0.5, none), undefined, 'the middle of an empty circle is empty');
  assert.equal(pickObject(p, { x: 20, y: 5.1 }, 0.5, none), 2);
  assert.equal(pickObject(p, { x: 15, y: 0 }, 0.5, none), undefined, 'outside the arc sweep');
  assert.equal(pickObject(p, { x: 50.3, y: 5 }, 0.5, none), 3);
});

test('filled shapes, hatches and text are picked anywhere inside', () => {
  const p = page([
    { ...base, type: 'POLYLINE', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, filled: true, obj: 1 },
    { ...base, type: 'HATCH', loops: [[{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }]], solid: true, patternAngle: 0, patternSpacing: 1, obj: 2 },
    { ...base, type: 'TEXT', position: { x: 40, y: 0 }, text: 'ROOM', height: 2, rotation: 0, obj: 3 },
  ]);
  assert.equal(pickObject(p, { x: 8, y: 2 }, 0.1, none), 1);
  assert.equal(pickObject(p, { x: 25, y: 5 }, 0.1, none), 2);
  assert.equal(pickObject(p, { x: 42, y: 1 }, 0.1, none), 3);
});

test('hidden layers cannot be picked', () => {
  const p = page([{ ...base, layer: 'OFF', type: 'LINE', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, obj: 1 }]);
  assert.equal(pickObject(p, { x: 5, y: 0 }, 0.5, new Set(['OFF'])), undefined);
});

test('viewport content is picked only inside its window', () => {
  const line: DxfEntity = { ...base, type: 'LINE', start: { x: 0, y: 5 }, end: { x: 100, y: 5 }, obj: 7 };
  const p = page([], [{ rect: { x: 0, y: 0, width: 20, height: 10 }, entities: [line] }]);
  assert.equal(pickObject(p, { x: 10, y: 5 }, 0.5, none), 7);
  assert.equal(pickObject(p, { x: 50, y: 5 }, 0.5, none), undefined, 'clipped away by the viewport');
});

test('a line wins over the inside of a text box or fill it crosses', () => {
  const p = page([
    { ...base, type: 'LINE', start: { x: 5, y: -10 }, end: { x: 5, y: 10 }, obj: 1 },
    { ...base, type: 'TEXT', position: { x: 0, y: 0 }, text: 'A LONG LABEL', height: 2, rotation: 0, obj: 2 },
    { ...base, type: 'HATCH', loops: [[{ x: 0, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: 0, y: 5 }]], solid: true, patternAngle: 0, patternSpacing: 1, obj: 3 },
  ]);
  assert.equal(pickObject(p, { x: 5.2, y: 1 }, 0.5, none), 1);
  // Away from the line, the fill or text under the cursor is still picked
  assert.equal(pickObject(p, { x: 8, y: -3 }, 0.5, none), 3);
});
