// Workflows (DECISIONS § Workflows): the stop dialog and the rows offer what the native host lists;
// a workflow chosen at the save waits for the transcript, starts through the host once it is in
// the folder, and the row and the processing tab follow it to the end; the Workflows section makes,
// edits and deletes them. The host is the real native/host.ts and supervisor, registered in the
// test profile (fixtures.ts `registerHost`) with the harness's runner e2e/fixtures/runners/e2e-echo,
// of which it makes the workflow "E2E echo" on its first run. The export goes to OPFS, so a test
// that wants the host to find the recording writes its directory on disk (`mirror`) the way the
// export would have.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import {
  CAPTURE_TARGET_TITLE,
  expect,
  HOST_HOME,
  HOST_NOTES,
  HOST_RECORDINGS,
  test,
} from './fixtures.ts';
import {
  clearRecordings,
  endDisplayTrack,
  openApp,
  patchRecording,
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
  await dialog.screenshot({ path: 'screenshots/routines-stop-dialog.png' });
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
  await progress.screenshot({ path: 'screenshots/routines-progress-running.png' });
  await row(page, rec.id).screenshot({ path: 'screenshots/routines-row-running.png' });

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
  await progress.screenshot({ path: 'screenshots/routines-progress-done.png' });
  await row(page, rec.id).screenshot({ path: 'screenshots/routines-row-done.png' });

  // What the run was given: the recording's directory on disk and its title, the workflow's name
  // and folder, and its prompt (the runner's own, as the workflow was made) filled in.
  const seen = readFileSync(path.join(HOST_HOME, 'runs', rec.routine!.runId!, 'seen.txt'), 'utf8');
  expect(seen).toContain(`dir=${dir}\n`);
  expect(seen).toContain(`title=${rec.title}\n`);
  expect(seen).toContain('workflow=E2E echo\n');
  expect(seen).toContain(`folder=${realpathSync(HOST_NOTES)}\n`);
  expect(seen).toContain(`# ${rec.title}`);
  expect(seen).toContain(`prompt:\nEcho "${rec.title}" from ${realpathSync(HOST_NOTES)}.\n`);
});

/** Run workflow… on a row: the picker, the workflow chosen, Run. */
async function runFromRow(row: ReturnType<Page['locator']>, workflow: string): Promise<void> {
  await row.locator('button.run-workflow').click();
  await row.locator('select.workflow-select').selectOption(workflow);
  await row.locator('.workflow-picker button.run').click();
}

test('from a transcribed row: Run workflow… opens a picker; refused by the host with its reason, offered again, and run once the files are there', async ({
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
  const open = r.locator('button.run-workflow');
  await expect(open).toBeEnabled();
  // The picker: the workflows on offer, the chosen one's line; Cancel puts the button back.
  await open.click();
  await expect(r.locator('select.workflow-select option')).toHaveText(['E2E echo']);
  await expect(r.locator('.workflow-line')).toHaveText('Writes down what it was given');
  await r.screenshot({ path: 'screenshots/workflows-row-picker.png' });
  await r.locator('.workflow-picker button.cancel').click();
  await expect(r.locator('.workflow-picker')).toHaveCount(0);
  await expect(open).toBeEnabled();

  // Nothing on disk where the host looks: refused, and the row says why.
  await runFromRow(r, ROUTINE);
  await expect(r.locator('.hint.routine.failed')).toContainText('E2E echo failed:', {
    timeout: 15_000,
  });
  await expect(r.locator('.hint.routine.failed')).toContainText('does not exist: is');
  await expect(r.locator('.workflow-badge.failed')).toHaveText('E2E echo');
  await r.screenshot({ path: 'screenshots/routines-row-failed.png' });
  expect((await record(page, live!.id)).routine?.state).toBe('failed');

  // The files are there now: the same picker runs it, and offers nothing while it runs.
  mirror(await record(page, live!.id));
  await runFromRow(r, ROUTINE);
  await expect(r.locator('.hint.routine.running')).toBeVisible({ timeout: 15_000 });
  await expect(r.locator('button.run-workflow')).toBeDisabled();
  await expect(r.locator('.hint.routine.done')).toContainText('Echoed', { timeout: 30_000 });
  await expect(r.locator('button.run-workflow')).toBeEnabled();
  await expect(r.locator('.workflow-badge.done')).toHaveText('E2E echo');
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
  await expect(dialog.locator('#routines-note')).toContainText(`Workflows read ${HOST_RECORDINGS}`);
  await expect(dialog.locator('#routines-note')).toContainText(`"${OTHER_EXPORT_DIR}"`);
  await dialog.screenshot({ path: 'screenshots/routines-stop-dialog-blocked.png' });
  await dialog.locator('#save').click();
  await expect
    .poll(async () => (await record(page, live!.id)).status, { timeout: 30_000 })
    .toBe('recorded');
  const rec = await record(page, live!.id);
  expect(rec.routine).toBeUndefined();
});

test('a plain Save drops a routine left on the record by a save that did not finish', async ({
  context,
  extensionId,
}) => {
  const { page } = await setUp(context, extensionId, { autoTranscribe: false });
  await startRecording(page);
  const [live] = await recordings(page);
  await page.waitForTimeout(2000);
  await endDisplayTrack(page);
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 30_000 });
  // As when the app tab died exporting a save with Index in Lawcel: still stopped, the routine on it.
  await patchRecording(page, live!.id, {
    routine: { id: ROUTINE, label: 'E2E echo', state: 'waiting', at: Date.now() },
  });
  await page.reload();
  await ready(page);
  await row(page, live!.id).locator('button.save').click();
  await expect
    .poll(async () => (await record(page, live!.id)).status, { timeout: 30_000 })
    .toBe('recorded');
  const rec = await record(page, live!.id);
  expect(rec.routine).toBeUndefined();
  // Not transcribed either: auto-transcription is off and no routine asks for it.
  await page.waitForTimeout(1500);
  expect((await record(page, live!.id)).status).toBe('recorded');
});

/** The workflow's files as the host keeps them. */
function stored(id: string): { json: Record<string, unknown>; prompt: string } | undefined {
  const dir = path.join(HOST_HOME, 'workflows', id);
  if (!existsSync(dir)) return undefined;
  return {
    json: JSON.parse(readFileSync(path.join(dir, 'workflow.json'), 'utf8')) as Record<
      string,
      unknown
    >,
    prompt: readFileSync(path.join(dir, 'prompt.md'), 'utf8'),
  };
}

test('the Workflows section: made with a variable put in at the cursor, a folder outside home refused, edited, run from a row with its prompt filled in, and deleted', async ({
  context,
  extensionId,
}) => {
  const { page } = await setUp(context, extensionId, { autoTranscribe: true });
  const section = page.locator('#workflows');
  const items = section.locator('.workflow-item');
  // The one the host made on its first run.
  await expect(items).toHaveCount(1);
  await expect(items.first().locator('.title')).toHaveText('E2E echo');
  await expect(items.first().locator('.runner')).toHaveText('runs with E2E echo');
  await expect(items.first().locator('.path')).toHaveText('~/notes');

  // New: the runner's prompt and folder to start from; a variable goes in at the cursor.
  await section.locator('#new-workflow').click();
  const form = section.locator('form.workflow-editor');
  await expect(form.locator('textarea[name="prompt"]')).toHaveValue(
    'Echo "{{title}}" from {{folder}}.\n',
  );
  await expect(form.locator('input[name="folder"]')).toHaveValue('~/notes');
  await expect(section.locator('#new-workflow')).toBeDisabled();
  await form.locator('input[name="label"]').fill('Call notes');
  await form.locator('input[name="description"]').fill('Notes into ~/notes');
  const prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill('Notes for  on .');
  await prompt.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(10, 10));
  await form.locator('button.variable[data-variable="title"]').click();
  await prompt.evaluate((t: HTMLTextAreaElement) =>
    t.setSelectionRange(t.value.length - 1, t.value.length - 1),
  );
  await form.locator('button.variable[data-variable="date"]').click();
  await expect(prompt).toHaveValue('Notes for {{title}} on {{date}}.');
  await expect(form.locator('details.wrap')).toHaveCount(0); // the echo runner adds nothing around it
  await page.screenshot({ path: 'screenshots/workflows-editor.png', fullPage: true });

  // A folder a call could do harm from is refused by the host, and nothing is saved.
  await form.locator('input[name="folder"]').fill(HOST_HOME);
  await form.locator('button.save').click();
  await expect(form.locator('.form-status.error')).toContainText('must be inside your home folder');
  expect(stored('call-notes')).toBeUndefined();

  await form.locator('input[name="folder"]').fill('~/notes');
  await form.locator('button.save').click();
  await expect(section.locator('#workflows-status')).toHaveText('Saved "Call notes".');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1).locator('.title')).toHaveText('Call notes');
  expect(stored('call-notes')).toMatchObject({
    json: {
      label: 'Call notes',
      description: 'Notes into ~/notes',
      runner: ROUTINE,
      folder: realpathSync(HOST_NOTES),
    },
    prompt: 'Notes for {{title}} on {{date}}.',
  });

  // Edited: the same id, the new prompt on disk; Cancel asks before it throws changes away.
  await items.nth(1).locator('button.edit').click();
  await form.locator('textarea[name="prompt"]').fill('Changed, then thrown away.');
  await form.locator('button.cancel').click();
  await expect(form.locator('button.cancel')).toHaveText('Discard changes?');
  await form.locator('button.cancel').click();
  await expect(form).toHaveCount(0);
  expect(stored('call-notes')!.prompt).toBe('Notes for {{title}} on {{date}}.');
  await items.nth(1).locator('button.edit').click();
  await form.locator('textarea[name="prompt"]').fill('Notes for "{{title}}", by {{workflow}}.');
  await form.locator('button.save').click();
  await expect(section.locator('#workflows-status')).toHaveText('Saved "Call notes".');
  expect(stored('call-notes')!.prompt).toBe('Notes for "{{title}}", by {{workflow}}.');
  await section.screenshot({ path: 'screenshots/workflows-section.png' });

  // Offered on a transcribed row at once, and run with its prompt filled in.
  await startRecording(page);
  const [live] = await recordings(page);
  await page.waitForTimeout(2000);
  await stopRecording(page);
  await expect
    .poll(async () => (await record(page, live!.id)).status, { timeout: 120_000 })
    .toBe('done');
  const r = row(page, live!.id);
  await r.locator('button.run-workflow').click();
  await expect(r.locator('select.workflow-select option')).toHaveText(['E2E echo', 'Call notes']);
  await r.locator('.workflow-picker button.cancel').click();
  const rec = await record(page, live!.id);
  mirror(rec);
  await runFromRow(r, 'call-notes');
  await expect(r.locator('.hint.routine.done')).toContainText('Call notes: done at', {
    timeout: 30_000,
  });
  const ran = await record(page, live!.id);
  const seen = readFileSync(path.join(HOST_HOME, 'runs', ran.routine!.runId!, 'seen.txt'), 'utf8');
  expect(seen).toContain('workflow=Call notes\n');
  expect(seen).toContain(`prompt:\nNotes for "${rec.title}", by Call notes.\n`);
  // The picker opens on the one last run.
  await r.locator('button.run-workflow').click();
  await expect(r.locator('select.workflow-select')).toHaveValue('call-notes');
  await r.locator('.workflow-picker button.cancel').click();

  // Deleted: a two-step, into the host's trash, and no longer offered.
  await confirm(page, items.nth(1).locator('button.delete'));
  await expect(items).toHaveCount(1);
  await expect(section.locator('#workflows-status')).toContainText('Deleted "Call notes".');
  expect(stored('call-notes')).toBeUndefined();
  expect(
    readdirSync(path.join(HOST_HOME, 'workflows', '.trash')).some((d) =>
      d.startsWith('call-notes-'),
    ),
  ).toBe(true);
  await r.locator('button.run-workflow').click();
  await expect(r.locator('select.workflow-select option')).toHaveText(['E2E echo']);
});
