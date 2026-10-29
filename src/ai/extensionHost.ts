import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DiskCache, clearDrawingCache } from './diskCache';
import { createAccessCheck } from './access';
import { WindowRegistry } from './windows';
import { startMcpServer, type RunningServer } from './server';
import {
  CLAUDE_EXTENSION_ID, MCP_DOCS_URL, SERVER_NAME, authorizationHeader, claudeAddCommandText, claudeRemoveArgs, connectClaude, disconnectClaude, findClaudeCli,
  isServerNotFound, lookupCommand, outsideDir,
} from './connect';
import { claudeCodePresent, startsAtStartup, startDecision } from './startup';
import { DwgEditorProvider } from '../dwgEditorProvider';
import type { DrawingStore } from './drawingStore';
import type { PreviewBridge } from './previewBridge';

const TOKEN_KEY = 'dwgPreviewer.ai.token';
const PUBLISH_MS = 20_000;

const realpath = promisify(fs.realpath.native);

async function getOrCreateToken(secrets: vscode.SecretStorage): Promise<string> {
  const existing = await secrets.get(TOKEN_KEY);
  if (existing) return existing;
  await secrets.store(TOKEN_KEY, randomBytes(32).toString('hex'));
  // Another window may have stored its own at the same moment: use what ended up stored.
  const stored = await secrets.get(TOKEN_KEY);
  if (!stored) throw new Error('Could not store the AI access token');
  return stored;
}

interface Running {
  port: number;
  token: string;
  disk: DiskCache;
  registry: WindowRegistry;
  timer: NodeJS.Timeout;
  folderSub: vscode.Disposable;
  server: RunningServer;
}

/**
 * Starts the AI side (local MCP server, window registry, disk cache, Copilot provider)
 * when `dwgPreviewer.ai.enabled` is on, and keeps it in step with the setting, the port
 * and the shared token. With the setting off nothing runs and nothing is written.
 */
export interface AiFeature extends vscode.Disposable {
  /** Disposes the feature and resolves once the server is closed and the registry file removed. */
  stopped(): Promise<void>;
  /** The running server's url and token, or undefined while the feature is off or not started. */
  current(): { url: string; token: string } | undefined;
}

const PROMPTED_KEY = 'dwgPreviewer.ai.prompted';
const CONNECTED_KEY = 'dwgPreviewer.ai.connected';
const REGISTERED_KEY = 'dwgPreviewer.ai.registeredKey';
/** Set on intent (Connect, setup for other agents, Copilot), not by opening a drawing: from then on it starts with VS Code. */
const USED_KEY = 'dwgPreviewer.ai.used';

function which(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    // On Windows `where $PATH:name` searches PATH only (plain `where` tries the current directory first);
    // anything found in the lookup's working directory is dropped all the same.
    const cwd = os.tmpdir();
    const { file, args } = lookupCommand(name);
    execFile(file, args, { timeout: 5000, windowsHide: true, cwd }, (err, out) => {
      resolve(err ? [] : outsideDir(String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean), cwd));
    });
  });
}

const keyOf = (url: string, token: string) => createHash('sha256').update(`${url}\n${token}`).digest('hex');

export function startAiFeature(
  context: vscode.ExtensionContext,
  store: DrawingStore,
  bridge: PreviewBridge,
  log: (msg: string) => void
): AiFeature {
  const storage = context.globalStorageUri;
  const cacheDir = () => vscode.Uri.joinPath(storage, 'drawing-cache').fsPath;
  const windowsDir = () => vscode.Uri.joinPath(storage, 'ai-windows').fsPath;

  let running: Running | undefined;
  /** Ports the user was already warned about this session. */
  const warnedPorts = new Set<number>();
  let onServerState: () => void = () => {};
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  const definitionsChanged = new vscode.EventEmitter<void>();

  const ownFolders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  async function stop(): Promise<void> {
    const r = running;
    if (!r) return;
    running = undefined;
    clearInterval(r.timer);
    r.folderSub.dispose();
    store.setDisk(undefined);
    await r.server.close().catch(() => {});
    await r.registry.dispose().catch(() => {});
    log('AI server stopped');
    definitionsChanged.fire();
  }

  async function start(port: number): Promise<void> {
    const token = await getOrCreateToken(context.secrets);
    const disk = new DiskCache(cacheDir());
    const registry = new WindowRegistry(windowsDir(), vscode.env.sessionId);
    const publish = () => registry.publish(ownFolders()).catch((e) => log(`Window registry publish failed: ${String(e)}`));
    await publish();
    const timer = setInterval(() => void publish(), PUBLISH_MS);
    const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => void publish());

    const checkAccess = createAccessCheck({
      workspaceFolders: async () => [...new Set([...ownFolders(), ...(await registry.folders())])],
      openPreviews: () => bridge.openPaths(),
      realpath: (p) => realpath(p),
      isFile: async (p) => {
        try {
          return (await fs.promises.stat(p)).isFile();
        } catch {
          return false;
        }
      },
      ask: async (p) => {
        try {
          const answer = await vscode.window.showWarningMessage(
            `Allow the AI agent to read ${path.basename(p)} (${p})?`,
            { modal: true },
            'Allow'
          );
          return answer === 'Allow';
        } catch {
          return false;
        }
      },
    });

    store.setDisk(disk);
    let server: RunningServer;
    try {
      server = await startMcpServer({ port, token, host: { store, checkAccess, preview: bridge }, log });
    } catch (e) {
      store.setDisk(undefined);
      clearInterval(timer);
      folderSub.dispose();
      await registry.dispose().catch(() => {});
      throw e;
    }
    running = { port, token, disk, registry, timer, folderSub, server };
    const report = () => {
      switch (server.state) {
        case 'serving':
          log(`AI server serving on ${server.url}`);
          break;
        case 'standby':
          log(`AI server standing by: another DWG Previewer window serves port ${port}`);
          break;
        case 'occupied':
          log(`AI server off: port ${port} is used by another program`);
          // Once per port per session: the server keeps retrying quietly in case the port frees.
          if (!warnedPorts.has(port)) {
            warnedPorts.add(port);
            void vscode.window.showWarningMessage(
              `Port ${port} is used by another program, so AI features are off. Change dwgPreviewer.ai.port.`
            );
          }
          break;
        case 'failed':
          log(`AI server could not listen on port ${port}: ${server.error}`);
          if (!warnedPorts.has(port)) {
            warnedPorts.add(port);
            void vscode.window.showWarningMessage(`DWG Previewer AI features are off: the local server could not listen on port ${port} (${server.error}).`);
          }
          break;
      }
    };
    report();
    server.onStateChange(() => {
      report();
      onServerState();
      definitionsChanged.fire();
    });
    onServerState();
    definitionsChanged.fire();
  }

  async function apply(): Promise<void> {
    if (disposed || !wanted) return;
    const cfg = vscode.workspace.getConfiguration('dwgPreviewer');
    if (!cfg.get<boolean>('ai.enabled', true)) {
      await stop();
      return;
    }
    const port = cfg.get<number>('ai.port', 45131);
    const token = await getOrCreateToken(context.secrets);
    if (running && running.port === port && running.token === token) return;
    await stop();
    if (disposed) return;
    await start(port);
  }

  // ---- Lazy start ----
  const state = context.globalState;
  /** Whether the AI side should run in this session; until then nothing (not even the keyring) is touched. */
  let wanted = startsAtStartup({ connected: state.get<boolean>(CONNECTED_KEY), used: state.get<boolean>(USED_KEY) });
  /**
   * Starts the AI side now if it is not running yet. With `intent` (Connect, setup, Copilot) it is also
   * remembered for the next startup; merely opening a drawing is not.
   */
  const ensureStarted = (intent = true): Promise<void> => {
    const d = startDecision({ wanted, used: state.get<boolean>(USED_KEY) === true, intent });
    if (d.remember) void state.update(USED_KEY, true);
    if (d.start) {
      wanted = true;
      log('Starting the AI server on first use');
      return schedule();
    }
    return queue;
  };

  const schedule = () => {
    queue = queue.then(apply).catch((e) => log(`AI server could not start: ${e instanceof Error ? e.message : String(e)}. It will try again when the AI settings change.`));
    return queue;
  };

  const subs: vscode.Disposable[] = [
    definitionsChanged,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dwgPreviewer.ai')) void schedule();
    }),
    context.secrets.onDidChange((e) => {
      if (e.key === TOKEN_KEY) void schedule();
    }),
    // Works with AI on or off: a cache written while it was on must still be removable.
    vscode.commands.registerCommand('dwgPreviewer.clearDrawingCache', async () => {
      try {
        const n = await clearDrawingCache(cacheDir());
        void vscode.window.showInformationMessage(`Removed ${n} cached drawing${n === 1 ? '' : 's'}.`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not clear the drawing cache: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  ];

  // ---- Connect Claude Code / other agents ----
  /** The server agents should use: ours or another DWG Previewer window's. Never a port another program holds. */
  const reachable = (r: Running | undefined): r is Running => !!r && (r.server.state === 'serving' || r.server.state === 'standby');
  const current = () => (reachable(running) ? { url: running.server.url, token: running.token } : undefined);
  const notRunningMessage = () => {
    const r = running;
    if (r?.server.state === 'occupied') {
      return `Port ${r.port} is used by another program, so AI features are off. Change dwgPreviewer.ai.port.`;
    }
    if (r?.server.state === 'failed') return `The AI server could not listen on port ${r.port}: ${r.server.error}`;
    return 'The AI server is not running. Turn on dwgPreviewer.ai.enabled first.';
  };

  const findCli = () =>
    findClaudeCli({
      which,
      claudeExtensionPath: () => vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)?.extensionPath,
      exists: async (p) => {
        try {
          return (await fs.promises.stat(p)).isFile();
        } catch {
          return false;
        }
      },
    });

  async function showManual(url: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Claude Code was not found. Run this in a terminal where \`claude\` works (replace <token> with the token from "Show setup for other agents"): ${claudeAddCommandText(url)}`,
      'Copy command',
      'Open docs'
    );
    if (choice === 'Copy command') await vscode.env.clipboard.writeText(claudeAddCommandText(url));
    else if (choice === 'Open docs') await vscode.env.openExternal(vscode.Uri.parse(MCP_DOCS_URL));
  }

  async function connect(): Promise<boolean> {
    await ensureStarted();
    const cur = current();
    if (!cur) {
      void vscode.window.showWarningMessage(notRunningMessage());
      return false;
    }
    const cli = await findCli();
    if (!cli) {
      if (vscode.env.remoteName) {
        void vscode.window.showInformationMessage(
          "This is a remote window and Claude Code was not found in it, so it cannot reach this window's local drawing server. Install the Claude Code extension in the remote window, then Connect again."
        );
      }
      await showManual(cur.url);
      return false;
    }
    const r = await connectClaude(cli, cur.url, cur.token);
    if (!r.ok) {
      log(`Connect failed: ${r.error}`);
      await state.update(CONNECTED_KEY, false);
      await state.update(REGISTERED_KEY, undefined);
      void vscode.window.showErrorMessage(r.error);
      return false;
    }
    await state.update(CONNECTED_KEY, true);
    await state.update(REGISTERED_KEY, keyOf(cur.url, cur.token));
    void vscode.window.showInformationMessage('Connected. New Claude Code conversations can read drawings.');
    return true;
  }

  async function disconnect(): Promise<void> {
    const cli = await findCli();
    if (!cli) {
      // Stop automatic re-registering; nothing here can remove the entry.
      await state.update(CONNECTED_KEY, false);
      await state.update(REGISTERED_KEY, undefined);
      void vscode.window.showWarningMessage(
        `Claude Code was not found, so the "${SERVER_NAME}" entry could not be removed. If it is still registered, run \`claude ${claudeRemoveArgs().join(' ')}\` yourself. DWG Previewer will no longer update it automatically.`
      );
      return;
    }
    const r = await disconnectClaude(cli, current()?.token ?? '');
    if (r.ok || isServerNotFound(r.error)) {
      await state.update(CONNECTED_KEY, false);
      await state.update(REGISTERED_KEY, undefined);
      void vscode.window.showInformationMessage(r.ok ? 'Disconnected Claude Code.' : 'Claude Code was already disconnected.');
    } else {
      log(`Disconnect failed: ${r.error}`);
      void vscode.window.showErrorMessage(`Could not disconnect Claude Code: ${r.error}`);
    }
  }

  // After a port or token change, keep a previous Connect working. Never a first-time connect.
  let reconnecting = false;
  const reconnectIfNeeded = async () => {
    const cur = current();
    if (!cur || reconnecting || !state.get<boolean>(CONNECTED_KEY)) return;
    if (state.get<string>(REGISTERED_KEY) === keyOf(cur.url, cur.token)) return;
    reconnecting = true;
    try {
      const cli = await findCli();
      if (!cli) return;
      const r = await connectClaude(cli, cur.url, cur.token);
      if (r.ok) {
        await state.update(REGISTERED_KEY, keyOf(cur.url, cur.token));
        log('Re-registered Claude Code after the server address changed');
      } else {
        log(`Re-registering Claude Code failed: ${r.error}`);
        await state.update(CONNECTED_KEY, false);
        await state.update(REGISTERED_KEY, undefined);
        void vscode.window.showWarningMessage(`DWG Previewer could not update Claude Code after the server address changed. ${r.error}`);
      }
    } finally {
      reconnecting = false;
    }
  };
  subs.push(definitionsChanged.event(() => void reconnectIfNeeded()));

  subs.push(
    vscode.commands.registerCommand('dwgPreviewer.connectAgents', async () => {
      const pick = await vscode.window.showQuickPick(
        ['Connect Claude Code', 'Disconnect Claude Code', 'Show setup for other agents'],
        { placeHolder: 'Connect AI agents to the drawing tools' }
      );
      if (pick === 'Connect Claude Code') await connect();
      else if (pick === 'Disconnect Claude Code') await disconnect();
      else if (pick) {
        await ensureStarted();
        const cur = current();
        if (!cur) {
          void vscode.window.showWarningMessage(notRunningMessage());
          return;
        }
        // The token is never written into a document (untitled documents can be backed up to disk).
        const choice = await vscode.window.showInformationMessage(
          `Other agents (Kiro and others) connect to a remote HTTP MCP server (name it "${SERVER_NAME}"). The JSON format differs per agent, so check your agent's MCP documentation and give it this URL and an Authorization header.`,
          'Copy URL',
          'Copy Authorization header'
        );
        if (choice === 'Copy URL') await vscode.env.clipboard.writeText(cur.url);
        else if (choice === 'Copy Authorization header') await vscode.env.clipboard.writeText(authorizationHeader(cur.token));
      }
    })
  );

  // First time a drawing opens: offer to connect, only to someone who has Claude Code. Asked at most once
  // per session and only while the server is serving; only Connect or "Don't ask again" stop it for good.
  let present: Promise<boolean> | undefined;
  const hasClaudeCode = () =>
    (present ??= claudeCodePresent({ extensionInstalled: () => !!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID), which }));
  let asking = false;
  let askedThisSession = false;
  let drawingOpened = false;
  const maybePrompt = async () => {
    if (!drawingOpened || asking || askedThisSession || disposed || state.get<boolean>(PROMPTED_KEY)) return;
    if (!vscode.workspace.getConfiguration('dwgPreviewer').get<boolean>('ai.enabled', true)) return;
    if (!running?.server.serving) return; // retried when the server starts serving
    asking = true;
    try {
      if (!(await hasClaudeCode())) return;
      if (disposed) return;
      askedThisSession = true;
      const answer = await vscode.window.showInformationMessage('Let Claude Code read your drawings?', 'Connect', 'Not now', "Don't ask again");
      if (answer === 'Connect') {
        await state.update(PROMPTED_KEY, true);
        await connect();
      } else if (answer === "Don't ask again") await state.update(PROMPTED_KEY, true);
    } finally {
      asking = false;
    }
  };
  onServerState = () => void maybePrompt();
  const isDrawingTab = (t: vscode.Tab) =>
    (t.input as any)?.viewType === DwgEditorProvider.viewType;
  subs.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.opened.some(isDrawingTab)) {
        drawingOpened = true;
        void ensureStarted(false);
        void maybePrompt();
      }
    })
  );
  if (vscode.window.tabGroups.all.some((g) => g.tabs.some(isDrawingTab))) {
    drawingOpened = true;
    void ensureStarted(false);
    void maybePrompt();
  }

  // Copilot (VS Code 1.101+) discovers the server through a provider; older hosts lack the API.
  // Listing the server touches nothing; Copilot resolving it (about to use it) starts the AI side.
  const lm = (vscode as any).lm;
  if (typeof lm?.registerMcpServerDefinitionProvider === 'function') {
    const definition = (url: string, token?: string) =>
      new (vscode as any).McpHttpServerDefinition('DWG Previewer', vscode.Uri.parse(url), token ? { Authorization: `Bearer ${token}` } : {});
    subs.push(
      lm.registerMcpServerDefinitionProvider('dwgPreviewer.mcp', {
        onDidChangeMcpServerDefinitions: definitionsChanged.event,
        provideMcpServerDefinitions: () => {
          const cfg = vscode.workspace.getConfiguration('dwgPreviewer');
          if (!cfg.get<boolean>('ai.enabled', true)) return [];
          const r = running;
          if (reachable(r)) return [definition(r.server.url, r.token)];
          if (r || wanted) return []; // started, but another program holds the port or listening failed
          return [definition(`http://127.0.0.1:${cfg.get<number>('ai.port', 45131)}/mcp`)];
        },
        resolveMcpServerDefinition: async () => {
          await ensureStarted();
          const r = running;
          return reachable(r) ? definition(r.server.url, r.token) : undefined;
        },
      })
    );
  }

  if (wanted) void schedule();

  let stopping: Promise<void> | undefined;
  const stopped = () => {
    if (!stopping) {
      disposed = true;
      for (const s of subs) s.dispose();
      stopping = queue.then(stop).catch(() => {});
    }
    return stopping;
  };
  return { dispose: () => void stopped(), stopped, current };
}
