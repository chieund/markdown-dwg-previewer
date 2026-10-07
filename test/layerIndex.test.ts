import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayerIndex } from '../src/webview/layerIndex';

const element = () => ({ style: { display: '' } });

test('elements on a hidden layer are hidden when added', () => {
  const index = new LayerIndex();
  const el = element();
  index.add('A', el, new Set(['A']));
  assert.equal(el.style.display, 'none');
});

test('toggling a layer flips only its own elements', () => {
  const index = new LayerIndex();
  const a = element();
  const b = element();
  index.add('A', a, new Set());
  index.add('B', b, new Set());

  index.apply(new Set(['A']));
  assert.equal(a.style.display, 'none');
  assert.equal(b.style.display, '');

  index.apply(new Set());
  assert.equal(a.style.display, '');
});

test('the visible count follows the hidden set, counting entities that drew nothing too', () => {
  const index = new LayerIndex();
  index.add('A', element(), new Set());
  index.add('A', null, new Set()); // an entity the renderer skipped still counts
  index.add('B', element(), new Set());

  assert.equal(index.visibleCount(new Set()), 3);
  assert.equal(index.visibleCount(new Set(['A'])), 1);
});
