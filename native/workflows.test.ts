// The folder check and ids from names (native/workflows.ts), in process. The host's own requests
// are in host.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { checkFolder, slugFor, type FolderRules } from './workflows.ts';

const root = mkdtempSync(path.join(tmpdir(), 'rescribe-workflows-'));
after(() => rmSync(root, { recursive: true, force: true }));

const home = path.join(root, 'Home');
const rules: FolderRules = {
  home,
  rescribe: path.join(home, 'RescribeData'),
  repo: path.join(home, 'Code', 'rescribe'),
};
for (const d of [
  'notes',
  'Library/LaunchAgents',
  'Library/Mobile Documents/notes',
  'RescribeData/workflows',
  'Code/rescribe/runners',
  'Code/other',
])
  mkdirSync(path.join(home, d), { recursive: true });

test('checkFolder: a folder of notes in the home folder, as the disk has it', () => {
  assert.equal(checkFolder('~/notes', rules), realpathSync(path.join(home, 'notes')));
  assert.equal(
    checkFolder(path.join(home, 'Library/Mobile Documents/notes'), rules),
    realpathSync(path.join(home, 'Library/Mobile Documents/notes')),
  );
  assert.equal(checkFolder('~/Code/other', rules), realpathSync(path.join(home, 'Code/other')));
});

test('checkFolder: Library, Rescribe and its clone are refused in any case the disk accepts', () => {
  // On the Mac's case-insensitive disk each of these is the folder it spells; on a case-sensitive
  // one it does not exist. Either way, refused.
  for (const folder of [
    '~/Library/LaunchAgents',
    '~/library/LaunchAgents',
    '~/LIBRARY/launchagents',
    '~/RescribeData/workflows',
    '~/rescribedata/workflows',
    '~/Code/rescribe/runners',
    '~/code/RESCRIBE/runners',
    '~/CODE',
    '~/home/../Home',
    path.join(root, 'home'),
  ])
    assert.throws(() => checkFolder(folder, rules), Error, folder);
  // Where the disk ignores case, refused for what it is, not for not being there.
  assert.throws(() => checkFolder('~/library/LaunchAgents', rules), /~\/Library|does not exist/);
  assert.throws(
    () => checkFolder('~/code/RESCRIBE/runners', rules),
    /Rescribe's clone|does not exist/,
  );
});

test('slugFor: lowercase ASCII and dashes, never empty', () => {
  assert.equal(slugFor('Mødenoter for Ærø'), 'modenoter-for-aero');
  assert.equal(slugFor('  Call notes: Acme / Q4  '), 'call-notes-acme-q4');
  assert.equal(slugFor('Résumé ß'), 'resume-ss');
  assert.equal(slugFor('🙂'), 'workflow');
  assert.equal(slugFor('x'.repeat(60)), 'x'.repeat(40));
});
