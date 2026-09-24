import path from 'node:path';
import { expect, test } from './fixtures.ts';

interface Ev {
  type: string;
  id?: string;
  name?: string;
  names?: string[];
  speaking?: boolean;
  at: number;
}

test('Meet adapter: roster, speaking intervals stamped at change time, traps of the real page', async ({
  context,
}) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __events: unknown[] };
    w.__events = [];
    window.addEventListener('rescribe:event', (e) => w.__events.push((e as CustomEvent).detail));
  });
  await page.goto('file://' + path.resolve('e2e/fixtures/fake-meet.html'));
  await page.addScriptTag({ path: path.resolve('dist/content/meet.js') });
  await page.waitForTimeout(6800);
  const { events, t0 } = await page.evaluate(() => {
    const w = window as unknown as { __events: Ev[]; __t0: number };
    return { events: w.__events, t0: w.__t0 };
  });
  const rel = events.map((e) => ({ ...e, at: e.at - t0 }));
  console.log(JSON.stringify(rel));

  // Roster: one entry per participant despite the duplicated self tile; chips and menu text ignored.
  const rosters = rel.filter((e) => e.type === 'roster');
  expect(rosters[0]?.names).toEqual(['Anna', 'Bo']);
  expect(rosters.at(-1)?.names).toEqual(['Anna']);

  const sp = rel.filter((e) => e.type === 'speaker');
  expect(sp.map((e) => `${e.name}:${e.speaking}`)).toEqual([
    'Anna:true',
    'Anna:false',
    'Bo:true',
    'Bo:false',
    'Bo:true',
    'Bo:false',
  ]);
  expect(sp.every((e) => typeof e.id === 'string' && e.id.startsWith('spaces/'))).toBe(true);

  // Stamps are change times, not detection times: starts within ~250 ms of the first wobble,
  // stops at the last wobble (not a window later), the removed tile closed at removal.
  const near = (actual: number, expected: number, tol: number) =>
    expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
  near(sp[0]!.at, 500, 300);
  near(sp[1]!.at, 2000, 300);
  near(sp[2]!.at, 3000, 300);
  near(sp[3]!.at, 4500, 300);
  near(sp[4]!.at, 5200, 300);
  near(sp[5]!.at, 5600, 400);
  expect(rel.some((e) => e.type === 'adapter-diagnostic')).toBe(false);
});
