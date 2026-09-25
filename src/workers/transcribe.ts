// Transcribe worker: one channel per job. VAD → per voiced region, the ASR engine → Segment[].
// Spawned by src/app/transcriber.ts as `new Worker(chrome.runtime.getURL('workers/transcribe.js'),
// { type: 'module' })`. Jobs are serialised; the model stays loaded across jobs and reloads only
// when a job asks for another model or backend, or after a transcribe failure (the engine may be
// dead then, and so may this worker's WASM runtime: the client terminates it on that error).
//
// Memory: the request's PCM buffer is transferred, never copied, and may be Int16 (what the PCM
// files in OPFS hold). Regions are converted to Float32 one at a time, each at most `maxRegionS`
// (30 s = 1.9 MB), so the peak beyond the input itself is one region plus the engine's own working
// set. A 3-hour channel costs 345 MB as Int16 or 690 MB as Float32; pass Int16.
import type { ChannelId, Segment } from '../lib/types.ts';
import { detectVoice } from '../lib/vad.ts';
import { SAMPLE_RATE, sliceRegion, toSegment } from '../lib/asr/regions.ts';
import {
  sameEngineOptions,
  type AsrEngine,
  type Backend,
  type EngineOptions,
  type Progress,
  type ProgressPhase,
} from '../lib/asr/engine.ts';
import { ParakeetEngine } from '../lib/asr/parakeet.ts';

// --- Protocol (imported by the client; this file is its single home) ------------------------

export interface TranscribeRequest {
  type: 'transcribe';
  jobId: string;
  channel: ChannelId;
  /** 16 kHz mono. Transfer its buffer: the caller's view is detached afterwards. */
  pcm: Float32Array | Int16Array;
  model: string;
  backend: Backend;
  /** Recording-relative seconds of `pcm[0]`; every segment and word time adds it. Default 0. */
  offsetS?: number;
}

export interface ProgressMessage {
  type: 'progress';
  jobId: string;
  phase: ProgressPhase;
  loaded: number;
  total: number;
  file?: string;
  /** 'transcribe' phase: the region about to be recognised (absent on the final message). */
  regionIndex?: number;
  regionCount?: number;
  /** 'transcribe' phase: where that region starts in the recording, seconds (absent at the end). */
  positionS?: number;
  /** 'transcribe' phase: where the channel's audio ends, recording-relative seconds. */
  lengthS?: number;
  /** 'transcribe' phase: voiced seconds recognised so far, and in the whole channel. */
  voicedDoneS?: number;
  voicedTotalS?: number;
}

export interface ResultMessage {
  type: 'result';
  jobId: string;
  /** Recording-relative seconds, one segment per voiced region that produced words. */
  segments: Segment[];
  /** The backend the engine ran on. A load refuses to degrade, so it is the one requested. */
  backend: Backend;
}

export interface ErrorMessage {
  type: 'error';
  jobId: string;
  /** 'load': this job failed to get a model, the worker is fine. 'transcribe': assume it is not. */
  stage: 'load' | 'transcribe';
  message: string;
}

export type WorkerRequest = TranscribeRequest;
export type WorkerResponse = ProgressMessage | ResultMessage | ErrorMessage;

// --- Worker body ----------------------------------------------------------------------------

// chrome.runtime.getURL is not available in a worker; the bundle lives at
// chrome-extension://<id>/workers/transcribe.js, so resolve from there.
const WASM_PATHS = new URL('/vendor/ort/', self.location.href).href;

let engine: AsrEngine | undefined;
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'transcribe') return;
  queue = queue.then(() => runJob(request));
});

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function createEngine(options: EngineOptions): AsrEngine {
  // Parakeet is the only engine today (DECISIONS § Speech recognition). Another engine would be
  // chosen here by `options.model`.
  return new ParakeetEngine(options, { wasmPaths: WASM_PATHS });
}

function dropEngine(): void {
  engine?.dispose();
  engine = undefined;
}

async function ensureEngine(
  options: EngineOptions,
  onProgress: (p: Progress) => void,
): Promise<AsrEngine> {
  if (engine && sameEngineOptions(engine.options, options)) return engine;
  dropEngine();
  const next = createEngine(options);
  try {
    await next.load(onProgress);
  } catch (err) {
    next.dispose();
    throw err;
  }
  engine = next;
  return next;
}

async function runJob(request: TranscribeRequest): Promise<void> {
  const { jobId, channel, pcm } = request;
  const offsetS = request.offsetS ?? 0;
  const progress = (p: Omit<ProgressMessage, 'type' | 'jobId'>) =>
    post({ type: 'progress', jobId, ...p });

  let asr: AsrEngine;
  try {
    asr = await ensureEngine({ model: request.model, backend: request.backend }, progress);
  } catch (err) {
    post({ type: 'error', jobId, stage: 'load', message: describe(err) });
    return;
  }

  try {
    const regions = detectVoice(pcm, SAMPLE_RATE);
    // For the progress: the voiced time is what the recogniser's time follows, the position is
    // where in the recording the human would look.
    const lengthS = offsetS + pcm.length / SAMPLE_RATE;
    const voicedTotalS = regions.reduce((sum, r) => sum + (r.end - r.start), 0);
    let voicedDoneS = 0;
    const segments: Segment[] = [];
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]!;
      progress({
        phase: 'transcribe',
        loaded: i,
        total: regions.length,
        regionIndex: i,
        regionCount: regions.length,
        positionS: offsetS + region.start,
        lengthS,
        voicedDoneS,
        voicedTotalS,
      });
      const { words } = await asr.transcribe(sliceRegion(pcm, region), SAMPLE_RATE);
      const segment = toSegment(channel, region, words, offsetS);
      if (segment) segments.push(segment);
      voicedDoneS += region.end - region.start;
    }
    progress({
      phase: 'transcribe',
      loaded: regions.length,
      total: regions.length,
      regionCount: regions.length,
      lengthS,
      voicedDoneS: voicedTotalS,
      voicedTotalS,
    });
    post({ type: 'result', jobId, segments, backend: asr.options.backend });
  } catch (err) {
    // A region that blew the WASM heap or lost the GPU device leaves the engine unusable, and
    // an aborted Emscripten runtime throws on every later call. Never hand this engine out again.
    dropEngine();
    post({ type: 'error', jobId, stage: 'transcribe', message: describe(err) });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
