// routines/index-in-lawcel/run.sh as the supervisor runs it, against stand-ins for what it talks
// to: lawcel-knowledge is a clone of a local bare repository, `claude` a script that writes what
// the agent would, `gh` a script that serves a board and records every issue it is asked to file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUN_SH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../routines/index-in-lawcel/run.sh',
);
const root = mkdtempSync(path.join(tmpdir(), 'rescribe-lawcel-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NAME = '2026-10-19-kenneth-ulf';
const NOTE_URL = `https://github.com/Lawcel/lawcel-knowledge/blob/main/meetings/notes/${NAME}.md`;
const BOARD = [{ number: 7, title: 'Public pricing', state: 'OPEN', assignees: [], body: 'x' }];

// The agent: a note, the hand-over, and whatever `cards` writes into .rescribe/cards.
const CLAUDE = `#!/bin/sh
touch "$RESCRIBE_RUN_DIR/claude-ran"
cp .rescribe/board.json "$RESCRIBE_RUN_DIR/seen-board.json"
cp .rescribe/assignable.tsv "$RESCRIBE_RUN_DIR/seen-assignable.tsv"
echo "# Notes" > meetings/notes/${NAME}.md
echo ${NAME} > .rescribe/name
echo "notes 2026-10-19 kenneth ulf: pricing" > .rescribe/commit-message
echo "${NAME}: pricing by buyer" > .rescribe/summary
. "$FAKE_CARDS"
`;

// gh: the board, two people who can be assigned, and `issue create` recorded with what origin's
// main was at that moment. FAKE_GH_DOWN fails every call; FAKE_GH_FAIL_AT fails the nth create.
const GH = `#!/bin/sh
[ -n "$FAKE_GH_DOWN" ] && { echo "HTTP 401: Bad credentials" >&2; exit 1; }
case "$1 $2" in
  "issue list") cat "$FAKE_BOARD" ;;
  "api --paginate") printf 'ulfaslak\\nkennethgraupner\\n' ;;
  "api users/ulfaslak") printf 'ulfaslak\\tUlf Aslak\\n' ;;
  "api users/kennethgraupner") printf 'kennethgraupner\\tKenneth Graupner\\n' ;;
  "issue create")
    n=$(( $(ls "$FAKE_GH_DIR" | wc -l) + 101 ))
    [ "$FAKE_GH_FAIL_AT" = "$n" ] && { echo "GraphQL: something went wrong" >&2; exit 1; }
    mkdir "$FAKE_GH_DIR/$n"
    printf '%s\\n' "$@" > "$FAKE_GH_DIR/$n/args"
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_GH_DIR/$n/body"; shift; done
    git --git-dir="$ORIGIN" log -1 --format=%s main > "$FAKE_GH_DIR/$n/origin-main"
    echo "https://github.com/Lawcel/lawcel-knowledge/issues/$n" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

interface Run {
  code: number | null;
  out: string;
  last: string;
  dir: string;
  origin: string;
  repo: string;
  /** The issues filed, in order: gh's arguments, the body, origin's main when it was filed. */
  filed: { args: string[]; body: string; originMain: string }[];
}

let n = 0;
function run(cards: string, extra: Record<string, string> = {}): Run {
  const t = path.join(root, `t${++n}`);
  const [bin, home, rec, dir, created] = ['bin', 'home', 'rec', 'run', 'created'].map((d) => {
    mkdirSync(path.join(t, d), { recursive: true });
    return path.join(t, d);
  }) as [string, string, string, string, string];
  const env = {
    PATH: `${bin}:${process.env['PATH']}`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const origin = path.join(t, 'origin.git');
  const repo = path.join(t, 'lawcel-knowledge');
  git('init', '--quiet', '--bare', '-b', 'main', origin);
  git('clone', '--quiet', origin, repo);
  for (const d of ['meetings/notes', 'meetings/transcripts']) {
    mkdirSync(path.join(repo, d), { recursive: true });
    writeFileSync(path.join(repo, d, '.gitkeep'), '');
  }
  git('-C', repo, 'add', '-A');
  git('-C', repo, 'commit', '--quiet', '-m', 'seed');
  git('-C', repo, 'push', '--quiet', 'origin', 'HEAD:main');

  writeFileSync(path.join(rec, 'transcript.md'), '# Meet - Lawcel\n\n**Ulf** [0:00]\n\nHej.\n');
  writeFileSync(path.join(rec, 'meta.json'), '{"participants":["Ulf","Kenneth Graupner"]}');
  writeFileSync(path.join(t, 'cards.sh'), cards);
  writeFileSync(path.join(t, 'board.json'), JSON.stringify(BOARD));
  writeFileSync(path.join(bin, 'claude'), CLAUDE);
  writeFileSync(path.join(bin, 'gh'), GH);
  chmodSync(path.join(bin, 'claude'), 0o755);
  chmodSync(path.join(bin, 'gh'), 0o755);

  const r = spawnSync('/bin/zsh', [RUN_SH], {
    encoding: 'utf8',
    env: {
      ...env,
      LAWCEL_KNOWLEDGE: repo,
      RESCRIBE_RECORDING_DIR: rec,
      RESCRIBE_RUN_DIR: dir,
      RESCRIBE_RUN_ID: `test-${n}`,
      FAKE_CARDS: path.join(t, 'cards.sh'),
      FAKE_BOARD: path.join(t, 'board.json'),
      FAKE_GH_DIR: created,
      ORIGIN: origin,
      ...extra,
    },
  });
  const out = `${r.stdout}${r.stderr}`;
  const filed = readdirSync(created)
    .sort()
    .map((i) => ({
      args: readFileSync(path.join(created, i, 'args'), 'utf8')
        .trimEnd()
        .split('\n'),
      body: readFileSync(path.join(created, i, 'body'), 'utf8'),
      originMain: readFileSync(path.join(created, i, 'origin-main'), 'utf8').trim(),
    }));
  const last = r.stdout.trimEnd().split('\n').at(-1) ?? '';
  return { code: r.status, out, last, dir, origin, repo, filed };
}

const originMain = (r: Run) =>
  execFileSync('git', ['--git-dir', r.origin, 'log', '-1', '--format=%s', 'main'], {
    encoding: 'utf8',
  }).trim();
const card = (i: number, title: string, body: string, assignees?: string) =>
  `mkdir -p .rescribe/cards/${i}
printf '${title}\\n' > .rescribe/cards/${i}/title
printf '${body}\\n' > .rescribe/cards/${i}/body.md
${assignees === undefined ? '' : `printf '${assignees}' > .rescribe/cards/${i}/assignees`}
`;

test('the cards are filed after the notes are on origin/main, each ending in where it came from', () => {
  const r = run(
    card(
      1,
      'Price by buyer type',
      'Draft prices per buyer.',
      'ulfaslak\\n @kennethgraupner \\nsomeone-else\\n',
    ) + card(2, 'Ask Christian for standard data', 'He offered a sample.'),
  );
  assert.equal(r.code, 0, r.out);
  assert.equal(originMain(r), 'notes 2026-10-19 kenneth ulf: pricing');
  assert.match(
    r.last,
    /^Pushed [0-9a-f]+ notes 2026-10-19 kenneth ulf: pricing; filed #101, #102$/,
  );
  assert.equal(
    readFileSync(path.join(r.dir, 'summary.txt'), 'utf8'),
    `${NAME}: pricing by buyer Cards: #101, #102.\n`,
  );

  assert.equal(r.filed.length, 2);
  const [first, second] = r.filed as [Run['filed'][0], Run['filed'][0]];
  for (const f of r.filed) {
    assert.equal(f.originMain, 'notes 2026-10-19 kenneth ulf: pricing', 'filed before the push');
    assert.ok(f.args.includes('Lawcel/lawcel-knowledge'));
  }
  assert.equal(first.args[first.args.indexOf('--title') + 1], 'Price by buyer type');
  // Only people who can be assigned there; a stray @ and spaces are forgiven.
  assert.ok(first.args.includes('--assignee=ulfaslak,kennethgraupner'), first.args.join(' '));
  assert.match(r.out, /someone-else cannot be assigned in Lawcel\/lawcel-knowledge; left out/);
  assert.ok(!second.args.some((a) => a.startsWith('--assignee')), second.args.join(' '));
  assert.equal(
    first.body,
    `Draft prices per buyer.\n\n_From the call [${NAME}](${NOTE_URL}). Filed by an agent (Rescribe, Index in Lawcel run test-${n})._\n`,
  );

  // The agent saw the board and who can be assigned; none of it was committed.
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, 'seen-board.json'), 'utf8')), BOARD);
  assert.equal(
    readFileSync(path.join(r.dir, 'seen-assignable.tsv'), 'utf8'),
    'ulfaslak\tUlf Aslak\nkennethgraupner\tKenneth Graupner\n',
  );
  const tree = execFileSync(
    'git',
    ['--git-dir', r.origin, 'ls-tree', '-r', '--name-only', 'main'],
    {
      encoding: 'utf8',
    },
  );
  assert.match(tree, new RegExp(`meetings/transcripts/${NAME}\\.md`));
  assert.doesNotMatch(tree, /\.rescribe/);
  assert.ok(!existsSync(path.join(r.dir, 'lawcel-knowledge')), 'the worktree is removed');
});

test('a call with nothing for the board pushes its notes and files nothing', () => {
  const r = run('');
  assert.equal(r.code, 0, r.out);
  assert.match(r.last, /^Pushed [0-9a-f]+ notes 2026-10-19 kenneth ulf: pricing$/);
  assert.equal(
    readFileSync(path.join(r.dir, 'summary.txt'), 'utf8'),
    `${NAME}: pricing by buyer\n`,
  );
  assert.equal(r.filed.length, 0);
});

test('more than ten cards, or one without a one-line title: nothing is pushed or filed', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => card(i + 1, `Card ${i + 1}`, 'x')).join('');
  for (const [cards, reason] of [
    [eleven, /^Claude Code wrote 11 cards, more than 10; nothing was pushed; the work is in /],
    [card(1, 'One', 'x') + card(2, 'Two\\nlines', 'x'), /^Card 2 has no one-line title/],
    [card(1, 'x'.repeat(121), 'x'), /^Card 1 has no one-line title of at most 120 characters/],
    [card(1, 'No body', ''), /^Card 1 has no body\.md/],
  ] as const) {
    const r = run(cards);
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, reason);
    assert.equal(originMain(r), 'seed');
    assert.equal(r.filed.length, 0);
  }
});

test('gh cannot read the board: the run stops before Claude Code starts', () => {
  const r = run(card(1, 'Never', 'x'), { FAKE_GH_DOWN: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(
    r.last,
    /^gh could not read Lawcel\/lawcel-knowledge's issues \(gh auth status\); nothing was indexed$/,
  );
  assert.ok(!existsSync(path.join(r.dir, 'claude-ran')));
  assert.ok(!existsSync(path.join(r.dir, 'lawcel-knowledge')), 'no worktree made');
  assert.equal(originMain(r), 'seed');
});

test('a card that fails to file: the notes stay pushed and the line says what was filed', () => {
  const r = run(card(1, 'First', 'x') + card(2, 'Second', 'y') + card(3, 'Third', 'z'), {
    FAKE_GH_FAIL_AT: '102',
  });
  assert.equal(r.code, 1, r.out);
  assert.match(
    r.last,
    /^Pushed [0-9a-f]+ notes 2026-10-19 kenneth ulf: pricing, but filing "Second" on the board failed \(filed #101\); the cards are in .*\/cards$/,
  );
  assert.equal(originMain(r), 'notes 2026-10-19 kenneth ulf: pricing');
  assert.equal(r.filed.length, 1);
  assert.ok(existsSync(path.join(r.dir, 'cards/2/issue.md')));
});
