// The native host's pure half (DECISIONS § Workflows): Chrome's native messaging framing, where
// things live, the extension id Chrome derives from an unpacked extension's path, a run's id and
// the environment a routine runs in. No I/O here; native/store.ts touches the disk.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository this host runs from: native/.. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where everything lives. The environment overrides each, for tests. */
export interface Paths {
  /** `~/.rescribe`: the host's home. */
  home: string;
  /** `~/.rescribe/recordings`: the folder Rescribe saves into, the only one a routine reads. */
  recordings: string;
  /** `~/.rescribe/runs`: one directory per run (status, log, whatever the runner keeps). */
  runs: string;
  /** `<repo>/runners`: one directory per runner, the code that runs a workflow. */
  runners: string;
}

export function paths(env: NodeJS.ProcessEnv): Paths {
  const home = env['RESCRIBE_HOME'] ?? path.join(homedir(), '.rescribe');
  return {
    home,
    recordings: env['RESCRIBE_RECORDINGS'] ?? path.join(home, 'recordings'),
    runs: path.join(home, 'runs'),
    runners: env['RESCRIBE_RUNNERS'] ?? path.join(REPO, 'runners'),
  };
}

/** One message as Chrome frames it: a 32-bit length in native byte order (little-endian on every Mac), then JSON. */
export function encodeMessage(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  return Buffer.concat([head, json]);
}

/** The first whole message in `buf` and what follows it; undefined until it has all arrived. */
export function decodeMessage(buf: Buffer): { message: unknown; rest: Buffer } | undefined {
  if (buf.length < 4) return undefined;
  const n = buf.readUInt32LE(0);
  if (buf.length < 4 + n) return undefined;
  return {
    message: JSON.parse(buf.subarray(4, 4 + n).toString('utf8')),
    rest: buf.subarray(4 + n),
  };
}

/**
 * The id Chrome gives an unpacked extension: the first 128 bits of the SHA-256 of its absolute
 * path, each hex digit written as a letter from a to p. The manifest's `allowed_origins` needs it.
 */
export function extensionIdForPath(dir: string): string {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** `20261023-140211-index-in-lawcel-3f9a`: sortable, and says which workflow ran. */
export function makeRunId(now: Date, workflow: string, rand: string): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${day}-${time}-${workflow}-${rand}`;
}

/** A run id as the host made it; anything else is refused before it becomes a path. */
export function isRunId(s: string): boolean {
  return /^\d{8}-\d{6}-[a-z0-9-]+-[0-9a-f]{4}$/.test(s);
}

/**
 * The environment a routine runs in: the browser's, which is launchd's (a minimal PATH), with the
 * human's tool directories in front, and without what would change who pays or what runs.
 * `ANTHROPIC_API_KEY` goes: with it set, `claude` bills that key instead of the human's
 * subscription, and the human's keys are never to be spent by an automation. The variables a
 * Claude Code session and tmux set go too, so a run started from inside one (a test, a terminal)
 * behaves as one started by the browser: the human's hooks key on `TMUX_PANE` and would mark
 * the window of whoever started it.
 */
const DROPPED = new Set(['ANTHROPIC_API_KEY', 'CLAUDECODE', 'TMUX', 'TMUX_PANE']);

export function routineEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (DROPPED.has(k) || k.startsWith('CLAUDE_CODE_')) continue;
    env[k] = v;
  }
  const home = env['HOME'] ?? homedir();
  const dirs = [
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':'),
  ];
  env['PATH'] = [...new Set(dirs.filter(Boolean))].join(':');
  return { ...env, ...extra };
}

/** The last non-empty line of a log, trimmed to one readable line. */
export function lastLine(text: string, max = 300): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (line === undefined) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
