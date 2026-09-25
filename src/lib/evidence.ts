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
  /**
   * Label for a participant whose display name the adapter never resolved (it sends the id as
   * the name then). Default "Speaker", the display-channel fallback. Ids never become labels.
   */
  unresolvedLabel?: string;
  /** Interval cleaning. Defaults: minDuration 0.3, mergeGap 0.3, lead MEET_LEAD. */
  clean?: CleanOptions;
  /**
   * Recording-relative seconds of speech on the microphone channel (the recogniser's mic
   * segments). The participant whose speaking coincides with it is the human, whatever the
   * platform calls the tile: Meet showed "You" on 2026-09-24 and the full name on 2026-09-25.
   * Without it only `selfNames` identifies the self tile.
   */
  micSpeech?: Array<{ start: number; end: number }>;
}

/** The human's own tile, as found by its overlap with microphone speech. */
export interface SelfTile {
  /** The display name the platform gave the tile. */
  name: string;
  /** Share of the tile's speaking time that coincides with microphone speech, 0–1. */
  micShare: number;
  /** Seconds the tile was reported speaking, clipped to the recording. */
  seconds: number;
}

/** A tile is the human's when at least this share of its speaking coincides with mic speech. */
export const SELF_MIC_SHARE = 0.5;
/** Seconds a tile must have been reported speaking before its mic share is trusted. */
export const SELF_MIN_SECONDS = 5;
/**
 * Seconds a tile must have been on screen (summed over roster snapshots), or half the recording
 * when that is shorter, to be a participant without ever having spoken for `minDuration`. Meet
 * flashes tiles for a shared screen or a status ("You are presenting", three seconds on
 * 2026-09-25) that are nobody.
 */
export const MIN_PRESENCE_SECONDS = 10;
/**
 * Tile labels that are a status, not a person: Meet's tile for the human's own shared screen
 * ("You are presenting", 2026-09-25). English; extend on observation. A remote's share is
 * "Name (Presentation)", caught by `isPresentationOf`.
 */
export const PRESENTATION_LABELS: ReadonlySet<string> = new Set(['You are presenting']);

export interface PlatformEvidence {
  /** Display-channel platform intervals, cleaned, clipped to the recording, sorted by start. */
  intervals: SpeakerInterval[];
  /**
   * Resolved display names, one per participant id plus roster names, in first-seen order,
   * deduplicated, with the self tile replaced by `selfLabel` or omitted. Not listed: presentation
   * tiles (a name that is another participant's name plus a parenthesised suffix, Meet's
   * "Anna (Presentation)") and tiles of no substance (never reported speaking for `minDuration`
   * and on screen under `MIN_PRESENCE_SECONDS`). Never an id string.
   */
  participants: string[];
  /** The human's tile when `micSpeech` identified exactly one. */
  self?: SelfTile;
  /**
   * Remote tiles of substance, one label per tile (an unresolved one under `unresolvedLabel`,
   * a rejoin under a new id twice), plus roster-only names with presence. What "the one remote
   * participant" is counted on.
   */
  remotes: string[];
  /** Whether the log holds a roster at all; without one nobody's presence is known. */
  rosterSeen: boolean;
}

/** Seconds of overlap between two interval lists. */
function overlapSeconds(
  a: ReadonlyArray<{ start: number; end: number }>,
  b: ReadonlyArray<{ start: number; end: number }>,
): number {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      const o = Math.min(x.end, y.end) - Math.max(x.start, y.start);
      if (o > 0) total += o;
    }
  }
  return total;
}

/** "Anna (Presentation)" next to "Anna": a tile for a shared screen, not a person. */
function isPresentationOf(name: string, names: ReadonlySet<string>): boolean {
  const open = name.lastIndexOf(' (');
  return open > 0 && name.endsWith(')') && names.has(name.slice(0, open));
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

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
 *
 * The transport is fire-and-forget, so a message can be lost or arrive twice. A duplicated
 * start or stop is harmless (togglesToIntervals ignores a start while open and a stop while
 * closed). A lost stop stretches that turn to the participant's next stop. A lost start loses
 * that turn, except when the stop is the first toggle received for the id: that reads as
 * "already speaking when listening began" and opens from t=0.
 *
 * The human's own tile is found by evidence, not by label: the id whose speaking coincides with
 * `micSpeech` (at least `SELF_MIC_SHARE` of its time, over at least `SELF_MIN_SECONDS`) is the
 * human; its intervals are not display evidence, since the display channel never carries the
 * human's voice, and it is listed under `selfLabel`. `selfNames` remains the fallback for a tile
 * that spoke too little to judge or a call without `micSpeech`.
 */
export function eventsToEvidence(
  events: AdapterEvent[],
  startedAtMs: number,
  endedAtMs: number,
  opts: EvidenceOptions = {},
): PlatformEvidence {
  const selfNames = new Set(opts.selfNames ?? ['You']);
  const unresolvedLabel = opts.unresolvedLabel ?? 'Speaker';
  const duration = toRecordingSeconds(endedAtMs, startedAtMs);

  /** Participant id → the last display name seen for it that is not the id itself. */
  const nameOf = new Map<string, string>();
  /** Every display name ever seen per id (a name that resolves mid-call is one person). */
  const namesById = new Map<string, Set<string>>();
  const ids = new Set<string>();
  /** Participant ids and roster names in the order they were first seen. */
  const order: Array<{ id: string } | { name: string }> = [];
  const toggles: Array<{ t: number; speaker: string; speaking: boolean }> = [];
  const rosters: Array<{ t: number; names: string[] }> = [];
  for (const ev of events) {
    if (ev.type === 'roster') {
      for (const n of ev.names) order.push({ name: n });
      rosters.push({ t: toRecordingSeconds(ev.at, startedAtMs), names: ev.names });
      continue;
    }
    if (!ids.has(ev.id)) {
      ids.add(ev.id);
      order.push({ id: ev.id });
    }
    if (ev.name !== ev.id) {
      nameOf.set(ev.id, ev.name);
      const names = namesById.get(ev.id) ?? new Set<string>();
      names.add(ev.name);
      namesById.set(ev.id, names);
    }
    toggles.push({
      t: toRecordingSeconds(ev.at, startedAtMs),
      speaker: ev.id,
      speaking: ev.speaking,
    });
  }

  // A stop that is the first toggle received for its id: speaking since before listening began.
  // Open it at -Infinity; the clip below makes that t=0. Any later unmatched stop is a lost
  // start and is ignored, so one lost message cannot rewrite the beginning of the recording.
  const first = new Set<string>();
  for (const tg of [...toggles].sort((a, b) => a.t - b.t)) {
    if (first.has(tg.speaker)) continue;
    first.add(tg.speaker);
    if (!tg.speaking) {
      toggles.push({ t: Number.NEGATIVE_INFINITY, speaker: tg.speaker, speaking: true });
    }
  }

  const clipped = togglesToIntervals('display', toggles, duration).map((iv) => ({
    ...iv,
    start: Math.max(0, iv.start),
    end: Math.min(duration, iv.end),
  }));

  const byId = new Map<string, SpeakerInterval[]>();
  for (const iv of clipped) {
    if (iv.end <= iv.start) continue;
    const list = byId.get(iv.speaker) ?? [];
    list.push(iv);
    byId.set(iv.speaker, list);
  }
  /** Seconds each id was reported speaking, clipped to the recording. */
  const secondsById = new Map<string, number>();
  /** Ids that spoke for real: at least one interval survives the same cleaning as the evidence. */
  const spokeIds = new Set<string>();
  const cleaning = {
    minDuration: opts.clean?.minDuration,
    mergeGap: opts.clean?.mergeGap,
    lead: 0,
  };
  for (const [id, list] of byId) {
    secondsById.set(
      id,
      list.reduce((sum, iv) => sum + (iv.end - iv.start), 0),
    );
    if (cleanIntervals(list, cleaning).length > 0) spokeIds.add(id);
  }

  // Self by microphone: per id, how much of its speaking coincides with mic speech. Exactly one
  // tile may qualify: two that do (a colleague in the same room, on their own laptop, whom the
  // microphone hears through the air) are both kept, and the label rule alone applies.
  const selfIds = new Set<string>();
  let self: SelfTile | undefined;
  if (opts.micSpeech) {
    const candidates: Array<{ id: string; tile: SelfTile }> = [];
    for (const [id, list] of byId) {
      const seconds = secondsById.get(id) ?? 0;
      if (seconds < SELF_MIN_SECONDS - EPSILON) continue;
      const share = overlapSeconds(list, opts.micSpeech) / seconds;
      if (share < SELF_MIC_SHARE - EPSILON) continue;
      candidates.push({
        id,
        tile: {
          name: nameOf.get(id) ?? unresolvedLabel,
          micShare: round3(Math.min(1, share)),
          seconds: round3(seconds),
        },
      });
    }
    if (candidates.length === 1) {
      selfIds.add(candidates[0]!.id);
      self = candidates[0]!.tile;
    }
  }
  const isSelfId = (id: string): boolean => selfIds.has(id) || selfNames.has(nameOf.get(id) ?? '');

  const raw = clipped
    .filter((iv) => !isSelfId(iv.speaker))
    .map((iv) => ({ ...iv, speaker: nameOf.get(iv.speaker) ?? unresolvedLabel }))
    .filter((iv) => iv.end > iv.start);

  const intervals = cleanIntervals(raw, {
    ...opts.clean,
    lead: opts.clean?.lead ?? MEET_LEAD,
  }).map((iv) => (iv.start < 0 ? { ...iv, start: 0 } : iv));

  // A selfLabel equal to a remote participant's name collapses to one entry here, and that
  // participant's display intervals become indistinguishable from the mic channel's label.
  const selfDisplayNames = new Set<string>(selfNames);
  for (const id of selfIds) {
    const name = nameOf.get(id);
    if (name !== undefined) selfDisplayNames.add(name);
  }
  const allNames = new Set<string>(nameOf.values());
  for (const entry of order) if ('name' in entry && !ids.has(entry.name)) allNames.add(entry.name);
  const isPresentation = (name: string): boolean =>
    PRESENTATION_LABELS.has(name) || isPresentationOf(name, allNames);

  // Substance: seconds on screen per name from the roster snapshots (each holds until the next),
  // and whether the name spoke for real over its ids.
  const presence = new Map<string, number>();
  const sortedRosters = [...rosters].sort((a, b) => a.t - b.t);
  sortedRosters.forEach((r, i) => {
    const next = i + 1 < sortedRosters.length ? sortedRosters[i + 1]!.t : duration;
    const span = Math.min(duration, next) - Math.max(0, r.t);
    if (span <= 0) return;
    for (const n of new Set(r.names)) presence.set(n, (presence.get(n) ?? 0) + span);
  });
  const spokeNames = new Set<string>();
  for (const id of spokeIds) {
    const name = nameOf.get(id);
    if (name !== undefined) spokeNames.add(name);
  }
  const minPresence = Math.min(MIN_PRESENCE_SECONDS, duration / 2) - EPSILON;
  const hasSubstance = (name: string | undefined, id?: string): boolean =>
    (id !== undefined && spokeIds.has(id)) ||
    (name !== undefined && (spokeNames.has(name) || (presence.get(name) ?? 0) >= minPresence));

  // Participants: one label per person. A roster name that was ever an id's name is that person
  // under the id's current name (a name that resolved mid-call), and the id, not the roster
  // line, counts it as a remote; a roster name equal to an id string is the id unresolved.
  // Remotes: one entry per tile, unresolved tiles included, so that "exactly one remote" is a
  // count of people, not of labels.
  const currentNameOf = new Map<string, string>();
  for (const [id, names] of namesById) {
    const current = nameOf.get(id);
    if (current !== undefined) for (const n of names) currentNameOf.set(n, current);
  }
  const participants: string[] = [];
  const remotes: string[] = [];
  const add = (label: string | undefined): void => {
    if (label !== undefined && !participants.includes(label)) participants.push(label);
  };
  for (const entry of order) {
    if ('id' in entry) {
      const name = nameOf.get(entry.id);
      if (name !== undefined && isPresentation(name)) continue;
      if (!hasSubstance(name, entry.id)) continue;
      if (isSelfId(entry.id)) {
        add(opts.selfLabel);
        continue;
      }
      remotes.push(name ?? unresolvedLabel);
      add(name);
    } else {
      if (ids.has(entry.name)) continue;
      const ofId = currentNameOf.get(entry.name);
      const name = ofId ?? entry.name;
      if (isPresentation(name) || !hasSubstance(name)) continue;
      if (selfDisplayNames.has(name)) {
        add(opts.selfLabel);
        continue;
      }
      if (ofId === undefined && !remotes.includes(name)) remotes.push(name);
      add(name);
    }
  }

  const rosterSeen = rosters.length > 0;
  return self === undefined
    ? { intervals, participants, remotes, rosterSeen }
    : { intervals, participants, self, remotes, rosterSeen };
}
