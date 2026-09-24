// The recording library (#4): recordings seeded through the picker path, then the actions that
// work from what is on disk. Asserts on IndexedDB and OPFS (the export "folder" is an OPFS
// directory, as in record.spec.ts), and on the row's data attributes and buttons, not on prose.
import path from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect, test } from './fixtures.ts';
import type { Recording } from '../src/lib/types.ts';
import { formatBytes } from '../src/app/library.ts';

const EXPORT_DIR = 'export-test';
/** Statuses a recording can rest at; the pipeline (#2), once it runs after stop, passes through `transcribing`. */
const SETTLED = new Set(['recorded', 'done', 'failed']);

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
  await ready(page);
  return page;
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('idle');
}

function idbWrite(page: Page, store: string, fn: string, args: unknown[]): Promise<void> {
  return page.evaluate(
    ({ store, fn, args }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('rescribe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction(store, 'readwrite');
          const os = tx.objectStore(store) as unknown as Record<
            string,
            (...a: unknown[]) => IDBRequest
          >;
          os[fn]!(...args);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { store, fn, args },
  );
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
  await idbWrite(page, 'recordings', 'clear', []);
  await page.evaluate(async (dirName) => {
    const root = await navigator.storage.getDirectory();
    for (const name of ['recordings', dirName])
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
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

async function recording(page: Page, id: string): Promise<Recording | undefined> {
  return (await recordings(page)).find((r) => r.id === id);
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

async function opfsRemove(page: Page, segments: string[]): Promise<void> {
  await page.evaluate(async (segments) => {
    let dir = await navigator.storage.getDirectory();
    for (const s of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    await dir.removeEntry(segments[segments.length - 1]!, { recursive: true });
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
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  const fresh = (await recordings(page)).find((r) => !before.has(r.id));
  expect(fresh).toBeDefined();
  return settled(page, fresh!.id);
}

/** The record once it rests at `recorded`, `done` or `failed` (the pipeline may run in between). */
async function settled(page: Page, id: string): Promise<Recording> {
  let rec: Recording | undefined;
  await expect
    .poll(
      async () => {
        rec = await recording(page, id);
        return rec?.status;
      },
      { timeout: 5 * 60_000, message: `recording ${id} settles` },
    )
    .toMatch(new RegExp(`^(${[...SETTLED].join('|')})$`));
  return rec!;
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
    ...settings,
  });
  await page.reload();
  await ready(page);
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

async function setStatus(page: Page, rec: Recording, status: Recording['status']): Promise<void> {
  await idbWrite(page, 'recordings', 'put', [{ ...rec, status }, rec.id]);
}

const storageText = (page: Page): Locator => page.locator('#storage-usage');

async function expectStorageMatchesWalk(page: Page): Promise<number> {
  const bytes = await opfsRecordingsBytes(page);
  await expect(storageText(page)).toHaveText(`Local storage: ${formatBytes(bytes)}`);
  return bytes;
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
  await ready(page);
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
  const t0 = await live.locator('.duration').textContent();
  await page.waitForTimeout(2200);
  const t1 = await live.locator('.duration').textContent();
  expect(t1).not.toBe(t0);
  await page.click('#stop');
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  await expect(page.locator('.recording-item[data-status="recording"]')).toHaveCount(0);
  await expect(page.locator('.recording-item')).toHaveCount(3);
  await expectStorageMatchesWalk(page);
  await page.locator('.recording-item').first().locator('button.delete').click();
  await page.screenshot({ path: 'screenshots/library.png', fullPage: true });
});

async function opfsRecordingsBytesOf(page: Page, id: string): Promise<number> {
  let total = 0;
  for (const name of ['video.mp4', 'video.webm', 'mic.pcm', 'display.pcm', 'events.jsonl']) {
    const s = await opfsSize(page, ['recordings', id, name]);
    if (s > 0) total += s;
  }
  return total;
}

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
  await setStatus(page, a!, 'transcribing');
  await page.waitForTimeout(400);
  await ra.locator('button.delete-media').click();
  await expect(page.locator('#library-status')).toContainText('is transcribing');
  expect(await opfsSize(page, ['recordings', a!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  expect(await opfsSize(page, ['recordings', a!.id, 'mic.pcm'])).toBeGreaterThan(0);
  expect((await recording(page, a!.id))!.mediaDeleted).toBeUndefined();
  await expect(ra).toHaveAttribute('data-status', 'transcribing');
  await expect(ra.locator('.actions')).toHaveCount(0);
  await setStatus(page, a!, a!.status);
  await page.reload();
  await ready(page);

  // Delete media on A.
  await clickTwice(ra.locator('button.delete-media'));
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

  // Bulk: only C still has media and is exported. Armed, then C is taken by the pipeline: the
  // target set is re-read at confirm time and C's media stays.
  const bulk = page.locator('#storage-actions button.delete-exported-media');
  await expect(bulk).toBeVisible();
  await bulk.click();
  await expect(bulk).toHaveText(/Free .* from 1 exported recording\?/);
  await setStatus(page, c!, 'transcribing');
  await page.waitForTimeout(400);
  await bulk.click();
  await expect(page.locator('#library-status')).toContainText('Nothing to delete');
  expect(await opfsSize(page, ['recordings', c!.id, 'video.mp4'])).toBeGreaterThan(10_000);
  await setStatus(page, c!, c!.status);
  await page.reload();
  await ready(page);
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
  await opfsRemove(page, [...exportedPath, 'recording.mp4']);
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
  await opfsRemove(page, exportedPath);
  expect(await opfsDirExists(page, exportedPath)).toBe(false);
  await writeOpfsFile(page, ['recordings', a!.id, 'transcript.md'], '# Transcript\n');
  await page.reload();
  await ready(page);
  await row(page, a!.id).locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved recording.mp4, transcript.md to ${a!.exportPath}/.`,
    { timeout: 15_000 },
  );
  expect(await opfsSize(page, [...exportedPath, 'recording.mp4'])).toBe(videoBytes);
  expect(await opfsSize(page, [...exportedPath, 'transcript.md'])).toBe('# Transcript\n'.length);
  expect((await recording(page, a!.id))!.exportPath).toBe(a!.exportPath);

  // With the media deleted, Re-export still writes the artifact, and says so.
  await clickTwice(row(page, a!.id).locator('button.delete-media'));
  await expect(row(page, a!.id).locator('.media-deleted')).toBeVisible();
  await opfsRemove(page, [...exportedPath, 'transcript.md']);
  await row(page, a!.id).locator('button.re-export').click();
  await expect(page.locator('#library-status')).toHaveText(
    `Saved transcript.md to ${a!.exportPath}/.`,
    { timeout: 15_000 },
  );
  expect(await opfsSize(page, [...exportedPath, 'transcript.md'])).toBeGreaterThan(0);

  // No export folder: the failure lands on the record and the row, nothing else changes.
  await idbWrite(page, 'handles', 'delete', ['export']);
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
  await idbWrite(page, 'recordings', 'put', [failed, failed.id]);
  await page.reload();
  await ready(page);
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
});
