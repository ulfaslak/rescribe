// Whisper on ONNX Runtime Web, without a framework: log-mel features (mel.ts), the encoder, and a
// greedy decoder with its key/value cache. Two uses (DECISIONS § Speech recognition):
//   - Edda v0.2 (Whisper large-v3-turbo fine-tuned on Danish) transcribes Danish: `EddaEngine`.
//   - whisper-base tells Danish from English, restricted to those two: `WhisperLanguageId`.
// Both run on WASM whatever the backend setting: the int8 exports use DynamicQuantizeMatMul,
// which ORT's WebGPU provider does not have.
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
import type { AsrEngine, EngineOptions, Progress, Transcription } from './engine.ts';
import { logMel, WHISPER_SAMPLES } from './mel.ts';
import { loopStart, spreadWords, WhisperVocab } from './tokens.ts';

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
}

/** Edda v0.2 int8, converted and hosted for Rescribe (the repo's README says how). */
export const EDDA: WhisperSpec = {
  name: 'edda',
  repoId: 'ulfaslak/edda-v0.2-onnx',
  revision: '0a38379a20342deea230a8c580e1ff03355e3e91',
  nMels: 128,
  encoder: 'onnx/encoder_model_int8.onnx',
  decoder: 'onnx/decoder_model_int8.onnx',
  decoderWithPast: 'onnx/decoder_with_past_model_int8.onnx',
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
    onProgress?: (p: Progress) => void,
  ): Promise<WhisperModel> {
    ort.env.wasm.wasmPaths = wasmPaths;
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
      const files = [spec.encoder, spec.decoder, spec.decoderWithPast];
      const fileUrls: (string | undefined)[] = [];
      for (const f of files) fileUrls.push(f ? await fetchFile(f) : undefined);

      onProgress?.({ phase: 'load', loaded: 0, total: 1 });
      const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] };
      for (const url of fileUrls)
        if (url) sessions.push(await ort.InferenceSession.create(url, options));
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
    while (tokens.length < MAX_NEW_TOKENS) {
      const next = argmaxText(lastRow(out['logits']!), v.eot);
      if (next === v.eot) break;
      tokens.push(next);
      const loop = loopStart(tokens);
      if (loop !== undefined) {
        tokens.length = loop;
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

/** The likeliest text token or the end: every other special token (timestamps, tasks) is out. */
function argmaxText(logits: Float32Array, eot: number): number {
  let best = 0;
  for (let i = 1; i <= eot; i++) if (logits[i]! > logits[best]!) best = i;
  return best;
}

/** Edda as an `AsrEngine`: Danish only, text with words spread over the region (tokens.ts). */
export class EddaEngine implements AsrEngine {
  readonly options: EngineOptions;
  private readonly wasmPaths: string;
  private model: WhisperModel | undefined;

  constructor(options: EngineOptions, config: { wasmPaths: string }) {
    this.options = options;
    this.wasmPaths = config.wasmPaths;
  }

  async load(onProgress?: (p: Progress) => void): Promise<void> {
    this.model = await WhisperModel.load(EDDA, this.wasmPaths, onProgress);
  }

  async transcribe(pcm: Float32Array, sampleRate: 16000): Promise<Transcription> {
    if (!this.model) throw new Error('EddaEngine: load() before transcribe()');
    // A region is at most 30 s (VAD maxRegionS), one Whisper window; guard anyway.
    const window = pcm.length > WHISPER_SAMPLES ? pcm.subarray(0, WHISPER_SAMPLES) : pcm;
    const text = await this.model.transcribe(window, 'da');
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
    this.model = await WhisperModel.load(WHISPER_BASE, this.wasmPaths, onProgress);
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
