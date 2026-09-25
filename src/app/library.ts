// The recording library (ARCHITECTURE § Pipeline: "any stage can be re-run from the library").
// One row per Recording: an editable title, the status, what is still on disk, and the actions
// that work from OPFS (re-export, re-run transcription, delete media, delete). App-tab only.
//
// app.ts calls renderList() after every recorder phase change and every pipeline phase. Each
// render re-reads IndexedDB and walks `recordings/` in OPFS once: the walk is both the storage
// figure and each row's inventory, so a row only offers what it can actually do. A recording the
// recorder or the pipeline holds (`recording`, `transcribing`, or queued per `isTranscribing`) gets
// no actions and no pencil. While a row is live a 1 s refresh keeps its duration and status
// current without help from the recorder or the pipeline.
import { formatDuration } from '../lib/format.ts';
import { loadSettings } from '../lib/settings.ts';
import type { Recording } from '../lib/types.ts';
import { finalize } from '../recorder/recorder.ts';
import {
  ensureExportPermission,
  exportArtifacts,
  ExportError,
  exportedFileState,
  exportVideoName,
  getExportRoot,
  setRecordingExportRoot,
  type ExportedFileState,
} from '../storage/export.ts';
import { isExportableArtifact, isMediaFile, pcmFileName, videoFileName } from '../storage/opfs.ts';
import {
  deleteMedia,
  deleteRecording,
  getRecording,
  getVideoFile,
  listRecordings,
  storageUsage,
  updateRecording,
  type StorageUsage,
} from '../storage/store.ts';
import { confirmButton } from '../ui/confirm.ts';
import { decide, isDeciding } from './decide.ts';
import {
  isTranscribing,
  onPipelineProgress,
  transcribeRecording,
  type PipelineProgress,
} from './pipeline.ts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const LIVE_REFRESH_MS = 1000;

// --- Formatting ---------------------------------------------------------------------------------
export function describeSources(rec: Recording): string {
  const display = rec.sources.find((s) => s.channel === 'display');
  const mic = rec.sources.some((s) => s.channel === 'mic');
  return `${display?.kind ?? 'display'}${mic ? ' + mic' : ', no mic'}`;
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
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// --- What a recording still has on disk ---------------------------------------------------------
interface Inventory {
  video: boolean;
  pcm: boolean;
  /** The pipeline's per-channel recogniser output: a re-run can rebuild the transcript from it
   * after the media is gone. */
  segmentsCache: boolean;
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
    segmentsCache: Object.keys(files).some((n) => /^segments\.[a-z]+\.json$/.test(n)),
    artifacts: Object.keys(files).filter(isExportableArtifact).sort(),
    bytes: usage.perRecording[rec.id] ?? 0,
    mediaBytes: Object.entries(files)
      .filter(([n]) => isMediaFile(n))
      .reduce((sum, [, b]) => sum + b, 0),
  };
}

/**
 * The bulk candidates: `done` (video and transcript both exported), with an export path and media
 * present. A `recorded` row is never one: its audio is what a transcript would be made from. What
 * the pipeline or an action holds at click time, and whether each exported video actually exists,
 * is decided in `removeExportedMedia`, not here, so the button does not flicker as the pipeline
 * moves through the list.
 */
function exportedWithMedia(recs: Recording[], usage: StorageUsage): Recording[] {
  return recs.filter(
    (r) => r.exportPath !== undefined && r.status === 'done' && inventory(r, usage).mediaBytes > 0,
  );
}

/** Held by the recorder (`recording`), or by the pipeline: running (`transcribing` on disk) or
 * queued (`isTranscribing`, in memory and ahead of the status on disk). */
const live = (rec: Recording): boolean =>
  rec.status === 'recording' || rec.status === 'transcribing' || isTranscribing(rec.id);

// --- Transcription (steps 3–5 live in src/app/pipeline.ts) --------------------------------------
/** The pipeline's latest progress message per recording id, shown on its row while it is held. */
const progress = new Map<string, string>();

/** app.ts re-renders the list on every phase change; here the line of a row already rendered as
 * held is updated in place, and a row not yet rendered that way is rendered (coalesced). */
function onProgress(id: string, p: PipelineProgress): void {
  if (p.phase === 'done') {
    progress.delete(id);
    void renderList();
    return;
  }
  progress.set(id, p.message);
  const el = document.querySelector(`.recording-item[data-id="${CSS.escape(id)}"] .progress`);
  if (el) el.textContent = p.message;
  else void renderList();
}

/** Steps 3–5 again from what is on disk: the PCM, or the segments cache once the media is gone. */
async function rerun(id: string): Promise<Outcome> {
  const rec = await claim(id, 'run it again');
  if (typeof rec === 'string') return rec;
  const result = await transcribeRecording(id);
  if (result.status === 'failed')
    return fail(`Transcription failed: ${result.error ?? 'unknown error'}`);
  if (result.error) return fail(`Transcribed, but ${result.error}`);
  return `Transcript saved to ${result.exportPath ?? '?'}/.`;
}

// --- Actions ------------------------------------------------------------------------------------
/** What an action reports: a line for the status readout (a string is not an error), or nothing. */
type Outcome = string | { text: string; isError?: boolean } | undefined;

const fail = (text: string): Outcome => ({ text, isError: true });

function libraryNote(text: string, isError = false): void {
  const el = $<HTMLElement>('#library-status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

/**
 * Recording ids with an action in progress, and what it is. A row in here renders the label and
 * no buttons, whatever re-render happens meanwhile (a Re-export streams a multi-GB video for
 * minutes, and a rebuilt row with a live Delete button would pull the file out from under the
 * stream); `runAction` refuses a second action on the same id, and the bulk filter skips it.
 */
const inflight = new Map<string, string>();

/** Run an action: mark its ids in flight (the rows show `label`), report, unmark, re-render. */
async function runAction(
  ids: string[],
  label: string,
  scope: Element,
  fn: () => Promise<Outcome>,
): Promise<void> {
  const busy = ids.find((id) => inflight.has(id));
  if (busy) {
    libraryNote(`${inflight.get(busy) ?? 'An action'} is still running on that recording.`, true);
    return;
  }
  for (const b of scope.querySelectorAll('button')) b.disabled = true;
  for (const id of ids) inflight.set(id, label);
  void renderList();
  let out: Outcome;
  let failure: unknown;
  try {
    out = await fn();
  } catch (err) {
    failure = err;
  }
  for (const id of ids) inflight.delete(id);
  // The list is settled before the outcome is reported: a note that appears while a render is
  // still pending invites the next click onto a row about to be replaced (an armed button that a
  // re-render swaps for a fresh one leaves the confirming click arming again).
  await renderList();
  if (failure !== undefined)
    libraryNote(failure instanceof Error ? failure.message : String(failure), true);
  else if (typeof out === 'string') libraryNote(out);
  else if (out) libraryNote(out.text, out.isError);
}

/**
 * "Save now" and "Re-export", one action: the video through `finalize` unless it is already in its
 * directory, then every artifact in OPFS (transcript.md, transcript.json, meta.json) through
 * `exportArtifacts`, next to it. Works from the stored record, never while the recorder or the
 * pipeline holds the recording, and re-requests the folder permission first thing in the click
 * (after a browser restart the persisted handle is `prompt`; the recording's own folder when it
 * was saved with Save as…). `finalize` reuses `exportPath`, so a
 * folder the human deleted comes back at the same path. `error` is cleared only when both are in
 * the folder; a `done` recording stays `done`. A `failed` recording with a playable video (a chunk
 * lost late in a long call) is saved as `failed` and keeps its reason: what went wrong on export
 * goes to the status line, not the record.
 */
async function reExport(id: string): Promise<Outcome> {
  // The recording's own folder (Save as…) or the Settings folder: whichever it is exported under.
  await ensureExportPermission((await getRecording(id)) ?? undefined).catch(() => undefined);
  const claimed = await claim(id, 'save it');
  if (typeof claimed === 'string') return claimed;
  let rec = claimed;
  const failed = rec.status === 'failed';
  const reason = rec.error;
  const settings = await loadSettings();
  const written: string[] = [];
  const notExported = async (msg: string): Promise<Outcome> => {
    if (!failed) await updateRecording(rec.id, { error: msg });
    return fail(msg);
  };
  const artifactsFailed = async (err: unknown): Promise<Outcome> => {
    const msg = `Transcript not exported: ${describe(err)}`;
    if (!failed) await updateRecording(rec.id, { error: msg });
    return fail(
      written.length ? `Saved ${written.join(', ')} to ${rec.exportPath}/, but ${msg}` : msg,
    );
  };
  // 1. Artifacts next to a video already in the folder; `missing` means redo both. No folder or no
  //    permission stops everything and says so as an export failure, not a transcript one.
  let needVideo = !rec.exportPath;
  if (!needVideo) {
    try {
      written.push(...(await exportArtifacts(rec)).names);
    } catch (err) {
      if (!(err instanceof ExportError)) return artifactsFailed(err);
      if (err.reason === 'missing') needVideo = true;
      else if (err.reason === 'io') return artifactsFailed(err);
      else return notExported(`Not exported: ${err.message}`);
    }
  }
  // 2. The video first, then the artifacts, when the folder does not have the video.
  if (needVideo) {
    const video = await getVideoFile(rec.id, rec.container);
    if (!video || video.size === 0)
      return notExported("Not exported: the video is no longer in Rescribe's storage.");
    rec = await finalize(rec, settings.pathTemplate);
    if (failed && reason !== rec.error) {
      // finalize reports through `error`; a failed recording's `error` is its failure reason.
      const exportError = rec.error;
      rec = await updateRecording(rec.id, { error: reason });
      if (!rec.exportPath) return fail(`Still not saved: ${exportError ?? '?'}`);
    } else if (!rec.exportPath) return fail(`Still not saved: ${rec.error ?? '?'}`);
    written.push(exportVideoName(rec.container));
    try {
      written.push(...(await exportArtifacts(rec)).names);
    } catch (err) {
      return artifactsFailed(err);
    }
  }
  if (!failed && rec.error) rec = await updateRecording(rec.id, { error: undefined });
  return written.length
    ? `Saved ${written.join(', ')} to ${rec.exportPath}/.`
    : `${rec.exportPath}/ is up to date: ${exportVideoName(rec.container)} is there and there is no transcript to save yet.`;
}

/**
 * The record as it is now, not as the row was rendered: a recording the recorder or the pipeline
 * has taken since (`recording`, `transcribing`, or queued behind another one, which the status on
 * disk may not say yet), or one waiting for its decision (`stopped`, or a decision in flight),
 * must not have its files touched.
 */
async function claim(id: string, what: string): Promise<Recording | string> {
  const rec = await getRecording(id);
  if (!rec) return 'That recording no longer exists.';
  const held =
    rec.status === 'recording' || rec.status === 'transcribing'
      ? rec.status
      : rec.status === 'stopped' || isDeciding(rec.id)
        ? 'waiting to be saved or discarded'
        : isTranscribing(rec.id)
          ? 'queued for transcription'
          : undefined;
  if (held) return `"${rec.title}" is ${held}; ${what} once it is done.`;
  return rec;
}

// --- The decision on a stopped recording (app/decide.ts) ----------------------------------------
/** Save into the folder from Settings; the permission is re-requested inside the click. */
async function saveStopped(id: string): Promise<Outcome> {
  await ensureExportPermission().catch(() => undefined);
  const rec = await decide(id, 'save');
  return savedOutcome(rec);
}

/** Save as…: Chrome's folder picker inside the click, the handle stored for this recording only. */
async function saveStoppedAs(id: string): Promise<Outcome> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker({ id: 'rescribe-save-as', mode: 'readwrite' });
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return undefined;
    return fail(`Could not choose a folder: ${describe(err)}`);
  }
  await setRecordingExportRoot(id, dir);
  const rec = await decide(id, 'save-as');
  return savedOutcome(rec);
}

function savedOutcome(rec: Recording | undefined): Outcome {
  if (!rec) return undefined;
  if (rec.error) return fail(`Recorded, but ${rec.error}`);
  return `Saved to ${rec.exportRoot ? `${rec.exportRoot}/` : ''}${rec.exportPath}/.`;
}

async function discardStopped(id: string): Promise<Outcome> {
  const rec = await getRecording(id);
  await decide(id, 'discard');
  return `Discarded "${rec?.title ?? id}". Nothing was exported.`;
}

/** Why the exported video could not be confirmed, for a refusal line. */
function explainExport(state: Exclude<ExportedFileState, 'present'>, rec: Recording): string {
  switch (state) {
    case 'missing':
      return `${rec.exportPath}/${exportVideoName(rec.container)} is not in the export folder (deleted, or the folder was moved). Re-export first.`;
    case 'no-folder':
      return 'No export folder chosen in Settings.';
    case 'permission':
      return 'Rescribe may not read the export folder; allow it and try again.';
  }
}

/**
 * Delete the local media of one recording. When the record says it was exported, the exported
 * video must be present right now (deleted in Finder, folder moved, permission not granted after
 * a restart: any of these would make this the only copy); a recording never exported was warned
 * about in the confirm.
 */
async function removeMedia(id: string): Promise<Outcome> {
  // Inside the click, for the prompt; the recording's own folder when it has one.
  await ensureExportPermission((await getRecording(id)) ?? undefined).catch(() => undefined);
  const rec = await claim(id, 'delete its media');
  if (typeof rec === 'string') return rec;
  if (rec.exportPath) {
    const state = await exportedFileState(rec);
    if (state !== 'present') return fail(`Media kept: ${explainExport(state, rec)}`);
  }
  const freed = await deleteMedia(id);
  const kept = rec.exportPath ? `; ${rec.exportPath}/ is untouched` : '';
  return `Deleted ${formatBytes(freed)} of media for "${rec.title}"${kept}.`;
}

async function remove(id: string): Promise<Outcome> {
  const rec = await claim(id, 'delete it');
  if (typeof rec === 'string') return rec;
  await deleteRecording(id);
  const kept = rec.exportPath ? `; ${rec.exportPath}/ is untouched` : '';
  return `Deleted "${rec.title}" from Rescribe${kept}.`;
}

let bulkRunning = false;

/**
 * The bulk target set is re-computed from the store at click time, never from the rendered list:
 * a candidate the pipeline holds (running or queued) or an action of ours is on is left alone and
 * counted, and each target's exported video is looked up before its media goes: a missing one is
 * kept and named. No folder, or no permission to look, refuses the whole run.
 */
async function removeExportedMedia(): Promise<Outcome> {
  await ensureExportPermission().catch(() => undefined);
  const [recs, usage] = await Promise.all([listRecordings(), storageUsage()]);
  // Held: by the pipeline (running or queued; the status on disk says `transcribing` from the
  // enqueue, `isTranscribing` says it a moment earlier) or by an action of ours.
  const withMedia = recs.filter(
    (r) => r.exportPath !== undefined && inventory(r, usage).mediaBytes > 0,
  );
  const held = withMedia.filter(
    (r) => r.status === 'transcribing' || isTranscribing(r.id) || inflight.has(r.id),
  );
  const targets = exportedWithMedia(recs, usage).filter((r) => !held.includes(r));
  if (targets.length === 0) {
    if (held.length === 0) return 'Nothing to delete: no exported recording has media left.';
    return fail(
      `Nothing deleted: ${plural(held.length, 'recording')} ${held.length === 1 ? 'is' : 'are'} being transcribed or exported; try again when done.`,
    );
  }
  const root = await getExportRoot();
  if (!root) return fail('Nothing deleted: no export folder chosen in Settings.');
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted')
    return fail(
      'Nothing deleted: Rescribe may not read the export folder; allow it and try again.',
    );
  bulkRunning = true;
  for (const rec of targets) inflight.set(rec.id, 'Deleting media…');
  try {
    let freed = 0;
    let deleted = 0;
    const kept: string[] = [];
    for (const rec of targets) {
      const state = await exportedFileState(rec);
      if (state !== 'present') {
        kept.push(`${rec.exportPath}/`);
        continue;
      }
      freed += await deleteMedia(rec.id);
      deleted++;
    }
    const keptText = kept.length
      ? ` Kept the media of ${plural(kept.length, 'recording')} whose exported video is missing: ${kept.join(', ')}. Re-export first.`
      : '';
    const heldText = held.length
      ? ` Left ${plural(held.length, 'recording')} being transcribed or exported alone.`
      : '';
    if (deleted === 0) return fail(`Nothing deleted.${keptText}${heldText}`);
    return `Freed ${formatBytes(freed)}: media deleted for ${plural(deleted, 'exported recording')}; the exported files remain.${keptText}${heldText}`;
  } finally {
    for (const rec of targets) inflight.delete(rec.id);
    bulkRunning = false;
  }
}

// --- Widgets ------------------------------------------------------------------------------------
/** The id whose title is being edited. While set, `renderList` defers: a wholesale re-render would
 * remove the focused input, Chromium fires `blur` on removal, and blur saves a half-typed title. */
let editing: string | undefined;

function editTitle(row: HTMLLIElement, rec: Recording): void {
  const titleRow = row.querySelector('.title-row');
  if (!titleRow || editing) return;
  editing = rec.id;
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
    editing = undefined;
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

  const busy = inflight.get(rec.id);
  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';
  titleRow.append(span('title', rec.title));
  // No pencil while the recorder or the pipeline holds the record (their writers carry the title
  // from their start), nor while an action of ours runs on it.
  if (!live(rec) && !busy) {
    const rename = document.createElement('button');
    rename.className = 'rename';
    rename.type = 'button';
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.setAttribute('aria-label', 'Rename');
    rename.addEventListener('click', () => editTitle(li, rec));
    titleRow.append(rename);
  }

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

  if (rec.exportPath)
    li.append(div('path', `${rec.exportRoot ? `${rec.exportRoot}/` : ''}${rec.exportPath}/`));
  if (rec.status === 'transcribing' || isTranscribing(rec.id))
    li.append(
      div(
        'progress',
        progress.get(rec.id) ??
          (rec.status === 'transcribing' ? 'Transcribing…' : 'Queued for transcription…'),
      ),
    );
  if (rec.error) li.append(div('hint error', rec.error));
  if (rec.note) li.append(div('hint', rec.note));
  if (rec.mediaDeleted)
    li.append(
      div('hint media-deleted', 'Media deleted from local storage; the exported files remain.'),
    );

  if (live(rec)) return li;
  if (busy) {
    li.append(div('progress busy', busy));
    return li;
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (rec.status === 'stopped') {
    // Waiting for the human: the same three choices as the stop dialog, nothing else. Nothing
    // has been exported and nothing is transcribed until one of them is clicked.
    li.append(
      div('hint pending', 'Not saved yet: save it, save it into another folder, or discard it.'),
    );
    const save = document.createElement('button');
    save.className = 'save';
    save.textContent = 'Save';
    save.title = 'Save the video into the export folder from Settings and transcribe it';
    save.addEventListener(
      'click',
      () => void runAction([rec.id], 'Saving…', li, () => saveStopped(rec.id)),
    );
    const saveAs = document.createElement('button');
    saveAs.className = 'save-as';
    saveAs.textContent = 'Save as…';
    saveAs.title = 'Choose a folder for this recording only; the Settings folder stays';
    saveAs.addEventListener(
      'click',
      () => void runAction([rec.id], 'Saving…', li, () => saveStoppedAs(rec.id)),
    );
    actions.append(
      save,
      saveAs,
      confirmButton(
        'Discard',
        `Discard "${rec.title}"? Nothing was exported.`,
        'discard',
        () => void runAction([rec.id], 'Discarding…', li, () => discardStopped(rec.id)),
      ),
    );
    li.append(actions);
    return li;
  }
  // Whatever is on disk can be saved, a failed recording's playable video included.
  const exportable = inv.video || inv.artifacts.length > 0;
  if (exportable) {
    // One action, two names: "Save now" while something is not in the folder (no path yet, or an
    // export error on a row that did not fail), "Re-export" when everything is there already.
    const needsSave = !rec.exportPath || (rec.status !== 'failed' && !!rec.error);
    const b = document.createElement('button');
    b.className = needsSave ? 'save-now' : 're-export';
    b.textContent = needsSave ? 'Save now' : 'Re-export';
    b.title = needsSave
      ? 'Save the video and the transcript files into the export folder'
      : `Write ${[inv.video ? exportVideoName(rec.container) : '', ...inv.artifacts].filter(Boolean).join(', ')} into ${rec.exportPath}/ again`;
    b.addEventListener(
      'click',
      () => void runAction([rec.id], 'Exporting…', li, () => reExport(rec.id)),
    );
    actions.append(b);
  }
  if (inv.pcm || inv.segmentsCache) {
    const b = document.createElement('button');
    b.className = 'rerun';
    b.textContent = rec.status === 'done' ? 'Re-run transcription' : 'Transcribe';
    b.title = inv.pcm
      ? 'Transcribe each channel again and rebuild the transcript'
      : 'Rebuild the transcript from the kept recogniser output; the audio is gone';
    b.addEventListener(
      'click',
      () => void runAction([rec.id], 'Transcribing…', li, () => rerun(rec.id)),
    );
    actions.append(b);
  }
  if (inv.mediaBytes > 0) {
    // A recording without a transcript loses the audio a transcript would be made from.
    const consequence =
      (rec.status === 'done' ? '' : ' Without the audio it cannot be transcribed.') +
      (rec.exportPath ? '' : ' It was never exported.');
    actions.append(
      confirmButton(
        'Delete media',
        `Delete ${formatBytes(inv.mediaBytes)} of media?${consequence}`,
        'delete-media',
        () => void runAction([rec.id], 'Deleting media…', li, () => removeMedia(rec.id)),
      ),
    );
  }
  actions.append(
    confirmButton(
      'Delete',
      `Delete "${rec.title}"?${rec.exportPath ? ' The exported files stay.' : ''}`,
      'delete',
      () => void runAction([rec.id], 'Deleting…', li, () => remove(rec.id)),
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
  if (bulkRunning) {
    actions.replaceChildren(span('progress busy', 'Deleting media…'));
    return;
  }
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
    () => void runAction([], 'Deleting media…', actions, removeExportedMedia),
  );
  button.title =
    'Deletes the video and audio kept in the browser for every recording whose video and transcript are in the export folder.';
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
    .map((r) =>
      [r.id, r.status, r.exportPath, r.error, r.note, r.mediaDeleted, r.transcribedAt].join(
        '\u0001',
      ),
    )
    .join('\u0002');

function bindOnce(): void {
  if (bound) return;
  bound = true;
  onPipelineProgress(onProgress);
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
  setLive(recs.some(live));
}

/**
 * Re-read everything and rebuild the list. Concurrent calls coalesce into one more render. While
 * a title is being edited nothing is rebuilt (see `editing`); the edit's finish renders.
 */
export function renderList(): Promise<void> {
  if (editing) return Promise.resolve();
  if (rendering) {
    dirty = true;
    return rendering;
  }
  rendering = (async () => {
    try {
      do {
        dirty = false;
        await render();
      } while (dirty);
    } catch (err) {
      // Never reject: every caller fires and forgets, and a list that stopped refreshing with
      // no word is worse than a stale row with one.
      libraryNote(
        `The list could not be refreshed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
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
