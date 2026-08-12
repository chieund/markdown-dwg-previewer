import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUnreadableFormat, detectDrawingFormat } from '../src/dwg/format';

const dxf = (...lines: string[]) => Buffer.from(lines.join('\r\n'), 'utf-8');

test('every DWG release stamps AC10xx into the header', () => {
  for (const version of ['AC1014', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032']) {
    const buffer = Buffer.concat([Buffer.from(version, 'latin1'), Buffer.alloc(64)]);
    assert.equal(detectDrawingFormat(buffer), 'dwg', `${version} should read as DWG`);
  }
});

test('a text DXF is recognised from its opening group-code pair', () => {
  assert.equal(detectDrawingFormat(dxf('0', 'SECTION', '2', 'HEADER')), 'dxf-text');
});

test('DXF written with plain newlines is still recognised', () => {
  assert.equal(
    detectDrawingFormat(Buffer.from('0\nSECTION\n2\nENTITIES\n', 'utf-8')),
    'dxf-text'
  );
});

test('leading whitespace, padding and a BOM do not hide a DXF', () => {
  assert.equal(detectDrawingFormat(dxf('', '  0  ', ' SECTION ', '2', 'HEADER')), 'dxf-text');
  assert.equal(
    detectDrawingFormat(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), dxf('0', 'SECTION')])),
    'dxf-text'
  );
});

test('999 comment pairs before the first section are skipped', () => {
  assert.equal(
    detectDrawingFormat(dxf('999', 'Exported by SomeCAD 2024', '0', 'SECTION', '2', 'HEADER')),
    'dxf-text'
  );
  assert.equal(
    detectDrawingFormat(dxf('999', 'one', '999', 'two', '0', 'SECTION')),
    'dxf-text'
  );
});

test('binary DXF is identified so it can be reported instead of silently failing', () => {
  const buffer = Buffer.concat([
    Buffer.from('AutoCAD Binary DXF\r\n', 'latin1'),
    Buffer.from([0x1a, 0x00]),
    Buffer.alloc(32),
  ]);
  assert.equal(detectDrawingFormat(buffer), 'dxf-binary');
});

test('unrelated files are rejected rather than guessed at', () => {
  assert.equal(detectDrawingFormat(Buffer.from('%PDF-1.7\n', 'latin1')), 'unknown');
  assert.equal(detectDrawingFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'unknown');
  assert.equal(detectDrawingFormat(Buffer.from('just some notes', 'utf-8')), 'unknown');
  assert.equal(detectDrawingFormat(Buffer.alloc(0)), 'unknown');
});

test('a DXF-like stream that never reaches SECTION is not accepted', () => {
  assert.equal(detectDrawingFormat(dxf('0', 'LINE', '8', '0')), 'unknown');
});

test('the header decides, not the file extension', () => {
  // A DWG renamed to .dxf must still be routed through the converter
  const renamed = Buffer.concat([Buffer.from('AC1032', 'latin1'), Buffer.alloc(64)]);
  assert.equal(detectDrawingFormat(renamed), 'dwg');
});

test('the binary-DXF message tells the user what to do about it', () => {
  const message = describeUnreadableFormat('dxf-binary', 'plan.dxf');
  assert.match(message, /plan\.dxf/);
  assert.match(message, /binary DXF/i);
  assert.match(message, /ASCII DXF/i, 'must name the fix, not just the problem');
});

test('the unknown-format message names the file and stays honest', () => {
  const message = describeUnreadableFormat('unknown', 'notes.dwg');
  assert.match(message, /notes\.dwg/);
  assert.match(message, /neither format/i);
});
