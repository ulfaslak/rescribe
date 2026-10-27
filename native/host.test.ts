// The native host as the browser drives it: a process per message, framed on stdin and stdout,
// against a temporary home, recordings folder and runners directory. The runners here are small
// shell scripts; what they record of their environment is what a real one would get. The
// workflows are made the way the app makes them, through the host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  HostRequest,
  HostResponse,
  RunStatus,
  RunTarget,
  Workflow,
} from '../src/lib/routines.ts';
import { decodeMessage, encodeMessage } from './lib.ts';
import { writeStatus } from './store.ts';

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host.ts');
const root = mkdtempSync(path.join(tmpdir(), 'rescribe-host-'));
after(() => rmSync(root, { recursive: true, force: true }));

const home = path.join(root, 'home');
const recordings = path.join(home, 'recordings');
const runners = path.join(root, 'runners');
// The human's home, which a workflow's folder must be in, with a folder of notes.
const user = path.join(root, 'user');
const notes = path.join(user, 'notes');
mkdirSync(notes, { recursive: true });
const env = {
  ...process.env,
  HOME: user,
  RESCRIBE_HOME: home,
  RESCRIBE_RUNNERS: runners,
  RESCRIBE_NOTIFY: '0',
  ANTHROPIC_API_KEY: 'sk-ant-must-not-reach-a-routine',
};

function runner(
  id: string,
  spec: object,
  script: string,
  texts: { prompt?: string; before?: string; after?: string } = {},
): void {
  const dir = path.join(runners, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(spec));
  writeFileSync(path.join(dir, 'run.sh'), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(dir, 'run.sh'), 0o755);
  writeFileSync(path.join(dir, 'prompt.md'), texts.prompt ?? 'Do it.\n');
  if (texts.before !== undefined) writeFileSync(path.join(dir, 'before.md'), texts.before);
  if (texts.after !== undefined) writeFileSync(path.join(dir, 'after.md'), texts.after);
}

// Records what it was given, says one thing for the human, and succeeds. Rescribe makes a
// workflow of it on its first run (`seed`), as it does Index in Lawcel.
runner(
  'echo',
  {
    label: 'Echo runner',
    description: 'Says what it got',
    folder: 'Anywhere',
    defaultFolder: '~/notes',
    order: 1,
    seed: { label: 'Echo', description: 'Says what it got' },
  },
  'env > "$RESCRIBE_RUN_DIR/env.txt"; cp "$RESCRIBE_PROMPT" "$RESCRIBE_RUN_DIR/seen-prompt.md"; echo working; echo "Echoed $RESCRIBE_TITLE" > "$RESCRIBE_RUN_DIR/summary.txt"',
  {
    prompt:
      'Echo {{title}} ({{ date }} {{time}}) with {{participants}} from {{transcript}} in {{folder}}; {{unknown}} stays.\n',
    before: 'Before {{workflow}}.\n',
    after: '\nAfter.\n',
  },
);
runner('fails', { label: 'Fails', order: 2 }, 'echo first; echo "the reason it failed"; exit 3');
runner('slow', { label: 'Slow', order: 3 }, 'sleep 5');
// Broken ones are not listed.
runner('nolabel', {}, 'true');
runner('Bad_Name', { label: 'Bad name' }, 'true');
writeFileSync(path.join(runners, 'README.md'), '# not a runner\n');
mkdirSync(path.join(runners, 'noscript'), { recursive: true });
writeFileSync(path.join(runners, 'noscript', 'runner.json'), '{"label":"No script"}');

/** 2026-10-23 12:02 in this machine's zone. */
const STARTED = new Date(2026, 9, 23, 12, 2).getTime();

function recording(exportPath: string, id: string, transcript = true): RunTarget {
  const dir = path.join(recordings, exportPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, startedAt: STARTED, participants: ['Ulf', 'Carolina'] }),
  );
  if (transcript) writeFileSync(path.join(dir, 'transcript.md'), '# A call\n');
  return { id, title: 'A call', folder: 'recordings', exportPath };
}

function ask(req: HostRequest): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', HOST], { env });
    let out = Buffer.alloc(0);
    child.stdout.on('data', (d: Buffer) => (out = Buffer.concat([out, d])));
    child.on('error', reject);
    child.on('exit', () => {
      const got = decodeMessage(out);
      if (!got || got.rest.length > 0) reject(new Error(`not one framed message: ${String(out)}`));
      else resolve(got.message as HostResponse);
    });
    // As Chrome does for sendNativeMessage: one message, the pipe left open until the answer.
    child.stdin.write(encodeMessage(req));
  });
}

async function save(w: Partial<Workflow>): Promise<Workflow> {
  const res = await ask({
    type: 'save-workflow',
    workflow: { id: '', label: '', runner: 'echo', folder: notes, prompt: 'Do it.', ...w },
  });
  assert.ok(res.ok && 'workflow' in res, JSON.stringify(res));
  return res.workflow;
}

async function refused(w: Partial<Workflow>): Promise<string> {
  const res = await ask({
    type: 'save-workflow',
    workflow: { id: '', label: 'X', runner: 'echo', folder: notes, prompt: 'Do it.', ...w },
  });
  assert.ok(!res.ok, `saved: ${JSON.stringify(w)}`);
  return res.error;
}

async function workflows(): Promise<Workflow[]> {
  const res = await ask({ type: 'list-workflows' });
  assert.ok(res.ok && 'workflows' in res, JSON.stringify(res));
  return res.workflows;
}

let starts = 0;
async function run(workflow: string, target: RunTarget, key = `k${++starts}`): Promise<RunStatus> {
  const res = await ask({ type: 'run-routine', routine: workflow, recording: target, key });
  assert.ok(res.ok && 'run' in res, JSON.stringify(res));
  assert.equal(res.run.state, 'running');
  return res.run;
}

async function settle(runId: string): Promise<RunStatus> {
  for (let i = 0; i < 100; i++) {
    const res = await ask({ type: 'routine-status', runId });
    assert.ok(res.ok && 'run' in res, JSON.stringify(res));
    if (res.run.state !== 'running') return res.run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('still running');
}

test('the first run makes the seeded workflow; the list offers the workflows, and says where recordings must be', async () => {
  assert.ok(!existsSync(path.join(home, 'workflows')));
  const res = await ask({ type: 'list-routines' });
  assert.ok(res.ok && 'routines' in res);
  assert.deepEqual(res.routines, [{ id: 'echo', label: 'Echo', description: 'Says what it got' }]);
  assert.equal(res.recordings, recordings);
  // On disk as the human can read and edit it, the runner's prompt as its own.
  const dir = path.join(home, 'workflows', 'echo');
  assert.equal(
    readFileSync(path.join(dir, 'prompt.md'), 'utf8'),
    readFileSync(path.join(runners, 'echo', 'prompt.md'), 'utf8'),
  );
  const stored = JSON.parse(readFileSync(path.join(dir, 'workflow.json'), 'utf8')) as Workflow;
  assert.equal(stored.runner, 'echo');
  assert.equal(stored.folder, notes);
});

test('the editor gets the workflows, prompt and all, the runners with their texts, and the home folder', async () => {
  const res = await ask({ type: 'list-workflows' });
  assert.ok(res.ok && 'workflows' in res);
  assert.equal(res.home, user);
  assert.deepEqual(
    res.runners.map((r) => r.id),
    ['echo', 'fails', 'slow'],
  );
  const echo = res.runners[0]!;
  assert.equal(echo.label, 'Echo runner');
  assert.equal(echo.folderHint, 'Anywhere');
  assert.equal(echo.defaultFolder, '~/notes');
  assert.equal(echo.before, 'Before {{workflow}}.\n');
  assert.equal(echo.after, '\nAfter.\n');
  assert.match(echo.prompt, /^Echo \{\{title\}\}/);
  assert.ok(!('dir' in echo) && !('script' in echo), 'no paths of the clone');
  assert.deepEqual(
    res.workflows.map((w) => [w.id, w.label, w.runner]),
    [['echo', 'Echo', 'echo']],
  );
});

test('a new workflow gets an id from its name, kept when it is edited; the same name twice gets two', async () => {
  const made = await save({ label: 'Mødenoter for Ærø', runner: 'fails', prompt: 'Fail.' });
  assert.equal(made.id, 'modenoter-for-aero');
  assert.equal(made.folder, realpathSync(notes));
  const again = await save({ label: 'Mødenoter for Ærø', runner: 'fails', prompt: 'Fail.' });
  assert.equal(again.id, 'modenoter-for-aero-2');
  const edited = await save({
    ...made,
    label: 'Meeting notes',
    description: 'One line',
    prompt: 'Fail again.\n',
    folder: '~/notes',
  });
  assert.equal(edited.id, made.id);
  assert.deepEqual(
    (await workflows()).map((w) => [w.id, w.label]),
    [
      ['echo', 'Echo'],
      ['modenoter-for-aero', 'Meeting notes'],
      ['modenoter-for-aero-2', 'Mødenoter for Ærø'],
    ],
  );
  assert.equal(
    readFileSync(path.join(home, 'workflows', made.id, 'prompt.md'), 'utf8'),
    'Fail again.\n',
  );
});

test('a folder a call could do harm from is refused, with a sentence for the human', async () => {
  mkdirSync(path.join(user, '.ssh'), { recursive: true });
  mkdirSync(path.join(user, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(path.join(user, 'Library', 'Mobile Documents', 'notes'), { recursive: true });
  writeFileSync(path.join(user, 'file.txt'), '');
  const cases: [string, RegExp][] = [
    [user, /must be inside your home folder/],
    ['~', /must be inside your home folder/],
    [root, /must be inside your home folder/],
    [tmpdir(), /must be inside your home folder/],
    ['notes', /must be a full path/],
    ['', /Name the folder/],
    [path.join(user, 'missing'), /does not exist/],
    [path.join(user, 'file.txt'), /is not a folder/],
    [path.join(user, '.ssh'), /hidden folder/],
    [path.join(user, 'Library', 'LaunchAgents'), /~\/Library/],
  ];
  for (const [folder, error] of cases) assert.match(await refused({ folder }), error, folder);
  // iCloud Drive is a folder of documents.
  const icloud = await save({ label: 'iCloud', folder: '~/Library/Mobile Documents/notes' });
  assert.equal(
    icloud.folder,
    realpathSync(path.join(user, 'Library', 'Mobile Documents', 'notes')),
  );
  await ask({ type: 'delete-workflow', id: icloud.id });
});

test('a workflow needs a name on one line, a runner there is and a prompt', async () => {
  assert.match(await refused({ label: '  ' }), /Give the workflow a name/);
  assert.match(await refused({ label: 'Two\nlines' }), /name must be one line/);
  assert.match(await refused({ runner: 'nope' }), /no runner "nope"/);
  assert.match(await refused({ prompt: ' \n ' }), /Write the prompt/);
  assert.match(await refused({ id: 'never-made' }), /no workflow "never-made" any more/);
  assert.match(await refused({ id: '../../etc' }), /no workflow "\.\.\/\.\.\/etc" any more/);
});

test('runs a workflow on the recording, outside the host: its runner, its folder, its prompt filled in, and its summary at the end', async () => {
  const target = recording('2026-10-23 12-02 Meet - Ulf - Carolina', 'rec-1');
  const started = await run('echo', target);
  assert.match(started.runId, /^\d{8}-\d{6}-echo-[0-9a-f]{4}$/);
  const done = await settle(started.runId);
  assert.equal(done.state, 'done');
  assert.equal(done.message, 'Echoed A call');
  assert.ok(done.endedAt! >= done.startedAt);
  const runDir = path.dirname(done.log);
  assert.match(readFileSync(done.log, 'utf8'), /working/);
  // It ran from the run's own copy of the runner.
  assert.equal(
    readFileSync(path.join(runDir, 'runner', 'run.sh'), 'utf8').includes('Echoed'),
    true,
  );
  // Copies of the recording's files for Claude Code to read.
  const inbox = path.join(runDir, 'recording');
  assert.equal(readFileSync(path.join(inbox, 'transcript.md'), 'utf8'), '# A call\n');
  assert.ok(existsSync(path.join(inbox, 'meta.json')));
  // The runner's before, the workflow's prompt, the runner's after, the variables filled in.
  assert.equal(
    readFileSync(path.join(runDir, 'seen-prompt.md'), 'utf8'),
    `Before Echo.\n\nEcho A call (2026-10-23 12:02) with Ulf, Carolina from ${inbox}/transcript.md in ${realpathSync(notes)}; {{unknown}} stays.\n\nAfter.\n`,
  );
  const seen = readFileSync(path.join(runDir, 'env.txt'), 'utf8');
  assert.match(
    seen,
    new RegExp(`^RESCRIBE_RECORDING_DIR=${path.join(recordings, target.exportPath)}$`, 'm'),
  );
  assert.match(seen, new RegExp(`^RESCRIBE_RUN_DIR=${runDir}$`, 'm'));
  assert.match(seen, new RegExp(`^RESCRIBE_PROMPT=${runDir}/prompt.md$`, 'm'));
  assert.match(seen, new RegExp(`^RESCRIBE_FOLDER=${realpathSync(notes)}$`, 'm'));
  assert.match(seen, /^RESCRIBE_WORKFLOW=Echo$/m);
  assert.match(seen, /^RESCRIBE_TITLE=A call$/m);
  assert.doesNotMatch(seen, /ANTHROPIC_API_KEY/);
  assert.match(seen, /^PATH=.*\/\.local\/bin:\/opt\/homebrew\/bin:/m);
});

test('a start asked again under the same key gets the same run, not a second one', async () => {
  const target = recording('twice', 'rec-9');
  const first = await run('echo', target, 'rec-9:echo:1');
  const again = await run('echo', target, 'rec-9:echo:1').catch(() => undefined);
  // `run` asserts `running`; the first may have finished already, so ask plainly too.
  const res = await ask({
    type: 'run-routine',
    routine: 'echo',
    recording: target,
    key: 'rec-9:echo:1',
  });
  assert.ok(res.ok && 'run' in res);
  assert.equal(res.run.runId, first.runId);
  if (again) assert.equal(again.runId, first.runId);
  const other = await run('echo', target, 'rec-9:echo:2');
  assert.notEqual(other.runId, first.runId);
  await settle(first.runId);
  await settle(other.runId);
});

test('a failing run fails with the last line it printed', async () => {
  const w = await save({ label: 'Fails', runner: 'fails' });
  const done = await settle((await run(w.id, recording('fails', 'rec-2'))).runId);
  assert.equal(done.state, 'failed');
  assert.equal(done.message, 'the reason it failed');
});

test('a run whose supervisor is gone is failed, not running forever', async () => {
  const w = await save({ label: 'Slow', runner: 'slow' });
  const started = await run(w.id, recording('slow', 'rec-3'));
  const dir = path.dirname(started.log);
  // As after a restart: the status still says running, with a pid nobody has.
  const s = JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')) as { pid: number };
  process.kill(-s.pid, 'SIGKILL');
  try {
    process.kill(s.pid, 'SIGKILL');
  } catch {
    // gone with its group
  }
  writeStatus(dir, { ...started, pid: s.pid });
  await new Promise((r) => setTimeout(r, 200));
  const res = await ask({ type: 'routine-status', runId: started.runId });
  assert.ok(res.ok && 'run' in res);
  assert.equal(res.run.state, 'failed');
  assert.match(res.run.message ?? '', /Interrupted/);
});

test('a run still running far past its time limit is failed, whatever its pid says', async () => {
  const started = await run('slow', recording('stale', 'rec-8'));
  const dir = path.dirname(started.log);
  // As after a restart that handed the pid to a live process: alive, and two hours old.
  writeStatus(dir, { ...started, startedAt: Date.now() - 2 * 3600_000, pid: process.pid });
  const res = await ask({ type: 'routine-status', runId: started.runId });
  assert.ok(res.ok && 'run' in res);
  assert.equal(res.run.state, 'failed');
  assert.match(res.run.message ?? '', /time limit/);
});

test('refuses a recording it cannot vouch for, with a sentence for the human', async () => {
  const cases: [RunTarget, RegExp][] = [
    [{ ...recording('elsewhere', 'rec-4'), folder: 'transcripts' }, /folder named "transcripts"/],
    [{ ...recording('wrong-id', 'rec-5'), id: 'rec-other' }, /another recording/],
    [recording('no-transcript', 'rec-6', false), /no transcript\.md/],
    [{ id: 'x', title: 'x', folder: 'recordings', exportPath: 'missing' }, /does not exist: is/],
    [{ id: 'x', title: 'x', folder: 'recordings', exportPath: '../../etc' }, /not inside/],
  ];
  for (const [target, error] of cases) {
    const res = await ask({ type: 'run-routine', routine: 'echo', recording: target, key: 'r' });
    assert.ok(!res.ok, target.exportPath);
    assert.match(res.error, error);
  }
  const notARun = await ask({ type: 'routine-status', runId: '../../etc' });
  assert.ok(!notARun.ok && /Not a run id/.test(notARun.error));
});

test('a workflow edited by hand to a folder the editor refuses, or to a runner that is gone, does not run', async () => {
  const w = await save({ label: 'Hand edited' });
  const file = path.join(home, 'workflows', w.id, 'workflow.json');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...stored, folder: user }));
  const res = await ask({
    type: 'run-routine',
    routine: w.id,
    recording: recording('hand', 'rec-10'),
    key: 'h1',
  });
  assert.ok(!res.ok && /must be inside your home folder/.test(res.error), JSON.stringify(res));
  writeFileSync(file, JSON.stringify({ ...stored, runner: 'gone' }));
  const gone = await ask({
    type: 'run-routine',
    routine: w.id,
    recording: recording('hand', 'rec-10'),
    key: 'h2',
  });
  assert.ok(!gone.ok && /runs with "gone", which is not in/.test(gone.error), JSON.stringify(gone));
  // Not offered either.
  const list = await ask({ type: 'list-routines' });
  assert.ok(list.ok && 'routines' in list);
  assert.ok(!list.routines.some((r) => r.id === w.id));
  await ask({ type: 'delete-workflow', id: w.id });
});

test('a deleted workflow goes to the trash, is not offered or run, and the seed does not come back', async () => {
  const res = await ask({ type: 'delete-workflow', id: 'echo' });
  assert.ok(res.ok && 'deleted' in res && res.deleted === 'echo', JSON.stringify(res));
  const trash = readdirSync(path.join(home, 'workflows', '.trash'));
  assert.ok(
    trash.some((d) => d.startsWith('echo-')),
    trash.join(),
  );
  assert.ok(!(await workflows()).some((w) => w.id === 'echo'));
  const list = await ask({ type: 'list-routines' });
  assert.ok(list.ok && 'routines' in list);
  assert.ok(!list.routines.some((r) => r.id === 'echo'));
  const ran = await ask({
    type: 'run-routine',
    routine: 'echo',
    recording: recording('deleted', 'rec-11'),
    key: 'd1',
  });
  assert.ok(!ran.ok && /There is no workflow "echo": it was deleted/.test(ran.error));
  const again = await ask({ type: 'delete-workflow', id: 'echo' });
  assert.ok(!again.ok && /There is no workflow "echo"/.test(again.error));
  const traversal = await ask({ type: 'delete-workflow', id: '../runs' });
  assert.ok(!traversal.ok);
  assert.ok(existsSync(path.join(home, 'runs')));
});
