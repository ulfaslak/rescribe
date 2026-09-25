// The stop dialog: a small popup window the service worker opens on a toolbar click while a
// recording runs or waits `stopped`, and when the app tab asks (the call ended, the share ended).
// A view over the app tab's pending recording (`query-pending`) that sends one `decide` message
// and closes. It never touches the recorder or the records; its one write is the "Save as…"
// folder handle, stored under `export:<id>` for the app tab (storage/handles.ts), and its one
// prompt is the folder permission, requested inside its own click because the app tab, hidden
// behind the call, cannot prompt. Closing the window decides nothing: a live recording goes on.
// A save hands over to the processing tab (progress/): the decision is sent, the service worker
// is asked for the tab, and this window closes without waiting for the answer. Discard is
// answered here.
import { formatDuration } from '../lib/format.ts';
import type { DecideResult, Decision, Message, PendingInfo } from '../lib/messages.ts';
import { send as post } from '../lib/messages.ts';
import { renderPathTemplate } from '../lib/pathtemplate.ts';
import { loadSettings } from '../lib/settings.ts';
import { ensureExportPermission, getExportRoot, setExportRoot } from '../storage/export.ts';
import { setRecordingExportRoot } from '../storage/handles.ts';
import { askApp } from '../ui/apptab.ts';
import { confirmButton } from '../ui/confirm.ts';
import { closeThisWindow } from '../ui/popup.ts';

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

function setEnabled(enabled: boolean): void {
  for (const b of document.querySelectorAll('button')) b.disabled = !enabled;
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
  where.textContent = `Save to ${root.name}/${segments.join('/')}/`;
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

async function send(action: Decision): Promise<void> {
  if (!info || finished) return;
  finished = true;
  setEnabled(false);
  if (action !== 'discard') {
    // The processing tab takes over (the export may take a while, the transcription longer):
    // the decision goes out, the tab is asked for, and this window closes without waiting for
    // the answer; the tab shows the outcome, whatever it is. The decision is dispatched before
    // the round trip for the tab returns, and a closed sender loses nothing: the app tab acts on
    // the message, not on the answer.
    status('Saving…');
    void askApp({ type: 'decide', id: info.id, action });
    await post({ type: 'open-progress', id: info.id });
    await close();
    return;
  }
  status('Discarding…');
  const res = await askApp<DecideResult>({ type: 'decide', id: info.id, action });
  if (!res) status('The Rescribe tab did not answer; it holds the recording.', true);
  else status(res.message, !res.ok);
  setTimeout(() => void close(), res?.ok ? CLOSE_AFTER_OK_MS : CLOSE_AFTER_ERROR_MS);
}

/** Save: the folder from Settings, chosen here first when there is none; the permission inside this click. */
async function onSave(): Promise<void> {
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
  await send('save');
}

/** Save as…: a folder for this recording only; the Settings folder stays what it is. */
async function onSaveAs(): Promise<void> {
  if (!info || finished) return;
  setEnabled(false);
  try {
    const dir = await window.showDirectoryPicker({ id: 'rescribe-save-as', mode: 'readwrite' });
    await setRecordingExportRoot(info.id, dir);
  } catch (err) {
    setEnabled(true);
    if ((err as DOMException).name !== 'AbortError')
      status(`Could not choose a folder: ${String(err)}`, true);
    return;
  }
  await send('save-as');
}

function main(): void {
  $<HTMLButtonElement>('#save').addEventListener('click', () => void onSave());
  $<HTMLButtonElement>('#save-as').addEventListener('click', () => void onSaveAs());
  const discard = confirmButton('Discard', 'Discard the recording?', 'discard', () => {
    void send('discard');
  });
  discard.id = 'discard';
  discard.disabled = true;
  $<HTMLElement>('#discard-slot').replaceWith(discard);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void close();
  });
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

main();
