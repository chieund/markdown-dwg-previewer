import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache, debounce } from '../src/dwg/cache';

test('the cache drops the least recently used entry once full', () => {
  const cache = new LruCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // a is now the most recent
  cache.set('c', 3);

  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('setting an existing key refreshes it instead of growing the cache', () => {
  const cache = new LruCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10);
  cache.set('c', 3);

  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.size, 2);
});

test('debounce runs once after a burst of calls', async () => {
  let runs = 0;
  const run = debounce(() => runs++, 20);
  run();
  run();
  run();
  assert.equal(runs, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runs, 1);
});

test('a cancelled debounce never runs', async () => {
  let runs = 0;
  const run = debounce(() => runs++, 20);
  run();
  run.cancel();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runs, 0);
});
