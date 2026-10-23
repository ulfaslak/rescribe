// Routines (DECISIONS § Routines): the stop dialog and the rows offer what the native host lists;
// a routine chosen at the save waits for the transcript, starts through the host once it is in
// the folder, and the row and the processing tab follow it to the end. The host is the real
// native/host.ts and supervisor, registered in the test profile (fixtures.ts `registerHost`) with
// the harness's routine e2e/fixtures/routines/e2e-echo. The export goes to OPFS, so a test that
// wants the host to find the recording writes its directory on disk (`mirror`) the way the
// export would have.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_TARGET_TITLE, expect, HOST_HOME, HOST_RECORDINGS, test } from './fixtures.ts';
import {
  clearRecordings,
  openApp,
  openTarget,
  OTHER_EXPORT_DIR,
  ready,
  recordings,
  seedExportFolder,
  serviceWorker,
  setSettings,
  startRecording,
  stopRecording,
  toolbarClick,
  waitForProgressPage,
  waitForStopDialog,
} from './helpers.ts';
import type { Recording } from '../src/lib/types.ts';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const ROUTINE = 'e2e-echo';

async function setUp(
  context: BrowserContext,
  extensionId: string,
  settings: Record<string, unknown>,
  folder?: string,
): Promise<{ page: Page; targetId: number }> {
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page, folder);
  await setSettings(page, {
    container: 'webm',
    pathTemplate: '{date} {time} {title}',
    micByDefault: true,
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

/** The recording's directory on disk, as the export would have written it under the host's folder. */
function mirror(rec: Recording): string {
  const dir = path.join(HOST_RECORDINGS, ...rec.exportPath!.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: rec.id }));
  writeFileSync(path.join(dir, 'transcript.md'), `# ${rec.title}\n`);
  return dir;
}

async function record(page: Page, id: string): Promise<Recording> {
  const rec = (await recordings(page)).find((r) => r.id === id);
  if (!rec) throw new Error(`no recording ${id}`);
  return rec;
}

/** Click a two-step button twice, past the double-click guard. */
async function confirm(page: Page, button: ReturnType<Page['locator']>): Promise<void> {
  await button.click();
  await expect(button).toHaveClass(/armed/);
  await page.waitForTimeout(400);
  await button.click();
}

test('chosen in the stop dialog: transcribed although Settings say not, started once the transcript is in the folder, followed to done in the row and the processing tab', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(context, extensionId, { autoTranscribe: false });
  const worker = await serviceWorker(context);
  await startRecording(page);
  const [live] = await recordings(page);
  await page.waitForTimeout(3000);
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  const dialog = await waitForStopDialog(context, extensionId);

  // The host's routine under Save, with its description; nothing in the way.
  const choice = dialog.locator(`button.routine[data-routine="${ROUTINE}"]`);
  await expect(choice).toBeEnabled();
  await expect(choice).toContainText('E2E echo');
  await expect(choice).toContainText('Writes down what it was given');
  await expect(dialog.locator('#routines-note')).toBeHidden();
  await expect(dialog.locator('#save')).toBeEnabled();
  await choice.click();
  const progress = await waitForProgressPage(context, extensionId);

  // Saved with the routine waiting on the record; the transcription runs (Settings say off).
  await expect
    .poll(async () => (await record(page, live!.id)).exportPath, { timeout: 30_000 })
    .toBeTruthy();
  let rec = await record(page, live!.id);
  expect(rec.routine).toMatchObject({ id: ROUTINE, label: 'E2E echo', state: 'waiting' });
  expect(['recorded', 'transcribing']).toContain(rec.status);
  const dir = mirror(rec);
  await expect(progress.locator('#detail')).toContainText('then E2E echo', { timeout: 60_000 });

  // Transcribed, then the routine runs outside the browser: the row says so, with its log.
  await expect
    .poll(async () => (await record(page, live!.id)).routine?.state, { timeout: 120_000 })
    .toBe('running');
  rec = await record(page, live!.id);
  expect(rec.status).toBe('done');
  expect(rec.error).toBeUndefined();
  await expect(row(page, rec.id).locator('.hint.routine.running')).toContainText(
    'E2E echo: running since',
  );
  await expect(row(page, rec.id).locator('.routine-log')).toHaveText(rec.routine!.log!);
  await expect(progress.locator('#headline')).toHaveText('E2E echo…');
  await expect(progress.locator('#log')).toContainText(rec.routine!.log!);

  // Done: what it said, in the record, the row and the processing tab.
  await expect
    .poll(async () => (await record(page, live!.id)).routine?.state, { timeout: 30_000 })
    .toBe('done');
  rec = await record(page, live!.id);
  expect(rec.routine!.message).toBe(`Echoed ${rec.title}`);
  await expect(row(page, rec.id).locator('.hint.routine.done')).toContainText(`E2E echo: done at`);
  await expect(row(page, rec.id).locator('.hint.routine.done')).toContainText(
    `Echoed ${rec.title}`,
  );
  await expect(progress.locator('#headline')).toHaveText('Done');
  await expect(progress.locator('#detail')).toContainText(`Echoed ${rec.title}`);
  await expect(progress.locator('#log')).toHaveText('');

  // What the routine was given: the recording's directory on disk and its title.
  const seen = readFileSync(path.join(HOST_HOME, 'runs', rec.routine!.runId!, 'seen.txt'), 'utf8');
  expect(seen).toContain(`dir=${dir}\n`);
  expect(seen).toContain(`title=${rec.title}\n`);
  expect(seen).toContain(`# ${rec.title}`);
});

test('from a transcribed row: refused by the host with its reason, offered again, and run once the files are there', async ({
  context,
  extensionId,
}) => {
  const { page } = await setUp(context, extensionId, { autoTranscribe: true });
  await startRecording(page);
  const [live] = await recordings(page);
  await page.waitForTimeout(3000);
  await stopRecording(page);
  await expect
    .poll(async () => (await record(page, live!.id)).status, { timeout: 120_000 })
    .toBe('done');
  const r = row(page, live!.id);
  const button = r.locator(`button.routine[data-routine="${ROUTINE}"]`);
  await expect(button).toBeEnabled();

  // Nothing on disk where the host looks: refused, and the row says why.
  await confirm(page, button);
  await expect(r.locator('.hint.routine.failed')).toContainText('E2E echo failed:', {
    timeout: 15_000,
  });
  await expect(r.locator('.hint.routine.failed')).toContainText('no readable meta.json');
  expect((await record(page, live!.id)).routine?.state).toBe('failed');

  // The files are there now: the same button runs it.
  mirror(await record(page, live!.id));
  await confirm(page, r.locator(`button.routine[data-routine="${ROUTINE}"]`));
  await expect(r.locator('.hint.routine.running')).toBeVisible({ timeout: 15_000 });
  await expect(r.locator(`button.routine[data-routine="${ROUTINE}"]`)).toBeDisabled();
  await expect(r.locator('.hint.routine.done')).toContainText('Echoed', { timeout: 30_000 });
  await expect(r.locator(`button.routine[data-routine="${ROUTINE}"]`)).toBeEnabled();
});

test('a Settings folder the host does not read: the routines are there but disabled, with the reason; Save still saves', async ({
  context,
  extensionId,
}) => {
  const { page, targetId } = await setUp(
    context,
    extensionId,
    { autoTranscribe: false },
    OTHER_EXPORT_DIR,
  );
  const worker = await serviceWorker(context);
  await startRecording(page);
  const [live] = await recordings(page);
  await toolbarClick(worker, { id: targetId, url: MEET_URL });
  const dialog = await waitForStopDialog(context, extensionId);
  await expect(dialog.locator('#save')).toBeEnabled();
  await expect(dialog.locator(`button.routine[data-routine="${ROUTINE}"]`)).toBeDisabled();
  await expect(dialog.locator('#routines-note')).toBeVisible();
  await expect(dialog.locator('#routines-note')).toContainText(`Routines read ${HOST_RECORDINGS}`);
  await expect(dialog.locator('#routines-note')).toContainText(`"${OTHER_EXPORT_DIR}"`);
  await dialog.locator('#save').click();
  await expect
    .poll(async () => (await record(page, live!.id)).status, { timeout: 30_000 })
    .toBe('recorded');
  const rec = await record(page, live!.id);
  expect(rec.routine).toBeUndefined();
});
