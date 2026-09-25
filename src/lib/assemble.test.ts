import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTranscript, parseEventLog, type EventLine } from './assemble.ts';
import { MEET_LEAD } from './evidence.ts';
import type { Recording, Segment } from './types.ts';

const T0 = 1_790_000_000_000;
const recording: Recording = {
  id: 'rec-1',
  startedAt: T0,
  endedAt: T0 + 20_000,
  title: 'Weekly sync',
  sources: [
    { channel: 'display', kind: 'tab', label: 'Meet' },
    { channel: 'mic', kind: 'microphone' },
  ],
  status: 'transcribing',
  container: 'mp4',
  exportPath: '2026-09-24 14-30 Weekly sync',
  levels: { mic: -20.5, display: -25 },
};
const settings = { myName: 'Ulf', model: 'parakeet-tdt-0.6b-v3', backend: 'wasm' as const };

const seg = (channel: 'mic' | 'display', start: number, end: number, text: string): Segment => ({
  channel,
  start,
  end,
  text,
  words: text.split(' ').map((w, i, all) => ({
    text: w,
    start: start + ((end - start) * i) / all.length,
    end: start + ((end - start) * (i + 1)) / all.length,
  })),
});

/** Two remote speakers and the human, with Meet events for the remote turns and the self tile. */
const segments: Segment[] = [
  seg('mic', 0.5, 2, 'Hi everyone'),
  seg('display', 3, 5, 'Hi Ulf'),
  seg('mic', 6, 8, 'Shall we start'),
  seg('display', 9, 11, 'Yes please'),
];
const sp = (ms: number, id: string, name: string, speaking: boolean): EventLine => ({
  type: 'speaker',
  platform: 'meet',
  at: T0 + ms,
  id,
  name,
  speaking,
});
const events: EventLine[] = [
  { type: 'roster', platform: 'meet', at: T0 + 100, names: ['You', 'Anna', 'Bo'] },
  sp(500, 'me', 'You', true),
  sp(2000, 'me', 'You', false),
  sp(3100, 'p1', 'Anna', true),
  sp(5000, 'p1', 'Anna', false),
  { type: 'clock-gap', at: T0 + 7000, position: 112_000, paddedSamples: 8000 },
  { type: 'adapter-diagnostic', platform: 'meet', at: T0 + 8000, message: 'no meter' },
  sp(9100, 'p2', 'Bo', true),
  sp(11_000, 'p2', 'Bo', false),
];

test('platform events name the display segments; the mic channel is the human', () => {
  const out = assembleTranscript({
    recording,
    settings,
    segments,
    events,
    rescribeVersion: '0.1.0',
  });
  assert.deepEqual(
    out.labelled.map((s) => [s.speaker, s.evidence]),
    [
      ['Ulf', 'channel'],
      ['Anna', 'platform'],
      ['Ulf', 'channel'],
      ['Bo', 'platform'],
    ],
  );
  assert.match(out.markdown, /^# Weekly sync\n/);
  assert.match(out.markdown, /Participants: Ulf, Anna, Bo/);
  assert.match(out.markdown, /\*\*Ulf\*\* \[0:00\]\n\nHi everyone\n/);
  assert.match(out.markdown, /\*\*Anna\*\* \[0:03\]\n\nHi Ulf\n/);
  assert.match(out.markdown, /\*\*Bo\*\* \[0:09\]\n\nYes please\n$/);
});

test('no events: display segments fall back to "Speaker", participants are empty', () => {
  const out = assembleTranscript({
    recording,
    settings,
    segments,
    events: [],
    rescribeVersion: '0.1.0',
  });
  assert.deepEqual(
    out.labelled.map((s) => [s.speaker, s.evidence]),
    [
      ['Ulf', 'channel'],
      ['Speaker', 'channel'],
      ['Ulf', 'channel'],
      ['Speaker', 'channel'],
    ],
  );
  assert.deepEqual(out.meta.participants, []);
  assert.deepEqual(out.json.participants, []);
  assert.doesNotMatch(out.markdown, /Participants/);
});

test('the self tile ("You") is dropped from display evidence and shown under my name', () => {
  // The human's own tile speaks over a display segment: without the drop, that segment would
  // read as "You"; with it, Anna's interval (platform) is the nearest evidence.
  const out = assembleTranscript({
    recording,
    settings,
    segments: [seg('display', 0.5, 2, 'echo of me'), ...segments],
    events,
    rescribeVersion: '0.1.0',
  });
  assert.ok(!out.labelled.some((s) => s.speaker === 'You'));
  assert.ok(!out.json.intervals.some((iv) => iv.speaker === 'You'));
  assert.deepEqual(out.meta.participants, ['Ulf', 'Anna', 'Bo']);
});

test('a self tile named after the human, not "You", is found by the microphone and dropped', () => {
  // Meet labelled the human's tile with the full name in a 58-minute call on 2026-09-25: two
  // thirds of the remote speaker's words were labelled as the human. The mic channel settles it.
  const ev: EventLine[] = [
    { type: 'roster', platform: 'meet', at: T0 + 100, names: ['Ulf Aslak', 'Anna', 'Bo'] },
    sp(500, 'me', 'Ulf Aslak', true),
    sp(2000, 'me', 'Ulf Aslak', false),
    sp(3100, 'p1', 'Anna', true),
    sp(5000, 'p1', 'Anna', false),
    sp(6000, 'me', 'Ulf Aslak', true),
    sp(8000, 'me', 'Ulf Aslak', false),
    sp(9100, 'p2', 'Bo', true),
    sp(11_000, 'p2', 'Bo', false),
    sp(12_000, 'me', 'Ulf Aslak', true),
    sp(16_000, 'me', 'Ulf Aslak', false),
  ];
  const out = assembleTranscript({
    recording,
    settings,
    segments: [
      seg('display', 0.5, 2, 'mm-hmm'),
      ...segments,
      seg('mic', 12, 16, 'and so on'),
      seg('display', 13, 14, 'right'),
    ],
    events: ev,
    rescribeVersion: '0.1.0',
  });
  assert.ok(!out.labelled.some((s) => s.speaker === 'Ulf Aslak'));
  assert.ok(!out.json.intervals.some((iv) => iv.speaker === 'Ulf Aslak'));
  assert.deepEqual(out.meta.participants, ['Ulf', 'Anna', 'Bo']);
  assert.deepEqual(out.meta.selfTile, { name: 'Ulf Aslak', micShare: 1, seconds: 7.5 });
  assert.ok(out.json.participants.includes('Ulf'));
});

test('with one remote participant the display channel is that person, not "Speaker"', () => {
  // Anna is the only other participant; her "mm-hmm" while the human talks got no Meet interval.
  const ev: EventLine[] = [
    { type: 'roster', platform: 'meet', at: T0 + 100, names: ['You', 'Anna'] },
    sp(3100, 'p1', 'Anna', true),
    sp(5000, 'p1', 'Anna', false),
  ];
  const out = assembleTranscript({
    recording,
    settings,
    segments: [...segments, seg('display', 7, 7.5, 'mm-hmm')],
    events: ev,
    rescribeVersion: '0.1.0',
  });
  assert.deepEqual(
    out.labelled.map((s) => [s.speaker, s.evidence]),
    [
      ['Ulf', 'channel'],
      ['Anna', 'platform'],
      ['Ulf', 'channel'],
      ['Anna', 'channel'],
      ['Anna', 'channel'],
    ],
  );
  assert.ok(!out.json.intervals.some((iv) => iv.speaker === 'Speaker'));
  // A second remote participant who sat silent through the call: the generic label again.
  const silent = assembleTranscript({
    recording,
    settings,
    segments: [...segments, seg('display', 7, 7.5, 'mm-hmm')],
    events: [
      { type: 'roster', platform: 'meet', at: T0 + 100, names: ['You', 'Anna', 'Bo'] },
      ...ev.slice(1),
    ],
    rescribeVersion: '0.1.0',
  });
  assert.deepEqual(silent.meta.participants, ['Ulf', 'Anna', 'Bo']);
  assert.equal(silent.labelled[4]!.speaker, 'Speaker');
  // Two remote participants: the generic label again for what no interval covers.
  const two = assembleTranscript({
    recording,
    settings,
    segments: [...segments, seg('display', 7, 7.5, 'mm-hmm')],
    events,
    rescribeVersion: '0.1.0',
  });
  assert.deepEqual(
    two.labelled.map((s) => s.speaker),
    ['Ulf', 'Anna', 'Ulf', 'Bo', 'Speaker'],
  );
});

test('the one-remote rule needs a roster line and counts tiles, not labels', () => {
  // No roster in the log (a recording started into a stable call): nobody vouched for who was
  // there, so a listener the indicator missed may exist; the display stays "Speaker".
  const noRoster = assembleTranscript({
    recording,
    settings,
    segments: [...segments, seg('display', 7, 7.5, 'mm-hmm')],
    events: [sp(3100, 'p1', 'Anna', true), sp(5000, 'p1', 'Anna', false)],
    rescribeVersion: '0.1.0',
  });
  assert.equal(noRoster.labelled[4]!.speaker, 'Speaker');
  assert.deepEqual(noRoster.meta.participants, ['Anna']);
  // A remote who shares "my name": two remote tiles, whatever the labels collapse to.
  const shared = assembleTranscript({
    recording,
    settings: { ...settings, myName: 'Anna' },
    segments: [...segments, seg('display', 7, 7.5, 'mm-hmm')],
    events,
    rescribeVersion: '0.1.0',
  });
  assert.deepEqual(shared.meta.participants, ['Anna', 'Bo']);
  assert.equal(shared.labelled[4]!.speaker, 'Speaker');
});

test('without a microphone source the self tile is judged by its label alone', () => {
  // Documented limitation (DEFERRED): mic off and Meet naming the tile by full name leaks.
  const noMic: Recording = {
    ...recording,
    sources: [{ channel: 'display', kind: 'tab', label: 'Meet' }],
  };
  const ev: EventLine[] = [
    { type: 'roster', platform: 'meet', at: T0 + 100, names: ['Ulf Aslak', 'Anna'] },
    sp(500, 'me', 'Ulf Aslak', true),
    sp(8000, 'me', 'Ulf Aslak', false),
    sp(3100, 'p1', 'Anna', true),
    sp(5000, 'p1', 'Anna', false),
  ];
  const out = assembleTranscript({
    recording: noMic,
    settings,
    segments: segments.filter((s) => s.channel === 'display'),
    events: ev,
    rescribeVersion: '0.1.0',
  });
  assert.equal(out.meta.selfTile, undefined);
  assert.ok(out.json.intervals.some((iv) => iv.speaker === 'Ulf Aslak'));
});

test('clock-gap and diagnostic lines never become evidence; gaps are surfaced in meta', () => {
  const out = assembleTranscript({
    recording,
    settings,
    segments,
    events,
    rescribeVersion: '0.1.0',
  });
  assert.deepEqual(out.meta.clockGaps, [{ at: 7, seconds: 0.5 }]);
  assert.ok(
    out.json.intervals.every((iv) => ['Ulf', 'Speaker', 'Anna', 'Bo'].includes(iv.speaker)),
  );
  const platform = out.json.intervals.filter((iv) => iv.source === 'platform');
  assert.deepEqual(
    platform.map((iv) => [iv.speaker, iv.start, iv.end]),
    [
      ['Anna', 3.1 - MEET_LEAD, 5],
      ['Bo', 9.1 - MEET_LEAD, 11],
    ],
  );
});

test('meta.json and transcript.json carry what transcribed the recording', () => {
  const out = assembleTranscript({
    recording,
    settings,
    segments,
    events,
    rescribeVersion: '0.1.0',
    now: T0 + 60_000,
  });
  assert.deepEqual(out.meta, {
    version: 1,
    id: 'rec-1',
    title: 'Weekly sync',
    startedAt: T0,
    endedAt: T0 + 20_000,
    sources: recording.sources,
    participants: ['Ulf', 'Anna', 'Bo'],
    model: 'parakeet-tdt-0.6b-v3',
    backend: 'wasm',
    container: 'mp4',
    exportPath: '2026-09-24 14-30 Weekly sync',
    levels: { mic: -20.5, display: -25 },
    clockGaps: [{ at: 7, seconds: 0.5 }],
    transcribedAt: T0 + 60_000,
    rescribeVersion: '0.1.0',
  });
  assert.equal(out.json.version, 1);
  assert.equal(out.json.model, 'parakeet-tdt-0.6b-v3');
  assert.equal(out.json.backend, 'wasm');
  assert.equal(out.json.segments.length, 4);
  assert.ok(out.json.segments.every((s) => s.words && s.words.length > 0));
  // Channel identity spans the recording with a finite end, so JSON keeps it.
  const identity = out.json.intervals.filter((iv) => iv.source === 'channel');
  assert.deepEqual(
    identity.map((iv) => [iv.channel, iv.speaker, iv.start, iv.end]),
    [
      ['mic', 'Ulf', 0, 20],
      ['display', 'Speaker', 0, 20],
    ],
  );
  assert.doesNotMatch(JSON.stringify(out.json), /null/);
});

test('a recording without endedAt spans the last segment; optional fields are left out', () => {
  const { endedAt: _e, exportPath: _p, levels: _l, ...bare } = recording;
  const out = assembleTranscript({
    recording: bare,
    settings,
    segments: [seg('mic', 0, 4.2, 'short one')],
    events: [],
    rescribeVersion: '0.1.0',
  });
  assert.equal(out.meta.endedAt, T0 + 4200);
  assert.ok(!('exportPath' in out.meta));
  assert.ok(!('levels' in out.meta));
  assert.deepEqual(
    out.labelled.map((s) => s.speaker),
    ['Ulf'],
  );
});

test('parseEventLog keeps well-formed lines of the four types and skips the rest', () => {
  const text = [
    JSON.stringify(events[0]),
    JSON.stringify(events[1]),
    '{"type":"clock-gap","at":1,"position":2,"paddedSamples":3}',
    '{"type":"adapter-diagnostic","platform":"meet","at":1,"message":"m"}',
    '{"type":"speaker","at":"not a number","id":"x","name":"y","speaking":true,"platform":"meet"}',
    '{"type":"unknown","at":1}',
    'not json',
    '',
    '{"type":"speaker","platform":"meet","at":1,"id":"p1","name":"Anna","speak', // truncated
  ].join('\n');
  const out = parseEventLog(text);
  assert.deepEqual(
    out.map((e) => e.type),
    ['roster', 'speaker', 'clock-gap', 'adapter-diagnostic'],
  );
  assert.deepEqual(parseEventLog(''), []);
});
