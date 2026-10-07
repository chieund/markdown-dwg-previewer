// Stands in for a worker that dies mid-job (e.g. out of memory).
import { parentPort } from 'worker_threads';

parentPort?.on('message', () => process.exit(3));
