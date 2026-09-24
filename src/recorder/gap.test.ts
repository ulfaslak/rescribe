// Pins the render-gap rule (ARCHITECTURE § Clock): when the audio clock falls behind the monotonic
// clock for a sustained window, the PCM files are zero-padded by the lag; a main-thread stall,
// whose queued blocks drain back to zero lag, never pads.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GapDetector } from './gap.ts';

const RATE = 16000;
const BLOCK = 3200; // 200 ms

function detector(): GapDetector {
  return new GapDetector({ sampleRate: RATE, thresholdMs: 250, windowMs: 1000, maxPadMs: 600_000 });
}

/** Feed `n` blocks whose audio position runs `lagMs` behind the monotonic clock (plus 3 ms latency). */
function feed(d: GapDetector, from: number, n: number, lagMs: number): number[] {
  const pads: number[] = [];
  for (let i = from; i < from + n; i++) {
    const position = i * BLOCK;
    const elapsedMs = ((position + BLOCK) / RATE) * 1000 + lagMs + 3;
    pads.push(d.observe(elapsedMs, position, BLOCK));
  }
  return pads;
}

describe('GapDetector', () => {
  it('pads nothing when the audio clock keeps up', () => {
    const d = detector();
    assert.deepEqual(feed(d, 0, 20, 0), new Array(20).fill(0));
    assert.equal(d.paddedFrames, 0);
  });

  it('pads a 3 s render gap once, after the lag persists for the window', () => {
    const d = detector();
    feed(d, 0, 10, 0);
    const pads = feed(d, 10, 10, 3000);
    const total = pads.reduce((a, b) => a + b, 0);
    // The lag includes the block's delivery latency (3 ms here), which is padded with it.
    assert.ok(Math.abs(total - 3 * RATE) <= RATE / 100, `padded the gap: ${total}`);
    assert.equal(pads.filter((p) => p > 0).length, 1, 'in one insertion');
    assert.ok(pads.findIndex((p) => p > 0) >= 4, 'not before a second of sustained lag');
    assert.deepEqual(feed(d, 20, 10, 3000), new Array(10).fill(0), 'and then keeps up');
    assert.ok(Math.abs(d.paddedFrames - 3 * RATE) <= RATE / 100);
  });

  it('ignores jitter under the threshold', () => {
    const d = detector();
    assert.deepEqual(feed(d, 0, 20, 200), new Array(20).fill(0));
  });

  it('ignores a main-thread stall: queued blocks arrive in a burst that drains to zero lag', () => {
    const d = detector();
    feed(d, 0, 10, 0);
    // A 1.4 s stall: seven blocks were queued and now arrive at the same instant.
    const now = ((17 * BLOCK) / RATE) * 1000 + 3;
    const pads = [10, 11, 12, 13, 14, 15, 16].map((i) => d.observe(now, i * BLOCK, BLOCK));
    assert.deepEqual(pads, new Array(7).fill(0));
    assert.deepEqual(feed(d, 17, 10, 0), new Array(10).fill(0));
  });

  it('caps one insertion so a clock jump cannot allocate hours of zeros', () => {
    const d = new GapDetector({
      sampleRate: RATE,
      thresholdMs: 250,
      windowMs: 1000,
      maxPadMs: 1000,
    });
    const pads = feed(d, 0, 10, 60_000);
    assert.equal(Math.max(...pads), RATE);
  });

  it('two channels at the same positions share one padding', () => {
    const d = detector();
    for (let i = 0; i < 10; i++) {
      const position = i * BLOCK;
      const elapsedMs = ((position + BLOCK) / RATE) * 1000 + 1000;
      const a = d.observe(elapsedMs, position, BLOCK);
      const b = d.observe(elapsedMs, position, BLOCK);
      assert.equal(a * b, 0, 'never both channels in one quantum');
    }
    assert.equal(d.paddedFrames, RATE);
  });
});
