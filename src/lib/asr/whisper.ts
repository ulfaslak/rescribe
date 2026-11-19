// Whisper on ONNX Runtime Web, without a framework: log-mel features (mel.ts), the encoder, and a
// greedy decoder with its key/value cache. Two uses (DECISIONS § Speech recognition):
//   - Edda v0.2 (Whisper large-v3-turbo fine-tuned on Danish) transcribes Danish: `EddaEngine`.
//   - whisper-base tells Danish from English, restricted to those two: `WhisperLanguageId`.
// The int8 exports run on WASM (ORT's WebGPU provider has no DynamicQuantizeMatMul). On WebGPU,
// Edda's encoder, most of its time on WASM because Whisper always encodes a full 30 s window,
// runs in fp16 instead; its decoder stays int8 on WASM, as parakeet.js's 'webgpu-hybrid' does.
// Measured through the worker on 5 min of a real Danish call (2026-11-19, headless Chromium,
// Apple Silicon): 81 s with the encoder on WebGPU, 303 s on WASM; Parakeet alone took 62 s.
// The language ID is cheap and stays on WASM.
//
// Like parakeet.ts this needs ORT's WASM and the model, so it is covered by e2e/transcribe.spec.ts,
// not by Node tests; its pure halves (mel.ts, tokens.ts) are. The files come through parakeet.js's
// `getModelFile` (IndexedDB first, huggingface.co once), pinned to a commit so a later push to a
// repo never changes what a cached install runs.
//
// The decoder is the two-file export (`decoder_model` for the prompt, `decoder_with_past_model`
// for every later token) because quantizing optimum's merged decoder breaks its If subgraph.
import * as ort from 'onnxruntime-web';
import { getModelFile } from 'parakeet.js';
import type { AsrEngine, Backend, EngineOptions, Progress, Transcription } from './engine.ts';
import { assertWebGpu, failOnDroppedWebGpu } from './webgpu.ts';
import { logMel, WHISPER_SAMPLES } from './mel.ts';
import { loopStart, RUNAWAY_REPEATS, soundsInvented, spreadWords, WhisperVocab } from './tokens.ts';

export interface WhisperSpec {
  /** Prefixes the file names in download progress, so two repos' `encoder_model_int8.onnx` differ. */
  name: string;
  repoId: string;
  /** A commit, never a branch. */
  revision: string;
  nMels: number;
  encoder: string;
  decoder: string;
  /** Needed to transcribe; language ID reads only the first step. */
  decoderWithPast?: string;
  /** The encoder for the WebGPU backend: fp16, its weights as external data (over 1 GB). */
  webgpuEncoder?: { model: string; data: string };
}

/** Edda v0.2 int8, converted and hosted for Rescribe (the repo's README says how). */
export const EDDA: WhisperSpec = {
  name: 'edda',
  repoId: 'ulfaslak/edda-v0.2-onnx',
  revision: 'ef0065cc797396f5bb0daa40012ef8fc0d09a889',
  nMels: 128,
  encoder: 'onnx/encoder_model_int8.onnx',
  decoder: 'onnx/decoder_model_int8.onnx',
  decoderWithPast: 'onnx/decoder_with_past_model_int8.onnx',
  webgpuEncoder: {
    model: 'onnx/encoder_model_fp16.onnx',
    data: 'onnx/encoder_model_fp16.onnx.data',
  },
};

/** whisper-base int8 from onnx-community, for language ID only. */
export const WHISPER_BASE: WhisperSpec = {
  name: 'whisper-base',
  repoId: 'onnx-community/whisper-base',
  revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
  nMels: 80,
  encoder: 'onnx/encoder_model_int8.onnx',
  decoder: 'onnx/decoder_model_int8.onnx',
};

/** Whisper's decoder context is 448 tokens; the prompt takes 4. */
const MAX_NEW_TOKENS = 440;

type Feeds = Record<string, ort.Tensor>;

export class WhisperModel {
  readonly spec: WhisperSpec;
  private readonly encoder: ort.InferenceSession;
  private readonly decoder: ort.InferenceSession;
  private readonly decoderWithPast: ort.InferenceSession | undefined;
  readonly vocab: WhisperVocab;

  private constructor(
    spec: WhisperSpec,
    sessions: [ort.InferenceSession, ort.InferenceSession, ort.InferenceSession | undefined],
    vocab: WhisperVocab,
  ) {
    this.spec = spec;
    [this.encoder, this.decoder, this.decoderWithPast] = sessions;
    this.vocab = vocab;
  }

  static async load(
    spec: WhisperSpec,
    wasmPaths: string,
    backend: Backend,
    onProgress?: (p: Progress) => void,
  ): Promise<WhisperModel> {
    ort.env.wasm.wasmPaths = wasmPaths;
    const gpu = backend === 'webgpu' ? spec.webgpuEncoder : undefined;
    if (gpu) await assertWebGpu();
    // ORT reads the thread count once, when the first session of the worker is created, and this
    // may be that session (the language ID loads before Parakeet). Same count as parakeet.js sets.
    ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
    const urls: string[] = [];
    const sessions: ort.InferenceSession[] = [];
    try {
      onProgress?.({ phase: 'download', loaded: 0, total: 0 });
      const fetchFile = async (file: string): Promise<string> => {
        const url = await getModelFile(spec.repoId, file, {
          revision: spec.revision,
          progress: (p) =>
            onProgress?.({
              phase: 'download',
              loaded: p.loaded,
              total: p.total,
              file: `${spec.name}/${p.file}`,
            }),
        });
        urls.push(url);
        return url;
      };
      const vocabJson = await (await fetch(await fetchFile('vocab.json'))).json();
      const addedJson = await (await fetch(await fetchFile('added_tokens.json'))).json();
      const encoderUrl = await fetchFile(gpu ? gpu.model : spec.encoder);
      const encoderDataUrl = gpu ? await fetchFile(gpu.data) : undefined;
      const decoderUrl = await fetchFile(spec.decoder);
      const pastUrl = spec.decoderWithPast ? await fetchFile(spec.decoderWithPast) : undefined;

      onProgress?.({ phase: 'load', loaded: 0, total: 1 });
      const wasm: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] };
      const encoder =
        gpu && encoderDataUrl
          ? await failOnDroppedWebGpu(
              'webgpu',
              (s) => void s.release().catch(() => undefined),
              () =>
                ort.InferenceSession.create(encoderUrl, {
                  executionProviders: ['webgpu'],
                  // The graph names its weights file by its bare name, next to the model.
                  externalData: [{ path: gpu.data.split('/').pop()!, data: encoderDataUrl }],
                }),
            )
          : await ort.InferenceSession.create(encoderUrl, wasm);
      sessions.push(encoder);
      sessions.push(await ort.InferenceSession.create(decoderUrl, wasm));
      if (pastUrl) sessions.push(await ort.InferenceSession.create(pastUrl, wasm));
      onProgress?.({ phase: 'load', loaded: 1, total: 1 });
      return new WhisperModel(
        spec,
        [sessions[0]!, sessions[1]!, sessions[2]],
        new WhisperVocab(vocabJson as Record<string, number>, addedJson as Record<string, number>),
      );
    } catch (err) {
      for (const s of sessions) void s.release().catch(() => undefined);
      throw err;
    } finally {
      for (const url of urls) URL.revokeObjectURL(url);
    }
  }

  /** The encoder's output for up to 30 s of 16 kHz mono; longer input is cut. */
  async encode(pcm: Float32Array): Promise<ort.Tensor> {
    const features = logMel(pcm, this.spec.nMels);
    const out = await this.encoder.run({
      input_features: new ort.Tensor('float32', features, [1, this.spec.nMels, 3000]),
    });
    return out['last_hidden_state']!;
  }

  /** P(first language) against the second, from the language token after `<|startoftranscript|>`. */
  async languageOdds(pcm: Float32Array, a: string, b: string): Promise<number> {
    const hidden = await this.encode(pcm);
    const out = await this.decoder.run({
      input_ids: ids([this.vocab.id('<|startoftranscript|>')]),
      encoder_hidden_states: hidden,
    });
    const logits = lastRow(out['logits']!);
    const la = logits[this.vocab.id(`<|${a}|>`)]!;
    const lb = logits[this.vocab.id(`<|${b}|>`)]!;
    const m = Math.max(la, lb);
    const ea = Math.exp(la - m);
    return ea / (ea + Math.exp(lb - m));
  }

  /** Greedy transcription of up to 30 s in `language`, without timestamps. */
  async transcribe(pcm: Float32Array, language: string): Promise<string> {
    if (!this.decoderWithPast) throw new Error(`${this.spec.name} was loaded for language ID only`);
    const hidden = await this.encode(pcm);
    const v = this.vocab;
    const prompt = [
      '<|startoftranscript|>',
      `<|${language}|>`,
      '<|transcribe|>',
      '<|notimestamps|>',
    ];
    let out = await this.decoder.run({
      input_ids: ids(prompt.map((t) => v.id(t))),
      encoder_hidden_states: hidden,
    });
    const cache: Feeds = {};
    const tokens: number[] = [];
    const logprobs: number[] = [];
    while (tokens.length < MAX_NEW_TOKENS) {
      const { token: next, logprob } = pickText(lastRow(out['logits']!), v.eot);
      if (next === v.eot) break;
      tokens.push(next);
      logprobs.push(logprob);
      // Stop early only on a loop no speaker makes (tokens.ts); an ordinary one is trimmed below.
      const runaway = loopStart(tokens, RUNAWAY_REPEATS);
      if (runaway !== undefined) {
        tokens.length = runaway;
        break;
      }
      // The prompt step returns the cross-attention cache too; later steps only the self-attention
      // one, so the encoder entries are kept from the first step.
      for (const [name, tensor] of Object.entries(out)) {
        if (name.startsWith('present.'))
          cache[name.replace('present.', 'past_key_values.')] = tensor;
      }
      out = await this.decoderWithPast.run({ input_ids: ids([next]), ...cache });
    }
    // A window that ran to the cap without an end is a decoder in a loop: keep the first copy.
    if (tokens.length >= MAX_NEW_TOKENS) tokens.length = loopStart(tokens) ?? tokens.length;
    if (soundsInvented(logprobs.slice(0, tokens.length))) return '';
    return v.decode(tokens);
  }

  dispose(): void {
    for (const s of [this.encoder, this.decoder, this.decoderWithPast])
      void s?.release().catch((err: unknown) => console.warn('[rescribe] whisper release', err));
  }
}

function ids(values: number[]): ort.Tensor {
  return new ort.Tensor(
    'int64',
    BigInt64Array.from(values, (x) => BigInt(x)),
    [1, values.length],
  );
}

/** The logits of the last position of a `[1, seq, vocab]` tensor. */
function lastRow(logits: ort.Tensor): Float32Array {
  const [, seq, vocab] = logits.dims as [number, number, number];
  return (logits.data as Float32Array).subarray((seq - 1) * vocab, seq * vocab);
}

/**
 * The likeliest text token or the end, every other special token (timestamps, tasks) out, and its
 * log-probability among those.
 */
function pickText(logits: Float32Array, eot: number): { token: number; logprob: number } {
  let best = 0;
  for (let i = 1; i <= eot; i++) if (logits[i]! > logits[best]!) best = i;
  const max = logits[best]!;
  let sum = 0;
  for (let i = 0; i <= eot; i++) sum += Math.exp(logits[i]! - max);
  return { token: best, logprob: -Math.log(sum) };
}

/** Edda as an `AsrEngine`: Danish only, text with words spread over the region (tokens.ts). */
export class EddaEngine implements AsrEngine {
  readonly options: EngineOptions;
  private readonly wasmPaths: string;
  private model: WhisperModel | undefined;
  /** Where the encoder actually runs: the worker reports it with every result. */
  ranOn: Backend = 'wasm';

  constructor(options: EngineOptions, config: { wasmPaths: string }) {
    this.options = options;
    this.wasmPaths = config.wasmPaths;
  }

  /**
   * WebGPU the app picked because an adapter exists, not the human's backend setting: if it fails,
   * at load or later (the GPU lost after the Mac slept, in a worker kept all day), Edda moves to
   * WASM, slower but a transcript. WebGPU the human chose fails loudly, as Parakeet's does.
   */
  private get mayFallBack(): boolean {
    return this.ranOn === 'webgpu' && this.options.backend !== 'webgpu';
  }

  async load(onProgress?: (p: Progress) => void): Promise<void> {
    this.ranOn = this.options.danishBackend ?? this.options.backend;
    try {
      this.model = await WhisperModel.load(EDDA, this.wasmPaths, this.ranOn, onProgress);
    } catch (err) {
      if (!this.mayFallBack) throw err;
      await this.fallBack(err, onProgress);
    }
  }

  private async fallBack(err: unknown, onProgress?: (p: Progress) => void): Promise<void> {
    console.warn('[rescribe] Edda on WebGPU failed, running it on WASM instead:', err);
    this.model?.dispose();
    this.model = undefined;
    this.ranOn = 'wasm';
    this.model = await WhisperModel.load(EDDA, this.wasmPaths, 'wasm', onProgress);
  }

  async transcribe(pcm: Float32Array, sampleRate: 16000): Promise<Transcription> {
    if (!this.model) throw new Error('EddaEngine: load() before transcribe()');
    // A region is at most 30 s (VAD maxRegionS), one Whisper window; guard anyway.
    const window = pcm.length > WHISPER_SAMPLES ? pcm.subarray(0, WHISPER_SAMPLES) : pcm;
    let text: string;
    try {
      text = await this.model.transcribe(window, 'da');
    } catch (err) {
      if (!this.mayFallBack) throw err;
      await this.fallBack(err);
      text = await this.model!.transcribe(window, 'da');
    }
    return { text, words: spreadWords(text, window.length / sampleRate) };
  }

  dispose(): void {
    this.model?.dispose();
    this.model = undefined;
  }
}

/** Danish or English, from whisper-base's language token restricted to the two. */
export class WhisperLanguageId {
  private readonly wasmPaths: string;
  private model: WhisperModel | undefined;

  constructor(config: { wasmPaths: string }) {
    this.wasmPaths = config.wasmPaths;
  }

  async load(onProgress?: (p: Progress) => void): Promise<void> {
    this.model = await WhisperModel.load(WHISPER_BASE, this.wasmPaths, 'wasm', onProgress);
  }

  /** P(Danish) against English for up to 30 s of speech. */
  pDanish(pcm: Float32Array): Promise<number> {
    if (!this.model) throw new Error('WhisperLanguageId: load() before pDanish()');
    return this.model.languageOdds(pcm, 'da', 'en');
  }

  dispose(): void {
    this.model?.dispose();
    this.model = undefined;
  }
}
