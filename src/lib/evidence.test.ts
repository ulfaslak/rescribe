import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanIntervals,
  eventsToEvidence,
  MEET_LEAD,
  MIN_PRESENCE_SECONDS,
  SELF_MIN_SECONDS,
} from './evidence.ts';
import { attribute } from './attribution.ts';
import type { AdapterEvent } from './evidence.ts';
import type { SpeakerInterval } from './types.ts';

const iv = (
  speaker: string,
  start: number,
  end: number,
  channel: 'mic' | 'display' = 'display',
  source: SpeakerInterval['source'] = 'platform',
): SpeakerInterval => ({ channel, speaker, start, end, source });

const spans = (ivs: SpeakerInterval[]) => ivs.map((i) => [i.speaker, i.start, i.end]);

// --- cleanIntervals ---------------------------------------------------------------------------

test('cleanIntervals drops a blip shorter than minDuration and keeps one exactly at it', () => {
  // 5.3 - 5 is 0.29999999999999982 in doubles: a 300 ms interval from ms stamps must survive.
  const out = cleanIntervals([iv('Anna', 1, 1.2), iv('Anna', 5, 5.3), iv('Anna', 10, 12)]);
  assert.deepEqual(spans(out), [
    ['Anna', 5, 5.3],
    ['Anna', 10, 12],
  ]);
});

test('a gap exactly at mergeGap merges despite float noise', () => {
  // 1.1 - 0.8 is 0.30000000000000004 in doubles.
  const out = cleanIntervals([iv('Anna', 0, 0.8), iv('Anna', 1.1, 2)]);
  assert.deepEqual(spans(out), [['Anna', 0, 2]]);
});

test('cleanIntervals merges same-speaker intervals within mergeGap, not beyond', () => {
  const out = cleanIntervals([iv('Anna', 0, 2), iv('Anna', 2.2, 4), iv('Anna', 4.5, 6)]);
  assert.deepEqual(spans(out), [
    ['Anna', 0, 4],
    ['Anna', 4.5, 6],
  ]);
});

test('two blips close together become one interval long enough to keep', () => {
  const out = cleanIntervals([iv('Anna', 1, 1.15), iv('Anna', 1.25, 1.4)]);
  assert.deepEqual(spans(out), [['Anna', 1, 1.4]]);
});

test('overlapping and nested same-speaker intervals merge', () => {
  const out = cleanIntervals([iv('Anna', 0, 5), iv('Anna', 1, 2), iv('Anna', 4, 8)]);
  assert.deepEqual(spans(out), [['Anna', 0, 8]]);
});

test('different speakers, channels or sources never merge; output is sorted by start', () => {
  const out = cleanIntervals([
    iv('Bo', 1, 2),
    iv('Anna', 0, 3),
    iv('Anna', 3.1, 4, 'mic'),
    iv('Anna', 3.1, 4, 'display', 'model'),
    iv('Anna', 3.1, 4),
  ]);
  assert.deepEqual(
    out.map((i) => [i.speaker, i.start, i.end, i.channel, i.source]),
    [
      ['Anna', 0, 4, 'display', 'platform'],
      ['Bo', 1, 2, 'display', 'platform'],
      ['Anna', 3.1, 4, 'display', 'model'],
      ['Anna', 3.1, 4, 'mic', 'platform'],
    ],
  );
});

test('lead moves starts earlier, never past the previous same-speaker end, and leaves ends alone', () => {
  const out = cleanIntervals([iv('Anna', 1, 2), iv('Anna', 2.5, 4), iv('Bo', 3, 5)], {
    lead: 0.75,
  });
  assert.deepEqual(spans(out), [
    ['Anna', 0.25, 2],
    ['Anna', 2, 4],
    ['Bo', 2.25, 5],
  ]);
});

test('lead is applied after the blip filter, so it cannot rescue a blip', () => {
  assert.deepEqual(cleanIntervals([iv('Anna', 1, 1.2)], { lead: 0.5 }), []);
});

test('lead defaults to 0 and a negative lead is treated as 0', () => {
  assert.deepEqual(spans(cleanIntervals([iv('Anna', 1, 2)])), [['Anna', 1, 2]]);
  assert.deepEqual(spans(cleanIntervals([iv('Anna', 1, 2)], { lead: -5 })), [['Anna', 1, 2]]);
});

test('cleanIntervals drops invalid intervals and does not mutate its input', () => {
  const input = [iv('Anna', 2, 2), iv('Anna', 3, 1), iv('Anna', 0, 1), iv('Anna', 1.1, 2)];
  const snapshot = JSON.stringify(input);
  const out = cleanIntervals(input);
  assert.deepEqual(spans(out), [['Anna', 0, 2]]);
  assert.equal(JSON.stringify(input), snapshot);
});

test('cleanIntervals options can be zero', () => {
  const out = cleanIntervals([iv('Anna', 0, 0.1), iv('Anna', 0.1, 0.2), iv('Anna', 0.5, 0.6)], {
    minDuration: 0,
    mergeGap: 0,
  });
  assert.deepEqual(spans(out), [
    ['Anna', 0, 0.2],
    ['Anna', 0.5, 0.6],
  ]);
});

// --- eventsToEvidence -------------------------------------------------------------------------

const T0 = 1_790_000_000_000;
const sp = (atOffsetMs: number, id: string, name: string, speaking: boolean): AdapterEvent => ({
  type: 'speaker',
  platform: 'meet',
  at: T0 + atOffsetMs,
  id,
  name,
  speaking,
});
const roster = (atOffsetMs: number, names: string[]): AdapterEvent => ({
  type: 'roster',
  platform: 'meet',
  at: T0 + atOffsetMs,
  names,
});
const noLead = { clean: { lead: 0 } };

test('speaker toggles become display platform intervals in recording seconds, labelled by name', () => {
  const { intervals, participants } = eventsToEvidence(
    [
      sp(1000, 'p1', 'Anna', true),
      sp(4000, 'p1', 'Anna', false),
      sp(4500, 'p2', 'Bo', true),
      sp(9000, 'p2', 'Bo', false),
    ],
    T0,
    T0 + 20_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [
    ['Anna', 1, 4],
    ['Bo', 4.5, 9],
  ]);
  assert.ok(intervals.every((i) => i.channel === 'display' && i.source === 'platform'));
  assert.deepEqual(participants, ['Anna', 'Bo']);
});

test('lead defaults to MEET_LEAD and can be overridden through clean', () => {
  const events = [sp(2000, 'p1', 'Anna', true), sp(4000, 'p1', 'Anna', false)];
  assert.equal(MEET_LEAD, 0.3);
  assert.deepEqual(spans(eventsToEvidence(events, T0, T0 + 10_000).intervals), [
    ['Anna', 2 - MEET_LEAD, 4],
  ]);
  assert.deepEqual(
    spans(eventsToEvidence(events, T0, T0 + 10_000, { clean: { lead: 0.1 } }).intervals),
    [['Anna', 1.9, 4]],
  );
});

test('lead never pushes a start before t=0', () => {
  const { intervals } = eventsToEvidence(
    [sp(100, 'p1', 'Anna', true), sp(3000, 'p1', 'Anna', false)],
    T0,
    T0 + 10_000,
  );
  assert.deepEqual(spans(intervals), [['Anna', 0, 3]]);
});

test('two participants with the same display name are paired by id, not collapsed', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(1000, 'p1', 'Anna', true),
      sp(2000, 'p2', 'Anna', true),
      sp(3000, 'p1', 'Anna', false),
      sp(6000, 'p2', 'Anna', false),
    ],
    T0,
    T0 + 10_000,
    noLead,
  );
  // Keyed by name, the second start would be ignored and the first stop would end both at 3.
  assert.deepEqual(spans(intervals), [['Anna', 1, 6]]);
});

test('the self tile is dropped from display evidence and from participants', () => {
  const events = [
    roster(0, ['You', 'Anna']),
    sp(1000, 'me', 'You', true),
    sp(3000, 'me', 'You', false),
    sp(2000, 'p1', 'Anna', true),
    sp(5000, 'p1', 'Anna', false),
  ];
  const out = eventsToEvidence(events, T0, T0 + 10_000, noLead);
  assert.deepEqual(spans(out.intervals), [['Anna', 2, 5]]);
  assert.deepEqual(out.participants, ['Anna']);
});

test('selfLabel puts the human into participants at the self tile position; selfNames overrides', () => {
  const events = [
    roster(0, ['Anna', 'Du', 'Bo']),
    sp(1000, 'me', 'Du', true),
    sp(3000, 'me', 'Du', false),
  ];
  const withDefault = eventsToEvidence(events, T0, T0 + 10_000, noLead);
  assert.deepEqual(spans(withDefault.intervals), [['Du', 1, 3]]);
  assert.deepEqual(withDefault.participants, ['Anna', 'Du', 'Bo']);

  const out = eventsToEvidence(events, T0, T0 + 10_000, {
    ...noLead,
    selfNames: ['Du', 'You'],
    selfLabel: 'Ulf',
  });
  assert.deepEqual(out.intervals, []);
  assert.deepEqual(out.participants, ['Anna', 'Ulf', 'Bo']);
});

test('a participant still on at the end closes at the end', () => {
  const { intervals } = eventsToEvidence([sp(7000, 'p1', 'Anna', true)], T0, T0 + 10_000, noLead);
  assert.deepEqual(spans(intervals), [['Anna', 7, 10]]);
});

test('events before the start are clipped to 0, not dropped', () => {
  const { intervals } = eventsToEvidence(
    [sp(-5000, 'p1', 'Anna', true), sp(2000, 'p1', 'Anna', false)],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [['Anna', 0, 2]]);
});

test('a stop without a received start means speaking since before listening began: on from 0', () => {
  const only = eventsToEvidence([sp(3000, 'p1', 'Anna', false)], T0, T0 + 10_000, noLead);
  assert.deepEqual(spans(only.intervals), [['Anna', 0, 3]]);

  const thenNormal = eventsToEvidence(
    [sp(1000, 'p1', 'Anna', false), sp(5000, 'p1', 'Anna', true), sp(8000, 'p1', 'Anna', false)],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(thenNormal.intervals), [
    ['Anna', 0, 1],
    ['Anna', 5, 8],
  ]);

  // An orphan stop before the recording started describes speech that ended before t=0.
  const before = eventsToEvidence(
    [sp(-1000, 'p1', 'Anna', false), sp(2000, 'p1', 'Anna', true), sp(4000, 'p1', 'Anna', false)],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(before.intervals), [['Anna', 2, 4]]);
});

// The transport (chrome.runtime.sendMessage, fire-and-forget) can reorder, duplicate or lose a
// message, and the adapter stamps a stop at the last meter change, before the poll that sends it.

test('arrival order differing from stamp order: a stop stamped before a later-arriving start', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(1000, 'p1', 'Anna', true),
      sp(2300, 'p2', 'Bo', true), // arrives first (MutationObserver)
      sp(2000, 'p1', 'Anna', false), // stamped at the last meter change, sent by the next poll
      sp(5000, 'p2', 'Bo', false),
    ],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [
    ['Anna', 1, 2],
    ['Bo', 2.3, 5],
  ]);
});

test('a duplicated start or stop changes nothing', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(1000, 'p1', 'Anna', true),
      sp(1000, 'p1', 'Anna', true),
      sp(3000, 'p1', 'Anna', false),
      sp(3000, 'p1', 'Anna', false),
      sp(6000, 'p1', 'Anna', true),
      sp(8000, 'p1', 'Anna', false),
    ],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [
    ['Anna', 1, 3],
    ['Anna', 6, 8],
  ]);
});

test('a lost start after a closed turn loses that turn only; it does not reopen from 0', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(10_000, 'p1', 'Anna', true),
      sp(20_000, 'p1', 'Anna', false),
      sp(110_000, 'p1', 'Anna', false),
    ],
    T0,
    T0 + 120_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [['Anna', 10, 20]]);
});

test('a lost stop stretches the turn to the next stop of that participant', () => {
  const { intervals } = eventsToEvidence(
    [sp(1000, 'p1', 'Anna', true), sp(6000, 'p1', 'Anna', true), sp(8000, 'p1', 'Anna', false)],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [['Anna', 1, 8]]);
});

test('a lost first start opens from 0 (documented residual) but loses ties to received evidence', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(1000, 'p1', 'Anna', true),
      sp(50_000, 'p1', 'Anna', false),
      sp(110_000, 'p2', 'Bo', false), // Bo's start at 100 s was lost
    ],
    T0,
    T0 + 120_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [
    ['Bo', 0, 110],
    ['Anna', 1, 50],
  ]);
  const out = attribute([{ channel: 'display', start: 10, end: 20, text: 'x' }], intervals);
  assert.equal(out[0]?.speaker, 'Anna');
});

test('a stop stamped earlier than its arrival, before the recording start, yields nothing', () => {
  const { intervals } = eventsToEvidence(
    [roster(500, ['Anna']), sp(-200, 'p1', 'Anna', false), sp(3000, 'p1', 'Anna', true)],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [['Anna', 3, 10]]);
});

test('three hours of toggles convert exactly', () => {
  const events: AdapterEvent[] = [];
  const turn = 20_000;
  for (let t = 0, i = 0; t < 3 * 3600 * 1000; t += turn, i++) {
    const [id, name] = i % 2 ? ['p2', 'Bo'] : ['p1', 'Anna'];
    events.push(sp(t + 300, id, name, true), sp(t + turn - 100, id, name, false));
  }
  const { intervals } = eventsToEvidence(events, T0, T0 + 3 * 3600 * 1000, noLead);
  assert.equal(intervals.length, 540);
  assert.deepEqual(spans(intervals).slice(-1), [['Bo', 10780.3, 10799.9]]);
  assert.ok(intervals.every((iv, i) => i === 0 || iv.start >= intervals[i - 1]!.start));
});

test('an interval entirely before the start or after the end is dropped; one straddling the end is clipped', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(-5000, 'p1', 'Anna', true),
      sp(-1000, 'p1', 'Anna', false),
      sp(8000, 'p2', 'Bo', true),
      sp(13_000, 'p2', 'Bo', false),
      sp(12_000, 'p3', 'Cy', true),
      sp(14_000, 'p3', 'Cy', false),
    ],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [['Bo', 8, 10]]);
});

test('a stray blip in the stream is cleaned away, and near same-speaker intervals merge', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(1000, 'p1', 'Anna', true),
      sp(1150, 'p1', 'Anna', false),
      sp(2000, 'p1', 'Anna', true),
      sp(4000, 'p1', 'Anna', false),
      sp(4200, 'p1', 'Anna', true),
      sp(6000, 'p1', 'Anna', false),
    ],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [['Anna', 2, 6]]);
});

test('participants are the union of roster and speaker names, first seen first, deduplicated', () => {
  const { participants } = eventsToEvidence(
    [
      roster(0, ['Anna', 'Bo']),
      sp(1000, 'p3', 'Cy', true),
      roster(2000, ['Bo', 'Anna', 'Cy', 'Dee']),
      sp(3000, 'p3', 'Cy', false),
    ],
    T0,
    T0 + 10_000,
  );
  assert.deepEqual(participants, ['Anna', 'Bo', 'Cy', 'Dee']);
});

test('a participant first seen under the id fallback takes the real name once it appears', () => {
  const { intervals, participants } = eventsToEvidence(
    [
      sp(1000, 'p1', 'p1', true),
      sp(2000, 'p1', 'p1', false),
      sp(3000, 'p1', 'Anna', true),
      sp(5000, 'p1', 'Anna', false),
    ],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [
    ['Anna', 1, 2],
    ['Anna', 3, 5],
  ]);
  assert.deepEqual(participants, ['Anna']);
});

test('a participant whose name never resolves is labelled Speaker and is not a participant', () => {
  const events = [
    roster(0, ['Anna']),
    sp(1000, 'spaces/x/devices/9', 'spaces/x/devices/9', true),
    sp(3000, 'spaces/x/devices/9', 'spaces/x/devices/9', false),
    sp(4000, 'p1', 'Anna', true),
    sp(5000, 'p1', 'Anna', false),
  ];
  const out = eventsToEvidence(events, T0, T0 + 10_000, noLead);
  assert.deepEqual(spans(out.intervals), [
    ['Speaker', 1, 3],
    ['Anna', 4, 5],
  ]);
  assert.deepEqual(out.participants, ['Anna']);
  const guest = eventsToEvidence(events, T0, T0 + 10_000, { ...noLead, unresolvedLabel: 'Guest' });
  assert.equal(guest.intervals[0]?.speaker, 'Guest');
});

test('a roster name equal to a participant id is the fallback, not a participant', () => {
  const { participants } = eventsToEvidence(
    [roster(0, ['p1', 'Anna']), sp(1000, 'p1', 'Bo', true), sp(2000, 'p1', 'Bo', false)],
    T0,
    T0 + 10_000,
  );
  assert.deepEqual(participants, ['Anna', 'Bo']);
});

test('a self tile first seen unresolved and later as You loses all its intervals', () => {
  const { intervals, participants } = eventsToEvidence(
    [
      sp(1000, 'me', 'me', true),
      sp(2000, 'me', 'me', false),
      sp(3000, 'me', 'You', true),
      sp(4000, 'me', 'You', false),
    ],
    T0,
    T0 + 10_000,
    { ...noLead, selfLabel: 'Ulf' },
  );
  assert.deepEqual(intervals, []);
  assert.deepEqual(participants, ['Ulf']);
});

test('no events, or an empty recording, yields nothing', () => {
  assert.deepEqual(eventsToEvidence([], T0, T0 + 10_000), { intervals: [], participants: [] });
  const { intervals } = eventsToEvidence([sp(0, 'p1', 'Anna', true)], T0, T0);
  assert.deepEqual(intervals, []);
});

test('output is sorted by start across participants', () => {
  const { intervals } = eventsToEvidence(
    [
      sp(5000, 'p2', 'Bo', true),
      sp(8000, 'p2', 'Bo', false),
      sp(1000, 'p1', 'Anna', true),
      sp(3000, 'p1', 'Anna', false),
    ],
    T0,
    T0 + 10_000,
    noLead,
  );
  assert.deepEqual(spans(intervals), [
    ['Anna', 1, 3],
    ['Bo', 5, 8],
  ]);
});

// --- self by microphone -----------------------------------------------------------------------

test('the self tile is the id whose speaking coincides with microphone speech, whatever its label', () => {
  // Meet named the human's tile "Ulf Aslak" (2026-09-25); the label rule alone would keep it.
  const events = [
    roster(0, ['Ulf Aslak', 'Anna']),
    sp(1000, 'me', 'Ulf Aslak', true),
    sp(3000, 'me', 'Ulf Aslak', false),
    sp(5000, 'me', 'Ulf Aslak', true),
    sp(8000, 'me', 'Ulf Aslak', false),
    sp(3000, 'p1', 'Anna', true),
    sp(5000, 'p1', 'Anna', false),
  ];
  const out = eventsToEvidence(events, T0, T0 + 10_000, {
    ...noLead,
    selfLabel: 'Ulf',
    micSpeech: [
      { start: 1, end: 3 },
      { start: 5, end: 8 },
    ],
  });
  assert.deepEqual(spans(out.intervals), [['Anna', 3, 5]]);
  assert.deepEqual(out.participants, ['Ulf', 'Anna']);
  assert.deepEqual(out.self, { name: 'Ulf Aslak', micShare: 1, seconds: 5 });
});

test('a remote participant talking over the human is not self', () => {
  // Anna speaks 6 s, 2 of them while the human talks: a third, well under the half required.
  const events = [sp(2000, 'p1', 'Anna', true), sp(8000, 'p1', 'Anna', false)];
  const out = eventsToEvidence(events, T0, T0 + 10_000, {
    ...noLead,
    selfLabel: 'Ulf',
    micSpeech: [{ start: 2, end: 4 }],
  });
  assert.deepEqual(spans(out.intervals), [['Anna', 2, 8]]);
  assert.deepEqual(out.participants, ['Anna']);
  assert.equal(out.self, undefined);
});

test('a tile that spoke too little to judge is kept unless its label says self', () => {
  const short = SELF_MIN_SECONDS * 1000 - 500;
  const events = [
    sp(1000, 'me', 'You', true),
    sp(2000, 'me', 'You', false),
    sp(3000, 'p1', 'Ulf Aslak', true),
    sp(3000 + short, 'p1', 'Ulf Aslak', false),
  ];
  const out = eventsToEvidence(events, T0, T0 + 20_000, {
    ...noLead,
    selfLabel: 'Ulf',
    micSpeech: [{ start: 0, end: 20 }],
  });
  assert.deepEqual(spans(out.intervals), [['Ulf Aslak', 3, 3 + short / 1000]]);
  assert.deepEqual(out.participants, ['Ulf', 'Ulf Aslak']);
  assert.equal(out.self, undefined);
});

test('without micSpeech only the label identifies the self tile', () => {
  const events = [sp(1000, 'me', 'Ulf Aslak', true), sp(8000, 'me', 'Ulf Aslak', false)];
  const out = eventsToEvidence(events, T0, T0 + 10_000, { ...noLead, selfLabel: 'Ulf' });
  assert.deepEqual(spans(out.intervals), [['Ulf Aslak', 1, 8]]);
  assert.equal(out.self, undefined);
});

test('presentation tiles are not participants; their intervals keep their label', () => {
  const events = [
    roster(0, [
      'Carolina Pinheiro',
      'Carolina Pinheiro (Presentation)',
      'Ulf Aslak (Your Presentation)',
      'Ulf Aslak',
    ]),
    sp(1000, 'me', 'Ulf Aslak', true),
    sp(7000, 'me', 'Ulf Aslak', false),
    sp(2000, 'pres', 'Carolina Pinheiro (Presentation)', true),
    sp(3000, 'pres', 'Carolina Pinheiro (Presentation)', false),
  ];
  const out = eventsToEvidence(events, T0, T0 + 10_000, {
    ...noLead,
    selfLabel: 'Ulf',
    micSpeech: [{ start: 1, end: 7 }],
  });
  assert.deepEqual(spans(out.intervals), [['Carolina Pinheiro (Presentation)', 2, 3]]);
  assert.deepEqual(out.participants, ['Carolina Pinheiro', 'Ulf']);
});

test('a tile on screen for a moment that never spoke is not a participant; a silent one present for the call is', () => {
  // "You are presenting" flashed for three seconds with a 40 ms meter blip (2026-09-25); Bo
  // never spoke but sat in the call.
  const events = [
    roster(0, ['You', 'Anna', 'Bo']),
    roster(4000, ['You', 'Anna', 'Bo', 'You are presenting']),
    sp(4100, 'x', 'You are presenting', true),
    sp(4140, 'x', 'You are presenting', false),
    roster(7000, ['You', 'Anna', 'Bo']),
    sp(1000, 'p1', 'Anna', true),
    sp(3000, 'p1', 'Anna', false),
  ];
  const out = eventsToEvidence(events, T0, T0 + 20_000, { ...noLead, selfLabel: 'Ulf' });
  assert.deepEqual(out.participants, ['Ulf', 'Anna', 'Bo']);
  assert.ok(MIN_PRESENCE_SECONDS > 3);
});

test('on a short recording, half of it on screen is enough presence', () => {
  const { participants } = eventsToEvidence(
    [roster(0, ['Anna']), roster(2000, ['Anna', 'Dee'])],
    T0,
    T0 + 6000,
  );
  assert.deepEqual(participants, ['Anna', 'Dee']);
});

test('a participant known only from speaker events counts by what they said', () => {
  const events = [
    sp(1000, 'p1', 'Anna', true),
    sp(3000, 'p1', 'Anna', false),
    sp(5000, 'p2', 'Bo', true),
    sp(5100, 'p2', 'Bo', false),
  ];
  const out = eventsToEvidence(events, T0, T0 + 10_000, noLead);
  assert.deepEqual(out.participants, ['Anna']);
});
