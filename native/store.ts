// The native host's disk (DECISIONS § Routines): the routines in `routines/<id>/`, the recording
// a run is for under the recordings folder, and each run's directory under `runs/<runId>/`
// (run.json: what to run; status.json: how it went; log.txt: what it printed).
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { RoutineInfo, RunStatus, RunTarget } from '../src/lib/routines.ts';
import { isRunId } from './lib.ts';

/** A routine on disk: what the extension sees, plus where it is and how long it may take. */
export interface Routine extends RoutineInfo {
  dir: string;
  script: string;
  /** Minutes before the supervisor stops it; `routine.json` `timeoutMinutes`, 60 by default. */
  timeoutMinutes: number;
}

/** What the host hands the supervisor: `runs/<runId>/run.json`. */
export interface RunSpec {
  runId: string;
  routine: string;
  label: string;
  script: string;
  timeoutMinutes: number;
  recordingDir: string;
  recording: RunTarget;
}

/** `status.json`: the extension's RunStatus, plus the supervisor's pid while it runs. */
export interface StoredStatus extends RunStatus {
  pid?: number;
  exitCode?: number | null;
}

const DEFAULT_TIMEOUT_MINUTES = 60;

function isExecutable(file: string): boolean {
  try {
    return statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Every `routines/<id>/` with a `routine.json` (`label`, optional `description`, `order`,
 * `timeoutMinutes`) and an executable `run.sh`, by `order` then label. A broken one is skipped
 * with a line on stderr (Chrome keeps the host's stderr in its log).
 */
export function listRoutines(dir: string): Routine[] {
  if (!existsSync(dir)) return [];
  const out: (Routine & { order: number })[] = [];
  for (const id of readdirSync(dir).sort()) {
    if (id.startsWith('.') || id.startsWith('_')) continue;
    const rdir = path.join(dir, id);
    if (!statSync(rdir).isDirectory()) continue;
    const script = path.join(rdir, 'run.sh');
    try {
      const spec = JSON.parse(readFileSync(path.join(rdir, 'routine.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      if (typeof spec['label'] !== 'string' || !spec['label']) throw new Error('no label');
      if (!isExecutable(script)) throw new Error('run.sh missing or not executable');
      out.push({
        id,
        label: spec['label'],
        ...(typeof spec['description'] === 'string' ? { description: spec['description'] } : {}),
        dir: rdir,
        script,
        timeoutMinutes:
          typeof spec['timeoutMinutes'] === 'number' && spec['timeoutMinutes'] > 0
            ? spec['timeoutMinutes']
            : DEFAULT_TIMEOUT_MINUTES,
        order: typeof spec['order'] === 'number' ? spec['order'] : 100,
      });
    } catch (err) {
      process.stderr.write(`[rescribe-host] routine ${id} skipped: ${String(err)}\n`);
    }
  }
  out.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return out.map(({ order: _order, ...r }) => r);
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and is someone else's, which a pid we started cannot become unless reused.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A run's status as the extension gets it: `running` with no supervisor alive (the machine
 * restarted under it, the supervisor was killed) is `failed`, written back so it stays so.
 */
export function currentStatus(dir: string): RunStatus {
  const s = readStatus(dir);
  if (s.state === 'running' && s.pid !== undefined && !alive(s.pid)) {
    const failed: StoredStatus = {
      ...s,
      state: 'failed',
      endedAt: Date.now(),
      message: 'Interrupted: the run stopped without finishing (a restart?). See the log.',
    };
    delete failed.pid;
    writeStatus(dir, failed);
    return publicStatus(failed);
  }
  return publicStatus(s);
}

export function publicStatus(s: StoredStatus): RunStatus {
  const { pid: _pid, exitCode: _exitCode, ...rest } = s;
  return rest;
}
