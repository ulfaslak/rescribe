// The processing tab: a normal tab the service worker opens (`open-progress`) after a save in the
// stop dialog, so the human sees what happens to the recording next (the video export, the
// transcription, where it all went) while the app tab, which does the work, stays pinned in the
// background. A view: the record from IndexedDB once a second (the truth on disk, readable with
// the app tab closed) plus the app tab's live line for it (`query-progress`). Closing this tab
// stops nothing; a closed app tab does, and this page says so and offers to open it.
import type { ProgressInfo } from '../lib/messages.ts';
import { send } from '../lib/messages.ts';
import { loadSettings } from '../lib/settings.ts';
import type { Recording } from '../lib/types.ts';
import { rootFor } from '../storage/export.ts';
import { getRecording } from '../storage/store.ts';
import { appTab, askApp } from '../ui/apptab.ts';

const REFRESH_MS = 1000;

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const id = new URLSearchParams(location.search).get('id') ?? '';

type Kind = 'busy' | 'done' | 'error' | 'paused';

interface View {
  headline: string;
  detail: string;
  kind: Kind;
  /** 0–1 for a bar; `busy` without one shows an indeterminate bar. */
  fraction?: number;
}

const PHASE_HEADLINE: Record<string, string> = {
  queued: 'Waiting to transcribe…',
  download: 'Downloading the speech model (once)…',
  load: 'Loading the speech model…',
  transcribe: 'Transcribing…',
  attribute: 'Attributing speakers…',
  export: 'Saving the transcript…',
};

const PAUSED: View = {
  headline: 'Paused',
  detail: 'The Rescribe tab is closed; the transcription continues when you open it.',
  kind: 'paused',
};

/** What to show: the live line from the app tab first, then the record on disk. */
function view(
  rec: Recording | undefined,
  live: ProgressInfo | undefined,
  appOpen: boolean,
  autoTranscribe: boolean,
): View {
  if (!rec)
    return { headline: 'Gone', detail: 'This recording was discarded or deleted.', kind: 'error' };
  if (live?.saving) return { headline: 'Saving the video…', detail: '', kind: 'busy' };
  if (live?.phase && live.phase !== 'done')
    return {
      headline: PHASE_HEADLINE[live.phase] ?? 'Working…',
      detail: live.message ?? '',
      kind: 'busy',
      fraction: live.fraction,
    };
  switch (rec.status) {
    case 'recording':
      return { headline: 'Recording…', detail: 'Stop it from the toolbar button.', kind: 'busy' };
    case 'stopped':
      return {
        headline: 'Waiting to be saved',
        detail: 'Save, Save as… or Discard it in Rescribe.',
        kind: 'paused',
      };
    case 'recorded':
      if (rec.error)
        return {
          headline: 'Not saved',
          detail: `${rec.error} Use Save now in Rescribe.`,
          kind: 'error',
        };
      if (!autoTranscribe)
        return {
          headline: 'Saved',
          detail: 'Transcription is off in Settings; run it from the recording in Rescribe.',
          kind: 'done',
        };
      return appOpen
        ? { headline: 'Saved', detail: 'The transcription starts in a moment…', kind: 'busy' }
        : PAUSED;
    case 'transcribing':
      return appOpen ? { headline: 'Waiting to transcribe…', detail: '', kind: 'busy' } : PAUSED;
    case 'done':
      return rec.error
        ? {
            headline: 'Transcribed, but not everything is in the folder',
            detail: rec.error,
            kind: 'error',
          }
        : {
            headline: 'Done',
            detail: 'The video and the transcript are in the folder.',
            kind: 'done',
          };
    case 'failed':
      return {
        headline: 'Transcription failed',
        detail: rec.error ?? 'Unknown error.',
        kind: 'error',
      };
  }
}

/** `<folder>/<path>/` as far as it is known: the folder before the export, the path after it. */
async function destination(rec: Recording | undefined): Promise<string> {
  if (!rec) return '';
  try {
    const root = await rootFor(rec);
    return `${root.name}/${rec.exportPath ? `${rec.exportPath}/` : ''}`;
  } catch {
    return '';
  }
}

function render(rec: Recording | undefined, v: View, dest: string): void {
  if (rec) document.title = `Rescribe · ${rec.title}`;
  $<HTMLElement>('#title').textContent = rec?.title ?? '';
  const h = $<HTMLElement>('#headline');
  h.textContent = v.headline;
  h.className = v.kind === 'busy' ? '' : v.kind;
  const detail = $<HTMLElement>('#detail');
  detail.textContent = v.detail;
  detail.className = `detail${v.kind === 'error' ? ' error' : ''}`;
  const bar = $<HTMLElement>('#bar');
  bar.hidden = v.kind !== 'busy';
  bar.classList.toggle('indeterminate', v.fraction === undefined);
  $<HTMLElement>('#bar-fill').style.width =
    v.fraction === undefined ? '' : `${Math.round(v.fraction * 100)}%`;
  $<HTMLElement>('#destination').textContent = dest;
  document.body.dataset['kind'] = v.kind;
}

let timer: number | undefined;

async function refresh(): Promise<void> {
  const rec = await getRecording(id);
  const live = rec ? await askApp<ProgressInfo>({ type: 'query-progress', id }) : undefined;
  // After the ask: a failed ask forgets a closed app tab, so this answers for the tab as it is.
  const appOpen = (await appTab()) !== undefined;
  const { autoTranscribe } = await loadSettings();
  const v = view(rec, live, appOpen, autoTranscribe);
  render(rec, v, await destination(rec));
  // Still polled at done or failed: a Save now, a re-run or a delete in Rescribe shows here too.
  if (!rec) window.clearInterval(timer);
}

function main(): void {
  $<HTMLButtonElement>('#open-app').addEventListener(
    'click',
    () => void send({ type: 'focus-app' }),
  );
  void refresh();
  timer = window.setInterval(() => void refresh(), REFRESH_MS);
}

main();
