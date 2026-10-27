// The native host's disk (DECISIONS § Workflows): the recording a run is for under the recordings
// folder, and each run's directory under `runs/<runId>/` (run.json: what to run; status.json: how
// it went; log.txt: what it printed). The workflows and their runners are in workflows.ts.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunStatus, RunTarget } from '../src/lib/routines.ts';
import { isRunId } from './lib.ts';

/** What the host hands the supervisor: `runs/<runId>/run.json`. */
export interface RunSpec {
  runId: string;
  /** The extension's name for this start (lib/routines.ts `runKey`): one run per key. */
  key: string;
  /** The workflow's id and name, as they were when it started. */
  routine: string;
  label: string;
  runner: string;
  /** The run's copy of the runner's run.sh. */
  script: string;
  /** The prompt with its variables filled in, before and after included (`prompt.md` here). */
  prompt: string;
  /** The workflow's folder, checked (workflows.ts `checkFolder`). */
  folder: string;
  timeoutMinutes: number;
  recordingDir: string;
  recording: RunTarget;
}

/** `status.json`: the extension's RunStatus, plus the supervisor's pid while it runs. */
export interface StoredStatus extends RunStatus {
  pid?: number;
  exitCode?: number | null;
}

/**
 * The recording's directory on disk, checked: Rescribe's Settings folder must be the recordings
 * folder (the extension knows it only by name: a folder handle has no path), the directory must
 * be inside it, and its `meta.json` must name this recording and sit next to `transcript.md`.
 * Throws with a sentence for the human.
 */
export function resolveRecording(root: string, target: RunTarget): string {
  if (path.basename(root) !== target.folder)
    throw new Error(
      `Rescribe saves into a folder named "${target.folder}", and routines read ${root}: choose that folder in Rescribe's Settings.`,
    );
  const dir = path.resolve(root, target.exportPath);
  if (!dir.startsWith(path.resolve(root) + path.sep))
    throw new Error(`"${target.exportPath}" is not inside ${root}.`);
  if (!existsSync(dir))
    throw new Error(
      `${dir} does not exist: is ${root} the folder Rescribe saves into (Settings), and the recording still in it?`,
    );
  let meta: { id?: unknown };
  try {
    meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { id?: unknown };
  } catch {
    throw new Error(`${dir} has no readable meta.json; is the transcript in the folder?`);
  }
  if (meta.id !== target.id)
    throw new Error(`${dir} holds another recording than "${target.title}".`);
  if (!existsSync(path.join(dir, 'transcript.md'))) throw new Error(`${dir} has no transcript.md.`);
  return dir;
}

/** The run started under `key`, if there is one: its directory. */
export function findRun(runs: string, key: string): string | undefined {
  if (!existsSync(runs)) return undefined;
  for (const id of readdirSync(runs).sort().reverse()) {
    if (!isRunId(id)) continue;
    try {
      if (readSpec(path.join(runs, id)).key === key) return path.join(runs, id);
    } catch {
      // a run directory without run.json yet: not this one
    }
  }
  return undefined;
}

export function runDir(runs: string, runId: string): string {
  if (!isRunId(runId)) throw new Error(`Not a run id: ${runId}`);
  return path.join(runs, runId);
}

export function readSpec(dir: string): RunSpec {
  return JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as RunSpec;
}

export function readStatus(dir: string): StoredStatus {
  return JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')) as StoredStatus;
}

/** Written whole and renamed into place, so a reader never sees half a file. */
export function writeStatus(dir: string, status: StoredStatus): void {
  const tmp = path.join(dir, `status.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(status, null, 2));
  renameSync(tmp, path.join(dir, 'status.json'));
}

/**
 * Whether our supervisor still runs. EPERM is a process of another user: the pid was reused after
 * a restart, since a supervisor we started runs as us.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Past the routine's own timeout, the supervisor has stopped it; this much later, nobody is left to say so. */
const GRACE_MS = 5 * 60_000;

/**
 * A run's status as the extension gets it: `running` with no supervisor alive (the machine
 * restarted under it, the supervisor was killed), or still `running` well past the routine's
 * timeout (a reused pid that looks alive), is `failed`, written back so it stays so.
 */
export function currentStatus(dir: string, now = Date.now()): RunStatus {
  const s = readStatus(dir);
  if (s.state !== 'running') return publicStatus(s);
  let limitMs = Infinity;
  try {
    limitMs = readSpec(dir).timeoutMinutes * 60_000 + GRACE_MS;
  } catch {
    // no run.json: only the pid can tell
  }
  const gone = s.pid !== undefined && !alive(s.pid);
  if (!gone && now - s.startedAt <= limitMs) return publicStatus(s);
  const failed: StoredStatus = {
    ...s,
    state: 'failed',
    endedAt: now,
    message: gone
      ? 'Interrupted: the run stopped without finishing (a restart?). See the log.'
      : 'Lost: the run outlived its time limit without reporting. See the log.',
  };
  delete failed.pid;
  writeStatus(dir, failed);
  return publicStatus(failed);
}

export function publicStatus(s: StoredStatus): RunStatus {
  const { pid: _pid, exitCode: _exitCode, ...rest } = s;
  return rest;
}
