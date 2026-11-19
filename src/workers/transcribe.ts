// Transcribe worker: one channel per job. VAD → per voiced region, the ASR engine → Segment[].
// The Danish + English model adds a language pass between the two: whisper-base scores windows of
// regions Danish or English (route.ts), and each region goes to Edda or Parakeet accordingly.
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
import { detectVoice, type Region } from '../lib/vad.ts';
import { SAMPLE_RATE, sliceRegion, toSegment } from '../lib/asr/regions.ts';
import { lidWindows, routeRegions, type RouteLanguage } from '../lib/asr/route.ts';
import { EddaEngine, WhisperLanguageId } from '../lib/asr/whisper.ts';
import {
  DANISH_ENGLISH_MODEL,
  PARAKEET_MODEL,
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
  /** EngineOptions.danishBackend: where Edda's encoder runs. */
  danishBackend?: Backend;
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

/**
 * What the worker holds loaded for one `EngineOptions`: Parakeet always, and for the Danish +
 * English model the language ID and Edda as well. All three stay loaded across jobs (about 1.7 GB
 * of the WASM heap at int8), so the second channel of a recording loads nothing.
 */
interface Recognisers {
  options: EngineOptions;
  parakeet: AsrEngine;
  danish?: { lid: WhisperLanguageId; edda: AsrEngine };
}

let held: Recognisers | undefined;
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'transcribe') return;
  queue = queue.then(() => runJob(request));
});

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function dropRecognisers(): void {
  held?.parakeet.dispose();
  held?.danish?.lid.dispose();
  held?.danish?.edda.dispose();
  held = undefined;
}

async function ensureRecognisers(
  options: EngineOptions,
  onProgress: (p: Progress) => void,
): Promise<Recognisers> {
  if (held && sameEngineOptions(held.options, options)) return held;
  dropRecognisers();
  if (options.model !== PARAKEET_MODEL && options.model !== DANISH_ENGLISH_MODEL)
    throw new Error(`unknown speech model ${options.model}`);
  const loaded: { dispose(): void }[] = [];
  const load = async <T extends { load(p: (p: Progress) => void): Promise<void>; dispose(): void }>(
    r: T,
  ): Promise<T> => {
    loaded.push(r);
    await r.load(onProgress);
    return r;
  };
  try {
    const next: Recognisers = { options, parakeet: undefined as unknown as AsrEngine };
    if (options.model === DANISH_ENGLISH_MODEL) {
      // The small one first, so a broken network fails in seconds, not after 650 MB.
      const lid = await load(new WhisperLanguageId({ wasmPaths: WASM_PATHS }));
      next.parakeet = await load(
        new ParakeetEngine(
          { model: PARAKEET_MODEL, backend: options.backend },
          { wasmPaths: WASM_PATHS },
        ),
      );
      const edda = await load(new EddaEngine(options, { wasmPaths: WASM_PATHS }));
      next.danish = { lid, edda };
    } else {
      next.parakeet = await load(new ParakeetEngine(options, { wasmPaths: WASM_PATHS }));
    }
    held = next;
    return next;
  } catch (err) {
    for (const r of loaded) r.dispose();
    throw err;
  }
}

/**
 * The language of every region: whisper-base on windows of regions (route.ts), or undefined for
 * Parakeet alone. A window's regions are joined end to end into one input of at most 30 s.
 */
async function languages(
  rec: Recognisers,
  pcm: Float32Array | Int16Array,
  regions: Region[],
): Promise<RouteLanguage[] | undefined> {
  if (!rec.danish) return undefined;
  const windows = lidWindows(regions);
  const pDanish: number[] = [];
  for (const w of windows) {
    const parts = w.map((i) => sliceRegion(pcm, regions[i]!));
    const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    pDanish.push(await rec.danish.lid.pDanish(joined));
  }
  return routeRegions(regions, windows, pDanish);
}

async function runJob(request: TranscribeRequest): Promise<void> {
  const { jobId, channel, pcm } = request;
  const offsetS = request.offsetS ?? 0;
  const progress = (p: Omit<ProgressMessage, 'type' | 'jobId'>) =>
    post({ type: 'progress', jobId, ...p });

  let rec: Recognisers;
  try {
    rec = await ensureRecognisers(
      { model: request.model, backend: request.backend, danishBackend: request.danishBackend },
      progress,
    );
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
    // The language pass takes a while on a long channel: say the channel's step has begun.
    progress({
      phase: 'transcribe',
      loaded: 0,
      total: regions.length,
      regionCount: regions.length,
      lengthS,
      voicedDoneS,
      voicedTotalS,
    });
    const langs = await languages(rec, pcm, regions);
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
      const language = langs?.[i];
      const asr = language === 'da' && rec.danish ? rec.danish.edda : rec.parakeet;
      const { words } = await asr.transcribe(sliceRegion(pcm, region), SAMPLE_RATE);
      const segment = toSegment(channel, region, words, offsetS);
      if (segment) segments.push(language ? { ...segment, language } : segment);
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
    post({ type: 'result', jobId, segments, backend: rec.options.backend });
  } catch (err) {
    // A region that blew the WASM heap or lost the GPU device leaves the engine unusable, and
    // an aborted Emscripten runtime throws on every later call. Never hand this engine out again.
    dropRecognisers();
    post({ type: 'error', jobId, stage: 'transcribe', message: describe(err) });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
