import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lidWindows, routeRegions } from './route.ts';
import type { Region } from '../vad.ts';

/** Regions of `len` seconds every `every` seconds. */
function regions(count: number, len: number, every: number, from = 0): Region[] {
  return Array.from({ length: count }, (_, i) => ({
    start: from + i * every,
    end: from + i * every + len,
  }));
}

test('lidWindows packs regions up to 30 voiced seconds, every region once, in order', () => {
  const rs = regions(10, 8, 9); // 8 s each: three fit (24 s), a fourth would be 32
  const ws = lidWindows(rs);
  assert.deepEqual(
    ws.flat(),
    rs.map((_, i) => i),
  );
  assert.deepEqual(ws[0], [0, 1, 2]);
});

test('lidWindows closes a window that would span more than a minute', () => {
  const rs = regions(4, 1, 25); // little speech, far apart
  const ws = lidWindows(rs);
  assert.deepEqual(ws, [[0, 1, 2], [3]]);
});

test('lidWindows: no regions, no windows', () => {
  assert.deepEqual(lidWindows([]), []);
});

test('routeRegions: one odd window in a Danish call stays Danish', () => {
  const rs = regions(20, 10, 10);
  const ws = lidWindows(rs); // 3 regions per window
  const p = ws.map((_, i) => (i === 3 ? 0.03 : 0.9));
  const langs = routeRegions(rs, ws, p);
  assert.ok(langs.every((l) => l === 'da'));
});

test('routeRegions: a long English stretch inside a Danish call goes to English', () => {
  const rs = regions(60, 10, 10); // 10 minutes
  const ws = lidWindows(rs);
  const p = ws.map((w) => (rs[w[0]!]!.start >= 200 && rs[w[0]!]!.start < 400 ? 0.0 : 0.95));
  const langs = routeRegions(rs, ws, p);
  assert.equal(langs[0], 'da');
  assert.equal(langs[30], 'en'); // 300 s, the middle of the English stretch
  assert.equal(langs[59], 'da');
});

test('routeRegions: an English call is English throughout', () => {
  const rs = regions(12, 5, 6);
  const ws = lidWindows(rs);
  assert.ok(
    routeRegions(
      rs,
      ws,
      ws.map(() => 0),
    ).every((l) => l === 'en'),
  );
});
