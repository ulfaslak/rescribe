// The transcribe worker inside the extension origin: real parakeet.js + ORT WASM, the fixture PCM
// pushed through the worker protocol from the app page. Proves the WASM URL the worker derives
// from self.location, VAD → regions → segments, model reuse across jobs, the failure paths, and
// the privacy invariant (e2e/privacy.ts), including that a cached model loads with zero requests.
//
// The first run in a fresh profile downloads the int8 model (about 650 MB); later runs load it
// from the profile's IndexedDB. The WebGPU variant needs the 2.4 GB fp32 encoder and is skipped
// unless RESCRIBE_E2E_WEBGPU=1.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { watchNetwork, type NetworkWatch } from './privacy.ts';
import type { Segment } from '../src/lib/types.ts';
import type { ProgressMessage, WorkerRequest, WorkerResponse } from '../src/workers/transcribe.ts';

const MODEL = 'parakeet-tdt-0.6b-v3';
const SAMPLE_RATE = 16000;
const FIXTURE_TEXT = 'e2e/fixtures/speech.txt';

/** Minimal RIFF reader for the 16 kHz 16-bit mono fixture. */
function readWav16kMono(path: string): Int16Array {
  const buf = readFileSync(path);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (sampleRate !== SAMPLE_RATE || bits !== 16)
    throw new Error(`unexpected wav ${sampleRate}/${bits}`);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2 / channels);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2 * channels);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

type Progress = Omit<ProgressMessage, 'type' | 'jobId'> & { at: number };

interface JobReport {
  segments: Segment[];
  progress: Progress[];
  ms: number;
  backend?: string;
  error?: string;
  stage?: string;
}

interface JobSpec {
  samples: number[];
  kind: 'int16' | 'float32';
  model: string;
  backend: 'wasm' | 'webgpu';
  offsetS?: number;
  /** Plant a non-finite sample inside the audio: parakeet.js rejects it at transcribe time. */
  poison?: boolean;
}

/** Runs one job on the page's worker: spawned on first use, kept on `window` so jobs share it. */
function runJob(page: Page, job: JobSpec): Promise<JobReport> {
  return page.evaluate((job) => {
    const w = window as unknown as { __transcribeWorker?: Worker; __jobs?: number };
    w.__transcribeWorker ??= new Worker(chrome.runtime.getURL('workers/transcribe.js'), {
      type: 'module',
    });
    const worker = w.__transcribeWorker;
    w.__jobs = (w.__jobs ?? 0) + 1;
    const jobId = `e2e-${w.__jobs}`;
    const pcm =
      job.kind === 'int16'
        ? Int16Array.from(job.samples)
        : Float32Array.from(job.samples, (s) => s / 32768);
    if (job.poison && pcm instanceof Float32Array) pcm[Math.floor(pcm.length / 2)] = Infinity;
    const progress: Progress[] = [];
    const t0 = performance.now();
    return new Promise<JobReport>((resolve) => {
      const done = (r: Omit<JobReport, 'progress' | 'ms'>) =>
        resolve({ ...r, progress, ms: Math.round(performance.now() - t0) });
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (m.jobId !== jobId) return;
        if (m.type === 'progress') {
          const { type: _t, jobId: _j, ...rest } = m;
          progress.push({ ...rest, at: Math.round(performance.now() - t0) });
        } else if (m.type === 'result') done({ segments: m.segments, backend: m.backend });
        else done({ segments: [], error: m.message, stage: m.stage });
      };
      worker.onerror = (e) => done({ segments: [], error: `worker error: ${e.message}` });
      const request: WorkerRequest = {
        type: 'transcribe',
        jobId,
        channel: 'mic',
        pcm,
        model: job.model,
        backend: job.backend,
        offsetS: job.offsetS,
      };
      worker.postMessage(request, [pcm.buffer]);
    });
  }, job);
}

/** Kills the page's worker so the next job spawns a fresh one. */
function terminateWorker(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __transcribeWorker?: Worker };
    w.__transcribeWorker?.terminate();
    delete w.__transcribeWorker;
  });
}

function wordHitRate(segments: Segment[]): number {
  const got = segments
    .map((s) => s.text)
    .join(' ')
    .toLowerCase();
  const words =
    readFileSync(FIXTURE_TEXT, 'utf8')
      .toLowerCase()
      .match(/[a-z']+/g) ?? [];
  return words.filter((w) => got.includes(w)).length / words.length;
}

function assertWellFormed(segments: Segment[], from: number, to: number): void {
  let prevEnd = from;
  for (const s of segments) {
    expect(s.channel).toBe('mic');
    expect(s.start).toBeGreaterThanOrEqual(prevEnd);
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.end).toBeLessThanOrEqual(to);
    expect(s.text.length).toBeGreaterThan(0);
    expect(s.words?.length ?? 0).toBeGreaterThan(0);
    let prev = s.start;
    for (const w of s.words ?? []) {
      expect(w.start).toBeGreaterThanOrEqual(prev);
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      expect(w.end).toBeLessThanOrEqual(s.end);
      prev = w.start;
    }
    prevEnd = s.end;
  }
}

const phases = (r: JobReport) => [...new Set(r.progress.map((p) => p.phase))].sort();

async function transcribeFixtureThroughWorker(
  page: Page,
  backend: 'wasm' | 'webgpu',
  net: NetworkWatch,
): Promise<void> {
  const fixture = readWav16kMono('e2e/fixtures/speech.wav');
  const seconds = fixture.length / SAMPLE_RATE;
  const samples = Array.from(fixture);
  const log = (msg: string) => console.log(`[transcribe ${backend}] ${msg}`);

  // Job 1: Int16 input, as the PCM files in OPFS hold it. Downloads (first run) and loads.
  const first = await runJob(page, { samples, kind: 'int16', model: MODEL, backend });
  const firstTranscribeMs =
    first.ms - (first.progress.find((p) => p.phase === 'transcribe')?.at ?? 0);
  log(
    `job 1: ${first.ms} ms in total, ${firstTranscribeMs} ms transcribing ${seconds.toFixed(2)} s ` +
      `of audio (RTF ${(firstTranscribeMs / 1000 / seconds).toFixed(3)}), ` +
      `segments: ${JSON.stringify(first.segments)}`,
  );
  expect(first.error, first.error).toBeUndefined();
  expect(first.backend).toBe(backend);
  const hits = wordHitRate(first.segments);
  log(`word hit rate ${hits.toFixed(2)}`);
  expect(hits).toBeGreaterThan(0.8);
  assertWellFormed(first.segments, 0, seconds);

  // Every phase reported at least once; bytes reported iff bytes were actually downloaded.
  expect(phases(first)).toEqual(['download', 'load', 'transcribe']);
  const downloaded = net.requests.some(
    (r) => r.host === 'huggingface.co' && /\/resolve\//.test(r.url),
  );
  const bytes = first.progress.filter((p) => p.phase === 'download' && p.loaded > 0);
  log(`model ${downloaded ? 'downloaded' : 'cached'}`);
  if (downloaded) expect(bytes.length).toBeGreaterThan(0);
  else expect(bytes).toEqual([]);
  const transcribe = first.progress.filter((p) => p.phase === 'transcribe');
  expect(transcribe.at(-1)).toMatchObject({ loaded: transcribe.at(-1)!.total });
  expect(transcribe.at(-1)!.total).toBeGreaterThan(0);

  // Job 2: same worker, Float32 input. The model is reused: no download or load phase, faster.
  const second = await runJob(page, { samples, kind: 'float32', model: MODEL, backend });
  log(`job 2: ${second.ms} ms (model reused, RTF ${(second.ms / 1000 / seconds).toFixed(3)})`);
  expect(second.error, second.error).toBeUndefined();
  expect(wordHitRate(second.segments)).toBeGreaterThan(0.8);
  expect(phases(second)).toEqual(['transcribe']);
  expect(second.ms).toBeLessThan(first.ms);

  // Job 3: silence only. VAD finds nothing, the engine is never asked, the result is empty.
  const silence = await runJob(page, {
    samples: new Array<number>(3 * SAMPLE_RATE).fill(0),
    kind: 'float32',
    model: MODEL,
    backend,
  });
  expect(silence.error, silence.error).toBeUndefined();
  expect(silence.segments).toEqual([]);
  expect(silence.progress.filter((p) => p.phase === 'transcribe').at(-1)).toMatchObject({
    loaded: 0,
    total: 0,
  });

  // Job 4: no samples at all. Same answer, no crash.
  const empty = await runJob(page, { samples: [], kind: 'int16', model: MODEL, backend });
  expect(empty.error, empty.error).toBeUndefined();
  expect(empty.segments).toEqual([]);

  // Job 5: two regions. speech + 3 s silence + speech → two segments in order with a gap, region
  // progress counting to 2, every word inside its segment.
  const gap = 3;
  const two = [...samples, ...new Array<number>(gap * SAMPLE_RATE).fill(0), ...samples];
  const multi = await runJob(page, { samples: two, kind: 'int16', model: MODEL, backend });
  log(`job 5 (two regions): ${JSON.stringify(multi.segments.map((s) => [s.start, s.end]))}`);
  expect(multi.error, multi.error).toBeUndefined();
  expect(multi.segments.length).toBe(2);
  assertWellFormed(multi.segments, 0, 2 * seconds + gap);
  expect(wordHitRate([multi.segments[0]!])).toBeGreaterThan(0.8);
  expect(wordHitRate([multi.segments[1]!])).toBeGreaterThan(0.8);
  expect(multi.segments[1]!.start - multi.segments[0]!.end).toBeGreaterThan(gap - 1);
  expect(multi.segments[1]!.start).toBeGreaterThan(seconds + gap - 0.5);
  expect(multi.progress.filter((p) => p.regionIndex === 1)).toHaveLength(1);
  expect(multi.progress.at(-1)).toMatchObject({ phase: 'transcribe', loaded: 2, total: 2 });

  // Job 6: a channel whose sample 0 sits 100 s into the recording.
  const offset = await runJob(page, {
    samples,
    kind: 'int16',
    model: MODEL,
    backend,
    offsetS: 100,
  });
  expect(offset.error, offset.error).toBeUndefined();
  expect(offset.segments.length).toBe(1);
  assertWellFormed(offset.segments, 100, 100 + seconds);
  expect(offset.segments[0]!.start).toBeCloseTo(first.segments[0]!.start + 100, 3);
  expect(offset.segments[0]!.words![0]!.start).toBeCloseTo(
    first.segments[0]!.words![0]!.start + 100,
    3,
  );

  // Job 7: a non-finite sample inside the speech. parakeet.js rejects it at transcribe time,
  // the worker reports a transcribe-stage error and drops its engine, so job 8 loads the model
  // again, from the cache, with no network request at all.
  const poisoned = await runJob(page, {
    samples,
    kind: 'float32',
    model: MODEL,
    backend,
    poison: true,
  });
  log(`job 7 (poisoned) → ${poisoned.stage}: ${poisoned.error}`);
  expect(poisoned.stage).toBe('transcribe');
  expect(poisoned.error).toMatch(/finite/);
  const requestsBeforeReload = net.networkRequests().length;
  const reloaded = await runJob(page, { samples, kind: 'int16', model: MODEL, backend });
  expect(reloaded.error, reloaded.error).toBeUndefined();
  expect(phases(reloaded)).toEqual(['download', 'load', 'transcribe']);
  expect(wordHitRate(reloaded.segments)).toBeGreaterThan(0.8);
  expect(net.networkRequests().slice(requestsBeforeReload)).toEqual([]);

  // Job 9: a model that does not exist. huggingface.co answers 401 for an unknown repo. The job
  // fails at the load stage with that message, the worker survives, and because the engine was
  // swapped out for the bad one, job 10 loads the real model again.
  const bogus = await runJob(page, { samples, kind: 'int16', model: 'no-such-model', backend });
  log(`job 9 (bogus model) → ${bogus.stage}: ${bogus.error}`);
  expect(bogus.stage).toBe('load');
  expect(bogus.error).toMatch(/^Failed to download encoder-model\S* 401/);
  expect(bogus.segments).toEqual([]);
  const again = await runJob(page, { samples, kind: 'int16', model: MODEL, backend });
  expect(again.error, again.error).toBeUndefined();
  expect(wordHitRate(again.segments)).toBeGreaterThan(0.8);
  expect(phases(again)).toEqual(['download', 'load', 'transcribe']);

  // Job 11: a fresh worker with the model cached makes zero network requests. This is what
  // DECISIONS means by a one-time download.
  await terminateWorker(page);
  const requestsBeforeSpawn = net.networkRequests().length;
  const fresh = await runJob(page, { samples, kind: 'int16', model: MODEL, backend });
  log(`job 11 (fresh worker, cached model): ${fresh.ms} ms`);
  expect(fresh.error, fresh.error).toBeUndefined();
  expect(wordHitRate(fresh.segments)).toBeGreaterThan(0.8);
  expect(phases(fresh)).toEqual(['download', 'load', 'transcribe']);
  expect(net.networkRequests().slice(requestsBeforeSpawn)).toEqual([]);
}

function logPageProblems(page: Page): void {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text());
  });
}

test.describe('transcribe worker', () => {
  test('wasm: transcribes the fixture inside the extension origin, reuses the model, stays local', async ({
    context,
    extensionId,
  }) => {
    const net = watchNetwork(context);
    const page = await context.newPage();
    logPageProblems(page);
    await page.goto(`chrome-extension://${extensionId}/app/app.html`);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

    await transcribeFixtureThroughWorker(page, 'wasm', net);

    console.log(`[privacy] origins seen: ${net.origins().join(', ')}`);
    net.assertOnlyAllowed();
    net.stop();
  });

  test('webgpu: same, with the fp32 encoder on WebGPU', async ({ context, extensionId }) => {
    test.skip(
      !process.env['RESCRIBE_E2E_WEBGPU'],
      'downloads the 2.4 GB fp32 encoder; set RESCRIBE_E2E_WEBGPU=1 to run',
    );
    const net = watchNetwork(context);
    const page = await context.newPage();
    logPageProblems(page);
    page.on('console', (m) => {
      if (/execution provider|Creating ONNX sessions|WebGPU/i.test(m.text()))
        console.log(`[page]`, m.text());
    });
    await page.goto(`chrome-extension://${extensionId}/app/app.html`);
    await transcribeFixtureThroughWorker(page, 'webgpu', net);
    console.log(`[privacy] origins seen: ${net.origins().join(', ')}`);
    net.assertOnlyAllowed();
    net.stop();
  });
});
