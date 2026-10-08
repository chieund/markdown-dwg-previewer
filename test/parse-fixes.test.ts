import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/dxf/parseDxf';
import type { DxfEntity, TextEntity } from '../src/shared/types';

const near = (actual: number, expected: number, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

const dxf = (...lines: string[]) => lines.join('\n');

/** A LAYER table entry; a negative colour means the layer is switched off. */
const layer = (name: string, color: number) => ['0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS'];

const withLayers = (layers: string[][], ...body: string[]) =>
  dxf(
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER',
    ...layers.flat(),
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    ...body,
    '0', 'EOF'
  );

const entities = (...body: string[]) => ['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC'];

const modelEntities = (text: string): DxfEntity[] => parseDxf(text).pages[0].entities;

const onlyText = (text: string): TextEntity => {
  const found = modelEntities(text).filter((e): e is TextEntity => e.type === 'TEXT');
  assert.equal(found.length, 1, `expected one text, got ${JSON.stringify(found)}`);
  return found[0];
};

// ── Colour inheritance ─────────────────────────────────────────────────────

test('layer-0 geometry inside a block takes the colour of the layer it was inserted on', () => {
  const text = withLayers(
    [layer('0', 7), layer('RED', 1)],
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'B', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    ...entities('0', 'INSERT', '8', 'RED', '2', 'B', '10', '0', '20', '0', '30', '0')
  );

  const [line] = modelEntities(text);
  assert.equal(line.layer, 'RED');
  assert.equal(line.color, '#ff0000');
});

// ── INSERT array explosion ────────────────────────────────────────────────

test('a huge INSERT array is capped instead of exhausting memory', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'B', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'POINT', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    ...entities('0', 'INSERT', '8', '0', '2', 'B', '10', '0', '20', '0', '30', '0',
      '70', '30000', '71', '30000', '44', '1', '45', '1'),
    '0', 'EOF'
  );

  const parsed = parseDxf(text);
  assert.ok(parsed.pages[0].entities.length <= 500_000, `got ${parsed.pages[0].entities.length}`);
  assert.ok(parsed.warnings?.some((w) => /limit/i.test(w)), 'the cut must be reported');
});

// ── Draw order ────────────────────────────────────────────────────────────

const hatch = (layerName: string, handle = 'H1') => [
  '0', 'HATCH', '5', handle, '8', layerName, '10', '0', '20', '0', '30', '0', '2', 'SOLID', '70', '1', '71', '0', '91', '1',
  '92', '2', '72', '0', '73', '1', '93', '4',
  '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10', '10', '0', '20', '10',
  '97', '0', '75', '0', '76', '1', '98', '0',
];

test('a hatch stays where the file put it in the draw order', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities(
      ...hatch('0'),
      '0', 'LINE', '5', 'L1', '8', '0', '10', '0', '20', '5', '30', '0', '11', '10', '21', '5', '31', '0'
    )
  );

  assert.deepEqual(modelEntities(text).map((e) => e.type), ['HATCH', 'LINE']);
});

// ── Visibility saved in the file ──────────────────────────────────────────

test('a layer switched off in CAD starts hidden', () => {
  const text = withLayers(
    [layer('0', 7), layer('OFF', -3)],
    ...entities('0', 'LINE', '8', 'OFF', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0')
  );

  const off = parseDxf(text).pages[0].layers.find((l) => l.name === 'OFF');
  assert.equal(off?.off, true);
});

test('layer off flags are ignored for converted DWGs, where libredwg sets them on every layer', () => {
  const text = withLayers(
    [layer('0', 7), layer('OFF', -3)],
    ...entities('0', 'LINE', '8', 'OFF', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0')
  );

  const off = parseDxf(text, { trustLayerOffFlags: false }).pages[0].layers.find((l) => l.name === 'OFF');
  assert.equal(off?.off, undefined);
});

test('an invisible attribute is not drawn', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities(
      '0', 'INSERT', '8', '0', '66', '1', '2', 'NOPE', '10', '0', '20', '0', '30', '0',
      '0', 'ATTRIB', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'SECRET', '2', 'TAG', '70', '1',
      '0', 'ATTRIB', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'SHOWN', '2', 'TAG2', '70', '0',
      '0', 'SEQEND', '8', '0'
    )
  );

  assert.deepEqual(modelEntities(text).filter((e) => e.type === 'TEXT').map((e) => (e as TextEntity).text), ['SHOWN']);
});

// ── OCS / extrusion ───────────────────────────────────────────────────────

test('a mirrored ARC (extrusion 0,0,-1) is drawn on the mirrored side', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'ARC', '5', 'A1', '8', '0', '10', '10', '20', '0', '30', '0', '40', '1',
      '210', '0', '220', '0', '230', '-1', '50', '0', '51', '90')
  );

  const [arc] = modelEntities(text);
  const points = arc.type === 'POLYLINE' ? arc.points : [];
  assert.ok(points.length > 2, `expected a sampled arc, got ${JSON.stringify(arc)}`);
  // OCS (11,0) → WCS (-11,0); OCS (10,1) → WCS (-10,1)
  near(points[0].x, -11);
  near(points[0].y, 0);
  near(points[points.length - 1].x, -10);
  near(points[points.length - 1].y, 1);
});

test('a mirrored CIRCLE (extrusion 0,0,-1) is drawn on the mirrored side', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'CIRCLE', '5', 'C1', '8', '0', '10', '10', '20', '3', '30', '0', '40', '1',
      '210', '0', '220', '0', '230', '-1')
  );

  const [circle] = modelEntities(text);
  assert.equal(circle.type, 'CIRCLE');
  if (circle.type === 'CIRCLE') {
    near(circle.center.x, -10);
    near(circle.center.y, 3);
  }
});

test('a mirrored LWPOLYLINE (extrusion 0,0,-1) is drawn on the mirrored side', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'LWPOLYLINE', '5', 'P1', '8', '0', '90', '2', '70', '0',
      '10', '5', '20', '1', '10', '8', '20', '1', '210', '0', '220', '0', '230', '-1')
  );

  const [poly] = modelEntities(text);
  assert.equal(poly.type, 'POLYLINE');
  if (poly.type === 'POLYLINE') {
    near(poly.points[0].x, -5);
    near(poly.points[1].x, -8);
  }
});

test('mirrored TEXT (extrusion 0,0,-1) is placed on the mirrored side', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'TEXT', '5', 'T1', '8', '0', '10', '20', '20', '4', '30', '0', '40', '2', '1', 'HELLO',
      '210', '0', '220', '0', '230', '-1')
  );

  near(onlyText(text).position.x, -20);
  near(onlyText(text).position.y, 4);
});

test('mirrored TEXT stays upright and runs back from its insertion point, as AutoCAD lays it out', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'TEXT', '5', 'T2', '8', '0', '10', '20', '20', '4', '30', '0', '40', '2', '1', 'HELLO',
      '210', '0', '220', '0', '230', '-1')
  );

  const t = onlyText(text);
  near(((t.rotation % 360) + 360) % 360, 0);
  assert.equal(t.hAlign, 'right');
});

test('a mirrored hatch mirrors its pattern angle', () => {
  const body = hatch('0');
  body.splice(body.indexOf('2'), 0, '210', '0', '220', '0', '230', '-1');
  body.push('52', '45');
  const text = withLayers([layer('0', 7)], ...entities(...body));

  const [h] = modelEntities(text);
  if (h.type !== 'HATCH') throw new Error('expected a hatch');
  near(((h.patternAngle % 180) + 180) % 180, 135);
});

test('a mirrored HATCH (extrusion 0,0,-1) is drawn on the mirrored side', () => {
  const body = hatch('0');
  // Extrusion goes in the header, before the boundary paths
  body.splice(body.indexOf('2'), 0, '210', '0', '220', '0', '230', '-1');
  const text = withLayers([layer('0', 7)], ...entities(...body));

  const [h] = modelEntities(text);
  assert.equal(h.type, 'HATCH');
  if (h.type === 'HATCH') {
    const xs = h.loops[0].map((p) => p.x);
    near(Math.min(...xs), -10);
    near(Math.max(...xs), 0);
  }
});

// ── Text content ─────────────────────────────────────────────────────────

const mtext = (content: string) =>
  withLayers([layer('0', 7)], ...entities('0', 'MTEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '71', '1', '1', content));

test('MTEXT keeps the text after a toggle code that has no semicolon', () => {
  assert.equal(onlyText(mtext('a \\Lunder\\l; b')).text, 'a under; b');
});

test('MTEXT stacked fractions become a/b', () => {
  assert.equal(onlyText(mtext('1\\S1/2;" pipe')).text, '11/2" pipe');
  assert.equal(onlyText(mtext('\\S3^4;')).text, '3/4');
});

test('MTEXT and TEXT decode \\U+XXXX escapes', () => {
  assert.equal(onlyText(mtext('\\U+3042\\U+3044')).text, 'あい');
  const text = withLayers([layer('0', 7)], ...entities('0', 'TEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'X\\U+00B0'));
  assert.equal(onlyText(text).text, 'X°');
});

test('MTEXT keeps escaped braces and backslashes, and drops font switches', () => {
  assert.equal(onlyText(mtext('{\\fArial|b1;Bold} \\{x\\} a\\\\b')).text, 'Bold {x} a\\b');
});

test('MTEXT column breaks become new lines and keep the text after them', () => {
  assert.equal(onlyText(mtext('a\\Nb;c')).text, 'a\nb;c');
});

test('MTEXT superscripts and subscripts drop the empty half of the stack', () => {
  assert.equal(onlyText(mtext('m\\S2^;')).text, 'm2');
  assert.equal(onlyText(mtext('x\\S^2;')).text, 'x2');
});

test('MTEXT paragraph breaks become new lines', () => {
  assert.equal(onlyText(mtext('Line1\\PLine2')).text, 'Line1\nLine2');
});

// ── Text alignment ───────────────────────────────────────────────────────

test('Aligned and Fit TEXT are anchored at their first point, not the second', () => {
  for (const halign of ['3', '5']) {
    const text = withLayers(
      [layer('0', 7)],
      ...entities('0', 'TEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'FIT',
        '72', halign, '11', '100', '21', '0', '31', '0')
    );
    near(onlyText(text).position.x, 0);
  }
});

// ── Text style ───────────────────────────────────────────────────────────

test('TEXT uses the font of its own style, not STANDARD', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'STYLE',
    '0', 'STYLE', '2', 'STANDARD', '70', '0', '3', 'txt',
    '0', 'STYLE', '2', 'SERIF', '70', '0', '3', 'times.ttf',
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    ...entities('0', 'TEXT', '5', 'T9', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'X', '7', 'SERIF'),
    '0', 'EOF'
  );

  assert.match(onlyText(text).fontFamily ?? '', /Times/);
});

// ── Viewports ────────────────────────────────────────────────────────────

const sheetWithViewport = (status: string) =>
  dxf(
    ...entities(
      // Model: one line inside the viewport's window, one far outside it
      '0', 'LINE', '8', 'NEAR', '10', '0', '20', '0', '30', '0', '11', '1', '21', '1', '31', '0',
      '0', 'LINE', '8', 'FAR', '10', '5000', '20', '5000', '30', '0', '11', '5001', '21', '5001', '31', '0',
      // Sheet: a border line and a viewport showing 10 units around the origin
      '0', 'LINE', '67', '1', '8', 'BORDER', '10', '0', '20', '0', '30', '0', '11', '100', '21', '0', '31', '0',
      '0', 'VIEWPORT', '67', '1', '8', '0', '10', '50', '20', '50', '30', '0', '40', '20', '41', '20',
      '68', status, '69', '2', '12', '0', '22', '0', '45', '10'
    ),
    '0', 'EOF'
  );

test('a viewport only carries the model geometry inside its window', () => {
  const sheet = parseDxf(sheetWithViewport('1')).pages[1];
  const views = sheet.viewports ?? [];
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].entities.map((e) => e.layer), ['NEAR']);
});

test('a viewport with status 0 still shows its view — libredwg and AutoCAD write 0 for every inactive layout', () => {
  const sheet = parseDxf(sheetWithViewport('0')).pages[1];
  assert.equal(sheet.viewports?.length ?? 0, 1);
});

test('model geometry outside a viewport does not use up the entity budget', () => {
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    lines.push('0', 'LINE', '8', 'M', '10', String(i * 10), '20', '0', '30', '0', '11', String(i * 10 + 1), '21', '0', '31', '0');
  }
  const text = dxf(
    ...entities(
      ...lines,
      '0', 'LINE', '8', 'TARGET', '10', '5000', '20', '0', '30', '0', '11', '5001', '21', '0', '31', '0',
      '0', 'LINE', '67', '1', '8', 'BORDER', '10', '0', '20', '0', '30', '0', '11', '100', '21', '0', '31', '0',
      '0', 'VIEWPORT', '67', '1', '8', '0', '10', '50', '20', '50', '30', '0', '40', '20', '41', '20',
      '68', '1', '69', '2', '12', '5000', '22', '0', '45', '10'
    ),
    '0', 'EOF'
  );

  const parsed = parseDxf(text, { maxEntities: 100 });
  assert.equal(parsed.warnings, undefined);
  assert.deepEqual(parsed.pages[1].viewports?.[0].entities.map((e) => e.layer), ['TARGET']);
});

test('a sheet of many detail viewports is not cut short by the work budget', () => {
  // Each viewport walks the whole model again. The budget is per pass, so 25
  // viewports onto a 900-line model are 25 small passes, not one runaway one.
  const lines: string[] = [];
  for (let i = 0; i < 900; i++) {
    lines.push('0', 'LINE', '8', 'M', '10', String(i * 10), '20', '0', '30', '0', '11', String(i * 10 + 1), '21', '0', '31', '0');
  }
  const viewports: string[] = [];
  for (let v = 0; v < 25; v++) {
    viewports.push(
      '0', 'VIEWPORT', '67', '1', '8', '0', '10', String(50 + v * 30), '20', '50', '30', '0', '40', '20', '41', '20',
      '68', '1', '69', String(v + 2), '12', String(v * 300 + 5), '22', '0', '45', '10'
    );
  }
  const text = dxf(
    ...entities(...lines, '0', 'LINE', '67', '1', '8', 'BORDER', '10', '0', '20', '0', '30', '0', '11', '900', '21', '0', '31', '0', ...viewports),
    '0', 'EOF'
  );

  const parsed = parseDxf(text, { maxEntities: 1000 });
  assert.equal(parsed.warnings, undefined);
  assert.equal(parsed.pages[1].viewports?.length, 25);
});

test('a block that inserts itself is cut short instead of hanging the parser', () => {
  // Six self-inserts and no geometry: 6^16 expansions emit nothing, so only a
  // budget on the work itself — not on the entities drawn — can stop it.
  const selfInsert = ['0', 'INSERT', '8', '0', '2', 'A', '10', '0', '20', '0', '30', '0'];
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'A', '70', '0', '10', '0', '20', '0', '30', '0',
    ...Array.from({ length: 6 }, () => selfInsert).flat(),
    '0', 'ENDBLK', '0', 'ENDSEC',
    ...entities(...selfInsert),
    '0', 'EOF'
  );

  const started = Date.now();
  const parsed = parseDxf(text, { maxEntities: 1000 });
  assert.ok(Date.now() - started < 2000, 'parse should stop early');
  assert.equal(parsed.warnings?.length, 1);
  assert.match(parsed.warnings![0], /cut short/);
});

test('a viewport keeps text whose anchor is outside the window but whose body reaches in', () => {
  const text = dxf(
    ...entities(
      // Right-aligned: anchored at x=12, its body runs left into the window (x ≤ 5)
      '0', 'TEXT', '8', 'RIGHT', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      '72', '2', '11', '12', '21', '0', '31', '0',
      // Top-attached MTEXT anchored above the window, hanging down into it
      '0', 'MTEXT', '8', 'HANG', '10', '0', '20', '7', '30', '0', '40', '1', '71', '1', '1', 'a\\Pb\\Pc\\Pd',
      '0', 'LINE', '67', '1', '8', 'BORDER', '10', '0', '20', '0', '30', '0', '11', '100', '21', '0', '31', '0',
      '0', 'VIEWPORT', '67', '1', '8', '0', '10', '50', '20', '50', '30', '0', '40', '10', '41', '10',
      '68', '1', '69', '2', '12', '0', '22', '0', '45', '10'
    ),
    '0', 'EOF'
  );

  const layers = (parseDxf(text).pages[1].viewports?.[0].entities ?? []).map((e) => e.layer).sort();
  assert.deepEqual(layers, ['HANG', 'RIGHT']);
});

test('many hatches are put back in file order without quadratic slowdown', () => {
  const body: string[] = [];
  for (let i = 0; i < 20_000; i++) {
    body.push('0', 'LINE', '5', `L${i}`, '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0');
    if (i % 2 === 0) body.push(...hatch('0', `H${i}`));
  }
  const text = [withLayers([layer('0', 7)]).replace(/\n0\nEOF$/, ''), ...entities(), '0', 'EOF']
    .join('\n')
    .replace('ENTITIES\n0\nENDSEC', `ENTITIES\n${body.join('\n')}\n0\nENDSEC`);

  const started = Date.now();
  const parsed = parseDxf(text);
  const elapsed = Date.now() - started;

  const types = parsed.pages[0].entities.slice(0, 4).map((e) => e.type);
  assert.deepEqual(types, ['LINE', 'HATCH', 'LINE', 'LINE']);
  assert.ok(elapsed < 6000, `took ${elapsed} ms`);
});

// ── Entities dxf-parser drops ─────────────────────────────────────────────

test('3D entities dxf-parser cannot read are named, not silently dropped', () => {
  const text = dxf(
    ...entities(
      '0', '3DSOLID', '5', 'A1', '8', '0', '1', 'opaque ACIS data',
      '0', '3DSOLID', '5', 'A2', '8', '0',
      '0', 'PLANESURFACE', '5', 'A3', '8', '0',
      '0', 'LINE', '5', 'A4', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0'
    ),
    '0', 'EOF'
  );

  assert.deepEqual(parseDxf(text).skippedEntityTypes.sort(), ['3DSOLID', 'PLANESURFACE']);
});

test('entities read by our own scanners are not reported as unsupported', () => {
  const text = dxf(
    ...entities(
      '0', 'HATCH', '5', 'B1', '8', '0', '2', 'SOLID', '70', '1', '91', '0',
      '0', 'VIEWPORT', '5', 'B2', '8', '0', '67', '1',
      '0', 'POLYLINE', '5', 'B3', '8', '0', '66', '1', '70', '0',
      '0', 'VERTEX', '5', 'B4', '8', '0', '10', '0', '20', '0', '30', '0',
      '0', 'VERTEX', '5', 'B5', '8', '0', '10', '1', '20', '0', '30', '0',
      '0', 'SEQEND', '5', 'B6', '8', '0'
    ),
    '0', 'EOF'
  );

  assert.deepEqual(parseDxf(text).skippedEntityTypes, []);
});

test('an unsupported entity on a layout is named; one inside an unused block definition is not', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '5', 'C0', '2', '*Paper_Space0', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'MULTILEADER', '5', 'C1', '8', '0',
    '0', 'ENDBLK', '5', 'C2', '8', '0',
    '0', 'BLOCK', '5', 'C3', '2', 'Library', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'REGION', '5', 'C4', '8', '0',
    '0', 'ENDBLK', '5', 'C5', '8', '0',
    '0', 'ENDSEC',
    ...entities('0', 'LINE', '5', 'C6', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0'),
    '0', 'EOF'
  );

  assert.deepEqual(parseDxf(text).skippedEntityTypes, ['MULTILEADER']);
});
