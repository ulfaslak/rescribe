// The vertical slice, picker path: Record screen… → 3 s with fake devices → Stop → recording.webm
// (or .mp4 with that option) in the export folder, PCM channels in OPFS, the Recording at
// `recorded`. The toolbar path needs a real click on the toolbar button (LIVE_CHECKS); everything
// downstream of "a MediaStream exists" is shared with this path.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect, test } from './fixtures.ts';
import {
  escape,
  removeOpfs,
  setSettings,
  startDialogs,
  stopDialogs,
  waitForStartDialog,
  dialogClosed,
  waitForStopDialog,
  windowOfTab,
} from './helpers.ts';
import { SETTINGS_VERSION, type Recording } from '../src/lib/types.ts';
import { exportVideoName } from '../src/recorder/recorder.ts';

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
  // Keep every display stream reachable from the test, to end its track mid-recording.
  await page.addInitScript(() => {
    const w = window as unknown as { __displayStreams: MediaStream[] };
    w.__displayStreams = [];
    const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (c?: DisplayMediaStreamOptions) => {
      const s = await orig(c);
      w.__displayStreams.push(s);
      return s;
    };
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`chrome-extension://${extensionId}/app/app.html`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');
  // This spec covers steps 1–2 only: a recording must end at `recorded`, with the pill idle and
  // the badge clear. The pipeline (steps 3–5, e2e/pipeline.spec.ts) would otherwise start on Stop.
  await setSettings(page, { autoTranscribe: false });
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

interface Probe {
  codecs: string[];
  /** From the header when it has one (`headerDuration`), else the last audio packet's time. */
  duration: number;
  /** NaN when the container carries no duration (a WebM exported without its header patched). */
  headerDuration: number;
  format: string;
  videoFrames: number;
  /** The last video packet's time: how far the pictures actually go, whatever the header says. */
  lastVideoPts: number;
  audioChannels: number;
}

function ffprobe(file: string): Probe {
  const run = (args: string[]) =>
    JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args, file]).toString(),
    ) as {
      streams?: Array<{ codec_name: string; codec_type: string; channels?: number }>;
      format?: { duration?: string; format_name: string };
      packets?: Array<{ pts_time?: string }>;
    };
  const probe = run(['-show_streams', '-show_format']);
  const headerDuration = Number(probe.format?.duration);
  let duration = headerDuration;
  if (!Number.isFinite(duration)) {
    // A live-stream WebM: no duration in the header. Take the last packet.
    const packets = run(['-show_packets', '-select_streams', 'a:0']).packets ?? [];
    duration = Math.max(0, ...packets.map((p) => Number(p.pts_time)).filter(Number.isFinite));
  }
  const audio = (probe.streams ?? []).find((s) => s.codec_type === 'audio');
  const video = run(['-show_packets', '-select_streams', 'v:0']).packets ?? [];
  return {
    codecs: (probe.streams ?? []).map((s) => s.codec_name),
    duration,
    headerDuration,
    format: probe.format?.format_name ?? '',
    videoFrames: video.length,
    lastVideoPts: Math.max(0, ...video.map((p) => Number(p.pts_time)).filter(Number.isFinite)),
    audioChannels: audio?.channels ?? 0,
  };
}

async function saveExport(page: Page, rec: Recording, name: string): Promise<string> {
  const file = path.resolve('.playwright/out', name);
  mkdirSync(path.dirname(file), { recursive: true });
  const bytes = await opfsBytes(page, [
    EXPORT_DIR,
    ...rec.exportPath!.split('/'),
    exportVideoName(rec.container),
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

/** RMS of an Int16 LE PCM buffer, in dBFS. */
function rmsDb(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return 20 * Math.log10(Math.sqrt(sum / Math.max(1, n)) || 1e-9);
}

function expectPcmLength(bytes: number, seconds: number, what: string): void {
  const expected = seconds * PCM_BYTES_PER_SECOND;
  console.log(
    `${what}: ${bytes} bytes = ${(bytes / PCM_BYTES_PER_SECOND).toFixed(2)} s (recorded ${seconds.toFixed(2)} s)`,
  );
  expect(bytes, what).toBeGreaterThan(expected * 0.8);
  expect(bytes, what).toBeLessThan(expected * 1.2);
}

test('picker path: 3 s → recording.webm (av1+opus, 5 fps, with its duration), PCM channels, recorded; twice without collision', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  // No {time}: the second recording renders the same folder name and must get a suffix. The
  // stored settings are an unversioned object with the old default container and no frame rate,
  // as every profile from before #27 has (the profile here is reused between tests, so the frame
  // rate a later test sets is dropped): the migration drops the container, and the recording must
  // come out at the new defaults.
  await setSettings(page, {
    container: 'mp4',
    frameRate: undefined,
    settingsVersion: undefined,
    pathTemplate: '{date} {title}',
    micByDefault: true,
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');
  await expect(page.locator('#folder-name')).toHaveText(EXPORT_DIR);
  await expect(page.locator('#mic')).toBeChecked();
  await expect(page.locator('select[name="container"]')).toHaveValue('webm');
  await expect(page.locator('select[name="frameRate"]')).toHaveValue('5');

  const clickedAt = await record(page, 3);
  const [rec] = await recordings(page);
  console.log(JSON.stringify(rec));
  expect(rec).toBeDefined();
  expect(rec!.status).toBe('recorded');
  expect(rec!.error).toBeUndefined();
  expect(rec!.note).toBeUndefined();
  expect(rec!.exportPath).toMatch(/^\d{4}-\d{2}-\d{2} Screen recording$/);
  expect(rec!.container).toBe('webm');
  expect(rec!.sources.map((s) => s.channel).sort()).toEqual(['display', 'mic']);
  const startDelta = rec!.startedAt - clickedAt;
  console.log(`startedAt − click = ${startDelta} ms`);
  expect(startDelta).toBeGreaterThanOrEqual(-50);
  expect(startDelta).toBeLessThan(1000);
  const seconds = (rec!.endedAt! - rec!.startedAt) / 1000;
  expect(seconds).toBeGreaterThan(2.5);
  expect(seconds).toBeLessThan(5);

  const opfs = ['recordings', rec!.id];
  const micBytes = await opfsSize(page, [...opfs, 'mic.pcm']);
  const displayBytes = await opfsSize(page, [...opfs, 'display.pcm']);
  expectPcmLength(micBytes, seconds, 'mic.pcm');
  expectPcmLength(displayBytes, seconds, 'display.pcm');
  const pcmSeconds = Math.max(micBytes, displayBytes) / PCM_BYTES_PER_SECOND;
  // Content, not just length: the taps zero-fill when starved, so a starved tap has the right size.
  const micDb = rmsDb(await opfsBytes(page, [...opfs, 'mic.pcm']));
  const displayDb = rmsDb(await opfsBytes(page, [...opfs, 'display.pcm']));
  console.log(
    `levels: mic ${micDb.toFixed(1)} dBFS, display ${displayDb.toFixed(1)} dBFS; stored ${JSON.stringify(rec!.levels)}`,
  );
  expect(micDb, 'the speech fixture reached mic.pcm').toBeGreaterThan(-40);
  expect(displayDb, 'fake display audio reached display.pcm').toBeGreaterThan(-40);
  expect(rec!.levels?.mic).toBeDefined();
  expect(Math.abs((rec!.levels?.mic ?? -999) - micDb)).toBeLessThan(1);
  // No render gaps were padded on a healthy run (a false positive would write a clock-gap line).
  expect(await opfsSize(page, [...opfs, 'events.jsonl'])).toBe(0);
  const videoBytes = await opfsSize(page, [...opfs, 'video.webm']);
  expect(videoBytes).toBeGreaterThan(10_000);

  const file = await saveExport(page, rec!, 'record.webm');
  const probe = ffprobe(file);
  console.log('ffprobe', JSON.stringify(probe));
  expect(probe.codecs).toEqual(expect.arrayContaining(['av1', 'opus']));
  // The exported header carries the recording's duration (MediaRecorder writes none): what a
  // player shows as the length, and what makes the exported file 11 bytes longer than the OPFS one.
  expect(probe.headerDuration).toBeGreaterThan(2);
  expect(probe.headerDuration).toBeLessThan(5);
  // Its value is the PCM length (the audio clock, which the clusters follow), not the wall clock.
  expect(Math.abs(probe.headerDuration - pcmSeconds)).toBeLessThan(0.002);
  expect(await opfsSize(page, [EXPORT_DIR, rec!.exportPath!, 'recording.webm'])).toBe(
    videoBytes + 11,
  );
  // Re-export from the row (the exported file deleted first, else it is left alone) writes the
  // same file again: the header patch is idempotent and the OPFS copy is untouched.
  await removeOpfs(page, [EXPORT_DIR, rec!.exportPath!], ['recording.webm']);
  await page.locator(`.recording-item[data-id="${rec!.id}"] button.re-export`).click();
  await expect(page.locator('#library-status')).toContainText('Saved recording.webm', {
    timeout: 15_000,
  });
  expect(await opfsSize(page, [EXPORT_DIR, rec!.exportPath!, 'recording.webm'])).toBe(
    videoBytes + 11,
  );
  expect(await opfsSize(page, [...opfs, 'video.webm'])).toBe(videoBytes);
  // Captured at 5 fps (Settings default), mixed to mono.
  expect(probe.videoFrames).toBeGreaterThan(0);
  expect(probe.videoFrames).toBeLessThanOrEqual(Math.ceil(probe.duration) * 5 + 2);
  expect(probe.audioChannels).toBe(1);

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
  expect(await opfsSize(page, [EXPORT_DIR, second!.exportPath!, 'recording.webm'])).toBeGreaterThan(
    10_000,
  );
  expect(await opfsSize(page, ['recordings', second!.id, 'mic.pcm'])).toBeGreaterThan(0);
});

test('mp4 option: h264 + aac, exported as recorded', async ({ context, extensionId }) => {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, {
    container: 'mp4',
    frameRate: 5,
    pathTemplate: '{date} {time} {title}',
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');

  await record(page, 2);
  const [rec] = await recordings(page);
  expect(rec!.status).toBe('recorded');
  expect(rec!.container).toBe('mp4');
  const videoBytes = await opfsSize(page, ['recordings', rec!.id, 'video.mp4']);
  expect(videoBytes).toBeGreaterThan(10_000);
  expect(await opfsSize(page, [EXPORT_DIR, rec!.exportPath!, 'recording.mp4'])).toBe(videoBytes);
  const probe = ffprobe(await saveExport(page, rec!, 'record.mp4'));
  console.log('ffprobe', JSON.stringify(probe));
  expect(probe.codecs).toEqual(expect.arrayContaining(['h264', 'aac']));
  expect(probe.headerDuration).toBeGreaterThan(1);
  expect(probe.headerDuration).toBeLessThan(4);
  expect(probe.audioChannels).toBe(1);
});

test('30 fps setting: more frames per second reach the file than at the default', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, {
    container: 'webm',
    frameRate: 30,
    pathTemplate: '{date} {time} {title}',
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('select[name="frameRate"]')).toHaveValue('30');

  await record(page, 2);
  const [rec] = await recordings(page);
  expect(rec!.status).toBe('recorded');
  const probe = ffprobe(await saveExport(page, rec!, 'record-30fps.webm'));
  console.log('ffprobe', JSON.stringify(probe));
  expect(probe.videoFrames).toBeGreaterThan(probe.duration * 10);
});

// INVARIANTS "on disk within seconds": a WebM chunk arrives per timeslice with keyframes 10 s
// apart (the first at 0 s, so 3.5 s of a killed recording decodes); an MP4 fragment arrives only
// at a keyframe, so that container runs with a keyframe per timeslice.
for (const container of ['webm', 'mp4'] as const)
  test(`app tab closed mid-recording (${container}): data is on disk, recovered and exported on next open`, async ({
    context,
    extensionId,
  }) => {
    await openTarget(context);
    let page = await openApp(context, extensionId);
    await clearRecordings(page);
    await seedExportFolder(page);
    await setSettings(page, { container, frameRate: 5, pathTemplate: '{date} {time} {title}' });
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
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
    const probe = ffprobe(await saveExport(page, rec!, `recovered.${container}`));
    console.log('ffprobe', JSON.stringify(probe));
    expect(probe.codecs).toEqual(expect.arrayContaining([container === 'webm' ? 'av1' : 'h264']));
    // Everything up to the last chunk written before the kill decodes: the packets say so (the
    // header can only repeat what the export wrote into it).
    expect(probe.videoFrames).toBeGreaterThan(0);
    expect(probe.lastVideoPts).toBeGreaterThan(seconds - 1.5);
    // The header says how long: the recovered WebM gets the record's duration (from the PCM
    // length) written in; a fragmented MP4 carries its own from the fragments.
    if (container === 'webm') expect(Math.abs(probe.headerDuration - seconds)).toBeLessThan(0.01);
    else expect(probe.headerDuration).toBeGreaterThan(seconds - 1.5);
  });

test('display track ends mid-recording (Stop sharing, tab closed): the recording waits stopped, the stop dialog opens, Save from it exports a playable video', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, { container: 'mp4', pathTemplate: '{date} {time} {title}' });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');

  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  await page.waitForTimeout(2500);
  // Chrome fires `ended` on the track when the source goes away; stop() alone does not.
  await page.evaluate(() => {
    const w = window as unknown as { __displayStreams: MediaStream[] };
    for (const t of w.__displayStreams[0]!.getVideoTracks()) {
      t.stop();
      t.dispatchEvent(new Event('ended'));
    }
  });
  // No decision was made: nothing is exported, the human is asked (e2e/stop-dialog.spec.ts has
  // the rest of that path). Save from the dialog exports.
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 30_000 });
  let [rec] = await recordings(page);
  expect(rec!.status).toBe('stopped');
  expect(rec!.exportPath).toBeUndefined();
  const dialog = await waitForStopDialog(context, extensionId);
  await expect(dialog.locator('#state')).toHaveText('ended');
  await dialog.click('#save');
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  await expect.poll(() => stopDialogs(context, extensionId).length, { timeout: 10_000 }).toBe(0);
  [rec] = await recordings(page);
  console.log(JSON.stringify(rec));
  expect(rec!.status).toBe('recorded');
  expect(rec!.exportPath).toBeDefined();
  expect(rec!.error).toBeUndefined();
  const probe = ffprobe(await saveExport(page, rec!, 'ended.mp4'));
  expect(probe.codecs).toEqual(expect.arrayContaining(['h264', 'aac']));
  expect(probe.duration).toBeGreaterThan(1);
});

test('no export folder chosen: Stop asks for one and keeps recording; the share ending leaves it waiting; Save from the row exports once a folder exists', async ({
  context,
  extensionId,
}) => {
  // The picker cannot be driven: here it is cancelled.
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
  });
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('rescribe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('handles', 'readwrite');
          tx.objectStore('handles').delete('export');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await setSettings(page, { container: 'mp4', pathTemplate: '{date} {time} {title}' });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#folder-name')).toHaveText('No folder chosen');

  // Stop with no folder: the picker (cancelled here), the recording untouched. Never a
  // recording marked "recorded, not exported" from a Save.
  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  await page.waitForTimeout(2000);
  await page.click('#stop');
  await expect(page.locator('#record-status')).toContainText('Choose a folder to save to');
  await expect(page.locator('#status')).toHaveText('recording');
  let [rec] = await recordings(page);
  expect(rec!.status).toBe('recording');

  // The share ends: it waits, with the media kept; Save from the row once a folder exists.
  await page.evaluate(() => {
    const w = window as unknown as { __displayStreams: MediaStream[] };
    for (const t of w.__displayStreams[0]!.getVideoTracks()) {
      t.stop();
      t.dispatchEvent(new Event('ended'));
    }
  });
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 30_000 });
  await escape(await waitForStopDialog(context, extensionId));
  [rec] = await recordings(page);
  console.log(JSON.stringify(rec));
  expect(rec!.status).toBe('stopped');
  expect(rec!.exportPath).toBeUndefined();
  expect(rec!.error).toBeUndefined();
  expect(await opfsSize(page, ['recordings', rec!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  const row = page.locator(`.recording-item[data-id="${rec!.id}"]`);
  await expect(row.locator('button.save')).toBeVisible();
  await expect(row.locator('button.save-now')).toHaveCount(0);
  await seedExportFolder(page);
  await row.locator('button.save').click();
  await expect(row.locator('.path')).toHaveText(/Screen recording\/$/, { timeout: 15_000 });
  const [saved] = await recordings(page);
  expect(saved!.id).toBe(rec!.id);
  expect(saved!.status).toBe('recorded');
  expect(saved!.error).toBeUndefined();
  expect(saved!.exportPath).toBeDefined();
  expect(await opfsSize(page, [EXPORT_DIR, saved!.exportPath!, 'recording.mp4'])).toBeGreaterThan(
    10_000,
  );
  await expect(row.locator('button.save-now')).toHaveCount(0);
  await expect(page.locator('#status')).toHaveText('idle');
});

test('a second app tab is inert: no badge change, no second recording', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  const a = await openApp(context, extensionId);
  await clearRecordings(a);
  await seedExportFolder(a);
  await a.reload();
  await expect(a.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(a.locator('#status')).toHaveText('idle');
  await a.click('#record-screen');
  await expect(a.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  const badge = () => a.evaluate(() => chrome.action.getBadgeText({}));
  expect(await badge()).toBe('REC');
  const aTabId = await a.evaluate(async () => (await chrome.tabs.getCurrent())!.id!);

  const b = await context.newPage();
  await b.goto(`chrome-extension://${extensionId}/app/app.html`);
  await expect(b.locator('#duplicate')).toBeVisible();
  await expect(b.locator('main')).toBeHidden();
  expect(await badge()).toBe('REC');
  // The service worker's per-tab query reaches the owner and only the owner.
  expect(
    await b.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'query-status' }), aTabId),
  ).toBe('recording');
  // "Go to the Rescribe tab" focuses A and closes the duplicate.
  await b.click('#focus-app');
  await expect.poll(() => b.isClosed(), { timeout: 10_000 }).toBe(true);

  // A broadcast toggle (as a keyboard command would be, before the fix) starts nothing in a
  // duplicate. The owner, recording, answers a toggle by coming forward (the service worker
  // sent it on a stale `idle`), and that closes the duplicate again.
  const b2 = await context.newPage();
  await b2.goto(`chrome-extension://${extensionId}/app/app.html`);
  await expect(b2.locator('#duplicate')).toBeVisible();
  await b2.evaluate(() => chrome.runtime.sendMessage({ type: 'toggle-recording', tabId: 1 }));
  await expect(a.locator('#status')).toHaveText('recording');
  expect(await badge()).toBe('REC');
  await expect.poll(() => b2.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(a.locator('#status')).toHaveText('recording');
  await a.click('#stop');
  await expect(a.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  const recs = await recordings(a);
  expect(recs).toHaveLength(1);
  expect(recs[0]!.status).toBe('recorded');
  expect(await badge()).toBe('');
});

test('storage worker fails to load: start fails visibly, nothing persisted, capture released', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const Orig = window.Worker;
    window.Worker = class extends Orig {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(String(url).replace('storage.js', 'missing.js'), opts);
      }
    };
  });
  await page.goto(`chrome-extension://${extensionId}/app/app.html`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');
  await clearRecordings(page);
  await page.click('#record-screen');
  await expect(page.locator('#record-status')).toContainText("Couldn't start", { timeout: 15_000 });
  await expect(page.locator('#record-status')).toContainText('storage worker');
  await expect(page.locator('#status')).toHaveText('idle');
  expect(await recordings(page)).toHaveLength(0);
  await expect(page.locator('#record-screen')).toBeEnabled();
});

test('a lost video chunk fails the recording at once and releases everything', async ({
  context,
  extensionId,
}) => {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await page.addInitScript(() => {
    let calls = 0;
    const orig = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      calls++;
      if (calls === 2) return Promise.reject(new Error('synthetic arrayBuffer failure'));
      return orig.call(this);
    };
  });
  await clearRecordings(page);
  await seedExportFolder(page);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');
  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  // Without a Stop click: the second chunk (~2 s) fails and the recording ends by itself.
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 15_000 });
  const [rec] = await recordings(page);
  console.log(JSON.stringify(rec));
  expect(rec!.status).toBe('failed');
  expect(rec!.error).toMatch(/Video chunk lost.*synthetic/);
  expect(rec!.endedAt! - rec!.startedAt).toBeLessThan(5000);
  await expect(page.locator('#record-status')).toContainText('Recording failed');
  // Contexts and the writer were released: a new recording works in the same page.
  await record(page, 2);
  const [next] = await recordings(page);
  expect(next!.id).not.toBe(rec!.id);
  expect(next!.status).toBe('recorded');
});

test('toolbar click: the start dialog opens for the clicked tab and the app tab is opened pinned in the background, on a Meet tab and on any other; Start without the real click fails in the dialog; the button and Escape close it; while recording the click opens the stop dialog', async ({
  context,
  extensionId,
}) => {
  // The real toolbar click cannot be made here, and without it getMediaStreamId refuses the
  // target ("not been invoked"), so every Start below fails after the routing decision. What is
  // exercised: the service worker's routing (`onToggle` with a Tab-shaped object), where the app
  // tab lands, and the dialog's answer to a Start it cannot honour. A successful start staying
  // in the background is the live check.
  const target = await openTarget(context);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const appUrl = `chrome-extension://${extensionId}/app/app.html`;
  type Created = { id: number; active: boolean; pinned: boolean; url: string };
  type Hooked = { rescribe: { onToggle: (tab: object) => Promise<void> }; __created: Created[] };
  const targetId = await worker.evaluate(async (title) => {
    const g = globalThis as unknown as Hooked;
    g.__created = [];
    chrome.tabs.onCreated.addListener((t) =>
      g.__created.push({
        id: t.id!,
        active: t.active,
        pinned: t.pinned,
        url: t.pendingUrl ?? t.url ?? '',
      }),
    );
    return (await chrome.tabs.query({ title }))[0]!.id!;
  }, CAPTURE_TARGET_TITLE);
  // The app tabs created (a dialog's popup window has a tab of its own, not counted).
  const created = async () =>
    (await worker.evaluate(() => (globalThis as unknown as Hooked).__created)).filter(
      (t) => t.url === appUrl,
    );
  const toggle = (url: string) =>
    worker.evaluate(
      ({ id, url }) =>
        (globalThis as unknown as Hooked).rescribe.onToggle({ id, url, title: 'Some tab' }),
      { id: targetId, url },
    );
  const activeTab = (id: number) =>
    worker.evaluate(async (id) => (await chrome.tabs.get(id)).active, id);
  const nextAppPage = () => context.waitForEvent('page', { predicate: (p) => p.url() === appUrl });
  const browserWindow = await windowOfTab(worker, targetId);

  // A Meet tab: the start dialog opens for it, the app tab is created pinned in the background,
  // in the browser window (not the dialog's)...
  let appPage = nextAppPage();
  await toggle('https://meet.google.com/abc-defg-hij');
  const dialog = await waitForStartDialog(context, extensionId);
  await expect(dialog.locator('#target-title')).toHaveText(CAPTURE_TARGET_TITLE);
  await expect(dialog.locator('#start')).toBeEnabled();
  let app = await appPage;
  await expect(app.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await setSettings(app, { autoTranscribe: false });
  let made = await created();
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ active: false, pinned: true });
  expect(await windowOfTab(worker, made[0]!.id)).toBe(browserWindow);
  // ...and a Start that could not get a stream id says so in the dialog and leaves the app tab
  // where it is.
  await dialog.click('#start');
  await expect(dialog.locator('#status')).toContainText("Couldn't capture that tab (", {
    timeout: 15_000,
  });
  await expect(dialog.locator('#start')).toBeEnabled();
  expect(dialogClosed(dialog)).toBe(false);
  expect(await activeTab(made[0]!.id)).toBe(false);
  await expect(app.locator('#status')).toHaveText('idle');
  const before = (await recordings(app)).length;
  expect(await app.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  // The button again closes the dialog and opens nothing; the next click opens it again; Escape
  // closes it.
  await toggle('https://meet.google.com/abc-defg-hij');
  await expect.poll(() => dialogClosed(dialog), { timeout: 5000 }).toBe(true);
  await app.waitForTimeout(500);
  expect(startDialogs(context, extensionId)).toHaveLength(0);
  expect(stopDialogs(context, extensionId)).toHaveLength(0);
  await toggle('https://meet.google.com/abc-defg-hij');
  await escape(await waitForStartDialog(context, extensionId));
  expect(await created()).toHaveLength(1);

  // Any other tab: the same; the app tab stays in the background there too (the dialog is the
  // interface).
  await worker.evaluate((id) => chrome.tabs.remove(id), made[0]!.id);
  await expect
    .poll(() => worker.evaluate(async (url) => (await chrome.tabs.query({ url })).length, appUrl), {
      timeout: 5000,
    })
    .toBe(0);
  appPage = nextAppPage();
  await toggle('https://www.youtube.com/watch?v=x');
  const again = await waitForStartDialog(context, extensionId);
  app = await appPage;
  await expect(app.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  made = await created();
  expect(made).toHaveLength(2);
  expect(made[1]).toMatchObject({ active: false, pinned: true });
  expect(await windowOfTab(worker, made[1]!.id)).toBe(browserWindow);
  await escape(again);
  expect(await recordings(app)).toHaveLength(before);

  // While recording, a click on any tab opens the stop dialog, not the start dialog, leaves the
  // app tab where it is and starts nothing; closing the dialog keeps recording
  // (e2e/stop-dialog.spec.ts has the rest).
  await app.click('#record-screen');
  await expect(app.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), targetId);
  expect(await activeTab(made[1]!.id)).toBe(false);
  await toggle('https://meet.google.com/abc-defg-hij');
  const stop = await waitForStopDialog(context, extensionId);
  await expect(stop.locator('#state')).toHaveText('recording');
  expect(startDialogs(context, extensionId)).toHaveLength(0);
  expect(await activeTab(made[1]!.id)).toBe(false);
  await expect(app.locator('#status')).toHaveText('recording');
  expect(await created()).toHaveLength(2);
  await escape(stop);
  await expect(app.locator('#status')).toHaveText('recording');
  await app.click('#stop');
  await expect(app.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  expect(await recordings(app)).toHaveLength(before + 1);
  await target.close();
});
