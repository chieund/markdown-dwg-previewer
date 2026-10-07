// Stands in for a worker stuck on one drawing: it starts `hang.dxf` and never
// returns, and parses anything else at once.
import { parentPort } from 'worker_threads';
import type { WorkerRequest } from '../../src/dwg/workerProtocol';

parentPort?.on('message', (request: WorkerRequest) => {
  parentPort?.postMessage({ id: request.id, type: 'progress', stage: 'parsing' });
  if (request.filePath === 'hang.dxf') for (;;);
  parentPort?.postMessage({ id: request.id, type: 'done', parsed: { pages: [], objects: [], skippedEntityTypes: [] } });
});
