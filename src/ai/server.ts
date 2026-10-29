import * as http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callToolResult, TOOL_DEFINITIONS, type ToolHost } from './tools';

export interface ServerOptions {
  port: number;
  token: string;
  host: ToolHost;
  log(msg: string): void;
  /** How often a standby instance retries binding the port. Default 5000. */
  retryMs?: number;
  /** Address to bind; tests only. The url always names 127.0.0.1. */
  bindHost?: string;
}

/**
 * - `serving`: this window serves the port.
 * - `standby`: another DWG Previewer window (same token) serves it; this one takes over when it frees.
 * - `occupied`: another program holds the port; nothing of ours is reachable there. Retried in case it frees.
 * - `failed`: listening failed for another reason (`error` says which). Retried.
 */
export type ServerState = 'serving' | 'standby' | 'occupied' | 'failed';

export interface RunningServer {
  readonly serving: boolean;
  readonly state: ServerState;
  /** The listen error's message while `state` is `failed`. */
  readonly error: string | undefined;
  readonly url: string;
  onServingChange(cb: (serving: boolean) => void): void;
  onStateChange(cb: (state: ServerState) => void): void;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

/**
 * Unauthenticated: answers a nonce with HMAC-SHA256(token, `${port}\n${nonce}`), which proves the token without
 * sending it. The port is part of the message so one server's answer cannot be replayed for another port.
 */
export const IDENTITY_PATH = '/mcp-identity';

export function identityProof(token: string, nonce: string, port: number): string {
  return createHmac('sha256', token).update(`${port}\n${nonce}`).digest('hex');
}

/**
 * True when whoever listens on `port` is a DWG Previewer server holding `token`.
 * The token itself is never sent: the occupant may be any program.
 */
export function probeIdentity(port: number, token: string, timeoutMs = 2000): Promise<boolean> {
  const nonce = randomBytes(16).toString('hex');
  const expected = Buffer.from(identityProof(token, nonce, port));
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = http.request(
      { host: HOST, port, path: IDENTITY_PATH, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 4096) return req.destroy();
          chunks.push(c);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(false);
          try {
            const proof = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { proof?: unknown }).proof;
            const given = Buffer.from(typeof proof === 'string' ? proof : '');
            finish(given.length === expected.length && timingSafeEqual(given, expected));
          } catch {
            finish(false);
          }
        });
        res.on('error', () => finish(false));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(false));
    req.on('close', () => finish(false));
    req.end(JSON.stringify({ nonce }));
  });
}

function answerIdentity(token: string, port: number, req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > 4096) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    let nonce: unknown;
    try {
      nonce = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { nonce?: unknown }).nonce;
    } catch {
      nonce = undefined;
    }
    if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 256) return reject(res, 400, 'Bad request');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ proof: identityProof(token, nonce, port) }));
  });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

function reject(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(message);
}

async function handleMcp(opts: ServerOptions, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Stateless: a fresh Server + transport per request.
  const server = new Server({ name: 'dwg-previewer', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS as never }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return callToolResult(opts.host, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>) as never;
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function startMcpServer(opts: ServerOptions): Promise<RunningServer> {
  let settle: () => void = () => {};
  const firstAttempt = new Promise<void>((r) => { settle = r; });
  const retryMs = opts.retryMs ?? 5000;
  const url = `http://${HOST}:${opts.port}/mcp`;
  const listeners: ((serving: boolean) => void)[] = [];
  const stateListeners: ((state: ServerState) => void)[] = [];
  let serving = false;
  let state: ServerState = 'standby';
  let error: string | undefined;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  /** The busy-port finding last written to the log, so a retry every few seconds logs only changes. */
  let reported: ServerState | undefined;

  const setServing = (v: boolean) => {
    if (serving === v) return;
    serving = v;
    for (const cb of listeners) {
      try { cb(v); } catch (e) { opts.log(`serving listener failed: ${String(e)}`); }
    }
  };
  const setState = (next: ServerState, message?: string) => {
    error = next === 'failed' ? message : undefined;
    if (state === next) return;
    state = next;
    setServing(next === 'serving');
    for (const cb of stateListeners) {
      try { cb(next); } catch (e) { opts.log(`state listener failed: ${String(e)}`); }
    }
  };

  const httpServer = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === IDENTITY_PATH && req.method === 'POST') {
      if (req.headers.origin !== undefined) return reject(res, 403, 'Forbidden');
      return answerIdentity(opts.token, req.socket.localPort ?? opts.port, req, res);
    }
    if (path !== '/mcp') return reject(res, 404, 'Not found');
    if (!tokenMatches(req.headers.authorization, opts.token)) return reject(res, 401, 'Unauthorized');
    if (req.headers.origin !== undefined) return reject(res, 403, 'Forbidden');
    handleMcp(opts, req, res).catch((e) => {
      opts.log(`MCP request failed: ${String(e)}`);
      if (!res.headersSent) reject(res, 500, 'Internal error');
      else res.end();
    });
  });

  const tryListen = () => {
    timer = undefined;
    if (closed) return;
    httpServer.listen(opts.port, opts.bindHost ?? HOST);
  };
  const retry = () => {
    if (!closed) timer = setTimeout(tryListen, retryMs);
  };

  httpServer.on('listening', () => {
    if (closed) {
      httpServer.close();
      return;
    }
    opts.log(`MCP server listening on ${url}`);
    reported = 'serving';
    setState('serving');
    settle();
  });
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (closed) return;
    if (err.code === 'EADDRINUSE') {
      // Never hand the token to whoever holds the port: ask it to prove it has the token instead.
      void probeIdentity(opts.port, opts.token).then((ours) => {
        if (closed) return;
        const next: ServerState = ours ? 'standby' : 'occupied';
        if (reported !== next) {
          reported = next;
          opts.log(
            ours
              ? `Port ${opts.port} is served by another DWG Previewer window; standing by`
              : `Port ${opts.port} is used by another program; AI features are off until it frees`
          );
        }
        setState(next);
        settle();
        retry();
      });
      return;
    }
    const message = err.code ? `${err.code}: ${err.message}` : err.message;
    if (reported !== 'failed' || error !== message) opts.log(`MCP server could not listen on port ${opts.port}: ${message}`);
    reported = 'failed';
    setState('failed', message);
    settle();
    retry();
  });

  tryListen();

  return firstAttempt.then(() => ({
    get serving() { return serving; },
    get state() { return state; },
    get error() { return error; },
    url,
    onServingChange(cb) { listeners.push(cb); },
    onStateChange(cb) { stateListeners.push(cb); },
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      return new Promise<void>((resolve) => {
        if (!httpServer.listening) { setServing(false); resolve(); return; }
        httpServer.close(() => { setServing(false); resolve(); });
        httpServer.closeAllConnections();
      });
    },
  } as RunningServer));
}
