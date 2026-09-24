// The recording library (#4): recordings seeded through the picker path, then the actions that
// work from what is on disk. Asserts on IndexedDB and OPFS (the export "folder" is an OPFS
// directory, as in record.spec.ts), and on the row's data attributes and buttons, not on prose.
// The pipeline cases run the real transcriber on the fixture audio (the model is cached in the
// profile after the first transcribe run).
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  clearExportFolder,
  clearRecordings,
  EXPORT_DIR,
  exported,
  openApp,
  openTarget,
  opfsSize,
  opfsText,
  patchRecording,
  recordings,
  removeOpfs,
  rerun as runPipeline,
  seedExportFolder,
  setSettings,
  waitForRecording,
} from './helpers.ts';
import type { Recording } from '../src/lib/types.ts';
import { formatBytes } from '../src/app/library.ts';

/** Statuses a recording can rest at; the pipeline, when it runs after stop, passes through `transcribing`. */
const SETTLED = new Set(['recorded', 'done', 'failed']);

/** The app is up and the recorder idle (the pill may show `transcribing` while the pipeline runs). */
async function readyIdle(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');
}

async function recording(page: Page, id: string): Promise<Recording | undefined> {
  return (await recordings(page)).find((r) => r.id === id);
}

async function opfsDirExists(page: Page, segments: string[]): Promise<boolean> {
  return page.evaluate(async (segments) => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const s of segments) dir = await dir.getDirectoryHandle(s);
      return true;
    } catch {
      return false;
    }
  }, segments);
}

/** Bytes of every file under `recordings/` in OPFS: the test's own walk, independent of the app's. */
async function opfsRecordingsBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let recs: FileSystemDirectoryHandle;
    try {
      recs = await root.getDirectoryHandle('recordings');
    } catch {
      return 0;
    }
    type Iter = FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemHandle>;
    };
    let total = 0;
    for await (const d of (recs as Iter).values()) {
      if (d.kind !== 'directory') continue;
      for await (const f of (d as Iter).values()) {
        if (f.kind === 'file') total += (await (f as FileSystemFileHandle).getFile()).size;
      }
    }
    return total;
  });
}

async function writeOpfsFile(page: Page, segments: string[], text: string): Promise<void> {
  await page.evaluate(
    async ({ segments, text }) => {
      let dir = await navigator.storage.getDirectory();
      for (const s of segments.slice(0, -1))
        dir = await dir.getDirectoryHandle(s, { create: true });
      const fh = await dir.getFileHandle(segments[segments.length - 1]!, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
    },
    { segments, text },
  );
}

/** Click Record screen…, wait `seconds`, click Stop, wait for idle and for the record to settle. */
async function record(page: Page, seconds: number): Promise<Recording> {
  const before = new Set((await recordings(page)).map((r) => r.id));
  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  await page.waitForTimeout(seconds * 1000);
  await page.click('#stop');
  await expect(page.locator('#record-screen')).toBeEnabled({ timeout: 30_000 });
  const fresh = (await recordings(page)).find((r) => !before.has(r.id));
  expect(fresh).toBeDefined();
  return settled(page, fresh!.id);
}

/** The record once it rests at `recorded`, `done` or `failed` (the pipeline may run in between). */
async function settled(page: Page, id: string): Promise<Recording> {
  return waitForRecording(page, id, (r) => SETTLED.has(r.status), { label: 'settle' });
}

async function seed(page: Page, n: number, seconds = 2): Promise<Recording[]> {
  const out: Recording[] = [];
  for (let i = 0; i < n; i++) out.push(await record(page, seconds));
  return out;
}

async function setUp(
  context: BrowserContext,
  extensionId: string,
  settings: Record<string, unknown> = {},
): Promise<Page> {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, {
    container: 'mp4',
    pathTemplate: '{date} {time} {title}',
    micByDefault: true,
    myName: 'Ulf',
    model: 'parakeet-tdt-0.6b-v3',
    backend: 'wasm',
    // The pipeline transcribes on stop by default; these tests seed recordings and run it when
    // they mean to (window.rescribe.transcribeRecording, or the row's Re-run).
    autoTranscribe: false,
    ...settings,
  });
  await page.reload();
  await readyIdle(page);
  await expect(page.locator('#folder-name')).toHaveText(EXPORT_DIR);
  return page;
}

const row = (page: Page, id: string): Locator => page.locator(`.recording-item[data-id="${id}"]`);

/** The in-page two-step: arm, wait out the double-click guard, confirm. */
async function clickTwice(button: Locator): Promise<void> {
  await button.click();
  await expect(button).toHaveClass(/armed/);
  await button.page().waitForTimeout(400);
  await button.click();
}

const storageText = (page: Page): Locator => page.locator('#storage-usage');

async function expectStorageMatchesWalk(page: Page): Promise<number> {
  const bytes = await opfsRecordingsBytes(page);
  await expect(storageText(page)).toHaveText(`Local storage: ${formatBytes(bytes)}`);
  return bytes;
}

async function opfsRecordingsBytesOf(page: Page, id: string): Promise<number> {
  let total = 0;
  for (const name of ['video.mp4', 'video.webm', 'mic.pcm', 'display.pcm', 'events.jsonl']) {
    const s = await opfsSize(page, ['recordings', id, name]);
    if (s > 0) total += s;
  }
  return total;
}

test('rename persists across reload and never renames the folder; a recording row ticks; storage matches the walk', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a, b] = await seed(page, 2);
  expect(a!.exportPath).toBeDefined();
  expect(b!.exportPath).toBeDefined();
  const bytes = await expectStorageMatchesWalk(page);
  expect(bytes).toBeGreaterThan(100_000);
  await expect(row(page, a!.id).locator('.size')).toHaveText(
    `${formatBytes(bytes - (await opfsRecordingsBytesOf(page, b!.id)))} local`,
  );

  // Rename: pencil → input → Enter.
  const r = row(page, a!.id);
  await expect(r.locator('.title')).toHaveText(a!.title);
  await r.locator('button.rename').click();
  const input = r.locator('input.title-input');
  await expect(input).toBeVisible();
  await expect(r.locator('.title-edit .hint')).toContainText(`the folder stays ${a!.exportPath}/`);
  await input.fill('Weekly sync');
  await input.press('Enter');
  await expect(r.locator('.title')).toHaveText('Weekly sync');
  await page.reload();
  await readyIdle(page);
  await expect(row(page, a!.id).locator('.title')).toHaveText('Weekly sync');
  const renamed = await recording(page, a!.id);
  expect(renamed!.title).toBe('Weekly sync');
  expect(renamed!.exportPath).toBe(a!.exportPath);
  expect(renamed!.status).toBe(a!.status);
  await expect(row(page, a!.id).locator('.path')).toHaveText(`${a!.exportPath}/`);
  // Escape cancels; the other row is untouched throughout.
  await row(page, a!.id).locator('button.rename').click();
  await row(page, a!.id).locator('input.title-input').fill('discarded');
  await row(page, a!.id).locator('input.title-input').press('Escape');
  await expect(row(page, a!.id).locator('.title')).toHaveText('Weekly sync');
  expect((await recording(page, a!.id))!.title).toBe('Weekly sync');
  expect((await recording(page, b!.id))!.title).toBe(b!.title);

  // A recording in progress: its row exists at `recording`, the duration ticks, no actions.
  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
  const live = page.locator('.recording-item[data-status="recording"]');
  await expect(live).toHaveCount(1);
  await expect(live.locator('.actions')).toHaveCount(0);
  await expect(live.locator('button.rename')).toHaveCount(0);
  const t0 = await live.locator('.duration').textContent();
  await page.waitForTimeout(2200);
  const t1 = await live.locator('.duration').textContent();
  expect(t1).not.toBe(t0);
  await page.click('#stop');
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  await expect(page.locator('.recording-item[data-status="recording"]')).toHaveCount(0);
  await expect(page.locator('.recording-item')).toHaveCount(3);
  await expectStorageMatchesWalk(page);

  // Two renames back to back: the second lands on the first's result and no other field is lost.
  for (const name of ['One', 'Two']) {
    await row(page, a!.id).locator('button.rename').click();
    await row(page, a!.id).locator('input.title-input').fill(name);
    await row(page, a!.id).locator('input.title-input').press('Enter');
    await expect(row(page, a!.id).locator('.title')).toHaveText(name);
  }
  expect(await recording(page, a!.id)).toMatchObject({
    title: 'Two',
    status: a!.status,
    exportPath: a!.exportPath,
    endedAt: a!.endedAt,
    levels: a!.levels,
  });
  await page.locator('.recording-item').first().locator('button.delete').click();
  await page.screenshot({ path: 'screenshots/library.png', fullPage: true });
});

test('delete media keeps the record, the events log and the export; delete recording keeps only the export; the bulk button frees the rest', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a, b, c] = await seed(page, 3);
  for (const rec of [a!, b!, c!]) {
    expect(rec.exportPath).toBeDefined();
    expect(await opfsSize(page, ['recordings', rec.id, 'video.mp4'])).toBeGreaterThan(10_000);
    expect(await opfsSize(page, ['recordings', rec.id, 'mic.pcm'])).toBeGreaterThan(0);
    expect(await opfsSize(page, ['recordings', rec.id, 'display.pcm'])).toBeGreaterThan(0);
    expect(await opfsSize(page, ['recordings', rec.id, 'events.jsonl'])).toBe(0);
  }
  const before = await expectStorageMatchesWalk(page);
  const exported = (rec: Recording) =>
    opfsSize(page, [EXPORT_DIR, ...rec.exportPath!.split('/'), 'recording.mp4']);
  const exportedA = await exported(a!);
  expect(exportedA).toBeGreaterThan(10_000);

  // Arm, then click elsewhere: disarmed, nothing deleted.
  const ra = row(page, a!.id);
  await ra.locator('button.delete-media').click();
  await expect(ra.locator('button.delete-media')).toHaveClass(/armed/);
  await page.locator('#recordings h2').click();
  await expect(ra.locator('button.delete-media')).not.toHaveClass(/armed/);
  expect(await opfsSize(page, ['recordings', a!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  // A double-click arms but does not confirm.
  await ra.locator('button.delete').dblclick();
  await expect(ra.locator('button.delete')).toHaveClass(/armed/);
  await page.waitForTimeout(500);
  await expect(ra).toHaveCount(1);
  expect(await recording(page, a!.id)).toBeDefined();
  await page.locator('#recordings h2').click();
  await expect(ra.locator('button.delete')).not.toHaveClass(/armed/);
  // Armed, then the pipeline takes the recording: the confirm is refused, the files stay.
  await ra.locator('button.delete-media').click();
  await expect(ra.locator('button.delete-media')).toHaveClass(/armed/);
  await patchRecording(page, a!.id, { status: 'transcribing' });
  await page.waitForTimeout(400);
  await ra.locator('button.delete-media').click();
  await expect(page.locator('#library-status')).toContainText('is transcribing');
  expect(await opfsSize(page, ['recordings', a!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  expect(await opfsSize(page, ['recordings', a!.id, 'mic.pcm'])).toBeGreaterThan(0);
  expect((await recording(page, a!.id))!.mediaDeleted).toBeUndefined();
  await expect(ra).toHaveAttribute('data-status', 'transcribing');
  await expect(ra.locator('.actions')).toHaveCount(0);
  await patchRecording(page, a!.id, { status: a!.status });
  await page.reload();
  await readyIdle(page);

  // Delete media on A: a recorded row says what is lost, then goes through.
  await ra.locator('button.delete-media').click();
  await expect(ra.locator('button.delete-media')).toHaveText(/cannot be transcribed/);
  await page.waitForTimeout(400);
  await ra.locator('button.delete-media').click();
  await expect(page.locator('#library-status')).toContainText(`Deleted `);
  await expect(page.locator('#library-status')).toContainText(`${a!.exportPath}/ is untouched`);
  for (const name of ['video.mp4', 'mic.pcm', 'display.pcm'])
    expect(await opfsSize(page, ['recordings', a!.id, name]), name).toBe(-1);
  expect(await opfsSize(page, ['recordings', a!.id, 'events.jsonl'])).toBe(0);
  const aAfter = await recording(page, a!.id);
  expect(aAfter).toMatchObject({
    id: a!.id,
    status: a!.status,
    exportPath: a!.exportPath,
    mediaDeleted: true,
  });
  expect(await exported(a!)).toBe(exportedA);
  await expect(ra).toHaveAttribute('data-status', a!.status);
  await expect(ra.locator('.media-deleted')).toBeVisible();
  await expect(ra.locator('button.delete-media')).toHaveCount(0);
  await expect(ra.locator('button.rerun')).toHaveCount(0);
  await expect(ra.locator('button.delete')).toHaveCount(1);
  const afterMedia = await expectStorageMatchesWalk(page);
  expect(afterMedia).toBeLessThan(before);

  // Delete recording B.
  const exportedB = await exported(b!);
  await clickTwice(row(page, b!.id).locator('button.delete'));
  await expect(row(page, b!.id)).toHaveCount(0);
  expect(await recording(page, b!.id)).toBeUndefined();
  expect(await opfsDirExists(page, ['recordings', b!.id])).toBe(false);
  expect(await exported(b!)).toBe(exportedB);
  await expect(page.locator('.recording-item')).toHaveCount(2);
  const afterDelete = await expectStorageMatchesWalk(page);
  expect(afterDelete).toBeLessThan(afterMedia);

  // Bulk: a recorded row is never a target (its audio is what a transcript is made from); a done
  // one is.
  await expect(page.locator('#storage-actions button')).toHaveCount(0);
  await patchRecording(page, c!.id, { status: 'done' });
  await page.reload();
  await readyIdle(page);
  const bulk = page.locator('#storage-actions button.delete-exported-media');
  await expect(bulk).toBeVisible();

  // C's exported video is gone (deleted in Finder, folder moved): the row refuses, the bulk keeps
  // C and names it, and nothing local is touched.
  const cVideo = [EXPORT_DIR, ...c!.exportPath!.split('/'), 'recording.mp4'];
  await removeOpfs(page, cVideo.slice(0, -1), ['recording.mp4']);
  await clickTwice(row(page, c!.id).locator('button.delete-media'));
  await expect(page.locator('#library-status')).toContainText('Media kept');
  await expect(page.locator('#library-status')).toContainText('not in the export folder');
  expect(await opfsSize(page, ['recordings', c!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  await clickTwice(bulk);
  await expect(page.locator('#library-status')).toContainText('Nothing deleted');
  await expect(page.locator('#library-status')).toContainText(`${c!.exportPath}/`);
  expect(await opfsSize(page, ['recordings', c!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  expect(await opfsSize(page, ['recordings', c!.id, 'mic.pcm'])).toBeGreaterThan(0);
  expect((await recording(page, c!.id))!.mediaDeleted).toBeUndefined();
  // Re-export puts the video back.
  await row(page, c!.id).locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved recording.mp4 to ${c!.exportPath}/.`,
    { timeout: 15_000 },
  );
  expect(await opfsSize(page, cVideo)).toBeGreaterThan(10_000);

  // No export folder at all: the bulk refuses outright.
  await clearExportFolder(page);
  await clickTwice(bulk);
  await expect(page.locator('#library-status')).toContainText('no export folder chosen');
  expect(await opfsSize(page, ['recordings', c!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  await seedExportFolder(page);

  // Armed, then C is taken by the pipeline: the target set is re-read at confirm time and C's
  // media stays.
  await bulk.click();
  await expect(bulk).toHaveText(/Free .* from 1 exported recording\?/);
  await patchRecording(page, c!.id, { status: 'transcribing' });
  await page.waitForTimeout(400);
  await bulk.click();
  await expect(page.locator('#library-status')).toContainText('being transcribed');
  expect(await opfsSize(page, ['recordings', c!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  await patchRecording(page, c!.id, { status: 'done' });
  await page.reload();
  await readyIdle(page);
  await clickTwice(page.locator('#storage-actions button.delete-exported-media'));
  await expect(page.locator('#library-status')).toContainText('Freed ');
  await expect(page.locator('#library-status')).toContainText('1 exported recording');
  for (const name of ['video.mp4', 'mic.pcm', 'display.pcm'])
    expect(await opfsSize(page, ['recordings', c!.id, name]), name).toBe(-1);
  expect((await recording(page, c!.id))!.mediaDeleted).toBe(true);
  expect(await exported(c!)).toBeGreaterThan(10_000);
  await expect(page.locator('#storage-actions button')).toHaveCount(0);
  // Only the two empty events logs remain.
  expect(await expectStorageMatchesWalk(page)).toBe(0);
});

test('Re-export recreates a deleted file and a deleted folder at the same path, writes artifacts, and reports a missing export folder on the row', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a] = await seed(page, 1);
  const videoBytes = await opfsSize(page, ['recordings', a!.id, 'video.mp4']);
  const exportedPath = [EXPORT_DIR, ...a!.exportPath!.split('/')];
  expect(await opfsSize(page, [...exportedPath, 'recording.mp4'])).toBe(videoBytes);
  const r = row(page, a!.id);
  await expect(r.locator('button.re-export')).toBeVisible();
  await expect(r.locator('button.save-now')).toHaveCount(0);

  // The exported file is gone: Re-export writes it again, same path, same status.
  await removeOpfs(page, exportedPath, ['recording.mp4']);
  expect(await opfsSize(page, [...exportedPath, 'recording.mp4'])).toBe(-1);
  await r.locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved recording.mp4 to ${a!.exportPath}/.`,
    { timeout: 15_000 },
  );
  expect(await opfsSize(page, [...exportedPath, 'recording.mp4'])).toBe(videoBytes);
  expect(await recording(page, a!.id)).toMatchObject({
    status: a!.status,
    exportPath: a!.exportPath,
  });

  // The whole folder is gone, and an artifact has appeared in OPFS (as the pipeline will write
  // them): Re-export recreates the folder and writes the artifact next to the video.
  await removeOpfs(page, [EXPORT_DIR], [a!.exportPath!]);
  expect(await opfsDirExists(page, exportedPath)).toBe(false);
  await writeOpfsFile(page, ['recordings', a!.id, 'transcript.md'], '# Transcript\n');
  // The pipeline's per-channel cache stays local: it must not be exported.
  await writeOpfsFile(page, ['recordings', a!.id, 'segments.mic.json'], '{}');
  await page.reload();
  await readyIdle(page);
  await row(page, a!.id).locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved recording.mp4, transcript.md to ${a!.exportPath}/.`,
    { timeout: 15_000 },
  );
  expect(await opfsSize(page, [...exportedPath, 'recording.mp4'])).toBe(videoBytes);
  expect(await opfsSize(page, [...exportedPath, 'transcript.md'])).toBe('# Transcript\n'.length);
  expect(await opfsSize(page, [...exportedPath, 'segments.mic.json'])).toBe(-1);
  expect((await recording(page, a!.id))!.exportPath).toBe(a!.exportPath);

  // With the media deleted, Re-export still writes the artifact, and says so.
  await clickTwice(row(page, a!.id).locator('button.delete-media'));
  await expect(row(page, a!.id).locator('.media-deleted')).toBeVisible();
  await removeOpfs(page, exportedPath, ['transcript.md']);
  await row(page, a!.id).locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved transcript.md to ${a!.exportPath}/.`,
    { timeout: 15_000 },
  );
  expect(await opfsSize(page, [...exportedPath, 'transcript.md'])).toBeGreaterThan(0);

  // No export folder: the failure lands on the record and the row, nothing else changes.
  await clearExportFolder(page);
  await row(page, a!.id).locator('button.re-export').click();
  await expect(row(page, a!.id).locator('.hint.error')).toContainText('No export folder', {
    timeout: 15_000,
  });
  expect(await recording(page, a!.id)).toMatchObject({
    status: a!.status,
    exportPath: a!.exportPath,
    error: expect.stringMatching(/^Not exported: .*No export folder/),
  });
  // Back with a folder: the error clears.
  await seedExportFolder(page);
  await row(page, a!.id).locator('button.re-export').click();
  await expect(row(page, a!.id).locator('.hint.error')).toHaveCount(0, { timeout: 15_000 });
  expect((await recording(page, a!.id))!.error).toBeUndefined();
});

test('a failed recording shows its error and offers only Delete', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const failed: Recording = {
    id: 'seeded-failed',
    startedAt: Date.now() - 60_000,
    endedAt: Date.now() - 58_000,
    title: 'Broken one',
    sources: [{ channel: 'display', kind: 'tab', label: 'Some tab' }],
    status: 'failed',
    container: 'mp4',
    error: 'Video chunk lost: synthetic arrayBuffer failure',
  };
  await patchRecording(page, failed.id, failed as unknown as Record<string, unknown>);
  await page.reload();
  await readyIdle(page);
  const r = row(page, failed.id);
  await expect(r).toHaveAttribute('data-status', 'failed');
  await expect(r.locator('.pill')).toHaveText('failed');
  await expect(r.locator('.hint.error')).toHaveText(failed.error!);
  await expect(r.locator('.sources')).toHaveText('tab, no mic');
  await expect(r.locator('.actions button')).toHaveCount(1);
  await expect(r.locator('button.delete')).toBeVisible();
  await expect(storageText(page)).toHaveText('Local storage: 0 B');
  await page.screenshot({ path: 'screenshots/library-failed.png', fullPage: true });
  await clickTwice(r.locator('button.delete'));
  await expect(r).toHaveCount(0);
  expect(await recording(page, failed.id)).toBeUndefined();
  await expect(page.locator('#recordings-empty')).toBeVisible();

  // A failed recording whose video did reach disk (a chunk lost late in a long call): Save now
  // exports what is there; the status and the failure reason stay.
  const [v] = await seed(page, 1);
  const broken = { status: 'failed', error: 'Video chunk lost: synthetic arrayBuffer failure' };
  await patchRecording(page, v!.id, { ...broken, exportPath: undefined });
  await page.reload();
  await readyIdle(page);
  const rv = row(page, v!.id);
  await expect(rv).toHaveAttribute('data-status', 'failed');
  await expect(rv.locator('button.save-now')).toBeVisible();
  await expect(rv.locator('button.delete-media')).toBeVisible();
  await expect(rv.locator('button.rerun')).toHaveText('Transcribe');
  await rv.locator('button.save-now').click();
  await expect(page.locator('#library-status')).toHaveText(
    /^Saved recording\.mp4 to .*Screen recording.*\/\.$/,
    { timeout: 15_000 },
  );
  const saved = (await recording(page, v!.id))!;
  expect(saved.status).toBe('failed');
  expect(saved.error).toBe(broken.error);
  expect(saved.status).toBe('failed');
  expect(saved.exportPath).toBeDefined();
  expect(
    await opfsSize(page, [EXPORT_DIR, ...saved.exportPath!.split('/'), 'recording.mp4']),
  ).toBeGreaterThan(10_000);
  await expect(rv.locator('button.re-export')).toBeVisible();
  await expect(rv.locator('.hint.error')).toHaveText(broken.error);
});

test('a re-render while a title is being edited neither saves the half-typed title nor closes the input; Escape cancels', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a, b] = await seed(page, 2);
  const ra = row(page, a!.id);
  await ra.locator('button.rename').click();
  const input = ra.locator('input.title-input');
  await input.fill('half typed');
  // B goes through the pipeline meanwhile: its queued and done phases each want to rebuild the
  // list (and, unlike a click elsewhere, never move the focus).
  await page.evaluate((id) => {
    void (
      window as unknown as { rescribe: { transcribeRecording: (id: string) => Promise<unknown> } }
    ).rescribe.transcribeRecording(id);
  }, b!.id);
  await waitForRecording(page, b!.id, (r) => r.status === 'done', { label: 'deferral' });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('half typed');
  expect((await recording(page, a!.id))!.title).toBe(a!.title);
  // The rebuild waited: B's row still shows what it was.
  await expect(row(page, b!.id)).toHaveAttribute('data-status', 'recorded');
  await input.press('Escape');
  await expect(ra.locator('.title')).toHaveText(a!.title);
  expect((await recording(page, a!.id))!.title).toBe(a!.title);
  // …and the deferred rebuild ran.
  await expect(row(page, b!.id)).toHaveAttribute('data-status', 'done');
  // Enter and blur still save.
  await ra.locator('button.rename').click();
  await ra.locator('input.title-input').fill('Final name');
  await ra.locator('input.title-input').press('Enter');
  await expect(ra.locator('.title')).toHaveText('Final name');
  await ra.locator('button.rename').click();
  await ra.locator('input.title-input').fill('Blurred name');
  await page.locator('#recordings h2').click();
  await expect(ra.locator('.title')).toHaveText('Blurred name');
  expect((await recording(page, a!.id))!.title).toBe('Blurred name');
});

test('a row with an action in progress shows it and offers nothing, whatever re-render happens meanwhile', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a] = await seed(page, 1);
  // Every export write waits, so the action is long enough to watch.
  await page.addInitScript(() => {
    const orig = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (
      this: FileSystemFileHandle,
      opts?: FileSystemCreateWritableOptions,
    ) {
      await new Promise((r) => setTimeout(r, 2500));
      return orig.call(this, opts);
    };
  });
  await page.reload();
  await readyIdle(page);
  // The exported video is gone, so Re-export has to write it.
  await removeOpfs(page, [EXPORT_DIR, a!.exportPath!], ['recording.mp4']);
  const ra = row(page, a!.id);
  await ra.locator('button.re-export').click();
  await expect(ra.locator('.busy')).toHaveText('Exporting…');
  await expect(ra.locator('button')).toHaveCount(0);
  // A recording starts meanwhile: the list is rebuilt; A's row must still show the action and no
  // buttons.
  await page.click('#record-screen');
  await expect(page.locator('.recording-item[data-status="recording"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(ra.locator('.busy')).toHaveText('Exporting…');
  await expect(ra.locator('button')).toHaveCount(0);
  await expect(page.locator('#library-status')).toHaveText(
    `Saved recording.mp4 to ${a!.exportPath}/.`,
    { timeout: 30_000 },
  );
  await expect(ra.locator('.busy')).toHaveCount(0);
  await expect(ra.locator('button.re-export')).toBeVisible();
  await expect(ra.locator('button.delete')).toBeVisible();
  await page.click('#stop');
  await expect(page.locator('#record-screen')).toBeEnabled({ timeout: 30_000 });
});

test('the storage walk survives a recording directory removed from under it', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a, b] = await seed(page, 2);
  // The first listing of B's directory removes B before it lists: what a delete landing while
  // the walk holds that handle looks like (the handle then throws NotFoundError).
  await page.addInitScript((victim: string) => {
    type Entries = (
      this: FileSystemDirectoryHandle,
    ) => AsyncIterableIterator<[string, FileSystemHandle]>;
    const proto = FileSystemDirectoryHandle.prototype as unknown as { entries: Entries };
    const orig = proto.entries;
    let removed = false;
    proto.entries = async function* (this: FileSystemDirectoryHandle) {
      if (this.name === victim && !removed) {
        removed = true;
        const root = await navigator.storage.getDirectory();
        const recs = await root.getDirectoryHandle('recordings');
        await recs.removeEntry(victim, { recursive: true });
      }
      for await (const entry of orig.call(this)) yield entry;
    };
  }, b!.id);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.reload();
  // The load's render walked `recordings/` and B vanished under it: the app is still up.
  await readyIdle(page);
  expect(await opfsDirExists(page, ['recordings', b!.id])).toBe(false);
  await expect(row(page, b!.id)).toHaveCount(1); // the record is still there…
  await expect(row(page, b!.id).locator('.size')).toHaveCount(0); // …with nothing local
  await expect(row(page, a!.id).locator('.size')).toHaveCount(1);
  await expect(page.locator('#library-status')).toHaveText('');
  expect(errors).toEqual([]);
  await expectStorageMatchesWalk(page);
});

// --- With the pipeline ----------------------------------------------------------------------------

async function transcribed(page: Page, id: string): Promise<Recording> {
  const rec = await runPipeline(page, id);
  expect(rec.status, rec.error).toBe('done');
  expect(rec.error).toBeUndefined();
  expect(rec.transcribedAt).toBeDefined();
  await expect(row(page, id)).toHaveAttribute('data-status', 'done');
  return rec;
}

const ARTIFACTS = ['meta.json', 'transcript.json', 'transcript.md'];

test('Re-run transcription on a done recording: the row shows the run, ends done with a fresh transcribedAt, meta.json carries it', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a] = await seed(page, 1);
  const first = await transcribed(page, a!.id);
  const t1 = first.transcribedAt!;
  const ra = row(page, a!.id);
  await expect(ra.locator('button.rerun')).toHaveText('Re-run transcription');
  // Without the recogniser cache the re-run transcribes again, long enough to watch the row.
  await removeOpfs(page, ['recordings', a!.id], ['segments.mic.json', 'segments.display.json']);
  await ra.locator('button.rerun').click();
  await expect(ra).toHaveAttribute('data-status', 'transcribing', { timeout: 10_000 });
  await expect(ra.locator('.progress')).not.toHaveText('');
  await expect(ra.locator('button')).toHaveCount(0);
  const second = await waitForRecording(
    page,
    a!.id,
    (r) => r.status !== 'transcribing' && (r.transcribedAt ?? 0) > t1,
    { label: 'rerun' },
  );
  expect(second.status, second.error).toBe('done');
  expect(second.error).toBeUndefined();
  expect(second.exportPath).toBe(first.exportPath);
  const meta = JSON.parse(await opfsText(page, exported(second, 'meta.json'))) as {
    transcribedAt: number;
  };
  expect(meta.transcribedAt).toBe(second.transcribedAt);
  await expect(page.locator('#library-status')).toHaveText(
    `Transcript saved to ${second.exportPath}/.`,
  );
  await expect(ra).toHaveAttribute('data-status', 'done');
  await expect(ra.locator('button.rerun')).toBeVisible();
  await expect(ra.locator('button.rename')).toBeVisible();
});

test('Re-export on a done recording: the deleted folder comes back with the video and the transcript files; with the media gone the transcript files still follow the exported video', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a] = await seed(page, 1);
  const done = await transcribed(page, a!.id);
  const files = ['recording.mp4', ...ARTIFACTS];
  const before: Record<string, number> = {};
  for (const n of files) {
    before[n] = await opfsSize(page, exported(done, n));
    expect(before[n], n).toBeGreaterThan(0);
  }
  const ra = row(page, a!.id);

  // The whole folder is gone: Re-export writes the video and every artifact again, same path.
  await removeOpfs(page, [EXPORT_DIR], [done.exportPath!]);
  await ra.locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved recording.mp4, ${ARTIFACTS.join(', ')} to ${done.exportPath}/.`,
    { timeout: 30_000 },
  );
  for (const n of files) expect(await opfsSize(page, exported(done, n)), n).toBe(before[n]);
  expect(await recording(page, a!.id)).toMatchObject({
    status: 'done',
    exportPath: done.exportPath,
    transcribedAt: done.transcribedAt,
  });
  expect((await recording(page, a!.id))!.error).toBeUndefined();

  // Media deleted, transcript files deleted from the folder: they follow the exported video.
  await clickTwice(ra.locator('button.delete-media'));
  await expect(page.locator('#library-status')).toContainText('Deleted ');
  await removeOpfs(page, [EXPORT_DIR, done.exportPath!], ARTIFACTS);
  await ra.locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved ${ARTIFACTS.join(', ')} to ${done.exportPath}/.`,
    { timeout: 30_000 },
  );
  for (const n of ARTIFACTS) expect(await opfsSize(page, exported(done, n)), n).toBe(before[n]);
  // The transcript can still be rebuilt from the kept recogniser output.
  await expect(ra.locator('button.rerun')).toHaveText('Re-run transcription');

  // Without the exported video and without the local one, nothing can be rebuilt: the row says so.
  await removeOpfs(page, [EXPORT_DIR], [done.exportPath!]);
  await ra.locator('button.re-export').click();
  await expect(ra.locator('.hint.error')).toContainText(
    "the video is no longer in Rescribe's storage",
    { timeout: 15_000 },
  );
  await expect(ra).toHaveAttribute('data-status', 'done');
});

test('a recording queued or running in the pipeline keeps its media through a confirmed bulk delete and offers nothing', async ({
  context,
  extensionId,
}) => {
  const page = await setUp(context, extensionId);
  const [a, b] = await seed(page, 2);
  const da = await transcribed(page, a!.id);
  const db = await transcribed(page, b!.id);
  const bulk = page.locator('#storage-actions button.delete-exported-media');
  await bulk.click();
  await expect(bulk).toHaveText(/from 2 exported recordings\?/);
  await page.waitForTimeout(400);
  // A transcribes again for real (no cache) and B queues behind it; then the bulk is confirmed.
  await removeOpfs(page, ['recordings', a!.id], ['segments.mic.json', 'segments.display.json']);
  await page.evaluate(
    ([x, y]) => {
      const r = (
        window as unknown as { rescribe: { transcribeRecording: (id: string) => Promise<unknown> } }
      ).rescribe;
      void r.transcribeRecording(x!);
      void r.transcribeRecording(y!);
      // The confirm in the same task, before the pipeline's status write or any re-render lands:
      // the click that races the enqueue.
      document
        .querySelector<HTMLButtonElement>('#storage-actions button.delete-exported-media.armed')!
        .click();
    },
    [a!.id, b!.id],
  );
  await expect(page.locator('#library-status')).toContainText('being transcribed');
  for (const id of [a!.id, b!.id]) {
    expect(await opfsSize(page, ['recordings', id, 'video.mp4']), id).toBeGreaterThan(10_000);
    expect(await opfsSize(page, ['recordings', id, 'mic.pcm']), id).toBeGreaterThan(0);
    expect((await recording(page, id))!.mediaDeleted).toBeUndefined();
  }
  await expect(row(page, b!.id).locator('button')).toHaveCount(0);
  await expect(row(page, b!.id).locator('.progress')).not.toHaveText('');
  const a2 = await waitForRecording(
    page,
    a!.id,
    (r) => r.status === 'done' && (r.transcribedAt ?? 0) > da.transcribedAt!,
    { label: 'rerun a' },
  );
  const b2 = await waitForRecording(
    page,
    b!.id,
    (r) => r.status === 'done' && (r.transcribedAt ?? 0) > db.transcribedAt!,
    { label: 'rerun b' },
  );
  expect(a2.error).toBeUndefined();
  expect(b2.error).toBeUndefined();
  for (const id of [a!.id, b!.id])
    expect(await opfsSize(page, ['recordings', id, 'video.mp4']), id).toBeGreaterThan(10_000);
  // Done again: the bulk goes through.
  await clickTwice(page.locator('#storage-actions button.delete-exported-media'));
  await expect(page.locator('#library-status')).toContainText('Freed ');
  await expect(page.locator('#library-status')).toContainText('2 exported recordings');
  for (const id of [a!.id, b!.id]) {
    expect(await opfsSize(page, ['recordings', id, 'video.mp4']), id).toBe(-1);
    expect((await recording(page, id))!.mediaDeleted).toBe(true);
  }
  await expectStorageMatchesWalk(page);
});
