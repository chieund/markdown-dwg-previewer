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

async function readLock(lock: string): Promise<{ id: string; mtimeMs: number } | undefined> {
  try {
    const [id, stat] = await Promise.all([fs.readFile(lock, 'utf-8'), fs.stat(lock)]);
    return { id, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Removes a lock left by a crashed window. Two windows may judge the same
 * lock stale; the first one breaks it and takes a new one, so the second must
 * not delete that. The lock is moved aside atomically and checked: if it is
 * not the one judged stale, it is put back.
 */
async function breakStaleLock(lock: string, staleId: string): Promise<void> {
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await fs.rename(lock, aside);
  } catch {
    return; // Someone else already moved it
  }
  try {
    if ((await fs.readFile(aside, 'utf-8')) !== staleId) {
      // A live lock: restore it unless a new one already took its place
      await fs.link(aside, lock).catch(() => {});
    }
  } finally {
    await fs.rm(aside, { force: true });
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

  const id = randomBytes(16).toString('hex');
  for (;;) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lock, 'wx', 0o600);
      await handle.writeFile(id);
    } catch (err) {
      await handle?.close();
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another window is creating it. It may already have stored the token;
      // read again before waiting, and recover from a crashed window's lock.
      const stored = await secrets.get(key);
      if (stored) return stored;
      const held = await readLock(lock);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await breakStaleLock(lock, held.id);
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
      // Only our own lock: a window that judged it stale may have replaced it
      if ((await readLock(lock))?.id === id) await fs.rm(lock, { force: true });
    }
  }
}
