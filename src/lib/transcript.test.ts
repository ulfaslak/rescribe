import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPathTemplate } from './pathtemplate.ts';
import { formatLocalDateTime, formatTime, renderMarkdown, toTurns } from './transcript.ts';
import type { LabelledSegment } from './types.ts';

const ls = (
  channel: 'mic' | 'display',
  speaker: string,
  start: number,
  end: number,
  text: string,
): LabelledSegment => ({ channel, speaker, start, end, text, evidence: 'platform' });

test('consecutive segments by the same speaker merge into one turn', () => {
  const turns = toTurns([
    ls('display', 'Anna', 0, 2, 'Hi there.'),
    ls('display', 'Anna', 2.5, 4, 'How are you?'),
    ls('mic', 'Me', 4.2, 6, 'Good.'),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.text, 'Hi there. How are you?');
  assert.equal(turns[0]?.end, 4);
  assert.equal(turns[1]?.speaker, 'Me');
});

test('turns are ordered by time across channels', () => {
  const turns = toTurns([ls('mic', 'Me', 10, 12, 'second'), ls('display', 'Anna', 0, 2, 'first')]);
  assert.deepEqual(
    turns.map((t) => t.text),
    ['first', 'second'],
  );
});

test('a long pause splits a turn even for the same speaker', () => {
  const turns = toTurns([ls('mic', 'Me', 0, 1, 'a'), ls('mic', 'Me', 30, 31, 'b')], { maxGap: 10 });
  assert.equal(turns.length, 2);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(-3), '0:00');
});

test('renderMarkdown produces a heading, participants and timestamped turns', () => {
  const md = renderMarkdown(
    toTurns([ls('display', 'Anna', 61, 63, 'Hello.'), ls('mic', 'Me', 64, 65, 'Hey.')]),
    {
      title: 'Weekly sync',
      startedAt: new Date(2026, 8, 24, 14, 30).getTime(),
      participants: ['Anna', 'Me'],
    },
  );
  assert.match(md, /^# Weekly sync\n/);
  assert.match(md, /2026-09-24 14:30/);
  assert.match(md, /Participants: Anna, Me/);
  assert.match(md, /\*\*Anna\*\* \[1:01\]\n\nHello\.\n/);
  assert.match(md, /\*\*Me\*\* \[1:04\]\n\nHey\.\n$/);
});

test('the header shows the local clock the export folder name uses, not UTC', () => {
  // 2026-09-25 07:19:36 UTC. In a zone with offset 0 the UTC header would be indistinguishable
  // from the local one, so the test pins a zone with an offset and asserts the literal.
  const startedAt = 1790320776839;
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/Copenhagen';
  try {
    assert.equal(new Date(startedAt).getTimezoneOffset(), -120);
    assert.equal(formatLocalDateTime(startedAt), '2026-09-25 09:19');
    const md = renderMarkdown([], { title: 'T', startedAt, participants: [] });
    assert.match(md, /^# T\n\n2026-09-25 09:19\n/);
    const [dir] = renderPathTemplate('{date} {time} {title}', { startedAt, title: 'T' });
    assert.equal(dir, '2026-09-25 09-19 T');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
