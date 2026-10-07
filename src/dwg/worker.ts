/**
 * Worker thread entry: converts and parses drawings away from the extension
 * host's thread. A big DWG takes seconds of synchronous WASM and parsing; on
 * the host thread that froze every extension in the window, and running out of
 * memory took them all down. Here it costs only this worker.
 */
import { parentPort } from 'worker_threads';
import { setConverterLogger } from './converter';
import { processDrawing } from './pipeline';
import { serialQueue } from './serial';
import type { WorkerReply, WorkerRequest } from './workerProtocol';

const port = parentPort;
if (!port) throw new Error('worker.ts must run in a worker thread');

const reply = (message: WorkerReply) => port.postMessage(message);

setConverterLogger((msg) => reply({ type: 'log', msg }));

// One drawing at a time: see serialQueue for why.
const enqueue = serialQueue();

port.on('message', (request: WorkerRequest) =>
  enqueue(async () => {
    const { id } = request;
    try {
      const parsed = await processDrawing(request.bytes, request.filePath, request.converterPath, (stage) =>
        reply({ id, type: 'progress', stage })
      );
      reply({ id, type: 'done', parsed });
    } catch (err) {
      reply({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })
);
