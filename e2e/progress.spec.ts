// The transcription progress the human sees (issue #31): one recording transcribed while the
// library row, the Record section's line and the processing tab are watched, with a screenshot
// of each state into screenshots/progress/ (gitignored) for the human to look at. The rules
// pinned here: no channel id or region count reaches any of the three views; the step count
// never changes while the job runs; the microphone is transcribed before the call and both
// show as steps; the row and the processing tab name the same steps.
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  clearRecordings,
  openApp,
  openTarget,
  progressUrl,
  ready,
  recordings,
  seedExportFolder,
  setSettings,
  startRecording,
  stopRecording,
  waitForRecording,
} from './helpers.ts';

/** Long enough for more than one region per channel, so a channel step is seen part-way. */
const RECORD_S = 40;
const POLL_MS = 150;
const SHOTS = path.resolve('screenshots/progress');

/** Implementation words that must never reach the human. */
const FORBIDDEN = /\b(mic|display|regions?)\b/i;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The visible text of `selector`, or '' when it is not there. A plain read: a locator's text
 * waits for the element to appear, and this project sets no action timeout, so a widget that
 * vanished between two reads (the list is rebuilt at every phase) would hang the poll.
 */
async function text(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector,
  );
}

/** An element screenshot, again when the list was rebuilt under it (a phase change re-renders). */
async function shoot(loc: Locator, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (!(await loc.count())) return;
      await loc.screenshot({ path: file, timeout: 5000 });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

interface Seen {
  /** The running step's label in the row, the phase, the headline in the tab. */
  key: string;
  rowStep: string;
  rowCount: string;
  tabHeadline: string;
  tabStep: string;
}

test("the three views show the job as steps in the human's words, in order, with one step count; a screenshot per state", async ({
  context,
  extensionId,
}) => {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  await seedExportFolder(page);
  await setSettings(page, {
    container: 'webm',
    pathTemplate: '{date} {time} {title}',
    micByDefault: true,
    myName: 'Ulf',
    model: 'parakeet-tdt-0.6b-v3',
    backend: 'wasm',
    autoTranscribe: false,
  });
  await page.reload();
  await ready(page);
  await expect(page.locator('#status')).toHaveText('idle');

  await startRecording(page);
  await page.waitForTimeout(RECORD_S * 1000);
  await stopRecording(page);
  const [rec] = await recordings(page);
  expect(rec).toBeDefined();
  const id = rec!.id;
  await waitForRecording(page, id, (r) => r.status === 'recorded', { label: 'saved' });

  // The processing tab for it, as the stop dialog would open it.
  const tab = await context.newPage();
  await tab.goto(`${progressUrl(extensionId)}?id=${id}`);
  await expect(tab.locator('#headline')).toHaveText('Saved');
  await tab.screenshot({ path: path.join(SHOTS, '00-tab-saved.png'), fullPage: true });

  const row = page.locator(`.recording-item[data-id="${id}"]`);
  const widget = row.locator('.progress');
  const widgetSel = `.recording-item[data-id="${id}"] .progress`;
  await page.evaluate(
    (id) =>
      void (
        window as unknown as { rescribe: { transcribeRecording: (id: string) => Promise<unknown> } }
      ).rescribe.transcribeRecording(id),
    id,
  );

  const seen: Seen[] = [];
  const states: string[] = [];
  let shots = 0;
  const deadline = Date.now() + 10 * 60_000;
  let status = 'transcribing';
  while (Date.now() < deadline) {
    const current = (await recordings(page)).find((r) => r.id === id);
    status = current?.status ?? 'gone';
    // The row and the line in one read, so a screenshot's name says what it shows.
    const { rowText, line, rowStep, phase } = await page.evaluate((sel) => {
      const w = document.querySelector(`${sel} .steps`) as HTMLElement | null;
      const inner = (el: Element | null) => (el as HTMLElement | null)?.innerText ?? '';
      return {
        rowText: inner(document.querySelector(sel)),
        line: inner(document.querySelector('#record-status')),
        rowStep: w?.querySelector('.step.running .step-label')?.textContent ?? '',
        phase: w?.dataset['phase'] ?? '',
      };
    }, widgetSel);
    const [tabHeadline, tabDetail, tabSteps] = await Promise.all([
      text(tab, '#headline'),
      text(tab, '#detail'),
      text(tab, '#steps'),
    ]);
    for (const t of [rowText, line, tabHeadline, tabDetail, tabSteps])
      expect(t, `implementation word in: ${t}`).not.toMatch(FORBIDDEN);
    const rowCount = (rowText.match(/step \d+ of (\d+)/) ?? [])[1] ?? '';
    const tabStep = await text(tab, '#steps .step.running .step-label');
    // A state is a phase and a running step; a download's bytes or a share ticking are not one.
    const key = `${phase}|${rowStep}|${rowStep ? '' : line}`;
    if (rowStep) states.push(rowStep);
    if (seen.at(-1)?.key !== key) {
      seen.push({ key, rowStep, rowCount, tabHeadline, tabStep });
      const name = `${String(++shots).padStart(2, '0')}-${slug(`${phase} ${rowStep || line}`)}`;
      console.log(
        `[progress] ${name}: row="${rowText.replace(/\n/g, ' | ')}" line="${line}" tab="${tabHeadline}"`,
      );
      if (await widget.count()) await shoot(row, path.join(SHOTS, `${name}-row.png`));
      await shoot(page.locator('#record'), path.join(SHOTS, `${name}-status.png`));
      await tab.screenshot({ path: path.join(SHOTS, `${name}-tab.png`), fullPage: true });
    }
    if (status === 'done' || status === 'failed') break;
    await page.waitForTimeout(POLL_MS);
  }
  const final = (await recordings(page)).find((r) => r.id === id);
  expect(final?.status, final?.error).toBe('done');
  // The tab polls once a second: give it its last look, then the closing screenshots.
  await expect(tab.locator('#headline')).toHaveText('Done', { timeout: 5000 });
  await expect(widget).toHaveCount(0);
  await shoot(row, path.join(SHOTS, '99-row-done.png'));
  await shoot(page.locator('#record'), path.join(SHOTS, '99-status-done.png'));
  await tab.screenshot({ path: path.join(SHOTS, '99-tab-done.png'), fullPage: true });

  // One step count throughout.
  const counts = new Set(seen.map((s) => s.rowCount).filter(Boolean));
  expect([...counts], JSON.stringify(seen)).toHaveLength(1);
  // The microphone, then the call, both as steps of their own, in the pipeline's order.
  const order = states.filter((s, i) => i === 0 || states[i - 1] !== s);
  const mic = order.indexOf('Ulf’s microphone');
  const call = order.indexOf('The call');
  expect(mic, JSON.stringify(order)).toBeGreaterThanOrEqual(0);
  expect(call, JSON.stringify(order)).toBeGreaterThan(mic);
  // The row and the processing tab name the same steps: every step the tab showed as running,
  // the row did too, under the same label.
  const rowSteps = new Set(seen.map((s) => s.rowStep).filter(Boolean));
  for (const s of seen) if (s.tabStep) expect(rowSteps.has(s.tabStep), s.tabStep).toBe(true);
  // The tab's headline followed the channels by the human's name and "the call".
  const headlines = seen.map((s) => s.tabHeadline);
  expect(
    headlines.some((h) => h === 'Transcribing Ulf’s microphone'),
    headlines.join(' / '),
  ).toBe(true);
  expect(
    headlines.some((h) => h === 'Transcribing the call'),
    headlines.join(' / '),
  ).toBe(true);
  console.log(`[progress] ${shots} states, screenshots in ${SHOTS}`);
});
