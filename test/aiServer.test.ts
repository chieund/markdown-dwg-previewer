import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as http from 'node:http';
import { startMcpServer, identityProof, probeIdentity, IDENTITY_PATH, type RunningServer } from '../src/ai/server';
import { DrawingStore } from '../src/ai/drawingStore';
import { parseDxf } from '../src/dxf/parseDxf';
import type { ToolHost } from '../src/ai/tools';

const TOKEN = 'secret-token-123';

const DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '100', '21', '50', '31', '0',
  '0', 'MTEXT', '8', 'TEXT', '10', '10', '20', '10', '30', '0', '40', '5', '1', 'hello',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

function host(): ToolHost {
  const parsed = parseDxf(DXF);
  return {
    store: new DrawingStore({ stat: async () => ({ mtimeMs: 1, size: 1 }), parse: async () => parsed, capacity: 2 }),
    checkAccess: async (p) => p,
  };
}

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

async function start(port: number, token = TOKEN, logs: string[] = []): Promise<RunningServer> {
  return startMcpServer({ port, token, host: host(), log: (m) => logs.push(m), retryMs: 100 });
}

/** Another program on the port: answers everything with 404. */
function squatter(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const s = http.createServer((_req, res) => { res.writeHead(404); res.end('nope'); });
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function rpc(url: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  const body = data ? data.slice(5).trim() : text;
  return { status: res.status, json: JSON.parse(body) };
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } };

test('initialize and tools/list return the five tools', async () => {
  const s = await start(await freePort());
  try {
    assert.equal(s.serving, true);
    const init = await rpc(s.url, 'initialize', INIT);
    assert.equal(init.status, 200);
    const list = await rpc(s.url, 'tools/list', {});
    const names = list.json.result.tools.map((t: { name: string }) => t.name);
    assert.equal(names.length, 5);
    assert.ok(names.includes('dwg_overview'));
  } finally {
    await s.close();
  }
});

test('tools/call dwg_overview returns JSON text', async () => {
  const s = await start(await freePort());
  try {
    const r = await rpc(s.url, 'tools/call', { name: 'dwg_overview', arguments: { path: '/d.dxf' } });
    const c = r.json.result.content[0];
    assert.equal(c.type, 'text');
    assert.ok(JSON.parse(c.text).pages);
  } finally {
    await s.close();
  }
});

test('auth, origin and path checks happen before the SDK', async () => {
  const s = await start(await freePort());
  try {
    const noTok = await fetch(s.url, { method: 'POST', body: '{}' });
    assert.equal(noTok.status, 401);
    const wrong = await fetch(s.url, { method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);
    const short = await fetch(s.url, { method: 'POST', body: '{}', headers: { authorization: 'Bearer x' } });
    assert.equal(short.status, 401);
    const origin = await rpc(s.url, 'tools/list', {}, { origin: 'http://evil.example' }).catch(() => null);
    assert.equal(origin, null); // 403 body is not JSON-RPC
    const o2 = await fetch(s.url, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' } });
    assert.equal(o2.status, 403);
    const other = await fetch(s.url.replace('/mcp', '/other'), { method: 'POST', body: '{}', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(other.status, 404);
  } finally {
    await s.close();
  }
});

test('standby: B waits while A serves and takes over when A closes', async () => {
  const port = await freePort();
  const a = await start(port);
  const b = await start(port);
  try {
    assert.equal(a.serving, true);
    assert.equal(b.serving, false);
    const flips: boolean[] = [];
    b.onServingChange((v: boolean) => flips.push(v));
    await a.close();
    const t0 = Date.now();
    while (!b.serving && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.serving, true);
    assert.deepEqual(flips, [true]);
    const list = await rpc(b.url, 'tools/list', {});
    assert.equal(list.json.result.tools.length, 5);
  } finally {
    await a.close();
    await b.close();
  }
});

test('close stops a standby instance from retrying', async () => {
  const port = await freePort();
  const a = await start(port);
  const b = await start(port);
  await b.close();
  await a.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.serving, false);
});

test('the identity endpoint proves the token without revealing it', async () => {
  const port = await freePort();
  const s = await start(port);
  try {
    const nonce = 'abc123nonce';
    const res = await fetch(s.url.replace('/mcp', IDENTITY_PATH), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    assert.equal(res.status, 200);
    const body = await res.json() as { proof: string };
    assert.equal(body.proof, identityProof(TOKEN, nonce, port));
    assert.notEqual(identityProof(TOKEN, nonce, port), identityProof('other-token', nonce, port));
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
    const origin = await fetch(s.url.replace('/mcp', IDENTITY_PATH), { method: 'POST', headers: { origin: 'http://evil.example' }, body: JSON.stringify({ nonce }) });
    assert.equal(origin.status, 403);
  } finally {
    await s.close();
  }
});

test('probeIdentity: ours, another token, another program, nobody', async () => {
  const port = await freePort();
  const a = await start(port);
  try {
    assert.equal(await probeIdentity(port, TOKEN), true);
    assert.equal(await probeIdentity(port, 'some-other-token'), false);
  } finally {
    await a.close();
  }
  const sq = await squatter(port);
  try {
    assert.equal(await probeIdentity(port, TOKEN), false);
  } finally {
    await new Promise((r) => sq.close(r));
  }
  assert.equal(await probeIdentity(port, TOKEN, 500), false);
});

test('the identity proof is bound to the port: a server on port A does not pass a probe for port B', async () => {
  const portA = await freePort();
  const portB = await freePort();
  const a = await start(portA);
  try {
    assert.equal(await probeIdentity(portA, TOKEN), true);
    assert.notEqual(identityProof(TOKEN, 'nonce-12345', portA), identityProof(TOKEN, 'nonce-12345', portB));
    // forward A's port-bound answer to a prober that thinks it is talking to port B
    const fwd = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const r = http.request({ host: '127.0.0.1', port: portA, path: IDENTITY_PATH, method: 'POST' }, (up) => up.pipe(res));
        r.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((r) => fwd.listen(portB, '127.0.0.1', r));
    try {
      assert.equal(await probeIdentity(portB, TOKEN), false);
    } finally {
      await new Promise((r) => fwd.close(r));
    }
  } finally {
    await a.close();
  }
});

test('port held by our own other window: standby', async () => {
  const port = await freePort();
  const a = await start(port);
  const logs: string[] = [];
  const b = await start(port, TOKEN, logs);
  try {
    assert.equal(b.state, 'standby');
    assert.equal(b.serving, false);
    assert.ok(logs.some((l) => /another DWG Previewer window/.test(l)), logs.join('\n'));
  } finally {
    await a.close();
    await b.close();
  }
});

test('port held by another program: occupied, keeps retrying, serves once it frees', async () => {
  const port = await freePort();
  const sq = await squatter(port);
  const logs: string[] = [];
  const b = await start(port, TOKEN, logs);
  try {
    assert.equal(b.state, 'occupied');
    assert.equal(b.serving, false);
    assert.ok(logs.some((l) => /another program/.test(l)), logs.join('\n'));
    const states: string[] = [];
    b.onStateChange((st) => states.push(st));
    await new Promise((r) => sq.close(r));
    const t0 = Date.now();
    while (!b.serving && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.state, 'serving');
    assert.deepEqual(states, ['serving']);
  } finally {
    await b.close();
  }
});

test('port held by a DWG server with a different token counts as another program', async () => {
  const port = await freePort();
  const a = await start(port, 'a-different-token-xyz');
  const b = await start(port);
  try {
    assert.equal(b.state, 'occupied');
  } finally {
    await a.close();
    await b.close();
  }
});

test('a listen error other than EADDRINUSE is reported with its real reason', async () => {
  const logs: string[] = [];
  // 192.0.2.1 (TEST-NET-1) is not an address of this machine: EADDRNOTAVAIL.
  const s = await startMcpServer({ port: await freePort(), token: TOKEN, host: host(), log: (m) => logs.push(m), retryMs: 100, bindHost: '192.0.2.1' });
  try {
    assert.equal(s.state, 'failed');
    assert.match(s.error ?? '', /EADDRNOTAVAIL|address not available|cannot assign/i);
    assert.equal(logs.some((l) => /in use/i.test(l)), false, logs.join('\n'));
  } finally {
    await s.close();
  }
});

test('a failed tool call is an MCP error result (isError)', async () => {
  const s = await start(await freePort());
  try {
    const bad = await rpc(s.url, 'tools/call', { name: 'dwg_overview', arguments: {} });
    assert.equal(bad.json.result.isError, true);
    assert.match(bad.json.result.content[0].text, /^Error: path is required/);
    const good = await rpc(s.url, 'tools/call', { name: 'dwg_overview', arguments: { path: '/d.dxf' } });
    assert.equal(good.json.result.isError, undefined);
  } finally {
    await s.close();
  }
});
