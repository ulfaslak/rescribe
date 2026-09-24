import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceRegion, toSegment } from './regions.ts';

test('sliceRegion views a Float32 channel and converts an Int16 one', () => {
  const f32 = new Float32Array(16000 * 2);
  f32[16000] = 0.5;
  const view = sliceRegion(f32, { start: 1, end: 1.5 });
  assert.equal(view.length, 8000);
  assert.equal(view[0], 0.5);
  assert.equal(view.buffer, f32.buffer);

  const i16 = new Int16Array(16000 * 2);
  i16[16000] = 16384;
  const copy = sliceRegion(i16, { start: 1, end: 1.5 });
  assert.equal(copy.length, 8000);
  assert.equal(copy[0], 0.5);
  assert.ok(copy instanceof Float32Array);
});

test('sliceRegion clamps to the audio', () => {
  const pcm = new Float32Array(16000);
  assert.equal(sliceRegion(pcm, { start: 0.5, end: 3 }).length, 8000);
  assert.equal(sliceRegion(pcm, { start: -1, end: 0.25 }).length, 4000);
});

test('toSegment shifts words by the region start and the channel offset', () => {
  const seg = toSegment(
    'display',
    { start: 10, end: 12 },
    [
      { text: 'hello', start: 0.1, end: 0.5 },
      { text: 'world', start: 0.6, end: 1.2 },
    ],
    100,
  );
  assert.deepEqual(seg, {
    channel: 'display',
    start: 110.1,
    end: 111.2,
    text: 'hello world',
    words: [
      { text: 'hello', start: 110.1, end: 110.5 },
      { text: 'world', start: 110.6, end: 111.2 },
    ],
  });
});

test('toSegment clamps overshooting word times to the region and keeps end ≥ start', () => {
  const seg = toSegment('mic', { start: 1, end: 2 }, [
    { text: 'late', start: 0.9, end: 1.08 },
    { text: 'beyond', start: 1.2, end: 1.3 },
  ]);
  assert.equal(seg?.words?.[0]?.end, 2);
  assert.deepEqual(seg?.words?.[1], { text: 'beyond', start: 2, end: 2 });
  assert.equal(seg?.end, 2);
});

test('toSegment drops blank words and yields nothing when no word remains', () => {
  assert.equal(toSegment('mic', { start: 0, end: 1 }, []), undefined);
  assert.equal(
    toSegment('mic', { start: 0, end: 1 }, [{ text: '  ', start: 0, end: 0.1 }]),
    undefined,
  );
  const seg = toSegment('mic', { start: 0, end: 1 }, [
    { text: ' a ', start: 0, end: 0.1 },
    { text: '', start: 0.1, end: 0.2 },
    { text: 'b', start: 0.2, end: 0.3 },
  ]);
  assert.equal(seg?.text, 'a b');
  assert.equal(seg?.words?.length, 2);
});

test('toSegment rounds to milliseconds', () => {
  const seg = toSegment('mic', { start: 0.1, end: 1 }, [{ text: 'x', start: 0.2, end: 0.4 }]);
  assert.equal(seg?.start, 0.3);
  assert.equal(seg?.end, 0.5);
});
