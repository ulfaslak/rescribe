import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, channelIdentity, togglesToIntervals } from './attribution.ts';
import { cleanIntervals, eventsToEvidence, MEET_LEAD } from './evidence.ts';
import type { AdapterEvent } from './evidence.ts';
import type { LabelledSegment, Segment, SpeakerInterval } from './types.ts';

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

// --- Realistic Meet timing --------------------------------------------------------------------
// Truth: turns alternate between speakers and overlap by 100 ms at each handover. The platform
// indicator starts 200–400 ms after speech onset and ends 100–300 ms after speech offset (what
// the Meet adapter showed in live calls). The ASR cuts every turn into 0.5–8 s segments.

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface TruthSegment extends Segment {
  truth: string;
}

function makeCall(
  totalSeconds: number,
  speakers: string[],
  seed: number,
): { platform: SpeakerInterval[]; segments: TruthSegment[] } {
  const rand = prng(seed);
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
  const turns: Array<{ speaker: string; start: number; end: number }> = [];
  for (let t = 0, i = 0; t < totalSeconds - 1; i++) {
    const end = Math.min(totalSeconds, t + between(5, 30));
    turns.push({ speaker: speakers[i % speakers.length]!, start: t, end });
    t = end - 0.1;
  }
  const platform: SpeakerInterval[] = turns.map((tr) => ({
    channel: 'display',
    speaker: tr.speaker,
    start: tr.start + between(0.2, 0.4),
    end: tr.end + between(0.1, 0.3),
    source: 'platform',
  }));
  const segments: TruthSegment[] = [];
  for (const tr of turns) {
    for (let s = tr.start; s < tr.end;) {
      let e = s + between(0.5, 8);
      if (e > tr.end - 0.5) e = tr.end;
      segments.push({ channel: 'display', start: s, end: e, text: tr.speaker, truth: tr.speaker });
      s = e + between(0.1, 0.3);
    }
  }
  return { platform, segments };
}

function wrongLabels(out: LabelledSegment[], segments: TruthSegment[]): string[] {
  return out
    .filter((s, i) => s.speaker !== segments[i]!.truth)
    .map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)} ${s.text} labelled ${s.speaker}`);
}

test('realistic Meet timing: a lagging indicator still labels every segment right', () => {
  const { platform, segments } = makeCall(600, ['Anna', 'Bo', 'Cy'], 1);
  assert.ok(
    segments.some((s) => s.end - s.start <= 0.7),
    'fixture has short segments',
  );
  const out = attribute(segments, cleanIntervals(platform, { lead: MEET_LEAD }));
  assert.deepEqual(wrongLabels(out, segments), []);
  assert.ok(out.every((s) => s.evidence === 'platform'));
});

test('a short utterance right after a handover needs the lead; tolerance cannot replace it', () => {
  // Anna truly speaks 0–10, Bo 9.9–25. Bo's first segment is a 0.6 s "Right."
  const raw: SpeakerInterval[] = [
    { channel: 'display', speaker: 'Anna', start: 0.3, end: 10.3, source: 'platform' },
    { channel: 'display', speaker: 'Bo', start: 10.25, end: 25.2, source: 'platform' },
  ];
  const right = seg('display', 9.9, 10.5, 'Right.');
  assert.equal(attribute([right], cleanIntervals(raw, { lead: 0 }))[0]?.speaker, 'Anna');
  assert.equal(
    attribute([right], cleanIntervals(raw, { lead: 0 }), { tolerance: 5 })[0]?.speaker,
    'Anna',
  );
  assert.equal(attribute([right], cleanIntervals(raw, { lead: MEET_LEAD }))[0]?.speaker, 'Bo');
  // The lead does not steal Anna's own last words.
  const okay = seg('display', 9.5, 10.0, 'Okay.');
  assert.equal(attribute([okay], cleanIntervals(raw, { lead: MEET_LEAD }))[0]?.speaker, 'Anna');
});

test('a segment spanning a handover goes to the majority-overlap speaker', () => {
  const evidence = cleanIntervals(
    [
      { channel: 'display', speaker: 'Anna', start: 0.3, end: 10.3, source: 'platform' },
      { channel: 'display', speaker: 'Bo', start: 10.25, end: 25.2, source: 'platform' },
    ],
    { lead: MEET_LEAD },
  );
  const out = attribute([seg('display', 7, 11.5), seg('display', 9, 14)], evidence);
  assert.deepEqual(
    out.map((s) => s.speaker),
    ['Anna', 'Bo'],
  );
});

test('an exact overlap tie goes to the later-starting interval, whatever the evidence order', () => {
  const anna: SpeakerInterval = {
    channel: 'display',
    speaker: 'Anna',
    start: 0,
    end: 10.3,
    source: 'platform',
  };
  const bo: SpeakerInterval = {
    channel: 'display',
    speaker: 'Bo',
    start: 10,
    end: 25,
    source: 'platform',
  };
  const s = seg('display', 9.9, 10.4);
  assert.equal(attribute([s], [anna, bo])[0]?.speaker, 'Bo');
  assert.equal(attribute([s], [bo, anna])[0]?.speaker, 'Bo');
});

test('an event stream that starts before and ends after the recording', () => {
  const T0 = 1_790_000_000_000;
  const ev = (atMs: number, id: string, name: string, speaking: boolean): AdapterEvent => ({
    type: 'speaker',
    platform: 'meet',
    at: T0 + atMs,
    id,
    name,
    speaking,
  });
  const { intervals } = eventsToEvidence(
    [
      ev(-3000, 'p1', 'Anna', true),
      ev(5000, 'p1', 'Anna', false),
      ev(4900, 'p2', 'Bo', true),
      ev(30_000, 'p2', 'Bo', false),
    ],
    T0,
    T0 + 20_000,
  );
  assert.ok(intervals.every((i) => i.start >= 0 && i.end <= 20));
  const out = attribute([seg('display', 0, 2), seg('display', 10, 19.9)], intervals);
  assert.deepEqual(
    out.map((s) => s.speaker),
    ['Anna', 'Bo'],
  );
});

test('two hours with hundreds of intervals label correctly', () => {
  const { platform, segments } = makeCall(2 * 3600, ['Anna', 'Bo', 'Cy', 'Dee'], 7);
  assert.ok(platform.length >= 300, `${platform.length} intervals`);
  assert.ok(segments.length >= 1000, `${segments.length} segments`);
  const out = attribute(segments, cleanIntervals(platform, { lead: MEET_LEAD }));
  assert.deepEqual(wrongLabels(out, segments), []);
});

test('a display segment with no platform evidence near it falls back to Speaker', () => {
  const platform = cleanIntervals(
    [
      { channel: 'display', speaker: 'Anna', start: 0.3, end: 10.3, source: 'platform' },
      { channel: 'display', speaker: 'Bo', start: 20.2, end: 30.2, source: 'platform' },
    ],
    { lead: MEET_LEAD },
  );
  const silence = seg('display', 12, 18);
  assert.deepEqual(attribute([silence], platform)[0], {
    ...silence,
    speaker: 'Speaker',
    evidence: 'none',
  });
  const withIdentity = attribute([silence], [...platform, channelIdentity('display', 'Speaker')]);
  assert.equal(withIdentity[0]?.speaker, 'Speaker');
  assert.equal(withIdentity[0]?.evidence, 'channel');
});

test('a mic segment stays the mic speaker whatever the display evidence says', () => {
  const display: SpeakerInterval[] = [
    { channel: 'display', speaker: 'Anna', start: 0, end: 100, source: 'platform' },
    { channel: 'display', speaker: 'Bo', start: 4, end: 9, source: 'platform' },
  ];
  const mine = seg('mic', 5, 8);
  assert.equal(attribute([mine], display)[0]?.speaker, 'Me');
  const out = attribute([mine], [channelIdentity('mic', 'Ulf'), ...display]);
  assert.equal(out[0]?.speaker, 'Ulf');
  assert.equal(out[0]?.evidence, 'channel');
});
