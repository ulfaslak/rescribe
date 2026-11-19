import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopStart, spreadWords, WhisperVocab } from './tokens.ts';

// Byte-level BPE: a space is written Ġ, the UTF-8 bytes of æ (C3 A6) as Ã¦.
const vocab = new WhisperVocab(
  { Hej: 0, Ġd: 1, 'Ã¦': 2, r: 3, '!': 4 },
  { '<|endoftext|>': 10, '<|startoftranscript|>': 11, '<|da|>': 12 },
);

test('WhisperVocab decodes byte-level tokens to UTF-8 and drops special tokens', () => {
  assert.equal(vocab.decode([11, 12, 0, 1, 2, 3, 4, 10]), 'Hej dær!');
});

test('WhisperVocab.id finds special tokens and throws on unknown ones', () => {
  assert.equal(vocab.id('<|da|>'), 12);
  assert.equal(vocab.eot, 10);
  assert.throws(() => vocab.id('<|sv|>'));
});

test('loopStart: no loop in ordinary text', () => {
  assert.equal(loopStart([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), undefined);
  assert.equal(loopStart([1, 2, 1, 2, 3]), undefined);
});

test('loopStart keeps the first copy of a repeated phrase', () => {
  const phrase = [5, 6, 7];
  const tokens = [1, 2, ...phrase, ...phrase, ...phrase, ...phrase, ...phrase];
  assert.equal(loopStart(tokens), 5);
});

test('loopStart: a single repeated token needs twice the repeats', () => {
  assert.equal(loopStart([1, 9, 9, 9, 9, 9]), undefined);
  assert.equal(loopStart([1, 9, 9, 9, 9, 9, 9, 9, 9]), 2);
});

test('spreadWords shares the span by characters, in order, inside it', () => {
  const words = spreadWords('  ja  okay det  ', 2);
  assert.deepEqual(
    words.map((w) => w.text),
    ['ja', 'okay', 'det'],
  );
  assert.equal(words[0]!.start, 0);
  assert.ok(Math.abs(words[2]!.end - 2) < 1e-9);
  for (let i = 1; i < words.length; i++) assert.ok(words[i]!.start >= words[i - 1]!.end);
  assert.ok(words[1]!.end - words[1]!.start > words[0]!.end - words[0]!.start);
});

test('spreadWords: nothing to place', () => {
  assert.deepEqual(spreadWords('   ', 3), []);
  assert.deepEqual(spreadWords('ja', 0), []);
});
