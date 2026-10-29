import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAccessCheck, AccessDenied, AccessDeps } from '../src/ai/access';
import { WindowRegistry } from '../src/ai/windows';

function setup(opts: { previews?: string[]; answer?: boolean; platform?: string } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiaccess-')));
  const ws = path.join(root, 'ws');
  const ws2 = path.join(root, 'ws2');
  const outside = path.join(root, 'outside');
  for (const d of [ws, ws2, outside]) fs.mkdirSync(d);
  const asks: string[] = [];
  const deps: AccessDeps = {
    workspaceFolders: async () => [ws],
    openPreviews: () => opts.previews ?? [],
    ask: async (p) => { asks.push(p); await new Promise((r) => setTimeout(r, 5)); return opts.answer ?? true; },
    realpath: (p) => fs.promises.realpath(p),
    isFile: async (p) => (await fs.promises.stat(p).catch(() => undefined))?.isFile() ?? false,
  };
  const check = createAccessCheck(deps, opts.platform);
  return { root, ws, ws2, outside, asks, check, deps };
}
const touch = (p: string) => fs.writeFileSync(p, 'x');

test('inside a folder is allowed without asking; ws2 is not inside ws', async () => {
  const s = setup();
  touch(path.join(s.ws, 'a.dwg')); touch(path.join(s.ws2, 'b.dwg'));
  assert.equal(await s.check(path.join(s.ws, 'a.dwg')), path.join(s.ws, 'a.dwg'));
  assert.equal(s.asks.length, 0);
  await s.check(path.join(s.ws2, 'b.dwg'));
  assert.equal(s.asks.length, 1);
});

test('open preview outside folders is allowed without asking', async () => {
  const s0 = setup();
  const f = path.join(s0.outside, 'a.dwg'); touch(f);
  const s = setup({ previews: [f] });
  const f2 = path.join(s.outside, 'a.dwg'); touch(f2);
  const s2 = setup({ previews: [] });
  void s2;
  const check = createAccessCheck({ ...s.deps, openPreviews: () => [f2] });
  assert.equal(await check(f2), f2);
  assert.equal(s.asks.length, 0);
});

test('outside asks once; remembers allow', async () => {
  const s = setup();
  const f = path.join(s.outside, 'a.dwg'); touch(f);
  await s.check(f); await s.check(f);
  assert.equal(s.asks.length, 1);
});

test('deny is remembered and throws AccessDenied each time', async () => {
  const s = setup({ answer: false });
  const f = path.join(s.outside, 'a.dwg'); touch(f);
  await assert.rejects(s.check(f), (e: Error) => e instanceof AccessDenied && /declined/.test(e.message));
  await assert.rejects(s.check(f), AccessDenied);
  assert.equal(s.asks.length, 1);
});

test('concurrent checks share one prompt', async () => {
  const s = setup();
  const f = path.join(s.outside, 'a.dwg'); touch(f);
  await Promise.all([s.check(f), s.check(f), s.check(f)]);
  assert.equal(s.asks.length, 1);
});

test('relative path denied', async () => {
  const s = setup();
  await assert.rejects(s.check('a.dwg'), AccessDenied);
});

test('.. into outside asks', async () => {
  const s = setup();
  touch(path.join(s.outside, 'a.dwg'));
  await s.check(path.join(s.ws, '..', 'outside', 'a.dwg'));
  assert.equal(s.asks.length, 1);
});

test('symlink inside ws to outside asks with the real path', async () => {
  const s = setup();
  const f = path.join(s.outside, 'a.dwg'); touch(f);
  fs.symlinkSync(f, path.join(s.ws, 'link.dwg'));
  assert.equal(await s.check(path.join(s.ws, 'link.dwg')), f);
  assert.deepEqual(s.asks, [f]);
});

test('symlinked workspace folder: files via real path are inside', async () => {
  const s = setup();
  const linkWs = path.join(s.root, 'wslink');
  fs.symlinkSync(s.ws, linkWs);
  touch(path.join(s.ws, 'a.dwg'));
  const check = createAccessCheck({ ...s.deps, workspaceFolders: async () => [linkWs] });
  await check(path.join(s.ws, 'a.dwg'));
  assert.equal(s.asks.length, 0);
});

test('directory named x.dwg denied; a.txt denied; A.DWG allowed; missing denied', async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.ws, 'x.dwg'));
  await assert.rejects(s.check(path.join(s.ws, 'x.dwg')), AccessDenied);
  touch(path.join(s.ws, 'a.txt'));
  await assert.rejects(s.check(path.join(s.ws, 'a.txt')), AccessDenied);
  touch(path.join(s.ws, 'A.DWG'));
  await s.check(path.join(s.ws, 'A.DWG'));
  await assert.rejects(s.check(path.join(s.ws, 'nope.dwg')), AccessDenied);
  assert.equal(s.asks.length, 0);
});

test('case-insensitive containment on win32 only', async () => {
  const s = setup();
  const f = path.join(s.ws, 'a.dwg'); touch(f);
  // Windows realpath accepts any case; emulate that for the upper-cased folder.
  const upperWs = s.ws.toUpperCase();
  const upper = {
    ...s.deps,
    workspaceFolders: async () => [upperWs],
    realpath: async (p: string) => (p === upperWs ? p : s.deps.realpath(p)),
  };
  await createAccessCheck(upper, 'win32')(f);
  assert.equal(s.asks.length, 0);
  await createAccessCheck(upper, 'linux')(f);
  assert.equal(s.asks.length, 1);
});

test('not-a-drawing cases all give one generic message', async () => {
  const s = setup();
  touch(path.join(s.outside, 'secret.txt')); touch(path.join(s.ws, 'a.dwg'));
  fs.symlinkSync(path.join(s.outside, 'secret.txt'), path.join(s.ws, 'link.dwg'));
  fs.symlinkSync(path.join(s.ws, 'a.dwg'), path.join(s.ws, 'link.txt'));
  fs.mkdirSync(path.join(s.ws, 'd.dwg'));
  const msgs: string[] = [];
  for (const f of ['link.dwg', 'link.txt', 'd.dwg', 'missing.dwg']) {
    const p = path.join(s.ws, f);
    await assert.rejects(s.check(p), (e: Error) => { msgs.push(e.message.replace(p, '<P>')); return e instanceof AccessDenied; });
  }
  assert.equal(new Set(msgs).size, 1);
  assert.match(msgs[0], /not a readable \.dwg or \.dxf drawing/);
  assert.equal(s.asks.length, 0);
});

test('a throwing isFile gives the generic denial, not the raw error', async () => {
  const s = setup();
  const f = path.join(s.ws, 'a.dwg'); touch(f);
  const check = createAccessCheck({ ...s.deps, isFile: async () => { throw new Error('EACCES secret'); } });
  await assert.rejects(check(f), (e: Error) => e instanceof AccessDenied && !/EACCES/.test(e.message));
});

test('root folder contains everything; trailing separator works', async () => {
  const s = setup();
  const f = path.join(s.outside, 'a.dwg'); touch(f);
  await createAccessCheck({ ...s.deps, workspaceFolders: async () => [path.parse(f).root] })(f);
  await createAccessCheck({ ...s.deps, workspaceFolders: async () => [s.outside + path.sep] })(f);
  assert.equal(s.asks.length, 0);
});

test('prompts for different paths are serialized', async () => {
  const s = setup();
  const f1 = path.join(s.outside, 'a.dwg'), f2 = path.join(s.outside, 'b.dwg'); touch(f1); touch(f2);
  let active = 0, maxActive = 0;
  const check = createAccessCheck({ ...s.deps, ask: async () => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((r) => setTimeout(r, 10)); active--; return true;
  } });
  await Promise.all([check(f1), check(f2)]);
  assert.equal(maxActive, 1);
});

test('an unanswered prompt times out as Deny for that call only, and the queue moves on', async () => {
  const s = setup();
  const f1 = path.join(s.outside, 'a.dwg'), f2 = path.join(s.outside, 'b.dwg'); touch(f1); touch(f2);
  const asked: string[] = [];
  const check = createAccessCheck({
    ...s.deps,
    askTimeoutMs: 30,
    // The first modal is never answered (e.g. it is in another window); later ones are.
    ask: (p) => { asked.push(p); return asked.length === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(true); },
  });
  const first = check(f1);
  const second = check(f2);
  await assert.rejects(first, (e: Error) => e instanceof AccessDenied && /did not answer/.test(e.message));
  assert.equal(await second, f2); // not blocked behind the unanswered one
  // Not remembered: the next call for the same file asks again.
  assert.equal(await check(f1), f1);
  assert.deepEqual(asked, [f1, f2, f1]);
});

test('the prompt timeout defaults to 60 s', async () => {
  const { ACCESS_PROMPT_TIMEOUT_MS } = await import('../src/ai/access');
  assert.equal(ACCESS_PROMPT_TIMEOUT_MS, 60_000);
});

test('registry hardening: relative, future, oversized ignored; modes; unique tmp', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiwin-')), 'reg');
  const a = new WindowRegistry(dir, 'a');
  await Promise.all([a.publish(['/x', 'rel/path']), a.publish(['/x', 'rel/path'])]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'a.json')).mode & 0o777, 0o600);
  }
  fs.writeFileSync(path.join(dir, 'fut.json'), JSON.stringify({ folders: ['/future'], updated: Date.now() + 60_000 }));
  fs.writeFileSync(path.join(dir, 'big.json'), JSON.stringify({ folders: ['/big'], updated: Date.now(), pad: 'x'.repeat(70_000) }));
  assert.deepEqual(await a.folders(), ['/x']);
});

test('registry: union of windows; stale and corrupt ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwin-'));
  const a = new WindowRegistry(dir, 'a'); const b = new WindowRegistry(dir, 'b');
  await a.publish(['/x', '/y']); await b.publish(['/y', '/z']);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ folders: ['/old'], updated: Date.now() - 61_000 }));
  fs.writeFileSync(path.join(dir, 'odd.json'), JSON.stringify({ folders: [1, '/ok'], updated: Date.now() }));
  assert.deepEqual((await a.folders()).sort(), ['/ok', '/x', '/y', '/z']);
  await b.dispose();
  assert.deepEqual((await a.folders()).sort(), ['/ok', '/x', '/y']);
  assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.tmp')));
});
