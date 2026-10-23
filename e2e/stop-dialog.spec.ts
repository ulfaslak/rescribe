// The stop dialog (src/stop/): a toolbar click while recording opens it; Save, the routines
// (routines.spec.ts covers them) and Discard; closing it keeps recording; a share that ends leaves the recording `stopped` and opens
// it; a Meet call that ends opens it while the recording goes on; a save hands over to the
// processing tab (src/progress/). The toolbar click is driven through the service worker's
// `onToggle` hook (helpers.toolbarClick); the dialog is the popup window's page in the same
// context. Asserts on IndexedDB, OPFS and the pages' elements.
import type { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect, test } from './fixtures.ts';
import {
  badgeText,
  clearRecordings,
  endDisplayTrack,
  escape,
  EXPORT_DIR,
  exported,
  openApp,
  openTarget,
  opfsList,
  opfsSize,
  progressUrl,
  ready,
  recordings,
  seedExportFolder,
  serviceWorker,
  setSettings,
  startRecording,
  stopDialogs,
  tabPlacement,
  toolbarClick,
  waitForProgressPage,
  waitForRecording,
  waitForStartDialog,
  waitForStopDialog,
  windowOfTab,
} from './helpers.ts';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';

async function setUp(
  context: BrowserContext,
  extensionId: string,
  settings: Record<string, unknown> = {},
): Promise<{ page: Page; targetId: number }> {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, {
    container: 'mp4',
    pathTemplate: '{date} {time} {title}',
    micByDefault: true,
    autoTranscribe: false,
    ...settings,
  });
  await page.reload();
  await ready(page);
  await expect(page.locator('#status')).toHaveText('idle');
  const worker = await serviceWorker(context);
  const targetId = await worker.evaluate(
    async (title) => (await chrome.tabs.query({ title }))[0]!.id!,
    CAPTURE_TARGET_TITLE,
  );
  return { page, targetId };
}

const row = (page: Page, id: string) => page.locator(`.recording-item[data-id="${id}"]`);

test('a click while recording opens the dialog; Escape keeps recording; a second click focuses the same one; Save stops, exports, hands over to the processing tab and leaves the app tab alone', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  await startRecording(page);
  const appTabId = await page.evaluate(async () => (await chrome.tabs.getCurrent())!.id!);
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), targetId);

  await toolbarClick(worker, { id: targetId, url: MEET_URL, title: 'Meet' });
  const dialog = await waitForStopDialog(context, extensionId);
  await expect(dialog.locator('#state')).toHaveText('recording');
  await expect(dialog.locator('#title')).toHaveText('Screen recording');
  await expect(dialog.locator('#where')).toContainText(`Into ${EXPORT_DIR}/`);
  await expect(dialog.locator('#where')).toContainText('Screen recording/');
  await expect(dialog.locator('#save')).toBeEnabled();
  await expect(dialog.locator('#footer')).toContainText('keeps recording');
  // The app tab stayed in the background; the recording goes on.
  expect(await worker.evaluate(async (id) => (await chrome.tabs.get(id)).active, appTabId)).toBe(
    false,
  );
  await expect(page.locator('#status')).toHaveText('recording');
  expect(await badgeText(page)).toBe('REC');

  // Escape: closed, still recording.
  await escape(dialog);
  await page.waitForTimeout(500);
  await expect(page.locator('#status')).toHaveText('recording');
  const [live] = await recordings(page);
  expect(live!.status).toBe('recording');

  // A second click, then a third: one dialog, focused, not two.
  await toolbarClick(worker, { id: targetId, url: 'https://www.youtube.com/watch?v=x' });
  const again = await waitForStopDialog(context, extensionId);
  await expect(again.locator('#state')).toHaveText('recording');
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  await page.waitForTimeout(700);
  expect(stopDialogs(context, extensionId)).toHaveLength(1);
  expect(again.isClosed()).toBe(false);
  // The elapsed time ticks while it is open.
  const t1 = await again.locator('#elapsed').textContent();
  await page.waitForTimeout(1500);
  expect(await again.locator('#elapsed').textContent()).not.toBe(t1);

  // Save: the recording stops; the processing tab replaces the dialog, in front in the browser
  // window (not the dialog's), and shows the outcome (transcription is off here); the video
  // lands in the Settings folder; the app tab is idle and still in the background.
  await again.click('#save');
  const progress = await waitForProgressPage(context, extensionId);
  expect(progress.url()).toBe(`${progressUrl(extensionId)}?id=${live!.id}`);
  await expect.poll(() => again.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(progress.locator('#title')).toHaveText('Screen recording');
  await expect(progress.locator('#headline')).toHaveText('Saved', { timeout: 30_000 });
  await expect(progress.locator('#detail')).toContainText('Transcription is off');
  await expect(progress.locator('#destination')).toContainText(`${EXPORT_DIR}/`);
  await expect(progress.locator('#destination')).toContainText('Screen recording/');
  expect(await tabPlacement(worker, progress.url())).toEqual({
    active: true,
    windowId: await windowOfTab(worker, appTabId),
  });
  await expect(page.locator('#status')).toHaveText('idle');
  const [rec] = await recordings(page);
  expect(rec!.id).toBe(live!.id);
  expect(rec!.status).toBe('recorded');
  expect(rec!.error).toBeUndefined();
  expect(rec!.exportRoot).toBeUndefined();
  expect(await opfsSize(page, exported(rec!, 'recording.mp4'))).toBeGreaterThan(10_000);
  expect(await badgeText(page)).toBe('');
  expect(await worker.evaluate(async (id) => (await chrome.tabs.get(id)).active, appTabId)).toBe(
    false,
  );
  await expect(page.locator('#record-status')).toContainText('Saved to ');
  // Closing the processing tab stops nothing and the dialog does not come back.
  await progress.close();
  await page.waitForTimeout(500);
  expect(stopDialogs(context, extensionId)).toHaveLength(0);
});

test('Discard is a two-step; confirmed, the recording is gone from Rescribe and nothing reached the folder', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  const before = await opfsList(page, [EXPORT_DIR]);
  await startRecording(page);
  const [live] = await recordings(page);
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  const dialog = await waitForStopDialog(context, extensionId);
  await expect(dialog.locator('#discard')).toBeEnabled();
  // One click arms; a double-click arms but does not confirm; the recording goes on.
  await dialog.locator('#discard').dblclick();
  await expect(dialog.locator('#discard')).toHaveClass(/armed/);
  await expect(page.locator('#status')).toHaveText('recording');
  expect(dialog.isClosed()).toBe(false);
  // The confirm, past the double-click guard.
  await page.waitForTimeout(400);
  await dialog.locator('#discard').click();
  await expect(dialog.locator('#status')).toContainText('Discarded', { timeout: 30_000 });
  await expect.poll(() => dialog.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(page.locator('#status')).toHaveText('idle');
  expect((await recordings(page)).find((r) => r.id === live!.id)).toBeUndefined();
  expect(await opfsList(page, ['recordings', live!.id])).toEqual([]);
  expect(await opfsList(page, [EXPORT_DIR])).toEqual(before);
  expect(await badgeText(page)).toBe('');
  await expect(page.locator('#record-status')).toContainText('Discarded');
  await expect(row(page, live!.id)).toHaveCount(0);
});

test("the share ends: the recording waits stopped with the badge on SAVE and the dialog open; closing it leaves the row's choices and survives a reload; a click reopens it; Save from the row exports and transcribes nothing until then", async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId, { autoTranscribe: true });
  const worker = await serviceWorker(context);
  await startRecording(page);
  await page.waitForTimeout(2000);
  const [live] = await recordings(page);
  await endDisplayTrack(page);
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 30_000 });
  const dialog = await waitForStopDialog(context, extensionId);
  await expect(dialog.locator('#state')).toHaveText('ended');
  await expect(dialog.locator('#footer')).toContainText('waiting');
  expect(await badgeText(page)).toBe('SAVE');
  let rec = (await recordings(page)).find((r) => r.id === live!.id)!;
  expect(rec.status).toBe('stopped');
  expect(rec.exportPath).toBeUndefined();
  expect(rec.endedAt).toBeDefined();
  // Nothing exported, nothing transcribed while it waits; a new recording is not blocked by it.
  expect(await opfsList(page, [EXPORT_DIR])).toEqual([]);
  await expect(page.locator('#record-status')).toContainText('not saved yet');
  await expect(page.locator('#record-screen')).toBeEnabled();

  // Escape: still stopped, the row offers the dialog's choices, the note stays.
  await escape(dialog);
  await expect(page.locator('#status')).toHaveText('stopped');
  const r = row(page, rec.id);
  await expect(r).toHaveAttribute('data-status', 'stopped');
  await expect(r.locator('button.save')).toBeVisible();
  await expect(r.locator('button.save-routine[data-routine="e2e-echo"]')).toBeVisible();
  await expect(r.locator('button.discard')).toBeVisible();
  await expect(r.locator('button.re-export, button.save-now, button.rerun')).toHaveCount(0);

  // A reload: still waiting.
  await page.reload();
  await ready(page);
  await expect(page.locator('#status')).toHaveText('stopped');
  expect(await badgeText(page)).toBe('SAVE');
  rec = (await recordings(page)).find((r) => r.id === live!.id)!;
  expect(rec.status).toBe('stopped');
  await expect(page.locator('#record-status')).toContainText('not saved yet');

  // A toolbar click on the app tab itself while stopped opens the dialog again (`ended`, the
  // elapsed time frozen); on any other tab it starts a new recording (below), never the dialog.
  const appTabId = await page.evaluate(async () => (await chrome.tabs.getCurrent())!.id!);
  await toolbarClick(worker, { id: appTabId, url: page.url() });
  const again = await waitForStopDialog(context, extensionId);
  await expect(again.locator('#state')).toHaveText('ended');
  await expect(again.locator('#elapsed')).toHaveText(/^0:0[1-4]$/);
  await expect(page.locator('#status')).toHaveText('stopped');
  expect((await recordings(page)).length).toBe(1);
  await escape(again);

  // Save from the row: exported, then transcribed (auto-transcribe is on).
  await row(page, rec.id).locator('button.save').click();
  await expect
    .poll(async () => (await recordings(page)).find((x) => x.id === rec.id)?.exportPath, {
      timeout: 30_000,
    })
    .toBeDefined();
  await expect(page.locator('#status')).toHaveText(/idle|transcribing/);
  expect(await badgeText(page)).not.toBe('SAVE');
  rec = await waitForRecording(page, rec.id, (x) => x.status === 'done' || x.status === 'failed', {
    label: 'row-save',
  });
  expect(rec.status, rec.error).toBe('done');
  expect(await opfsSize(page, exported(rec, 'recording.mp4'))).toBeGreaterThan(10_000);
  expect(await opfsSize(page, exported(rec, 'transcript.md'))).toBeGreaterThan(0);
  await expect(page.locator('#status')).toHaveText('idle');
  expect(await badgeText(page)).toBe('');
});

test('a Meet call that ends opens the dialog while the recording goes on: from any tab on the picker path, never without a tab, never after the recording', async ({
  context,
  extensionId,
}) => {
  const { page } = await setUp(context, extensionId);
  // A duplicate app tab stands in for a content-script sender: it carries a tab id. The service
  // worker stands in for anything that is not a tab.
  const meetTab = await context.newPage();
  await meetTab.goto(`chrome-extension://${extensionId}/app/app.html`);
  await expect(meetTab.locator('#duplicate')).toBeVisible();
  const worker = await serviceWorker(context);
  const send = (m: object) => chrome.runtime.sendMessage(m).catch(() => undefined);
  const ended = () => ({ type: 'call-ended', platform: 'meet', at: Date.now() });
  await startRecording(page);
  await worker.evaluate(send, ended());
  await page.waitForTimeout(1500);
  expect(stopDialogs(context, extensionId)).toHaveLength(0);
  // The picker path cannot tell which tab the shared window shows: any tab's call-ended counts,
  // contributed events or not (the toolbar path takes only the recorded tab's; no harness for it).
  await meetTab.evaluate(send, ended());
  const dialog = await waitForStopDialog(context, extensionId);
  await expect(dialog.locator('#state')).toHaveText('recording');
  await expect(page.locator('#status')).toHaveText('recording');
  await escape(dialog);
  await expect(page.locator('#status')).toHaveText('recording');
  // After the recording, nothing.
  await page.click('#stop');
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 30_000 });
  await meetTab.evaluate(send, ended());
  await page.waitForTimeout(1000);
  expect(stopDialogs(context, extensionId)).toHaveLength(0);
  const [rec] = await recordings(page);
  expect(rec!.status).toBe('recorded');
});

test('a recording waiting stopped never blocks a new one: a toolbar click opens the start dialog (which says what waits; Start fails visibly there) and not the stop dialog, Record screen… records, and the waiting one is pending again afterwards', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  await startRecording(page);
  await page.waitForTimeout(1500);
  const [waiting] = await recordings(page);
  await endDisplayTrack(page);
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 30_000 });
  await escape(await waitForStopDialog(context, extensionId));

  // The app tab closed with the recording waiting (no warning for that: the beforeunload handler
  // does not cancel), then a click in a call: the start dialog opens, the app tab comes back
  // already knowing what waits (the dialog says so), Start goes ahead (and fails here, the
  // harness has no stream id), no stop dialog opens, and the waiting one is still waiting.
  const warns = () =>
    page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await warns()).toBe(false);
  // Closed as a tab (Playwright's page.close leaves the tab behind now and then, seen
  // 2026-09-25), and gone before the click: a click in the same instant would meet a dying tab,
  // which no human manages.
  const appUrl = `chrome-extension://${extensionId}/app/app.html`;
  const closingId = await page.evaluate(async () => (await chrome.tabs.getCurrent())!.id!);
  await worker.evaluate((id) => chrome.tabs.remove(id), closingId);
  await expect.poll(() => page.isClosed(), { timeout: 5000 }).toBe(true);
  await expect
    .poll(() => worker.evaluate(async (url) => (await chrome.tabs.query({ url })).length, appUrl), {
      timeout: 5000,
    })
    .toBe(0);
  const nextApp = context.waitForEvent('page', {
    predicate: (p) => p.url() === appUrl,
    timeout: 15_000,
  });
  await toolbarClick(worker, { id: targetId, url: MEET_URL, title: 'Meet' });
  const dialog = await waitForStartDialog(context, extensionId);
  const app = await nextApp;
  await ready(app);
  await expect(dialog.locator('#background-text')).toContainText('is not saved yet', {
    timeout: 15_000,
  });
  await dialog.click('#start');
  await expect(dialog.locator('#status')).toContainText("Couldn't capture that tab", {
    timeout: 15_000,
  });
  expect(stopDialogs(context, extensionId)).toHaveLength(0);
  await escape(dialog);
  await expect(app.locator('#status')).toHaveText('stopped');
  expect(await badgeText(app)).toBe('SAVE');
  const r = row(app, waiting!.id);
  await expect(r).toHaveAttribute('data-status', 'stopped');
  await expect(r.locator('button.save')).toBeVisible();

  // Record screen… works while it waits; Stop saves the new one; the old one is pending again.
  await expect(app.locator('#record-screen')).toBeEnabled();
  await startRecording(app);
  expect(await badgeText(app)).toBe('REC');
  await app.click('#stop');
  await expect(app.locator('#record-screen')).toBeEnabled({ timeout: 30_000 });
  const recs = await recordings(app);
  expect(recs).toHaveLength(2);
  expect(recs.find((x) => x.id === waiting!.id)!.status).toBe('stopped');
  expect(recs.find((x) => x.id !== waiting!.id)!.status).toBe('recorded');
  await expect(app.locator('#status')).toHaveText('stopped');
  expect(await badgeText(app)).toBe('SAVE');
  await expect(app.locator('#record-status')).toContainText('not saved yet');
});

test('the share ends while the dialog is open: the same dialog turns to ended, none other opens', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  await startRecording(page);
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  const dialog = await waitForStopDialog(context, extensionId);
  await expect(dialog.locator('#state')).toHaveText('recording');
  await endDisplayTrack(page);
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 30_000 });
  await expect(dialog.locator('#state')).toHaveText('ended', { timeout: 5000 });
  await page.waitForTimeout(2500);
  expect(dialog.isClosed()).toBe(false);
  expect(stopDialogs(context, extensionId)).toHaveLength(1);
  await expect(dialog.locator('#footer')).toContainText('waiting');
  await dialog.click('#save');
  const progress = await waitForProgressPage(context, extensionId);
  await expect.poll(() => dialog.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(progress.locator('#headline')).toHaveText('Saved', { timeout: 30_000 });
  const [rec] = await recordings(page);
  expect(rec!.status).toBe('recorded');
  expect(rec!.exportPath).toBeDefined();
  await progress.close();
});
