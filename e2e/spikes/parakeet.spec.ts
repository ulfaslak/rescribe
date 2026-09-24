import { readFileSync } from 'node:fs';
import { expect, test } from '../fixtures.ts';

test('parakeet spike: model loads in the extension origin and transcribes the fixture', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text());
  });
  await page.goto(`chrome-extension://${extensionId}/spikes/parakeet/spike.html`);
  await page.waitForFunction(() => (window as unknown as { __spike?: unknown }).__spike, null, {
    timeout: 14 * 60_000,
  });
  const r = await page.evaluate(
    () => (window as unknown as { __spike: Record<string, unknown> }).__spike,
  );
  console.log(JSON.stringify(r, null, 1));
  expect(r['error'], String(r['stack'] ?? '')).toBeUndefined();

  const expected = readFileSync('e2e/fixtures/speech.txt', 'utf8').toLowerCase();
  const got = String(r['text']).toLowerCase();
  const words = expected.match(/[a-z']+/g) ?? [];
  const hits = words.filter((w) => got.includes(w)).length;
  console.log(`word hit rate ${hits}/${words.length}`);
  expect(hits / words.length).toBeGreaterThan(0.8);
});
