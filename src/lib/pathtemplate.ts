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
const MAX_SEGMENT = 120;
const FALLBACK_TITLE = 'Recording';

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(d: Date): string {
  return `${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

/** One directory name: illegal characters become `-`, whitespace collapses, edges are trimmed of
 * spaces and dots (Windows rejects trailing ones; a leading dot hides the directory). */
export function sanitizeSegment(raw: string): string {
  let s = raw.replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[. ]+|[. ]+$/g, '');
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).replace(/[. ]+$/g, '');
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
