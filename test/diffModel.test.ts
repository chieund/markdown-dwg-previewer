import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_COLORS, pageLabel, paint, stepIndex } from '../src/webview/diffModel';
import type { DiffPage, DxfEntity } from '../src/shared/types';

const line: DxfEntity = { type: 'LINE', layer: 'A', color: '#123456', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, linetype: '1 1', obj: 2 };

test('painting recolours copies and leaves the originals alone', () => {
  const [copy] = paint([line], DIFF_COLORS.added);
  assert.equal(copy.color, DIFF_COLORS.added);
  assert.equal(line.color, '#123456');
  assert.equal(copy.obj, 2, 'the change index is kept for highlighting');
});

test('old shapes of changed objects are drawn dashed', () => {
  const [copy] = paint([line], DIFF_COLORS.removed, true);
  assert.equal(copy.linetype, '6 4');
});

test('a page label carries its number of changes', () => {
  const page = { name: 'Model Space', changes: [{}, {}, {}] } as unknown as DiffPage;
  assert.equal(pageLabel(page), 'Model Space (3 changes)');
  assert.equal(pageLabel({ ...page, changes: [] }), 'Model Space (no changes)');
  assert.equal(pageLabel({ ...page, changes: [{}] } as unknown as DiffPage), 'Model Space (1 change)');
});

test('stepping through changes wraps around, and starts from either end', () => {
  assert.equal(stepIndex(-1, 5, 1), 0);
  assert.equal(stepIndex(-1, 5, -1), 4);
  assert.equal(stepIndex(4, 5, 1), 0);
  assert.equal(stepIndex(0, 5, -1), 4);
  assert.equal(stepIndex(-1, 0, 1), -1);
});
