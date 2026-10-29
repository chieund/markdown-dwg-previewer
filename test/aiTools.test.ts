import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, TOOL_DEFINITIONS, type ToolHost } from '../src/ai/tools';
import { DrawingStore } from '../src/ai/drawingStore';
import { parseDxf } from '../src/dxf/parseDxf';
import type { ParsedDxf } from '../src/shared/types';

const dxf = (...lines: string[]) => lines.join('\n');

const NESTED_DIM = [
  '0', 'DIMENSION', '8', 'DIMS', '2', '*D1', '10', '0', '20', '0', '30', '0',
  '11', '100', '21', '900', '31', '0', '70', '33', '42', '3500',
];

/** Frame block around everything, two labels, 200 fillers, a stray point, two dimensions. */
function fixture(units?: number): string {
  const fillers: string[] = [];
  for (let i = 0; i < 200; i++) {
    fillers.push('0', 'POINT', '8', '0', '10', String(i * 5), '20', String(400 + (i % 20) * 10), '30', '0');
  }
  return dxf(
    '0', 'SECTION', '2', 'HEADER',
    ...(units === undefined ? [] : ['9', '$INSUNITS', '70', String(units)]),
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'FRAME', '70', '0', '10', '0', '20', '0', '30', '0',
    '0', 'LINE', '8', '0', '10', '-1000', '20', '-1000', '30', '0', '11', '2000', '21', '-1000', '31', '0',
    '0', 'LINE', '8', '0', '10', '2000', '20', '-1000', '30', '0', '11', '2000', '21', '1500', '31', '0',
    '0', 'LINE', '8', '0', '10', '2000', '20', '1500', '30', '0', '11', '-1000', '21', '1500', '31', '0',
    '0', 'LINE', '8', '0', '10', '-1000', '20', '1500', '30', '0', '11', '-1000', '21', '-1000', '31', '0',
    '0', 'ENDBLK',
    '0', 'BLOCK', '2', 'ELEV', '70', '0', '10', '0', '20', '0', '30', '0',
    ...NESTED_DIM,
    '0', 'ENDBLK',
    '0', 'BLOCK', '2', '*D1', '70', '1', '10', '0', '20', '0', '30', '0',
    '0', 'MTEXT', '8', '0', '10', '100', '20', '900', '30', '0', '40', '50', '1', '3500',
    '0', 'ENDBLK',
    '0', 'BLOCK', '2', '*D2', '70', '1', '10', '0', '20', '0', '30', '0',
    '0', 'MTEXT', '8', '0', '10', '800', '20', '900', '30', '0', '40', '50', '1', '25000',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'FRAME', '10', '0', '20', '0', '30', '0',
    '0', 'MTEXT', '8', 'TEXT', '10', '0', '20', '0', '30', '0', '40', '50', '1', '12 cửa 30x30',
    '0', 'MTEXT', '8', 'TEXT', '10', '500', '20', '0', '30', '0', '40', '50', '1', 'L=15m',
    '0', 'POINT', '8', '0', '10', '1000000', '20', '1000000', '30', '0',
    '0', 'DIMENSION', '8', 'DIMS', '2', '*D2', '10', '0', '20', '0', '30', '0',
    '11', '800', '21', '900', '31', '0', '70', '33', '42', '25000',
    '0', 'INSERT', '8', '0', '2', 'ELEV', '10', '0', '20', '0', '30', '0',
    ...fillers,
    '0', 'ENDSEC', '0', 'EOF'
  );
}

function hostFor(text: string | ParsedDxf, over: Partial<ToolHost> = {}): ToolHost {
  const parsed = typeof text === 'string' ? parseDxf(text) : text;
  return {
    store: new DrawingStore({
      stat: async () => ({ mtimeMs: 1, size: 1 }),
      parse: async () => parsed,
      capacity: 2,
    }),
    checkAccess: async (p) => p,
    ...over,
  };
}

async function json(host: ToolHost, name: string, args: Record<string, unknown> = {}) {
  const out = await callTool(host, name, { path: '/d.dxf', ...args });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  return JSON.parse((out[0] as { text: string }).text);
}

test('overview says NOT DECLARED without $INSUNITS and names the unit when declared', async () => {
  assert.equal((await json(hostFor(fixture()), 'dwg_overview')).units, 'NOT DECLARED');
  assert.equal((await json(hostFor(fixture(4)), 'dwg_overview')).units, 'millimetre');
  assert.equal((await json(hostFor(fixture(6)), 'dwg_overview')).units, 'metre');
});

test('overview main extents leave out the stray point; counts of types and blocks', async () => {
  const o = await json(hostFor(fixture(4)), 'dwg_overview');
  assert.ok(o.pages[0].extents.maxX >= 1_000_000, 'true extents include the stray');
  assert.ok(o.pages[0].mainExtents.maxX < 5000, JSON.stringify(o.pages[0].mainExtents));
  assert.equal(o.objectTypes.MTEXT, 2);
  assert.equal(o.blocks.FRAME, 1);
  assert.equal(o.blocks.ELEV, 1);
  assert.deepEqual(o.titleBlockAttributes, []);
});

test('find_text folds accents; lists what it is inside and what is nearby', async () => {
  const r = await json(hostFor(fixture(4)), 'dwg_find_text', { query: 'cua' });
  assert.equal(r.totalMatches, 1);
  const m = r.matches[0];
  assert.equal(m.text, '12 cửa 30x30');
  assert.ok(m.inside.some((b: { block?: string }) => b.block === 'FRAME'), 'the frame contains it');
  assert.equal(m.nearby[0].text, 'L=15m');
  assert.ok(!m.nearby.some((b: { block?: string }) => b.block === 'FRAME'), 'containers are not nearby');
});

test('find_text finds labels drawn inside a block and points at the INSERT', async () => {
  const src = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'DOOR', '70', '0', '10', '0', '20', '0', '30', '0',
    '0', 'TEXT', '5', 'T1', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'Cửa D1',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '5', 'I1', '8', '0', '2', 'DOOR', '10', '5', '20', '5', '30', '0',
    '0', 'TEXT', '5', 'T2', '8', '0', '10', '10', '20', '10', '30', '0', '40', '1', '1', 'Cửa D2',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const r = await json(hostFor(src), 'dwg_find_text', { query: 'Cửa' });
  assert.equal(r.totalMatches, 2);
  const nested = r.matches.find((m: { text?: string }) => m.text === 'Cửa D1');
  assert.ok(nested, JSON.stringify(r.matches));
  assert.equal(nested.id, 0);
  assert.equal(nested.block, 'DOOR');
  assert.equal(nested.inBlock, true);
  assert.ok(nested.center);
  assert.equal(r.matches.filter((m: { text?: string }) => m.text === 'Cửa D2').length, 1);
});

test('warnings from a cut-short drawing reach every reading tool', async () => {
  const parsed = parseDxf(fixture());
  parsed.warnings = ['Drawing cut short after 1000 entities'];
  const host = hostFor(parsed);
  assert.deepEqual((await json(host, 'dwg_overview')).warnings, parsed.warnings);
  assert.deepEqual((await json(host, 'dwg_find_text', { query: 'cua' })).warnings, parsed.warnings);
  assert.deepEqual((await json(host, 'dwg_dimensions')).warnings, parsed.warnings);
});

test('find_text respects limit and keeps an exact total', async () => {
  const r = await json(hostFor(fixture()), 'dwg_find_text', { query: 'l', limit: 1 });
  assert.equal(r.returned, 1);
  assert.equal(r.matches.length, 1);
  assert.ok(r.totalMatches > 1);
  assert.equal(r.truncated, true);
});

test('dimensions count every value, nested ones included, each with a center', async () => {
  const r = await json(hostFor(fixture()), 'dwg_dimensions');
  assert.equal(r.total, 2);
  assert.equal(r.valueCounts['25000'], 1);
  assert.equal(r.valueCounts['3500'], 1);
  for (const d of r.dimensions) assert.ok(d.center, JSON.stringify(d));
  const filtered = await json(hostFor(fixture()), 'dwg_dimensions', { near: { x: 800, y: 900, radius: 50 } });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.dimensions[0].value, '25000');
});

test('20,000 labels are cut to 100,000 characters with the total kept', async () => {
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (let i = 0; i < 20000; i++) {
    lines.push('0', 'MTEXT', '8', 'T', '10', String(i), '20', '0', '30', '0', '40', '2', '1', `label ${i} ` + 'x'.repeat(400));
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  const host = hostFor(lines.join("\n"));
  const out = await callTool(host, 'dwg_find_text', { path: '/d.dxf', limit: 200 });
  const t = (out[0] as { text: string }).text;
  assert.ok(t.length <= 100_000, String(t.length));
  const r = JSON.parse(t);
  assert.equal(r.truncated, true);
  assert.equal(r.totalMatches, 20000);
  assert.ok(r.returned < 200 && r.returned === r.matches.length);
});

test('a refused access comes back as an Error result', async () => {
  const host = hostFor(fixture(), {
    checkAccess: async () => {
      throw new Error('The user declined access to /d.dxf');
    },
  });
  const out = await callTool(host, 'dwg_overview', { path: '/d.dxf' });
  const t = (out[0] as { text: string }).text;
  assert.ok(t.startsWith('Error:'));
  assert.match(t, /declined/);
});

test('show and snapshot without the preview say to open VS Code', async () => {
  for (const name of ['dwg_show', 'dwg_snapshot']) {
    const t = ((await callTool(hostFor(fixture()), name, { path: '/d.dxf' }))[0] as { text: string }).text;
    assert.ok(t.startsWith('Error:'), t);
    assert.match(t, /VS Code/);
  }
});

test('show and snapshot reach the preview with the checked path', async () => {
  const seen: unknown[] = [];
  const host = hostFor(fixture(), {
    checkAccess: async () => '/real.dxf',
    preview: {
      show: async (p, _k, req) => (seen.push([p, req]), 'shown'),
      snapshot: async (p, _k, req) => (seen.push([p, req]), 'UE5H'),
    },
  });
  assert.equal(((await callTool(host, 'dwg_show', { path: '/x', objects: [1], fit: true }))[0] as { text: string }).text, 'shown');
  const snap = await callTool(host, 'dwg_snapshot', { path: '/x', around: 1 });
  assert.deepEqual(snap[0], { type: 'image', data: 'UE5H', mimeType: 'image/png' });
  assert.equal((seen[0] as unknown[])[0], '/real.dxf');
});

test('unknown tools and a missing path are errors; every tool is defined', async () => {
  assert.equal(TOOL_DEFINITIONS.length, 5);
  assert.ok(((await callTool(hostFor(fixture()), 'nope', {}))[0] as { text: string }).text.startsWith('Error:'));
  assert.ok(((await callTool(hostFor(fixture()), 'dwg_overview', {}))[0] as { text: string }).text.startsWith('Error:'));
});

test('dimensions never guess: no text means no value, no position means no center', async () => {
  const parsed = parseDxf(fixture());
  const obj = parsed.dimensions![0].obj;
  parsed.dimensions = [
    { obj, text: '', layer: 'DIMS', position: { x: 10, y: 10 }, measurement: 1234.5 },
    { obj, text: '777', layer: 'DIMS', measurement: 777 },
    { obj, text: '888', layer: 'DIMS', position: { x: 10, y: 10 } },
  ];
  const host = hostFor(parsed);
  const r = await json(host, 'dwg_dimensions');
  assert.equal(r.noText, 1);
  assert.deepEqual(r.valueCounts, { '777': 1, '888': 1 });
  const bare = r.dimensions.find((d: { measurement?: number; value?: string }) => d.measurement === 1234.5);
  assert.equal(bare.value, undefined);
  const nopos = r.dimensions.find((d: { value?: string }) => d.value === '777');
  assert.equal(nopos.center, undefined);
  const near = await json(host, 'dwg_dimensions', { near: { x: 10, y: 10, radius: 5 } });
  assert.deepEqual(near.dimensions.map((d: { value?: string }) => d.value), [undefined, '888']);
});

test('units: the whole DXF table by name; unknown codes are said so', async () => {
  assert.equal((await json(hostFor(fixture(7)), 'dwg_overview')).units, 'kilometre');
  assert.equal((await json(hostFor(fixture(24)), 'dwg_overview')).units, 'US survey mile');
  assert.equal((await json(hostFor(fixture(99)), 'dwg_overview')).units, 'unit code 99 (not recognised)');
  assert.equal((await json(hostFor(fixture(0)), 'dwg_overview')).units, 'NOT DECLARED');
});

test('an oversized overview is cut to the cap and says so', async () => {
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (let i = 0; i < 3000; i++) {
    lines.push('0', 'MTEXT', '8', 'LAYER_' + i + '_' + 'y'.repeat(60), '10', String(i), '20', '0', '30', '0', '40', '2', '1', 'n' + i);
  }
  for (let i = 0; i < 5; i++) lines.push('0', 'MTEXT', '8', 'N', '10', '0', '20', '0', '30', '0', '40', '2', '1', 'z'.repeat(5000 + i));
  lines.push('0', 'ENDSEC', '0', 'EOF');
  const parsed = parseDxf(lines.join('\n'));
  // Many long block names push it over
  parsed.objects.forEach((o, i) => { if (i < 3000) o.block = 'BLK_' + i + '_' + 'b'.repeat(2500); });
  const t = ((await callTool(hostFor(parsed), 'dwg_overview', { path: '/d.dxf' }))[0] as { text: string }).text;
  assert.ok(t.length <= 100_000, String(t.length));
  const o = JSON.parse(t);
  assert.equal(o.truncated, true);
  assert.ok(o.totalLayers >= 3000);
});

test('page accepts an index, a numeric string or a name; layer filters', async () => {
  const host = hostFor(fixture());
  const byIndex = await json(host, 'dwg_find_text', { query: 'cửa', page: 0 });
  const byString = await json(host, 'dwg_find_text', { query: 'cửa', page: '0' });
  assert.equal(byIndex.totalMatches, 1);
  assert.equal(byString.totalMatches, 1);
  const byName = await json(host, 'dwg_find_text', { query: 'cửa', page: byIndex.matches[0].page });
  assert.equal(byName.totalMatches, 1);
  const bad = ((await callTool(host, 'dwg_find_text', { path: '/d.dxf', page: '9' }))[0] as { text: string }).text;
  assert.ok(bad.startsWith('Error:'));
  assert.equal((await json(host, 'dwg_find_text', { query: 'l=15m', layer: 'text' })).totalMatches, 1);
  assert.equal((await json(host, 'dwg_find_text', { query: 'l=15m', layer: 'other' })).totalMatches, 0);
  assert.equal((await json(host, 'dwg_dimensions', { layer: 'dims' })).total, 2);
  assert.equal((await json(host, 'dwg_dimensions', { layer: 'nope' })).total, 0);
});

test('fold handles đ: "dam" finds "Đầm"', async () => {
  const host = hostFor(dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'MTEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '2', '1', 'Đầm D1', '0', 'ENDSEC', '0', 'EOF'));
  assert.equal((await json(host, 'dwg_find_text', { query: 'dam' })).totalMatches, 1);
});

test('245,000 objects: a 30-match find_text stays fast', async () => {
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (let i = 0; i < 245000; i++) {
    lines.push('0', i % 8000 === 0 ? 'MTEXT' : 'POINT', '8', '0', '10', String(i % 700), '20', String(Math.floor(i / 700)), '30', '0');
    if (i % 8000 === 0) lines.push('40', '2', '1', 'pile ' + i);
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  const host = hostFor(parseDxf(lines.join('\n')));
  await host.store.get('/d.dxf', { persist: true });
  const t0 = Date.now();
  const r = await json(host, 'dwg_find_text', { query: 'pile', limit: 30 });
  const ms = Date.now() - t0;
  assert.equal(r.totalMatches, 31);
  assert.ok(ms < 2000, `took ${ms} ms`);
});
