// Shared helpers for specs that drive the app page: open it, seed the export "folder" (an OPFS
// directory handle, see ENVIRONMENT_NOTES), record, and read records and OPFS files back.
// record.spec.ts predates this file and carries its own copies of the first half.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Frame, Page, Worker } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect } from './fixtures.ts';
import { SETTINGS_VERSION, type Recording } from '../src/lib/types.ts';

/** The export "folder": a directory in OPFS, a real FileSystemDirectoryHandle. */
export const EXPORT_DIR = 'export-test';
/** A second one, for "the human chose another folder". */
export const OTHER_EXPORT_DIR = 'export-other';
const FIXTURE_TEXT = 'e2e/fixtures/speech.txt';

export async function openTarget(context: BrowserContext): Promise<Page> {
  const target = await context.newPage();
  await target.goto('file://' + path.resolve('e2e/fixtures/capture-target.html'));
  await expect(target).toHaveTitle(CAPTURE_TARGET_TITLE);
  return target;
}

export async function ready(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'owner', { timeout: 15_000 });
}

export async function openApp(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  // Keep every display stream reachable from the test, to end its track mid-recording
  // (`endDisplayTrack`): Chrome fires `ended` when the source goes away; stop() alone does not.
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
  await ready(page);
  return page;
}

function idbHandles(page: Page, op: 'put' | 'delete', dirName = EXPORT_DIR): Promise<void> {
  return page.evaluate(
    async ({ op, dirName }) => {
      const root = await navigator.storage.getDirectory();
      const dir = op === 'put' ? await root.getDirectoryHandle(dirName, { create: true }) : null;
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('rescribe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('handles', 'readwrite');
          const store = tx.objectStore('handles');
          if (dir) store.put(dir, 'export');
          else store.delete('export');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { op, dirName },
  );
}

export const seedExportFolder = (page: Page, dirName = EXPORT_DIR): Promise<void> =>
  idbHandles(page, 'put', dirName);
export const clearExportFolder = (page: Page): Promise<void> => idbHandles(page, 'delete');

/** Write settings as the form would: stamped with the current version, unless the patch says otherwise. */
export async function setSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    async ({ patch, version }) => {
      const cur = ((await chrome.storage.local.get('settings'))['settings'] ?? {}) as object;
      await chrome.storage.local.set({ settings: { settingsVersion: version, ...cur, ...patch } });
    },
    { patch, version: SETTINGS_VERSION },
  );
}

export async function getSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    async () =>
      ((await chrome.storage.local.get('settings'))['settings'] ?? {}) as Record<string, unknown>,
  );
}

export async function clearRecordings(page: Page): Promise<void> {
  await page.evaluate(
    async (dirNames) => {
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
      for (const name of ['recordings', ...dirNames]) {
        await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      }
    },
    [EXPORT_DIR, OTHER_EXPORT_DIR],
  );
}

/** Merge `patch` into the stored record, as the app's updateRecording does (no app code runs). */
export async function patchRecording(
  page: Page,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ id, patch }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('rescribe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('recordings', 'readwrite');
          const store = tx.objectStore('recordings');
          const get = store.get(id);
          get.onsuccess = () => {
            const next = { ...(get.result as Record<string, unknown>), ...patch };
            for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
            store.put(next, id);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { id, patch },
  );
}

/** Remove OPFS entries (files or directories) under `dir`; missing ones are ignored. */
export async function removeOpfs(page: Page, dir: string[], names: string[]): Promise<void> {
  await page.evaluate(
    async ({ dir, names }) => {
      let d = await navigator.storage.getDirectory();
      for (const s of dir) d = await d.getDirectoryHandle(s);
      for (const n of names) await d.removeEntry(n, { recursive: true }).catch(() => undefined);
    },
    { dir, names },
  );
}

/** The app's pipeline on one recording, through the DevTools hook; resolves with the record. */
export async function rerun(page: Page, id: string): Promise<Recording> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          rescribe: { transcribeRecording: (id: string) => Promise<Recording> };
        }
      ).rescribe.transcribeRecording(id),
    id,
  );
}

/** What the row shows: its status attribute and whether it offers Save now. */
export function rowState(
  page: Page,
  id: string,
): Promise<{ status: string | null; save: boolean }> {
  return page.evaluate((id) => {
    const li = document.querySelector(`.recording-item[data-id="${id}"]`);
    return {
      status: li?.getAttribute('data-status') ?? null,
      save: !!li?.querySelector('button.save-now'),
    };
  }, id);
}

export async function recordings(page: Page): Promise<Recording[]> {
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
export async function opfsSize(page: Page, segments: string[]): Promise<number> {
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

/** An OPFS text file. Throws when it does not exist. */
export async function opfsText(page: Page, segments: string[]): Promise<string> {
  return page.evaluate(async (segments) => {
    let dir = await navigator.storage.getDirectory();
    for (const s of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    return (await (await dir.getFileHandle(segments[segments.length - 1]!)).getFile()).text();
  }, segments);
}

/** Entry names in an OPFS directory, sorted; [] when it does not exist. */
export async function opfsList(page: Page, segments: string[]): Promise<string[]> {
  return page.evaluate(async (segments) => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const s of segments) dir = await dir.getDirectoryHandle(s);
    } catch {
      return [];
    }
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    return names.sort();
  }, segments);
}

/** The path of an exported file inside the seeded folder. */
export function exported(rec: Recording, name: string): string[] {
  return [EXPORT_DIR, ...rec.exportPath!.split('/'), name];
}

export async function badgeText(page: Page): Promise<string> {
  return page.evaluate(() => chrome.action.getBadgeText({}));
}

/** Click Record screen… and wait for the recording to run. */
export async function startRecording(page: Page): Promise<void> {
  await page.click('#record-screen');
  await expect(page.locator('#status')).toHaveText('recording', { timeout: 15_000 });
}

/**
 * Click Stop and wait for the recorder to be done (the Record button is enabled again). The pill
 * may already show `transcribing` by then. Returns the wall clock at the click.
 */
export async function stopRecording(page: Page): Promise<number> {
  const clickedAt = Date.now();
  await page.click('#stop');
  await expect(page.locator('#record-screen')).toBeEnabled({ timeout: 30_000 });
  return clickedAt;
}

/**
 * Poll the stored record until `until` holds, logging the Record section's status line as it
 * changes (model download, regions). The first run downloads the model, hence the long default.
 */
export async function waitForRecording(
  page: Page,
  id: string,
  until: (rec: Recording) => boolean,
  opts: { timeoutMs?: number; everyMs?: number; label?: string } = {},
): Promise<Recording> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const everyMs = opts.everyMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastLine = '';
  while (Date.now() < deadline) {
    const rec = (await recordings(page)).find((r) => r.id === id);
    if (rec && until(rec)) return rec;
    const line = (await page.locator('#record-status').textContent()) ?? '';
    if (line !== lastLine) {
      console.log(`[${opts.label ?? 'wait'}] ${rec?.status ?? '?'} · ${line}`);
      lastLine = line;
    }
    await page.waitForTimeout(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for recording ${id}`);
}

/** Share of the fixture's words that appear in `text` (case-insensitive). */
export function wordHitRate(text: string): number {
  const got = text.toLowerCase();
  const words =
    readFileSync(FIXTURE_TEXT, 'utf8')
      .toLowerCase()
      .match(/[a-z']+/g) ?? [];
  return words.filter((w) => got.includes(w)).length / words.length;
}

/** End the current recording's display track as Chrome's "Stop sharing" bar or a closed tab would. */
export async function endDisplayTrack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __displayStreams: MediaStream[] };
    for (const t of w.__displayStreams.at(-1)!.getVideoTracks()) {
      t.stop();
      t.dispatchEvent(new Event('ended'));
    }
  });
}

// --- The service worker, the dialog windows and the processing tab ---------------------------
export async function serviceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

export const stopDialogUrl = (extensionId: string): string =>
  `chrome-extension://${extensionId}/stop/stop.html`;
export const startDialogUrl = (extensionId: string): string =>
  `chrome-extension://${extensionId}/start/start.html`;
export const progressUrl = (extensionId: string): string =>
  `chrome-extension://${extensionId}/progress/progress.html`;

/** The pages open right now under `url` (a dialog window's page, a processing tab), query aside. */
export function pagesAt(context: BrowserContext, url: string): Page[] {
  return context.pages().filter((p) => p.url().startsWith(url));
}
export const stopDialogs = (context: BrowserContext, extensionId: string): Page[] =>
  pagesAt(context, stopDialogUrl(extensionId));
/** The start dialogs open right now: overlays' frames in pages, and fallback windows' pages. */
export const startDialogs = (context: BrowserContext, extensionId: string): Frame[] =>
  context
    .pages()
    .flatMap((p) => p.frames())
    .filter((f) => !f.isDetached() && f.url().startsWith(startDialogUrl(extensionId)));
/** The fallback windows among them (a page of their own). */
export const startDialogWindows = (context: BrowserContext, extensionId: string): Page[] =>
  pagesAt(context, startDialogUrl(extensionId));
/** Whether a start dialog is the overlay in a page rather than a window of its own. */
export const isOverlay = (dialog: Frame): boolean => dialog.parentFrame() !== null;
/** The tab a start dialog is for (its URL also carries the one-time key). */
export const dialogTab = (dialog: Frame): number =>
  Number(new URL(dialog.url()).searchParams.get('tab'));
export const progressPages = (context: BrowserContext, extensionId: string): Page[] =>
  pagesAt(context, progressUrl(extensionId));

/** The next page to open under `url`, or one already open, loaded. */
export async function waitForPageAt(
  context: BrowserContext,
  url: string,
  timeout = 10_000,
): Promise<Page> {
  const open = pagesAt(context, url)[0];
  if (open) return open;
  const page = await context.waitForEvent('page', {
    predicate: (p) => p.url().startsWith(url),
    timeout,
  });
  await page.waitForLoadState();
  return page;
}

/** The next stop dialog to open, or one already open. */
export const waitForStopDialog = (
  context: BrowserContext,
  extensionId: string,
  timeout?: number,
): Promise<Page> => waitForPageAt(context, stopDialogUrl(extensionId), timeout);

/**
 * The next start dialog to open, or one already open, with its target, microphones and folder
 * shown: the overlay's frame in a page, or the fallback window's main frame.
 */
export async function waitForStartDialog(
  context: BrowserContext,
  extensionId: string,
  timeout = 10_000,
): Promise<Frame> {
  let dialog: Frame | undefined;
  await expect
    .poll(() => (dialog = startDialogs(context, extensionId)[0]) !== undefined, { timeout })
    .toBe(true);
  if (!isOverlay(dialog!)) await dialog!.page().waitForLoadState();
  await expect(dialog!.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
  return dialog!;
}

/** The next processing tab to open, or one already open. */
export const waitForProgressPage = (
  context: BrowserContext,
  extensionId: string,
  timeout?: number,
): Promise<Page> => waitForPageAt(context, progressUrl(extensionId), timeout);

/** Where a tab sits: its window and whether it is the active one there. */
export function tabPlacement(
  worker: Worker,
  url: string,
): Promise<{ active: boolean; windowId: number } | undefined> {
  return worker.evaluate(async (url) => {
    const t = (await chrome.tabs.query({})).find((t) => t.url === url);
    return t ? { active: t.active, windowId: t.windowId } : undefined;
  }, url);
}

export function windowOfTab(worker: Worker, tabId: number): Promise<number> {
  return worker.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, tabId);
}

/**
 * Escape in a dialog closes its window (or takes the overlay out of its page) from the keydown,
 * so the press itself can report a closed target; that it closed is what the caller asserts
 * afterwards.
 */
export async function escape(dialog: Page | Frame): Promise<void> {
  if ('keyboard' in dialog) {
    await dialog.keyboard.press('Escape').catch(() => undefined);
    await expect.poll(() => dialog.isClosed(), { timeout: 5000 }).toBe(true);
    return;
  }
  if (!isOverlay(dialog)) return escape(dialog.page());
  await dialog
    .locator('body')
    .press('Escape')
    .catch(() => undefined);
  await expect.poll(() => dialog.isDetached(), { timeout: 5000 }).toBe(true);
}

/**
 * The toolbar click, through the service worker's hook, with a Tab-shaped object. It opens the
 * start dialog (or the stop dialog while recording); a Start from that dialog then fails, since
 * without a real click `getMediaStreamId` refuses the target. The routing (which dialog, where
 * the app tab lands) is what this exercises.
 */
export async function toolbarClick(
  worker: Worker,
  tab: { id: number; url: string; title?: string },
): Promise<void> {
  await worker.evaluate(
    (tab) =>
      (
        globalThis as unknown as { rescribe: { onToggle: (t: object) => Promise<void> } }
      ).rescribe.onToggle(tab),
    tab,
  );
}

/** Whether a start dialog is gone: the overlay out of its page, or the window closed. */
export const dialogClosed = (dialog: Frame): boolean =>
  isOverlay(dialog) ? dialog.isDetached() : dialog.page().isClosed();
