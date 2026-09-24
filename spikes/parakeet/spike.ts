// Spike: parakeet.js + onnxruntime-web inside the extension origin. Loads Parakeet TDT 0.6B v3
// from the Hub (cached in IndexedDB), transcribes speech.wav, reports timing. See spikes/README.md.
import * as ort from 'onnxruntime-web';
import { fromHub } from 'parakeet.js';

declare global {
  interface Window {
    __spike?: Record<string, unknown>;
  }
}

const el = document.getElementById('out')!;
const r: Record<string, unknown> = {};
const show = () => {
  el.textContent = JSON.stringify(r, null, 1);
};
const done = () => {
  window.__spike = r;
  show();
};

function parseWav16kMono(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf);
  const channels = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  const bits = dv.getUint16(34, true);
  if (sampleRate !== 16000 || bits !== 16)
    throw new Error(`expected 16 kHz 16-bit wav, got ${sampleRate}/${bits}`);
  let off = 12;
  while (off < dv.byteLength) {
    const id = String.fromCharCode(
      dv.getUint8(off),
      dv.getUint8(off + 1),
      dv.getUint8(off + 2),
      dv.getUint8(off + 3),
    );
    const size = dv.getUint32(off + 4, true);
    if (id === 'data') {
      const n = Math.floor(size / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = dv.getInt16(off + 8 + i * 2 * channels, true) / 32768;
      return out;
    }
    off += 8 + size;
  }
  throw new Error('no data chunk');
}

async function run(): Promise<void> {
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
  r.crossOriginIsolated = globalThis.crossOriginIsolated;
  r.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  r.hardwareConcurrency = navigator.hardwareConcurrency;
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter() : null;
  r.webgpu = adapter
    ? {
        f16: adapter.features.has('shader-f16'),
        vendor: adapter.info?.vendor,
        architecture: adapter.info?.architecture,
      }
    : null;
  show();

  const q = new URLSearchParams(location.search);
  const backend = (q.get('backend') ?? (adapter ? 'webgpu' : 'wasm')) as 'webgpu' | 'wasm';
  const encoderQuant = (q.get('enc') ?? (backend === 'webgpu' ? 'fp32' : 'int8')) as
    'fp16' | 'fp32' | 'int8';
  r.requested = { backend, encoderQuant, decoderQuant: 'int8' };
  const progress: Record<string, string> = {};
  const t0 = performance.now();
  const model = await fromHub('parakeet-tdt-0.6b-v3', {
    backend,
    encoderQuant,
    decoderQuant: 'int8',
    progress: (p) => {
      progress[p.file] = `${Math.round(p.loaded / 1e6)}/${Math.round(p.total / 1e6)} MB`;
      r.progress = progress;
      show();
    },
  });
  r.loadMs = Math.round(performance.now() - t0);
  r.ortThreads = ort.env.wasm.numThreads;
  show();

  const wav = await (
    await fetch(chrome.runtime.getURL('spikes/parakeet/speech.wav'))
  ).arrayBuffer();
  const pcm = parseWav16kMono(wav);
  r.audioSeconds = pcm.length / 16000;
  const t1 = performance.now();
  const res = await model.transcribeLongAudio(pcm, 16000, { returnTimestamps: true });
  const transcribeMs = Math.round(performance.now() - t1);
  r.transcribeMs = transcribeMs;
  r.rtf = Number((transcribeMs / 1000 / (pcm.length / 16000)).toFixed(3));
  r.text = res.text;
  r.chunks = res.chunks;
  r.metrics = res.metrics;
}

run()
  .catch((e) => {
    r.error = String(e);
    r.stack = (e as Error).stack;
  })
  .finally(done);
