// The native host (native/host.ts), for the extension's pages: the workflows it offers, starting
// one on a recording, a run's status, and the workflows themselves for the app's editor. Each
// call is one `chrome.runtime.sendNativeMessage`: the browser starts the host, it answers and
// exits. Not src/lib: this is chrome.*. Shared by the stop dialog (the list) and the app tab
// (everything).
import {
  NATIVE_HOST,
  type HostRequest,
  type HostResponse,
  type RoutineInfo,
  type RunnerInfo,
  type RunStatus,
  type RunTarget,
  type Workflow,
  type WorkflowEntry,
} from '../lib/routines.ts';

/**
 * The host could not be reached at all (not installed, not allowed, no answer); a run may still be
 * going. `transient`: no answer in time, which asking again (with the same key) may settle.
 */
export class HostUnavailable extends Error {
  readonly transient: boolean;
  constructor(message: string, transient = false) {
    super(message);
    this.name = 'HostUnavailable';
    this.transient = transient;
  }
}

class Timeout extends Error {}

function unavailable(err: unknown): HostUnavailable {
  const text = err instanceof Error ? err.message : String(err);
  if (err instanceof Timeout)
    return new HostUnavailable(`The workflow host did not answer: ${text}`, true);
  if (/not found/i.test(text))
    return new HostUnavailable(
      'The workflow host is not installed: run npm run install-host in the Rescribe clone.',
    );
  if (/forbidden/i.test(text))
    return new HostUnavailable(
      "The workflow host does not know this extension's id: run npm run install-host again.",
    );
  return new HostUnavailable(`The workflow host did not answer: ${text}`);
}

/** The list is asked for on startup, before the first render: a host that hangs must not hold it up. */
const LIST_TIMEOUT_MS = 3000;
const RUN_TIMEOUT_MS = 15_000;
/** The editor's requests: a save checks the folder on disk. */
const EDIT_TIMEOUT_MS = 10_000;

async function ask(req: HostRequest, timeoutMs: number): Promise<HostResponse> {
  let res: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    res = await Promise.race([
      chrome.runtime.sendNativeMessage(NATIVE_HOST, req),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Timeout(`no answer within ${timeoutMs / 1000} s`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    throw unavailable(err);
  } finally {
    clearTimeout(timer);
  }
  if (!res || typeof res !== 'object' || !('ok' in res))
    throw new HostUnavailable('The workflow host gave no answer.');
  return res as HostResponse;
}

export interface RoutineList {
  routines: RoutineInfo[];
  /** The folder routines read recordings from, as the host has it (`~/.rescribe/recordings`). */
  recordings?: string;
  /** Why there are none: the host is missing, or said no. */
  error?: string;
}

/** The routines on offer; none, with the reason, when the host cannot be asked. */
export async function listRoutines(): Promise<RoutineList> {
  try {
    const res = await ask({ type: 'list-routines' }, LIST_TIMEOUT_MS);
    if (!res.ok) return { routines: [], error: res.error };
    if (!('routines' in res)) return { routines: [], error: 'Unexpected answer from the host.' };
    return { routines: res.routines, recordings: res.recordings };
  } catch (err) {
    return { routines: [], error: (err as Error).message };
  }
}

/** The last path segment of the host's recordings folder: what the Settings folder must be called. */
export function folderName(recordings: string): string {
  return recordings.split('/').filter(Boolean).at(-1) ?? recordings;
}

/**
 * Why a routine cannot run on what is saved into the Settings folder `root` (its name: a handle
 * has no path), or undefined. The host checks this again, with the files, when a run starts;
 * saying it here saves a call's worth of waiting for the transcript.
 */
export function folderMismatch(list: RoutineList, root: string | undefined): string | undefined {
  if (!list.recordings) return undefined;
  const want = folderName(list.recordings);
  if (root === undefined) return `Workflows read ${list.recordings}: choose it in Settings.`;
  if (root !== want)
    return `Workflows read ${list.recordings}, and Rescribe saves into "${root}": choose ${list.recordings} in Settings.`;
  return undefined;
}

async function runStatus(req: HostRequest): Promise<RunStatus> {
  const res = await ask(req, RUN_TIMEOUT_MS);
  if (!res.ok) throw new Error(res.error);
  if (!('run' in res)) throw new Error('Unexpected answer from the host.');
  return res.run;
}

/**
 * Start `routine` on a recording in the folder, or get the run already started under `key`; the
 * run is `running` (or further) when this resolves. Throws HostUnavailable when the host cannot
 * be reached, an Error with the host's reason when it refused.
 */
export function startRoutine(
  routine: string,
  recording: RunTarget,
  key: string,
): Promise<RunStatus> {
  return runStatus({ type: 'run-routine', routine, recording, key });
}

/** A run's status. Throws as `startRoutine` does. */
export function routineStatus(runId: string): Promise<RunStatus> {
  return runStatus({ type: 'routine-status', runId });
}

export interface WorkflowList {
  /** Without their prompts: `getWorkflow` has one whole. */
  workflows: WorkflowEntry[];
  runners: RunnerInfo[];
  /** The human's home directory, for folders shown as `~/…`. */
  home: string;
}

/** The workflows and the runners, for the editor. Throws HostUnavailable, or with the host's reason. */
export async function listWorkflows(): Promise<WorkflowList> {
  const res = await ask({ type: 'list-workflows' }, EDIT_TIMEOUT_MS);
  if (!res.ok) throw new Error(res.error);
  if (!('workflows' in res)) throw new Error('Unexpected answer from the host.');
  return { workflows: res.workflows, runners: res.runners, home: res.home };
}

/** One workflow whole, for the editor. Throws with the host's reason: deleted, too long. */
export async function getWorkflow(id: string): Promise<Workflow> {
  const res = await ask({ type: 'get-workflow', id }, EDIT_TIMEOUT_MS);
  if (!res.ok) throw new Error(res.error);
  if (!('workflow' in res)) throw new Error('Unexpected answer from the host.');
  return res.workflow;
}

/** Saved as it is on disk now (a new one with its id). Throws with the host's reason: a folder it refuses. */
export async function saveWorkflow(workflow: Workflow): Promise<Workflow> {
  const res = await ask({ type: 'save-workflow', workflow }, EDIT_TIMEOUT_MS);
  if (!res.ok) throw new Error(res.error);
  if (!('workflow' in res)) throw new Error('Unexpected answer from the host.');
  return res.workflow;
}

export async function deleteWorkflow(id: string): Promise<void> {
  const res = await ask({ type: 'delete-workflow', id }, EDIT_TIMEOUT_MS);
  if (!res.ok) throw new Error(res.error);
}
