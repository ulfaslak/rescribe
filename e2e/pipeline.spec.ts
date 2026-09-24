// Pipeline steps 3–5 end to end, through the app page: a recording with the fake mic → Stop →
// transcript.md, transcript.json and meta.json next to the video with the name from Settings on
// the mic channel; adapter messages during a recording → events.jsonl, meta.json's participants
// and a note on the row; no export folder → the artifacts wait in OPFS; a reload mid-transcription
// starts it again; and the privacy assertion over each whole run (e2e/privacy.ts).
//
// The first run in a fresh profile downloads the int8 model (about 650 MB); later runs load it
// from the profile's IndexedDB. Headless display capture carries the same fake-device speech as
// the microphone (ENVIRONMENT_NOTES), so display segments exist and read as "Speaker"; platform
// attribution of real display speech is src/lib/assemble.test.ts and LIVE_CHECKS.
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  badgeText,
  clearExportFolder,
  clearRecordings,
  exported,
  EXPORT_DIR,
  getSettings,
  openApp,
  openTarget,
  opfsList,
  opfsText,
  OTHER_EXPORT_DIR,
  patchRecording,
  ready,
  recordings,
  removeOpfs,
  rerun,
  rowState,
  seedExportFolder,
  setSettings,
  startRecording,
  stopRecording,
  waitForRecording,
  wordHitRate,
} from './helpers.ts';
import { watchNetwork, type NetworkWatch } from './privacy.ts';
import type { Recording } from '../src/lib/types.ts';
import type { TranscriptFile, TranscriptMetaFile } from '../src/lib/assemble.ts';

/** Longer than the 7.7 s fixture, so every word is captured at least once. */
const RECORD_S = 10;
const SETTINGS = {
  container: 'mp4',
  pathTemplate: '{date} {time} {title}',
  micByDefault: true,
  myName: 'Ulf',
  model: 'parakeet-tdt-0.6b-v3',
  backend: 'wasm',
  autoTranscribe: true,
};

async function setUp(
  context: BrowserContext,
  extensionId: string,
  opts: { folder: boolean } = { folder: true },
): Promise<{ page: Page; net: NetworkWatch }> {
  const net = watchNetwork(context);
  await openTarget(context);
  const page = await openApp(context, extensionId);
  await clearRecordings(page);
  if (opts.folder) await seedExportFolder(page);
  else await clearExportFolder(page);
  await setSettings(page, SETTINGS);
  await page.reload();
  await ready(page);
  await expect(page.locator('#status')).toHaveText('idle');
  return { page, net };
}

const settled = (r: Recording) => r.status === 'done' || r.status === 'failed';

function finish(net: NetworkWatch): void {
  console.log(`[privacy] origins seen: ${net.origins().join(', ')}`);
  net.assertOnlyAllowed();
  net.stop();
}

test('record → transcribe: transcript.md/json and meta.json next to the video, my name on the mic channel, local only', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  await expect(page.locator('#mic')).toBeChecked();
  await startRecording(page);
  await page.waitForTimeout(RECORD_S * 1000);
  const stoppedAt = await stopRecording(page);
  const [started] = await recordings(page);
  expect(started).toBeDefined();
  expect(['recorded', 'transcribing']).toContain(started!.status);
  // The recorder is idle (Record is enabled) while the pill and the badge show the pipeline.
  await expect(page.locator('#status')).toHaveText('transcribing');
  await expect.poll(() => badgeText(page)).toBe('…');

  const rec = await waitForRecording(page, started!.id, settled, { label: 'transcribe' });
  const elapsed = Date.now() - stoppedAt;
  console.log(`[pipeline] stop → ${rec.status} in ${elapsed} ms: ${JSON.stringify(rec)}`);
  expect(rec.status, rec.error).toBe('done');
  expect(rec.error).toBeUndefined();
  expect(rec.model).toBe(SETTINGS.model);
  expect(rec.backend).toBe('wasm');
  expect(rec.transcribedAt).toBeGreaterThan(rec.endedAt!);
  await expect(page.locator('#status')).toHaveText('idle');
  await expect.poll(() => badgeText(page)).toBe('');
  await expect(page.locator('#record-status')).toContainText('Transcript saved to');
  await expect(page.locator(`.recording-item[data-id="${rec.id}"]`)).toHaveAttribute(
    'data-status',
    'done',
  );

  // transcript.md: the fixture's words under the name from Settings.
  const md = await opfsText(page, exported(rec, 'transcript.md'));
  console.log(`[pipeline] transcript.md:\n${md}`);
  const hits = wordHitRate(md);
  console.log(`[pipeline] word hit rate ${hits.toFixed(2)}`);
  expect(hits).toBeGreaterThan(0.8);
  expect(md).toMatch(/^# Screen recording\n/);
  expect(md).toContain('**Ulf** [0:0');
  expect(md).not.toContain('Participants:');

  // transcript.json: segments with words, channel identity as the evidence for the mic.
  const json = JSON.parse(await opfsText(page, exported(rec, 'transcript.json'))) as TranscriptFile;
  expect(json.version).toBe(1);
  expect(json.model).toBe(SETTINGS.model);
  expect(json.backend).toBe('wasm');
  expect(json.participants).toEqual([]);
  const mic = json.segments.filter((s) => s.channel === 'mic');
  expect(mic.length).toBeGreaterThan(0);
  for (const s of mic) {
    expect(s.speaker).toBe('Ulf');
    expect(s.evidence).toBe('channel');
    expect(s.words!.length).toBeGreaterThan(0);
    expect(s.start).toBeGreaterThanOrEqual(0);
    expect(s.end).toBeLessThanOrEqual((rec.endedAt! - rec.startedAt) / 1000 + 0.5);
  }
  const display = json.segments.filter((s) => s.channel === 'display');
  console.log(`[pipeline] display segments (fake device): ${JSON.stringify(display)}`);
  for (const s of display) expect(s.speaker).toBe('Speaker');
  expect(json.intervals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ channel: 'mic', speaker: 'Ulf', source: 'channel', start: 0 }),
    ]),
  );
  expect(json.turns.length).toBeGreaterThan(0);

  // meta.json: when, what, who, what transcribed it.
  const meta = JSON.parse(await opfsText(page, exported(rec, 'meta.json'))) as TranscriptMetaFile;
  const version = await page.evaluate(() => chrome.runtime.getManifest().version);
  expect(meta).toMatchObject({
    version: 1,
    id: rec.id,
    title: rec.title,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    participants: [],
    model: SETTINGS.model,
    backend: 'wasm',
    container: 'mp4',
    exportPath: rec.exportPath,
    clockGaps: [],
    transcribedAt: rec.transcribedAt,
    rescribeVersion: version,
  });
  expect(meta.sources.map((s) => s.channel).sort()).toEqual(['display', 'mic']);
  expect(meta.levels?.mic).toBeDefined();

  // OPFS holds the same artifacts plus the per-channel segments; the video is still there.
  const files = await opfsList(page, ['recordings', rec.id]);
  console.log(`[pipeline] OPFS: ${files.join(', ')}`);
  expect(files).toEqual(
    expect.arrayContaining([
      'video.mp4',
      'mic.pcm',
      'display.pcm',
      'events.jsonl',
      'transcript.md',
      'transcript.json',
      'meta.json',
      'segments.mic.json',
      'segments.display.json',
    ]),
  );
  expect(await opfsText(page, ['recordings', rec.id, 'transcript.md'])).toBe(md);
  const exportedFiles = await opfsList(page, exported(rec, '').slice(0, -1));
  expect(exportedFiles).toEqual(['meta.json', 'recording.mp4', 'transcript.json', 'transcript.md']);
  finish(net);
});

test('adapter messages during a recording: events.jsonl as received, participants in meta.json, diagnostics only from contributing tabs', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  // Real senders carry a tab: two duplicate app tabs (inert, but they can send) stand in for two
  // Meet tabs. The service worker has no tab and stands in for anything that is not an adapter.
  const openDuplicate = async (): Promise<Page> => {
    const dup = await context.newPage();
    await dup.goto(`chrome-extension://${extensionId}/app/app.html`);
    await expect(dup.locator('#duplicate')).toBeVisible();
    return dup;
  };
  const tabX = await openDuplicate();
  const tabY = await openDuplicate();
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const sendAll = async (msgs: object[]) => {
    for (const m of msgs) await chrome.runtime.sendMessage(m).catch(() => undefined);
  };
  const from = (tab: Page, msgs: object[]) => tab.evaluate(sendAll, msgs);
  const fromWorker = (msgs: object[]) => worker.evaluate(sendAll, msgs);
  const speaker = (at: number, id: string, name: string, speaking: boolean) => ({
    type: 'speaker',
    platform: 'meet',
    at,
    id,
    name,
    speaking,
  });
  const diagnostic = (at: number, message: string) => ({
    type: 'adapter-diagnostic',
    platform: 'meet',
    at,
    message,
  });
  const noteOf = async () => (await recordings(page))[0]?.note ?? '';

  // Before the recording: nothing to attach it to, dropped.
  await from(tabX, [speaker(Date.now(), 'p0', 'Early', true)]);
  await startRecording(page);
  await page.waitForTimeout(300);
  // A diagnostic from a tab that has contributed nothing, and one without a tab: not ours.
  await from(tabY, [diagnostic(Date.now(), 'stranger: no tiles')]);
  await fromWorker([diagnostic(Date.now(), 'no tab: no tiles')]);
  const t1 = Date.now();
  await from(tabX, [
    { type: 'roster', platform: 'meet', at: t1, names: ['You', 'Anna'] },
    speaker(t1, 'p1', 'Anna', true),
  ]);
  await page.waitForTimeout(2000);
  const t2 = Date.now();
  await from(tabX, [speaker(t2, 'p1', 'Anna', false), diagnostic(t2, 'saw tiles but no meter')]);
  // The note reaches the record while still recording, so a crash keeps it.
  await expect.poll(noteOf).toContain('Meet adapter: saw tiles but no meter');
  expect(await noteOf()).not.toContain('stranger');
  expect(await noteOf()).not.toContain('no tab');
  // Y contributes a speaker event; from then on its diagnostics count too.
  const t3 = Date.now();
  await from(tabY, [
    speaker(t3, 'p2', 'Bo', true),
    diagnostic(t3, "from Bo's tab"),
    speaker(t3 + 500, 'p2', 'Bo', false),
  ]);
  await expect.poll(noteOf).toContain("Meet adapter: from Bo's tab");
  await page.waitForTimeout(700);
  await stopRecording(page);
  // After the recording: dropped.
  await from(tabX, [speaker(Date.now(), 'p9', 'Late', true)]);

  const [started] = await recordings(page);
  const rec = await waitForRecording(page, started!.id, settled, { label: 'adapter' });
  console.log(`[pipeline] ${JSON.stringify(rec)}`);
  expect(rec.status, rec.error).toBe('done');

  const lines = (await opfsText(page, ['recordings', rec.id, 'events.jsonl']))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines.map((l) => l['type'])).toEqual([
    'roster',
    'speaker',
    'speaker',
    'adapter-diagnostic',
    'speaker',
    'adapter-diagnostic',
    'speaker',
  ]);
  expect(lines[0]).toEqual({ type: 'roster', platform: 'meet', at: t1, names: ['You', 'Anna'] });
  expect(lines[1]).toEqual(speaker(t1, 'p1', 'Anna', true));
  expect(lines[2]).toEqual(speaker(t2, 'p1', 'Anna', false));
  expect(lines[3]).toEqual(diagnostic(t2, 'saw tiles but no meter'));
  expect(lines[5]).toEqual(diagnostic(t3, "from Bo's tab"));
  expect(JSON.stringify(lines)).not.toMatch(/Early|Late|stranger|no tab/);

  const meta = JSON.parse(await opfsText(page, exported(rec, 'meta.json'))) as TranscriptMetaFile;
  expect(meta.participants).toEqual(['Ulf', 'Anna', 'Bo']);
  const json = JSON.parse(await opfsText(page, exported(rec, 'transcript.json'))) as TranscriptFile;
  const anna = json.intervals.filter((iv) => iv.speaker === 'Anna');
  expect(anna).toHaveLength(1);
  expect(anna[0]).toMatchObject({ channel: 'display', source: 'platform' });
  // Recording-relative, the lead (0.3 s) applied to the start, the stop as stamped.
  expect(anna[0]!.start).toBeCloseTo(Math.max(0, (t1 - rec.startedAt) / 1000 - 0.3), 2);
  expect(anna[0]!.end).toBeCloseTo((t2 - rec.startedAt) / 1000, 2);
  expect(json.intervals.filter((iv) => iv.speaker === 'Bo')).toHaveLength(1);
  expect(await opfsText(page, exported(rec, 'transcript.md'))).toContain(
    'Participants: Ulf, Anna, Bo',
  );

  expect(rec.note).toContain('Meet adapter: saw tiles but no meter');
  expect(rec.note).toContain("Meet adapter: from Bo's tab");
  expect(rec.note).not.toMatch(/stranger|no tab/);
  await expect(page.locator(`.recording-item[data-id="${rec.id}"]`)).toContainText(
    'saw tiles but no meter',
  );
  finish(net);
});

test('no export folder: done, artifacts kept in OPFS, the row and the status line say not exported', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId, { folder: false });
  await expect(page.locator('#folder-name')).toHaveText('No folder chosen');
  await startRecording(page);
  await page.waitForTimeout(3000);
  await stopRecording(page);
  const [started] = await recordings(page);
  const id = started!.id;
  // The row follows the stored record: `transcribing` from the moment the pipeline queued it,
  // and no Save now while it owns the recording.
  await expect.poll(() => rowState(page, id)).toEqual({ status: 'transcribing', save: false });
  const rec = await waitForRecording(page, id, settled, { label: 'no-folder' });
  console.log(`[pipeline] ${JSON.stringify(rec)}`);
  expect(rec.status, rec.error).toBe('done');
  expect(rec.exportPath).toBeUndefined();
  expect(rec.error).toMatch(/^Not exported: No export folder/);
  const files = await opfsList(page, ['recordings', rec.id]);
  expect(files).toEqual(
    expect.arrayContaining(['video.mp4', 'transcript.md', 'transcript.json', 'meta.json']),
  );
  const meta = JSON.parse(
    await opfsText(page, ['recordings', rec.id, 'meta.json']),
  ) as TranscriptMetaFile;
  expect(meta.exportPath).toBeUndefined();
  expect(await opfsList(page, [EXPORT_DIR])).toEqual([]);
  await expect(page.locator('#record-status')).toContainText('Not exported: No export folder');
  const row = page.locator(`.recording-item[data-id="${rec.id}"]`);
  await expect(row).toContainText('No export folder');
  await expect(row).toHaveAttribute('data-status', 'done');

  // A folder is chosen; Save now on the `done` row exports the video and every artifact, and
  // clears the error. The recording stays `done`.
  await expect(row.locator('button.save-now')).toBeVisible();
  await seedExportFolder(page);
  await row.locator('button.save-now').click();
  await expect(row.locator('.path')).toHaveText(/Screen recording\/$/, { timeout: 15_000 });
  const [saved] = await recordings(page);
  console.log(`[pipeline] after Save now ${JSON.stringify(saved)}`);
  expect(saved!.id).toBe(rec.id);
  expect(saved!.status).toBe('done');
  expect(saved!.error).toBeUndefined();
  expect(saved!.exportPath).toBeDefined();
  expect(await opfsList(page, exported(saved!, '').slice(0, -1))).toEqual([
    'meta.json',
    'recording.mp4',
    'transcript.json',
    'transcript.md',
  ]);
  expect(await opfsText(page, exported(saved!, 'transcript.md'))).toBe(
    await opfsText(page, ['recordings', rec.id, 'transcript.md']),
  );
  await expect(row.locator('button.save-now')).toHaveCount(0);
  // Save now lives in the library (#4); its outcome goes to the library's status line.
  await expect(page.locator('#library-status')).toContainText('Saved recording.mp4, meta.json');
  finish(net);
});

test('the export folder changes mid-transcription: done with "Not exported", nothing written under the new folder, the files carry the current title; Save now redoes video and artifacts there', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  await startRecording(page);
  await page.waitForTimeout(RECORD_S * 1000);
  await stopRecording(page);
  const [started] = await recordings(page);
  const id = started!.id;
  const oldPath = started!.exportPath!;
  // Once the pipeline has marked the record, another folder is chosen and the title changes.
  await expect.poll(() => rowState(page, id)).toMatchObject({ status: 'transcribing' });
  await seedExportFolder(page, OTHER_EXPORT_DIR);
  await patchRecording(page, id, { title: 'Renamed call' });
  const rec = await waitForRecording(page, id, settled, { label: 'moved-folder' });
  console.log(`[pipeline] ${JSON.stringify(rec)}`);
  expect(rec.status, rec.error).toBe('done');
  expect(rec.exportPath).toBe(oldPath);
  expect(rec.error).toBe(
    "Not exported: the recording's folder was not found under the current export folder",
  );
  expect(await opfsList(page, [OTHER_EXPORT_DIR])).toEqual([]);
  expect(await opfsList(page, [EXPORT_DIR, oldPath])).toEqual(['recording.mp4']);
  const md = await opfsText(page, ['recordings', id, 'transcript.md']);
  expect(md).toMatch(/^# Renamed call\n/);
  const meta = JSON.parse(
    await opfsText(page, ['recordings', id, 'meta.json']),
  ) as TranscriptMetaFile;
  expect(meta.title).toBe('Renamed call');

  // Save now: the video and the artifacts land under the new folder at the same relative path.
  const row = page.locator(`.recording-item[data-id="${id}"]`);
  await expect(row.locator('button.save-now')).toBeVisible();
  await row.locator('button.save-now').click();
  await expect.poll(async () => (await recordings(page))[0]?.error).toBeUndefined();
  const [saved] = await recordings(page);
  expect(saved!.status).toBe('done');
  expect(saved!.exportPath).toBe(oldPath);
  expect(await opfsList(page, [OTHER_EXPORT_DIR, ...oldPath.split('/')])).toEqual([
    'meta.json',
    'recording.mp4',
    'transcript.json',
    'transcript.md',
  ]);
  expect(await opfsList(page, [EXPORT_DIR, oldPath])).toEqual(['recording.mp4']);
  finish(net);
});

test('re-running a failed recording: the earlier failure moves to the note; done only with an export path or a "Not exported" reason; without media it stays failed with both reasons', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  await startRecording(page);
  await page.waitForTimeout(3000);
  await stopRecording(page);
  const [started] = await recordings(page);
  const id = started!.id;
  const first = await waitForRecording(page, id, settled, { label: 'first' });
  expect(first.status, first.error).toBe('done');

  // (a) Failed with its media present: runs from the cache, the reason survives in the note.
  await patchRecording(page, id, { status: 'failed', error: 'Video chunk lost: synthetic' });
  const a = await rerun(page, id);
  console.log(`[pipeline] (a) ${JSON.stringify(a)}`);
  expect(a.status, a.error).toBe('done');
  expect(a.error).toBeUndefined();
  expect(a.note).toContain('Earlier failure: Video chunk lost: synthetic');
  expect(a.transcribedAt!).toBeGreaterThan(first.transcribedAt!);

  // (b) Failed, never exported, no folder: done, but never without saying why nothing is there.
  await clearExportFolder(page);
  await patchRecording(page, id, {
    status: 'failed',
    error: 'Something else',
    exportPath: undefined,
  });
  const b = await rerun(page, id);
  console.log(`[pipeline] (b) ${JSON.stringify(b)}`);
  expect(b.status).toBe('done');
  expect(b.exportPath).toBeUndefined();
  expect(b.error).toMatch(/^Not exported: /);
  expect(b.note).toContain('Earlier failure: Something else');

  // (c) Failed and the media gone: failed, the earlier reason first.
  await removeOpfs(page, ['recordings'], [id]);
  await patchRecording(page, id, { status: 'failed', error: 'Video chunk lost: synthetic' });
  const c = await rerun(page, id);
  console.log(`[pipeline] (c) ${JSON.stringify(c)}`);
  expect(c.status).toBe('failed');
  expect(c.error).toMatch(/^Video chunk lost: synthetic Nothing to transcribe: /);
  finish(net);
});

test('after the media is deleted, a done recording re-runs from its segments cache (a new "my name" relabels it) and re-exports; without the cache it fails', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  await startRecording(page);
  await page.waitForTimeout(3000);
  await stopRecording(page);
  const [started] = await recordings(page);
  const id = started!.id;
  const first = await waitForRecording(page, id, settled, { label: 'first' });
  expect(first.status, first.error).toBe('done');

  // Delete media (what the library's deleteMedia does): video and PCM go, the rest stays.
  await removeOpfs(page, ['recordings', id], ['video.mp4', 'mic.pcm', 'display.pcm']);
  await patchRecording(page, id, { mediaDeleted: true });
  await setSettings(page, { myName: 'Ulf Aslak' });
  const again = await rerun(page, id);
  console.log(`[pipeline] ${JSON.stringify(again)}`);
  expect(again.status, again.error).toBe('done');
  expect(again.error).toBeUndefined();
  expect(again.transcribedAt!).toBeGreaterThan(first.transcribedAt!);
  const md = await opfsText(page, exported(again, 'transcript.md'));
  expect(md).toContain('**Ulf Aslak** [');
  expect(md).not.toContain('**Ulf** [');
  expect(await opfsList(page, ['recordings', id])).toEqual([
    'events.jsonl',
    'meta.json',
    'segments.display.json',
    'segments.mic.json',
    'transcript.json',
    'transcript.md',
  ]);

  // Without the cache there is nothing to assemble from.
  await removeOpfs(page, ['recordings', id], ['segments.mic.json', 'segments.display.json']);
  const gone = await rerun(page, id);
  console.log(`[pipeline] ${JSON.stringify(gone)}`);
  expect(gone.status).toBe('failed');
  expect(gone.error).toMatch(/Nothing to transcribe/);
  await setSettings(page, { myName: 'Ulf' });
  finish(net);
});

test('a reload mid-transcription: the recording goes back to recorded with a note and is transcribed again', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  // The tab warns on close while the pipeline runs; leave anyway.
  page.on('dialog', (d) => void d.accept());
  await startRecording(page);
  await page.waitForTimeout(RECORD_S * 1000);
  await stopRecording(page);
  const [started] = await recordings(page);
  const mid = await waitForRecording(page, started!.id, (r) => r.status !== 'recorded', {
    everyMs: 50,
    timeoutMs: 30_000,
    label: 'until-transcribing',
  });
  expect(mid.status).toBe('transcribing');
  await expect(page.locator('#status')).toHaveText('transcribing');

  await page.reload();
  await ready(page);
  const [after] = await recordings(page);
  expect(['recorded', 'transcribing', 'done']).toContain(after!.status);
  const rec = await waitForRecording(page, started!.id, settled, { label: 'after-reload' });
  console.log(`[pipeline] ${JSON.stringify(rec)}`);
  expect(rec.status, rec.error).toBe('done');
  expect(rec.note).toContain('interrupted by a reload');
  expect(wordHitRate(await opfsText(page, exported(rec, 'transcript.md')))).toBeGreaterThan(0.8);
  finish(net);
});

test('recording while transcribing: query-status stays idle for the toolbar, both recordings end done in order', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // A long first recording, so its transcription outlasts the second recording.
  await startRecording(page);
  await page.waitForTimeout(15_000);
  await stopRecording(page);
  const [a] = await recordings(page);
  await expect(page.locator('#status')).toHaveText('transcribing');
  // What the service worker asks before a toolbar click: the recorder's state, not the pipeline's.
  expect(await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'query-status' }))).toBe(
    'idle',
  );
  await startRecording(page);
  await expect.poll(() => badgeText(page)).toBe('REC');
  await page.waitForTimeout(2000);
  await stopRecording(page);
  const [b] = await recordings(page);
  expect(b!.id).not.toBe(a!.id);
  // The queued recording is marked on disk at once, while the first still runs.
  const status = (id: string) => recordings(page).then((rs) => rs.find((r) => r.id === id)?.status);
  await expect.poll(() => status(b!.id), { timeout: 1500 }).toBe('transcribing');
  expect(await status(a!.id)).toBe('transcribing');
  const doneA = await waitForRecording(page, a!.id, settled, { label: 'A' });
  const doneB = await waitForRecording(page, b!.id, settled, { label: 'B' });
  console.log(`[pipeline] A ${JSON.stringify(doneA)}\n[pipeline] B ${JSON.stringify(doneB)}`);
  expect(doneA.status, doneA.error).toBe('done');
  expect(doneB.status, doneB.error).toBe('done');
  expect(doneA.transcribedAt!).toBeLessThan(doneB.transcribedAt!);
  for (const rec of [doneA, doneB])
    expect(wordHitRate(await opfsText(page, exported(rec, 'transcript.md')))).toBeGreaterThan(0.25);
  await expect(page.locator('#status')).toHaveText('idle');
  await expect.poll(() => badgeText(page)).toBe('');
  finish(net);
});

test('an interrupted transcription whose media is gone fails instead of producing an empty transcript', async ({
  context,
  extensionId,
}) => {
  const { page, net } = await setUp(context, extensionId);
  await startRecording(page);
  await page.waitForTimeout(2000);
  await stopRecording(page);
  const [rec] = await recordings(page);
  await waitForRecording(page, rec!.id, settled, { label: 'first' });
  // As if the tab died mid-transcription and the recording's directory was removed meanwhile.
  await page.evaluate(async (id) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('rescribe');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('recordings', 'readwrite');
        const store = tx.objectStore('recordings');
        const get = store.get(id);
        get.onsuccess = () => store.put({ ...(get.result as object), status: 'transcribing' }, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('recordings');
    await dir.removeEntry(id, { recursive: true });
  }, rec!.id);
  await page.reload();
  await ready(page);
  const after = await waitForRecording(page, rec!.id, settled, { label: 'deleted' });
  console.log(`[pipeline] ${JSON.stringify(after)}`);
  expect(after.status).toBe('failed');
  expect(after.error).toMatch(/no longer in Rescribe's storage/);
  expect(after.note).toContain('interrupted by a reload');
  await expect(page.locator('#record-status')).toContainText('Transcription failed');
  finish(net);
});

test('Settings: backend and auto-transcribe are saved from the form', async ({
  context,
  extensionId,
}) => {
  const { page } = await setUp(context, extensionId);
  await expect(page.locator('select[name="backend"]')).toHaveValue('wasm');
  await expect(page.locator('input[name="autoTranscribe"]')).toBeChecked();
  await page.selectOption('select[name="backend"]', 'webgpu');
  await page.uncheck('input[name="autoTranscribe"]');
  await expect(page.locator('#settings-saved')).toHaveText('Saved.');
  await expect
    .poll(() => getSettings(page))
    .toMatchObject({
      backend: 'webgpu',
      autoTranscribe: false,
    });
  await page.reload();
  await ready(page);
  await expect(page.locator('select[name="backend"]')).toHaveValue('webgpu');
  await expect(page.locator('input[name="autoTranscribe"]')).not.toBeChecked();
  // Leave the profile as the other specs expect it.
  await setSettings(page, { backend: 'wasm', autoTranscribe: true });
});
