// The vertical slice, picker path: Record screen… → 3 s with fake devices → Stop → recording.mp4
// in the export folder, PCM channels in OPFS, the Recording at `recorded`. The toolbar path needs
// a real click on the toolbar button (LIVE_CHECKS); everything downstream of "a MediaStream
// exists" is shared with this path.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect, test } from './fixtures.ts';
import type { Recording } from '../src/lib/types.ts';

/** The export "folder" is a directory in OPFS: an OPFS handle is a FileSystemDirectoryHandle, so
 * the export code runs unchanged and the test reads the result back through OPFS. */
const EXPORT_DIR = 'export-test';
const PCM_BYTES_PER_SECOND = 16000 * 2;

async function openTarget(context: BrowserContext): Promise<Page> {
  const target = await context.newPage();
  await target.goto('file://' + path.resolve('e2e/fixtures/capture-target.html'));
  await expect(target).toHaveTitle(CAPTURE_TARGET_TITLE);
  return target;
}

async function openApp(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`chrome-extension://${extensionId}/app/app.html`);
  await expect(page.locator('#status')).toHaveText('idle');
  return page;
}

async function seedExportFolder(page: Page): Promise<void> {
  await page.evaluate(async (dirName) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('rescribe');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(dir, 'export');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, EXPORT_DIR);
}

async function setSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (patch) => {
    const cur = ((await chrome.storage.local.get('settings'))['settings'] ?? {}) as object;
    await chrome.storage.local.set({ settings: { ...cur, ...patch } });
  }, patch);
}

async function clearRecordings(page: Page): Promise<void> {
  await page.evaluate(async (dirName) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('rescribe');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('recordings', 'readwrite');
        tx.objectStore('recordings').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
    const root = await navigator.storage.getDirectory();
    for (const name of ['recordings', dirName]) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
  }, EXPORT_DIR);
}

async function recordings(page: Page): Promise<Recording[]> {
  return page.evaluate(
    () =>
      new Promise<Recording[]>((resolve, reject) => {
        const req = indexedDB.open('rescribe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const r = req.result.transaction('recordings').objectStore('recordings').getAll();
          r.onsuccess = () =>
            resolve((r.result as Recording[]).sort((a, b) => b.startedAt - a.startedAt));
          r.onerror = () => reject(r.error);
        };
      }),
  );
}

/** Byte length of an OPFS file, or -1 when it does not exist. */
async function opfsSize(page: Page, segments: string[]): Promise<number> {
  return page.evaluate(async (segments) => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const s of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
      return (await (await dir.getFileHandle(segments[segments.length - 1]!)).getFile()).size;
    } catch {
      return -1;
    }
  }, segments);
}

async function opfsBytes(page: Page, segments: string[]): Promise<Buffer> {
  const b64 = await page.evaluate(async (segments) => {
    let dir = await navigator.storage.getDirectory();
    for (const s of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    const file = await (await dir.getFileHandle(segments[segments.length - 1]!)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, segments);
  return Buffer.from(b64, 'base64');
}

function ffprobe(file: string): { codecs: string[]; duration: number; format: string } {
  const run = (args: string[]) =>
    JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args, file]).toString(),
    ) as {
      streams?: Array<{ codec_name: string }>;
      format?: { duration?: string; format_name: string };
      packets?: Array<{ pts_time?: string }>;
    };
  const probe = run(['-show_streams', '-show_format']);
  let duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration)) {
    // A MediaRecorder WebM is a live stream: no duration in the header. Take the last packet.
    const packets = run(['-show_packets', '-select_streams', 'a:0']).packets ?? [];
    duration = Math.max(0, ...packets.map((p) => Number(p.pts_time)).filter(Number.isFinite));
  }
  return {
    codecs: (probe.streams ?? []).map((s) => s.codec_name),
    duration,
    format: probe.format?.format_name ?? '',
  };
}

async function saveExport(page: Page, rec: Recording, name: string): Promise<string> {
  const file = path.resolve('.playwright/out', name);
  mkdirSync(path.dirname(file), { recursive: true });
  const bytes = await opfsBytes(page, [
    EXPORT_DIR,
    ...rec.exportPath!.split('/'),
    rec.container === 'mp4' ? 'recording.mp4' : 'recording.webm',
  ]);
  writeFileSync(file, bytes);
  return file;
}

/** Click Record screen…, wait `seconds`, click Stop, wait for idle. Returns the wall clock at the click. */
async function record(page: Page, seconds: number): Promise<number> {
  const clickedAt = Date.now();
  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  await page.waitForTimeout(seconds * 1000);
  await page.click('#stop');
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  return clickedAt;
}

function expectPcmLength(bytes: number, seconds: number, what: string): void {
  const expected = seconds * PCM_BYTES_PER_SECOND;
  console.log(
    `${what}: ${bytes} bytes = ${(bytes / PCM_BYTES_PER_SECOND).toFixed(2)} s (recorded ${seconds.toFixed(2)} s)`,
  );
  expect(bytes, what).toBeGreaterThan(expected * 0.8);
  expect(bytes, what).toBeLessThan(expected * 1.2);
}

test('picker path: 3 s → recording.mp4 (h264+aac), PCM channels, recorded; twice without collision', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  // No {time}: the second recording renders the same folder name and must get a suffix.
  await setSettings(page, { container: 'mp4', pathTemplate: '{date} {title}', micByDefault: true });
  await page.reload();
  await expect(page.locator('#status')).toHaveText('idle');
  await expect(page.locator('#folder-name')).toHaveText(EXPORT_DIR);
  await expect(page.locator('#mic')).toBeChecked();

  const clickedAt = await record(page, 3);
  const [rec] = await recordings(page);
  console.log(JSON.stringify(rec));
  expect(rec).toBeDefined();
  expect(rec!.status).toBe('recorded');
  expect(rec!.error).toBeUndefined();
  expect(rec!.exportPath).toMatch(/^\d{4}-\d{2}-\d{2} Screen recording$/);
  expect(rec!.container).toBe('mp4');
  expect(rec!.sources.map((s) => s.channel).sort()).toEqual(['display', 'mic']);
  const startDelta = rec!.startedAt - clickedAt;
  console.log(`startedAt − click = ${startDelta} ms`);
  expect(startDelta).toBeGreaterThanOrEqual(-50);
  expect(startDelta).toBeLessThan(1000);
  const seconds = (rec!.endedAt! - rec!.startedAt) / 1000;
  expect(seconds).toBeGreaterThan(2.5);
  expect(seconds).toBeLessThan(5);

  const opfs = ['recordings', rec!.id];
  expectPcmLength(await opfsSize(page, [...opfs, 'mic.pcm']), seconds, 'mic.pcm');
  expectPcmLength(await opfsSize(page, [...opfs, 'display.pcm']), seconds, 'display.pcm');
  expect(await opfsSize(page, [...opfs, 'events.jsonl'])).toBe(0);
  const videoBytes = await opfsSize(page, [...opfs, 'video.mp4']);
  expect(videoBytes).toBeGreaterThan(10_000);

  const file = await saveExport(page, rec!, 'record.mp4');
  const probe = ffprobe(file);
  console.log('ffprobe', JSON.stringify(probe));
  expect(probe.codecs).toEqual(expect.arrayContaining(['h264', 'aac']));
  expect(probe.duration).toBeGreaterThan(2);
  expect(probe.duration).toBeLessThan(5);
  expect(await opfsSize(page, [EXPORT_DIR, rec!.exportPath!, 'recording.mp4'])).toBe(videoBytes);

  // The list shows it.
  const item = page.locator(`.recording-item[data-id="${rec!.id}"]`);
  await expect(item).toHaveAttribute('data-status', 'recorded');
  await expect(item.locator('.path')).toHaveText(`${rec!.exportPath}/`);

  // Second recording in the same context: fresh id and folder, suffix on the name collision.
  await record(page, 2);
  const [second, first] = await recordings(page);
  expect(first!.id).toBe(rec!.id);
  expect(second!.id).not.toBe(rec!.id);
  expect(second!.status).toBe('recorded');
  expect(second!.exportPath).toBe(`${rec!.exportPath} (2)`);
  expect(await opfsSize(page, [EXPORT_DIR, second!.exportPath!, 'recording.mp4'])).toBeGreaterThan(
    10_000,
  );
  expect(await opfsSize(page, ['recordings', second!.id, 'mic.pcm'])).toBeGreaterThan(0);
});

test('webm container: vp9 + opus', async ({ context, extensionId }) => {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, { container: 'webm', pathTemplate: '{date} {time} {title}' });
  await page.reload();
  await expect(page.locator('#status')).toHaveText('idle');

  await record(page, 2);
  const [rec] = await recordings(page);
  expect(rec!.status).toBe('recorded');
  expect(rec!.container).toBe('webm');
  const probe = ffprobe(await saveExport(page, rec!, 'record.webm'));
  console.log('ffprobe', JSON.stringify(probe));
  expect(probe.codecs).toEqual(expect.arrayContaining(['vp9', 'opus']));
  expect(probe.duration).toBeGreaterThan(1);
  expect(probe.duration).toBeLessThan(4);
});

test('app tab closed mid-recording: data is on disk, recovered and exported on next open', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  let page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, { container: 'mp4', pathTemplate: '{date} {time} {title}' });
  await page.reload();
  await expect(page.locator('#status')).toHaveText('idle');

  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  await page.waitForTimeout(3500);
  const killedAt = Date.now();
  await page.close({ runBeforeUnload: false });

  page = await openApp(context, extensionId);
  await expect(page.locator('#record-status')).toContainText('Recovered 1 interrupted recording');
  const [rec] = await recordings(page);
  console.log(JSON.stringify(rec));
  expect(rec!.status).toBe('recorded');
  expect(rec!.note).toMatch(/Interrupted/);
  expect(rec!.exportPath).toBeDefined();
  // endedAt comes from the PCM length: within a second of when the tab died.
  expect(Math.abs(rec!.endedAt! - killedAt)).toBeLessThan(1000);
  const opfs = ['recordings', rec!.id];
  const seconds = (rec!.endedAt! - rec!.startedAt) / 1000;
  expectPcmLength(await opfsSize(page, [...opfs, 'mic.pcm']), seconds, 'mic.pcm');
  const probe = ffprobe(await saveExport(page, rec!, 'recovered.mp4'));
  console.log('ffprobe', JSON.stringify(probe));
  expect(probe.codecs).toEqual(expect.arrayContaining(['h264']));
  expect(probe.duration).toBeGreaterThan(1);
});
