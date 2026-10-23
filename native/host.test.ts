// The native host as the browser drives it: a process per message, framed on stdin and stdout,
// against a temporary home, recordings folder and routines directory. The routines here are
// small shell scripts; what they record of their environment is what a real one would get.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HostRequest, HostResponse, RunStatus, RunTarget } from '../src/lib/routines.ts';
import { decodeMessage, encodeMessage } from './lib.ts';
import { writeStatus } from './store.ts';

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host.ts');
const root = mkdtempSync(path.join(tmpdir(), 'rescribe-host-'));
after(() => rmSync(root, { recursive: true, force: true }));

const home = path.join(root, 'home');
const recordings = path.join(home, 'recordings');
const routines = path.join(root, 'routines');
const env = {
  ...process.env,
  RESCRIBE_HOME: home,
  RESCRIBE_ROUTINES: routines,
  RESCRIBE_NOTIFY: '0',
  ANTHROPIC_API_KEY: 'sk-ant-must-not-reach-a-routine',
};

function routine(id: string, spec: object, script: string): void {
  const dir = path.join(routines, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'routine.json'), JSON.stringify(spec));
  writeFileSync(path.join(dir, 'run.sh'), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(dir, 'run.sh'), 0o755);
}

// Records what it was given, says one thing for the human, and succeeds.
routine(
  'echo',
  { label: 'Echo', description: 'Says what it got', order: 1 },
  'env > "$RESCRIBE_RUN_DIR/env.txt"; echo working; echo "Echoed $RESCRIBE_TITLE" > "$RESCRIBE_RUN_DIR/summary.txt"',
);
routine('fails', { label: 'Fails', order: 2 }, 'echo first; echo "the reason it failed"; exit 3');
routine('slow', { label: 'Slow', order: 3 }, 'sleep 5');
// Broken ones are not listed.
routine('nolabel', {}, 'true');
mkdirSync(path.join(routines, 'noscript'), { recursive: true });
writeFileSync(path.join(routines, 'noscript', 'routine.json'), '{"label":"No script"}');

function recording(exportPath: string, id: string, transcript = true): RunTarget {
  const dir = path.join(recordings, exportPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id }));
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

async function run(routineId: string, target: RunTarget): Promise<RunStatus> {
  const res = await ask({ type: 'run-routine', routine: routineId, recording: target });
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

test('lists the routines in order, and where recordings must be', async () => {
  const res = await ask({ type: 'list-routines' });
  assert.ok(res.ok && 'routines' in res);
  assert.deepEqual(res.routines, [
    { id: 'echo', label: 'Echo', description: 'Says what it got' },
    { id: 'fails', label: 'Fails' },
    { id: 'slow', label: 'Slow' },
  ]);
  assert.equal(res.recordings, recordings);
});

test('runs a routine on the recording, outside the host, with its summary at the end', async () => {
  const target = recording('2026-10-23 12-02 Meet - Ulf - Carolina', 'rec-1');
  const started = await run('echo', target);
  assert.match(started.runId, /^\d{8}-\d{6}-echo-[0-9a-f]{4}$/);
  const done = await settle(started.runId);
  assert.equal(done.state, 'done');
  assert.equal(done.message, 'Echoed A call');
  assert.ok(done.endedAt! >= done.startedAt);
  const runDir = path.dirname(done.log);
  assert.match(readFileSync(done.log, 'utf8'), /working/);
  const seen = readFileSync(path.join(runDir, 'env.txt'), 'utf8');
  assert.match(
    seen,
    new RegExp(`^RESCRIBE_RECORDING_DIR=${path.join(recordings, target.exportPath)}$`, 'm'),
  );
  assert.match(seen, new RegExp(`^RESCRIBE_RUN_DIR=${runDir}$`, 'm'));
  assert.match(seen, /^RESCRIBE_TITLE=A call$/m);
  assert.doesNotMatch(seen, /ANTHROPIC_API_KEY/);
  assert.match(seen, /^PATH=.*\/\.local\/bin:\/opt\/homebrew\/bin:/m);
});

test('a failing routine fails with the last line it printed', async () => {
  const done = await settle((await run('fails', recording('fails', 'rec-2'))).runId);
  assert.equal(done.state, 'failed');
  assert.equal(done.message, 'the reason it failed');
});

test('a run whose supervisor is gone is failed, not running forever', async () => {
  const started = await run('slow', recording('slow', 'rec-3'));
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
    [{ id: 'x', title: 'x', folder: 'recordings', exportPath: 'missing' }, /no readable meta/],
    [{ id: 'x', title: 'x', folder: 'recordings', exportPath: '../../etc' }, /not inside/],
  ];
  for (const [target, error] of cases) {
    const res = await ask({ type: 'run-routine', routine: 'echo', recording: target });
    assert.ok(!res.ok, target.exportPath);
    assert.match(res.error, error);
  }
  const unknown = await ask({
    type: 'run-routine',
    routine: 'nope',
    recording: recording('ok', 'rec-7'),
  });
  assert.ok(!unknown.ok && /No routine "nope"/.test(unknown.error));
  const notARun = await ask({ type: 'routine-status', runId: '../../etc' });
  assert.ok(!notARun.ok && /Not a run id/.test(notARun.error));
});
