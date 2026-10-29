import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { matches, resolveDrawing, score } from '../scripts/evalMatch';

test('integers match whole numbers only', () => {
  assert.ok(matches('There are 57 doors', '57'));
  assert.ok(matches('57 doors', '57'));
  assert.ok(matches('count: 57.', '57'));
  assert.ok(matches('57.0 doors', '57'));
  assert.ok(!matches('157 doors', '57'));
  assert.ok(!matches('570 doors', '57'));
  assert.ok(!matches('57.5 doors', '57'));
  assert.ok(!matches('-57 doors', '57'));
  assert.ok(!matches('1,57', '57'));
  assert.ok(!matches('5-57', '57'));
});

test('decimals tolerate formatting and trailing zeros', () => {
  for (const s of ['120.5 m', '120,50 m', '120.50m', 'L = 120.5.']) assert.ok(matches(s, '120.5'), s);
  for (const s of ['1120.5', '120.55', '122.5', '120', '2120,5']) assert.ok(!matches(s, '120.5'), s);
  assert.ok(matches('D = 1.0 m', '1.0'));
  assert.ok(!matches('11.0 m', '1.0'));
});

test('thousands separators', () => {
  assert.ok(matches('120,500 mm', '120500'));
  assert.ok(matches('120.500 mm', '120500'));
  assert.ok(matches('120500', '120500'));
  assert.ok(!matches('1120500', '120500'));
});

test('negative numbers', () => {
  assert.ok(matches('x = -918.95', '-918.95'));
  assert.ok(matches('x = \u2212918.95, y = 218.2', '-918.95'));
  assert.ok(!matches('x = 918.95', '-918.95'));
  assert.ok(!matches('x = -918.951', '-918.95'));
});

test('text: alternatives, boundaries, accents, case', () => {
  assert.ok(matches('Spans: 4 spans of 25 m', '4 spans|4 nhịp'));
  assert.ok(matches('có 4 NHỊP', '4 nhip'));
  assert.ok(!matches('14 spans', '4 spans'));
  assert.ok(!matches('-4 spans', '4 spans'));
  assert.ok(matches('columns 30×30 cm', '30x30|30×30'));
  assert.ok(matches('Cửa sổ 2 cánh', 'cua so 2 canh'));
  assert.ok(!matches('the gantryx', 'gantry'));
  assert.ok(matches("175'-0\" overall", "175'-0"));
  assert.ok(!matches("1175'-0\"", "175'-0"));
  assert.ok(matches('Option 1 (a.b)', '(a.b)'));
  assert.ok(matches('There are **2** design options', '2 design options'));
  assert.ok(!matches('anything', ''));
});

test('score: all expects and no forbid', () => {
  assert.deepEqual(score('L = 120.50 m', ['120.5'], ['122.5']), { pass: true, missing: [], forbidden: [] });
  assert.equal(score('L = 122.5 m', ['120.5'], ['122.5']).pass, false);
  assert.equal(score('120.5 and 122.5', ['120.5'], ['122.5']).forbidden[0], '122.5');
  assert.equal(score('anything', [], []).pass, false);
});

test('resolveDrawing: absolute as given, relative under DWG_SAMPLES, relative without it is an error', () => {
  const abs = path.resolve('/x/a.dxf');
  assert.equal(resolveDrawing(abs, undefined), abs);
  assert.equal(resolveDrawing('a b.dxf', '/samples'), path.resolve('/samples', 'a b.dxf'));
  assert.throws(() => resolveDrawing('a.dxf', undefined), /DWG_SAMPLES/);
});

test('the public question set holds no machine-specific paths', async () => {
  const fs = await import('node:fs');
  const qs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'test', 'ai-eval.public.json'), 'utf8')) as { drawing: string }[];
  for (const q of qs) assert.equal(path.isAbsolute(q.drawing), false, q.drawing);
});
