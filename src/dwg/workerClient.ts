import { Worker } from 'worker_threads';
import type { ParsedDxf } from '../shared/types';
import type { Stage } from './pipeline';
import type { WorkerReply, WorkerRequest } from './workerProtocol';

/** Heap cap for the worker: a runaway drawing fails on its own instead of taking the host down. */
const WORKER_HEAP_MB = 3072;

interface Job {
  resolve: (parsed: ParsedDxf) => void;
  reject: (err: Error) => void;
  progress: (stage: Stage) => void;
}

/**
 * Runs drawing jobs on one long-lived worker thread, so the WASM converters
 * load once. If the worker dies — out of memory, a crash in WASM — its jobs
 * fail with a readable message and the next job starts a fresh worker.
 */
export class DrawingWorker {
  private worker: Worker | null = null;
  private readonly jobs = new Map<number, Job>();
  private nextId = 1;

  constructor(
    private readonly scriptPath: string,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  run(bytes: Uint8Array, filePath: string, converterPath: string, progress: (stage: Stage) => void): Promise<ParsedDxf> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    // Keep the process alive while a job is out; an idle worker must not.
    worker.ref();
    return new Promise<ParsedDxf>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, progress });
      const request: WorkerRequest = { id, bytes, filePath, converterPath };
      worker.postMessage(request);
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('The drawing worker was shut down.'));
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(this.scriptPath, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    worker.on('message', (reply: WorkerReply) => this.onReply(reply));
    worker.on('error', (err: Error & { code?: string }) => {
      this.log(`Drawing worker error: ${err.message}`);
      if (this.worker === worker) this.worker = null;
      this.failAll(
        new Error(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'This drawing needs more memory than the previewer allows, so it stopped. ' +
              'Try opening one layout at a time, or exploding very large block arrays.'
            : `The drawing worker stopped: ${err.message}`
        )
      );
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (this.jobs.size > 0) this.failAll(new Error(`The drawing worker stopped unexpectedly (exit code ${code}).`));
    });
    this.worker = worker;
    return worker;
  }

  private onReply(reply: WorkerReply): void {
    if (reply.type === 'log') {
      this.log(reply.msg);
      return;
    }
    const job = this.jobs.get(reply.id);
    if (!job) return;
    if (reply.type === 'progress') {
      job.progress(reply.stage);
      return;
    }
    this.jobs.delete(reply.id);
    if (this.jobs.size === 0) this.worker?.unref();
    if (reply.type === 'done') job.resolve(reply.parsed);
    else job.reject(new Error(reply.message));
  }

  private failAll(err: Error): void {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of jobs) job.reject(err);
  }
}
