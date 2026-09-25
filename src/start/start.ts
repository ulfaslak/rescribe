// The start dialog: an overlay at the top right of the page the toolbar button was clicked on
// (an iframe the service worker injects, start/overlay.ts), or a small popup window where a page
// cannot host one; the service worker opens it on a toolbar click while nothing is being
// recorded (background.ts `onToggle`). What will be recorded (the tab the
// button was clicked on), which microphone, where it will be saved, and one Start Capture
// button. It starts nothing by itself: Start sends `start-capture` to the service worker, which
// holds the tab-capture grant from the click, and the window closes on its answer. The toolbar
// button again, or Escape, closes it and starts nothing. Its writes: the microphone choice into
// Settings, and the Settings folder handle from Change… (a picker inside its own click; in the
// overlay Chrome refuses pickers to a frame inside another site's page, so Change… there brings
// the Rescribe tab forward, whose Settings pick the folder).
import type {
  Message,
  PendingInfo,
  ProgressInfo,
  StartInfo,
  StartResult,
} from '../lib/messages.ts';
import { stepOf } from '../lib/progress.ts';
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
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
/** The one-time key the service worker put in the URL (background.ts `startKeyFor`). */
const key = params.get('k') ?? '';
const BACKGROUND_MS = 1000;
let starting = false;
/** In a page as an overlay (an iframe), not a window of its own. */
const embedded = window.top !== window;

/** Close the dialog: the overlay asks its page to take it out; the window closes itself. */
async function closeDialog(): Promise<void> {
  if (embedded) window.parent.postMessage({ rescribe: 'close' }, '*');
  else await closeThisWindow();
}

/**
 * Only a dialog the service worker opened shows anything: the page is web-accessible (the overlay
 * needs that), so any site could load it in a frame of its own; without the key the service worker
 * holds for this tab it stays blank and asks nothing of the app tab.
 */
async function issuedByRescribe(): Promise<boolean> {
  const name = `start:${tabId}`;
  try {
    return !!key && (await chrome.storage.session.get(name))[name] === key;
  } catch {
    return false;
  }
}

/** The overlay out of sight while a start runs: it is part of the page the capture records. */
function hideOverlay(hidden: boolean): void {
  if (embedded) window.parent.postMessage({ rescribe: hidden ? 'hide' : 'show' }, '*');
}

/** The overlay's iframe is as tall as the dialog: its page is told on every change. */
function reportSize(): void {
  const main = $<HTMLElement>('main');
  const post = (): void =>
    window.parent.postMessage(
      { rescribe: 'size', height: main.getBoundingClientRect().height },
      '*',
    );
  new ResizeObserver(post).observe(main);
  post();
}

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

/** The overlay's folder and microphones, from the app tab (messages.ts StartInfo); undefined until it answers. */
let startInfo: StartInfo | undefined;
let startInfoSeen = '';

async function describeFolder(): Promise<void> {
  if (embedded) {
    const name = startInfo?.folder;
    $<HTMLElement>('#folder').textContent = startInfo
      ? (name ?? 'No folder chosen yet')
      : 'Asking Rescribe…';
    $<HTMLElement>('#folder').title = name ?? 'Save asks for one when the recording ends';
    return;
  }
  const root = await getExportRoot();
  $<HTMLElement>('#folder').textContent = root ? root.name : 'No folder chosen yet';
  $<HTMLElement>('#folder').title = root ? root.name : 'Save asks for one when the recording ends';
}

/**
 * Change…: the Settings folder, picked here (the app tab, hidden, cannot); the app tab is told.
 * In the overlay the picker is refused, so the Rescribe tab comes forward to pick it in Settings;
 * the folder line follows on the next poll of the app tab.
 */
async function changeFolder(): Promise<void> {
  if (embedded) {
    status('Choose the folder under Settings in the Rescribe tab, then come back here.');
    void send({ type: 'focus-app' });
    return;
  }
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
  if (embedded && !startInfo) return;
  const settings = await loadSettings();
  await fillMicSelect(
    $<HTMLSelectElement>('#mic'),
    { mic: settings.micByDefault, micDeviceId: settings.micDeviceId },
    startInfo?.mics,
  );
  $<HTMLSelectElement>('#mic').disabled = false;
}

/**
 * The overlay's folder and microphones, asked of the app tab (which may still be booting) until it
 * answers, then again on every poll; the page is redrawn only when the answer changed, so an open
 * microphone list is not rebuilt under the pointer.
 */
async function refreshStartInfo(): Promise<void> {
  const info = await askApp<StartInfo>({ type: 'query-start-info' });
  if (!info) return;
  const seen = JSON.stringify(info);
  if (seen === startInfoSeen) return;
  startInfoSeen = seen;
  startInfo = info;
  await Promise.all([fillMics(), describeFolder()]);
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
    const at = busy.progress ? stepOf(busy.progress) : undefined;
    text.textContent = busy.saving
      ? `Saving “${busy.title}” in the background.`
      : `Transcribing “${busy.title}” in the background${at ? ` (step ${at.index} of ${at.count})` : ''}.`;
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
  hideOverlay(true);
  const res = (await send({
    type: 'start-capture',
    tabId,
    key,
    mic: choice.mic,
    micDeviceId: choice.micDeviceId,
  } satisfies Message)) as StartResult | undefined;
  if (res?.ok) {
    await closeDialog();
    return;
  }
  hideOverlay(false);
  status(res?.error ?? 'Rescribe did not answer; try again.', true);
  start.disabled = false;
  // Disabling the button dropped the focus; back on it, so Escape and Enter still reach the dialog.
  start.focus();
  starting = false;
}

async function main(): Promise<void> {
  if (embedded) document.documentElement.classList.add('embedded');
  if (!(await issuedByRescribe())) {
    // Not a dialog the service worker opened (a page loaded it, or the extension was reloaded
    // under it): nothing to show, nothing asked. A toolbar click opens a real one.
    $<HTMLElement>('main').replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent: 'Click the Rescribe button again.',
      }),
    );
    if (embedded) reportSize();
    return;
  }
  $<HTMLButtonElement>('#start').addEventListener('click', () => void onStart());
  $<HTMLButtonElement>('#change-folder').addEventListener('click', () => void changeFolder());
  $<HTMLSelectElement>('#mic').addEventListener('change', () => void onMicChange());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void closeDialog();
  });
  if (embedded) reportSize();
  else navigator.mediaDevices.addEventListener('devicechange', () => void fillMics());
  const ok = await describeTarget();
  await Promise.all([fillMics(), describeFolder()]);
  // The overlay's folder and microphones come from the app tab, which may still be booting (the
  // click opens it in the background); the one-liner follows it too, and its transcription may
  // end while the dialog is open.
  const poll = async (): Promise<void> => {
    if (embedded) await refreshStartInfo();
    await describeBackground();
  };
  await poll();
  setInterval(() => void poll(), BACKGROUND_MS);
  while (embedded && !startInfo) {
    await new Promise((r) => setTimeout(r, 200));
    await refreshStartInfo();
  }
  if (ok) {
    const start = $<HTMLButtonElement>('#start');
    start.disabled = false;
    start.focus();
  }
  // Ready for the e2e harness once the target, the microphones and the folder are shown.
  document.body.dataset['ready'] = 'true';
}

void main();
