// Whisper's log-mel features, the input of every Whisper encoder (Edda, whisper-base). Pure and
// Node-testable: mel.test.ts checks it against values Hugging Face's WhisperFeatureExtractor
// produced for the same signal.
//
// What it reproduces (transformers `WhisperFeatureExtractor`, numpy path): the PCM zero-padded or
// cut to 30 s, reflect-padded by n_fft/2 at both ends, a periodic Hann window of 400 samples every
// 160, the power spectrum, a Slaney-scale, Slaney-normalised mel filterbank from 0 to 8 kHz,
// log10 clamped at 1e-10, the last frame dropped, everything floored at (max - 8), then
// (x + 4) / 4. Output layout is the encoder's `[nMels, 3000]`, row-major.

export const WHISPER_SAMPLES = 480000;
export const WHISPER_FRAMES = 3000;
const N_FFT = 400;
const HOP = 160;
const BINS = N_FFT / 2 + 1;
const SAMPLE_RATE = 16000;

// --- Slaney mel scale ------------------------------------------------------------------------

const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = 15;
const LOG_STEP = Math.log(6.4) / 27;

function hzToMel(hz: number): number {
  return hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP : (3 * hz) / 200;
}

function melToHz(mel: number): number {
  return mel >= MIN_LOG_MEL
    ? MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL))
    : (200 * mel) / 3;
}

/** The filterbank as `[nMels][201]`, row-major: weight of FFT bin k in mel band m. */
export function melFilters(nMels: number): Float64Array {
  const out = new Float64Array(nMels * BINS);
  const lo = hzToMel(0);
  const hi = hzToMel(SAMPLE_RATE / 2);
  const melHz: number[] = [];
  for (let i = 0; i < nMels + 2; i++) melHz.push(melToHz(lo + ((hi - lo) * i) / (nMels + 1)));
  for (let m = 0; m < nMels; m++) {
    const left = melHz[m]!;
    const centre = melHz[m + 1]!;
    const right = melHz[m + 2]!;
    const norm = 2 / (right - left);
    for (let k = 0; k < BINS; k++) {
      const f = (k * SAMPLE_RATE) / N_FFT;
      const down = (f - left) / (centre - left);
      const up = (right - f) / (right - centre);
      const w = Math.max(0, Math.min(down, up));
      if (w > 0) out[m * BINS + k] = w * norm;
    }
  }
  return out;
}

// --- FFT of length 400 -----------------------------------------------------------------------

/**
 * A mixed-radix decimation-in-time FFT for one fixed length whose prime factors are small (400 =
 * 2⁴·5²): each level splits by its factor p and recombines with a p-point DFT. In place of a
 * power-of-two FFT because Whisper's window is 400 samples and must not be padded.
 */
export class Fft {
  readonly n: number;
  private readonly factors: number[];
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.factors = [];
    let rest = n;
    for (const p of [4, 2, 3, 5]) {
      while (rest % p === 0) {
        this.factors.push(p);
        rest /= p;
      }
    }
    if (rest !== 1) throw new Error(`Fft: ${n} has a prime factor above 5`);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** Forward transform of the real or complex input; results in `outRe`/`outIm`. */
  transform(
    inRe: Float64Array,
    inIm: Float64Array | undefined,
    outRe: Float64Array,
    outIm: Float64Array,
  ): void {
    this.step(inRe, inIm, 0, 1, outRe, outIm, 0, this.n, 0);
  }

  private step(
    inRe: Float64Array,
    inIm: Float64Array | undefined,
    inOff: number,
    stride: number,
    outRe: Float64Array,
    outIm: Float64Array,
    outOff: number,
    n: number,
    level: number,
  ): void {
    if (n === 1) {
      outRe[outOff] = inRe[inOff]!;
      outIm[outOff] = inIm ? inIm[inOff]! : 0;
      return;
    }
    const p = this.factors[level]!;
    const m = n / p;
    // p sub-transforms of length m over the inputs r, r + p, r + 2p…, laid out one after another.
    for (let r = 0; r < p; r++)
      this.step(
        inRe,
        inIm,
        inOff + r * stride,
        stride * p,
        outRe,
        outIm,
        outOff + r * m,
        m,
        level + 1,
      );
    // Recombine: X[k + q·m] = Σ_r W_n^{r·(k + q·m)} · Y_r[k].
    const twiddle = this.n / n;
    const tRe = new Float64Array(p);
    const tIm = new Float64Array(p);
    for (let k = 0; k < m; k++) {
      for (let r = 0; r < p; r++) {
        const yr = outRe[outOff + r * m + k]!;
        const yi = outIm[outOff + r * m + k]!;
        const idx = (r * k * twiddle) % this.n;
        const c = this.cos[idx]!;
        const s = this.sin[idx]!;
        tRe[r] = yr * c - yi * s;
        tIm[r] = yr * s + yi * c;
      }
      for (let q = 0; q < p; q++) {
        let re = 0;
        let im = 0;
        for (let r = 0; r < p; r++) {
          const idx = (((r * q) % p) * m * twiddle) % this.n;
          const c = this.cos[idx]!;
          const s = this.sin[idx]!;
          re += tRe[r]! * c - tIm[r]! * s;
          im += tRe[r]! * s + tIm[r]! * c;
        }
        outRe[outOff + q * m + k] = re;
        outIm[outOff + q * m + k] = im;
      }
    }
  }
}

// --- Features --------------------------------------------------------------------------------

const fft = new Fft(N_FFT);
const HANN = (() => {
  const w = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  return w;
})();
const filterCache = new Map<number, Float64Array>();

/**
 * Whisper's encoder input for up to 30 s of 16 kHz mono PCM: `[nMels, 3000]` row-major. Longer
 * input is cut at 30 s. Frames that lie wholly in the zero padding are not transformed: their
 * power is zero, so a 3 s region costs a tenth of a full window.
 */
export function logMel(pcm: Float32Array, nMels: number): Float32Array {
  let filters = filterCache.get(nMels);
  if (!filters) {
    filters = melFilters(nMels);
    filterCache.set(nMels, filters);
  }
  const len = Math.min(pcm.length, WHISPER_SAMPLES);
  const sample = (j: number): number => {
    // Index into the 30 s signal, reflect-padded by N_FFT/2 on both sides.
    if (j < 0) j = -j;
    else if (j >= WHISPER_SAMPLES) j = 2 * (WHISPER_SAMPLES - 1) - j;
    return j < len ? pcm[j]! : 0;
  };
  const mel = new Float64Array(nMels * WHISPER_FRAMES);
  const frame = new Float64Array(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  for (let t = 0; t < WHISPER_FRAMES; t++) {
    const first = t * HOP - N_FFT / 2;
    // Wholly in the zero padding (the right reflection only reaches back N_FFT/2 samples, which
    // a short signal never fills): every mel value stays 0.
    if (first >= len && first + N_FFT <= WHISPER_SAMPLES) continue;
    for (let i = 0; i < N_FFT; i++) frame[i] = sample(first + i) * HANN[i]!;
    fft.transform(frame, undefined, re, im);
    for (let k = 0; k < BINS; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    for (let m = 0; m < nMels; m++) {
      let acc = 0;
      const row = m * BINS;
      for (let k = 0; k < BINS; k++) {
        const w = filters[row + k]!;
        if (w !== 0) acc += w * power[k]!;
      }
      mel[m * WHISPER_FRAMES + t] = acc;
    }
  }
  let max = -Infinity;
  for (let i = 0; i < mel.length; i++) {
    const v = Math.log10(Math.max(mel[i]!, 1e-10));
    mel[i] = v;
    if (v > max) max = v;
  }
  const out = new Float32Array(mel.length);
  const floor = max - 8;
  for (let i = 0; i < mel.length; i++) out[i] = (Math.max(mel[i]!, floor) + 4) / 4;
  return out;
}
