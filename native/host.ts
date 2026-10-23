// The native messaging host (DECISIONS § Routines): the browser starts it for one message from
// the extension (`chrome.runtime.sendNativeMessage`), it answers once and exits. Installed by
// native/install.ts, which points the browser at a wrapper that runs this file with Node.
//
// `list-routines`: the routines in routines/. `run-routine`: the recording's directory checked
// (store.ts `resolveRecording`), a run directory made, and the supervisor (supervise.ts) started
// detached in a session of its own, so the run outlives this process, which the browser kills
// once it has answered, and the browser itself. `routine-status`: what the run's status.json says.
// stdout carries the framed answer and nothing else; diagnostics go to stderr.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostRequest, HostResponse, RunStatus } from '../src/lib/routines.ts';
import { decodeMessage, encodeMessage, makeRunId, paths } from './lib.ts';
import {
  currentStatus,
  findRun,
  listRoutines,
  resolveRecording,
  runDir,
  type RunSpec,
  writeStatus,
} from './store.ts';

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervise.ts');

function readOne(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    process.stdin.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const got = decodeMessage(buf);
        if (got) resolve(got.message);
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('end', () => reject(new Error('stdin closed before a whole message')));
  });
}

function runRoutine(req: Extract<HostRequest, { type: 'run-routine' }>): HostResponse {
  const p = paths(process.env);
  // Asked again for a start it has seen (the answer was lost): that run, not a second one.
  const seen = findRun(p.runs, req.key);
  if (seen) return { ok: true, run: currentStatus(seen) };
  const routine = listRoutines(p.routines).find((r) => r.id === req.routine);
  if (!routine) return { ok: false, error: `No routine "${req.routine}" in ${p.routines}.` };
  const recordingDir = resolveRecording(p.recordings, req.recording);
  const runId = makeRunId(new Date(), routine.id, randomBytes(2).toString('hex'));
  const dir = runDir(p.runs, runId);
  mkdirSync(dir, { recursive: true });
  // The run gets a copy of the routine: a shell reads its script as it goes, so a pull in the
  // clone that changes run.sh under a run would have it carry on with the new file's bytes.
  const copy = path.join(dir, 'routine');
  cpSync(routine.dir, copy, { recursive: true });
  const spec: RunSpec = {
    runId,
    key: req.key,
    routine: routine.id,
    label: routine.label,
    script: path.join(copy, path.basename(routine.script)),
    timeoutMinutes: routine.timeoutMinutes,
    recordingDir,
    recording: req.recording,
  };
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(spec, null, 2));
  const log = path.join(dir, 'log.txt');
  const status: RunStatus = { runId, state: 'running', startedAt: Date.now(), log };
  // Before the spawn: the supervisor reads it as it starts.
  writeStatus(dir, status);
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, ['--no-warnings', SUPERVISOR, dir], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  // Its pid at once, so a status read before the supervisor writes its own can tell it is alive.
  if (child.pid !== undefined) writeStatus(dir, { ...status, pid: child.pid });
  return { ok: true, run: status };
}

function handle(req: HostRequest): HostResponse {
  const p = paths(process.env);
  switch (req.type) {
    case 'list-routines':
      return {
        ok: true,
        routines: listRoutines(p.routines).map(({ id, label, description }) => ({
          id,
          label,
          ...(description !== undefined ? { description } : {}),
        })),
        recordings: p.recordings,
      };
    case 'run-routine':
      return runRoutine(req);
    case 'routine-status':
      return { ok: true, run: currentStatus(runDir(p.runs, req.runId)) };
    default:
      return { ok: false, error: `Unknown request ${JSON.stringify(req)}` };
  }
}

async function main(): Promise<void> {
  let res: HostResponse;
  try {
    res = handle((await readOne()) as HostRequest);
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  process.stdout.write(encodeMessage(res), () => process.exit(0));
}

void main();
