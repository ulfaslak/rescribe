import path from 'node:path';
import { expect, test } from './fixtures.ts';

interface Ev {
  type: string;
  name?: string;
  names?: string[];
  speaking?: boolean;
  at: number;
}

test('Meet adapter: roster from tiles, speaking from meter activity, menu text ignored', async ({
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
  await page.waitForTimeout(5500);
  const events = (await page.evaluate(
    () => (window as unknown as { __events: Ev[] }).__events,
  )) as Ev[];
  console.log(JSON.stringify(events));

  const roster = events.find((e) => e.type === 'roster');
  expect(roster?.names).toEqual(['Anna', 'Bo']);

  const speakers = events.filter((e) => e.type === 'speaker').map((e) => `${e.name}:${e.speaking}`);
  expect(speakers).toEqual(['Anna:true', 'Anna:false', 'Bo:true', 'Bo:false']);

  const [annaOn, annaOff, boOn] = events.filter((e) => e.type === 'speaker');
  expect(annaOff!.at - annaOn!.at).toBeGreaterThan(1200);
  expect(annaOff!.at - annaOn!.at).toBeLessThan(2600);
  expect(boOn!.at - annaOn!.at).toBeGreaterThan(2000);
  expect(events.some((e) => e.type === 'adapter-diagnostic')).toBe(false);
});
