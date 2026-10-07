// Mirrors the real worker's shape: a DWG job awaits (the WASM load, a CLI
// converter) before it finishes, and `hang.dxf` blocks the thread for good.
// Jobs go through the same serial queue as src/dwg/worker.ts.
import { parentPort } from 'worker_threads';
import { serialQueue } from '../../src/dwg/serial';
import type { WorkerRequest } from '../../src/dwg/workerProtocol';

const enqueue = serialQueue();

parentPort?.on('message', (request: WorkerRequest) =>
  enqueue(async () => {
    parentPort?.postMessage({ id: request.id, type: 'progress', stage: 'converting' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (request.filePath === 'hang.dxf') for (;;);
    parentPort?.postMessage({ id: request.id, type: 'done', parsed: { pages: [], objects: [], skippedEntityTypes: [] } });
  })
);
