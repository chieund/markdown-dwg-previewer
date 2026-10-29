/**
 * Agent evaluation harness: a fresh `claude -p` session, restricted to the
 * dwg_* tools, answers question sets on real drawings. A question is PASS when
 * every `expect` substring is in the answer and no `forbid` substring is.
 *
 *   node esbuild.js --ai-eval && node out-test/aiEval.js <questions.json>
 *
 * Question file: [{ drawing, question, expect[], forbid?[], source }].
 * `drawing` is an absolute path, or a path relative to the folder named by the
 * DWG_SAMPLES environment variable (so committed question sets hold no
 * machine-specific paths), e.g.
 *
 *   DWG_SAMPLES=~/samples node out-test/aiEval.js test/ai-eval.public.json
 *
 * Reports go to out-test/ (git-ignored); they may contain client text.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { processDrawing } from '../src/dwg/pipeline';
import { DrawingStore } from '../src/ai/drawingStore';
import { startMcpServer } from '../src/ai/server';
import { SERVER_NAME } from '../src/ai/connect';
import { resolveDrawing, score } from './evalMatch';

interface Question {
  drawing: string;
  question: string;
  expect: string[];
  forbid?: string[];
  source: string;
  /** Shown beside the question in the report; does not affect scoring. */
  note?: string;
}

const ALLOWED = ['dwg_overview', 'dwg_find_text', 'dwg_dimensions'].map((t) => `mcp__${SERVER_NAME}__${t}`).join(',');
// Belt and braces: --tools "" removes every built-in tool; the disallow list names the usual ones anyway.
const DISALLOWED = 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function runClaude(prompt: string, mcpConfig: string, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', '--strict-mcp-config', '--mcp-config', mcpConfig, '--tools', '', '--allowedTools', ALLOWED, '--disallowedTools', DISALLOWED],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(prompt);
  });
}

function buildPrompt(drawing: string, qs: Question[]): string {
  return [
    `Answer these questions about the drawing file ${drawing}. Use only the dwg_* tools (pass that absolute path).`,
    'Rules: state every number with its unit; if the drawing does not declare units, say so. If you cannot find something in the drawing, answer "not found" for it instead of guessing.',
    'Answer each question on its own line, prefixed with its number (Q1, Q2, ...).',
    '',
    ...qs.map((q, i) => `Q${i + 1}. ${q.question}`),
  ].join('\n');
}

/** The part of the answer belonging to question i (lines from "Qi" to the next "Q<j>"), else undefined (never score the whole answer: it could false-pass). */
function answerFor(answer: string, i: number, total: number): string | undefined {
  const start = new RegExp(`(^|\\n)\\W*Q${i + 1}\\b`).exec(answer);
  if (!start) return undefined;
  const rest = answer.slice(start.index);
  const next = i + 1 < total ? new RegExp(`\\n\\W*Q${i + 2}\\b`).exec(rest) : null;
  return next ? rest.slice(0, next.index) : rest;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node out-test/aiEval.js <questions.json>');
  const questions: Question[] = (JSON.parse(fs.readFileSync(file, 'utf8')) as Question[]).map((q) => ({ ...q, drawing: resolveDrawing(q.drawing) }));
  const byDrawing = new Map<string, Question[]>();
  for (const q of questions) byDrawing.set(q.drawing, [...(byDrawing.get(q.drawing) ?? []), q]);

  const store = new DrawingStore({
    capacity: 4,
    stat: async (p) => {
      const s = await fs.promises.stat(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
    parse: async (p) => processDrawing(await fs.promises.readFile(p), p, '', () => {}),
  });
  const lines: string[] = [`# AI eval ${new Date().toISOString()} (${path.basename(file)})`, ''];
  let pass = 0;
  let check = 0;
  let failedRuns = 0;
  let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
  let tmp: string | undefined;
  let cwd: string | undefined;
  try {
    const token = randomBytes(24).toString('hex');
    const port = await freePort();
    server = await startMcpServer({
      port,
      token,
      log: (m) => console.error(`[mcp] ${m}`),
      host: {
        store,
        checkAccess: async (p) => {
          if (!path.isAbsolute(p)) throw new Error('Absolute path required');
          return fs.promises.realpath(p);
        },
      },
    });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-eval-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-eval-cwd-'));
    const mcpConfig = path.join(tmp, 'mcp.json');
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });

    for (const [drawing, qs] of byDrawing) {
      console.error(`Running ${path.basename(drawing)} (${qs.length} questions)...`);
      lines.push(`## ${path.basename(drawing)}`, '');
      const r = await runClaude(buildPrompt(drawing, qs), mcpConfig, cwd);
      if (r.code !== 0 || !r.out.trim()) {
        failedRuns++;
        check += qs.length;
        const why = `${r.err.trim().slice(0, 500)} ${r.out.trim().slice(0, 500)}`.trim();
        console.log(`RUN FAILED  ${path.basename(drawing)} (exit ${r.code}) ${why}`);
        qs.forEach((q, i) => lines.push(`### Q${i + 1} RUN FAILED`, `Question: ${q.question}`, ''));
        lines.push(`RUN FAILED (exit ${r.code}): ${why}`, '');
        continue;
      }
      qs.forEach((q, i) => {
        const a = answerFor(r.out, i, qs.length);
        const sc = a === undefined ? undefined : score(a, q.expect, q.forbid ?? []);
        const ok = sc?.pass === true;
        if (ok) pass++; else check++;
        const detail = sc ? `missing=[${sc.missing}] forbidden=[${sc.forbidden}]` : 'no answer labelled for this question';
        console.log(`${ok ? 'PASS' : 'CHECK'}  Q${i + 1} ${path.basename(drawing)}${ok ? '' : `  ${detail}`}`);
        lines.push(`### Q${i + 1} ${ok ? 'PASS' : 'CHECK'}`, `Question: ${q.question}`, `Source: ${q.source}`, ...(q.note ? [`Note: ${q.note}`] : []), `Expect: ${q.expect.join(' ; ')}  Forbid: ${(q.forbid ?? []).join(' ; ')}`,
          ok ? '' : `Detail: ${detail}`, 'Answer:', (a ?? '(none)').trim(), '');
      });
      lines.push('<details><summary>Full answer</summary>', '', r.out.trim(), '', '</details>', '');
    }
  } catch (e) {
    failedRuns++;
    lines.push(`HARNESS ERROR: ${e instanceof Error ? e.message : String(e)}`, '');
    console.error(e);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    await server?.close().catch(() => {});
    lines.push(`Summary: ${pass} PASS, ${check} CHECK, ${failedRuns} failed run(s)`);
    const outDir = path.resolve(__dirname, '..', 'out-test');
    fs.mkdirSync(outDir, { recursive: true });
    const report = path.join(outDir, `ai-eval-${new Date().toISOString().slice(0, 10)}-${path.basename(file, '.json')}.md`);
    fs.writeFileSync(report, lines.join('\n'));
    console.log(`${pass} PASS, ${check} CHECK, ${failedRuns} failed run(s) -> ${report}`);
  }
  process.exit(check > 0 || failedRuns > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
