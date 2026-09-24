import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { floatToInt16, int16ToFloat32, pcmSeconds } from './pcm.ts';

describe('floatToInt16', () => {
  it('maps full scale and clamps beyond it', () => {
    const dst = new Int16Array(5);
    const n = floatToInt16(new Float32Array([0, 1, -1, 2, -2]), dst, 0);
    assert.equal(n, 5);
    assert.deepEqual([...dst], [0, 32767, -32768, 32767, -32768]);
  });
  it('writes at the offset and stops at the end of dst', () => {
    const dst = new Int16Array(3);
    const n = floatToInt16(new Float32Array([0.5, 0.5, 0.5]), dst, 2);
    assert.equal(n, 1);
    assert.deepEqual([...dst], [0, 0, 16384]);
  });
});

describe('int16ToFloat32', () => {
  it('round-trips within one quantisation step', () => {
    const src = new Float32Array([0, 0.25, -0.25, 0.999, -0.999]);
    const i16 = new Int16Array(src.length);
    floatToInt16(src, i16, 0);
    const back = int16ToFloat32(i16);
    for (let i = 0; i < src.length; i++)
      assert.ok(Math.abs((back[i] ?? 0) - (src[i] ?? 0)) < 1 / 32767, `sample ${i}`);
  });
});

describe('pcmSeconds', () => {
  it('is bytes / 2 / 16000', () => {
    assert.equal(pcmSeconds(32000 * 3), 3);
  });
});
