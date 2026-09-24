import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEpochMs, toRecordingSeconds } from './clock.ts';

const T0 = 1_790_000_000_000; // an epoch ms in 2026

test('an event at the start is t=0', () => {
  assert.equal(toRecordingSeconds(T0, T0), 0);
});

test('seconds, not milliseconds', () => {
  assert.equal(toRecordingSeconds(T0 + 1500, T0), 1.5);
});

test('hours into a recording', () => {
  const threeHours = 3 * 3600 * 1000;
  assert.equal(toRecordingSeconds(T0 + threeHours + 250, T0), 10800.25);
});

test('sub-millisecond precision survives the round trip', () => {
  // A double near 1.79e12 resolves to about 0.25 µs, so microsecond agreement is the bar.
  const at = T0 + 1234.5678;
  const s = toRecordingSeconds(at, T0);
  assert.ok(Math.abs(s - 1.2345678) < 1e-6, `got ${s}`);
  assert.ok(Math.abs(toEpochMs(s, T0) - at) < 1e-3, `got ${toEpochMs(s, T0)}`);
});

test('an event stamped before the recording started is negative', () => {
  assert.equal(toRecordingSeconds(T0 - 2000, T0), -2);
});

test('toEpochMs inverts toRecordingSeconds across a long recording', () => {
  for (const s of [0, 0.001, 59.999, 3600, 7199.5, 5 * 3600 + 0.25]) {
    const at = toEpochMs(s, T0);
    assert.ok(Math.abs(toRecordingSeconds(at, T0) - s) < 1e-9, `s=${s}`);
  }
});
