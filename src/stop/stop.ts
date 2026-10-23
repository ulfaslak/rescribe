// The stop dialog: a small popup window the service worker opens on a toolbar click while a
// recording runs or waits `stopped`, and when the app tab asks (the call ended, the share ended).
// A view over the app tab's pending recording (`query-pending`) that asks what should happen to
// it: Save, Save with one of the routines the native host offers (ui/routines.ts; DECISIONS §
// Routines), or Discard. It sends one `decide` message and closes. It never touches the recorder
// or the records; its one write is the Settings folder when none is chosen yet, and its one
// prompt is the folder permission, requested inside its own click because the app tab, hidden
// behind the call, cannot prompt. Closing the window decides nothing: a live recording goes on.
// A save also opens the processing tab (progress/) at once, which follows the export, the
// transcription and the routine; this window stays until the export answers, says where the
// video went, and closes.
import { formatDuration } from '../lib/format.ts';
import type { DecideResult, Decision, PendingInfo } from '../lib/messages.ts';
import { send as post } from '../lib/messages.ts';
import { renderPathTemplate } from '../lib/pathtemplate.ts';
import type { RoutineInfo } from '../lib/routines.ts';
import { loadSettings } from '../lib/settings.ts';
import { ensureExportPermission, getExportRoot, setExportRoot } from '../storage/export.ts';
import { askApp } from '../ui/apptab.ts';
import { confirmButton } from '../ui/confirm.ts';
import { closeThisWindow } from '../ui/popup.ts';
import { folderMismatch, listRoutines } from '../ui/routines.ts';

const REFRESH_MS = 1000;
const CLOSE_AFTER_OK_MS = 1500;
const CLOSE_AFTER_ERROR_MS = 5000;
const CLOSE_AFTER_NOTHING_MS = 1200;

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

let info: PendingInfo | undefined;
/** Set once a decision was sent or the dialog is on its way out: no more refreshes. */
let finished = false;
/** Empty answers in a row; one is a hiccup (the app tab between two states), two is an answer. */
let misses = 0;
function query(): Promise<PendingInfo | undefined> {
  return askApp<PendingInfo>({ type: 'query-pending' });
}

async function close(): Promise<void> {
  finished = true;
  await closeThisWindow();
}

function status(text: string, isError = false): void {
  const el = $<HTMLElement>('#status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

/** Why the routines cannot run (the host is missing, the folder is not its own), or undefined. */
let routineBlocker: string | undefined;

function setEnabled(enabled: boolean): void {
  for (const b of document.querySelectorAll('button'))
    b.disabled = !enabled || (b.classList.contains('routine') && routineBlocker !== undefined);
}

/** The window as tall as what it shows: the routines are known only once the host answered. */
async function fitWindow(): Promise<void> {
  const want = document.documentElement.scrollHeight;
  if (Math.abs(want - window.innerHeight) < 4) return;
  try {
    const w = await chrome.windows.getCurrent();
    if (w.id === undefined || w.type !== 'popup') return; // "Show as tab": not ours to resize
    await chrome.windows.update(w.id, {
      height: window.outerHeight - window.innerHeight + want,
    });
  } catch {
    // the window is going away
  }
}

/**
 * One button per routine the host offers, under Save: the same save, and the routine once the
 * transcript is in the folder. None, and a line saying why, when the host cannot be asked;
 * disabled, with the reason, when the Settings folder is not the one the host reads.
 */
async function renderRoutines(): Promise<void> {
  const [list, root] = await Promise.all([listRoutines(), getExportRoot()]);
  const note = $<HTMLElement>('#routines-note');
  routineBlocker = list.error ?? folderMismatch(list, root?.name);
  // Said even when there are no routines to show: a host that stopped answering is news.
  note.hidden = routineBlocker === undefined;
  note.textContent = list.error ? `No routines: ${list.error}` : (routineBlocker ?? '');
  for (const routine of list.routines) {
    const b = document.createElement('button');
    b.className = 'choice routine';
    b.dataset['routine'] = routine.id;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = routine.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = routine.description ?? 'Save, transcribe, then run it';
    b.title = routineBlocker ?? `Save, transcribe, then: ${routine.description ?? routine.label}`;
    b.append(label, sub);
    b.disabled = true;
    b.addEventListener('click', () => void onSave(routine));
    $<HTMLElement>('#choices').append(b);
  }
  await fitWindow();
}

function render(): void {
  if (!info) return;
  $<HTMLElement>('#title').textContent = info.title;
  const state = $<HTMLElement>('#state');
  state.textContent = info.live ? 'recording' : 'ended';
  state.className = `pill ${info.live ? 'recording' : 'pending'}`;
  $<HTMLElement>('#elapsed').textContent = formatDuration(
    (info.endedAt ?? Date.now()) - info.startedAt,
  );
  $<HTMLElement>('#footer').textContent = info.live
    ? 'Closing this window keeps recording.'
    : 'Closing this window keeps it waiting in the Rescribe tab.';
}

/** Where Save will put it: the folder from Settings and the directory the template renders. */
async function describeDestination(): Promise<void> {
  if (!info) return;
  const where = $<HTMLElement>('#where');
  const root = await getExportRoot();
  if (!root) {
    where.textContent = 'No folder chosen yet: Save asks for one first.';
    return;
  }
  const settings = await loadSettings();
  const segments = renderPathTemplate(settings.pathTemplate, info);
  where.textContent = `Into ${root.name}/${segments.join('/')}/`;
  where.title = where.textContent;
}

/**
 * The pending recording again: the elapsed time ticks, `recording` becomes `ended` when the
 * stream dies under the open dialog, and the dialog closes when nothing is pending any more (a
 * decision made in the Rescribe tab, or nothing was recording in the first place).
 */
async function refresh(): Promise<void> {
  if (finished) return;
  const next = await query();
  if (finished) return;
  if (!next || (info && next.id !== info.id)) {
    if (++misses < 2) return;
    finished = true;
    if (!info) status('Nothing is recording.');
    setTimeout(() => void close(), info ? 0 : CLOSE_AFTER_NOTHING_MS);
    return;
  }
  misses = 0;
  const first = info === undefined;
  info = next;
  render();
  if (first) {
    await describeDestination();
    setEnabled(true);
    $<HTMLButtonElement>('#save').focus();
  }
}

async function send(action: Decision, routine?: RoutineInfo): Promise<void> {
  if (!info || finished) return;
  finished = true;
  setEnabled(false);
  status(action === 'discard' ? 'Discarding…' : 'Saving…');
  // A save: the processing tab opens now and follows the export, the transcription and the
  // routine; this window waits for the export's answer like a discard does, then closes. Not
  // closed at once: tearing the window down within milliseconds of a picker's handle being stored
  // crashed Chrome for Testing (ENVIRONMENT_NOTES), and the answer is worth its line here anyway.
  if (action !== 'discard') void post({ type: 'open-progress', id: info.id });
  const res = await askApp<DecideResult>({
    type: 'decide',
    id: info.id,
    action,
    ...(routine ? { routine } : {}),
  });
  if (!res) status('The Rescribe tab did not answer; it holds the recording.', true);
  else status(res.message, !res.ok);
  setTimeout(() => void close(), res?.ok ? CLOSE_AFTER_OK_MS : CLOSE_AFTER_ERROR_MS);
}

/**
 * Save, with a routine or without: the folder from Settings, chosen here first when there is none
 * (a routine is never offered then: the folder must be the host's); the permission inside this
 * click.
 */
async function onSave(routine?: RoutineInfo): Promise<void> {
  if (!info || finished) return;
  setEnabled(false);
  try {
    let root = await getExportRoot();
    if (!root) {
      root = await window.showDirectoryPicker({ id: 'rescribe-export', mode: 'readwrite' });
      await setExportRoot(root);
    }
    await ensureExportPermission();
  } catch (err) {
    setEnabled(true);
    if ((err as DOMException).name !== 'AbortError')
      status(`Could not choose a folder: ${String(err)}`, true);
    return;
  }
  await send('save', routine);
}

function main(): void {
  $<HTMLButtonElement>('#save').addEventListener('click', () => void onSave());
  const discard = confirmButton('Discard', 'Discard the recording?', 'discard', () => {
    void send('discard');
  });
  discard.id = 'discard';
  discard.disabled = true;
  $<HTMLElement>('#discard-slot').replaceWith(discard);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void close();
  });
  // The routines first: the buttons are enabled with Save, on the first answer from the app tab.
  void renderRoutines().then(() => {
    if (info && !finished) setEnabled(true);
  });
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

main();
