import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fft, logMel, melFilters, WHISPER_FRAMES } from './mel.ts';

interface Fixture {
  stride: number;
  cases: { seconds: number; nMels: number; values: number[] }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./mel.fixture.json', import.meta.url), 'utf8'),
) as Fixture;

/** The fixture's signal (scripts/make-mel-fixture.py), in float32 like numpy's. */
function signal(seconds: number): Float32Array {
  const n = Math.round(seconds * 16000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    out[i] =
      0.3 * Math.sin(2 * Math.PI * 220 * t) +
      0.2 * Math.sin(2 * Math.PI * 1730 * t * (1 + 0.1 * t)) +
      0.05 * Math.sin(i * 12.9898);
  }
  return out;
}

test('Fft matches a direct DFT at length 400', () => {
  const n = 400;
  const fft = new Fft(n);
  const x = Float64Array.from(
    { length: n },
    (_, i) => Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.9),
  );
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  fft.transform(x, undefined, re, im);
  for (const k of [0, 1, 7, 50, 199, 200, 333]) {
    let dr = 0;
    let di = 0;
    for (let i = 0; i < n; i++) {
      dr += x[i]! * Math.cos((2 * Math.PI * k * i) / n);
      di -= x[i]! * Math.sin((2 * Math.PI * k * i) / n);
    }
    assert.ok(Math.abs(re[k]! - dr) < 1e-9, `re[${k}]`);
    assert.ok(Math.abs(im[k]! - di) < 1e-9, `im[${k}]`);
  }
});

test('Fft refuses a length with a prime factor above 5', () => {
  assert.throws(() => new Fft(14));
});

test('melFilters: every band has weight, none outside 0–8 kHz', () => {
  for (const nMels of [80, 128]) {
    const f = melFilters(nMels);
    assert.equal(f.length, nMels * 201);
    for (let m = 0; m < nMels; m++) {
      let sum = 0;
      for (let k = 0; k < 201; k++) sum += f[m * 201 + k]!;
      assert.ok(sum > 0, `band ${m} of ${nMels} is empty`);
    }
  }
});

for (const c of fixture.cases) {
  test(`logMel matches WhisperFeatureExtractor: ${c.seconds} s, ${c.nMels} mels`, () => {
    const out = logMel(signal(c.seconds), c.nMels);
    assert.equal(out.length, c.nMels * WHISPER_FRAMES);
    let worst = 0;
    c.values.forEach((expected, j) => {
      worst = Math.max(worst, Math.abs(out[j * fixture.stride]! - expected));
    });
    // float32 input, float64 here, float32 there; 1e-3 is far below anything the encoder notices.
    assert.ok(worst < 1e-3, `max abs diff ${worst}`);
  });
}

test('logMel of silence is the floor everywhere', () => {
  const out = logMel(new Float32Array(16000), 80);
  assert.ok(out.every((v) => Math.abs(v - (-10 + 4) / 4) < 1e-6));
});
