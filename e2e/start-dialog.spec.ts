// The start dialog (src/start/) and the processing tab (src/progress/): a toolbar click while
// nothing records opens the dialog for the clicked tab with its microphones and the folder;
// the choices persist; a save in the stop dialog hands over to the processing tab, which follows
// the export and the transcription to the end, can be closed, and says so when the app tab that
// does the work is closed. The toolbar click is driven through the service worker's `onToggle`
// hook (helpers.toolbarClick); the dialog is the popup window's page in the same context.
import type { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect, test } from './fixtures.ts';
import {
  clearRecordings,
  escape,
  EXPORT_DIR,
  exported,
  getSettings,
  openApp,
  openTarget,
  opfsSize,
  OTHER_EXPORT_DIR,
  progressPages,
  progressUrl,
  ready,
  recordings,
  seedExportFolder,
  serviceWorker,
  setSettings,
  dialogClosed,
  dialogTab,
  isOverlay,
  startDialogWindows,
  startDialogUrl,
  startRecording,
  toolbarClick,
  waitForProgressPage,
  waitForRecording,
  waitForStartDialog,
  waitForStopDialog,
  windowOfTab,
} from './helpers.ts';
import type { Recording } from '../src/lib/types.ts';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const settled = (r: Recording) => r.status === 'done' || r.status === 'failed';

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
    micDeviceId: undefined,
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

test('the dialog shows the clicked tab, the microphones and the folder; the microphone choice and a changed folder persist and reach the app tab; a page that cannot host the overlay gets the window, where Change… picks; the button on another tab moves the dialog there', async ({
  context,
  extensionId,
}) => {
  // The picker cannot be driven: in the window it answers with another OPFS directory.
  await context.addInitScript((other) => {
    if (!location.pathname.endsWith('/start/start.html')) return;
    window.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle(other, { create: true });
  }, OTHER_EXPORT_DIR);
  const { page, targetId } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  await toolbarClick(worker, { id: targetId, url: MEET_URL, title: 'Meet' });
  const dialog = await waitForStartDialog(context, extensionId);
  expect(isOverlay(dialog)).toBe(true);
  expect(dialogTab(dialog)).toBe(targetId);
  await expect(dialog.locator('#target-title')).toHaveText(CAPTURE_TARGET_TITLE);
  await expect(dialog.locator('#folder')).toHaveText(EXPORT_DIR);
  await expect(dialog.locator('#start')).toBeEnabled();
  await expect(dialog.locator('#background')).toBeHidden();

  // The microphones, as the app tab lists them: the fake devices (by label once the origin holds
  // the permission, which the first recording grants; the default device before), and "No
  // microphone".
  const mic = dialog.locator('#mic');
  await expect(mic).toBeEnabled();
  const options = await mic.locator('option').allTextContents();
  expect(options.at(-1)).toBe('No microphone');
  expect(options.length).toBeGreaterThanOrEqual(2);
  await expect(mic).not.toHaveValue('none');
  // "No microphone" is a setting; the app tab's checkbox and form follow it.
  await mic.selectOption('none');
  await expect.poll(() => getSettings(page).then((s) => s['micByDefault'])).toBe(false);
  await expect(page.locator('#mic')).not.toBeChecked();
  await expect(page.locator('input[name=micByDefault]')).not.toBeChecked();
  // A device: on again, with its id when it is a labelled device; the id is the app tab's own.
  const first = (await mic.locator('option').first().getAttribute('value'))!;
  await mic.selectOption(first);
  await expect.poll(() => getSettings(page).then((s) => s['micByDefault'])).toBe(true);
  expect((await getSettings(page))['micDeviceId']).toBe(first || undefined);
  await expect(page.locator('#mic')).toBeChecked();
  const appIds = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.label)
      .map((d) => d.deviceId),
  );
  if (first) expect(appIds).toContain(first);
  await escape(dialog);

  // A page that cannot host the overlay (the browser's own): the window, where Change… picks the
  // Settings folder, shown in the window and in the app tab at once.
  const other = await context.newPage();
  await other.goto('chrome://version');
  const otherId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url?.startsWith('chrome://version'))!.id!,
  );
  await toolbarClick(worker, { id: otherId, url: 'chrome://version/' });
  const windowed = await waitForStartDialog(context, extensionId);
  expect(isOverlay(windowed)).toBe(false);
  expect(dialogTab(windowed)).toBe(otherId);
  await windowed.click('#change-folder');
  await expect(windowed.locator('#folder')).toHaveText(OTHER_EXPORT_DIR);
  await expect(page.locator('#folder-name')).toHaveText(OTHER_EXPORT_DIR);
  await escape(windowed);
  // The next dialog opens on the changed folder and the chosen microphone.
  await toolbarClick(worker, { id: targetId, url: MEET_URL, title: 'Meet' });
  const again = await waitForStartDialog(context, extensionId);
  await expect(again.locator('#folder')).toHaveText(OTHER_EXPORT_DIR);
  await expect(again.locator('#mic')).toHaveValue(first);

  // The button on another tab moves the dialog there instead of merely closing it; and Escape in
  // a window that sits as a tab in the browser window ("Show as tab") closes only that tab.
  await toolbarClick(worker, { id: otherId, url: 'chrome://version/' });
  await expect.poll(() => dialogClosed(again), { timeout: 5000 }).toBe(true);
  const moved = await waitForStartDialog(context, extensionId);
  expect(dialogTab(moved)).toBe(otherId);
  const browserWindow = await windowOfTab(worker, targetId);
  await worker.evaluate(
    async ({ url, windowId }) => {
      const t = (await chrome.tabs.query({})).find((t) => t.url === url)!;
      await chrome.tabs.move(t.id!, { windowId, index: -1 });
    },
    { url: moved.url(), windowId: browserWindow },
  );
  const count = () =>
    worker.evaluate(async (w) => (await chrome.tabs.query({ windowId: w })).length, browserWindow);
  const before = await count();
  await escape(moved);
  expect(await count()).toBe(before - 1);
  await expect(page.locator('#status')).toHaveText('idle');
  await other.close();
  expect(await recordings(page)).toHaveLength(0);
});

test('a save in the stop dialog opens the processing tab, which follows the export and the transcription to done; closing it stops nothing; with the app tab closed it says paused and Open Rescribe resumes', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId, { autoTranscribe: true });
  const worker = await serviceWorker(context);
  await startRecording(page);
  await page.waitForTimeout(3000);
  const [live] = await recordings(page);
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  const dialog = await waitForStopDialog(context, extensionId);
  await dialog.click('#save');
  const progress = await waitForProgressPage(context, extensionId);
  expect(progress.url()).toBe(`${progressUrl(extensionId)}?id=${live!.id}`);
  await expect.poll(() => dialog.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(progress.locator('#title')).toHaveText('Screen recording');
  // The export, then the pipeline (the first run downloads the model), each step a headline in
  // the human's words (issue #31: e2e/progress.spec.ts walks the steps themselves).
  await expect(progress.locator('#headline')).toHaveText(
    /Saving the video|Saved|Waiting to transcribe|Downloading the speech model|Loading the speech model|Transcribing (your|.+’s) microphone|Transcribing the call|Working out who said what|Writing the transcript files/,
    { timeout: 30_000 },
  );
  await expect(progress.locator('#destination')).toContainText(`${EXPORT_DIR}/`, {
    timeout: 30_000,
  });
  await expect(progress.locator('body')).toHaveAttribute('data-kind', 'busy');
  // Closing the processing tab stops nothing.
  await progress.close();
  let rec = await waitForRecording(page, live!.id, settled, { label: 'progress' });
  expect(rec.status, rec.error).toBe('done');
  expect(await opfsSize(page, exported(rec, 'transcript.md'))).toBeGreaterThan(0);
  expect(progressPages(context, extensionId)).toHaveLength(0);

  // A second, longer recording (the model is cached now, so a short one would be done before
  // the tab could close); this time the app tab closes mid-transcription: the page says paused,
  // Open Rescribe brings the app tab back, and the transcription runs to done.
  await startRecording(page);
  await page.waitForTimeout(15_000);
  const [second] = await recordings(page);
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  await (await waitForStopDialog(context, extensionId)).click('#save');
  const again = await waitForProgressPage(context, extensionId);
  expect(again.url()).toBe(`${progressUrl(extensionId)}?id=${second!.id}`);
  await expect(again.locator('#headline')).toHaveText(
    /Waiting to transcribe|Downloading the speech model|Loading the speech model|Transcribing (your|.+’s) microphone|Transcribing the call|Working out who said what|Writing the transcript files/,
    { timeout: 60_000 },
  );
  const appUrl = `chrome-extension://${extensionId}/app/app.html`;
  const nextApp = context.waitForEvent('page', {
    predicate: (p) => p.url() === appUrl,
    timeout: 15_000,
  });
  await page.close({ runBeforeUnload: false });
  await expect
    .poll(() => worker.evaluate(async (url) => (await chrome.tabs.query({ url })).length, appUrl), {
      timeout: 5000,
    })
    .toBe(0);
  await expect(again.locator('#headline')).toHaveText('Paused', { timeout: 10_000 });
  await expect(again.locator('body')).toHaveAttribute('data-kind', 'paused');
  await again.click('#open-app');
  const app = await nextApp;
  await ready(app);
  rec = await waitForRecording(app, second!.id, settled, { label: 'resumed' });
  expect(rec.status, rec.error).toBe('done');
  expect(rec.note).toContain('interrupted');
  await expect(again.locator('#headline')).toHaveText('Done', { timeout: 10_000 });
  await expect(again.locator('#destination')).toHaveText(`${EXPORT_DIR}/${rec.exportPath}/`);
  await expect(again.locator('body')).toHaveAttribute('data-kind', 'done');
  await again.close();
});

test('the dialog for a tab that closed meanwhile offers nothing; a discarded recording shows as gone in its processing tab', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  // The target closes under the open dialog: Start is refused there, not after the fact. Only a
  // window outlives its tab (an overlay goes with it), so the target is a page that gets one.
  const browserPage = await context.newPage();
  await browserPage.goto('chrome://version');
  const browserTab = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url?.startsWith('chrome://version'))!.id!,
  );
  await toolbarClick(worker, { id: browserTab, url: 'chrome://version/' });
  const dialog = await waitForStartDialog(context, extensionId);
  expect(isOverlay(dialog)).toBe(false);
  await worker.evaluate((id) => chrome.tabs.remove(id), browserTab);
  await dialog.click('#start');
  await expect(dialog.locator('#status')).toContainText('closed', { timeout: 10_000 });
  await escape(dialog);

  // A processing tab for a recording that is then discarded says so and stops polling.
  await openTarget(context);
  await startRecording(page);
  await page.waitForTimeout(1500);
  const [live] = await recordings(page);
  const newTarget = await worker.evaluate(
    async (title) => (await chrome.tabs.query({ title }))[0]!.id!,
    CAPTURE_TARGET_TITLE,
  );
  await toolbarClick(worker, { id: newTarget, url: MEET_URL });
  const stop = await waitForStopDialog(context, extensionId);
  await stop.click('#save');
  const progress = await waitForProgressPage(context, extensionId);
  await expect(progress.locator('#headline')).toHaveText('Saved', { timeout: 30_000 });
  const del = page.locator(`.recording-item[data-id="${live!.id}"] button.delete`);
  await del.click();
  await page.waitForTimeout(400);
  await del.click();
  await expect(progress.locator('#headline')).toHaveText('Gone', { timeout: 10_000 });
  await progress.close();
});

test('on a web page the dialog is an overlay at the top right of that page, no window and no backdrop; the button toggles it, Escape closes it, Change… brings the Rescribe tab forward, and a Start after it closed is cancelled', async ({
  context,
  extensionId,
}) => {
  const { page } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  // A web page with a strict CSP (no frames of its own, no scripts): the overlay still shows.
  const SITE = 'https://rescribe.test/call';
  await context.route('https://rescribe.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: { 'content-security-policy': "default-src 'none'; frame-src 'none'" },
      body: '<!doctype html><title>A web page</title><style>body{margin:0;height:3000px;background:#abc}</style><h1>page</h1>',
    }),
  );
  const site = await context.newPage();
  await site.setViewportSize({ width: 1200, height: 800 });
  await site.goto(SITE);
  const siteId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0]!.id!,
    SITE,
  );
  const overlayFrame = () =>
    site.frames().find((f) => f.url().startsWith(startDialogUrl(extensionId)));
  const hostBox = () =>
    site.evaluate(() => {
      const el = document.getElementById('rescribe-start-overlay');
      if (!el) return undefined;
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, width: r.width, height: r.height };
    });

  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(() => !!overlayFrame(), { timeout: 10_000 }).toBe(true);
  const frame = overlayFrame()!;
  expect(dialogTab(frame)).toBe(siteId);
  await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
  await expect(frame.locator('#target-title')).toHaveText('A web page');
  await expect(frame.locator('#target-host')).toHaveText('rescribe.test');
  await expect(frame.locator('#folder')).toHaveText(EXPORT_DIR);
  await expect(frame.locator('#start')).toBeEnabled();
  expect((await frame.locator('#mic option').allTextContents()).at(-1)).toBe('No microphone');
  // No window of its own, and nothing over the rest of the page: a box at the top right, as tall
  // as the dialog.
  expect(startDialogWindows(context, extensionId)).toHaveLength(0);
  const box = (await hostBox())!;
  expect(box.top).toBe(12);
  expect(box.right).toBe(1200 - 12);
  expect(box.width).toBeLessThan(400);
  const mainHeight = await frame.evaluate(
    () => document.querySelector('main')!.getBoundingClientRect().height,
  );
  await expect.poll(async () => Math.abs((await hostBox())!.height - mainHeight)).toBeLessThan(2);
  await expect(site.locator('h1')).toBeVisible();
  await site.screenshot({ path: 'screenshots/start-overlay.png' });

  // The button again closes it; once more opens it; Escape closes it.
  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(hostBox).toBeUndefined();
  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(() => !!overlayFrame(), { timeout: 10_000 }).toBe(true);
  await expect(overlayFrame()!.locator('body')).toHaveAttribute('data-ready', 'true');
  await overlayFrame()!.locator('#start').focus();
  await site.keyboard.press('Escape');
  await expect.poll(hostBox).toBeUndefined();

  // In fullscreen only the fullscreen element shows: the overlay goes in there.
  await site.evaluate(() => document.body.requestFullscreen());
  await expect.poll(() => site.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(() => !!overlayFrame(), { timeout: 10_000 }).toBe(true);
  expect(
    await site.evaluate(
      () => document.getElementById('rescribe-start-overlay')?.parentElement?.tagName,
    ),
  ).toBe('BODY');
  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(hostBox).toBeUndefined();
  await site.evaluate(() => document.exitFullscreen());

  // Change…: the picker is refused to a frame in another site's page; the Rescribe tab comes
  // forward instead, and the overlay stays.
  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(() => !!overlayFrame(), { timeout: 10_000 }).toBe(true);
  const again = overlayFrame()!;
  await expect(again.locator('body')).toHaveAttribute('data-ready', 'true');
  await again.click('#change-folder');
  await expect(again.locator('#status')).toContainText('Rescribe tab');
  const appUrl = `chrome-extension://${extensionId}/app/app.html`;
  await expect
    .poll(() =>
      worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.active, appUrl),
    )
    .toBe(true);
  expect(await hostBox()).toBeDefined();

  // Start from the overlay reaches the capture (which a faked click cannot grant: the refusal
  // shows in the overlay, not "Cancelled"); with the overlay closed, a Start is cancelled.
  await again.click('#start');
  await expect(again.locator('#status')).toContainText("Couldn't capture", { timeout: 15_000 });
  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(hostBox).toBeUndefined();
  const res = await worker.evaluate(
    (tabId) =>
      (
        globalThis as unknown as {
          rescribe: { startCapture: (m: object) => Promise<{ ok: boolean; error?: string }> };
        }
      ).rescribe.startCapture({ type: 'start-capture', tabId, mic: false }),
    siteId,
  );
  expect(res.error).toContain('Cancelled');
  await expect(page.locator('#status')).toHaveText('idle');

  // A site that frames the dialog page itself (it is web-accessible, for the overlay) gets a blank
  // one without the key: it asks nothing of the app tab, starts nothing, and does not count as an
  // open dialog, so the toolbar still opens the real one on that tab.
  const EVIL = 'https://evil.test/';
  await context.route('https://evil.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Evil</title><iframe src="${startDialogUrl(extensionId)}?tab=${siteId}&k=guess"></iframe>`,
    }),
  );
  const evil = await context.newPage();
  await evil.goto(EVIL);
  const planted = () => evil.frames().find((f) => f.url().startsWith(startDialogUrl(extensionId)));
  await expect.poll(() => !!planted()).toBe(true);
  await expect(planted()!.locator('main')).toHaveText('Click the Rescribe button again.');
  const guessed = await worker.evaluate(
    (tabId) =>
      (
        globalThis as unknown as {
          rescribe: { startCapture: (m: object) => Promise<{ ok: boolean; error?: string }> };
        }
      ).rescribe.startCapture({ type: 'start-capture', tabId, key: 'guess', mic: false }),
    siteId,
  );
  expect(guessed.error).toContain('Cancelled');
  await toolbarClick(worker, { id: siteId, url: SITE, title: 'A web page' });
  await expect.poll(() => !!overlayFrame(), { timeout: 10_000 }).toBe(true);
  await expect(overlayFrame()!.locator('body')).toHaveAttribute('data-ready', 'true');
  await escape(overlayFrame()!);
  expect(await recordings(page)).toHaveLength(0);
  await evil.close();
  await site.close();
});
