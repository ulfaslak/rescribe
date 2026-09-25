// The decision on a `stopped` recording (ARCHITECTURE § Pipeline step 2): save it into the folder
// from Settings, save it into a folder of its own, or discard it. App-tab only. The stop dialog,
// the app tab's Stop button and a library row all end here; app.ts stops the recorder first when
// the recording is still live (`stop()` ends at `stopped`), so this module only ever sees records
// on disk. Listeners (app.ts) learn the outcome to refresh the status and start transcription.
import type { Decision } from '../lib/messages.ts';
import { loadSettings } from '../lib/settings.ts';
import type { Recording } from '../lib/types.ts';
import { finalize } from '../recorder/recorder.ts';
import { deleteRecordingExportRoot, getRecordingExportRoot } from '../storage/handles.ts';
import { deleteRecording, getRecording, updateRecording } from '../storage/store.ts';

/**
 * `started` when the decision begins (an export may take a while); `done` with the record after
 * a save (`recorded`, exported or not) or without one after a discard.
 */
export type DecisionEvent =
  | { phase: 'started'; id: string; action: Decision }
  | { phase: 'done'; id: string; action: Decision; before: Recording; rec?: Recording };
export type DecisionListener = (ev: DecisionEvent) => void;

const listeners = new Set<DecisionListener>();
/** Ids with a decision in progress: a second decision on the same recording is refused. */
const deciding = new Set<string>();

export function onDecision(listener: DecisionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isDeciding(id: string): boolean {
  return deciding.has(id);
}

function emit(ev: DecisionEvent): void {
  for (const l of listeners) {
    try {
      l(ev);
    } catch (err) {
      console.error('[rescribe] decision listener', err);
    }
  }
}

/**
 * Apply the decision to a recording at `stopped`. `save`: `finalize` into the folder from
 * Settings (a Save as handle left behind by an earlier, failed attempt is dropped first).
 * `save-as`: the same into the folder whose handle the caller stored under `export:<id>`
 * (storage/handles.ts) before calling; its name goes on the record. `discard`: the record, its
 * files and its handle are deleted; nothing was ever exported. Throws when the recording does not
 * exist, is not `stopped`, or has a decision in progress; a failed export does not throw, it is
 * on the returned record (`error`, no `exportPath`; the row offers Save now).
 */
export async function decide(
  id: string,
  action: Decision,
  onExporting?: (rec: Recording) => void,
): Promise<Recording | undefined> {
  if (deciding.has(id)) throw new Error('That recording is being saved or discarded already.');
  deciding.add(id);
  try {
    const before = await getRecording(id);
    if (!before) throw new Error('That recording no longer exists.');
    if (before.status !== 'stopped')
      throw new Error(`"${before.title}" is ${before.status}; there is nothing to decide.`);
    emit({ phase: 'started', id, action });
    let out: Recording | undefined;
    if (action === 'discard') {
      await deleteRecording(id);
    } else {
      let target = before;
      if (action === 'save-as') {
        const own = await getRecordingExportRoot(id);
        if (!own) throw new Error('No folder was chosen for this recording.');
        target = await updateRecording(id, { exportRoot: own.name });
      } else if (before.exportRoot !== undefined || (await getRecordingExportRoot(id))) {
        await deleteRecordingExportRoot(id);
        target = await updateRecording(id, { exportRoot: undefined });
      }
      out = await finalize(target, (await loadSettings()).pathTemplate, onExporting);
    }
    emit({ phase: 'done', id, action, before, rec: out });
    return out;
  } finally {
    deciding.delete(id);
  }
}
