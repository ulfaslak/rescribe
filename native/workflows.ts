// Workflows and their runners on disk (DECISIONS § Workflows). A runner is code in this repository,
// `runners/<id>/`: `runner.json`, an executable `run.sh`, `prompt.md` (the prompt a new workflow of
// it starts with) and, when it wraps the workflow's prompt, `before.md` and `after.md`. A workflow
// is the human's, written by the app's Workflows section through the host: `~/.rescribe/workflows/
// <id>/`, `workflow.json` (name, line, runner, folder) and `prompt.md`. A deleted one goes to
// `workflows/.trash/`, not away.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { RunnerInfo, Workflow } from '../src/lib/routines.ts';
import { REPO, type Paths } from './lib.ts';

/** A runner on disk: what the editor sees, plus where it is, how long it may take, and its seed. */
export interface Runner extends RunnerInfo {
  dir: string;
  script: string;
  /** Minutes before the supervisor stops a run; `runner.json` `timeoutMinutes`, 60 by default. */
  timeoutMinutes: number;
  /** The workflow of it made when the host first runs, with the runner's id as its own. */
  seed?: { label: string; description?: string };
}

const DEFAULT_TIMEOUT_MINUTES = 60;
/** An id goes into a run's id (lib.ts `isRunId`) and is a directory name. */
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 200;
/** A native message to the browser is at most 1 MB, and the list carries every prompt. */
const MAX_PROMPT = 50_000;

function isExecutable(file: string): boolean {
  try {
    return statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Every `runners/<id>/` with a `runner.json` (`label`, `description`, `folder`, optional
 * `defaultFolder`, `order`, `timeoutMinutes`, `seed`), a `prompt.md` and an executable `run.sh`, by
 * `order` then label. A broken one is skipped with a line on stderr (Chrome keeps the host's
 * stderr in its log).
 */
export function listRunners(dir: string): Runner[] {
  if (!existsSync(dir)) return [];
  const out: (Runner & { order: number })[] = [];
  for (const id of readdirSync(dir).sort()) {
    if (id.startsWith('.') || id.startsWith('_')) continue;
    const rdir = path.join(dir, id);
    if (!statSync(rdir).isDirectory()) continue; // README.md
    if (!ID.test(id)) {
      process.stderr.write(
        `[rescribe-host] runner ${id} skipped: name it in lowercase and dashes\n`,
      );
      continue;
    }
    const script = path.join(rdir, 'run.sh');
    try {
      const spec = JSON.parse(readFileSync(path.join(rdir, 'runner.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      const label = str(spec['label']);
      if (!label) throw new Error('no label');
      if (!isExecutable(script)) throw new Error('run.sh missing or not executable');
      const prompt = readText(path.join(rdir, 'prompt.md'));
      if (prompt === undefined) throw new Error('no prompt.md');
      const before = readText(path.join(rdir, 'before.md'));
      const after = readText(path.join(rdir, 'after.md'));
      const seed = spec['seed'] as Record<string, unknown> | undefined;
      const defaultFolder = str(spec['defaultFolder']);
      out.push({
        id,
        label,
        description: str(spec['description']) ?? '',
        folderHint: str(spec['folder']) ?? 'Where Claude Code works.',
        ...(defaultFolder ? { defaultFolder } : {}),
        prompt,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        dir: rdir,
        script,
        timeoutMinutes:
          typeof spec['timeoutMinutes'] === 'number' && spec['timeoutMinutes'] > 0
            ? spec['timeoutMinutes']
            : DEFAULT_TIMEOUT_MINUTES,
        ...(seed && str(seed['label'])
          ? {
              seed: {
                label: str(seed['label'])!,
                ...(str(seed['description']) ? { description: str(seed['description'])! } : {}),
              },
            }
          : {}),
        order: typeof spec['order'] === 'number' ? spec['order'] : 100,
      });
    } catch (err) {
      process.stderr.write(`[rescribe-host] runner ${id} skipped: ${String(err)}\n`);
    }
  }
  out.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return out.map(({ order: _order, ...r }) => r);
}

/** What a runner shows the editor: no paths on disk. */
export function runnerInfo(r: Runner): RunnerInfo {
  const { dir: _dir, script: _script, timeoutMinutes: _t, seed: _seed, ...info } = r;
  return info;
}

export function workflowsDir(p: Paths): string {
  return path.join(p.home, 'workflows');
}

/** `workflow.json`: everything but the id (its directory) and the prompt (`prompt.md`). */
interface StoredWorkflow {
  label: string;
  description?: string;
  runner: string;
  folder: string;
  createdAt: number;
  updatedAt: number;
}

/** Written whole and renamed into place, so a reader never sees half a file. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function writeWorkflowFiles(dir: string, stored: StoredWorkflow, prompt: string): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, 'prompt.md'), prompt);
  writeAtomic(path.join(dir, 'workflow.json'), `${JSON.stringify(stored, null, 2)}\n`);
}

/** `~` and `~/…` against the human's home. */
export function expandHome(folder: string, home: string): string {
  if (folder === '~') return home;
  if (folder.startsWith('~/')) return path.join(home, folder.slice(2));
  return folder;
}

/**
 * The first time the host runs there is no workflows directory: it is made with a workflow of each
 * runner that has a `seed` (Index in Lawcel, which was a routine in the repository until
 * 2026-10-27), under the runner's id, so records that named the routine name the workflow. Made
 * aside and renamed into place: two hosts started at once (the stop dialog and the app tab) both
 * see either nothing or all of it. Never again after: a workflow the human deleted stays deleted.
 */
export function ensureWorkflows(p: Paths, runners: Runner[], home: string): void {
  const dir = workflowsDir(p);
  if (existsSync(dir)) return;
  mkdirSync(p.home, { recursive: true });
  const tmp = `${dir}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const now = Date.now();
  for (const r of runners) {
    if (!r.seed) continue;
    writeWorkflowFiles(
      path.join(tmp, r.id),
      {
        label: r.seed.label,
        ...(r.seed.description ? { description: r.seed.description } : {}),
        runner: r.id,
        folder: expandHome(r.defaultFolder ?? '~', home),
        createdAt: now,
        updatedAt: now,
      },
      r.prompt,
    );
  }
  try {
    renameSync(tmp, dir);
  } catch {
    // Another host made it first.
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readStored(dir: string): StoredWorkflow & { prompt: string } {
  const stored = JSON.parse(readFileSync(path.join(dir, 'workflow.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const label = str(stored['label']);
  const runner = str(stored['runner']);
  const folder = str(stored['folder']);
  if (!label || !runner || !folder)
    throw new Error('workflow.json needs a label, a runner and a folder');
  const description = str(stored['description']);
  return {
    label,
    ...(description ? { description } : {}),
    runner,
    folder,
    createdAt: typeof stored['createdAt'] === 'number' ? stored['createdAt'] : 0,
    updatedAt: typeof stored['updatedAt'] === 'number' ? stored['updatedAt'] : 0,
    prompt: readFileSync(path.join(dir, 'prompt.md'), 'utf8'),
  };
}

function toWorkflow(id: string, s: StoredWorkflow & { prompt: string }): Workflow {
  return {
    id,
    label: s.label,
    ...(s.description ? { description: s.description } : {}),
    runner: s.runner,
    folder: s.folder,
    prompt: s.prompt,
  };
}

/** Every workflow, oldest first. A broken one (a hand edit) is skipped with a line on stderr. */
export function listWorkflows(p: Paths): Workflow[] {
  const dir = workflowsDir(p);
  if (!existsSync(dir)) return [];
  const out: { w: Workflow; createdAt: number }[] = [];
  for (const id of readdirSync(dir).sort()) {
    if (!ID.test(id)) continue; // .trash, temporaries
    try {
      const s = readStored(path.join(dir, id));
      out.push({ w: toWorkflow(id, s), createdAt: s.createdAt });
    } catch (err) {
      process.stderr.write(`[rescribe-host] workflow ${id} skipped: ${String(err)}\n`);
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.w.id.localeCompare(b.w.id));
  return out.map((o) => o.w);
}

export function readWorkflow(p: Paths, id: string): Workflow | undefined {
  if (!ID.test(id)) return undefined;
  try {
    return toWorkflow(id, readStored(path.join(workflowsDir(p), id)));
  } catch {
    return undefined;
  }
}

/** What a folder is checked against: the human's home, Rescribe's own and this clone. */
export interface FolderRules {
  home: string;
  /** `~/.rescribe`: the recordings, the runs, the workflows. */
  rescribe: string;
  /** The clone the host runs from: the runners. */
  repo: string;
}

export function folderRules(p: Paths, home: string): FolderRules {
  return { home, rescribe: p.home, repo: REPO };
}

/**
 * A path as the disk has it: symlinks resolved and, through the system's realpath, each name in
 * the case it was made with (`realpathSync` keeps the case it is given, and on the Mac's
 * case-insensitive disk `~/library` is `~/Library`).
 */
function real(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Compared without case as well: a path the disk did not resolve keeps the case it was given. */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const within = (dir: string, parent: string): boolean =>
  same(dir, parent) || dir.toLowerCase().startsWith(parent.toLowerCase() + path.sep);

/**
 * The folder a workflow's Claude Code may read and write, checked, as an absolute path without
 * symlinks; throws with a sentence for the human. What was said on a call can steer that agent, so
 * the folder is where it can do harm, and these are refused: anything not inside the home folder,
 * the home folder itself, a hidden folder at its top (`.ssh`, `.claude`, `.config`, `.local`, which
 * hold keys, settings and programs on the PATH), `~/Library` but for iCloud Drive and the cloud
 * drives (`Mobile Documents`, `CloudStorage`: launch agents live there), and anything that holds
 * Rescribe's own files or is inside them (the runners a run executes, the workflows' prompts).
 */
export function checkFolder(folder: string, rules: FolderRules): string {
  const given = expandHome(folder.trim(), rules.home);
  if (!given) throw new Error('Name the folder Claude Code works in.');
  if (!path.isAbsolute(given))
    throw new Error(`The folder must be a full path, like ~/Documents/notes, not "${folder}".`);
  let stat;
  try {
    stat = statSync(given);
  } catch {
    throw new Error(`${given} does not exist.`);
  }
  if (!stat.isDirectory()) throw new Error(`${given} is not a folder.`);
  const dir = real(given);
  const home = real(rules.home);
  if (!within(dir, home) || same(dir, home))
    throw new Error(`The folder must be inside your home folder (${home}), not ${dir}.`);
  const [top, second] = path.relative(home, dir).split(path.sep);
  if (top?.startsWith('.'))
    throw new Error(
      `${dir} is in ~/${top}, a hidden folder that holds settings, keys or programs: choose a folder of your own documents.`,
    );
  if (
    same(top ?? '', 'Library') &&
    !same(second ?? '', 'Mobile Documents') &&
    !same(second ?? '', 'CloudStorage')
  )
    throw new Error(
      `${dir} is in ~/Library, which holds what macOS runs: choose a folder of your own documents (iCloud Drive is fine).`,
    );
  for (const [own, what] of [
    [real(rules.rescribe), "Rescribe's own folder"],
    [real(rules.repo), "Rescribe's clone, which holds the code a run executes"],
  ] as const) {
    if (within(dir, own) || within(own, dir))
      throw new Error(`${dir} ${within(dir, own) ? 'is in' : 'holds'} ${what} (${own}).`);
  }
  return dir;
}

/** `Mødenoter for Acme` → `modenoter-for-acme`: lowercase ASCII and dashes, at most 40 characters. */
export function slugFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug || 'workflow';
}

function oneLine(v: unknown, what: string, max: number, required: boolean): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (required) throw new Error(`Give the workflow ${what}.`);
    return undefined;
  }
  if (/[\r\n]/.test(s)) throw new Error(`The workflow's ${what} must be one line.`);
  if (s.length > max) throw new Error(`The workflow's ${what} is longer than ${max} characters.`);
  return s;
}

/**
 * A workflow saved as the editor sent it, checked: a name, a runner there is, a folder
 * `checkFolder` allows, a prompt. A new one (no id) gets an id from its name, made unique; an
 * existing one keeps its id and when it was made. Answers it as it is on disk now.
 */
export function saveWorkflow(
  p: Paths,
  w: Workflow,
  runners: Runner[],
  rules: FolderRules,
): Workflow {
  const label = oneLine(w.label, 'a name', MAX_LABEL, true)!;
  const description = oneLine(w.description, 'line', MAX_DESCRIPTION, false);
  if (!runners.some((r) => r.id === w.runner))
    throw new Error(`There is no runner "${w.runner}" in this Rescribe.`);
  const folder = checkFolder(typeof w.folder === 'string' ? w.folder : '', rules);
  const prompt = typeof w.prompt === 'string' ? w.prompt : '';
  if (!prompt.trim()) throw new Error('Write the prompt Claude Code is given.');
  if (prompt.length > MAX_PROMPT)
    throw new Error(`The prompt is longer than ${MAX_PROMPT} characters.`);
  const root = workflowsDir(p);
  mkdirSync(root, { recursive: true });
  let id = w.id;
  let createdAt = Date.now();
  if (id) {
    if (!ID.test(id) || !existsSync(path.join(root, id)))
      throw new Error(`There is no workflow "${id}" any more: it was deleted.`);
    try {
      createdAt = readStored(path.join(root, id)).createdAt || createdAt;
    } catch {
      // a broken one is rewritten whole
    }
  } else {
    const base = slugFor(label);
    id = base;
    for (let n = 2; existsSync(path.join(root, id)); n++) id = `${base}-${n}`;
  }
  writeWorkflowFiles(
    path.join(root, id),
    {
      label,
      ...(description ? { description } : {}),
      runner: w.runner,
      folder,
      createdAt,
      updatedAt: Date.now(),
    },
    prompt,
  );
  return readWorkflow(p, id)!;
}

/** Into `workflows/.trash/<id>-<when>/`, so a prompt deleted by mistake can be got back by hand. */
export function deleteWorkflow(p: Paths, id: string, now = new Date()): void {
  const root = workflowsDir(p);
  if (!ID.test(id) || !existsSync(path.join(root, id)))
    throw new Error(`There is no workflow "${id}".`);
  const trash = path.join(root, '.trash');
  mkdirSync(trash, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  renameSync(path.join(root, id), path.join(trash, `${id}-${stamp}`));
}

/** A runner's directory copied for one run: a shell reads its script as it goes, so a pull must not change it under a run. */
export function copyRunner(r: Runner, to: string): string {
  cpSync(r.dir, to, { recursive: true });
  return path.join(to, path.basename(r.script));
}
