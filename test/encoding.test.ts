import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDxfBuffer } from '../src/dwg/encoding';
import { parseDxf } from '../src/dxf/parseDxf';

const header = (version: string, codepage: string) =>
  ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', version, '9', '$DWGCODEPAGE', '3', codepage, '0', 'ENDSEC'].join('\n');

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

/** "あい" in Shift-JIS. */
const SJIS_AI = [0x82, 0xa0, 0x82, 0xa2];

test('an R2000 DXF in code page 932 is decoded as Shift-JIS', () => {
  const text = decodeDxfBuffer(bytes(header('AC1015', 'ANSI_932'), '\n0\nEOF\n999\n', SJIS_AI));
  assert.ok(text.endsWith('あい'), JSON.stringify(text.slice(-10)));
});

test('a UTF-8 DXF stays UTF-8 even when it declares an ANSI code page', () => {
  const text = decodeDxfBuffer(Buffer.concat([Buffer.from(header('AC1015', 'ANSI_932') + '\n999\n'), Buffer.from('あい', 'utf-8')]));
  assert.ok(text.endsWith('あい'));
});

test('an R2007+ DXF is read as UTF-8', () => {
  const text = decodeDxfBuffer(Buffer.concat([Buffer.from(header('AC1021', 'ANSI_1252') + '\n999\n'), Buffer.from('é', 'utf-8')]));
  assert.ok(text.endsWith('é'));
});

test('a Western DXF in code page 1252 keeps its accents', () => {
  const text = decodeDxfBuffer(bytes(header('AC1015', 'ANSI_1252'), '\n999\n', [0xe9]));
  assert.ok(text.endsWith('é'));
});

test('a leading UTF-8 byte-order mark is dropped', () => {
  const text = decodeDxfBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('0\nEOF')]));
  assert.equal(text, '0\nEOF');
});

test('MTEXT \\M+1 escapes decode through Shift-JIS', () => {
  const text = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'MTEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', '\\M+182A0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const [entity] = parseDxf(text).pages[0].entities;
  assert.equal(entity.type === 'TEXT' ? entity.text : null, 'あ');
});
