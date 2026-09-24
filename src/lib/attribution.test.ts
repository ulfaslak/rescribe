import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, channelIdentity, togglesToIntervals } from './attribution.ts';
import type { Segment, SpeakerInterval } from './types.ts';

const seg = (channel: 'mic' | 'display', start: number, end: number, text = 'x'): Segment => ({
  channel,
  start,
  end,
  text,
});

test('channel identity labels the mic channel and falls back on the display channel', () => {
  const out = attribute([seg('mic', 0, 2), seg('display', 3, 5)], [channelIdentity('mic', 'Ulf')]);
  assert.equal(out[0]?.speaker, 'Ulf');
  assert.equal(out[0]?.evidence, 'channel');
  assert.equal(out[1]?.speaker, 'Speaker');
  assert.equal(out[1]?.evidence, 'none');
});

test('platform evidence beats channel identity even with less overlap', () => {
  const evidence: SpeakerInterval[] = [
    channelIdentity('display', 'Speaker'),
    { channel: 'display', speaker: 'Anna', start: 4.5, end: 5, source: 'platform' },
  ];
  const [out] = attribute([seg('display', 3, 5)], evidence);
  assert.equal(out?.speaker, 'Anna');
  assert.equal(out?.evidence, 'platform');
});

test('among same-rank evidence the larger overlap wins', () => {
  const evidence: SpeakerInterval[] = [
    { channel: 'display', speaker: 'Anna', start: 0, end: 3.2, source: 'platform' },
    { channel: 'display', speaker: 'Bo', start: 3.2, end: 10, source: 'platform' },
  ];
  const [out] = attribute([seg('display', 3, 6)], evidence);
  assert.equal(out?.speaker, 'Bo');
});

test('a near miss within tolerance still labels, beyond tolerance does not', () => {
  const evidence: SpeakerInterval[] = [
    { channel: 'display', speaker: 'Anna', start: 10, end: 12, source: 'platform' },
  ];
  assert.equal(attribute([seg('display', 12.5, 14)], evidence)[0]?.speaker, 'Anna');
  assert.equal(attribute([seg('display', 13.5, 14)], evidence)[0]?.speaker, 'Speaker');
  assert.equal(
    attribute([seg('display', 13.5, 14)], evidence, { tolerance: 2 })[0]?.speaker,
    'Anna',
  );
});

test('an overlapping interval beats a nearer non-overlapping one of the same rank', () => {
  const evidence: SpeakerInterval[] = [
    { channel: 'display', speaker: 'Anna', start: 0, end: 3.1, source: 'platform' },
    { channel: 'display', speaker: 'Bo', start: 5.05, end: 9, source: 'platform' },
  ];
  const [out] = attribute([seg('display', 3, 5)], evidence);
  assert.equal(out?.speaker, 'Anna');
});

test('evidence on one channel never labels the other', () => {
  const evidence: SpeakerInterval[] = [
    { channel: 'display', speaker: 'Anna', start: 0, end: 100, source: 'platform' },
  ];
  assert.equal(attribute([seg('mic', 1, 2)], evidence)[0]?.speaker, 'Me');
});

test('fallback labels are configurable', () => {
  const out = attribute([seg('mic', 0, 1), seg('display', 0, 1)], [], {
    fallback: { mic: 'Ulf', display: 'Guest' },
  });
  assert.deepEqual(
    out.map((s) => s.speaker),
    ['Ulf', 'Guest'],
  );
});

test('works hours into a recording', () => {
  const h = 3 * 3600;
  const evidence: SpeakerInterval[] = [
    { channel: 'display', speaker: 'Anna', start: h + 10, end: h + 20, source: 'platform' },
  ];
  assert.equal(attribute([seg('display', h + 12, h + 15)], evidence)[0]?.speaker, 'Anna');
});

test('togglesToIntervals pairs on/off per speaker and closes open ones at end', () => {
  const ivs = togglesToIntervals(
    'display',
    [
      { t: 1, speaker: 'Anna', speaking: true },
      { t: 2, speaker: 'Bo', speaking: true },
      { t: 3, speaker: 'Anna', speaking: false },
      { t: 3.5, speaker: 'Anna', speaking: false },
      { t: 4, speaker: 'Anna', speaking: true },
    ],
    6,
  );
  assert.deepEqual(
    ivs.map((i) => [i.speaker, i.start, i.end]),
    [
      ['Anna', 1, 3],
      ['Bo', 2, 6],
      ['Anna', 4, 6],
    ],
  );
  assert.ok(ivs.every((i) => i.source === 'platform' && i.channel === 'display'));
});

test('togglesToIntervals ignores an off without an on and unsorted input', () => {
  const ivs = togglesToIntervals(
    'display',
    [
      { t: 5, speaker: 'Anna', speaking: false },
      { t: 2, speaker: 'Anna', speaking: true },
      { t: 0.5, speaker: 'Anna', speaking: false },
    ],
    10,
  );
  assert.deepEqual(
    ivs.map((i) => [i.start, i.end]),
    [[2, 5]],
  );
});
