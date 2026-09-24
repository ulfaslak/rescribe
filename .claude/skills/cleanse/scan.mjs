#!/usr/bin/env node
// The mechanical half of /cleanse (SKILL.md next to this file): the checks that need no
// judgement, so the reading goes to the parts that do. No dependencies. Run from the repo root:
//
//   node .claude/skills/cleanse/scan.mjs
//
// Hard findings exit 1: a broken [[link]], a `path` the docs name that is not on disk, a § section
// that is not there, an entry of ARCHITECTURE's file structure that is not on disk. Soft findings
// are printed for the cleanse to judge and never fail the run: a test title the docs may have
// paraphrased, an orphan candidate, a ledger entry that misses a field.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

if (!existsSync('AGENTS/DNA')) {
  console.error('Run from the repo root: AGENTS/DNA/ not found.');
  process.exit(2);
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.playwright',
  'test-results',
  'playwright-report',
  'screenshots',
]);
// What scripts/build.mjs bundles. A source file nothing imports is fine when it is one of these.
const ENTRY_POINTS = [
  /^src\/background\.ts$/,
  /^src\/app\/app\.ts$/,
  /^src\/workers\/[^/]+\.ts$/,
  /\.worklet\.ts$/,
  /^src\/content\/meet\.ts$/,
];
const BUILD_SCRIPT = 'scripts/build.mjs';
const BUILD_MARKERS = [
  "'src/background.ts'",
  "'src/app/app.ts'",
  "globSync('src/workers/*.ts')",
  "globSync('src/**/*.worklet.ts')",
  "'src/content/meet.ts'",
];
const DNA_DIR = 'AGENTS/DNA';
const LEDGERS = {
  'AGENTS/AGENT_MISTAKES.md': null, // its own rules, below
  'AGENTS/DEFERRED.md': ['**What**', '**Why deferred**', '**Trigger**'],
  'AGENTS/LIVE_CHECKS.md': ['**Trigger**', '**Steps**', '**Success criteria**', '**On failure**'],
  'AGENTS/DNA/INVARIANTS.md': ['**Mechanism:**', '**Incident:**'],
};
const INVARIANT_LENGTH = 600; // INVARIANTS.md: "Past ~600 characters, re-read"

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = dir === '.' ? e.name : join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk('.');
const isDocPath = (f) =>
  f.startsWith('AGENTS/') || f.startsWith('.claude/') || f === 'CLAUDE.md' || f === 'README.md';
const mdFiles = allFiles.filter((f) => f.endsWith('.md') && isDocPath(f));
const tsFiles = allFiles.filter(
  (f) => f.endsWith('.ts') && (f.startsWith('src/') || f.startsWith('e2e/') || !f.includes('/')),
);
const testFiles = tsFiles.filter((f) => /\.(test|spec)\.ts$/.test(f));
const topLevel = new Set(readdirSync('.').filter((n) => !SKIP_DIRS.has(n)));

// Every markdown file in the repo is a [[link]] target, by upper-cased basename.
const docsByName = new Map();
for (const f of allFiles.filter((f) => f.endsWith('.md'))) {
  const key = basename(f, '.md').toUpperCase();
  if (!docsByName.has(key)) docsByName.set(key, []);
  docsByName.get(key).push(f);
}
const resolveDoc = (name) => docsByName.get(basename(name.trim(), '.md').toUpperCase())?.[0];

const headingCache = new Map();
function headings(file) {
  if (!headingCache.has(file)) {
    headingCache.set(
      file,
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => /^#{1,6} /.test(l))
        .map((l) => l.replace(/^#+ /, '').replace(/`/g, '').trim().toLowerCase()),
    );
  }
  return headingCache.get(file);
}

// A doc as lines, with fenced code blocks blanked so `paths` and § inside them are not prose.
function loadDoc(file) {
  const raw = readFileSync(file, 'utf8').split('\n');
  const prose = [];
  let fence = false;
  for (const l of raw) {
    if (/^\s*```/.test(l)) {
      fence = !fence;
      prose.push('');
      continue;
    }
    prose.push(fence ? '' : l);
  }
  return { file, raw, prose };
}
const docs = mdFiles.map(loadDoc);
// Inline code is not prose either: `[[links]]` in a sentence about links are not links.
const noCode = (l) => l.replace(/`[^`\n]*`/g, '');
const eachProseLine = (fn) => docs.forEach((d) => d.prose.forEach((l, i) => fn(d, l, i + 1)));

const sections = [];
const verbose = process.argv.includes('--verbose');
const counts = {};
const count = (k) => (counts[k] = (counts[k] ?? 0) + 1);
function section(title, hard) {
  const s = { title, hard, items: [] };
  sections.push(s);
  return (file, line, msg) => s.items.push(`${file}:${line}: ${msg}`);
}

// --- 1. [[links]] ---------------------------------------------------------------------------
const link = section('Broken [[links]]', true);
const LINK = /\[\[([^\]|#]+)(?:#[^\]]*)?(?:\|[^\]]*)?\]\]/g;
eachProseLine((d, l, n) => {
  for (const m of noCode(l).matchAll(LINK)) {
    count('[[links]]');
    if (!resolveDoc(m[1])) link(d.file, n, `[[${m[1]}]] matches no *.md file in the repo`);
  }
});

// --- 2. § section references ------------------------------------------------------------------
// `[[DOC]] § "Heading"` and `DOC § Heading words…`: quoted, the text must be part of a heading of
// DOC; unquoted, some prefix of the words that follow must start a heading.
const sect = section('§ references to sections that are not there', true);
const SECT =
  /(?:\[\[([^\]|#]+)\]\]|\b([A-Z][A-Z_]{3,}))(?:\.md)? § (?:"([^"]+)"|“([^”]+)”|(\S.*))/g;
eachProseLine((d, l, n) => {
  for (const m of noCode(l).matchAll(SECT)) {
    const name = m[1] ?? m[2];
    count('§ references');
    const target = resolveDoc(name);
    if (!target) continue; // a bracketed miss is a broken link (above); a bare word is prose
    const hs = headings(target);
    const quoted = m[3] ?? m[4];
    if (quoted !== undefined) {
      if (!hs.some((h) => h.includes(quoted.toLowerCase())))
        sect(d.file, n, `${name} § "${quoted}": no heading in ${target} contains it`);
      continue;
    }
    const words = m[5].split(/\s+/);
    let hit = false;
    for (let k = Math.min(words.length, 10); k >= 1 && !hit; k--) {
      const prefix = words
        .slice(0, k)
        .join(' ')
        .replace(/[.,;:()]+$/, '')
        .toLowerCase();
      hit = prefix.length > 0 && hs.some((h) => h.startsWith(prefix));
    }
    if (!hit)
      sect(
        d.file,
        n,
        `${name} § ${words.slice(0, 4).join(' ')}…: no heading in ${target} starts with it`,
      );
  }
});

// --- 3. `paths` named in the docs ------------------------------------------------------------
// A backticked token with a `/` whose first segment is a top-level entry of the repo must exist.
// One whose first segment is not (`app/app.html`, `workers/transcribe.js`) is a bundle path and
// is accepted when it exists under src/ (`.js` → `.ts`); anything else (OPFS layouts, the export
// folder, worktree paths) is not a repo path and is not checked.
const path = section('`paths` named in the docs that are not on disk', true);
const TICK = /`([^`\n]+)`/g;
const NOT_A_PATH = /[\s<>*{}$~|=()[\]"'!?,→]|^https?:|^chrome|^brave|^\/|\.\./;
eachProseLine((d, l, n) => {
  for (const m of l.matchAll(TICK)) {
    const t = m[1].replace(/[.,;:]+$/, '');
    if (NOT_A_PATH.test(t) || !t.includes('/')) continue;
    if (!topLevel.has(t.split('/')[0])) continue;
    count('paths');
    if (!existsSync(t.replace(/\/$/, ''))) path(d.file, n, `${t} is not on disk`);
  }
});

// --- 4. ARCHITECTURE's file structure vs the tree on disk ---------------------------------------
const tree = section("Entries of ARCHITECTURE's file structure that are not on disk", true);
const treeSoft = section("On disk but not in ARCHITECTURE's file structure", false);
const arch = docs.find((d) => d.file === `${DNA_DIR}/ARCHITECTURE.md`);
const PATH_TOKEN = /^[\w.@-]+(\/[\w.@-]+)*\/?$/;
if (!arch) tree(`${DNA_DIR}/ARCHITECTURE.md`, 1, 'file not found');
else {
  // The fence whose first line is the repo root (`rescribe/`).
  const start = arch.raw.findIndex(
    (l, i) => /^```/.test(l) && /^\S+\/\s*$/.test(arch.raw[i + 1] ?? ''),
  );
  if (start < 0)
    tree(arch.file, 1, 'no file-structure fence found (a fence whose first line is `<root>/`)');
  else {
    const fenceText = [];
    const entries = []; // { path, isDir, line }
    const stack = []; // { indent, path }
    for (let i = start + 2; i < arch.raw.length && !/^```/.test(arch.raw[i]); i++) {
      const l = arch.raw[i];
      fenceText.push(l);
      const m = /^(\s*)(\S.*?)(?:\s{2,}.*)?$/.exec(l);
      if (!m) continue;
      const names = m[2].split(/,\s*/);
      if (!names.every((x) => PATH_TOKEN.test(x))) continue; // a wrapped description line
      const indent = m[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].path : '';
      for (const name of names) {
        const p = (parent + name).replace(/\/$/, '');
        entries.push({ path: p, isDir: name.endsWith('/'), line: i + 1 });
      }
      if (names.length === 1 && names[0].endsWith('/'))
        stack.push({ indent, path: parent + names[0] });
    }
    const listed = new Set(entries.map((e) => e.path));
    const enumerated = new Set(); // directories whose children the tree spells out
    for (const e of entries) {
      let p = dirname(e.path);
      while (p && p !== '.') {
        enumerated.add(p);
        p = dirname(p);
      }
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.path.split('/')[0])) continue;
      count('tree entries');
      if (!existsSync(e.path))
        tree(arch.file, e.line, `${e.path}${e.isDir ? '/' : ''} is not on disk`);
      else if (e.isDir !== statSync(e.path).isDirectory())
        tree(
          arch.file,
          e.line,
          `${e.path} is ${e.isDir ? 'a file but listed as a directory' : 'a directory but listed as a file'}`,
        );
    }
    const fence = fenceText.join('\n');
    for (const dir of [...enumerated].sort()) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name) || name === '.DS_Store' || /\.test\.ts$/.test(name)) continue;
        const p = `${dir}/${name}`;
        if (listed.has(p) || enumerated.has(p) || fence.includes(name)) continue;
        treeSoft(
          arch.file,
          start + 1,
          `${p} is on disk but the file structure does not mention it`,
        );
      }
    }
  }
}

// --- 5. Orphan source files ------------------------------------------------------------------
// A src/ file that no other file imports and that is not a bundle entry point. Exports that
// nothing imports are for the reading: this only sees files.
const orphan = section('Source files nothing imports (orphan candidates)', false);
const build = existsSync(BUILD_SCRIPT) ? readFileSync(BUILD_SCRIPT, 'utf8') : '';
for (const marker of BUILD_MARKERS) {
  if (!build.includes(marker))
    orphan(
      BUILD_SCRIPT,
      1,
      `does not contain ${marker}: the ENTRY_POINTS list in scan.mjs is stale`,
    );
}
const imported = new Set();
const IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
for (const f of tsFiles) {
  for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
    imported.add(join(dirname(f), m[1]));
  }
}
for (const f of tsFiles) {
  if (!f.startsWith('src/') || /\.(test|d)\.ts$/.test(f)) continue;
  count('source files');
  if (ENTRY_POINTS.some((re) => re.test(f))) continue;
  if (!imported.has(f)) orphan(f, 1, 'no file imports it and it is not a bundle entry point');
}

// --- 6. "planned" markers in the DNA ----------------------------------------------------------
const planned = section(
  '"planned" markers in the DNA (each names something not yet built; verify)',
  false,
);
eachProseLine((d, l, n) => {
  if (
    d.file.startsWith(`${DNA_DIR}/`) &&
    /\bplanned\b/i.test(l) &&
    !/^#|marked \*\*\(planned\)\*\*/.test(l)
  )
    planned(d.file, n, l.trim().slice(0, 100));
});

// --- 7. Test titles the docs quote ---------------------------------------------------------------
// `e2e/x.spec.ts` "title" (either order, same line) and `e2e "title"`: the quoted text should be
// part of a test title in that file. A miss is usually a paraphrase; sometimes a renamed test.
const titles = section(
  'Quoted test titles that match no test (paraphrase or rename; verify)',
  false,
);
const TITLE =
  /\b(?:test|it|describe)(?:\.(?:only|skip|serial|describe))*\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g;
const titlesOf = new Map();
for (const f of testFiles) {
  titlesOf.set(
    f,
    [...readFileSync(f, 'utf8').matchAll(TITLE)].map((m) => m[2].toLowerCase()),
  );
}
const allTitles = [...titlesOf.values()].flat();
const TEST_PATH = /`([\w./-]*\.(?:spec|test)\.ts)`/g;
const QUOTE = /"([^"…]{4,})"|“([^”…]{4,})”/g;
function checkTitle(d, n, q, file) {
  count('quoted test titles');
  const needle = q.toLowerCase();
  const pool = file ? (titlesOf.get(file) ?? []) : allTitles;
  if (pool.some((t) => t.includes(needle))) return;
  const elsewhere = [...titlesOf]
    .filter(([, ts]) => ts.some((t) => t.includes(needle)))
    .map(([f]) => f);
  titles(
    d.file,
    n,
    `"${q}"${file ? ` in ${file}` : ''}: ${elsewhere.length ? `found only in ${elsewhere.join(', ')}` : 'no test title contains it'}`,
  );
}
eachProseLine((d, l, n) => {
  const seen = new Set();
  for (const m of l.matchAll(TEST_PATH)) {
    const file = testFiles.find((f) => f === m[1] || f.endsWith(`/${m[1]}`));
    if (!file) continue;
    const window = l.slice(Math.max(0, m.index - 120), m.index + m[0].length + 240);
    for (const q of window.matchAll(QUOTE)) {
      const text = q[1] ?? q[2];
      if (!seen.has(text)) {
        seen.add(text);
        checkTitle(d, n, text, file);
      }
    }
  }
  for (const m of l.matchAll(/\be2e (?:case |test )?"([^"]{4,})"/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      checkTitle(d, n, m[1], null);
    }
  }
});

// --- 8. Ledger entry formats ---------------------------------------------------------------------
const ledger = section('Ledger entries missing a field or a tag', false);
function entriesOf(doc) {
  const out = [];
  doc.raw.forEach((l, i) => {
    if (/^### /.test(l)) out.push({ line: i + 1, heading: l, body: [] });
    else if (out.length) out[out.length - 1].body.push(l);
  });
  return out;
}
for (const [file, fields] of Object.entries(LEDGERS)) {
  const d = docs.find((x) => x.file === file);
  if (!d) continue;
  for (const e of entriesOf(d)) {
    const body = e.body.join('\n');
    count('ledger entries');
    if (fields) {
      for (const f of fields) if (!body.includes(f)) ledger(file, e.line, `entry lacks ${f}`);
      if (file.endsWith('INVARIANTS.md') && body.trim().length > INVARIANT_LENGTH)
        ledger(
          file,
          e.line,
          `entry is ${body.trim().length} characters; INVARIANTS asks to re-read past ~${INVARIANT_LENGTH}`,
        );
      continue;
    }
    // AGENT_MISTAKES: `### YYYY-MM-DD · #<ref> · <category>` ending in a tag; [learned] needs a reference.
    if (!/^### \d{4}-\d{2}-\d{2} · #[^·]+ · .+/.test(e.heading))
      ledger(file, e.line, 'heading is not `### YYYY-MM-DD · #<issue or PR> · <category>`');
    const tag = /\[(learned|not codified)\]/.exec(e.heading)?.[1];
    if (!tag) ledger(file, e.line, 'entry has neither [learned] nor [not codified]');
    else if (
      tag === 'learned' &&
      !/`[^`]+`|§|CLAUDE\.md|INVARIANTS|ARCHITECTURE|DECISIONS|DEVELOPMENT|PRODUCT|ENVIRONMENT_NOTES/.test(
        body,
      )
    )
      ledger(
        file,
        e.line,
        '[learned] but the body names no fix (no path, §, DNA file or CLAUDE.md item)',
      );
  }
}
const env = docs.find((x) => x.file === 'AGENTS/ENVIRONMENT_NOTES.md');
if (env) {
  for (const e of entriesOf(env)) {
    const m = /(remove|delete) (this|the) (note|entry)[^.]*/i.exec(e.body.join(' '));
    if (m) ledger(env.file, e.line, `has a removal condition: "${m[0].trim()}"; verify`);
  }
}

// --- Report --------------------------------------------------------------------------------------
let hard = 0;
let soft = 0;
for (const s of sections) {
  console.log(`\n== ${s.title} (${s.hard ? 'hard' : 'soft'}) ==`);
  if (!s.items.length) console.log('  none');
  for (const it of s.items) console.log(`  ${it}`);
  if (s.hard) hard += s.items.length;
  else soft += s.items.length;
}
if (verbose)
  console.log(
    `\nChecked: ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}.`,
  );
console.log(`\n${hard} hard, ${soft} soft.`);
process.exit(hard ? 1 : 0);
