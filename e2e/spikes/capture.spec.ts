import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures.ts';

test('capture spike: display + mic → MP4 (H.264/AAC) + OPFS', async ({ context, extensionId }) => {
  const target = await context.newPage();
  await target.goto(`chrome-extension://${extensionId}/spikes/capture/target.html`);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/spikes/capture/spike.html`);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.click('#go');
  await page.waitForFunction(() => (window as unknown as { __spike?: unknown }).__spike, null, {
    timeout: 60_000,
  });
  const r = await page.evaluate(
    () => (window as unknown as { __spike: Record<string, unknown> }).__spike,
  );
  console.log(JSON.stringify(r, null, 1));
  expect(r['error'], String(r['stack'] ?? '')).toBeUndefined();

  const file = path.resolve('.playwright/out/spike-capture.mp4');
  mkdirSync(path.dirname(file), { recursive: true });
  await (await downloadPromise).saveAs(file);
  expect(statSync(file).size).toBe(r['size']);
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      file,
    ]).toString(),
  ) as {
    streams: Array<{ codec_name: string }>;
    format: { duration?: string; format_name: string };
  };
  console.log(
    'ffprobe',
    JSON.stringify({ format: probe.format, codecs: probe.streams.map((s) => s.codec_name) }),
  );

  expect(probe.streams.map((s) => s.codec_name)).toEqual(expect.arrayContaining(['h264', 'aac']));
  expect(Number(probe.format.duration)).toBeGreaterThan(2);
  expect(Number(probe.format.duration)).toBeLessThan(5);
  expect(r['opfsBytes']).toBe(r['size']);
  const peak = r['peakRms'] as Record<string, number>;
  expect(peak['mic'] ?? 0, 'fake mic audio reached the graph').toBeGreaterThan(0.001);
  expect(peak['display'] ?? 0, 'tab audio reached the graph').toBeGreaterThan(0.001);
});
