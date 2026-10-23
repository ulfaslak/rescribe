// Routines: what the human can have done with a recording once its transcript is in the folder
// (DECISIONS § Routines). A routine is a script on the human's machine, run by the native host
// (native/host.ts) outside the browser; the extension only lists them, starts one and follows it.
// This file is the protocol between the two and the words the pages use for a run. Pure: the
// host imports its types too.

/** The native messaging host's name, in its manifest and in `chrome.runtime.sendNativeMessage`. */
export const NATIVE_HOST = 'com.rescribe.host';

/** A routine as the host lists it, from `routines/<id>/routine.json`. */
export interface RoutineInfo {
  id: string;
  /** The button's label: "Index in Lawcel". */
  label: string;
  /** One line under the button: what it does. */
  description?: string;
}

/** The recording a run is for, as the extension knows it: where it was exported, and its id. */
export interface RunTarget {
  id: string;
  title: string;
  /** The name of the Settings folder (the handle's name); the host checks it is its own. */
  folder: string;
  /** The recording's directory under that folder (`Recording.exportPath`). */
  exportPath: string;
}

export type HostRequest =
  | { type: 'list-routines' }
  | { type: 'run-routine'; routine: string; recording: RunTarget }
  | { type: 'routine-status'; runId: string };

export type RunState = 'running' | 'done' | 'failed';

/** One run of a routine, as the host reports it (`~/.rescribe/runs/<runId>/status.json`). */
export interface RunStatus {
  runId: string;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  /** done: the routine's one line; failed: why. */
  message?: string;
  /** The run's log file, absolute, for the human. */
  log: string;
}

export type HostResponse =
  | { ok: true; routines: RoutineInfo[]; recordings: string }
  | { ok: true; run: RunStatus }
  | { ok: false; error: string };

/**
 * A routine chosen for a recording, on its record. `waiting`: chosen, and the transcript is not in
 * the folder yet (it starts when it is); `running` to `done` or `failed` as the host reports.
 */
export interface RoutineRun {
  id: string;
  label: string;
  state: 'waiting' | RunState;
  runId?: string;
  /** Epoch ms: when it was chosen (`waiting`), started (`running`) or ended. */
  at: number;
  /** done: the routine's one line; failed: why. */
  message?: string;
  log?: string;
}

/** A routine to wait for the transcript. */
export function waitingRun(routine: RoutineInfo, now: number): RoutineRun {
  return { id: routine.id, label: routine.label, state: 'waiting', at: now };
}

/** The record's run after a host status: the state, when, what it said, where its log is. */
export function applyStatus(run: RoutineRun, status: RunStatus): RoutineRun {
  return {
    ...run,
    state: status.state,
    runId: status.runId,
    at: status.state === 'running' ? status.startedAt : (status.endedAt ?? status.startedAt),
    message: status.message,
    log: status.log,
  };
}

/** `14:02`, local. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * One line about a run, for the row and the processing tab: "Index in Lawcel: running since
 * 14:02", "Index in Lawcel: done at 14:09. 2026-10-23-ulf-carolina: …", "Index in Lawcel
 * failed: …". `transcribed`: whether the transcript is in the folder, which a waiting run waits for.
 */
export function describeRun(run: RoutineRun, transcribed: boolean): string {
  switch (run.state) {
    case 'waiting':
      return transcribed
        ? `${run.label}: starting…`
        : `${run.label}: starts when the transcript is in the folder.`;
    case 'running':
      return `${run.label}: running since ${clock(run.at)}.`;
    case 'done':
      return `${run.label}: done at ${clock(run.at)}.${run.message ? ` ${run.message}` : ''}`;
    case 'failed':
      return `${run.label} failed: ${run.message ?? 'unknown error'}`;
  }
}
