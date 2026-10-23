// The routine chosen for a recording (DECISIONS § Routines), app-tab only: started through the
// native host once the recording is `done` with its transcript in the folder, then followed until
// the host says `done` or `failed`, every state written to the record (`Recording.routine`), which
// is what the row and the processing tab show.
//
// A routine waits on the record as `waiting` from the decision (app/decide.ts) or a row's click.
// It starts when the pipeline finishes a recording (its `done` event), after a Save now that put
// the transcript in the folder (`startWhenReady`, from the library), and on app start for whatever
// a closed tab left waiting. Runs are followed by polling the host every few seconds while any is
// `running`; the run itself lives outside the browser, so a closed tab only delays the record.
import { applyStatus, runKey, waitingRun, type RoutineInfo } from '../lib/routines.ts';
import type { Recording } from '../lib/types.ts';
import { rootFor } from '../storage/export.ts';
import { getRecording, listRecordings, updateRecording } from '../storage/store.ts';
import { HostUnavailable, listRoutines, routineStatus, startRoutine } from '../ui/routines.ts';
import type { RoutineList } from '../ui/routines.ts';
import { onPipelineProgress } from './pipeline.ts';

const POLL_MS = 4000;
/** A start the host did not answer in time is asked again (same key) this much later. */
const RETRY_START_MS = 30_000;

/** Records with a run going: polled. */
const following = new Set<string>();
/** Records whose start is in flight: a second trigger (the pipeline and a click) must not start it twice. */
const starting = new Set<string>();
let timer: number | undefined;
let changed: () => void = () => undefined;
let offered: RoutineList = { routines: [] };

/** The routines the host offered when last asked (the row's buttons). */
export function routinesOnOffer(): RoutineList {
  return offered;
}

/** Ask the host again; the list changes when a routine is added to the clone it runs from. */
export async function refreshRoutines(): Promise<RoutineList> {
  offered = await listRoutines();
  return offered;
}

/** The transcript is in the folder: what a routine needs. */
export function transcriptInFolder(rec: Recording): boolean {
  return rec.status === 'done' && !rec.error && rec.exportPath !== undefined;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Start the record's waiting routine if its transcript is in the folder; otherwise nothing. */
export async function startWhenReady(id: string): Promise<void> {
  if (starting.has(id)) return;
  starting.add(id);
  try {
    const rec = await getRecording(id);
    const run = rec?.routine;
    if (!rec || run?.state !== 'waiting' || !transcriptInFolder(rec)) return;
    let patch: Recording['routine'];
    try {
      const root = await rootFor(rec);
      const status = await startRoutine(
        run.id,
        { id: rec.id, title: rec.title, folder: root.name, exportPath: rec.exportPath! },
        runKey(rec.id, run),
      );
      patch = applyStatus(run, status);
    } catch (err) {
      if (err instanceof HostUnavailable && err.transient) {
        // No answer in time: the run may have started all the same. It stays waiting and is
        // asked again under the same key, which the host answers with that run if it exists.
        window.setTimeout(() => void startWhenReady(id), RETRY_START_MS);
        return;
      }
      // Not installed, or refused (the folder is not the host's, the files are not there): the
      // run never began, so it is failed with the reason, and the row offers it again.
      patch = { ...run, state: 'failed', at: Date.now(), message: message(err) };
    }
    await updateRecording(id, { routine: patch });
    if (patch.state === 'running') follow(id);
    changed();
  } finally {
    starting.delete(id);
  }
}

/**
 * The row's click: put `routine` on a recording whose transcript is in the folder and start it.
 * Refused while another run on it is waiting or running.
 */
export async function runRoutineOn(id: string, routine: RoutineInfo): Promise<Recording> {
  const rec = await getRecording(id);
  if (!rec) throw new Error('That recording no longer exists.');
  if (!transcriptInFolder(rec))
    throw new Error(`"${rec.title}" has no transcript in the folder yet.`);
  if (rec.routine?.state === 'running' || starting.has(id))
    throw new Error(`${rec.routine?.label ?? 'A routine'} is already running on it.`);
  await updateRecording(id, { routine: waitingRun(routine, Date.now()) });
  await startWhenReady(id);
  return (await getRecording(id)) ?? rec;
}

function follow(id: string): void {
  following.add(id);
  timer ??= window.setInterval(() => void poll(), POLL_MS);
}

async function poll(): Promise<void> {
  for (const id of [...following]) {
    const rec = await getRecording(id);
    const run = rec?.routine;
    if (!run || run.state !== 'running' || !run.runId) {
      following.delete(id);
      continue;
    }
    let next: Recording['routine'];
    try {
      next = applyStatus(run, await routineStatus(run.runId));
    } catch (err) {
      // The host out of reach (reinstalled, moved) says nothing about the run, which goes on
      // outside the browser: ask again next time. A host that answers no (the run's directory
      // is gone) does.
      if (err instanceof HostUnavailable) continue;
      next = { ...run, state: 'failed', at: Date.now(), message: message(err) };
    }
    if (next.state === 'running') continue;
    following.delete(id);
    await updateRecording(id, { routine: next });
    changed();
  }
  if (following.size === 0 && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

/**
 * On app start, after the list of routines (`refreshRoutines`, awaited before the first render:
 * the rows' buttons depend on it, and a render after the fact would swap a two-step button the
 * human is halfway through): a start whenever the pipeline finishes a recording, and what a
 * closed tab left: runs still going are followed, routines waiting on a transcript that is in the
 * folder now are started. `onChange` re-renders whatever shows the records.
 */
export async function initRoutines(onChange: () => void): Promise<void> {
  changed = onChange;
  onPipelineProgress((id, p) => {
    if (p.phase === 'done') void startWhenReady(id);
  });
  for (const rec of await listRecordings()) {
    if (rec.routine?.state === 'running') follow(rec.id);
    else if (rec.routine?.state === 'waiting') void startWhenReady(rec.id);
  }
}
