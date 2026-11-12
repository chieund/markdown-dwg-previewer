/**
 * Connecting agents that read their MCP servers from a JSON file in the
 * user's home: Cursor (`~/.cursor/mcp.json`) and Kiro
 * (`~/.kiro/settings/mcp.json`). Both take a remote server as
 * `{ "url": …, "headers": { … } }` under `mcpServers`.
 *
 * The file belongs to the user: other servers and settings are kept as they
 * are, and a file that is not plain JSON is never rewritten.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SERVER_NAME, authorizationHeader } from './connect';

export interface FileAgent {
  id: 'cursor' | 'kiro';
  name: string;
  /** Path of the user-level config, under `home`. */
  configPath(home: string): string;
}

export const FILE_AGENTS: FileAgent[] = [
  { id: 'cursor', name: 'Cursor', configPath: (home) => path.join(home, '.cursor', 'mcp.json') },
  { id: 'kiro', name: 'Kiro', configPath: (home) => path.join(home, '.kiro', 'settings', 'mcp.json') },
];

type Config = Record<string, unknown> & { mcpServers?: Record<string, unknown> };

/** The config as an object; `undefined` text is an empty config. Throws on anything else. */
function parse(text: string | undefined, file: string): Config {
  if (text === undefined || !text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not plain JSON (comments or a syntax error?), so it was left untouched. Add the server by hand.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} does not hold a JSON object, so it was left untouched.`);
  const config = value as Config;
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    throw new Error(`"mcpServers" in ${file} is not an object, so it was left untouched.`);
  }
  return config;
}

/** The config text with this extension's server set to `url` and `token`; everything else kept. */
export function withServer(text: string | undefined, url: string, token: string, file = 'The config file'): string {
  const config = parse(text, file);
  const [name, value] = authorizationHeader(token).split(/:\s*/, 2);
  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: { url, headers: { [name]: value } } };
  return JSON.stringify(config, null, 2) + '\n';
}

/** The config text without this extension's server, or `undefined` when it was not there. */
export function withoutServer(text: string | undefined, file = 'The config file'): string | undefined {
  const config = parse(text, file);
  if (!config.mcpServers || !(SERVER_NAME in config.mcpServers)) return undefined;
  const { [SERVER_NAME]: _removed, ...rest } = config.mcpServers;
  config.mcpServers = rest;
  return JSON.stringify(config, null, 2) + '\n';
}

/** True when the config has this extension's server, whatever its address. */
export function hasServer(text: string | undefined): boolean {
  try {
    const servers = parse(text, '').mcpServers;
    return !!servers && SERVER_NAME in servers;
  } catch {
    return false;
  }
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Writes atomically, so the agent never reads half a file. The file holds the
 * token, so a new one is private to the user; an existing one keeps its mode.
 */
async function writeConfig(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mode = await fs.stat(file).then((s) => s.mode & 0o777, () => 0o600);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, text, { mode });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function connectFileAgent(agent: FileAgent, url: string, token: string, home = os.homedir()): Promise<string> {
  const file = agent.configPath(home);
  await writeConfig(file, withServer(await readIfExists(file), url, token, file));
  return file;
}

/** Removes the server; false when it was not registered. */
export async function disconnectFileAgent(agent: FileAgent, home = os.homedir()): Promise<boolean> {
  const file = agent.configPath(home);
  const next = withoutServer(await readIfExists(file), file);
  if (next === undefined) return false;
  await writeConfig(file, next);
  return true;
}

/**
 * Brings an existing registration up to date after the port or token changed.
 * Files without the server are left alone: this never connects an agent.
 */
export async function refreshFileAgent(agent: FileAgent, url: string, token: string, home = os.homedir()): Promise<boolean> {
  const file = agent.configPath(home);
  const text = await readIfExists(file);
  if (!hasServer(text)) return false;
  const next = withServer(text, url, token, file);
  if (next === text) return false;
  await writeConfig(file, next);
  return true;
}
