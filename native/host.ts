// The native messaging host (DECISIONS § Workflows): the browser starts it for one message from
// the extension (`chrome.runtime.sendNativeMessage`), it answers once and exits. Installed by
// native/install.ts, which points the browser at a wrapper that runs this file with Node.
//
// `list-routines`: the workflows, for the stop dialog and the rows. `list-workflows`,
// `save-workflow`, `delete-workflow`: the Workflows section's (workflows.ts). `run-routine`: the
// workflow and the recording's directory checked (store.ts `resolveRecording`), a run directory
// made with the runner's copy, the recording's files and the prompt filled in, and the supervisor
// (supervise.ts) started detached in a session of its own, so the run outlives this process,
// which the browser kills once it has answered, and the browser itself. `routine-status`: what
// the run's status.json says. stdout carries the framed answer and nothing else; diagnostics go
// to stderr.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderPrompt,
  type HostRequest,
  type HostResponse,
  type PromptVariable,
  type RunStatus,
} from '../src/lib/routines.ts';
import { decodeMessage, encodeMessage, makeRunId, paths, type Paths } from './lib.ts';
import {
  currentStatus,
  findRun,
  resolveRecording,
  runDir,
  type RunSpec,
  writeStatus,
} from './store.ts';
import {
  checkFolder,
  copyRunner,
  deleteWorkflow,
  ensureWorkflows,
  folderRules,
  listRunners,
  listWorkflows,
  readWorkflow,
  runnerInfo,
  saveWorkflow,
  type Runner,
} from './workflows.ts';

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

const home = (): string => process.env['HOME'] ?? homedir();

/** The runners, with the workflows made on the first run (workflows.ts `ensureWorkflows`). */
function setUp(p: Paths): Runner[] {
  const runners = listRunners(p.runners);
  ensureWorkflows(p, runners, home());
  return runners;
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * What a prompt's variables stand for in this run (lib/routines.ts PROMPT_VARIABLES): the day and
 * time it started in this machine's zone, as the folder's name has them, and who was there, from
 * the copy of meta.json.
 */
function promptValues(
  inbox: string,
  title: string,
  folder: string,
  workflow: string,
): Record<PromptVariable, string> {
  let meta: { startedAt?: unknown; participants?: unknown } = {};
  try {
    meta = JSON.parse(readFileSync(path.join(inbox, 'meta.json'), 'utf8')) as typeof meta;
  } catch {
    // resolveRecording read it; a file gone since leaves the values it gave empty
  }
  const started = typeof meta.startedAt === 'number' ? new Date(meta.startedAt) : undefined;
  const names = Array.isArray(meta.participants)
    ? meta.participants.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];
  return {
    title,
    date: started
      ? `${started.getFullYear()}-${two(started.getMonth() + 1)}-${two(started.getDate())}`
      : 'unknown',
    time: started ? `${two(started.getHours())}:${two(started.getMinutes())}` : 'unknown',
    participants: names.length ? names.join(', ') : 'not known',
    transcript: path.join(inbox, 'transcript.md'),
    folder,
    workflow,
  };
}

function runRoutine(req: Extract<HostRequest, { type: 'run-routine' }>): HostResponse {
  const p = paths(process.env);
  // Asked again for a start it has seen (the answer was lost): that run, not a second one.
  const seen = findRun(p.runs, req.key);
  if (seen) return { ok: true, run: currentStatus(seen) };
  const runners = setUp(p);
  const workflow = readWorkflow(p, req.routine);
  if (!workflow)
    return { ok: false, error: `There is no workflow "${req.routine}": it was deleted.` };
  const runner = runners.find((r) => r.id === workflow.runner);
  if (!runner)
    return {
      ok: false,
      error: `${workflow.label} runs with "${workflow.runner}", which is not in ${p.runners}.`,
    };
  // Checked again: workflow.json may have been edited by hand since the editor saved it.
  const folder = checkFolder(workflow.folder, folderRules(p, home()));
  const recordingDir = resolveRecording(p.recordings, req.recording);
  const runId = makeRunId(new Date(), workflow.id, randomBytes(2).toString('hex'));
  const dir = runDir(p.runs, runId);
  mkdirSync(dir, { recursive: true });
  // The run gets a copy of the runner: a shell reads its script as it goes, so a pull in the
  // clone that changes run.sh under a run would have it carry on with the new file's bytes.
  const script = copyRunner(runner, path.join(dir, 'runner'));
  // The recording's files Claude Code reads are copies: nothing a run does reaches the folder
  // that is the recording's archive.
  const inbox = path.join(dir, 'recording');
  mkdirSync(inbox);
  for (const name of ['transcript.md', 'meta.json', 'transcript.json'])
    if (existsSync(path.join(recordingDir, name)))
      copyFileSync(path.join(recordingDir, name), path.join(inbox, name));
  // The prompt as Claude Code gets it: the runner's before, the workflow's, the runner's after.
  const values = promptValues(inbox, req.recording.title, folder, workflow.label);
  const prompt = path.join(dir, 'prompt.md');
  writeFileSync(
    prompt,
    [runner.before, workflow.prompt, runner.after]
      .filter((t): t is string => t !== undefined && t.trim() !== '')
      .map((t) => renderPrompt(t.trim(), values))
      .join('\n\n') + '\n',
  );
  const spec: RunSpec = {
    runId,
    key: req.key,
    routine: workflow.id,
    label: workflow.label,
    runner: runner.id,
    script,
    prompt,
    folder,
    timeoutMinutes: runner.timeoutMinutes,
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
    case 'list-routines': {
      const runners = setUp(p);
      return {
        ok: true,
        // A workflow whose runner is gone (a hand edit, a runner removed) is not offered.
        routines: listWorkflows(p)
          .filter((w) => runners.some((r) => r.id === w.runner))
          .map(({ id, label, description }) => ({
            id,
            label,
            ...(description !== undefined ? { description } : {}),
          })),
        recordings: p.recordings,
      };
    }
    case 'list-workflows': {
      const runners = setUp(p);
      return {
        ok: true,
        workflows: listWorkflows(p),
        runners: runners.map(runnerInfo),
        home: home(),
      };
    }
    case 'save-workflow': {
      const runners = setUp(p);
      return {
        ok: true,
        workflow: saveWorkflow(p, req.workflow, runners, folderRules(p, home())),
      };
    }
    case 'delete-workflow':
      setUp(p);
      deleteWorkflow(p, req.id);
      return { ok: true, deleted: req.id };
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
