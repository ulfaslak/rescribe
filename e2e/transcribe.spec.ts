// The transcribe worker inside the extension origin: real parakeet.js + ORT WASM, the fixture PCM
// pushed through the worker protocol from the app page. Proves the WASM URL the worker derives
// from self.location, VAD → regions → segments, model reuse across jobs, and the privacy
// invariant (e2e/privacy.ts).
//
// The first run in a fresh profile downloads the int8 model (about 650 MB); later runs load it
// from the profile's IndexedDB. The WebGPU variant needs the 2.4 GB fp32 encoder and is skipped
// unless RESCRIBE_E2E_WEBGPU=1.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { watchNetwork } from './privacy.ts';
import type { Segment } from '../src/lib/types.ts';
import type { ProgressMessage, WorkerRequest, WorkerResponse } from '../src/workers/transcribe.ts';

const MODEL = 'parakeet-tdt-0.6b-v3';
const SAMPLE_RATE = 16000;

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

type Progress = Omit<ProgressMessage, 'type' | 'jobId'>;

interface JobReport {
  segments: Segment[];
  progress: Progress[];
  ms: number;
  error?: string;
}

interface JobSpec {
  samples: number[];
  kind: 'int16' | 'float32';
  model: string;
  backend: 'wasm' | 'webgpu';
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
          progress.push(rest);
        } else if (m.type === 'result') done({ segments: m.segments });
        else done({ segments: [], error: m.message });
      };
      worker.onerror = (e) => done({ segments: [], error: `worker error: ${e.message}` });
      const request: WorkerRequest = {
        type: 'transcribe',
        jobId,
        channel: 'mic',
        pcm,
        model: job.model,
        backend: job.backend,
      };
      worker.postMessage(request, [pcm.buffer]);
    });
  }, job);
}

function wordHitRate(segments: Segment[], expectedPath: string): number {
  const got = segments
    .map((s) => s.text)
    .join(' ')
    .toLowerCase();
  const words =
    readFileSync(expectedPath, 'utf8')
      .toLowerCase()
      .match(/[a-z']+/g) ?? [];
  return words.filter((w) => got.includes(w)).length / words.length;
}

function assertWellFormed(segments: Segment[], seconds: number): void {
  for (const s of segments) {
    expect(s.channel).toBe('mic');
    expect(s.start).toBeGreaterThanOrEqual(0);
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.end).toBeLessThanOrEqual(seconds);
    expect(s.text.length).toBeGreaterThan(0);
    expect(s.words?.length ?? 0).toBeGreaterThan(0);
    let prev = s.start;
    for (const w of s.words ?? []) {
      expect(w.start).toBeGreaterThanOrEqual(prev);
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      expect(w.end).toBeLessThanOrEqual(s.end);
      prev = w.start;
    }
  }
}

async function transcribeFixtureThroughWorker(
  page: Page,
  backend: 'wasm' | 'webgpu',
  net: ReturnType<typeof watchNetwork>,
): Promise<void> {
  const fixture = readWav16kMono('e2e/fixtures/speech.wav');
  const seconds = fixture.length / SAMPLE_RATE;
  const samples = Array.from(fixture);

  // Job 1: Int16 input, as the PCM files in OPFS hold it. Downloads and loads the model.
  const first = await runJob(page, { samples, kind: 'int16', model: MODEL, backend });
  console.log(
    `[transcribe ${backend}] job 1: ${first.ms} ms for ${seconds.toFixed(2)} s of audio ` +
      `(RTF ${(first.ms / 1000 / seconds).toFixed(3)}), segments: ${JSON.stringify(first.segments)}`,
  );
  expect(first.error, first.error).toBeUndefined();
  const hits = wordHitRate(first.segments, 'e2e/fixtures/speech.txt');
  console.log(`[transcribe ${backend}] word hit rate ${hits.toFixed(2)}`);
  expect(hits).toBeGreaterThan(0.8);
  assertWellFormed(first.segments, seconds);

  // Every phase reported at least once; bytes reported iff bytes were actually downloaded.
  const phases = (r: JobReport) => new Set(r.progress.map((p) => p.phase));
  expect([...phases(first)].sort()).toEqual(['download', 'load', 'transcribe']);
  const downloaded = net.requests.some(
    (r) => r.host === 'huggingface.co' && /\/resolve\//.test(r.url),
  );
  const bytes = first.progress.filter((p) => p.phase === 'download' && p.loaded > 0);
  console.log(`[transcribe ${backend}] model ${downloaded ? 'downloaded' : 'cached'}`);
  if (downloaded) expect(bytes.length).toBeGreaterThan(0);
  const transcribe = first.progress.filter((p) => p.phase === 'transcribe');
  expect(transcribe.at(-1)).toMatchObject({ loaded: transcribe.at(-1)!.total });
  expect(transcribe.at(-1)!.total).toBeGreaterThan(0);

  // Job 2: same worker, Float32 input. The model is reused: no download or load phase, faster.
  const second = await runJob(page, { samples, kind: 'float32', model: MODEL, backend });
  console.log(`[transcribe ${backend}] job 2: ${second.ms} ms (model reused)`);
  expect(second.error, second.error).toBeUndefined();
  expect(wordHitRate(second.segments, 'e2e/fixtures/speech.txt')).toBeGreaterThan(0.8);
  expect([...phases(second)]).toEqual(['transcribe']);
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
}

test.describe('transcribe worker', () => {
  test('wasm: transcribes the fixture inside the extension origin, reuses the model, stays local', async ({
    context,
    extensionId,
  }) => {
    const net = watchNetwork(context);
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning')
        console.log(`[page ${m.type()}]`, m.text());
    });
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
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning')
        console.log(`[page ${m.type()}]`, m.text());
    });
    await page.goto(`chrome-extension://${extensionId}/app/app.html`);
    await transcribeFixtureThroughWorker(page, 'webgpu', net);
    console.log(`[privacy] origins seen: ${net.origins().join(', ')}`);
    net.assertOnlyAllowed();
    net.stop();
  });
});
