// App-side client of the transcribe worker. One worker for the app tab, spawned on first use and
// reused; every job is posted the moment it is requested (the worker serialises them), so the
// caller's PCM buffer is transferred at call time. Part 2 of issue #2 wires this after stop: read
// each channel's PCM from OPFS, call `transcribeChannel`, hand the segments to attribution.
//
// Failure model: a load error (bad model, no WebGPU, network down) fails that job only. A
// transcribe error means the worker's WASM runtime may be dead, so the worker is terminated and
// every job posted behind the failed one fails too; the next job starts a fresh worker. Post the
// channels one after another if the second should survive the first's failure.
import type { ChannelId, Segment } from '../lib/types.ts';
import { sameEngineOptions, type Backend, type EngineOptions } from '../lib/asr/engine.ts';
import type { ProgressMessage, WorkerRequest, WorkerResponse } from '../workers/transcribe.ts';

export interface TranscribeOptions {
  /** Model key, e.g. Settings.model. */
  model: string;
  backend: Backend;
  /** Recording-relative seconds of the PCM's sample 0. Default 0. */
  offsetS?: number;
}

export type TranscribeProgress = Omit<ProgressMessage, 'type' | 'jobId'>;

/** What the client needs from a Worker; injectable so the class is unit-testable without one. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
}

export interface TranscriberDeps {
  createWorker?: () => WorkerLike;
}

interface Job {
  id: string;
  options: EngineOptions;
  resolve: (segments: Segment[]) => void;
  reject: (err: Error) => void;
  onProgress?: (p: TranscribeProgress) => void;
}

const createExtensionWorker = (): WorkerLike =>
  new Worker(chrome.runtime.getURL('workers/transcribe.js'), { type: 'module' });

export class Transcriber {
  private readonly createWorker: () => WorkerLike;
  private worker: WorkerLike | undefined;
  private readonly pending = new Map<string, Job>();
  /** The model the live worker holds loaded: what its last result was made with. */
  private loaded: EngineOptions | undefined;
  private disposed = false;
  private seq = 0;

  constructor(deps: TranscriberDeps = {}) {
    this.createWorker = deps.createWorker ?? createExtensionWorker;
  }

  /**
   * Transcribes one channel. `pcm` is 16 kHz mono; its buffer is transferred to the worker right
   * now, so the caller's array is empty when this returns. Pass Int16 straight from the PCM file:
   * the worker converts per region. Jobs run one after another in call order.
   */
  transcribeChannel(
    pcm: Float32Array | Int16Array,
    channel: ChannelId,
    opts: TranscribeOptions,
    onProgress?: (p: TranscribeProgress) => void,
  ): Promise<Segment[]> {
    if (this.disposed) return Promise.reject(new Error('transcriber disposed'));
    return new Promise<Segment[]>((resolve, reject) => {
      const worker = this.ensureWorker();
      const id = `job-${++this.seq}`;
      const request: WorkerRequest = {
        type: 'transcribe',
        jobId: id,
        channel,
        pcm,
        model: opts.model,
        backend: opts.backend,
        offsetS: opts.offsetS ?? 0,
      };
      // A detached or shared buffer makes postMessage throw; that fails this job only (the
      // executor's throw rejects the promise) and registers nothing, so later jobs are unaffected.
      worker.postMessage(request, [pcm.buffer as ArrayBuffer]);
      this.pending.set(id, {
        id,
        options: { model: opts.model, backend: opts.backend },
        resolve,
        reject,
        onProgress,
      });
    });
  }

  /**
   * Whether the worker holds this model loaded, as far as its results say: true after a job with
   * these options succeeded on the worker that is still alive; false before the first job, after
   * a restart (a failure, a crash) and once a job with other options ran. What the pipeline's
   * progress plan asks before it decides whether the human will see a "Speech model" step.
   */
  holdsModel(options: EngineOptions): boolean {
    return this.worker !== undefined && !!this.loaded && sameEngineOptions(this.loaded, options);
  }

  /** Terminates the worker and fails every pending job. A disposed Transcriber stays disposed. */
  dispose(): void {
    this.disposed = true;
    this.restart(new Error('transcriber disposed'));
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (e) => this.onMessage(e.data);
    worker.onerror = (e) => this.restart(new Error(e.message || 'transcribe worker crashed'));
    worker.onmessageerror = () =>
      this.restart(new Error('transcribe worker: undeliverable message'));
    this.worker = worker;
    return worker;
  }

  private onMessage(msg: WorkerResponse): void {
    const job = this.pending.get(msg.jobId);
    if (!job) return;
    switch (msg.type) {
      case 'progress': {
        const { type: _type, jobId: _jobId, ...progress } = msg;
        job.onProgress?.(progress);
        return;
      }
      case 'result':
        this.pending.delete(job.id);
        this.loaded = job.options;
        job.resolve(msg.segments);
        return;
      case 'error':
        if (msg.stage === 'load') {
          this.pending.delete(job.id);
          job.reject(new Error(msg.message));
          return;
        }
        // The worker's runtime may be poisoned (an aborted WASM module throws on every later
        // call): drop it, so the next job starts from a clean one.
        this.pending.delete(job.id);
        job.reject(new Error(msg.message));
        this.restart(
          new Error(`transcribe worker restarted after a failure in another job: ${msg.message}`),
        );
        return;
    }
  }

  /** Terminates the worker and fails every pending job with `err`; the next job respawns. */
  private restart(err: Error): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.loaded = undefined;
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const job of jobs) job.reject(err);
  }
}
