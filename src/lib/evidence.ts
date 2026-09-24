// Platform speaker evidence: from the raw adapter message stream (speaker toggles stamped in
// wall-clock ms, roster snapshots) to cleaned SpeakerIntervals in recording time, plus the
// participant list for meta.json. Pure. The app tab buffers the messages during a recording and
// calls eventsToEvidence once it knows startedAt/endedAt; the library can call it again later
// from events.jsonl, so nothing here depends on when it runs.
import type { Message } from './messages.ts';
import type { SpeakerInterval } from './types.ts';
import { togglesToIntervals } from './attribution.ts';
import { toRecordingSeconds } from './clock.ts';

/** The adapter messages this layer consumes. */
export type AdapterEvent = Extract<Message, { type: 'speaker' | 'roster' }>;

export interface CleanOptions {
  /** Seconds. Intervals shorter than this, after merging, are dropped as indicator flicker. Default 0.3. */
  minDuration?: number;
  /** Seconds. Same-speaker intervals separated by at most this much are merged. Default 0.3. */
  mergeGap?: number;
  /**
   * Seconds. Starts are moved earlier by this much, never before the previous same-speaker
   * interval's end. Compensates a detector that trails speech onset. Default 0.
   */
  lead?: number;
}

const EPSILON = 1e-6;

/**
 * Cleans platform intervals per channel + source + speaker: merges overlapping or near intervals
 * (gap ≤ mergeGap), then drops what is still shorter than minDuration, then applies the lead.
 * Two blips can therefore merge into one interval long enough to keep. Invalid intervals
 * (end ≤ start) are dropped. Output is sorted by start; input is not mutated.
 */
export function cleanIntervals(
  intervals: SpeakerInterval[],
  opts: CleanOptions = {},
): SpeakerInterval[] {
  // Stamps arrive as ms and become seconds by division, so a 300 ms interval can measure
  // 0.29999999999999982 s. Duration comparisons get a microsecond of slack.
  const minDuration = (opts.minDuration ?? 0.3) - EPSILON;
  const mergeGap = (opts.mergeGap ?? 0.3) + EPSILON;
  const lead = Math.max(0, opts.lead ?? 0);

  const groups = new Map<string, SpeakerInterval[]>();
  for (const iv of intervals) {
    if (!(iv.end > iv.start)) continue;
    const key = `${iv.channel}\u0000${iv.source}\u0000${iv.speaker}`;
    const list = groups.get(key) ?? [];
    list.push(iv);
    groups.set(key, list);
  }

  const out: SpeakerInterval[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: SpeakerInterval[] = [];
    for (const iv of list) {
      const last = merged[merged.length - 1];
      if (last && iv.start - last.end <= mergeGap) {
        if (iv.end > last.end) last.end = iv.end;
      } else {
        merged.push({ ...iv });
      }
    }
    let prevEnd = Number.NEGATIVE_INFINITY;
    for (const iv of merged) {
      if (iv.end - iv.start < minDuration) continue;
      iv.start = Math.max(prevEnd, iv.start - lead);
      prevEnd = iv.end;
      out.push(iv);
    }
  }
  return out.sort(byStart);
}

function byStart(a: SpeakerInterval, b: SpeakerInterval): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    (a.speaker < b.speaker ? -1 : a.speaker > b.speaker ? 1 : 0) ||
    (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0)
  );
}

export interface EvidenceOptions {
  /**
   * What the platform calls the human's own tile (Meet: "You"). Its speaking events are not
   * display evidence: the display channel never carries the human's voice; the mic channel does,
   * and channel identity labels it. Default ['You'].
   */
  selfNames?: string[];
  /** Label under which the human appears in `participants`. Omitted: the self tile is left out. */
  selfLabel?: string;
  /** Interval cleaning. Defaults: minDuration 0.3, mergeGap 0.3, lead MEET_LEAD. */
  clean?: CleanOptions;
}

export interface PlatformEvidence {
  /** Display-channel platform intervals, cleaned, clipped to the recording, sorted by start. */
  intervals: SpeakerInterval[];
  /**
   * Display names in first-seen order across roster and speaker messages, deduplicated, with
   * the self tile replaced by `selfLabel` or omitted.
   */
  participants: string[];
}

/**
 * Seconds Meet's speaking indicator trails speech onset (a few hundred ms in the calls observed
 * on 2026-09-24; AGENTS/LIVE_CHECKS.md has the check that tunes it). Applied as `lead`.
 */
export const MEET_LEAD = 0.3;

/**
 * Turns the adapter's message stream for one recording into platform evidence. Toggles are
 * paired per participant id (two participants with the same display name stay apart); the
 * speaker label is the display name. A participant still speaking at `endedAtMs` is closed
 * there; intervals are clipped to [0, duration], so a speaker already on at t=0 is on from 0,
 * whether their start event was received or only their stop.
 */
export function eventsToEvidence(
  events: AdapterEvent[],
  startedAtMs: number,
  endedAtMs: number,
  opts: EvidenceOptions = {},
): PlatformEvidence {
  const selfNames = new Set(opts.selfNames ?? ['You']);
  const duration = toRecordingSeconds(endedAtMs, startedAtMs);

  const seen = new Set<string>();
  const rawNames: string[] = [];
  const note = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    rawNames.push(name);
  };

  /** Participant id → display name. The adapter falls back to the id when it cannot read a name. */
  const nameOf = new Map<string, string>();
  const toggles: Array<{ t: number; speaker: string; speaking: boolean }> = [];
  for (const ev of events) {
    if (ev.type === 'roster') {
      for (const n of ev.names) note(n);
      continue;
    }
    note(ev.name);
    if (selfNames.has(ev.name)) continue;
    if (ev.name !== ev.id || !nameOf.has(ev.id)) nameOf.set(ev.id, ev.name);
    toggles.push({
      t: toRecordingSeconds(ev.at, startedAtMs),
      speaker: ev.id,
      speaking: ev.speaking,
    });
  }

  // The adapter never emits a stop without having sent its start, so a stop with no open start
  // means the start predates what the app tab received: that participant was already speaking
  // when listening began. Open them from -Infinity; the clip below makes that t=0.
  const orphaned = new Set<string>();
  const open = new Set<string>();
  for (const tg of [...toggles].sort((a, b) => a.t - b.t)) {
    if (tg.speaking) open.add(tg.speaker);
    else if (open.has(tg.speaker)) open.delete(tg.speaker);
    else orphaned.add(tg.speaker);
  }
  for (const speaker of orphaned) {
    toggles.push({ t: Number.NEGATIVE_INFINITY, speaker, speaking: true });
  }

  const raw = togglesToIntervals('display', toggles, duration)
    .map((iv) => ({
      ...iv,
      speaker: nameOf.get(iv.speaker) ?? iv.speaker,
      start: Math.max(0, iv.start),
      end: Math.min(duration, iv.end),
    }))
    .filter((iv) => iv.end > iv.start);

  const intervals = cleanIntervals(raw, {
    ...opts.clean,
    lead: opts.clean?.lead ?? MEET_LEAD,
  }).map((iv) => (iv.start < 0 ? { ...iv, start: 0 } : iv));

  const participants: string[] = [];
  for (const n of rawNames) {
    const label = selfNames.has(n) ? opts.selfLabel : n;
    if (label !== undefined && !participants.includes(label)) participants.push(label);
  }

  return { intervals, participants };
}
