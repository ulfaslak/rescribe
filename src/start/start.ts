// The start dialog: a small popup window the service worker opens on a toolbar click while
// nothing is being recorded (background.ts `onToggle`). What will be recorded (the tab the
// button was clicked on), which microphone, where it will be saved, and one Start Capture
// button. It starts nothing by itself: Start sends `start-capture` to the service worker, which
// holds the tab-capture grant from the click, and the window closes on its answer. The toolbar
// button again, or Escape, closes it and starts nothing. Its writes: the microphone choice into
// Settings, and the Settings folder handle from Change… (a picker inside its own click).
import type { Message, PendingInfo, ProgressInfo, StartResult } from '../lib/messages.ts';
import { send } from '../lib/messages.ts';
import { loadSettings, saveSettings } from '../lib/settings.ts';
import { getExportRoot, setExportRoot } from '../storage/handles.ts';
import { askApp } from '../ui/apptab.ts';
import { fillMicSelect, micChoice } from '../ui/mics.ts';
import { closeThisWindow } from '../ui/popup.ts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

/** The tab the toolbar button was clicked on, from the URL the service worker opened. */
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const BACKGROUND_MS = 1000;
let starting = false;

function status(text: string, isError = false): void {
  const el = $<HTMLElement>('#status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

/** The tab to record, as it is now: its title and host. Gone: nothing to start. */
async function describeTarget(): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    $<HTMLElement>('#target-title').textContent = tab.title || 'This tab';
    $<HTMLElement>('#target-host').textContent = hostOf(tab.url);
    return true;
  } catch {
    $<HTMLElement>('#target-title').textContent = 'That tab is closed';
    $<HTMLElement>('#target-host').textContent = '';
    status('Open the tab you want to record and click the Rescribe button there.', true);
    return false;
  }
}

async function describeFolder(): Promise<void> {
  const root = await getExportRoot();
  $<HTMLElement>('#folder').textContent = root ? root.name : 'No folder chosen yet';
  $<HTMLElement>('#folder').title = root ? root.name : 'Save asks for one when the recording ends';
}

/** Change…: the Settings folder, picked here (the app tab, hidden, cannot); the app tab is told. */
async function changeFolder(): Promise<void> {
  try {
    const handle = await window.showDirectoryPicker({ id: 'rescribe-export', mode: 'readwrite' });
    await setExportRoot(handle);
    await describeFolder();
    status('');
    void send({ type: 'folder-changed' });
  } catch (err) {
    if ((err as DOMException).name !== 'AbortError')
      status(`Could not choose a folder: ${String(err)}`, true);
  }
}

async function fillMics(): Promise<void> {
  const settings = await loadSettings();
  await fillMicSelect($<HTMLSelectElement>('#mic'), {
    mic: settings.micByDefault,
    micDeviceId: settings.micDeviceId,
  });
  $<HTMLSelectElement>('#mic').disabled = false;
}

/** The microphone choice is a setting: the next dialog and "Record screen…" use it too. */
async function onMicChange(): Promise<void> {
  const choice = micChoice($<HTMLSelectElement>('#mic'));
  await saveSettings(
    choice.mic ? { micByDefault: true, micDeviceId: choice.micDeviceId } : { micByDefault: false },
  );
}

/**
 * What else Rescribe holds, in one line: a recording waiting to be saved, or one being saved or
 * transcribed in the background (the toolbar shows nothing for that). Each with a way there.
 */
async function describeBackground(): Promise<void> {
  const line = $<HTMLElement>('#background');
  const text = $<HTMLElement>('#background-text');
  const open = $<HTMLButtonElement>('#background-open');
  const pending = await askApp<PendingInfo>({ type: 'query-pending' });
  if (pending && !pending.live) {
    text.textContent = `“${pending.title}” is not saved yet.`;
    open.textContent = 'Open Rescribe';
    open.onclick = () => void send({ type: 'focus-app' });
    line.hidden = false;
    return;
  }
  const busy = await askApp<ProgressInfo>({ type: 'query-progress' });
  if (busy?.title) {
    text.textContent = busy.saving
      ? `Saving “${busy.title}” in the background.`
      : `Transcribing “${busy.title}” in the background.`;
    open.textContent = 'Show';
    open.onclick = () => void send({ type: 'open-progress', id: busy.id });
    line.hidden = false;
    return;
  }
  line.hidden = true;
}

/** Start Capture: the service worker starts the recording through the app tab; then close. */
async function onStart(): Promise<void> {
  if (starting) return;
  starting = true;
  const start = $<HTMLButtonElement>('#start');
  start.disabled = true;
  status('Starting…');
  const choice = micChoice($<HTMLSelectElement>('#mic'));
  const res = (await send({
    type: 'start-capture',
    tabId,
    mic: choice.mic,
    micDeviceId: choice.micDeviceId,
  } satisfies Message)) as StartResult | undefined;
  if (res?.ok) {
    await closeThisWindow();
    return;
  }
  status(res?.error ?? 'Rescribe did not answer; try again.', true);
  start.disabled = false;
  starting = false;
}

async function main(): Promise<void> {
  $<HTMLButtonElement>('#start').addEventListener('click', () => void onStart());
  $<HTMLButtonElement>('#change-folder').addEventListener('click', () => void changeFolder());
  $<HTMLSelectElement>('#mic').addEventListener('change', () => void onMicChange());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void closeThisWindow();
  });
  navigator.mediaDevices.addEventListener('devicechange', () => void fillMics());
  const ok = await describeTarget();
  await Promise.all([fillMics(), describeFolder()]);
  if (ok) {
    const start = $<HTMLButtonElement>('#start');
    start.disabled = false;
    start.focus();
  }
  // The one-liner follows the app tab, which may still be booting (the click opens it in the
  // background) and whose transcription may end while this window is open.
  void describeBackground();
  setInterval(() => void describeBackground(), BACKGROUND_MS);
  // Ready for the e2e harness once the target, the microphones and the folder are shown.
  document.body.dataset['ready'] = 'true';
}

void main();
