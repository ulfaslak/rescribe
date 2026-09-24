// The app tab. Owns all state: the recorder, storage, settings, the library list. The service
// worker only pokes it with messages. See ARCHITECTURE § Runtime topology.
import type { AppStatus, Message } from '../lib/messages.ts';
import { send } from '../lib/messages.ts';
import { loadSettings, saveSettings } from '../lib/settings.ts';
import type { Recording, Settings } from '../lib/types.ts';
import {
  captureDisplay,
  captureMic,
  captureTab,
  CaptureCancelled,
  stopAll,
} from '../recorder/capture.ts';
import type { Captured } from '../recorder/capture.ts';
import { Recorder, recoverInterrupted } from '../recorder/recorder.ts';
import { ensureExportPermission, getExportRoot, setExportRoot } from '../storage/export.ts';
import { listRecordings } from '../storage/store.ts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

let status: AppStatus = 'idle';
let recorder: Recorder | undefined;
let starting = false;
let ticker: number | undefined;

function setStatus(next: AppStatus): void {
  status = next;
  const pill = $<HTMLSpanElement>('#status');
  pill.textContent = next;
  pill.className = `pill ${next === 'recording' ? 'recording' : next === 'transcribing' ? 'processing' : ''}`;
  $<HTMLButtonElement>('#stop').disabled = next !== 'recording';
  $<HTMLButtonElement>('#record-screen').disabled = next !== 'idle';
  void send({
    type: 'badge',
    state: next === 'recording' ? 'recording' : next === 'transcribing' ? 'processing' : 'idle',
  });
}

function note(text: string, isError = false): void {
  const el = $<HTMLElement>('#record-status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

// --- Messages from the service worker and content scripts ---------------------------------
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg.type) {
    case 'query-status':
      sendResponse(status);
      return false;
    case 'toggle-recording':
      void onToggleRecording(msg);
      return false;
    case 'speaker':
    case 'roster':
    case 'adapter-diagnostic':
      console.info('[rescribe] adapter', msg);
      return false;
    default:
      return false;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (status !== 'idle') e.preventDefault();
});

// --- Recording ----------------------------------------------------------------------------
function describeSources(rec: Recording): string {
  const display = rec.sources.find((s) => s.channel === 'display');
  const mic = rec.sources.some((s) => s.channel === 'mic');
  return `${display?.kind ?? 'display'}${mic ? ' + mic' : ', no mic'}`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function tick(): void {
  const rec = recorder?.recording;
  if (!rec || rec.status !== 'recording') return;
  note(`Recording ${formatDuration(Date.now() - rec.startedAt)} · ${describeSources(rec)}`);
}

/** Toolbar button or keyboard command: the service worker obtained a tab-capture stream id. */
async function onToggleRecording(
  msg: Extract<Message, { type: 'toggle-recording' }>,
): Promise<void> {
  if (status !== 'idle' || starting) return;
  if (!msg.streamId) {
    note(
      `Couldn't capture that tab${msg.error ? ` (${msg.error})` : ''}. Use "Record screen…" and pick it instead.`,
      true,
    );
    return;
  }
  let display: Captured;
  try {
    display = await captureTab(msg.streamId, msg.tabTitle);
  } catch (err) {
    note(`Couldn't capture that tab: ${String(err)}`, true);
    return;
  }
  await startRecording(display, msg.tabTitle || 'Tab recording');
}

/** "Record screen…": Chrome's picker, from a click in this tab. */
async function onRecordScreen(): Promise<void> {
  if (status !== 'idle' || starting) return;
  let display: Captured;
  try {
    display = await captureDisplay();
  } catch (err) {
    if (err instanceof CaptureCancelled) note('');
    else note(`Couldn't start: ${String(err)}`, true);
    return;
  }
  await startRecording(display, 'Screen recording');
}

async function startRecording(display: Captured, title: string): Promise<void> {
  if (status !== 'idle' || starting) {
    stopAll(display.stream);
    return;
  }
  starting = true;
  try {
    const settings = await loadSettings();
    const wantMic = $<HTMLInputElement>('#mic').checked;
    const mic = wantMic ? await captureMic() : undefined;
    if (wantMic && !mic) note('Microphone unavailable; recording without it.', true);
    recorder = await Recorder.start(
      {
        display,
        mic,
        title,
        container: settings.container,
        pathTemplate: settings.pathTemplate,
        note: wantMic && !mic ? 'Microphone unavailable at start; recorded without it.' : undefined,
      },
      onRecorderChange,
    );
  } catch (err) {
    note(`Couldn't start: ${err instanceof Error ? err.message : String(err)}`, true);
    setStatus('idle');
  } finally {
    starting = false;
  }
}

function onRecorderChange(
  rec: Recording,
  phase: 'recording' | 'stopping' | 'exporting' | 'done',
): void {
  switch (phase) {
    case 'recording':
      setStatus('recording');
      window.clearInterval(ticker);
      ticker = window.setInterval(tick, 1000);
      tick();
      break;
    case 'stopping':
      window.clearInterval(ticker);
      setStatus('recorded');
      note('Finishing…');
      break;
    case 'exporting':
      note(`Saving ${rec.container === 'mp4' ? 'recording.mp4' : 'recording.webm'}…`);
      break;
    case 'done':
      recorder = undefined;
      setStatus('idle');
      if (rec.status === 'failed') note(`Recording failed: ${rec.error ?? 'unknown error'}`, true);
      else if (rec.error) note(`Recorded, but ${rec.error}`, true);
      else note(`Saved to ${rec.exportPath ?? '?'}/`);
      break;
  }
  void renderList();
}

async function onStop(): Promise<void> {
  const r = recorder;
  if (!r) return;
  // Inside the click: the folder permission prompt needs a user gesture.
  await ensureExportPermission().catch(() => undefined);
  await r.stop();
}

// --- Library (plain list; #4 grows it) ---------------------------------------------------------
function item(rec: Recording): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'recording-item';
  li.dataset['id'] = rec.id;
  li.dataset['status'] = rec.status;
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = rec.title;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const when = document.createElement('span');
  when.textContent = new Date(rec.startedAt).toLocaleString();
  const dur = document.createElement('span');
  dur.textContent = formatDuration((rec.endedAt ?? Date.now()) - rec.startedAt);
  const src = document.createElement('span');
  src.textContent = describeSources(rec);
  const pill = document.createElement('span');
  pill.className = `pill ${rec.status}`;
  pill.textContent = rec.status;
  meta.append(when, dur, src, pill);
  li.append(title, meta);
  if (rec.exportPath) {
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = `${rec.exportPath}/`;
    li.append(path);
  }
  for (const [text, cls] of [
    [rec.error, 'hint error'],
    [rec.note, 'hint'],
  ] as const) {
    if (!text) continue;
    const p = document.createElement('div');
    p.className = cls;
    p.textContent = text;
    li.append(p);
  }
  return li;
}

async function renderList(): Promise<void> {
  const recs = await listRecordings();
  $<HTMLUListElement>('#recordings-list').replaceChildren(...recs.map(item));
  $<HTMLElement>('#recordings-empty').hidden = recs.length > 0;
}

// --- Settings -----------------------------------------------------------------------------
async function describeFolder(): Promise<void> {
  const name = $<HTMLOutputElement>('#folder-name');
  const hint = $<HTMLElement>('#folder-hint');
  const handle = await getExportRoot();
  if (!handle) {
    name.textContent = 'No folder chosen';
    hint.textContent = '';
    return;
  }
  name.textContent = handle.name;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  hint.textContent =
    perm === 'granted' ? '' : 'Chrome will ask for permission again on the next export.';
}

async function chooseFolder(): Promise<void> {
  const hint = $<HTMLElement>('#folder-hint');
  try {
    const handle = await window.showDirectoryPicker({ id: 'rescribe-export', mode: 'readwrite' });
    await setExportRoot(handle);
    await describeFolder();
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') {
      hint.textContent =
        'Picker closed without a folder (AbortError). If you did pick one, report this: HUMAN_TODO.';
    } else {
      hint.textContent = `Could not choose folder: ${String(err)}`;
    }
  }
}

function bindSettings(settings: Settings): void {
  const form = $<HTMLFormElement>('#settings-form');
  const fields = form.elements;
  (fields.namedItem('pathTemplate') as HTMLInputElement).value = settings.pathTemplate;
  (fields.namedItem('myName') as HTMLInputElement).value = settings.myName;
  (fields.namedItem('container') as HTMLSelectElement).value = settings.container;
  (fields.namedItem('micByDefault') as HTMLInputElement).checked = settings.micByDefault;
  (fields.namedItem('model') as HTMLSelectElement).value = settings.model;
  $<HTMLInputElement>('#mic').checked = settings.micByDefault;

  let timer: number | undefined;
  form.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const data = new FormData(form);
      await saveSettings({
        pathTemplate: String(data.get('pathTemplate') || '{date} {time} {title}'),
        myName: String(data.get('myName') || 'Me'),
        container: data.get('container') === 'webm' ? 'webm' : 'mp4',
        micByDefault: data.get('micByDefault') === 'on',
        model: String(data.get('model') || settings.model),
      });
      const saved = $<HTMLElement>('#settings-saved');
      saved.textContent = 'Saved.';
      window.setTimeout(() => (saved.textContent = ''), 1500);
    }, 300);
  });
}

async function main(): Promise<void> {
  setStatus('idle');
  const settings = await loadSettings();
  bindSettings(settings);
  $<HTMLButtonElement>('#choose-folder').addEventListener('click', () => void chooseFolder());
  $<HTMLButtonElement>('#record-screen').addEventListener('click', () => void onRecordScreen());
  $<HTMLButtonElement>('#stop').addEventListener('click', () => void onStop());
  await describeFolder();
  await renderList();
  const recovered = await recoverInterrupted(settings.pathTemplate);
  if (recovered.length > 0) {
    note(`Recovered ${recovered.length} interrupted recording${recovered.length > 1 ? 's' : ''}.`);
    await renderList();
  }
}

void main();
