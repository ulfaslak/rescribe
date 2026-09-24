// PCM regions → Segments: the pure half of the transcribe worker, unit-tested in Node. Slices one
// voiced region out of a channel (a Float32 channel is viewed, an Int16 one converted) and turns
// the engine's words for that region into one Segment in recording-relative seconds.
import type { ChannelId, Segment, Word } from '../types.ts';
import { int16ToFloat32, type Pcm, type Region } from '../vad.ts';

export const SAMPLE_RATE = 16000;

/** The region's samples as Float32. A Float32 input is viewed, not copied; Int16 is converted. */
export function sliceRegion(pcm: Pcm, region: Region, sampleRate = SAMPLE_RATE): Float32Array {
  const a = Math.max(0, Math.floor(region.start * sampleRate));
  const b = Math.min(pcm.length, Math.ceil(region.end * sampleRate));
  return pcm instanceof Int16Array ? int16ToFloat32(pcm.subarray(a, b)) : pcm.subarray(a, b);
}

/**
 * One Segment for a region: the engine's words (times relative to the region's first sample)
 * shifted by `offsetS + region.start` and clamped to the region, text = the words joined with
 * spaces. `offsetS` is the recording-relative time of the channel's sample 0. A region the engine
 * heard nothing in yields no segment.
 */
export function toSegment(
  channel: ChannelId,
  region: Region,
  words: Word[],
  offsetS = 0,
): Segment | undefined {
  const lo = roundMs(offsetS + region.start);
  const hi = roundMs(offsetS + region.end);
  const placed: Word[] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const start = clamp(roundMs(offsetS + region.start + w.start), lo, hi);
    const end = clamp(roundMs(offsetS + region.start + w.end), start, hi);
    placed.push({ text, start, end });
  }
  const first = placed[0];
  const last = placed[placed.length - 1];
  if (!first || !last) return undefined;
  return {
    channel,
    start: first.start,
    end: last.end,
    text: placed.map((w) => w.text).join(' '),
    words: placed,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
