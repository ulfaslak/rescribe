// The recording library (ARCHITECTURE § Pipeline: "any stage can be re-run from the library").
// One row per Recording: an editable title, the status, what is still on disk, and the actions
// that work from OPFS (re-export, re-run transcription, delete media, delete). App-tab only.
//
// app.ts calls renderList() after every recorder phase change. Each render re-reads IndexedDB and
// walks `recordings/` in OPFS once: the walk is both the storage figure and each row's inventory,
// so a row only offers what it can actually do. While a row is `recording` or `transcribing` a
// 1 s refresh keeps its duration and status current without help from the recorder or the pipeline.
import { loadSettings } from '../lib/settings.ts';
import type { Recording } from '../lib/types.ts';
import { exportVideoName } from '../recorder/recorder.ts';
import {
  ensureExportPermission,
  ExportError,
  getExportDirectory,
  writeExportFile,
} from '../storage/export.ts';
import { isExportableArtifact, isMediaFile, pcmFileName, videoFileName } from '../storage/opfs.ts';
import {
  deleteMedia,
  deleteRecording,
  getArtifactFile,
  getRecording,
  getVideoFile,
  listArtifactNames,
  listRecordings,
  storageUsage,
  updateRecording,
  type StorageUsage,
} from '../storage/store.ts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

/** How long a two-step button stays armed before it quietly disarms. */
const ARM_MS = 8000;
/** A confirming click sooner than this after arming is ignored: a double-click must not delete. */
const ARM_GUARD_MS = 350;
const LIVE_REFRESH_MS = 1000;

// --- Formatting ---------------------------------------------------------------------------------
export function describeSources(rec: Recording): string {
  const display = rec.sources.find((s) => s.channel === 'display');
  const mic = rec.sources.some((s) => s.channel === 'mic');
  return `${display?.kind ?? 'display'}${mic ? ' + mic' : ', no mic'}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatLevels(levels: Recording['levels']): string | undefined {
  if (!levels) return undefined;
  const parts = (['mic', 'display'] as const)
    .filter((ch) => levels[ch] !== undefined)
    .map((ch) => `${ch} ${levels[ch]} dBFS`);
  return parts.length ? parts.join(' · ') : undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} ${units[i]}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// --- What a recording still has on disk ---------------------------------------------------------
interface Inventory {
  video: boolean;
  pcm: boolean;
  artifacts: string[];
  /** Everything in the directory. */
  bytes: number;
  /** The video and the PCM files only: what "Delete media" frees. */
  mediaBytes: number;
}

function inventory(rec: Recording, usage: StorageUsage): Inventory {
  const files = usage.files[rec.id] ?? {};
  const size = (name: string): number => files[name] ?? 0;
  return {
    video: size(videoFileName(rec.container)) > 0,
    pcm: size(pcmFileName('mic')) > 0 || size(pcmFileName('display')) > 0,
    artifacts: Object.keys(files).filter(isExportableArtifact).sort(),
    bytes: usage.perRecording[rec.id] ?? 0,
    mediaBytes: Object.entries(files)
      .filter(([n]) => isMediaFile(n))
      .reduce((sum, [, b]) => sum + b, 0),
  };
}

/** The bulk target: exported, finished with (`done`) or at least saved (`recorded`), media present. */
function exportedWithMedia(recs: Recording[], usage: StorageUsage): Recording[] {
  return recs.filter(
    (r) =>
      r.exportPath !== undefined &&
      (r.status === 'done' || r.status === 'recorded') &&
      inventory(r, usage).mediaBytes > 0,
  );
}

// --- Transcription (contract with src/app/pipeline.ts, #2) --------------------------------------
// TODO(#2): when src/app/pipeline.ts is on main, import { transcribeRecording, onPipelineProgress }
// from './pipeline.ts', set PIPELINE_AVAILABLE to true, subscribe in bindOnce() with
// `onPipelineProgress(onProgress)` and make rerun() call `transcribeRecording(id)`. The row
// already renders `progress.get(id)` while the status is `transcribing`.
const PIPELINE_AVAILABLE = false;
/** The pipeline's latest progress message per recording id, shown on a `transcribing` row. */
const progress = new Map<string, string>();

function onProgress(id: string, p: { message: string }): void {
  progress.set(id, p.message);
  const el = document.querySelector(`.recording-item[data-id="${CSS.escape(id)}"] .progress`);
  if (el) el.textContent = p.message;
  else void renderList(); // the status flipped to `transcribing` under us
}

async function rerun(id: string): Promise<string | undefined> {
  const rec = await getRecording(id);
  if (!rec) return 'That recording no longer exists.';
  // TODO(#2): `await transcribeRecording(id); return undefined;` (the row shows the outcome).
  return `Transcription is not available yet (#2); "${rec.title}" was left as is.`;
}

// --- Actions ------------------------------------------------------------------------------------
function libraryNote(text: string, isError = false): void {
  const el = $<HTMLElement>('#library-status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

/** Run an action with the row's buttons disabled, report, then re-render. */
async function runAction(scope: Element, fn: () => Promise<string | undefined>): Promise<void> {
  for (const b of scope.querySelectorAll('button')) b.disabled = true;
  try {
    const text = await fn();
    if (text) libraryNote(text);
  } catch (err) {
    libraryNote(err instanceof Error ? err.message : String(err), true);
  } finally {
    await renderList();
  }
}

/**
 * Write everything the recording still has in OPFS into its export directory: the video (unless
 * the media was deleted) and every artifact (transcript.md, transcript.json, meta.json: any file
 * in recordings/<id>/ that is neither raw media nor the events log). Reuses `exportPath` when set,
 * so a folder the human deleted is recreated at the same path; a `recorded` recording without one
 * gets a path from the template, as `finalize` does on stop. The status never changes: `done`
 * stays `done`. Also "Save now" for a recording whose export failed on stop (no folder, or the
 * folder permission was not granted because finalize ran outside a click).
 */
async function reExport(id: string): Promise<string | undefined> {
  // First thing inside the click: after a browser restart the persisted folder handle is
  // `prompt`, and requestPermission only prompts from a user gesture.
  await ensureExportPermission().catch(() => undefined);
  const rec = await claim(id, 'export it');
  if (typeof rec === 'string') return rec;
  const settings = await loadSettings();
  const video = await getVideoFile(rec.id, rec.container);
  const artifacts = await listArtifactNames(rec.id);
  const hasVideo = video !== undefined && video.size > 0;
  if (!hasVideo && artifacts.length === 0)
    return `Nothing left in local storage to export for "${rec.title}".`;
  try {
    const { dir, path } = await getExportDirectory(rec, settings.pathTemplate);
    const written: string[] = [];
    if (hasVideo) {
      const name = exportVideoName(rec.container);
      await writeExportFile(dir, name, video.stream());
      written.push(name);
    }
    for (const name of artifacts) {
      const file = await getArtifactFile(rec.id, name);
      if (!file) continue; // deleted between the listing and now
      await writeExportFile(dir, name, file.stream());
      written.push(name);
    }
    await updateRecording(rec.id, { exportPath: path, error: undefined });
    return `Saved ${written.join(', ')} to ${path}/.`;
  } catch (err) {
    const msg = err instanceof ExportError ? err.message : String(err);
    await updateRecording(rec.id, { error: `Not exported: ${msg}` });
    return undefined; // the row shows the error
  }
}

const live = (rec: Recording): boolean =>
  rec.status === 'recording' || rec.status === 'transcribing';

/**
 * The record as it is now, not as the row was rendered: a recording the recorder or the pipeline
 * has taken since (status `recording` or `transcribing`) must not have its files touched.
 */
async function claim(id: string, what: string): Promise<Recording | string> {
  const rec = await getRecording(id);
  if (!rec) return 'That recording no longer exists.';
  if (live(rec)) return `"${rec.title}" is ${rec.status}; ${what} once it is done.`;
  return rec;
}

async function removeMedia(id: string): Promise<string> {
  const rec = await claim(id, 'delete its media');
  if (typeof rec === 'string') return rec;
  const freed = await deleteMedia(id);
  const kept = rec.exportPath ? `; ${rec.exportPath}/ is untouched` : '';
  return `Deleted ${formatBytes(freed)} of media for "${rec.title}"${kept}.`;
}

async function remove(id: string): Promise<string> {
  const rec = await claim(id, 'delete it');
  if (typeof rec === 'string') return rec;
  await deleteRecording(id);
  const kept = rec.exportPath ? `; ${rec.exportPath}/ is untouched` : '';
  return `Deleted "${rec.title}" from Rescribe${kept}.`;
}

/** The bulk target is re-computed from the store at click time, never from the rendered list. */
async function removeExportedMedia(): Promise<string> {
  const [recs, usage] = await Promise.all([listRecordings(), storageUsage()]);
  const targets = exportedWithMedia(recs, usage);
  if (targets.length === 0) return 'Nothing to delete: no exported recording has media left.';
  let freed = 0;
  for (const rec of targets) freed += await deleteMedia(rec.id);
  return `Freed ${formatBytes(freed)}: media deleted for ${plural(targets.length, 'exported recording')}; the exported files remain.`;
}

// --- Widgets ------------------------------------------------------------------------------------
/**
 * A destructive action as an in-page two-step: the first click arms the button (its label becomes
 * the question), the second runs it; a click anywhere else, or ARM_MS, disarms. Never
 * window.confirm, which blocks the tab and any automation driving it.
 */
function confirmButton(
  label: string,
  question: string,
  cls: string,
  run: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  let timer: number | undefined;
  let armedAt = 0;
  const onOutside = (e: Event): void => {
    if (e.target !== b) disarm();
  };
  const disarm = (): void => {
    b.classList.remove('armed');
    b.textContent = label;
    window.clearTimeout(timer);
    document.removeEventListener('click', onOutside, true);
  };
  b.addEventListener('click', () => {
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = question;
      armedAt = performance.now();
      timer = window.setTimeout(disarm, ARM_MS);
      // Deferred: the arming click is still propagating and would disarm at once.
      window.setTimeout(() => document.addEventListener('click', onOutside, true), 0);
      return;
    }
    if (performance.now() - armedAt < ARM_GUARD_MS) return; // the second half of a double-click
    disarm();
    run();
  });
  return b;
}

function editTitle(row: HTMLLIElement, rec: Recording): void {
  const titleRow = row.querySelector('.title-row');
  if (!titleRow) return;
  const form = document.createElement('form');
  form.className = 'title-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-input';
  input.value = rec.title;
  input.setAttribute('aria-label', 'Title');
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = rec.exportPath
    ? `Renames the recording here only; the folder stays ${rec.exportPath}/. Enter saves, Escape cancels.`
    : 'Enter saves, Escape cancels.';
  form.append(input, hint);
  titleRow.replaceWith(form);
  let finished = false;
  const finish = async (save: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== rec.title) await updateRecording(rec.id, { title: value });
    await renderList();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void finish(true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void finish(false);
  });
  input.addEventListener('blur', () => void finish(true));
  input.focus();
  input.select();
}

function div(cls: string, text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return el;
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function item(rec: Recording, inv: Inventory): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'recording-item';
  li.dataset['id'] = rec.id;
  li.dataset['status'] = rec.status;

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';
  const title = span('title', rec.title);
  const rename = document.createElement('button');
  rename.className = 'rename';
  rename.type = 'button';
  rename.textContent = '✎';
  rename.title = 'Rename';
  rename.setAttribute('aria-label', 'Rename');
  rename.addEventListener('click', () => editTitle(li, rec));
  titleRow.append(title, rename);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(
    span('when', new Date(rec.startedAt).toLocaleString()),
    span('duration', formatDuration((rec.endedAt ?? Date.now()) - rec.startedAt)),
    span('sources', describeSources(rec)),
    span(`pill ${rec.status}`, rec.status),
  );
  const levels = formatLevels(rec.levels);
  if (levels) meta.append(span('levels', levels));
  if (inv.bytes > 0) meta.append(span('size', `${formatBytes(inv.bytes)} local`));
  li.append(titleRow, meta);

  if (rec.exportPath) li.append(div('path', `${rec.exportPath}/`));
  if (rec.status === 'transcribing')
    li.append(div('progress', progress.get(rec.id) ?? 'Transcribing…'));
  if (rec.error) li.append(div('hint error', rec.error));
  if (rec.note) li.append(div('hint', rec.note));
  if (rec.mediaDeleted)
    li.append(
      div('hint media-deleted', 'Media deleted from local storage; the exported files remain.'),
    );

  if (rec.status === 'recording' || rec.status === 'transcribing') return li;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const exportable =
    (rec.status === 'recorded' || rec.status === 'done') && (inv.video || inv.artifacts.length > 0);
  if (exportable) {
    // "Save now" is the same action, named for the row that never got a folder (record.spec.ts).
    const b = document.createElement('button');
    b.className = rec.exportPath ? 're-export' : 'save-now';
    b.textContent = rec.exportPath ? 'Re-export' : 'Save now';
    b.title = rec.exportPath
      ? `Write ${[inv.video ? exportVideoName(rec.container) : '', ...inv.artifacts].filter(Boolean).join(', ')} into ${rec.exportPath}/ again`
      : 'Save the recording into the export folder';
    b.addEventListener('click', () => void runAction(li, () => reExport(rec.id)));
    actions.append(b);
  }
  if (inv.pcm) {
    const b = document.createElement('button');
    b.className = 'rerun';
    b.textContent = rec.status === 'done' ? 'Re-run transcription' : 'Transcribe';
    if (!PIPELINE_AVAILABLE) {
      b.disabled = true;
      b.title = 'Transcription lands with #2.';
    }
    b.addEventListener('click', () => void runAction(li, () => rerun(rec.id)));
    actions.append(b);
  }
  if (inv.mediaBytes > 0) {
    actions.append(
      confirmButton(
        'Delete media',
        `Delete ${formatBytes(inv.mediaBytes)} of media?${rec.exportPath ? '' : ' It was never exported.'}`,
        'delete-media',
        () => void runAction(li, () => removeMedia(rec.id)),
      ),
    );
  }
  actions.append(
    confirmButton(
      'Delete',
      `Delete "${rec.title}"?${rec.exportPath ? ' The exported files stay.' : ''}`,
      'delete',
      () => void runAction(li, () => remove(rec.id)),
    ),
  );
  li.append(actions);
  return li;
}

function renderStorage(recs: Recording[], usage: StorageUsage): void {
  const known = new Set(recs.map((r) => r.id));
  const orphans = Object.keys(usage.files).filter((id) => !known.has(id));
  const orphanBytes = orphans.reduce((sum, id) => sum + (usage.perRecording[id] ?? 0), 0);
  $<HTMLElement>('#storage-usage').textContent =
    `Local storage: ${formatBytes(usage.total)}` +
    (orphans.length
      ? ` (${formatBytes(orphanBytes)} in ${plural(orphans.length, 'directory')} without a recording)`
      : '');
  const actions = $<HTMLElement>('#storage-actions');
  const targets = exportedWithMedia(recs, usage);
  if (targets.length === 0) {
    actions.replaceChildren();
    return;
  }
  const bytes = targets.reduce((sum, r) => sum + inventory(r, usage).mediaBytes, 0);
  const button = confirmButton(
    'Delete media for exported recordings',
    `Free ${formatBytes(bytes)} from ${plural(targets.length, 'exported recording')}?`,
    'delete-exported-media',
    () => void runAction(actions, removeExportedMedia),
  );
  button.title =
    'Deletes the video and audio in local storage of every recording whose files are in the export folder.';
  actions.replaceChildren(button);
}

// --- Render and live refresh --------------------------------------------------------------------
let rendering: Promise<void> | undefined;
let dirty = false;
let liveTimer: number | undefined;
/** What the list last rendered, so the live refresh can tell a status change from a tick. */
let signature = '';
let bound = false;

const signatureOf = (recs: Recording[]): string =>
  recs
    .map((r) => [r.id, r.status, r.exportPath, r.error, r.note, r.mediaDeleted].join('\u0001'))
    .join('\u0002');

function bindOnce(): void {
  if (bound) return;
  bound = true;
  // TODO(#2): onPipelineProgress(onProgress);
}

async function render(): Promise<void> {
  bindOnce();
  const [recs, usage] = await Promise.all([listRecordings(), storageUsage()]);
  $<HTMLUListElement>('#recordings-list').replaceChildren(
    ...recs.map((rec) => item(rec, inventory(rec, usage))),
  );
  $<HTMLElement>('#recordings-empty').hidden = recs.length > 0;
  renderStorage(recs, usage);
  signature = signatureOf(recs);
  setLive(recs.some((r) => r.status === 'recording' || r.status === 'transcribing'));
}

/** Re-read everything and rebuild the list. Concurrent calls coalesce into one more render. */
export function renderList(): Promise<void> {
  if (rendering) {
    dirty = true;
    return rendering;
  }
  rendering = (async () => {
    do {
      dirty = false;
      await render();
    } while (dirty);
  })().finally(() => {
    rendering = undefined;
  });
  return rendering;
}

function setLive(live: boolean): void {
  if (live && liveTimer === undefined)
    liveTimer = window.setInterval(() => void refreshLive(), LIVE_REFRESH_MS);
  if (!live && liveTimer !== undefined) {
    window.clearInterval(liveTimer);
    liveTimer = undefined;
  }
}

/** Once a second while something is live: a status change re-renders, otherwise the durations tick. */
async function refreshLive(): Promise<void> {
  if (rendering) return;
  const recs = await listRecordings();
  if (signatureOf(recs) !== signature) {
    await renderList();
    return;
  }
  for (const rec of recs) {
    if (rec.status !== 'recording') continue;
    const el = document.querySelector(`.recording-item[data-id="${CSS.escape(rec.id)}"] .duration`);
    if (el) el.textContent = formatDuration(Date.now() - rec.startedAt);
  }
}
