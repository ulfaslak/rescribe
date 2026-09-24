// App-side client of the transcribe worker. One worker for the app tab, spawned on first use,
// reused across jobs, one job at a time. Part 2 of issue #2 wires this after stop: read each
// channel's PCM from OPFS, call `transcribeChannel`, hand the segments to attribution.
import type { ChannelId, Segment } from '../lib/types.ts';
import type { Backend } from '../lib/asr/engine.ts';
import type { ProgressMessage, WorkerRequest, WorkerResponse } from '../workers/transcribe.ts';

export interface TranscribeOptions {
  /** Model key, e.g. Settings.model. */
  model: string;
  backend: Backend;
}

export type TranscribeProgress = Omit<ProgressMessage, 'type' | 'jobId'>;

interface Job {
  id: string;
  resolve: (segments: Segment[]) => void;
  reject: (err: Error) => void;
  onProgress?: (p: TranscribeProgress) => void;
}

export class Transcriber {
  private worker: Worker | undefined;
  private active: Job | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  /**
   * Transcribes one channel. `pcm` is 16 kHz mono; its buffer is transferred to the worker, so the
   * caller's array is empty afterwards. Pass Int16 straight from the PCM file: the worker converts
   * per region. Jobs run one after another in call order.
   */
  transcribeChannel(
    pcm: Float32Array | Int16Array,
    channel: ChannelId,
    opts: TranscribeOptions,
    onProgress?: (p: TranscribeProgress) => void,
  ): Promise<Segment[]> {
    const run = () => this.run(pcm, channel, opts, onProgress);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Terminates the worker and fails the active job. Jobs still queued run on a fresh worker, as
   * does the next call, so the model loads again.
   */
  dispose(): void {
    this.fail(new Error('transcriber disposed'));
  }

  private run(
    pcm: Float32Array | Int16Array,
    channel: ChannelId,
    opts: TranscribeOptions,
    onProgress?: (p: TranscribeProgress) => void,
  ): Promise<Segment[]> {
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
      };
      // A detached or shared buffer makes postMessage throw; that must fail this job only, not
      // leave it registered as active so the next job's messages get ignored.
      worker.postMessage(request, [pcm.buffer as ArrayBuffer]);
      this.active = { id, resolve, reject, onProgress };
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(chrome.runtime.getURL('workers/transcribe.js'), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
    worker.onerror = (e) => this.fail(new Error(e.message || 'transcribe worker crashed'));
    worker.onmessageerror = () => this.fail(new Error('transcribe worker: undeliverable message'));
    this.worker = worker;
    return worker;
  }

  private onMessage(msg: WorkerResponse): void {
    const job = this.active;
    if (!job || msg.jobId !== job.id) return;
    switch (msg.type) {
      case 'progress': {
        const { type: _type, jobId: _jobId, ...progress } = msg;
        job.onProgress?.(progress);
        return;
      }
      case 'result':
        this.active = undefined;
        job.resolve(msg.segments);
        return;
      case 'error':
        this.active = undefined;
        job.reject(new Error(msg.message));
        return;
    }
  }

  /** A dead worker cannot finish anything: drop it, fail the active job, respawn on next use. */
  private fail(err: Error): void {
    this.worker?.terminate();
    this.worker = undefined;
    const job = this.active;
    this.active = undefined;
    job?.reject(err);
  }
}
