// The app tab. Owns all state: the recorder, storage, settings, the library list. The service
// worker only pokes it with messages. See ARCHITECTURE § Runtime topology.
import type { AppStatus, DecideResult, Decision, Message, PendingInfo } from '../lib/messages.ts';
import { send } from '../lib/messages.ts';
import { formatDuration } from '../lib/format.ts';
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
import { getRecording, listRecordings } from '../storage/store.ts';
import { decide, isDeciding, onDecision } from './decide.ts';
import { describeSources, renderList } from './library.ts';
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
/** A start is under way, from its first capture to the recorder running; one at a time. */
let starting = false;
let ticker: number | undefined;
/**
 * The recording the stop dialog is about when nothing is live: the newest one at `stopped`,
 * waiting for the human's decision (`refreshPending`). The status is `stopped` while it is set.
 */
let pendingId: string | undefined;
/** The live recording whose stop was asked for together with a decision (`applyDecision`). */
let deciding: string | undefined;
/** Decisions being applied (an export in flight), whatever recording they are on. */
let applying = 0;

/**
 * `status` is the recorder's state and what `query-status` answers, so a toolbar click can still
 * start a recording while a transcription runs. The pill and the badge show that transcription
 * when nothing is being recorded. `stopped`: a recording waits for the decision (badge `SAVE`);
 * `recorded`: busy for a moment (the recorder draining, an export running).
 */
function setStatus(next: AppStatus): void {
  status = next;
  refreshStatus();
}

const PILL_CLASS: Partial<Record<AppStatus, string>> = {
  recording: 'recording',
  stopped: 'pending',
  transcribing: 'processing',
};

function refreshStatus(): void {
  const shown: AppStatus = status === 'idle' && isPipelineBusy() ? 'transcribing' : status;
  const pill = $<HTMLSpanElement>('#status');
  pill.textContent = shown;
  pill.className = `pill ${PILL_CLASS[shown] ?? ''}`;
  $<HTMLButtonElement>('#stop').disabled = status !== 'recording';
  $<HTMLButtonElement>('#record-screen').disabled = status !== 'idle';
  void send({
    type: 'badge',
    state:
      shown === 'recording'
        ? 'recording'
        : shown === 'stopped'
          ? 'pending'
          : shown === 'transcribing'
            ? 'processing'
            : 'idle',
  });
}

/**
 * Nothing live and no decision in flight: the newest `stopped` recording, if any, is what the
 * stop dialog and the badge are about, and the status says so. Called after every stop and
 * every decision, and on startup (a recording left `stopped` by a closed tab is still waiting).
 */
async function refreshPending(): Promise<void> {
  if (recorder || applying > 0) return;
  const stopped = (await listRecordings()).filter((r) => r.status === 'stopped');
  pendingId = stopped[0]?.id;
  if (pendingId) {
    const rec = stopped[0]!;
    setStatus('stopped');
    note(
      `"${rec.title}" (${formatDuration((rec.endedAt ?? Date.now()) - rec.startedAt)}) is not saved yet: Save, Save as… or Discard it from its row below, or from the toolbar button.`,
    );
  } else setStatus('idle');
}

/** The human's decision is needed: the service worker opens the stop dialog. */
function askToSave(): void {
  void send({ type: 'ask-to-save' });
}

function note(text: string, isError = false): void {
  const el = $<HTMLElement>('#record-status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

/**
 * Bring this tab forward. A toolbar click on a call platform tab leaves this tab in the
 * background (background.ts `onToggle`), so anything that needs the human's eyes or hands during a
 * start asks for the foreground: a permission prompt (Chrome shows it only for a visible tab; in
 * a hidden one the request waits, and with it the recording) or a start that failed, whose note
 * would otherwise sit unseen while the human waits for the badge. Already in front, it only
 * raises this tab's window.
 */
function comeForward(): void {
  void send({ type: 'focus-app' });
}

/** Whether getUserMedia for the microphone will prompt. Unknown counts as a prompt. */
async function micWillPrompt(): Promise<boolean> {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return p.state === 'prompt';
  } catch {
    return true;
  }
}

// --- Messages from the service worker and content scripts ---------------------------------
// Registered by main() only in the tab that owns the recorder; a duplicate tab never listens.
function onMessage(
  msg: Message,
  sender: chrome.runtime.MessageSender,
  sendResponse: (res: AppStatus | PendingInfo | DecideResult | undefined) => void,
): boolean {
  switch (msg.type) {
    case 'query-status':
      sendResponse(status);
      return false;
    case 'toggle-recording':
      void onToggleRecording(msg);
      return false;
    case 'query-pending':
      void pendingInfo().then((info) => sendResponse(info));
      return true;
    case 'decide':
      void applyDecision(msg.id, msg.action).then((result) => {
        try {
          sendResponse(result);
        } catch {
          // the dialog closed meanwhile
        }
      });
      return true;
    case 'call-ended': {
      // Only from the recorded tab (toolbar path) or a tab that contributed events (picker
      // path), and only while recording: the human is asked, the recording goes on.
      const from = sender.tab?.id;
      const ours =
        from !== undefined &&
        (recordedTabId !== undefined ? from === recordedTabId : contributingTabs.has(from));
      if (recorder && status === 'recording' && ours) askToSave();
      return false;
    }
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

// A `stopped` recording waits on disk and is picked up again on the next open: no warning for it.
window.addEventListener('beforeunload', (e) => {
  if (status === 'recording' || status === 'recorded' || isPipelineBusy()) e.preventDefault();
});

// --- Recording ----------------------------------------------------------------------------
function tick(): void {
  const rec = recorder?.recording;
  if (!rec || rec.status !== 'recording') return;
  note(`Recording ${formatDuration(Date.now() - rec.startedAt)} · ${describeSources(rec)}`);
}

/** True once `#mic` reflects Settings; a toggle that lands before then reads Settings itself. */
let formBound = false;

/** Whether this recording wants the microphone: the checkbox once bound, Settings before. */
function micWanted(settings: Settings): boolean {
  return formBound ? $<HTMLInputElement>('#mic').checked : settings.micByDefault;
}

/** The microphone when wanted; `missing` when it was wanted and unavailable (denied, absent). */
interface MicResult {
  mic?: Captured;
  missing: boolean;
}

/**
 * The microphone, when wanted. A permission prompt brings this tab forward first: Chrome shows
 * the prompt only for a visible tab, and a toolbar click on a call platform tab leaves this tab
 * hidden. Unavailable is not a failure: the recording goes on without it.
 */
async function acquireMic(settings: Settings): Promise<MicResult> {
  if (!micWanted(settings)) return { missing: false };
  if (await micWillPrompt()) comeForward();
  const mic = await captureMic();
  return { mic, missing: !mic };
}

/**
 * Toolbar button or keyboard command: the service worker obtained a tab-capture stream id. It
 * sends this only after reading `idle`, so a message that arrives while not idle, or while a
 * start is pending, is a click it did not bring this tab forward for: do it now, with whatever
 * the pending start waits on (a permission prompt) or with Stop.
 */
async function onToggleRecording(
  msg: Extract<Message, { type: 'toggle-recording' }>,
): Promise<void> {
  if (status !== 'idle' || starting) {
    comeForward();
    return;
  }
  if (!msg.streamId) {
    note(
      `Couldn't capture that tab${msg.error ? ` (${msg.error})` : ''}. Use "Record screen…" and pick it instead.`,
      true,
    );
    comeForward();
    return;
  }
  starting = true;
  try {
    const settings = await loadSettings();
    // The microphone before the tab: consuming the stream id mutes the captured tab for the
    // human until the recorder plays it back, and a permission prompt takes as long as the human
    // takes. The id lives 10 s from issue (background.ts): enough once the microphone is granted;
    // a prompt answered later fails the tab capture visibly and the next click succeeds.
    const mic = await acquireMic(settings);
    let display: Captured;
    try {
      display = await captureTab(msg.streamId, msg.tabTitle);
    } catch (err) {
      if (mic.mic) stopAll(mic.mic.stream);
      note(`Couldn't capture that tab: ${String(err)}`, true);
      comeForward();
      return;
    }
    await startRecording(display, mic, settings, msg.tabTitle || 'Tab recording', msg.tabId);
  } finally {
    starting = false;
  }
}

/** "Record screen…": Chrome's picker, from a click in this tab. The picker first: it needs the gesture. */
async function onRecordScreen(): Promise<void> {
  if (status !== 'idle' || starting) return;
  starting = true;
  try {
    let display: Captured;
    try {
      display = await captureDisplay();
    } catch (err) {
      if (err instanceof CaptureCancelled) note('');
      else note(`Couldn't start: ${String(err)}`, true);
      return;
    }
    const settings = await loadSettings();
    const mic = await acquireMic(settings);
    await startRecording(display, mic, settings, 'Screen recording');
  } finally {
    starting = false;
  }
}

/**
 * The recorder over the captured streams. `starting` is the caller's, held from its first
 * capture, so two starts cannot both get here; the status guard is for the recorder's own state.
 */
async function startRecording(
  display: Captured,
  mic: MicResult,
  settings: Settings,
  title: string,
  tabId?: number,
): Promise<void> {
  if (status !== 'idle') {
    stopAll(display.stream);
    if (mic.mic) stopAll(mic.mic.stream);
    return;
  }
  recordedTabId = tabId;
  contributingTabs.clear();
  // The recording starts anyway; the row keeps the note. Not a reason to come forward.
  if (mic.missing) note('Microphone unavailable; recording without it.', true);
  try {
    recorder = await Recorder.start(
      {
        display,
        mic: mic.mic,
        title,
        container: settings.container,
        note: mic.missing ? 'Microphone unavailable at start; recorded without it.' : undefined,
      },
      onRecorderChange,
    );
  } catch (err) {
    note(`Couldn't start: ${err instanceof Error ? err.message : String(err)}`, true);
    comeForward();
    recordedTabId = undefined;
    setStatus('idle');
  }
}

function onRecorderChange(rec: Recording, phase: 'recording' | 'stopping' | 'stopped'): void {
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
    case 'stopped':
      recorder = undefined;
      recordedTabId = undefined;
      contributingTabs.clear();
      if (rec.status === 'failed') {
        note(`Recording failed: ${rec.error ?? 'unknown error'}`, true);
        void refreshPending();
      } else if (deciding === rec.id) {
        // `applyDecision` asked for this stop and goes on with the decision.
      } else {
        // The stream died (Stop sharing, the captured tab closed): the recording waits for the
        // human. Nothing is exported and nothing transcribed until they say so.
        pendingId = rec.id;
        setStatus('stopped');
        note(
          `Recording ended (${formatDuration((rec.endedAt ?? Date.now()) - rec.startedAt)}), not saved yet: Save, Save as… or Discard it from its row below, or from the toolbar button.`,
        );
        askToSave();
      }
      break;
  }
  void renderList();
}

/** What the stop dialog shows: the live recording, else the newest one waiting `stopped`. */
async function pendingInfo(): Promise<PendingInfo | undefined> {
  const live = recorder?.recording;
  if (live && status === 'recording')
    return { id: live.id, title: live.title, startedAt: live.startedAt, live: true };
  if (!pendingId || applying > 0 || isDeciding(pendingId)) return undefined;
  const rec = await getRecording(pendingId);
  if (!rec || rec.status !== 'stopped') return undefined;
  return {
    id: rec.id,
    title: rec.title,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    live: false,
  };
}

/**
 * The decision, from the stop dialog, the Stop button or a row: stop the recorder first when the
 * recording is the live one (its stop ends at `stopped`), then `decide` (app/decide.ts). The
 * export runs with the status at `recorded` (busy); the outcome goes to the status line and,
 * through `onDecision`, starts the transcription.
 */
async function applyDecision(id: string, action: Decision): Promise<DecideResult> {
  const r = recorder;
  if (r && r.recording.id === id) {
    if (deciding !== undefined) return { ok: false, message: 'The recording is already stopping.' };
    deciding = id;
    let stopped: Recording;
    try {
      stopped = await r.stop();
    } finally {
      deciding = undefined;
    }
    if (stopped.status !== 'stopped') {
      await refreshPending();
      return { ok: false, message: `Recording failed: ${stopped.error ?? 'unknown error'}` };
    }
  }
  applying++;
  try {
    if (!recorder) setStatus('recorded');
    const out = await decide(id, action, (rec) => {
      if (!recorder) note(`Saving ${exportVideoName(rec.container)}…`);
    });
    if (!out) return { ok: true, message: 'Discarded.' };
    if (out.error) return { ok: true, message: `Recorded, but ${out.error}` };
    return { ok: true, message: `Saved to ${describePath(out)}` };
  } catch (err) {
    return { ok: false, message: describe(err) };
  } finally {
    applying--;
    await refreshPending();
    void renderList();
  }
}

/** `<folder>/<path>/` with the recording's own folder in front when it has one. */
function describePath(rec: Recording): string {
  return `${rec.exportRoot ? `${rec.exportRoot}/` : ''}${rec.exportPath ?? '?'}/`;
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

/** Stop in the app tab: stop and save into the folder from Settings, in one click. */
async function onStop(): Promise<void> {
  const r = recorder;
  if (!r) return;
  // Inside the click: the folder permission prompt needs a user gesture.
  await ensureExportPermission().catch(() => undefined);
  await applyDecision(r.recording.id, 'save');
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
  formBound = true;

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
  // Every decision, wherever it was made (the stop dialog, Stop, a row): the status line says
  // what happened and a saved recording is transcribed (the artifacts go to OPFS first and follow
  // the video when it is saved, exported or not).
  // A decision from a row (not through `applyDecision`) moves the status the same way: busy
  // while it runs, then whatever is pending next.
  onDecision((ev) => {
    if (ev.phase === 'started') {
      if (!recorder) setStatus('recorded');
      return;
    }
    const rec = ev.rec;
    if (ev.action === 'discard') note(`Discarded "${ev.before.title}".`);
    else if (!rec) note('');
    else if (rec.error) note(`Recorded, but ${rec.error}`, true);
    else note(`Saved to ${describePath(rec)}`);
    void refreshPending().then(() => {
      if (rec?.status === 'recorded') void autoTranscribe(rec.id);
    });
  });
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
  // A recording left `stopped` (the tab closed before the human decided) is still waiting.
  await refreshPending();
  // Startup is complete (recovery included); the e2e harness waits for this.
  document.body.dataset['ready'] = 'owner';
}

void main();
