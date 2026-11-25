import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FILE_AGENTS, connectFileAgent, disconnectFileAgent, hasServer, refreshFileAgent, withServer, withoutServer,
} from '../src/ai/agentConfig';

const URL = 'http://127.0.0.1:45131/mcp';
const cursor = FILE_AGENTS.find((a) => a.id === 'cursor')!;
const kiro = FILE_AGENTS.find((a) => a.id === 'kiro')!;
const home = () => fs.mkdtemp(path.join(os.tmpdir(), 'dwg-agents-'));

test('the server is added in the url + headers form both agents read', () => {
  assert.deepEqual(JSON.parse(withServer(undefined, URL, 'tok')), {
    mcpServers: { 'dwg-previewer': { url: URL, headers: { Authorization: 'Bearer tok' } } },
  });
});

test("the user's other servers and settings are kept", () => {
  const before = JSON.stringify({ theme: 'x', mcpServers: { github: { command: 'gh' }, 'dwg-previewer': { url: 'old' } } });
  const after = JSON.parse(withServer(before, URL, 'tok'));
  assert.equal(after.theme, 'x');
  assert.deepEqual(after.mcpServers.github, { command: 'gh' });
  assert.equal(after.mcpServers['dwg-previewer'].url, URL);
  assert.deepEqual(JSON.parse(withoutServer(JSON.stringify(after))!), { theme: 'x', mcpServers: { github: { command: 'gh' } } });
});

test('a file that is not plain JSON is refused, never rewritten', () => {
  assert.throws(() => withServer('{ // comment\n}', URL, 'tok', 'mcp.json'), /not plain JSON/);
  assert.throws(() => withServer('[]', URL, 'tok', 'mcp.json'), /JSON object/);
  assert.throws(() => withServer('{"mcpServers": []}', URL, 'tok', 'mcp.json'), /not an object/);
});

test('removing a server that is not there changes nothing', () => {
  assert.equal(withoutServer(undefined), undefined);
  assert.equal(withoutServer('{"mcpServers":{"github":{}}}'), undefined);
  assert.equal(hasServer('{"mcpServers":{"dwg-previewer":{}}}'), true);
  assert.equal(hasServer('not json'), false);
});

test('connect writes each agent its own file, private to the user', async (t) => {
  const h = await home();
  const file = await connectFileAgent(kiro, URL, 'tok', h);
  assert.equal(file, path.join(h, '.kiro', 'settings', 'mcp.json'));
  assert.equal(JSON.parse(await fs.readFile(file, 'utf-8')).mcpServers['dwg-previewer'].headers.Authorization, 'Bearer tok');
  assert.equal(await connectFileAgent(cursor, URL, 'tok', h), path.join(h, '.cursor', 'mcp.json'));
  if (process.platform === 'win32') return t.skip('POSIX permissions');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('a broken file is left exactly as it was', async () => {
  const h = await home();
  const file = cursor.configPath(h);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ broken');
  await assert.rejects(connectFileAgent(cursor, URL, 'tok', h), /not plain JSON/);
  assert.equal(await fs.readFile(file, 'utf-8'), '{ broken');
});

test('refresh updates a connected agent and never connects a new one', async () => {
  const h = await home();
  assert.equal(await refreshFileAgent(cursor, URL, 'new', h), false);
  await assert.rejects(fs.stat(cursor.configPath(h)), /ENOENT/);
  await connectFileAgent(cursor, URL, 'old', h);
  assert.equal(await refreshFileAgent(cursor, URL, 'new', h), true);
  assert.equal(await refreshFileAgent(cursor, URL, 'new', h), false);
  const servers = JSON.parse(await fs.readFile(cursor.configPath(h), 'utf-8')).mcpServers;
  assert.equal(servers['dwg-previewer'].headers.Authorization, 'Bearer new');
});

test('disconnect removes only this server', async () => {
  const h = await home();
  assert.equal(await disconnectFileAgent(kiro, h), false);
  await connectFileAgent(kiro, URL, 'tok', h);
  assert.equal(await disconnectFileAgent(kiro, h), true);
  assert.deepEqual(JSON.parse(await fs.readFile(kiro.configPath(h), 'utf-8')), { mcpServers: {} });
});
