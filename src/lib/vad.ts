// Energy-based voice activity detection over 16 kHz mono PCM: which stretches of a channel are
// worth sending to the recogniser. Pure and Node-testable; the transcribe worker is its one caller.
// DECISIONS § Speech recognition: energy-based first, Silero later (issue #9).
//
// Pipeline: RMS per frame in dBFS → adaptive threshold (a low percentile of the frame energies is
// the noise floor; threshold = floor + margin, clamped to an absolute range so silence and
// near-silence never trigger and a loud constant floor never gates speech) → hangover keeps a
// region open briefly after the level drops → pad → merge close regions → drop regions with too
// little voiced content → split long regions at their quietest frame.
//
// Accepts Int16Array as well as Float32Array so a whole channel never has to be converted: the
// worker converts one region at a time (see src/workers/transcribe.ts).

export interface Region {
  /** Seconds from the start of the PCM. */
  start: number;
  end: number;
}

export type Pcm = Float32Array | Int16Array;

export interface VadOptions {
  /** Analysis frame length. Region edges are quantised to it. */
  frameMs: number;
  /** Fraction of frames assumed to be background; their energy is the noise floor. */
  noisePercentile: number;
  /** Frames this far above the noise floor are voiced. */
  marginDb: number;
  /** The threshold is never below this, so pure silence and near-silence never trigger. */
  minThresholdDb: number;
  /** The threshold is never above this, so a loud constant floor never gates speech. */
  maxThresholdDb: number;
  /** A region stays open this long after the level drops: word tails, short pauses. */
  hangoverMs: number;
  /** Added before and after every region so onsets and tails are not clipped. */
  padMs: number;
  /** Regions closer than this become one region. */
  mergeGapMs: number;
  /**
   * Regions with less above-threshold content than this are dropped: clicks, coughs, key taps.
   * Measured on the frames that were actually above the threshold, not on the padded length,
   * because hangover plus padding alone make every region longer than this.
   */
  minVoicedMs: number;
  /** Regions longer than this are split so the recogniser sees bounded input. */
  maxRegionS: number;
  /** A long region is cut at the quietest frame within this many seconds before the limit. */
  splitSearchS: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  frameMs: 20,
  noisePercentile: 0.1,
  marginDb: 8,
  minThresholdDb: -50,
  maxThresholdDb: -30,
  hangoverMs: 300,
  padMs: 200,
  mergeGapMs: 500,
  minVoicedMs: 250,
  maxRegionS: 30,
  splitSearchS: 5,
};

/** Int16 PCM → Float32 in [-1, 1). Writes into `out` when given (it must be at least as long). */
export function int16ToFloat32(
  pcm: Int16Array,
  out: Float32Array = new Float32Array(pcm.length),
): Float32Array {
  const n = pcm.length;
  for (let i = 0; i < n; i++) out[i] = pcm[i]! / 32768;
  return out;
}

/**
 * RMS level per non-overlapping frame, in dBFS (0 dBFS = full scale, digital silence ≈ -180).
 * A trailing partial frame counts if it has any samples.
 */
export function frameEnergiesDb(pcm: Pcm, sampleRate: number, frameMs: number): Float32Array {
  const frameLen = frameLength(sampleRate, frameMs);
  const n = pcm.length;
  const nFrames = Math.ceil(n / frameLen);
  const out = new Float32Array(nFrames);
  // Two monomorphic loops: one polymorphic loop over both array kinds is measurably slower on a
  // multi-hour channel.
  if (pcm instanceof Int16Array) {
    const scale = 1 / (32768 * 32768);
    for (let f = 0; f < nFrames; f++) {
      const a = f * frameLen;
      const b = Math.min(n, a + frameLen);
      let sum = 0;
      for (let i = a; i < b; i++) {
        const s = pcm[i]!;
        sum += s * s;
      }
      out[f] = 10 * Math.log10((sum / (b - a)) * scale + 1e-18);
    }
  } else {
    for (let f = 0; f < nFrames; f++) {
      const a = f * frameLen;
      const b = Math.min(n, a + frameLen);
      let sum = 0;
      for (let i = a; i < b; i++) {
        const s = pcm[i]!;
        sum += s * s;
      }
      out[f] = 10 * Math.log10(sum / (b - a) + 1e-18);
    }
  }
  return out;
}

/** Voiced regions of `pcm`, in seconds, sorted, non-overlapping, clamped to the audio. */
export function detectVoice(
  pcm: Pcm,
  sampleRate = 16000,
  options: Partial<VadOptions> = {},
): Region[] {
  const o: VadOptions = { ...DEFAULT_VAD_OPTIONS, ...options };
  if (pcm.length === 0) return [];
  const frameLen = frameLength(sampleRate, o.frameMs);
  const frameS = frameLen / sampleRate;
  const duration = pcm.length / sampleRate;

  const energies = frameEnergiesDb(pcm, sampleRate, o.frameMs);
  const floor = percentile(energies, o.noisePercentile);
  const threshold = Math.min(o.maxThresholdDb, Math.max(o.minThresholdDb, floor + o.marginDb));

  // 1. Runs of voiced frames, each extended by the hangover. A run remembers how many of its
  //    frames were actually above the threshold so transients can be told from speech later.
  interface Run {
    startFrame: number;
    endFrame: number;
    voicedFrames: number;
  }
  const hangoverFrames = Math.round(o.hangoverMs / o.frameMs);
  const runs: Run[] = [];
  let open: Run | undefined;
  let remaining = 0;
  for (let f = 0; f < energies.length; f++) {
    if (energies[f]! > threshold) {
      if (!open) {
        open = { startFrame: f, endFrame: f + 1, voicedFrames: 0 };
        runs.push(open);
      }
      open.voicedFrames++;
      open.endFrame = f + 1;
      remaining = hangoverFrames;
    } else if (open && remaining > 0) {
      remaining--;
      open.endFrame = f + 1;
    } else {
      open = undefined;
    }
  }

  // Everything from here on is in whole frames, so "gap under 500 ms" never turns into a
  // floating-point coin toss at exactly 500 ms. Seconds only at the very end.

  // 2. Pad, clamped to the audio.
  const padFrames = Math.round(o.padMs / o.frameMs);
  const padded: Run[] = runs.map((r) => ({
    startFrame: Math.max(0, r.startFrame - padFrames),
    endFrame: Math.min(energies.length, r.endFrame + padFrames),
    voicedFrames: r.voicedFrames,
  }));

  // 3. Merge regions separated by less than the gap (padding can even make them overlap).
  const mergeGapFrames = Math.round(o.mergeGapMs / o.frameMs);
  const merged: Run[] = [];
  for (const r of padded) {
    const last = merged[merged.length - 1];
    if (last && r.startFrame - last.endFrame < mergeGapFrames) {
      last.endFrame = Math.max(last.endFrame, r.endFrame);
      last.voicedFrames += r.voicedFrames;
    } else {
      merged.push({ ...r });
    }
  }

  // 4. Drop transients. 5. Split long regions at the quietest frame before the limit.
  const maxRegionFrames = Math.round(o.maxRegionS / frameS);
  const splitSearchFrames = Math.round(o.splitSearchS / frameS);
  const out: Region[] = [];
  const toSeconds = (startFrame: number, endFrame: number): Region => ({
    start: roundMs(startFrame * frameS),
    end: roundMs(Math.min(duration, endFrame * frameS)),
  });
  for (const r of merged) {
    if (r.voicedFrames * frameS * 1000 < o.minVoicedMs) continue;
    let start = r.startFrame;
    while (r.endFrame - start > maxRegionFrames) {
      const cut = quietestFrame(
        energies,
        start + maxRegionFrames - splitSearchFrames,
        start + maxRegionFrames,
      );
      out.push(toSeconds(start, cut));
      start = cut;
    }
    out.push(toSeconds(start, r.endFrame));
  }
  return out;
}

function frameLength(sampleRate: number, frameMs: number): number {
  return Math.max(1, Math.round((sampleRate * frameMs) / 1000));
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/** Index of the quietest frame in [from, to]; the first one wins a tie. */
function quietestFrame(energies: Float32Array, from: number, to: number): number {
  const f0 = Math.max(0, from);
  const f1 = Math.min(energies.length - 1, to);
  let best = f1;
  let bestEnergy = Infinity;
  for (let f = f0; f <= f1; f++) {
    if (energies[f]! < bestEnergy) {
      bestEnergy = energies[f]!;
      best = f;
    }
  }
  return best;
}

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
