import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { claudeAddArgs, claudeRemoveArgs, claudeAddCommandText, findClaudeCli, redact, authorizationHeader, addFailureMessage, isServerNotFound, runClaude, lookupCommand, outsideDir, SERVER_NAME } from '../src/ai/connect';
import { startsAtStartup, startDecision, claudeCodePresent } from '../src/ai/startup';

test('claudeAddArgs is the exact argument array', () => {
  assert.deepEqual(claudeAddArgs('http://127.0.0.1:45131/mcp', 'tok'), [
    'mcp', 'add', '--scope', 'user', '--transport', 'http', 'dwg-previewer', 'http://127.0.0.1:45131/mcp',
    '--header', 'Authorization: Bearer tok',
  ]);
});

test('claudeRemoveArgs', () => {
  assert.deepEqual(claudeRemoveArgs(), ['mcp', 'remove', '--scope', 'user', 'dwg-previewer']);
});

test('the registered name is specific, so a user server called "dwg" is never touched', () => {
  assert.equal(SERVER_NAME, 'dwg-previewer');
  assert.ok(claudeAddCommandText('http://u/mcp').includes(' dwg-previewer http://u/mcp '));
  assert.equal(claudeRemoveArgs().includes('dwg'), false);
});

const deps = (o: { which?: string | string[]; ext?: string; files?: string[]; platform?: string }) => ({
  which: async () => (Array.isArray(o.which) ? o.which : o.which ? [o.which] : []),
  claudeExtensionPath: () => o.ext,
  exists: async (p: string) => (o.files ?? []).includes(p),
  platform: o.platform ?? 'linux',
});

test('findClaudeCli prefers PATH', async () => {
  const ext = path.join('/e');
  const bundled = path.join(ext, 'resources', 'native-binary', 'claude');
  assert.equal(await findClaudeCli(deps({ which: '/usr/bin/claude', ext, files: [bundled] })), '/usr/bin/claude');
});

test('findClaudeCli falls back to the bundled binary', async () => {
  const ext = '/e';
  const bundled = path.join(ext, 'resources', 'native-binary', 'claude');
  assert.equal(await findClaudeCli(deps({ ext, files: [bundled] })), bundled);
});

test('findClaudeCli finds claude.exe on Windows', async () => {
  const ext = 'C:\\e';
  const exe = path.join(ext, 'resources', 'native-binary', 'claude.exe');
  assert.equal(await findClaudeCli(deps({ ext, files: [exe], platform: 'win32' })), exe);
});

test('findClaudeCli returns undefined when neither exists', async () => {
  assert.equal(await findClaudeCli(deps({ ext: '/e' })), undefined);
  assert.equal(await findClaudeCli(deps({})), undefined);
});

test('redact removes the token everywhere', () => {
  assert.equal(redact('failed: Authorization: Bearer abc123 and abc123', 'abc123').includes('abc123'), false);
  assert.equal(redact('nothing', ''), 'nothing');
});

test('win32: only a .exe from where is accepted, any line', async () => {
  const lines = ['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\bin\\claude.exe'];
  assert.equal(await findClaudeCli(deps({ which: lines, platform: 'win32' })), 'C:\\bin\\claude.exe');
});

test('win32: falls back to bundled exe when where gives only scripts; relative paths ignored', async () => {
  const ext = 'C:\\e';
  const exe = path.join(ext, 'resources', 'native-binary', 'claude.exe');
  assert.equal(await findClaudeCli(deps({ which: ['C:\\npm\\claude.cmd', 'claude.exe'], ext, files: [exe], platform: 'win32' })), exe);
  assert.equal(await findClaudeCli(deps({ which: ['C:\\npm\\claude.cmd'], platform: 'win32' })), undefined);
});

test('authorizationHeader', () => {
  assert.equal(authorizationHeader('t'), 'Authorization: Bearer t');
});

test('addFailureMessage says whether the previous connection was removed', () => {
  assert.match(addFailureMessage('boom', true), /previous DWG connection was removed.*boom.*Connect AI Agents/);
  assert.doesNotMatch(addFailureMessage('boom', false), /was removed/);
});

test('isServerNotFound matches only the CLI\'s own wording', () => {
  assert.ok(isServerNotFound('No MCP server found with name: dwg-previewer'));
  assert.ok(isServerNotFound('no mcp server found with name "dwg-previewer" in user config'));
  assert.ok(!isServerNotFound('permission denied'));
  assert.ok(!isServerNotFound('/bin/sh: claude: not found'));
  assert.ok(!isServerNotFound('Config file not found'));
});

test('lookupCommand: Windows searches PATH only, never the current directory', () => {
  assert.deepEqual(lookupCommand('claude', 'win32'), { file: 'where', args: ['$PATH:claude'] });
  assert.deepEqual(lookupCommand('claude', 'linux'), { file: 'which', args: ['claude'] });
  assert.deepEqual(lookupCommand('claude', 'darwin'), { file: 'which', args: ['claude'] });
});

test('outsideDir drops a result planted in the lookup\'s working directory', () => {
  const where = ['C:\\Users\\u\\AppData\\Local\\Temp\\claude.exe', 'C:\\tools\\claude.exe'];
  assert.deepEqual(outsideDir(where, 'C:\\Users\\u\\AppData\\Local\\Temp', 'win32'), ['C:\\tools\\claude.exe']);
  // case-insensitive on Windows, and a sub-folder of cwd is inside too
  assert.deepEqual(outsideDir(['c:\\users\\u\\appdata\\local\\temp\\x\\claude.exe'], 'C:\\Users\\u\\AppData\\Local\\Temp\\', 'win32'), []);
  // a sibling whose name only starts the same is kept
  assert.deepEqual(outsideDir(['C:\\Temp2\\claude.exe'], 'C:\\Temp', 'win32'), ['C:\\Temp2\\claude.exe']);
  assert.deepEqual(outsideDir(['/tmp/claude', '/usr/bin/claude'], '/tmp', 'linux'), ['/usr/bin/claude']);
});

test('lazy start: only users who connected or used AI before start the server at startup', () => {
  assert.equal(startsAtStartup({}), false);
  assert.equal(startsAtStartup({ connected: false, used: false }), false);
  assert.equal(startsAtStartup({ connected: true }), true);
  assert.equal(startsAtStartup({ used: true }), true);
});

test('start decision: opening a drawing starts the session but only intent is remembered', () => {
  assert.deepEqual(startDecision({ wanted: false, used: false, intent: false }), { start: true, remember: false });
  assert.deepEqual(startDecision({ wanted: false, used: false, intent: true }), { start: true, remember: true });
  // already running from a drawing open, then the user connects: now it is remembered
  assert.deepEqual(startDecision({ wanted: true, used: false, intent: true }), { start: false, remember: true });
  assert.deepEqual(startDecision({ wanted: true, used: false, intent: false }), { start: false, remember: false });
  assert.deepEqual(startDecision({ wanted: true, used: true, intent: true }), { start: false, remember: false });
});

test('claudeCodePresent: the extension or a claude on PATH; the lookup is skipped when the extension is there', async () => {
  let looked = 0;
  const which = (lines: string[]) => async () => { looked++; return lines; };
  assert.equal(await claudeCodePresent({ extensionInstalled: () => true, which: which([]) }), true);
  assert.equal(looked, 0);
  assert.equal(await claudeCodePresent({ extensionInstalled: () => false, which: which(['/usr/bin/claude']) }), true);
  assert.equal(await claudeCodePresent({ extensionInstalled: () => false, which: which([]) }), false);
  assert.equal(await claudeCodePresent({ extensionInstalled: () => false, which: async () => { throw new Error('x'); } }), false);
});

test('redaction happens before truncation (token straddling the 500 cut)', async () => {
  const token = 'SECRETTOKEN1234567890';
  const script = `process.stderr.write('x'.repeat(490) + '${token}' + 'y'.repeat(50)); process.exit(1)`;
  const r = await runClaude(process.execPath, ['-e', script], token);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.includes('SECRETTOKEN'), false);
    assert.equal(r.error.includes('1234567890'), false);
    assert.ok(r.error.includes('<token>'));
  }
});
