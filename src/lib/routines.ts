// Workflows: what the human can have done with a recording once its transcript is in the folder
// (DECISIONS § Workflows). A workflow is the human's configuration (a name, a folder, the prompt
// Claude Code is given), kept by the native host (native/host.ts) as files; its runner, code in
// this repository (`runners/<id>/`), runs it outside the browser. The extension lists them, edits
// them, starts one on a recording and follows the run. This file is the protocol between the two
// and the words the pages use for a run; a workflow's run on a recording is still a "routine" in
// the code and on the record (`Recording.routine`), its name from before workflows. Pure: the host
// imports its types too.

/** The native messaging host's name, in its manifest and in `chrome.runtime.sendNativeMessage`. */
export const NATIVE_HOST = 'com.rescribe.host';

/** A workflow as the stop dialog and the rows offer it. */
export interface RoutineInfo {
  id: string;
  /** Its name: "Index in Lawcel". */
  label: string;
  /** One line under its button: what it does. */
  description?: string;
}

/**
 * A workflow as the Workflows section edits it: `~/.rescribe/workflows/<id>/` (`workflow.json`,
 * `prompt.md`) on the host's side.
 */
export interface Workflow extends RoutineInfo {
  /** Given by the host when it is first saved (empty until then) and never changed: records name it. */
  id: string;
  /** The runner that runs it (`runners/<runner>/`). */
  runner: string;
  /** Where Claude Code works: an absolute path (`~/` is expanded when it is saved). */
  folder: string;
  /** What Claude Code is told, with `{{variables}}` (PROMPT_VARIABLES). */
  prompt: string;
}

/** A runner as the host lists it for the editor: `runners/<id>/runner.json` and its texts. */
export interface RunnerInfo {
  id: string;
  /** Its name in the editor's select. */
  label: string;
  /** What it does around Claude Code. */
  description: string;
  /** What the workflow's folder is to it. */
  folderHint: string;
  /** The folder a new workflow of it starts with. */
  defaultFolder?: string;
  /** The prompt a new workflow of it starts with. */
  prompt: string;
  /** What it puts before and after the workflow's prompt, variables and all. */
  before?: string;
  after?: string;
}

/**
 * The variables a prompt can use, each as `{{name}}`, anywhere and as often as it likes; the host
 * fills them in when a run starts (`renderPrompt`). The names are fixed: a prompt names them.
 */
export const PROMPT_VARIABLES = [
  { name: 'title', means: "the recording's title in Rescribe" },
  { name: 'date', means: 'the day it started: 2026-10-27' },
  { name: 'time', means: 'when it started: 14:02' },
  { name: 'participants', means: 'who was on the call, as Meet named them' },
  { name: 'transcript', means: 'the transcript, a file Claude Code can read' },
  { name: 'folder', means: "the workflow's folder" },
  { name: 'workflow', means: "the workflow's name" },
] as const;

export type PromptVariable = (typeof PROMPT_VARIABLES)[number]['name'];

/** `{{name}}` (spaces inside the braces allowed) replaced by its value; any other `{{…}}` stays as written. */
export function renderPrompt(template: string, values: Record<PromptVariable, string>): string {
  return template.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (all, name: string) =>
    Object.hasOwn(values, name) ? values[name as PromptVariable] : all,
  );
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
  /**
   * `key` names this start (`runKey`): the host answers a key it has seen with that run instead
   * of starting another, so a start whose answer was lost can be asked again safely.
   */
  | { type: 'run-routine'; routine: string; recording: RunTarget; key: string }
  | { type: 'routine-status'; runId: string }
  | { type: 'list-workflows' }
  /** A new one has an empty `id`; the answer has the one the host gave it. */
  | { type: 'save-workflow'; workflow: Workflow }
  | { type: 'delete-workflow'; id: string };

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
  /** `home`: the human's home directory, for showing folders as `~/…`. */
  | { ok: true; workflows: Workflow[]; runners: RunnerInfo[]; home: string }
  | { ok: true; workflow: Workflow }
  | { ok: true; deleted: string }
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

/** The start of `run` on recording `id`: the same until the human picks a routine again. */
export function runKey(id: string, run: Pick<RoutineRun, 'id' | 'at'>): string {
  return `${id}:${run.id}:${run.at}`;
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
