/**
 * Corpus test — chạy pipeline thật (DWG → DXF → parse) trên cả một thư mục .dwg
 * và báo cáo kết quả từng file.
 *
 *   npm run test:corpus -- /đường/dẫn/tới/thư-mục
 *   npm run test:corpus -- /đường/dẫn/tới/thư-mục --save
 *
 * Lần chạy đầu dùng --save để ghi baseline (test/corpus-baseline.json). Các lần
 * sau chạy không cờ sẽ đối chiếu với baseline và báo đỏ nếu có file tụt entity
 * hoặc chuyển từ chạy được sang lỗi — đây chính là lưới an toàn khi refactor
 * parser.
 *
 * Bundle ra out-test/ để __dirname nằm đúng một cấp dưới gốc project, giống hệt
 * out/extension.js lúc chạy thật — nhờ vậy converter tìm WASM theo đúng đường
 * dẫn nó sẽ dùng trong bản đóng gói.
 */
import * as fs from 'fs';
import * as path from 'path';
import { convertDwgToDxf, setConverterLogger } from '../src/dwg/converter';
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
  layers?: number;
  blocks?: number;
  skipped?: string[];
}

const BASELINE = path.resolve(__dirname, '..', 'test', 'corpus-baseline.json');

function findDrawings(dir: string): string[] {
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
      dxf = buffer.toString('utf-8');
    } else if (format === 'dwg') {
      dxf = await convertDwgToDxf(buffer, filePath, '');
    } else {
      throw new Error(describeUnreadableFormat(format, path.basename(filePath)).split('\n')[0]);
    }
    result.convertMs = Date.now() - convertStart;
    result.dxfKB = Math.round(dxf.length / 1024);

    const parseStart = Date.now();
    const parsed = parseDxf(dxf);
    result.parseMs = Date.now() - parseStart;

    result.pages = parsed.pages.length;
    result.entities = parsed.pages.reduce((sum, page) => sum + page.entities.length, 0);
    result.layers = new Set(parsed.pages.flatMap((p) => p.layers.map((l) => l.name))).size;
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

  console.log('\nEntity chưa vẽ được (số file gặp phải — chính là danh sách nên làm tiếp):');
  for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(type, 20)} ${count} file`);
  }
}

function compareWithBaseline(results: FileResult[]): number {
  if (!fs.existsSync(BASELINE)) {
    console.log('\nChưa có baseline. Chạy lại kèm --save để ghi lại kết quả hiện tại làm mốc.');
    return 0;
  }

  const baseline: FileResult[] = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
  const before = new Map(baseline.map((r) => [r.file, r]));
  const regressions: string[] = [];
  const improvements: string[] = [];

  for (const now of results) {
    const was = before.get(now.file);
    if (!was) {
      improvements.push(`${now.file}: file mới trong corpus`);
      continue;
    }
    if (was.ok && !now.ok) {
      regressions.push(`${now.file}: trước chạy được, giờ lỗi — ${now.error}`);
    } else if (!was.ok && now.ok) {
      improvements.push(`${now.file}: trước lỗi, giờ chạy được`);
    } else if (was.ok && now.ok && was.entities !== now.entities) {
      const delta = now.entities! - was.entities!;
      const line = `${now.file}: ${was.entities} → ${now.entities} entity (${delta > 0 ? '+' : ''}${delta})`;
      (delta < 0 ? regressions : improvements).push(line);
    }
  }

  for (const was of baseline) {
    if (!results.some((r) => r.file === was.file)) {
      console.log(`  (bỏ qua) ${was.file} có trong baseline nhưng không còn trong thư mục`);
    }
  }

  if (improvements.length) {
    console.log('\nThay đổi theo hướng tốt lên:');
    for (const line of improvements) console.log('  + ' + line);
  }
  if (regressions.length) {
    console.log('\nREGRESSION:');
    for (const line of regressions) console.log('  - ' + line);
  }
  if (!improvements.length && !regressions.length) {
    console.log('\nKhớp baseline hoàn toàn.');
  }

  return regressions.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const save = args.includes('--save');
  const dir = args.find((a) => !a.startsWith('--')) ?? process.env.DWG_CORPUS;

  if (!dir) {
    console.error('Thiếu thư mục.\n  npm run test:corpus -- /đường/dẫn/tới/thư-mục [--save]');
    process.exit(2);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Không phải thư mục: ${dir}`);
    process.exit(2);
  }

  const files = findDrawings(dir);
  if (files.length === 0) {
    console.error(`Không tìm thấy file .dwg / .dxf nào trong ${dir}`);
    process.exit(2);
  }

  const logLines: string[] = [];
  setConverterLogger((msg) => logLines.push(msg));

  console.log(`Chạy ${files.length} bản vẽ từ ${dir}`);

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
    `\n${results.length - failed}/${results.length} file convert + parse thành công` +
    (empty ? `, ${empty} file ra 0 entity (cần xem lại)` : '')
  );

  if (save) {
    fs.writeFileSync(BASELINE, JSON.stringify(results, null, 2) + '\n');
    console.log(`Đã ghi baseline: ${path.relative(process.cwd(), BASELINE)}`);
    process.exit(failed > 0 ? 1 : 0);
  }

  const regressions = compareWithBaseline(results);
  process.exit(failed > 0 || regressions > 0 ? 1 : 0);
}

void main();
