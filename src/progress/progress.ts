// The processing tab: a normal tab the service worker opens (`open-progress`) after a save in the
// stop dialog, so the human sees what happens to the recording next (the video export, the
// transcription, where it all went, and the workflow chosen for it, which runs outside the
// browser) while the app tab, which does the work, stays pinned in the background. A view: the record from IndexedDB once a second (the truth on disk, readable with
// the app tab closed) plus the app tab's live line for it (`query-progress`). Closing this tab
// stops nothing; a closed app tab does, and this page says so and offers to open it.
import type { ProgressInfo } from '../lib/messages.ts';
import { send } from '../lib/messages.ts';
import { stepOf, type PipelineProgress } from '../lib/progress.ts';
import { describeRun } from '../lib/routines.ts';
import { loadSettings } from '../lib/settings.ts';
import type { Recording } from '../lib/types.ts';
import { rootFor } from '../storage/export.ts';
import { getRecording } from '../storage/store.ts';
import { appTab, askApp } from '../ui/apptab.ts';
import { renderSteps } from '../ui/steps.ts';

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
  /** The pipeline's steps (ui/steps.ts) once it has a plan; `busy` without one shows a bar. */
  progress?: PipelineProgress;
}

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
  // What comes after the transcript, while the transcript is still being made.
  const then = rec.routine?.state === 'waiting' ? ` · then ${rec.routine.label}` : '';
  if (live?.progress && live.progress.phase !== 'done') {
    const p = live.progress;
    const at = stepOf(p);
    return {
      headline: p.message,
      detail: at
        ? `Step ${at.index} of ${at.count} · ${Math.round(p.overall * 100)}% of the whole job${then}`
        : then.slice(3),
      kind: 'busy',
      ...(p.steps.length ? { progress: p } : {}),
    };
  }
  switch (rec.status) {
    case 'recording':
      return { headline: 'Recording…', detail: 'Stop it from the toolbar button.', kind: 'busy' };
    case 'stopped':
      return {
        headline: 'Waiting to be saved',
        detail: 'Save it, run a workflow on it or Discard it in Rescribe.',
        kind: 'paused',
      };
    case 'recorded':
      // Saved, not being transcribed right now: what the app tab says (`live`), not what the
      // setting promises (auto-transcribe queues a recording at the save, never later).
      if (rec.error)
        return {
          headline: 'Not saved',
          detail: `${rec.error} Use Save now in Rescribe.`,
          kind: 'error',
        };
      return {
        headline: 'Saved',
        detail: autoTranscribe
          ? 'The video is in the folder.'
          : 'Transcription is off in Settings; run it from the recording in Rescribe.',
        kind: 'done',
      };
    case 'transcribing':
      return appOpen ? { headline: 'Waiting to transcribe…', detail: '', kind: 'busy' } : PAUSED;
    case 'done': {
      if (rec.error)
        return {
          headline: 'Transcribed, but not everything is in the folder',
          detail: rec.error + (rec.routine ? ` ${describeRun(rec.routine, false)}` : ''),
          kind: 'error',
        };
      const run = rec.routine;
      const files = 'The video and the transcript are in the folder.';
      if (!run) return { headline: 'Done', detail: files, kind: 'done' };
      switch (run.state) {
        case 'waiting':
          return { headline: `Starting ${run.label}…`, detail: files, kind: 'busy' };
        case 'running':
          return {
            headline: `${run.label}…`,
            detail: `${files} ${describeRun(run, true)} It runs outside the browser, so this tab and Rescribe can close; a notification says when it is done.`,
            kind: 'busy',
          };
        case 'done':
          return { headline: 'Done', detail: `${files} ${describeRun(run, true)}`, kind: 'done' };
        case 'failed':
          return { headline: `${run.label} failed`, detail: run.message ?? '', kind: 'error' };
      }
      break;
    }
    case 'failed':
      // The recorder, the export and the pipeline all end here; the error says which.
      return { headline: 'Failed', detail: rec.error ?? 'Unknown error.', kind: 'error' };
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

/** The run's log while it runs or after it failed: where to look, outside the browser. */
function logPath(rec: Recording | undefined): string {
  const run = rec?.routine;
  return run?.log && (run.state === 'running' || run.state === 'failed') ? `Log: ${run.log}` : '';
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
  // The steps once the pipeline has a plan; an indeterminate bar for the export and the queue.
  const steps = $<HTMLElement>('#steps');
  steps.hidden = !v.progress;
  if (v.progress) renderSteps(steps, v.progress, { vertical: true });
  else steps.replaceChildren();
  const bar = $<HTMLElement>('#bar');
  bar.hidden = v.kind !== 'busy' || !!v.progress;
  bar.classList.add('indeterminate');
  $<HTMLElement>('#destination').textContent = dest;
  $<HTMLElement>('#log').textContent = logPath(rec);
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
