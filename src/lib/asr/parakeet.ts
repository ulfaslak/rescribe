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
import * as ort from 'onnxruntime-web';
import { getParakeetModel, ParakeetModel } from 'parakeet.js';
import type { AsrEngine, EngineOptions, Progress, Transcription } from './engine.ts';

export interface ParakeetEngineConfig {
  /**
   * URL prefix of the ORT WASM binaries the build copies to dist/vendor/ort/. The caller derives it
   * from its own context (a worker has no chrome.runtime.getURL).
   */
  wasmPaths: string;
}

/** Our backend names → parakeet.js backend modes. */
const PARAKEET_BACKEND = { wasm: 'wasm', webgpu: 'webgpu-hybrid' } as const;

interface Releasable {
  release?: () => Promise<void>;
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
    const backend = PARAKEET_BACKEND[this.options.backend];
    // WebGPU cannot run the int8 encoder; the hub loader would force fp32 anyway. Be explicit.
    const encoderQuant = this.options.backend === 'webgpu' ? 'fp32' : 'int8';

    // Phase 1, download: parakeet.js resolves each file from its IndexedDB cache or huggingface.co.
    // Its progress callback only fires while bytes actually move, so a fully cached model reports
    // just this opening marker.
    onProgress?.({ phase: 'download', loaded: 0, total: 0 });
    const files = await getParakeetModel(this.options.model, {
      backend,
      encoderQuant,
      decoderQuant: 'int8',
      progress: (p) =>
        onProgress?.({ phase: 'download', loaded: p.loaded, total: p.total, file: p.file }),
    });

    // Phase 2, load: ORT session creation. No finer progress exists.
    onProgress?.({ phase: 'load', loaded: 0, total: 1 });
    this.model = await ParakeetModel.fromUrls({
      ...files.urls,
      filenames: files.filenames,
      preprocessorBackend: files.preprocessorBackend,
      backend,
      wasmPaths: this.wasmPaths,
    });
    onProgress?.({ phase: 'load', loaded: 1, total: 1 });
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
    // ParakeetModel has no release of its own. Its two ORT sessions hold the weights in the WASM
    // heap, which JS garbage collection does not reclaim, so release them explicitly: a backend
    // switch inside one long-lived worker would otherwise leak the previous model.
    const sessions = this.model as unknown as
      { encoderSession?: Releasable; joinerSession?: Releasable } | undefined;
    this.model = undefined;
    for (const s of [sessions?.encoderSession, sessions?.joinerSession]) {
      try {
        void s?.release?.()?.catch(() => undefined);
      } catch {
        // Already released, or a backend without release(): nothing to free.
      }
    }
  }
}
