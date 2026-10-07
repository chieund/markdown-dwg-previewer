import { Worker } from 'worker_threads';
import type { ParsedDxf } from '../shared/types';
import type { Stage } from './pipeline';
import type { WorkerReply, WorkerRequest } from './workerProtocol';

/** Heap cap for the worker: a runaway drawing fails on its own instead of taking the host down. */
const WORKER_HEAP_MB = 3072;

/**
 * How long one drawing may take once the worker has started on it. The largest
 * corpus drawing takes under 7 s; this is for a file that would never finish,
 * which would otherwise hold up every drawing opened after it. It must outlast
 * the external converters' own limits (ODA File Converter: 120 s, then
 * dwg2dxf: 60 s, see converter.ts) plus parsing, or a slow but legitimate
 * conversion would be cut off and blamed on the drawing.
 */
const JOB_TIMEOUT_MS = 300_000;

interface Job {
  request: WorkerRequest;
  resolve: (parsed: ParsedDxf) => void;
  reject: (err: Error) => void;
  progress: (stage: Stage) => void;
  /** Set once the worker reports it has started on this job. */
  timer?: ReturnType<typeof setTimeout>;
}

export interface DrawingWorkerOptions {
  /** Overrides JOB_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Runs drawing jobs on one long-lived worker thread, so the WASM converters
 * load once. If the worker dies — out of memory, a crash in WASM — its jobs
 * fail with a readable message and the next job starts a fresh worker. A job
 * that runs too long fails alone: the worker is replaced and the jobs queued
 * behind it are sent to the new one.
 */
export class DrawingWorker {
  private worker: Worker | null = null;
  private readonly jobs = new Map<number, Job>();
  private nextId = 1;
  private readonly timeoutMs: number;

  constructor(
    private readonly scriptPath: string,
    private readonly log: (msg: string) => void = () => {},
    options: DrawingWorkerOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  }

  run(bytes: Uint8Array, filePath: string, converterPath: string, progress: (stage: Stage) => void): Promise<ParsedDxf> {
    const id = this.nextId++;
    return new Promise<ParsedDxf>((resolve, reject) => {
      const request: WorkerRequest = { id, bytes, filePath, converterPath };
      this.jobs.set(id, { request, resolve, reject, progress });
      this.send(request);
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('The drawing worker was shut down.'));
    if (worker) await worker.terminate();
  }

  private send(request: WorkerRequest): void {
    const worker = this.ensureWorker();
    // Keep the process alive while a job is out; an idle worker must not.
    worker.ref();
    worker.postMessage(request);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(this.scriptPath, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    // A worker retired after a timeout still reports its exit; its jobs have moved on.
    const current = () => this.worker === worker;
    worker.on('message', (reply: WorkerReply) => {
      if (current() || reply.type === 'log') this.onReply(reply);
    });
    worker.on('error', (err: Error & { code?: string }) => {
      this.log(`Drawing worker error: ${err.message}`);
      if (!current()) return;
      this.worker = null;
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
      if (!current()) return;
      this.worker = null;
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
      // The first stage marks the worker starting on the job; the clock runs from there.
      job.timer ??= setTimeout(() => this.timeOut(reply.id), this.timeoutMs);
      job.progress(reply.stage);
      return;
    }
    this.finish(reply.id, job);
    if (reply.type === 'done') job.resolve(reply.parsed);
    else job.reject(new Error(reply.message));
  }

  /**
   * Fails the job that ran too long and replaces the worker stuck on it. The
   * jobs that were waiting go to the new worker, so one bad file does not take
   * the drawings opened after it down too.
   */
  private timeOut(id: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.finish(id, job);
    this.log(`Drawing worker: ${job.request.filePath} took longer than ${this.timeoutMs} ms; restarting the worker`);
    const limit = this.timeoutMs >= 1000 ? `${Math.round(this.timeoutMs / 1000)} s` : `${this.timeoutMs} ms`;
    job.reject(
      new Error(
        `This drawing took longer than ${limit} to read, so it was stopped. ` +
          'The file may be damaged, or too complex to preview.'
      )
    );

    const stuck = this.worker;
    this.worker = null;
    if (stuck) void stuck.terminate();
    for (const waiting of this.jobs.values()) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.timer = undefined;
      this.send(waiting.request);
    }
  }

  private finish(id: number, job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    this.jobs.delete(id);
    if (this.jobs.size === 0) this.worker?.unref();
  }

  private failAll(err: Error): void {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of jobs) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(err);
    }
  }
}
