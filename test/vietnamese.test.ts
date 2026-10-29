import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/dxf/parseDxf';
import { decodeTcvn3, legacyFontOf } from '../src/dxf/vietnamese';
import { legacyEncodingOf } from '../src/dwg/encoding';

const dxf = (...lines: string[]) => lines.join('\n');

const style = (name: string, font: string) => ['0', 'STYLE', '2', name, '70', '0', '40', '0', '3', font];

/** A DXF with a STYLE table (VN → .VnTime, STD → Arial), then the given sections. */
const withStyles = (...rest: string[]) =>
  dxf(
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'STYLE',
    ...style('VN', '.VnTime'),
    ...style('STD', 'Arial'),
    ...style('Standard', 'Arial'),
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    ...rest,
    '0', 'EOF'
  );

const text = (handle: string, styleName: string, value: string) =>
  ['0', 'TEXT', '5', handle, '8', '0', '7', styleName, '10', '0', '20', '0', '30', '0', '40', '1', '1', value];

const entities = (...body: string[]) => ['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC'];

test('TCVN3 notes read as Vietnamese', () => {
  assert.equal(decodeTcvn3('12 cöa 30x30', false, 'latin1'), '12 cửa 30x30');
  assert.equal(decodeTcvn3('MÆt b»ng tÇng 2', false, 'latin1'), 'Mặt bằng tầng 2');
  assert.equal(decodeTcvn3('Ghi chó chung', false, 'latin1'), 'Ghi chú chung');
});
test('caps fonts show capitals', () => assert.equal(decodeTcvn3('mÆt c¾t', true, 'latin1'), 'MẶT CẮT'));
test('a byte the decoder could not map does not stop the rest', () =>
  assert.equal(decodeTcvn3('Cöa ®i ch�nh', false, 'latin1'), 'Cửa đi ch�nh'));
test('text decoded as windows-1258 maps back to its bytes first', () => {
  const bytes = new Uint8Array([0x63, 0xf6, 0x61]); // "cửa" in TCVN3 bytes
  const asRead = new TextDecoder('windows-1258').decode(bytes);
  assert.equal(decodeTcvn3(asRead, false, 'windows-1258'), 'cửa');
});
test('font files are recognised', () => {
  for (const f of ['.VnTime', 'VNTIME_1.TTF', 'vn-abc.shx', 'vnsimple.shx', 'Vnarial_0.ttf']) assert.equal(legacyFontOf(f), 'tcvn3');
  for (const f of ['.VnArialH', 'VHTIME_0.TTF', 'VHARIAL.TTF', 'VnTimeH.TTF', 'VNArialH.TTF', 'VnArialH_0.TTF', 'vn-abch.shx']) assert.equal(legacyFontOf(f), 'tcvn3-caps');
  for (const f of ['Arial', 'TIMES.TTF', 'txt.shx', 'romans.shx', undefined]) assert.equal(legacyFontOf(f), null);
});
test('the encoding a file was read with follows its header', () => {
  const head = (...vars: string[]) => dxf('0', 'SECTION', '2', 'HEADER', ...vars, '0', 'ENDSEC');
  assert.equal(legacyEncodingOf(head('9', '$ACADVER', '1', 'AC1021')), null);
  assert.equal(legacyEncodingOf(head('9', '$ACADVER', '1', 'AC1015', '9', '$DWGCODEPAGE', '3', 'ANSI_1258')), 'windows-1258');
  assert.equal(legacyEncodingOf(head('9', '$ACADVER', '1', 'AC1015')), 'windows-1252');
});

test('R2007+ text is Unicode, so a .Vn* style is not decoded as TCVN3 again', () => {
  const src = dxf(
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1021', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'STYLE',
    ...style('VN', '.VnTime'),
    '0', 'ENDTAB', '0', 'ENDSEC',
    ...entities(...text('A1', 'VN', 'cöa')),
    '0', 'EOF'
  );
  assert.equal(parseDxf(src).objects[0].text, 'cöa');
});

test('only text drawn in a TCVN3 font is converted', () => {
  const objects = parseDxf(
    withStyles(...entities(...text('A1', 'VN', 'cöa'), ...text('A2', 'STD', 'cöa'), ...text('A3', 'STD', '30×30')))
  ).objects;
  assert.deepEqual(objects.map((o) => o.text), ['cửa', 'cöa', '30×30']);
});

test('the drawn text is converted as well as the listed one', () => {
  const page = parseDxf(withStyles(...entities(...text('A1', 'VN', 'cöa')))).pages[0];
  assert.equal((page.entities[0] as { text: string }).text, 'cửa');
});

test('an MTEXT font switch converts only its own span', () => {
  const mtext = ['0', 'MTEXT', '5', 'B1', '8', '0', '7', 'STD', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'Plan {\\f.VnTime|b0;cöa} ×2'];
  assert.equal(parseDxf(withStyles(...entities(...mtext))).objects[0].text, 'Plan cửa ×2');
});

test('attributes and dimension texts in TCVN3 styles are converted too', () => {
  const body = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', '*D1', '8', '0', '10', '0', '20', '0', '30', '0',
    ...text('C1', 'VN', 'phßng 25m'),
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    ...entities(
      '0', 'INSERT', '5', 'D1', '8', '0', '2', 'BLK', '10', '0', '20', '0', '30', '0', '66', '1',
      '0', 'ATTRIB', '5', 'D2', '8', '0', '7', 'VN', '2', 'T', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'TÇng 2',
      '0', 'SEQEND',
      '0', 'DIMENSION', '5', 'D3', '8', '0', '2', '*D1', '70', '0', '10', '0', '20', '0', '30', '0',
      '11', '5', '21', '5', '31', '0', '13', '0', '23', '0', '33', '0', '14', '10', '24', '0', '34', '0'
    )
  );
  const { objects } = parseDxf(withStyles(body));
  assert.equal(objects.find((o) => o.type === 'INSERT')!.attributes![0].value, 'Tầng 2');
  assert.equal(objects.find((o) => o.type === 'DIMENSION')!.text, 'phòng 25m');
});

const mtextIn = (handle: string, styleName: string, value: string) =>
  ['0', 'MTEXT', '5', handle, '8', '0', '7', styleName, '10', '0', '20', '0', '30', '0', '40', '1', '1', value];
const firstText = (src: string) => parseDxf(src).objects[0].text;

test('an MTEXT in a TCVN3 style converts with no font switch', () => {
  assert.equal(firstText(withStyles(...entities(...mtextIn('B1', 'VN', 'cöa')))), 'cửa');
});

test('a {} scope ends the font switch made inside it', () => {
  assert.equal(firstText(withStyles(...entities(...mtextIn('B1', 'STD', '{\\f.VnTime|b0;cöa} cöa')))), 'cửa cöa');
});

test('switching back to a plain font inside a TCVN3 style stops the conversion', () => {
  assert.equal(firstText(withStyles(...entities(...mtextIn('B1', 'VN', 'cöa \\fArial|b0;cöa')))), 'cửa cöa');
});

test('a caps font gives capitals for TEXT and MTEXT', () => {
  const src = dxf(
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'STYLE',
    ...style('CAPS', '.VnTimeH'),
    '0', 'ENDTAB', '0', 'ENDSEC',
    ...entities(...text('A1', 'CAPS', 'mÆt c¾t'), ...mtextIn('B1', 'CAPS', 'mÆt c¾t')),
    '0', 'EOF'
  );
  assert.deepEqual(parseDxf(src).objects.map((o) => o.text), ['MẶT CẮT', 'MẶT CẮT']);
});

test('a style with no font file is not TCVN3 even when STANDARD is', () => {
  const src = dxf(
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'STYLE',
    ...style('Standard', '.VnTime'),
    '0', 'STYLE', '2', 'PLAIN', '70', '0', '40', '0',
    '0', 'ENDTAB', '0', 'ENDSEC',
    ...entities(...text('A1', 'PLAIN', 'cöa')),
    '0', 'EOF'
  );
  assert.equal(firstText(src), 'cöa');
});
