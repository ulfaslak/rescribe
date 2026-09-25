// The stop dialog: a small popup window the service worker opens on a toolbar click while a
// recording runs or waits `stopped`, and when the app tab asks (the call ended, the share ended).
// A view over the app tab's pending recording (`query-pending`) that sends one `decide` message
// and closes. It never touches the recorder or the records; its one write is the "Save as…"
// folder handle, stored under `export:<id>` for the app tab (storage/handles.ts), and its one
// prompt is the folder permission, requested inside its own click because the app tab, hidden
// behind the call, cannot prompt. Closing the window decides nothing: a live recording goes on.
import { formatDuration } from '../lib/format.ts';
import type { DecideResult, Decision, Message, PendingInfo } from '../lib/messages.ts';
import { renderPathTemplate } from '../lib/pathtemplate.ts';
import { loadSettings } from '../lib/settings.ts';
import { ensureExportPermission, getExportRoot, setExportRoot } from '../storage/export.ts';
import { setRecordingExportRoot } from '../storage/handles.ts';
import { confirmButton } from '../ui/confirm.ts';

const APP_URL = chrome.runtime.getURL('app/app.html');
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
/** The owning app tab, once found. */
let appTabId: number | undefined;

/**
 * The app tab that owns the recorder: the one that answers `query-status` (a duplicate never
 * listens). Messages go to it by tab id, as the service worker's do (background.ts
 * `tabStatus`), not broadcast: a broadcast would also reach the service worker and any
 * duplicate app tab, and only the owner may answer for the recording.
 */
async function appTab(): Promise<number | undefined> {
  if (appTabId !== undefined) return appTabId;
  for (const t of await chrome.tabs.query({ url: APP_URL })) {
    if (t.id === undefined) continue;
    const status = await chrome.tabs
      .sendMessage(t.id, { type: 'query-status' } satisfies Message)
      .catch(() => undefined);
    if (status !== undefined) {
      appTabId = t.id;
      return t.id;
    }
  }
  return undefined;
}

/** Ask the owning app tab; undefined when there is none or it does not answer. */
async function ask<T>(msg: Message): Promise<T | undefined> {
  const id = await appTab();
  if (id === undefined) return undefined;
  try {
    return (await chrome.tabs.sendMessage(id, msg)) as T | undefined;
  } catch {
    appTabId = undefined;
    return undefined;
  }
}

function query(): Promise<PendingInfo | undefined> {
  return ask<PendingInfo>({ type: 'query-pending' });
}

async function close(): Promise<void> {
  finished = true;
  try {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) await chrome.windows.remove(win.id);
    else window.close();
  } catch {
    window.close();
  }
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
  status(action === 'discard' ? 'Discarding…' : 'Saving…');
  const res = await ask<DecideResult>({ type: 'decide', id: info.id, action });
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
