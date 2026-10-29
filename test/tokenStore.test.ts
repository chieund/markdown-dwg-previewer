import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getOrCreateToken, type SecretStore } from '../src/ai/tokenStore';

const KEY = 'test.ai.token';

function fakeSecrets(initial?: string): SecretStore & { writes: number } {
  let value = initial;
  return {
    writes: 0,
    async get() {
      return value;
    },
    async store(_key, next) {
      this.writes++;
      value = next;
    },
  };
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'dwg-token-'));

test('a token is created once and then reused', async () => {
  const dir = await tmp();
  const secrets = fakeSecrets();
  const token = await getOrCreateToken(secrets, dir, KEY);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(await getOrCreateToken(secrets, dir, KEY), token);
  assert.equal(secrets.writes, 1);
});

test('two windows starting together agree on one token', async () => {
  const dir = await tmp();
  const secrets = fakeSecrets();
  const [a, b] = await Promise.all([
    getOrCreateToken(secrets, dir, KEY),
    getOrCreateToken(secrets, dir, KEY),
  ]);
  assert.equal(a, b);
  assert.equal(secrets.writes, 1);
});

test('a token already in the keyring is not replaced', async () => {
  const dir = await tmp();
  const secrets = fakeSecrets('already-here');
  assert.equal(await getOrCreateToken(secrets, dir, KEY), 'already-here');
  assert.equal(secrets.writes, 0);
});

test('a lock left by a crashed window is recovered', async () => {
  const dir = await tmp();
  const lock = path.join(dir, 'ai-token.lock');
  await fs.writeFile(lock, '');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lock, old, old);
  const secrets = fakeSecrets();
  const token = await getOrCreateToken(secrets, dir, KEY);
  assert.match(token, /^[0-9a-f]{64}$/);
  await assert.rejects(fs.stat(lock), /ENOENT/);
});
