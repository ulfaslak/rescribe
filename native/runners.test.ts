// The runners in runners/, as code: what every one of them must keep true (DECISIONS §
// Workflows), and "Claude Code in a folder" (runners/claude/run.sh) as the supervisor runs it,
// against a stand-in for `claude` that writes what the agent would.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { paths } from './lib.ts';
import { listRunners } from './workflows.ts';

const dir = paths({}).runners;

test('every runner directory is listed: a label, a prompt.md and an executable run.sh', () => {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
  assert.deepEqual(
    listRunners(dir)
      .map((r) => r.id)
      .sort(),
    dirs,
  );
});

test('a runner that runs Claude Code runs it restricted to the file tools, never with permissions bypassed', () => {
  for (const r of listRunners(dir)) {
    const script = readFileSync(r.script, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
      // continuation lines are one command
      .replace(/\\\n/g, ' ');
    assert.doesNotMatch(script, /bypassPermissions|dangerously-skip-permissions/, r.id);
    const calls = script.match(/^\s*claude\s.*$/gm) ?? [];
    assert.ok(calls.length > 0, `${r.id} runs Claude Code`);
    for (const call of calls) {
      for (const flag of ['--restricted', '--strict-mcp-config'])
        assert.ok(call.includes(flag), `${r.id}: ${flag} missing in: ${call}`);
      // Restricted mode alone still offers web search and messages to other sessions.
      const tools = /--tools[ =]([\w,]+)/.exec(call)?.[1]?.split(',').sort();
      assert.deepEqual(tools, ['Edit', 'Glob', 'Grep', 'Read', 'Write'], `${r.id}: ${call}`);
      // The prompt is the workflow's, as the host filled it in.
      assert.match(call, /claude -p "\$\(<\$RESCRIBE_PROMPT\)"/, `${r.id}: ${call}`);
    }
  }
});

test('the one Rescribe makes on its first run is Index in Lawcel, as it was before workflows', () => {
  const seeded = listRunners(dir).filter((r) => r.seed);
  assert.deepEqual(
    seeded.map((r) => [r.id, r.seed!.label]),
    [['index-in-lawcel', 'Index in Lawcel']],
  );
});

// --- runners/claude/run.sh --------------------------------------------------------------------
const CLAUDE_SH = path.join(dir, 'claude', 'run.sh');
const root = mkdtempSync(path.join(tmpdir(), 'rescribe-runner-'));
after(() => rmSync(root, { recursive: true, force: true }));

// The agent: what it was given, a note in the folder, and its line next to the transcript.
// FAKE_SUMMARY is that line (none when empty); FAKE_FAIL makes it exit as Claude Code does on an
// error.
const CLAUDE = `#!/bin/sh
printf '%s' "$2" > "$RESCRIBE_RUN_DIR/seen-prompt"
printf '%s\\n' "$@" > "$RESCRIBE_RUN_DIR/seen-args"
pwd -P > "$RESCRIBE_RUN_DIR/seen-cwd"
[ -n "$FAKE_FAIL" ] && { echo '{"type":"result","is_error":true}'; exit 1; }
inbox=; prev=
for a in "$@"; do [ "$prev" = --add-dir ] && inbox=$a; prev=$a; done
head -1 "$inbox/transcript.md" > notes.md
[ -n "$FAKE_SUMMARY" ] && printf '%s\\n' "$FAKE_SUMMARY" > "$inbox/summary"
echo '{"type":"result","is_error":false}'
`;

let n = 0;
function runClaude(env: Record<string, string> = {}): {
  code: number | null;
  last: string;
  run: string;
  folder: string;
} {
  const t = path.join(root, `t${++n}`);
  const [bin, home, run] = ['bin', 'home', 'run'].map((d) => {
    mkdirSync(path.join(t, d), { recursive: true });
    return path.join(t, d);
  }) as [string, string, string];
  const folder = path.join(home, 'notes');
  mkdirSync(folder);
  mkdirSync(path.join(run, 'recording'));
  writeFileSync(path.join(run, 'recording', 'transcript.md'), '# Meet - Acme\n');
  writeFileSync(path.join(run, 'prompt.md'), 'Write notes from "Meet - Acme".\n');
  writeFileSync(path.join(bin, 'claude'), CLAUDE);
  chmodSync(path.join(bin, 'claude'), 0o755);
  const r = spawnSync('/bin/zsh', [CLAUDE_SH], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env['PATH']}`,
      HOME: home,
      // zsh reads .zshenv from here: the human's own puts Homebrew first, in front of the stand-in.
      ZDOTDIR: home,
      RESCRIBE_RUN_DIR: run,
      RESCRIBE_RUN_ID: `test-${n}`,
      RESCRIBE_FOLDER: folder,
      RESCRIBE_PROMPT: path.join(run, 'prompt.md'),
      RESCRIBE_WORKFLOW: 'Notes',
      FAKE_SUMMARY: 'Wrote notes.md: Acme wants a pilot',
      ...env,
    },
  });
  return {
    code: r.status,
    last: `${r.stdout}${r.stderr}`.trimEnd().split('\n').at(-1) ?? '',
    run,
    folder,
  };
}

test('Claude Code in a folder: the prompt given in the folder, restricted, with the transcript to read; its line is the summary', () => {
  const r = runClaude();
  assert.equal(r.code, 0, r.last);
  assert.equal(
    readFileSync(path.join(r.run, 'seen-prompt'), 'utf8'),
    'Write notes from "Meet - Acme".',
  );
  assert.equal(readFileSync(path.join(r.run, 'seen-cwd'), 'utf8').trim(), realpathSync(r.folder));
  const args = readFileSync(path.join(r.run, 'seen-args'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--add-dir') + 1], path.join(r.run, 'recording'));
  assert.ok(args.includes('--restricted'));
  assert.equal(readFileSync(path.join(r.folder, 'notes.md'), 'utf8'), '# Meet - Acme\n');
  assert.equal(
    readFileSync(path.join(r.run, 'summary.txt'), 'utf8'),
    'Wrote notes.md: Acme wants a pilot\n',
  );
  assert.equal(r.last, 'Done: Wrote notes.md: Acme wants a pilot');
});

test('Claude Code in a folder: no summary is still done; an error from Claude Code, or no folder, fails with a line', () => {
  const quiet = runClaude({ FAKE_SUMMARY: '' });
  assert.equal(quiet.code, 0, quiet.last);
  assert.ok(!existsSync(path.join(quiet.run, 'summary.txt')));
  assert.match(
    quiet.last,
    /^Done in .*notes; Claude Code wrote no summary \(see .*trace\.jsonl\)$/,
  );

  const failed = runClaude({ FAKE_FAIL: '1' });
  assert.equal(failed.code, 1);
  assert.match(failed.last, /^Claude Code exited with an error; see .*trace\.jsonl$/);

  const gone = runClaude({ RESCRIBE_FOLDER: path.join(root, 'nowhere') });
  assert.equal(gone.code, 1);
  assert.match(gone.last, /nowhere is not there any more; nothing was done$/);
  assert.ok(!existsSync(path.join(gone.run, 'seen-prompt')), 'Claude Code never started');
});

test('Claude Code in a folder: a long summary is cut to 200 characters, counted as characters', () => {
  const long = `Notes for Ærø: ${'å'.repeat(250)}`;
  const r = runClaude({ FAKE_SUMMARY: long });
  assert.equal(r.code, 0, r.last);
  const summary = readFileSync(path.join(r.run, 'summary.txt'), 'utf8').trimEnd();
  assert.equal([...summary].length, 200);
  assert.ok(summary.endsWith('…'));
});
