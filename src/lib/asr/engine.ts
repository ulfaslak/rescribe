// The ASR engine interface. Engine-agnostic: parakeet.ts (Parakeet) and whisper.ts (Edda)
// implement it; the transcribe worker picks the recognisers by `EngineOptions.model`
// (DECISIONS § Speech recognition).
import type { Word } from '../types.ts';

export type Backend = 'wasm' | 'webgpu';

/** Parakeet TDT 0.6B v3 alone, every language (parakeet.js's model key). */
export const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3';
/**
 * Danish to Edda, the rest to Parakeet, routed by whisper-base's language ID (route.ts,
 * whisper.ts). The default (DECISIONS § Speech recognition).
 */
export const DANISH_ENGLISH_MODEL = 'danish-english';
/** The model keys Settings offers, default first. */
export const MODELS = [DANISH_ENGLISH_MODEL, PARAKEET_MODEL] as const;

export interface EngineOptions {
  /** A key from `MODELS`. */
  model: string;
  backend: Backend;
  /**
   * Where Edda's encoder runs, for the Danish + English model: the app decides (WebGPU when the
   * setting says so or the browser has an adapter, DECISIONS § Speech recognition). Absent: as
   * `backend`.
   */
  danishBackend?: Backend;
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
  return a.model === b.model && a.backend === b.backend && a.danishBackend === b.danishBackend;
}
