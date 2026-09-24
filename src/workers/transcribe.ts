// Transcribe worker: one channel per job. VAD → per voiced region, the ASR engine → Segment[].
// Spawned by src/app/transcriber.ts as `new Worker(chrome.runtime.getURL('workers/transcribe.js'),
// { type: 'module' })`. Jobs are serialised; the model stays loaded across jobs and reloads only
// when a job asks for another model or backend.
//
// Memory: the request's PCM buffer is transferred, never copied, and may be Int16 (what the PCM
// files in OPFS hold). Regions are converted to Float32 one at a time, each at most `maxRegionS`
// (30 s = 1.9 MB), so the peak beyond the input itself is one region plus the engine's own working
// set. A 3-hour channel costs 345 MB as Int16 or 690 MB as Float32; pass Int16.
import type { ChannelId, Segment, Word } from '../lib/types.ts';
import { detectVoice, int16ToFloat32, type Pcm, type Region } from '../lib/vad.ts';
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
}

export interface ResultMessage {
  type: 'result';
  jobId: string;
  /** Recording-relative seconds, one segment per voiced region that produced words. */
  segments: Segment[];
}

export interface ErrorMessage {
  type: 'error';
  jobId: string;
  message: string;
}

export type WorkerRequest = TranscribeRequest;
export type WorkerResponse = ProgressMessage | ResultMessage | ErrorMessage;

// --- Worker body ----------------------------------------------------------------------------

const SAMPLE_RATE = 16000;
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

async function ensureEngine(
  options: EngineOptions,
  onProgress: (p: Progress) => void,
): Promise<AsrEngine> {
  if (engine && sameEngineOptions(engine.options, options)) return engine;
  engine?.dispose();
  engine = undefined;
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
  const progress = (p: Omit<ProgressMessage, 'type' | 'jobId'>) =>
    post({ type: 'progress', jobId, ...p });
  try {
    const asr = await ensureEngine({ model: request.model, backend: request.backend }, progress);
    const regions = detectVoice(pcm, SAMPLE_RATE);
    const duration = pcm.length / SAMPLE_RATE;
    const segments: Segment[] = [];
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]!;
      progress({
        phase: 'transcribe',
        loaded: i,
        total: regions.length,
        regionIndex: i,
        regionCount: regions.length,
      });
      const { words } = await asr.transcribe(sliceRegion(pcm, region), SAMPLE_RATE);
      const segment = toSegment(channel, region, words, duration);
      if (segment) segments.push(segment);
    }
    progress({
      phase: 'transcribe',
      loaded: regions.length,
      total: regions.length,
      regionCount: regions.length,
    });
    post({ type: 'result', jobId, segments });
  } catch (err) {
    post({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) });
  }
}

/** The region's samples as Float32. A Float32 input is viewed, not copied; Int16 is converted. */
function sliceRegion(pcm: Pcm, region: Region): Float32Array {
  const a = Math.max(0, Math.floor(region.start * SAMPLE_RATE));
  const b = Math.min(pcm.length, Math.ceil(region.end * SAMPLE_RATE));
  return pcm instanceof Int16Array ? int16ToFloat32(pcm.subarray(a, b)) : pcm.subarray(a, b);
}

/**
 * One Segment per region: words offset by the region start and clamped to the audio, text = the
 * words joined with spaces. A region the engine heard nothing in yields no segment.
 */
function toSegment(
  channel: ChannelId,
  region: Region,
  words: Word[],
  duration: number,
): Segment | undefined {
  const placed: Word[] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const start = clamp(roundMs(region.start + w.start), 0, duration);
    const end = clamp(roundMs(region.start + w.end), start, duration);
    placed.push({ text, start, end });
  }
  const first = placed[0];
  const last = placed[placed.length - 1];
  if (!first || !last) return undefined;
  return {
    channel,
    start: first.start,
    end: last.end,
    text: placed.map((w) => w.text).join(' '),
    words: placed,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
