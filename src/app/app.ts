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
import { exportVideoName, finalize, Recorder, recoverInterrupted } from '../recorder/recorder.ts';
import { ensureExportPermission, getExportRoot, setExportRoot } from '../storage/export.ts';
import { listRecordings } from '../storage/store.ts';
import {
  isPipelineBusy,
  onPipelineProgress,
  recoverInterruptedTranscriptions,
  transcribeRecording,
} from './pipeline.ts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

let status: AppStatus = 'idle';
let recorder: Recorder | undefined;
/** The tab a toolbar recording captures; adapter events from other tabs are not its events. */
let recordedTabId: number | undefined;
let starting = false;
let ticker: number | undefined;

/**
 * `status` is the recorder's state and what `query-status` answers, so a toolbar click can still
 * start a recording while a transcription runs. The pill and the badge show that transcription
 * when nothing is being recorded.
 */
function setStatus(next: AppStatus): void {
  status = next;
  refreshStatus();
}

function refreshStatus(): void {
  const shown: AppStatus = status === 'idle' && isPipelineBusy() ? 'transcribing' : status;
  const pill = $<HTMLSpanElement>('#status');
  pill.textContent = shown;
  pill.className = `pill ${shown === 'recording' ? 'recording' : shown === 'transcribing' ? 'processing' : ''}`;
  $<HTMLButtonElement>('#stop').disabled = status !== 'recording';
  $<HTMLButtonElement>('#record-screen').disabled = status !== 'idle';
  void send({
    type: 'badge',
    state: shown === 'recording' ? 'recording' : shown === 'transcribing' ? 'processing' : 'idle',
  });
}

function note(text: string, isError = false): void {
  const el = $<HTMLElement>('#record-status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

// --- Messages from the service worker and content scripts ---------------------------------
// Registered by main() only in the tab that owns the recorder; a duplicate tab never listens.
function onMessage(
  msg: Message,
  sender: chrome.runtime.MessageSender,
  sendResponse: (res: AppStatus) => void,
): boolean {
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
      // Into events.jsonl, stamps as received, while a recording runs; the pipeline reads the
      // file back (lib/assemble.ts). Outside a recording there is nothing to attach them to. A
      // toolbar recording captures one tab, so a Meet call idling in another tab is not its
      // evidence; a picker recording (a window, the screen) cannot tell and takes every tab's.
      if (recorder && status === 'recording') {
        const from = sender.tab?.id;
        if (recordedTabId !== undefined && from !== undefined && from !== recordedTabId) {
          console.info('[rescribe] adapter message from another tab', msg);
          return false;
        }
        recorder.appendEvent(msg);
        if (msg.type === 'adapter-diagnostic') recorder.addNote(`Meet adapter: ${msg.message}`);
      } else {
        console.info('[rescribe] adapter message outside a recording', msg);
      }
      return false;
    default:
      return false;
  }
}

window.addEventListener('beforeunload', (e) => {
  if (status !== 'idle' || isPipelineBusy()) e.preventDefault();
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
  await startRecording(display, msg.tabTitle || 'Tab recording', msg.tabId);
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

async function startRecording(display: Captured, title: string, tabId?: number): Promise<void> {
  if (status !== 'idle' || starting) {
    stopAll(display.stream);
    return;
  }
  starting = true;
  recordedTabId = tabId;
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
    recordedTabId = undefined;
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
      note(`Saving ${exportVideoName(rec.container)}…`);
      break;
    case 'done':
      recorder = undefined;
      recordedTabId = undefined;
      setStatus('idle');
      if (rec.status === 'failed') note(`Recording failed: ${rec.error ?? 'unknown error'}`, true);
      else if (rec.error) note(`Recorded, but ${rec.error}`, true);
      else note(`Saved to ${rec.exportPath ?? '?'}/`);
      // Exported or not: the artifacts go to OPFS first and follow the video when it is saved.
      if (rec.status === 'recorded') void autoTranscribe(rec.id);
      break;
  }
  void renderList();
}

// --- Transcription (steps 3–5 live in pipeline.ts; this is the status line around them) --------
async function autoTranscribe(id: string): Promise<void> {
  if ((await loadSettings()).autoTranscribe) await runPipeline(id);
}

async function runPipeline(id: string): Promise<void> {
  const done = transcribeRecording(id);
  refreshStatus();
  try {
    const rec = await done;
    if (status !== 'idle') return;
    if (rec.status === 'failed')
      note(`Transcription failed: ${rec.error ?? 'unknown error'}`, true);
    else if (rec.error) note(`Transcribed. ${rec.error}`, true);
    else note(`Transcript saved to ${rec.exportPath ?? '?'}/`);
  } catch (err) {
    if (status === 'idle') note(`Transcription failed: ${String(err)}`, true);
  } finally {
    refreshStatus();
    void renderList();
  }
}

async function onStop(): Promise<void> {
  const r = recorder;
  if (!r) return;
  // Inside the click: the folder permission prompt needs a user gesture.
  await ensureExportPermission().catch(() => undefined);
  await r.stop();
}

// --- Library (plain list; #4 grows it) ---------------------------------------------------------
/** "Save now": export a `recorded` recording that has no export path yet, from a click, so the
 * folder permission can be re-requested (after a browser restart, or when the share ended from
 * Chrome's bar and finalize ran outside a gesture). */
async function saveNow(rec: Recording, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await ensureExportPermission().catch(() => undefined);
    const settings = await loadSettings();
    const done = await finalize(rec, settings.pathTemplate);
    note(
      done.exportPath ? `Saved to ${done.exportPath}/` : `Still not saved: ${done.error ?? '?'}`,
      !done.exportPath,
    );
  } finally {
    await renderList();
  }
}

function formatLevels(levels: Recording['levels']): string | undefined {
  if (!levels) return undefined;
  const parts = (['mic', 'display'] as const)
    .filter((ch) => levels[ch] !== undefined)
    .map((ch) => `${ch} ${levels[ch]} dBFS`);
  return parts.length ? parts.join(' · ') : undefined;
}

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
  const levels = formatLevels(rec.levels);
  if (levels) {
    const lv = document.createElement('span');
    lv.className = 'levels';
    lv.textContent = levels;
    meta.append(lv);
  }
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
  if (rec.status === 'recorded' && !rec.exportPath) {
    const save = document.createElement('button');
    save.className = 'save-now';
    save.textContent = 'Save now';
    save.addEventListener('click', () => void saveNow(rec, save));
    li.append(save);
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
  (fields.namedItem('backend') as HTMLSelectElement).value = settings.backend;
  (fields.namedItem('autoTranscribe') as HTMLInputElement).checked = settings.autoTranscribe;
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
        backend: data.get('backend') === 'webgpu' ? 'webgpu' : 'wasm',
        autoTranscribe: data.get('autoTranscribe') === 'on',
      });
      const saved = $<HTMLElement>('#settings-saved');
      saved.textContent = 'Saved.';
      window.setTimeout(() => (saved.textContent = ''), 1500);
    }, 300);
  });
}

/** A second app tab: inert, so the two cannot disagree about the badge or start two recordings. */
function showDuplicate(): void {
  document.body.classList.add('duplicate');
  const section = $<HTMLElement>('#duplicate');
  section.hidden = false;
  $<HTMLButtonElement>('#focus-app').addEventListener(
    'click',
    () => void send({ type: 'focus-app' }),
  );
}

async function main(): Promise<void> {
  // Single-owner rule: if another app tab answers, this tab does nothing at all. The service
  // worker does not answer query-status, so any answer is a live sibling.
  const sibling = await send({ type: 'query-status' });
  if (sibling !== undefined) {
    showDuplicate();
    document.body.dataset['ready'] = 'duplicate';
    return;
  }
  chrome.runtime.onMessage.addListener(onMessage);
  setStatus('idle');
  // The Record section's status line follows the pipeline while nothing is being recorded; the
  // library follows it per row.
  onPipelineProgress((_id, p) => {
    if (status === 'idle') note(p.message);
  });
  const settings = await loadSettings();
  bindSettings(settings);
  $<HTMLButtonElement>('#choose-folder').addEventListener('click', () => void chooseFolder());
  $<HTMLButtonElement>('#record-screen').addEventListener('click', () => void onRecordScreen());
  $<HTMLButtonElement>('#stop').addEventListener('click', () => void onStop());
  await describeFolder();
  await renderList();
  // A duplicate tab is inert (above), so a `recording` answer here can only come from an owner
  // tab that loaded in the same instant as this one; its recording must not be "recovered".
  const elsewhere = await send({ type: 'query-status' });
  const recovered =
    elsewhere === 'recording' ? [] : await recoverInterrupted(settings.pathTemplate);
  if (recovered.length > 0) {
    note(`Recovered ${recovered.length} interrupted recording${recovered.length > 1 ? 's' : ''}.`);
    await renderList();
  }
  // A transcription the last page load left unfinished starts again, once, whatever the
  // auto-transcribe setting: it was already under way. A recovered recording follows the setting.
  const interrupted = await recoverInterruptedTranscriptions();
  for (const rec of interrupted) void runPipeline(rec.id);
  for (const rec of recovered) if (rec.status === 'recorded') void autoTranscribe(rec.id);
  if (interrupted.length > 0) await renderList();
  // Startup is complete (recovery included); the e2e harness waits for this.
  document.body.dataset['ready'] = 'owner';
}

void main();
