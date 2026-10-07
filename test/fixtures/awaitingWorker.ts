// Mirrors the real pipeline's shape: a DWG awaits its converter (the WASM
// load, a CLI tool), while a DXF parses at once — so `hang.dxf` blocks the
// thread without ever awaiting. Jobs go through the same serial queue as
// src/dwg/worker.ts; without it, the stuck DXF starts during the DWG's await.
import { parentPort } from 'worker_threads';
import { serialQueue } from '../../src/dwg/serial';
import type { WorkerRequest } from '../../src/dwg/workerProtocol';

const enqueue = serialQueue();

parentPort?.on('message', (request: WorkerRequest) =>
  enqueue(async () => {
    parentPort?.postMessage({ id: request.id, type: 'progress', stage: 'converting' });
    if (request.filePath === 'hang.dxf') for (;;);
    await new Promise((resolve) => setTimeout(resolve, 50));
    parentPort?.postMessage({ id: request.id, type: 'done', parsed: { pages: [], objects: [], skippedEntityTypes: [] } });
  })
);
