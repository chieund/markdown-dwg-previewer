import { execFile } from 'node:child_process';
import * as path from 'node:path';

/** Specific, so Connect and Disconnect never touch a user's own server with a generic name. */
export const SERVER_NAME = 'dwg-previewer';
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
export const MCP_DOCS_URL = 'https://code.claude.com/docs/en/mcp';

export function claudeAddArgs(url: string, token: string): string[] {
  return ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, url, '--header', `Authorization: Bearer ${token}`];
}

export function claudeRemoveArgs(): string[] {
  return ['mcp', 'remove', '--scope', 'user', SERVER_NAME];
}

/** The command as a user would type it, with the token shown as a placeholder when none is given. */
export function claudeAddCommandText(url: string, token = '<token>'): string {
  return `claude mcp add --scope user --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}

export interface CliDeps {
  /** All absolute paths the lookup (`which`/`where`) printed, in order. */
  which(name: string): Promise<string[]>;
  claudeExtensionPath(): string | undefined;
  exists(p: string): Promise<boolean>;
  platform?: string;
}

/**
 * The program that finds `name` on PATH. Windows' `where` also searches the current directory unless
 * told `$PATH:name`, which searches PATH only.
 */
export function lookupCommand(name: string, platform: string = process.platform): { file: string; args: string[] } {
  return platform === 'win32' ? { file: 'where', args: [`$PATH:${name}`] } : { file: 'which', args: [name] };
}

/** The lookup's results outside `dir` (its working directory): a program planted there is never run. */
export function outsideDir(lines: string[], dir: string, platform: string = process.platform): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const base = norm(p.resolve(dir));
  const prefix = base.endsWith(p.sep) ? base : base + p.sep;
  return lines.filter((l) => !norm(p.resolve(l)).startsWith(prefix));
}

/** PATH first, then the private copy bundled in the Claude Code VS Code extension. */
export async function findClaudeCli(deps: CliDeps): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  const isAbs = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const found = (await deps.which('claude')).map((l) => l.trim()).filter((l) => l && isAbs(l));
  // On Windows execFile can only run a real executable, not claude.cmd or an extensionless script.
  const onPath = platform === 'win32' ? found.find((l) => /\.exe$/i.test(l)) : found[0];
  if (onPath) return onPath;
  const ext = deps.claudeExtensionPath();
  if (!ext) return undefined;
  const names = platform === 'win32' ? ['claude.exe', 'claude'] : ['claude', 'claude.exe'];
  for (const n of names) {
    const p = path.join(ext, 'resources', 'native-binary', n);
    if (await deps.exists(p)) return p;
  }
  return undefined;
}

export function redact(text: string, token: string): string {
  return token ? text.split(token).join('<token>') : text;
}

export function authorizationHeader(token: string): string {
  return `Authorization: Bearer ${token}`;
}

export type RunResult = { ok: true } | { ok: false; error: string };

/** Runs the CLI without a shell; any message is redacted. */
export function runClaude(cli: string, args: string[], token: string, timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const raw = String(stderr).trim() || String(stdout).trim() || err.message;
      resolve({ ok: false, error: redact(raw, token).slice(0, 500) });
    });
  });
}

/** Registers the server: remove (failure ignored) then add. */
export async function connectClaude(cli: string, url: string, token: string): Promise<RunResult> {
  const removed = await runClaude(cli, claudeRemoveArgs(), token);
  const added = await runClaude(cli, claudeAddArgs(url, token), token);
  if (added.ok) return added;
  return { ok: false, error: addFailureMessage(added.error, removed.ok) };
}

export function addFailureMessage(reason: string, removedPrevious: boolean): string {
  return removedPrevious
    ? `The previous DWG connection was removed and the new one could not be added: ${reason}. Run DWG: Connect AI Agents… to try again.`
    : `The new DWG connection could not be added: ${reason}. Run DWG: Connect AI Agents… to try again.`;
}

/** The CLI's own "No MCP server found with name: …" — not any message that happens to say "not found". */
export function isServerNotFound(msg: string): boolean {
  return /no mcp server found/i.test(msg);
}

export async function disconnectClaude(cli: string, token: string): Promise<RunResult> {
  return runClaude(cli, claudeRemoveArgs(), token);
}
