// The ASR engine interface. Engine-agnostic: parakeet.ts implements it today; sherpa-onnx or
// Whisper would be another file implementing the same three methods, and the transcribe worker
// would pick between them by `EngineOptions.model` (DECISIONS § Speech recognition).
import type { Word } from '../types.ts';

export type Backend = 'wasm' | 'webgpu';

export interface EngineOptions {
  /** Model key understood by the engine, e.g. parakeet.js's 'parakeet-tdt-0.6b-v3'. */
  model: string;
  backend: Backend;
}

export type ProgressPhase = 'download' | 'load' | 'transcribe';

export interface Progress {
  phase: ProgressPhase;
  /**
   * Units depend on the phase: bytes of `file` for 'download', steps for 'load', regions done for
   * 'transcribe'. `total` 0 means "started, size unknown".
   */
  loaded: number;
  total: number;
  file?: string;
}

export interface Transcription {
  text: string;
  /** Word timings in seconds from the start of the PCM that was passed in. */
  words: Word[];
}

export interface AsrEngine {
  readonly options: EngineOptions;
  /** Downloads (first time) and loads the model. Idempotent per instance is not required. */
  load(onProgress?: (p: Progress) => void): Promise<void>;
  /** Recognises one bounded stretch of mono PCM. Call `load()` first. */
  transcribe(pcm: Float32Array, sampleRate: 16000): Promise<Transcription>;
  /** Frees the model. The instance is not reusable afterwards. */
  dispose(): void;
}

export function sameEngineOptions(a: EngineOptions, b: EngineOptions): boolean {
  return a.model === b.model && a.backend === b.backend;
}
