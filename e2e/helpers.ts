// Shared helpers for specs that drive the app page: open it, seed the export "folder" (an OPFS
// directory handle, see ENVIRONMENT_NOTES), record, and read records and OPFS files back.
// record.spec.ts predates this file and carries its own copies of the first half.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect } from './fixtures.ts';
import type { Recording } from '../src/lib/types.ts';

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

export async function setSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (patch) => {
    const cur = ((await chrome.storage.local.get('settings'))['settings'] ?? {}) as object;
    await chrome.storage.local.set({ settings: { ...cur, ...patch } });
  }, patch);
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
