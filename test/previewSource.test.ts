import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewSource } from '../src/previewSource';

const uri = (scheme: string, fsPath: string, str: string) => ({ scheme, fsPath, toString: () => str });

test('a file: drawing is read from its real path, shared with the agent', () => {
  const src = previewSource(uri('file', '/w/link.dwg', 'file:///w/link.dwg'), (p) => (p === '/w/link.dwg' ? '/real/a.dwg' : p));
  assert.deepEqual(src, { kind: 'file', path: '/real/a.dwg' });
});

test('a git: revision (old side of a diff) is read through VS Code, never from the working file', () => {
  let resolved = false;
  const src = previewSource(
    uri('git', '/w/a.dwg', 'git:/w/a.dwg?%7B%22ref%22%3A%22HEAD%22%7D'),
    (p) => { resolved = true; return p; }
  );
  assert.deepEqual(src, { kind: 'memory', key: 'git:/w/a.dwg?%7B%22ref%22%3A%22HEAD%22%7D' });
  assert.equal(resolved, false);
});

test('other non-file schemes (vscode-vfs, vscode-remote) are memory-only, keyed by the full uri', () => {
  assert.deepEqual(previewSource(uri('vscode-vfs', '/github/o/r/a.dxf', 'vscode-vfs://github/o/r/a.dxf'), (p) => p), {
    kind: 'memory',
    key: 'vscode-vfs://github/o/r/a.dxf',
  });
});
