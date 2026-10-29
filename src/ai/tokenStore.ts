import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The part of VS Code's SecretStorage this module needs. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

const LOCK_NAME = 'ai-token.lock';
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const RETRY_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isStale(lock: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lock);
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Reads the shared AI token, creating it under an exclusive lock if this is the
 * first window. Two VS Code windows starting together must agree on one token:
 * the server identity probe uses it to tell a standby window from a stranger.
 */
export async function getOrCreateToken(secrets: SecretStore, dir: string, key: string): Promise<string> {
  const existing = await secrets.get(key);
  if (existing) return existing;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  const lock = path.join(dir, LOCK_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another window is creating it. It may already have stored the token;
      // read again before waiting, and recover from a crashed window's lock.
      const stored = await secrets.get(key);
      if (stored) return stored;
      if (await isStale(lock)) {
        await fs.rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the AI access token lock');
      await sleep(RETRY_MS);
      continue;
    }

    try {
      // Re-read while holding the lock: another window may have stored the
      // token between our first read and our lock acquisition.
      const stored = await secrets.get(key);
      if (stored) return stored;
      const token = randomBytes(32).toString('hex');
      await secrets.store(key, token);
      const after = await secrets.get(key);
      if (!after) throw new Error('Could not store the AI access token');
      return after;
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
    }
  }
}
