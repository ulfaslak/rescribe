// The export directory name from the Settings path template. Pure: no DOM, no chrome.*.
//
// Tokens: {date} → YYYY-MM-DD, {time} → HH-MM (local time; a colon is not a portable file-name
// character), {title} → the recording title. A `/` in the template nests directories. Every
// segment is made safe for macOS, Windows and Linux file systems; the title is sanitised before
// substitution so a `/` inside a title cannot nest.

export interface TemplateContext {
  /** Epoch ms of the recording start; rendered in local time. */
  startedAt: number;
  title: string;
}

/** Characters no common file system accepts in a name, plus control characters. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
/** APFS and ext4 allow 255 UTF-8 bytes per name; leave room for the collision suffix. */
const MAX_SEGMENT_BYTES = 200;
/** Windows device names, reserved with any extension, any case. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FALLBACK_TITLE = 'Recording';

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH-MM` for a directory name; `formatTime(d, ':')` for text. */
export function formatTime(d: Date, sep = '-'): string {
  return `${pad(d.getHours())}${sep}${pad(d.getMinutes())}`;
}

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** The longest prefix of `s` within `maxBytes` of UTF-8, cut only between code points. */
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const b = utf8Length(ch.codePointAt(0) ?? 0);
    if (bytes + b > maxBytes) break;
    bytes += b;
    out += ch;
  }
  return out;
}

/** One directory name: illegal characters become `-`, whitespace collapses, edges are trimmed of
 * spaces and dots (Windows rejects trailing ones; a leading dot hides the directory), the name
 * is capped by UTF-8 bytes without splitting a character, and a Windows device name gets a `_`. */
export function sanitizeSegment(raw: string): string {
  let s = raw.replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[. ]+|[. ]+$/g, '');
  s = truncateUtf8(s, MAX_SEGMENT_BYTES).replace(/[. ]+$/g, '');
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Render the template into path segments (one per nested directory). Never empty. */
export function renderPathTemplate(template: string, ctx: TemplateContext): string[] {
  const d = new Date(ctx.startedAt);
  const title = sanitizeSegment(ctx.title) || FALLBACK_TITLE;
  const rendered = template.replace(/\{(date|time|title)\}/g, (_, key: string) =>
    key === 'date' ? formatDate(d) : key === 'time' ? formatTime(d) : title,
  );
  const segments = rendered
    .split('/')
    .map(sanitizeSegment)
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments : [`${formatDate(d)} ${formatTime(d)} ${title}`];
}

/** The n-th candidate for a directory name: the name itself, then "name (2)", "name (3)", … */
export function candidateName(base: string, n: number): string {
  return n <= 1 ? base : `${base} (${n})`;
}

/** The first candidate that is not taken. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const c = candidateName(base, n);
    if (!taken.has(c)) return c;
  }
}
