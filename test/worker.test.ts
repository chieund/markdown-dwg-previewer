import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { processDrawing } from '../src/dwg/pipeline';
import { DrawingWorker } from '../src/dwg/workerClient';

const dxfBytes = () =>
  Buffer.from(
    ['0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '1', '31', '0',
      '0', 'ENDSEC', '0', 'EOF'].join('\n')
  );

const WORKER = path.join(__dirname, '..', 'src', 'dwg', 'worker.js');
const CRASHING = path.join(__dirname, 'fixtures', 'crashWorker.js');

test('the pipeline parses DXF bytes and reports its stages', async () => {
  const stages: string[] = [];
  const parsed = await processDrawing(dxfBytes(), 'a.dxf', '', (stage) => stages.push(stage));
  assert.equal(parsed.pages[0].entities.length, 1);
  assert.deepEqual(stages, ['parsing']);
});

test('the pipeline explains a file that is not a drawing', async () => {
  await assert.rejects(processDrawing(Buffer.from('hello world'), 'notes.dwg', '', () => {}), /not a DWG or DXF/);
});

test('the worker parses a drawing off the calling thread', async () => {
  const worker = new DrawingWorker(WORKER);
  try {
    const stages: string[] = [];
    const parsed = await worker.run(dxfBytes(), 'a.dxf', '', (stage) => stages.push(stage));
    assert.equal(parsed.pages[0].entities.length, 1);
    assert.deepEqual(stages, ['parsing']);
  } finally {
    await worker.dispose();
  }
});

test('the worker passes errors back as rejections', async () => {
  const worker = new DrawingWorker(WORKER);
  try {
    await assert.rejects(worker.run(Buffer.from('hello world'), 'notes.dwg', '', () => {}), /not a DWG or DXF/);
  } finally {
    await worker.dispose();
  }
});

test('a worker that dies fails its job and the next job gets a fresh worker', async () => {
  const worker = new DrawingWorker(CRASHING);
  try {
    await assert.rejects(worker.run(dxfBytes(), 'a.dxf', '', () => {}), /stopped/);
    await assert.rejects(worker.run(dxfBytes(), 'a.dxf', '', () => {}), /stopped/);
  } finally {
    await worker.dispose();
  }
});
