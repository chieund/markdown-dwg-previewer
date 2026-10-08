/**
 * Corpus test — runs the real pipeline (DWG → DXF → parse) over a whole folder of
 * drawings and reports the result for each file.
 *
 *   npm run test:corpus -- /path/to/folder [more folders or files…]
 *   npm run test:corpus -- /path/to/folder --save
 *   npm run test:corpus -- /private/drawings --baseline=/private/drawings/baseline.json
 *
 * The first run uses --save to record a baseline (test/corpus-baseline.json). Later
 * runs without the flag compare against it and flag any file that lost entities,
 * went from working to failing, or whose pages now span a different area — the
 * safety net for refactoring the parser.
 *
 * test/corpus-baseline.json is public, and lists file names. Drawings that may not
 * be named in public (a client's project) keep their baseline elsewhere through
 * --baseline.
 *
 * Bundled into out-test/ so __dirname sits one level below the project root, just
 * like out/extension.js at runtime — so the converter finds the WASM along the
 * same path it uses in the packaged extension.
 */
import * as fs from 'fs';
import * as path from 'path';
import { convertDwgToDxf, setConverterLogger } from '../src/dwg/converter';
import { decodeDxfBuffer } from '../src/dwg/encoding';
import { describeUnreadableFormat, detectDrawingFormat } from '../src/dwg/format';
import { parseDxf } from '../src/dxf/parseDxf';

interface FileResult {
  file: string;
  format?: string;
  sizeKB: number;
  ok: boolean;
  error?: string;
  dxfKB?: number;
  convertMs?: number;
  parseMs?: number;
  pages?: number;
  entities?: number;
  /** Model geometry drawn through paper-space viewports; a broken viewport shows up only here. */
  viewportEntities?: number;
  layers?: number;
  /**
   * Each page's bounds, rounded. A misplaced block keeps the entity count but
   * moves the extents — a mirrored INSERT drawn on the wrong side showed up only
   * as geometry outside the drawing frame.
   */
  extents?: string[];
  /**
   * INSERTs still listed under an anonymous name (`*U12`, `*B24`) rather than
   * the dynamic block they stand for. The scan once looked in the wrong
   * section and every file kept these names, with every unit test passing.
   */
  anonymousInserts?: number;
  blocks?: number;
  skipped?: string[];
}

const DEFAULT_BASELINE = path.resolve(__dirname, '..', 'test', 'corpus-baseline.json');

/** Bounds to 4 significant digits: float noise is not a change, a block on the wrong side is. */
function extentsOf(bounds: { minX: number; minY: number; maxX: number; maxY: number } | null): string {
  if (!bounds) return 'empty';
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].map((v) => Number(v.toPrecision(4))).join(' ');
}

function findDrawings(dir: string): string[] {
  if (!fs.statSync(dir).isDirectory()) return /\.(dwg|dxf)$/i.test(dir) ? [dir] : [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findDrawings(full));
    else if (/\.(dwg|dxf)$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

async function runFile(filePath: string, logLines: string[]): Promise<FileResult> {
  const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
  const result: FileResult = { file: path.basename(filePath), sizeKB, ok: false };

  try {
    const buffer = fs.readFileSync(filePath);

    // Mirrors dwgEditorProvider: a DXF skips conversion and goes straight in.
    const format = detectDrawingFormat(buffer);
    result.format = format;

    const convertStart = Date.now();
    let dxf: string;
    if (format === 'dxf-text') {
      dxf = decodeDxfBuffer(buffer);
    } else if (format === 'dwg') {
      dxf = await convertDwgToDxf(buffer, filePath, '');
    } else {
      throw new Error(describeUnreadableFormat(format, path.basename(filePath)).split('\n')[0]);
    }
    result.convertMs = Date.now() - convertStart;
    result.dxfKB = Math.round(dxf.length / 1024);

    const parseStart = Date.now();
    const parsed = parseDxf(dxf, { trustLayerOffFlags: format === 'dxf-text' });
    result.parseMs = Date.now() - parseStart;

    result.pages = parsed.pages.length;
    result.entities = parsed.pages.reduce((sum, page) => sum + page.entities.length, 0);
    result.viewportEntities = parsed.pages.reduce(
      (sum, page) => sum + (page.viewports ?? []).reduce((n, view) => n + view.entities.length, 0),
      0
    );
    result.layers = new Set(parsed.pages.flatMap((p) => p.layers.map((l) => l.name))).size;
    result.extents = parsed.pages.map((page) => extentsOf(page.bounds));
    result.anonymousInserts = parsed.objects.filter((o) => o.type === 'INSERT' && o.block?.startsWith('*')).length;
    result.skipped = parsed.skippedEntityTypes.slice().sort();
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
    result.error += logLines.length ? `  |  log: ${logLines[logLines.length - 1]}` : '';
  }

  return result;
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const padL = (s: string, n: number) => s.padStart(n);

function printTable(results: FileResult[]): void {
  const header =
    pad('File', 46) + padL('Fmt', 10) + padL('Size', 8) + padL('DXF', 8) + padL('Conv', 8) +
    padL('Parse', 8) + padL('Pages', 7) + padL('Entities', 10) + padL('Layers', 8) + '  Status';
  console.log('\n' + header);
  console.log('─'.repeat(header.length));

  for (const r of results) {
    if (!r.ok) {
      console.log(pad(r.file, 46) + padL(r.format ?? '—', 10) + padL(`${r.sizeKB}K`, 8) + padL('—', 8) + padL('—', 8) +
        padL('—', 8) + padL('—', 7) + padL('—', 10) + padL('—', 8) + '  FAIL');
      console.log(' '.repeat(4) + '↳ ' + r.error);
      continue;
    }
    console.log(
      pad(r.file, 46) +
      padL(r.format ?? '—', 10) +
      padL(`${r.sizeKB}K`, 8) +
      padL(`${r.dxfKB}K`, 8) +
      padL(`${r.convertMs}ms`, 8) +
      padL(`${r.parseMs}ms`, 8) +
      padL(String(r.pages), 7) +
      padL(String(r.entities), 10) +
      padL(String(r.layers), 8) +
      (r.entities === 0 ? '  EMPTY' : '  ok')
    );
  }
}

function printSkippedSummary(results: FileResult[]): void {
  const counts = new Map<string, number>();
  for (const r of results) {
    for (const type of r.skipped ?? []) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  if (counts.size === 0) return;

  console.log('\nEntities not drawn yet (number of files affected — the to-do list):');
  for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(type, 20)} ${count} file(s)`);
  }
}

function compareWithBaseline(results: FileResult[], baselinePath: string): number {
  if (!fs.existsSync(baselinePath)) {
    console.log('\nNo baseline yet. Run again with --save to record the current results as the baseline.');
    return 0;
  }

  const baseline: FileResult[] = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const before = new Map(baseline.map((r) => [r.file, r]));
  const regressions: string[] = [];
  const improvements: string[] = [];

  for (const now of results) {
    const was = before.get(now.file);
    if (!was) {
      improvements.push(`${now.file}: new file in the corpus`);
      continue;
    }
    if (was.ok && !now.ok) {
      regressions.push(`${now.file}: worked before, fails now — ${now.error}`);
    } else if (!was.ok && now.ok) {
      improvements.push(`${now.file}: failed before, works now`);
    } else if (was.ok && now.ok && was.entities !== now.entities) {
      const delta = now.entities! - was.entities!;
      const line = `${now.file}: ${was.entities} → ${now.entities} entities (${delta > 0 ? '+' : ''}${delta})`;
      (delta < 0 ? regressions : improvements).push(line);
    }
    if (was.ok && now.ok && was.viewportEntities !== undefined && was.viewportEntities !== now.viewportEntities) {
      const delta = now.viewportEntities! - was.viewportEntities;
      const line = `${now.file}: ${was.viewportEntities} → ${now.viewportEntities} entities in viewports (${delta > 0 ? '+' : ''}${delta})`;
      (delta < 0 ? regressions : improvements).push(line);
    }
    if (was.ok && now.ok && was.anonymousInserts !== undefined && now.anonymousInserts! > was.anonymousInserts) {
      regressions.push(`${now.file}: ${was.anonymousInserts} → ${now.anonymousInserts} INSERTs under an anonymous block name`);
    }
    // Recorded since 2026-10-08; older baselines have no extents to compare.
    if (was.ok && now.ok && was.extents && now.extents && was.extents.join('|') !== now.extents.join('|')) {
      const pages = now.extents
        .map((extent, i) => (extent !== was.extents![i] ? `page ${i + 1}: ${was.extents![i] ?? 'none'} → ${extent}` : null))
        .filter(Boolean);
      regressions.push(`${now.file}: drawing extents moved (${pages.join('; ') || 'page count changed'}) — check it on screen, then --save`);
    }
  }

  for (const was of baseline) {
    if (!results.some((r) => r.file === was.file)) {
      console.log(`  (skipped) ${was.file} is in the baseline but no longer in the folder`);
    }
  }

  if (improvements.length) {
    console.log('\nImprovements:');
    for (const line of improvements) console.log('  + ' + line);
  }
  if (regressions.length) {
    console.log('\nREGRESSION:');
    for (const line of regressions) console.log('  - ' + line);
  }
  if (!improvements.length && !regressions.length) {
    console.log('\nMatches the baseline exactly.');
  }

  return regressions.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const save = args.includes('--save');
  const baselineArg = args.find((a) => a.startsWith('--baseline='));
  const baselinePath = baselineArg ? path.resolve(baselineArg.slice('--baseline='.length)) : DEFAULT_BASELINE;
  const given = args.filter((a) => !a.startsWith('--'));
  const dirs = given.length > 0 ? given : process.env.DWG_CORPUS ? [process.env.DWG_CORPUS] : [];

  if (dirs.length === 0) {
    console.error('Missing folder.\n  npm run test:corpus -- /path/to/folder [more…] [--save] [--baseline=file.json]');
    process.exit(2);
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      console.error(`Not found: ${dir}`);
      process.exit(2);
    }
  }

  const files = dirs.flatMap(findDrawings);
  if (files.length === 0) {
    console.error(`No .dwg / .dxf files found in ${dirs.join(', ')}`);
    process.exit(2);
  }
  // Results are matched to the baseline by file name
  const names = files.map((file) => path.basename(file));
  const twice = names.filter((name, i) => names.indexOf(name) !== i);
  if (twice.length > 0) {
    console.error(`Two drawings share a name, which the baseline cannot tell apart: ${[...new Set(twice)].join(', ')}`);
    process.exit(2);
  }

  const logLines: string[] = [];
  setConverterLogger((msg) => logLines.push(msg));

  console.log(`Running ${files.length} drawings from ${dirs.join(', ')}`);

  const results: FileResult[] = [];
  for (const file of files) {
    logLines.length = 0;
    process.stdout.write(`  ${path.basename(file)} … `);
    const result = await runFile(file, logLines);
    process.stdout.write(result.ok ? 'ok\n' : 'FAIL\n');
    results.push(result);
  }

  printTable(results);
  printSkippedSummary(results);

  const failed = results.filter((r) => !r.ok).length;
  const empty = results.filter((r) => r.ok && r.entities === 0).length;
  console.log(
    `\n${results.length - failed}/${results.length} files converted + parsed` +
    (empty ? `, ${empty} with 0 entities (worth a look)` : '')
  );

  if (save) {
    fs.writeFileSync(baselinePath, JSON.stringify(results, null, 2) + '\n');
    console.log(`Baseline saved: ${path.relative(process.cwd(), baselinePath)}`);
    process.exit(failed > 0 ? 1 : 0);
  }

  const regressions = compareWithBaseline(results, baselinePath);
  process.exit(failed > 0 || regressions > 0 ? 1 : 0);
}

void main();
