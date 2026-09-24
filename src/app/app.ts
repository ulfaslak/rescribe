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
import { exportVideoName, Recorder, recoverInterrupted } from '../recorder/recorder.ts';
import { ensureExportPermission, getExportRoot, setExportRoot } from '../storage/export.ts';
import { getRecording } from '../storage/store.ts';
import { describeSources, formatDuration, renderList } from './library.ts';
import {
  isPipelineBusy,
  onPipelineProgress,
  recoverInterruptedTranscriptions,
  transcribeRecording,
  type PipelinePhase,
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
/** Tabs whose speaker or roster events reached the current recording (the picker path). */
const contributingTabs = new Set<number>();
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
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
    case 'adapter-diagnostic': {
      // Into events.jsonl, stamps as received, while a recording runs; the pipeline reads the
      // file back (lib/assemble.ts). Only content scripts send these, so a message without a
      // sender tab is not an adapter's. A toolbar recording captures one tab, so a Meet call
      // idling in another tab is not its evidence. A picker recording (a window, the screen)
      // cannot tell which tab it shows and takes every tab's speaker and roster events, but a
      // diagnostic only from a tab that has already contributed events to this recording: a
      // Meet tab left open elsewhere reports "no tiles" after 60 s, and that is not this
      // recording's problem.
      const from = sender.tab?.id;
      const accepted =
        recorder !== undefined &&
        status === 'recording' &&
        from !== undefined &&
        (recordedTabId !== undefined
          ? from === recordedTabId
          : msg.type !== 'adapter-diagnostic' || contributingTabs.has(from));
      if (!accepted || !recorder || from === undefined) {
        console.info('[rescribe] adapter message not for this recording', msg);
        return false;
      }
      contributingTabs.add(from);
      recorder.appendEvent(msg);
      if (msg.type === 'adapter-diagnostic') recorder.addNote(`Meet adapter: ${msg.message}`);
      return false;
    }
    default:
      return false;
  }
}

window.addEventListener('beforeunload', (e) => {
  if (status !== 'idle' || isPipelineBusy()) e.preventDefault();
});

// --- Recording ----------------------------------------------------------------------------
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
  contributingTabs.clear();
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
      contributingTabs.clear();
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
  // The Record section's status line follows the pipeline while nothing is being recorded. The
  // list shows the stored record, so it is rendered again whenever the pipeline moves a
  // recording (queued: marked `transcribing`; done) and at every phase in between.
  const lastPhase = new Map<string, PipelinePhase>();
  onPipelineProgress((id, p) => {
    if (status === 'idle') note(p.message);
    if (lastPhase.get(id) !== p.phase) {
      lastPhase.set(id, p.phase);
      void renderList();
    }
    if (p.phase === 'done') lastPhase.delete(id);
  });
  // For DevTools and the e2e harness: run the pipeline on a recording by id.
  (window as unknown as { rescribe: unknown }).rescribe = {
    transcribeRecording: async (id: string) => {
      await runPipeline(id);
      return getRecording(id);
    },
  };
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
