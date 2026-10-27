// `npm run install-host`: makes the workflows reachable from the browser (DECISIONS § Workflows).
// Creates ~/.rescribe/{recordings,runs,bin}, writes ~/.rescribe/bin/rescribe-host (a wrapper that
// runs native/host.ts from this checkout with this Node: the browser starts hosts with launchd's
// PATH, where neither is found), and registers it as the native messaging host for Rescribe's
// extension id in every browser whose profile directory exists (Brave, Chrome, Chromium).
//
// Run it from the primary clone: the browser runs the host from where it was installed, and the
// extension it serves is the one loaded from this checkout's dist/ (its id is derived from that
// path). `--extension-id <id>` overrides the derived id; `--force` installs from a worktree.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { NATIVE_HOST } from '../src/lib/routines.ts';
import { extensionIdForPath, paths, REPO } from './lib.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const gitDir = (which: string): string =>
  path.resolve(
    REPO,
    execFileSync('git', ['rev-parse', which], { cwd: REPO, encoding: 'utf8' }).trim(),
  );
if (gitDir('--git-dir') !== gitDir('--git-common-dir') && !args.includes('--force')) {
  console.error(
    `${REPO} is a git worktree. Install from the primary clone (the browser runs the host from where it is installed), or pass --force.`,
  );
  process.exit(1);
}

const p = paths(process.env);
const extensionId = flag('--extension-id') ?? extensionIdForPath(path.join(REPO, 'dist'));
for (const d of [p.recordings, p.runs, path.join(p.home, 'bin')]) mkdirSync(d, { recursive: true });

// Node by name on a PATH with Homebrew's links in front, not the path this Node runs from: that is
// a versioned Cellar directory, and the next `brew upgrade` deletes it.
const wrapper = path.join(p.home, 'bin', 'rescribe-host');
writeFileSync(
  wrapper,
  [
    '#!/bin/sh',
    `# Written by ${path.join(REPO, 'native/install.ts')}; run it again rather than editing this.`,
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
    `exec node --no-warnings "${path.join(REPO, 'native/host.ts')}" "$@"`,
    '',
  ].join('\n'),
);
chmodSync(wrapper, 0o755);

const manifest = {
  name: NATIVE_HOST,
  description: 'Rescribe workflows',
  path: wrapper,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
const support = path.join(homedir(), 'Library/Application Support');
const browsers: [string, string][] = [
  ['Brave', 'BraveSoftware/Brave-Browser'],
  ['Chrome', 'Google/Chrome'],
  ['Chromium', 'Chromium'],
];
const installed: string[] = [];
for (const [name, dir] of browsers) {
  const profile = path.join(support, dir);
  if (!existsSync(profile)) continue;
  const hosts = path.join(profile, 'NativeMessagingHosts');
  mkdirSync(hosts, { recursive: true });
  const file = path.join(hosts, `${NATIVE_HOST}.json`);
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  installed.push(`${name}: ${file}`);
}

console.log(`Native host ${NATIVE_HOST} for extension ${extensionId}`);
console.log(`  host:       ${wrapper}`);
console.log(`  recordings: ${p.recordings}`);
console.log(`  runners:    ${p.runners}`);
console.log(`  workflows:  ${path.join(p.home, 'workflows')}`);
for (const line of installed) console.log(`  ${line}`);
if (installed.length === 0) console.log('  no browser profile found; nothing registered');
