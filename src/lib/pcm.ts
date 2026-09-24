// PCM sample conversion. The channel files in OPFS are 16 kHz mono Int16 little-endian, raw
// (ARCHITECTURE § Storage). Pure: used by the AudioWorklet tap and by whoever reads the files.

export const PCM_SAMPLE_RATE = 16000;
export const PCM_BYTES_PER_SAMPLE = 2;

/** Float32 samples in [-1, 1] → Int16 into `dst` starting at `offset`, clamped. Returns the count. */
export function floatToInt16(src: Float32Array, dst: Int16Array, offset: number): number {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = 0; i < n; i++) {
    const v = src[i] ?? 0;
    const c = v > 1 ? 1 : v < -1 ? -1 : v;
    dst[offset + i] = c < 0 ? Math.round(c * 32768) : Math.round(c * 32767);
  }
  return n;
}

/** Int16 → Float32 in [-1, 1]. */
export function int16ToFloat32(src: Int16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i] ?? 0;
    out[i] = v < 0 ? v / 32768 : v / 32767;
  }
  return out;
}

/** Seconds of audio in a PCM byte count. */
export function pcmSeconds(bytes: number): number {
  return bytes / PCM_BYTES_PER_SAMPLE / PCM_SAMPLE_RATE;
}
