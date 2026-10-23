// One run of a routine, started detached by native/host.ts: `node supervise.ts <runDir>`. Runs the
// routine's run.sh with the recording's directory in its environment (lib.ts `routineEnv`), its
// output into the run's log.txt, then writes the outcome into status.json and tells the human
// with a macOS notification. Lives in a session of its own, so neither the host's exit nor the
// browser's takes it down; a run that outlives its routine's `timeoutMinutes` is stopped.
//
// What a routine gets: RESCRIBE_RECORDING_DIR (the recording's directory: transcript.md,
// transcript.json, meta.json, the video), RESCRIBE_RUN_DIR (this run's directory, for anything
// it keeps), RESCRIBE_RUN_ID, RESCRIBE_TITLE. Exit 0 is done. Its one line for the human is
// RESCRIBE_RUN_DIR/summary.txt when it writes one, else the last line it printed.
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lastLine, routineEnv } from './lib.ts';
import { readSpec, readStatus, writeStatus, type StoredStatus } from './store.ts';

const dir = path.resolve(process.argv[2] ?? '');
const spec = readSpec(dir);
const log = path.join(dir, 'log.txt');

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function notify(title: string, message: string): void {
  if (process.env['RESCRIBE_NOTIFY'] === '0') return;
  // Through argv, so no quoting of the message into AppleScript.
  const n = spawn(
    'osascript',
    [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title "Rescribe" subtitle (item 1 of argv)',
      '-e',
      'end run',
      title,
      message,
    ],
    { stdio: 'ignore' },
  );
  n.on('error', () => undefined);
}

function finish(patch: Partial<StoredStatus>): void {
  const status: StoredStatus = { ...readStatus(dir), endedAt: Date.now(), ...patch };
  delete status.pid;
  writeStatus(dir, status);
  const ok = status.state === 'done';
  notify(
    ok ? `${spec.label}: done` : `${spec.label} failed`,
    status.message ?? spec.recording.title,
  );
}

const out = openSync(log, 'a');
const child = spawn(spec.script, [], {
  cwd: path.dirname(spec.script),
  // Its own process group, so a timeout stops everything it started (claude and its tools too).
  detached: true,
  stdio: ['ignore', out, out],
  env: routineEnv(process.env, {
    RESCRIBE_RECORDING_DIR: spec.recordingDir,
    RESCRIBE_RUN_DIR: dir,
    RESCRIBE_RUN_ID: spec.runId,
    RESCRIBE_TITLE: spec.recording.title,
  }),
});
writeStatus(dir, { ...readStatus(dir), pid: process.pid });

/** After SIGTERM, how long the routine's group gets before SIGKILL. */
const KILL_AFTER_MS = 10_000;

function signalGroup(signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), KILL_AFTER_MS).unref();
}, spec.timeoutMinutes * 60_000);

child.on('error', (err) => {
  clearTimeout(timer);
  finish({ state: 'failed', message: `Could not start ${spec.script}: ${err.message}` });
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const printed = lastLine(readText(log));
  if (code === 0) {
    const summary = path.join(dir, 'summary.txt');
    const message = (existsSync(summary) && lastLine(readText(summary))) || printed;
    finish({ state: 'done', exitCode: 0, ...(message ? { message } : {}) });
    return;
  }
  const why = timedOut
    ? `Stopped after ${spec.timeoutMinutes} minutes.`
    : (printed ?? `Exited with ${code ?? signal}.`);
  finish({ state: 'failed', exitCode: code, message: why });
});
