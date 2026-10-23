import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeMessage,
  encodeMessage,
  extensionIdForPath,
  isRunId,
  lastLine,
  makeRunId,
  routineEnv,
} from './lib.ts';

test('a message survives framing, and a partial one waits for the rest', () => {
  const msg = { type: 'run-routine', title: 'Møde – Ulf / Carolina' };
  const framed = encodeMessage(msg);
  assert.equal(framed.readUInt32LE(0), framed.length - 4);
  assert.equal(decodeMessage(framed.subarray(0, 3)), undefined);
  assert.equal(decodeMessage(framed.subarray(0, framed.length - 1)), undefined);
  const both = Buffer.concat([framed, encodeMessage({ type: 'list-routines' })]);
  const first = decodeMessage(both);
  assert.deepEqual(first?.message, msg);
  assert.deepEqual(decodeMessage(first!.rest)?.message, { type: 'list-routines' });
});

test("the extension id is Chrome's hash of the unpacked path", () => {
  // The id Brave shows for the primary clone's dist/ (brave://extensions, 2026-10-23).
  assert.equal(
    extensionIdForPath('/Users/ulfaslak/Documents/git/rescribe/dist'),
    'ofjahjphiojonpemonngebbbjdfjdbmn',
  );
});

test('a run id sorts by time, names the routine, and nothing else passes as one', () => {
  const id = makeRunId(new Date(2026, 9, 3, 9, 5, 7), 'index-in-lawcel', '3f9a');
  assert.equal(id, '20261003-090507-index-in-lawcel-3f9a');
  assert.ok(isRunId(id));
  for (const bad of ['../etc', '20261003-090507-x-3f9a/..', '', '20261003-090507--3f9', 'a/b'])
    assert.ok(!isRunId(bad), bad);
});

test("a routine's environment drops the API key, Claude Code's session and tmux, and finds the tools", () => {
  const env = routineEnv(
    {
      HOME: '/Users/u',
      PATH: '/usr/bin:/bin',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      SSH_AUTH_SOCK: '/tmp/agent',
      TMUX: '/tmp/tmux-501/default,1,0',
      TMUX_PANE: '%3',
    },
    { RESCRIBE_RUN_ID: 'r' },
  );
  assert.equal(env['ANTHROPIC_API_KEY'], undefined);
  assert.equal(env['CLAUDECODE'], undefined);
  assert.equal(env['CLAUDE_CODE_ENTRYPOINT'], undefined);
  assert.equal(env['TMUX_PANE'], undefined);
  assert.equal(env['TMUX'], undefined);
  assert.equal(env['SSH_AUTH_SOCK'], '/tmp/agent');
  assert.equal(env['RESCRIBE_RUN_ID'], 'r');
  assert.deepEqual(env['PATH']?.split(':'), [
    '/Users/u/.local/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]);
});

test('the last line of a log is its last non-empty one, kept short', () => {
  assert.equal(lastLine('a\nb\n\n  \n'), 'b');
  assert.equal(lastLine('\n\n'), undefined);
  assert.equal(lastLine('x'.repeat(400), 10), `${'x'.repeat(9)}…`);
});
