// The routines in routines/, as code: what every one of them must keep true (DECISIONS § Routines).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { paths } from './lib.ts';
import { listRoutines } from './store.ts';

const dir = paths({}).routines;

test('every routine directory is listed: a label and an executable run.sh', () => {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
  assert.deepEqual(
    listRoutines(dir)
      .map((r) => r.id)
      .sort(),
    dirs,
  );
});

test('a routine that runs Claude Code runs it restricted to the file tools, never with permissions bypassed', () => {
  for (const r of listRoutines(dir)) {
    const script = readFileSync(r.script, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
      // continuation lines are one command
      .replace(/\\\n/g, ' ');
    assert.doesNotMatch(script, /bypassPermissions|dangerously-skip-permissions/, r.id);
    for (const call of script.match(/^\s*claude\s.*$/gm) ?? []) {
      for (const flag of ['--restricted', '--strict-mcp-config'])
        assert.ok(call.includes(flag), `${path.basename(r.dir)}: ${flag} missing in: ${call}`);
      // Restricted mode alone still offers web search and messages to other sessions.
      const tools = /--tools[ =]([\w,]+)/.exec(call)?.[1]?.split(',').sort();
      assert.deepEqual(tools, ['Edit', 'Glob', 'Grep', 'Read', 'Write'], `${r.id}: ${call}`);
    }
  }
});
