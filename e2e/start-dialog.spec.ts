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
  startDialogUrl,
  startRecording,
  toolbarClick,
  waitForProgressPage,
  waitForRecording,
  waitForStartDialog,
  waitForStopDialog,
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

test('the dialog shows the clicked tab, the microphones and the folder; the microphone choice and a changed folder persist and reach the app tab; the folder change survives Escape', async ({
  context,
  extensionId,
}) => {
  // The picker cannot be driven: in the dialog it answers with another OPFS directory.
  await context.addInitScript((other) => {
    if (!location.pathname.endsWith('/start/start.html')) return;
    window.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle(other, { create: true });
  }, OTHER_EXPORT_DIR);
  const { page, targetId } = await setUp(context, extensionId);
  const worker = await serviceWorker(context);
  await toolbarClick(worker, { id: targetId, url: MEET_URL, title: 'Meet' });
  const dialog = await waitForStartDialog(context, extensionId);
  expect(dialog.url()).toBe(`${startDialogUrl(extensionId)}?tab=${targetId}`);
  await expect(dialog.locator('#target-title')).toHaveText(CAPTURE_TARGET_TITLE);
  await expect(dialog.locator('#folder')).toHaveText(EXPORT_DIR);
  await expect(dialog.locator('#start')).toBeEnabled();
  await expect(dialog.locator('#background')).toBeHidden();

  // The microphones: the fake devices (by label once the origin holds the permission, which the
  // first recording grants; the default device before), and "No microphone".
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
  // A device: on again, with its id when it is a labelled device.
  const first = (await mic.locator('option').first().getAttribute('value'))!;
  await mic.selectOption(first);
  await expect.poll(() => getSettings(page).then((s) => s['micByDefault'])).toBe(true);
  expect((await getSettings(page))['micDeviceId']).toBe(first || undefined);
  await expect(page.locator('#mic')).toBeChecked();

  // Change…: the Settings folder, shown in the dialog and in the app tab at once.
  await dialog.click('#change-folder');
  await expect(dialog.locator('#folder')).toHaveText(OTHER_EXPORT_DIR);
  await expect(page.locator('#folder-name')).toHaveText(OTHER_EXPORT_DIR);
  await escape(dialog);
  // The next dialog opens on the changed folder and the chosen microphone.
  await toolbarClick(worker, { id: targetId, url: MEET_URL, title: 'Meet' });
  const again = await waitForStartDialog(context, extensionId);
  await expect(again.locator('#folder')).toHaveText(OTHER_EXPORT_DIR);
  await expect(again.locator('#mic')).toHaveValue(first);
  await escape(again);
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
  // The export, then the pipeline (the first run downloads the model), each phase a headline.
  await expect(progress.locator('#headline')).toHaveText(
    /Saving the video|Saved|Waiting to transcribe|Downloading|Loading|Transcribing/,
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

  // A second recording; this time the app tab closes mid-transcription: the page says paused,
  // Open Rescribe brings the app tab back, and the transcription runs to done.
  await startRecording(page);
  await page.waitForTimeout(3000);
  const [second] = await recordings(page);
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  await (await waitForStopDialog(context, extensionId)).click('#save');
  const again = await waitForProgressPage(context, extensionId);
  expect(again.url()).toBe(`${progressUrl(extensionId)}?id=${second!.id}`);
  await expect(again.locator('#headline')).toHaveText(
    /Waiting to transcribe|Downloading|Loading|Transcribing|Attributing/,
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
  // The target closes under the open dialog: Start is refused there, not after the fact.
  await toolbarClick(worker, { id: targetId, url: MEET_URL, title: 'Meet' });
  const dialog = await waitForStartDialog(context, extensionId);
  await worker.evaluate((id) => chrome.tabs.remove(id), targetId);
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
