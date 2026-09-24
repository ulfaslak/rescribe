// The parakeet.js implementation of AsrEngine: NVIDIA Parakeet TDT 0.6B v3 on ONNX Runtime Web.
// Touches neither chrome.* nor the DOM, but it is not Node-testable: it needs ORT's WASM binaries
// and the model, so e2e/transcribe.spec.ts exercises it through the transcribe worker.
//
// Measured in the spike this file replaced (2026-09-24, headless Chromium, extension origin, Apple
// Silicon, 16 WASM threads, the 7.7 s fixture, word-perfect in every variant; the fixture is short,
// so treat the ratios as a floor):
//
// | Variant                                            | Download | Load (cached) | Transcribe 7.7 s |
// |----------------------------------------------------|----------|---------------|------------------|
// | wasm, encoder int8, decoder int8                   | 652 MB   | 8 s           | 1.31 s, ~6× RT   |
// | "webgpu", encoder fp32 external data, decoder int8 | 2.4 GB   | ~10 s         | 0.99 s, ~8× RT   |
// | webgpu, encoder fp16 single file                   | 1.24 GB  | fails         | std::bad_alloc   |
//
// The fp16 file is one 1.24 GB protobuf; ORT copies it into the 32-bit WASM heap and parses it into
// a second copy, which overflows the 4 GB ceiling. The fp32 export ships its weights as external
// data (`encoder-model.onnx` + `.onnx.data`), which ORT loads without the protobuf copy, so even at
// 2.4 GB it fits. Issue #10 tracks an fp16 external-data export.
//
// Caveat on the "webgpu" row: the spike passed parakeet.js's `'webgpu'` alias, which leaves ORT's
// execution providers empty in `fromUrls`, and ORT then tries its backends by priority with WASM
// before WebGPU. That row measured fp32 on WASM. This file passes `'webgpu-hybrid'` (encoder on
// WebGPU with WASM fallback, decoder on WASM), which is what parakeet.js means by WebGPU. Measured
// through the transcribe worker in headless Chromium (`RESCRIBE_E2E_WEBGPU=1`, 2026-09-24): the
// first call 0.99 s (shader warm-up included), the second 0.18 s for the 7.7 s fixture, ~44× real
// time, against ~0.9 s on WASM. Brave is unverified; see LIVE_CHECKS.
//
// Files are fetched one by one with parakeet.js's `getModelFile`, which serves its IndexedDB cache
// before the network, so a cached model loads with zero requests (DECISIONS: a one-time download).
// `getParakeetModel`/`fromHub` are not used: they list the Hub repo on every load, cached or not,
// and skip the external-data file when that listing fails, which broke WebGPU loading offline.
import * as ort from 'onnxruntime-web';
import { getModelConfig, getModelFile, ParakeetModel } from 'parakeet.js';
import type { AsrEngine, Backend, EngineOptions, Progress, Transcription } from './engine.ts';

export interface ParakeetEngineConfig {
  /**
   * URL prefix of the ORT WASM binaries the build copies to dist/vendor/ort/. The caller derives it
   * from its own context (a worker has no chrome.runtime.getURL).
   */
  wasmPaths: string;
}

/** Our backend names → parakeet.js backend modes. */
const PARAKEET_BACKEND = { wasm: 'wasm', webgpu: 'webgpu-hybrid' } as const;

/** The repo files per backend. WebGPU cannot run the int8 encoder; fp32 ships its weights aside. */
const ENCODER: Record<Backend, { model: string; data?: string }> = {
  wasm: { model: 'encoder-model.int8.onnx' },
  webgpu: { model: 'encoder-model.onnx', data: 'encoder-model.onnx.data' },
};
const DECODER = 'decoder_joint-model.int8.onnx';
const TOKENIZER = 'vocab.txt';

interface Releasable {
  release?: () => Promise<void>;
}
interface ModelSessions {
  encoderSession?: Releasable;
  joinerSession?: Releasable;
}

export class ParakeetEngine implements AsrEngine {
  readonly options: EngineOptions;
  private readonly wasmPaths: string;
  private model: ParakeetModel | undefined;

  constructor(options: EngineOptions, config: ParakeetEngineConfig) {
    this.options = options;
    this.wasmPaths = config.wasmPaths;
  }

  async load(onProgress?: (p: Progress) => void): Promise<void> {
    // parakeet.js sets wasmPaths only when unset, and its default is a jsDelivr CDN, which
    // DECISIONS forbids. Set it first, unconditionally, before any session is created.
    ort.env.wasm.wasmPaths = this.wasmPaths;
    const { backend, model } = this.options;
    if (backend === 'webgpu') await assertWebGpu();

    const repoId = getModelConfig(model)?.repoId ?? model;
    const encoder = ENCODER[backend];
    const urls: string[] = [];
    try {
      // Phase 1, download: each file from the IndexedDB cache or huggingface.co. The progress
      // callback only fires while bytes move, so a cached model reports just the opening marker.
      onProgress?.({ phase: 'download', loaded: 0, total: 0 });
      const fetchFile = async (file: string): Promise<string> => {
        const url = await getModelFile(repoId, file, {
          progress: (p) =>
            onProgress?.({ phase: 'download', loaded: p.loaded, total: p.total, file: p.file }),
        });
        urls.push(url);
        return url;
      };
      const encoderUrl = await fetchFile(encoder.model);
      const encoderDataUrl = encoder.data ? await fetchFile(encoder.data) : null;
      const decoderUrl = await fetchFile(DECODER);
      const tokenizerUrl = await fetchFile(TOKENIZER);

      // Phase 2, load: ORT session creation. No finer progress exists.
      onProgress?.({ phase: 'load', loaded: 0, total: 1 });
      this.model = await failOnDroppedWebGpu(backend, () =>
        ParakeetModel.fromUrls({
          encoderUrl,
          encoderDataUrl,
          decoderUrl,
          tokenizerUrl,
          filenames: { encoder: encoder.model, decoder: DECODER },
          preprocessorBackend: 'js',
          backend: PARAKEET_BACKEND[backend],
          wasmPaths: this.wasmPaths,
        }),
      );
      onProgress?.({ phase: 'load', loaded: 1, total: 1 });
    } finally {
      // The blob URLs pin the cached blobs (650 MB, 2.4 GB on WebGPU) next to ORT's own copy for
      // the worker's lifetime; the sessions and tokenizer have read them by now.
      for (const url of urls) URL.revokeObjectURL(url);
    }
  }

  async transcribe(pcm: Float32Array, sampleRate: 16000): Promise<Transcription> {
    if (!this.model) throw new Error('ParakeetEngine: load() before transcribe()');
    const result = await this.model.transcribeLongAudio(pcm, sampleRate, {
      returnTimestamps: 'word',
      // parakeet.js defaults this to true and then prints a console.table per call.
      enableProfiling: false,
    });
    const words = (result.words ?? []).map((w) => ({
      text: w.text,
      start: w.start_time,
      end: w.end_time,
    }));
    return { text: result.text, words };
  }

  dispose(): void {
    const model = this.model;
    this.model = undefined;
    if (model) releaseSessions(model);
  }
}

/**
 * ParakeetModel has no release of its own. Its two ORT sessions hold the weights in the WASM heap,
 * which garbage collection does not reclaim, so release them explicitly: a backend switch inside
 * one long-lived worker would otherwise leak the previous model. The field names are parakeet.js
 * internals; if a release renames them this must fail loudly, not turn into a silent leak.
 */
function releaseSessions(model: ParakeetModel): void {
  const sessions = model as unknown as ModelSessions;
  for (const name of ['encoderSession', 'joinerSession'] as const) {
    const session = sessions[name];
    if (!session || typeof session.release !== 'function') {
      console.error(
        `[rescribe] ParakeetModel.${name} is missing or has no release(); parakeet.js changed ` +
          'and src/lib/asr/parakeet.ts must follow, or every model reload leaks the WASM heap.',
      );
      continue;
    }
    session.release().catch((err: unknown) => console.warn('[rescribe] session release', err));
  }
}

/** A WebGPU load must not quietly become fp32 on WASM, slower than the int8 default. */
async function assertWebGpu(): Promise<void> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  const adapter = gpu ? await gpu.requestAdapter() : null;
  if (!adapter) {
    throw new Error('WebGPU is not available in this browser; switch the backend to WASM');
  }
}

/**
 * ORT drops an execution provider it cannot initialise with only a console.warn ("removing
 * requested execution provider ..." in onnxruntime-web/dist/ort.mjs) and runs on WASM. For the
 * WebGPU backend that is the silent degradation `assertWebGpu` guards against one step earlier;
 * catch it here too, at the moment it happens.
 */
async function failOnDroppedWebGpu<T extends ParakeetModel>(
  backend: Backend,
  create: () => Promise<T>,
): Promise<T> {
  if (backend !== 'webgpu') return create();
  const originalWarn = console.warn;
  let dropped: string | undefined;
  console.warn = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (/removing requested execution provider "webgpu"/.test(text)) dropped = text;
    originalWarn.apply(console, args);
  };
  try {
    const model = await create();
    if (dropped) {
      releaseSessions(model);
      throw new Error(`WebGPU refused by ONNX Runtime, not running on WASM instead: ${dropped}`);
    }
    return model;
  } finally {
    console.warn = originalWarn;
  }
}
