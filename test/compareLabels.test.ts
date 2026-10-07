import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLabels, headContentProblem } from '../src/compareLabels';

test('a file against its Git revision names the revision', () => {
  assert.deepEqual(compareLabels('/w/plans/a.dwg', '/w/plans/a.dwg', 'HEAD'), { oldLabel: 'a.dwg (HEAD)', newLabel: 'a.dwg' });
});

test('two files with different names are told apart by name', () => {
  assert.deepEqual(compareLabels('/w/a-v1.dwg', '/w/a-v2.dwg'), { oldLabel: 'a-v1.dwg', newLabel: 'a-v2.dwg' });
});

test('two files with the same name are told apart by their folder', () => {
  assert.deepEqual(compareLabels('/w/old/plan.dwg', '/w/new/plan.dwg'), { oldLabel: 'old/plan.dwg', newLabel: 'new/plan.dwg' });
});


test('an empty HEAD read means the file is not in HEAD', () => {
  assert.match(headContentProblem(new Uint8Array()) ?? '', /not in HEAD/);
});

test('a Git LFS pointer is recognised instead of being called a corrupt drawing', () => {
  const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n');
  assert.match(headContentProblem(pointer) ?? '', /Git LFS/);
});

test('real drawing bytes are fine', () => {
  assert.equal(headContentProblem(Buffer.from('AC1032\0\0\0')), undefined);
});
