// Labelled segments → turns → transcript.md / transcript.json content. Pure.
import { formatDate } from './pathtemplate.ts';
import type { LabelledSegment, Turn } from './types.ts';

export interface TurnOptions {
  /** Seconds. A pause longer than this starts a new turn even for the same speaker. */
  maxGap?: number;
}

export function toTurns(segments: LabelledSegment[], opts: TurnOptions = {}): Turn[] {
  const maxGap = opts.maxGap ?? 10;
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const turns: Turn[] = [];
  for (const seg of sorted) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker && seg.start - last.end <= maxGap) {
      last.end = Math.max(last.end, seg.end);
      last.text = joinText(last.text, seg.text);
      last.segments.push(seg);
    } else {
      turns.push({
        speaker: seg.speaker,
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
        segments: [seg],
      });
    }
  }
  return turns;
}

function joinText(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

/** 0 → "0:00", 65 → "1:05", 3661 → "1:01:01". */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export interface TranscriptMeta {
  title: string;
  /** Epoch ms. */
  startedAt: number;
  participants?: string[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM` in the local time zone: the clock the export folder's name uses. */
export function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderMarkdown(turns: Turn[], meta: TranscriptMeta): string {
  const lines: string[] = [`# ${meta.title}`, '', formatLocalDateTime(meta.startedAt)];
  if (meta.participants?.length) lines.push('', `Participants: ${meta.participants.join(', ')}`);
  lines.push('');
  for (const t of turns) {
    lines.push(`**${t.speaker}** [${formatTime(t.start)}]`, '', t.text, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export interface TranscriptJson {
  version: 1;
  title: string;
  startedAt: number;
  participants: string[];
  turns: Array<{ speaker: string; start: number; end: number; text: string }>;
  segments: LabelledSegment[];
}

export function toJson(
  turns: Turn[],
  segments: LabelledSegment[],
  meta: TranscriptMeta,
): TranscriptJson {
  return {
    version: 1,
    title: meta.title,
    startedAt: meta.startedAt,
    participants: meta.participants ?? [],
    turns: turns.map(({ speaker, start, end, text }) => ({ speaker, start, end, text })),
    segments,
  };
}
