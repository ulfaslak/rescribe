import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VAD_OPTIONS, detectVoice, frameEnergiesDb, int16ToFloat32 } from './vad.ts';

const SR = 16000;
const FRAME = DEFAULT_VAD_OPTIONS.frameMs / 1000;
const PAD = DEFAULT_VAD_OPTIONS.padMs / 1000;
const HANG = DEFAULT_VAD_OPTIONS.hangoverMs / 1000;

/** Deterministic PRNG (mulberry32) so noise tests are repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}

/** Adds a sine burst of the given peak amplitude over [from, to) seconds. */
function tone(out: Float32Array | Int16Array, from: number, to: number, amplitude: number): void {
  const a = Math.round(from * SR);
  const b = Math.min(out.length, Math.round(to * SR));
  const scale = out instanceof Int16Array ? 32767 : 1;
  for (let i = a; i < b; i++) {
    out[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * amplitude * scale;
  }
}

/** Adds uniform white noise of the given peak amplitude everywhere. RMS is amplitude / √3. */
function noise(out: Float32Array, amplitude: number, seed = 1): void {
  const r = rng(seed);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (r() * 2 - 1) * amplitude;
}

/** What one isolated burst over [from, to) should become: padded, with the hangover tail. */
function expected(from: number, to: number, duration: number): { start: number; end: number } {
  return { start: Math.max(0, from - PAD), end: Math.min(duration, to + HANG + PAD) };
}

function assertNear(
  actual: { start: number; end: number }[],
  wanted: { start: number; end: number }[],
  tolerance = FRAME,
): void {
  assert.equal(actual.length, wanted.length, JSON.stringify(actual));
  actual.forEach((r, i) => {
    const w = wanted[i]!;
    assert.ok(Math.abs(r.start - w.start) <= tolerance + 1e-9, `start ${r.start} vs ${w.start}`);
    assert.ok(Math.abs(r.end - w.end) <= tolerance + 1e-9, `end ${r.end} vs ${w.end}`);
  });
}

test('empty input → no regions', () => {
  assert.deepEqual(detectVoice(new Float32Array(0)), []);
  assert.deepEqual(detectVoice(new Int16Array(0)), []);
});

test('digital silence → no regions', () => {
  assert.deepEqual(detectVoice(silence(10)), []);
});

test('low white noise → no regions, whether faint or well above the absolute floor', () => {
  const faint = silence(10);
  noise(faint, 0.003); // about -55 dBFS RMS
  assert.deepEqual(detectVoice(faint), []);
  const audible = silence(10);
  noise(audible, 0.03); // about -35 dBFS RMS: adaptive floor, no fixed level can trigger
  assert.deepEqual(detectVoice(audible), []);
});

test('bursts quieter than the absolute floor on digital silence never trigger', () => {
  const pcm = silence(10);
  tone(pcm, 2, 4, 0.002); // about -57 dBFS RMS, below minThresholdDb
  assert.deepEqual(detectVoice(pcm), []);
});

test('tone bursts land within a frame of the truth, with hangover and padding', () => {
  const pcm = silence(20);
  tone(pcm, 2, 4, 0.1);
  tone(pcm, 7, 9.5, 0.1);
  assertNear(detectVoice(pcm), [expected(2, 4, 20), expected(7, 9.5, 20)]);
});

test('regions are clamped to the audio', () => {
  const pcm = silence(20);
  tone(pcm, 0, 1, 0.1);
  tone(pcm, 19, 20, 0.1);
  const regions = detectVoice(pcm);
  assertNear(regions, [expected(0, 1, 20), expected(19, 20, 20)]);
  assert.equal(regions[0]!.start, 0);
  assert.equal(regions[1]!.end, 20);
});

test('bursts with a gap under the merge gap become one region; over it, two', () => {
  const close = silence(20);
  tone(close, 2, 3, 0.1);
  tone(close, 3.9, 5, 0.1); // padded gap 3.5 → 3.7 = 0.2 s
  assertNear(detectVoice(close), [{ start: 1.8, end: 5.5 }]);
  const apart = silence(20);
  tone(apart, 2, 3, 0.1);
  tone(apart, 4.2, 5, 0.1); // padded gap 3.5 → 4.0 = 0.5 s, not under the gap
  assertNear(detectVoice(apart), [expected(2, 3, 20), expected(4.2, 5, 20)]);
});

test('a click is dropped; a short word is kept', () => {
  const click = silence(10);
  tone(click, 5, 5.05, 0.5);
  assert.deepEqual(detectVoice(click), []);
  const word = silence(10);
  tone(word, 5, 5.3, 0.1);
  assertNear(detectVoice(word), [expected(5, 5.3, 10)]);
});

test('speech over a noisy floor is found; the floor itself is not', () => {
  const pcm = silence(20);
  noise(pcm, 0.01); // about -45 dBFS RMS
  tone(pcm, 5, 7, 0.08); // about -25 dBFS RMS
  assertNear(detectVoice(pcm), [expected(5, 7, 20)], 2 * FRAME);
});

test('a region over the limit splits at the quietest frame in its last seconds', () => {
  const pcm = silence(91);
  tone(pcm, 0, 90.5, 0.1);
  // Two dips too short for the hangover to break the region, exactly where the cuts should land.
  tone(pcm, 28, 28.1, 0.001);
  tone(pcm, 57, 57.1, 0.001);
  const regions = detectVoice(pcm);
  assert.ok(regions.length >= 4, JSON.stringify(regions));
  for (const r of regions) assert.ok(r.end - r.start <= 30 + 1e-9, JSON.stringify(r));
  for (let i = 1; i < regions.length; i++) assert.equal(regions[i]!.start, regions[i - 1]!.end);
  assert.equal(regions[0]!.start, 0);
  // Any frame inside a dip is the quietest by a hair (8.8 sine cycles per frame, so RMS depends
  // on phase); the cut must land in the dip, not on a particular frame of it.
  const inDip = (t: number, dip: number) => t >= dip && t <= dip + 0.1;
  assert.ok(inDip(regions[0]!.end, 28), `first cut ${regions[0]!.end}`);
  assert.ok(inDip(regions[1]!.end, 57), `second cut ${regions[1]!.end}`);
  assert.equal(regions.at(-1)!.end, 91);
});

test('Int16 and Float32 input give the same regions', () => {
  const f32 = silence(20);
  tone(f32, 2, 4, 0.1);
  tone(f32, 7, 9.5, 0.1);
  const i16 = new Int16Array(f32.length);
  tone(i16, 2, 4, 0.1);
  tone(i16, 7, 9.5, 0.1);
  assert.deepEqual(detectVoice(i16), detectVoice(f32));
});

test('a two-hour sparse Int16 channel runs in well under a second', () => {
  const hours = 2;
  const pcm = new Int16Array(hours * 3600 * SR);
  const bursts: number[] = [];
  for (let t = 300; t < hours * 3600 - 10; t += 360) {
    bursts.push(t);
    tone(pcm, t, t + 2, 0.1);
  }
  const t0 = performance.now();
  const regions = detectVoice(pcm);
  const ms = performance.now() - t0;
  console.log(`  vad: ${hours} h in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1000, `took ${ms} ms`);
  assertNear(
    regions,
    bursts.map((t) => expected(t, t + 2, hours * 3600)),
  );
});

test('frameEnergiesDb: silence is far below any threshold, full scale is 0 dBFS', () => {
  const e = frameEnergiesDb(silence(1), SR, 20);
  assert.equal(e.length, 50);
  assert.ok(e[0]! < -170);
  const full = new Float32Array(320).fill(1);
  assert.ok(Math.abs(frameEnergiesDb(full, SR, 20)[0]!) < 1e-6);
  const i16 = new Int16Array(320).fill(32767);
  assert.ok(Math.abs(frameEnergiesDb(i16, SR, 20)[0]!) < 0.001);
  // A trailing partial frame is a frame.
  assert.equal(frameEnergiesDb(new Float32Array(330), SR, 20).length, 2);
});

test('int16ToFloat32 scales to [-1, 1)', () => {
  const out = int16ToFloat32(Int16Array.from([32767, -32768, 0, 16384]));
  assert.ok(Math.abs(out[0]! - 32767 / 32768) < 1e-9);
  assert.equal(out[1], -1);
  assert.equal(out[2], 0);
  assert.equal(out[3], 0.5);
});
