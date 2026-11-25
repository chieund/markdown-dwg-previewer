import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/dxf/parseDxf';
import { arrowPolygon, scanAnnotations, scanDimStyles } from '../src/dxf/annotations';
import { toPairs } from '../src/dxf/hatch';
import { callTool, type ToolHost } from '../src/ai/tools';
import { DrawingStore } from '../src/ai/drawingStore';
import type { DxfEntity, TextEntity } from '../src/shared/types';

const dxf = (...lines: string[]) => lines.join('\n');

const TABLE_BLOCK = [
  '0', 'BLOCK', '2', '*T1', '70', '1', '10', '0', '20', '0', '30', '0',
  '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '50', '21', '0', '31', '0',
  '0', 'LINE', '8', '0', '10', '0', '20', '-10', '30', '0', '11', '50', '21', '-10', '31', '0',
  '0', 'MTEXT', '8', '0', '10', '2', '20', '-1', '30', '0', '40', '2', '71', '1', '1', 'DOOR SCHEDULE',
  '0', 'MTEXT', '8', '0', '10', '2', '20', '-6', '30', '0', '40', '2', '71', '1', '1', 'D1 900x2100',
  '0', 'ENDBLK',
];

const table = (block = '*T1', extra: string[] = []) => [
  '0', 'ACAD_TABLE', '5', 'A1', '8', 'Schedules', '92', '12', '310', 'AABBCC',
  '100', 'AcDbBlockReference', '10', '100', '20', '200', '30', '0', '2', block, '100', 'AcDbTable', ...extra,
];

const file = (blocks: string[], entities: string[], tables: string[] = []) =>
  dxf('0', 'SECTION', '2', 'TABLES', ...tables, '0', 'ENDSEC', '0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF');

const onPage = (parsed: ReturnType<typeof parseDxf>, type: DxfEntity['type']) => parsed.pages.flatMap((p) => p.entities).filter((e) => e.type === type);

test('a table is drawn from its block at its insertion point and is not a counted block', () => {
  const parsed = parseDxf(file(TABLE_BLOCK, table()));
  assert.deepEqual(parsed.skippedEntityTypes, []);
  const [o] = parsed.objects;
  assert.equal(o.type, 'ACAD_TABLE');
  assert.equal(o.block, undefined);
  assert.equal(o.layer, 'Schedules');
  const lines = onPage(parsed, 'LINE') as Extract<DxfEntity, { type: 'LINE' }>[];
  assert.deepEqual(lines.map((l) => [l.start.x, l.start.y, l.end.x, l.end.y]), [[100, 200, 150, 200], [100, 190, 150, 190]]);
  assert.deepEqual((onPage(parsed, 'TEXT') as TextEntity[]).map((t) => t.text), ['DOOR SCHEDULE', 'D1 900x2100']);
  assert.ok(parsed.pages[0].entities.every((e) => e.obj === 0), 'every part belongs to the table');
  assert.equal(o.empty, undefined);
});

test('a table whose block is missing is reported as not drawn', () => {
  const parsed = parseDxf(file(TABLE_BLOCK, table('*T99')));
  assert.deepEqual(parsed.skippedEntityTypes, ['ACAD_TABLE']);
});

test('a table in paper space lands on its layout, and an invisible one is not drawn', () => {
  const inSpace = (...codes: string[]) => ['0', 'ACAD_TABLE', '5', 'A1', '8', 'S', ...codes, '100', 'AcDbBlockReference', '10', '0', '20', '0', '2', '*T1'];
  const paper = parseDxf(file(TABLE_BLOCK, inSpace('67', '1')));
  assert.equal(paper.objects[0].page, paper.pages.length - 1);
  assert.equal(paper.pages[paper.objects[0].page].name, 'Paper Space');
  assert.equal(onPage(parseDxf(file(TABLE_BLOCK, inSpace('60', '1'))), 'LINE').length, 0);
});

function host(parsed: ReturnType<typeof parseDxf>): ToolHost {
  return {
    store: new DrawingStore({ stat: async () => ({ mtimeMs: 1, size: 1 }), parse: async () => parsed, capacity: 2 }),
    checkAccess: async (p) => p,
  };
}

test('an agent finds a table cell by its text, and the table is an object of its own', async () => {
  const parsed = parseDxf(file(TABLE_BLOCK, table()));
  const out = await callTool(host(parsed), 'dwg_find_text', { path: '/d.dxf', query: 'd1 900' });
  const json = JSON.parse((out[0] as { text: string }).text);
  assert.equal(json.totalMatches, 1);
  assert.equal(json.matches[0].text, 'D1 900x2100');
  assert.equal(json.matches[0].id, 0);
  assert.equal(json.matches[0].inBlock, true);
});

const MLEADER = (extra: string[] = []) => [
  '0', 'MULTILEADER', '5', 'B1', '8', 'Notes', '100', 'AcDbMLeader',
  '300', 'CONTEXT_DATA{', '40', '48', '10', '300', '20', '500', '30', '0', '41', '3', '140', '9', '145', '4',
  '290', '1', '304', 'ROOF:\\PEPDM',
  '11', '0', '21', '0', '31', '1', '12', '320', '22', '555', '32', '0', '13', '1', '23', '0', '33', '0',
  '302', 'LEADER{', '290', '1', '291', '1', '10', '450', '20', '550', '30', '0', '11', '-1', '21', '0', '31', '0', '90', '0', '40', '25',
  '304', 'LEADER_LINE{', '10', '450', '20', '490', '30', '0', '91', '0', '305', '}', '303', '}', '301', '}',
  ...extra,
];

test('a multileader draws its line, dogleg, arrow and note text, and its object carries the text', () => {
  const parsed = parseDxf(file([], MLEADER()));
  assert.deepEqual(parsed.skippedEntityTypes, []);
  const [o] = parsed.objects;
  assert.equal(o.type, 'MULTILEADER');
  assert.equal(o.text, 'ROOF:\nEPDM');
  const polys = onPage(parsed, 'POLYLINE') as Extract<DxfEntity, { type: 'POLYLINE' }>[];
  const open = polys.filter((p) => !p.closed);
  assert.deepEqual(open.map((p) => p.points.map((q) => [q.x, q.y])), [[[450, 550], [450, 490]], [[450, 550], [425, 550]]]);
  const arrow = polys.find((p) => p.closed && p.filled)!;
  assert.deepEqual(arrow.points[0], { x: 450, y: 490 }, 'the arrow tip sits at the end of the line');
  const [note] = onPage(parsed, 'TEXT') as TextEntity[];
  assert.equal(note.text, 'ROOF:\nEPDM');
  assert.deepEqual(note.position, { x: 320, y: 555 });
  assert.equal(note.height, 3);
  assert.equal(note.vAlign, 'top');
});

test('annotation lines are drawn but never counted as linework', () => {
  const parsed = parseDxf(file([], MLEADER()));
  assert.equal(parsed.objects[0].length, undefined);
  assert.equal(parsed.objects[0].area, undefined);
});

test('a multileader with no arrow size or no dogleg draws only what it has', () => {
  const noArrow = MLEADER().map((v, i, a) => (a[i - 1] === '140' ? '0' : v));
  const parsed = parseDxf(file([], noArrow));
  assert.equal((onPage(parsed, 'POLYLINE') as { filled?: boolean }[]).filter((p) => p.filled).length, 0);
  const noDogleg = MLEADER().map((v, i, a) => (a[i - 1] === '291' ? '0' : v));
  assert.equal((onPage(parsed, 'POLYLINE') as { closed: boolean }[]).filter((p) => !p.closed).length, 2);
  assert.equal((onPage(parseDxf(file([], noDogleg)), 'POLYLINE') as { closed: boolean }[]).filter((p) => !p.closed).length, 1);
});

test('a multileader with several leader lines gets an arrow on each', () => {
  const extra = MLEADER();
  const second = ['304', 'LEADER_LINE{', '10', '460', '20', '480', '30', '0', '10', '470', '20', '470', '30', '0', '91', '1', '305', '}'];
  const at = extra.lastIndexOf('303');
  const two = [...extra.slice(0, at), ...second, ...extra.slice(at)];
  const parsed = parseDxf(file([], two));
  const polys = onPage(parsed, 'POLYLINE') as Extract<DxfEntity, { type: 'POLYLINE' }>[];
  assert.equal(polys.filter((p) => p.filled).length, 2);
  assert.deepEqual(polys.find((p) => !p.closed && p.points.length === 3)!.points.map((q) => [q.x, q.y]), [[450, 550], [460, 480], [470, 470]]);
});

const DIMSTYLES = ['0', 'TABLE', '2', 'DIMSTYLE', '0', 'DIMSTYLE', '2', 'A1-450', '40', '450', '41', '1.6', '0', 'DIMSTYLE', '2', 'Standard', '41', '0.18', '0', 'ENDTAB'];

const LEADER = (style: string, arrow = '1') => [
  '0', 'LEADER', '5', 'C1', '8', 'Notes', '100', 'AcDbLeader', '3', style, '71', arrow, '72', '0', '76', '2',
  '10', '0', '20', '0', '30', '0', '10', '1000', '20', '0', '30', '0', '210', '0', '220', '0', '230', '1',
];

test('a leader is a polyline, with an arrow as big as its dimension style says', () => {
  const parsed = parseDxf(file([], LEADER('a1-450'), DIMSTYLES));
  assert.equal(parsed.objects[0].type, 'LEADER');
  const polys = onPage(parsed, 'POLYLINE') as Extract<DxfEntity, { type: 'POLYLINE' }>[];
  const line = polys.find((p) => !p.closed)!;
  assert.deepEqual(line.points, [{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
  const arrow = polys.find((p) => p.filled)!;
  assert.deepEqual(arrow.points[0], { x: 0, y: 0 });
  assert.ok(Math.abs(arrow.points[1].x - 720) < 1e-9 && Math.abs(Math.abs(arrow.points[1].y) - 120) < 1e-9, 'size 1.6 × scale 450 = 720, a third as wide');
});

test('a leader without an arrow, or in an unknown style, has none', () => {
  for (const [style, flag] of [['a1-450', '0'], ['nope', '1']]) {
    const polys = onPage(parseDxf(file([], LEADER(style, flag), DIMSTYLES)), 'POLYLINE') as { filled?: boolean }[];
    assert.equal(polys.filter((p) => p.filled).length, 0, `${style} ${flag}`);
    assert.equal(polys.length, 1);
  }
});

test('a leader inside a block is placed with the block', () => {
  const block = ['0', 'BLOCK', '2', 'CALL', '70', '0', '10', '0', '20', '0', '30', '0', ...LEADER('Standard', '0'), '0', 'ENDBLK'];
  const insert = ['0', 'INSERT', '8', '0', '2', 'CALL', '10', '10', '20', '20', '30', '0'];
  const parsed = parseDxf(file(block, insert, DIMSTYLES));
  const [line] = onPage(parsed, 'POLYLINE') as Extract<DxfEntity, { type: 'POLYLINE' }>[];
  assert.deepEqual(line.points, [{ x: 10, y: 20 }, { x: 1010, y: 20 }]);
});

test('dimension styles are read by name, ignoring case', () => {
  const styles = scanDimStyles(toPairs(file([], [], DIMSTYLES)));
  assert.deepEqual(styles.get('A1-450'), { scale: 450, arrow: 1.6 });
  assert.deepEqual(styles.get('STANDARD'), { scale: 1, arrow: 0.18 });
});

test('the arrow is a closed filled triangle as long as its size', () => {
  const [tip, a, b] = arrowPolygon({ tip: { x: 10, y: 0 }, direction: { x: 1, y: 0 }, size: 6 });
  assert.deepEqual(tip, { x: 10, y: 0 });
  assert.deepEqual([a.x, b.x], [4, 4]);
  assert.deepEqual([a.y, b.y].sort(), [-1, 1]);
});

test('a leader or table with nothing usable is reported, never thrown', () => {
  assert.deepEqual([...scanAnnotations(file([], ['0', 'LEADER', '5', 'C1', '76', '1'])).unreadable], ['LEADER']);
  assert.deepEqual([...scanAnnotations(file([], ['0', 'MULTILEADER', '5', 'C1', '100', 'AcDbMLeader'])).unreadable], ['MULTILEADER']);
  assert.deepEqual([...scanAnnotations(file([], ['0', 'ACAD_TABLE', '5', 'C1'])).unreadable], ['ACAD_TABLE']);
});
