import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstLineOffset, LINE_SPACING } from '../src/webview/renderer';
import { exportBackground } from '../src/webview/export';
import { carryOverView, initialHiddenLayers } from '../src/webview/sceneState';
import type { DxfPage } from '../src/shared/types';

// ── Multi-line text ──────────────────────────────────────────────────────

test('a single line sits on its anchor whatever the alignment', () => {
  for (const vAlign of [undefined, 'top', 'middle', 'bottom'] as const) {
    assert.equal(firstLineOffset(1, vAlign), 0);
  }
});

test('top-aligned lines run down from the anchor', () => {
  assert.equal(firstLineOffset(3, 'top'), 0);
});

test('middle-aligned lines are centred on the anchor', () => {
  assert.equal(firstLineOffset(3, 'middle'), -LINE_SPACING);
});

test('bottom-aligned lines end on the anchor', () => {
  assert.equal(firstLineOffset(3, 'bottom'), -2 * LINE_SPACING);
});

// ── Export background ────────────────────────────────────────────────────

test('the export background covers the view, wherever the drawing sits', () => {
  // A drawing far from the origin, as fitBounds frames it (y is flipped)
  const view = { x: 9995, y: -205, w: 110, h: 110 };
  const rect = exportBackground(view);
  assert.ok(rect.x <= view.x && rect.x + rect.w >= view.x + view.w, JSON.stringify(rect));
  assert.ok(rect.y <= view.y && rect.y + rect.h >= view.y + view.h, JSON.stringify(rect));
});

// ── Scene state ──────────────────────────────────────────────────────────

const page = (name: string, layers: { name: string; off?: boolean }[]): DxfPage => ({
  name,
  entities: [],
  bounds: null,
  layers: layers.map((l) => ({ name: l.name, color: '#fff', entityCount: 1, off: l.off })),
});

test('layers switched off in the file start hidden', () => {
  const hidden = initialHiddenLayers([page('Model', [{ name: 'A' }, { name: 'OFF', off: true }])]);
  assert.deepEqual([...hidden], ['OFF']);
});

test('a reload keeps the page, hidden layers and view the user had', () => {
  const pages = [page('Model', [{ name: 'A' }]), page('Sheet', [{ name: 'B' }, { name: 'C' }])];
  const kept = carryOverView(
    { pageName: 'Sheet', hiddenLayers: new Set(['B', 'GONE']) },
    pages
  );
  assert.equal(kept.pageIndex, 1);
  assert.deepEqual([...kept.hiddenLayers], ['B']);
  assert.equal(kept.keepView, true);
});

test('a reload whose page is gone starts over on the first page', () => {
  const kept = carryOverView({ pageName: 'Deleted', hiddenLayers: new Set() }, [page('Model', [{ name: 'A' }, { name: 'OFF', off: true }])]);
  assert.equal(kept.pageIndex, 0);
  assert.deepEqual([...kept.hiddenLayers], ['OFF']);
  assert.equal(kept.keepView, false);
});

test('off layers are still shown when hiding them would leave the first page blank', () => {
  // title_block-arch.dwg: the whole title block sits on layer 0, which is off
  const hidden = initialHiddenLayers([page('Model', [{ name: '0', off: true }]), page('Sheet', [{ name: 'X' }])]);
  assert.deepEqual([...hidden], []);
});
