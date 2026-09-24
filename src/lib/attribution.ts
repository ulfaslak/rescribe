// Speaker attribution: one pure function from segments plus evidence to labelled segments.
// Evidence comes from layers that all emit SpeakerInterval: platform adapters (Meet's speaking
// indicator), a diarization model (later), and channel identity (mic = the human). See
// AGENTS/DNA/DECISIONS.md § "Audio channels and speaker attribution".
import type {
  ChannelId,
  EvidenceSource,
  LabelledSegment,
  Segment,
  SpeakerInterval,
} from './types.ts';

const RANK: Record<EvidenceSource, number> = { platform: 3, model: 2, channel: 1 };

export interface AttributeOptions {
  /** Seconds. A non-overlapping interval this close to a segment can still label it. */
  tolerance?: number;
  /** Label when no evidence applies. */
  fallback?: Partial<Record<ChannelId, string>>;
}

const DEFAULT_FALLBACK: Record<ChannelId, string> = { mic: 'Me', display: 'Speaker' };

/** Convenience: the channel-identity layer as evidence covering the whole recording. */
export function channelIdentity(
  channel: ChannelId,
  speaker: string,
  end: number = Number.POSITIVE_INFINITY,
): SpeakerInterval {
  return { channel, speaker, start: 0, end, source: 'channel' };
}

interface Candidate {
  iv: SpeakerInterval;
  overlap: number;
  gap: number;
}

function compare(a: Candidate, b: Candidate): number {
  const rank = RANK[b.iv.source] - RANK[a.iv.source];
  if (rank !== 0) return rank;
  const aOver = a.overlap > 0 ? 1 : 0;
  const bOver = b.overlap > 0 ? 1 : 0;
  if (aOver !== bOver) return bOver - aOver;
  if (aOver) return b.overlap - a.overlap;
  return a.gap - b.gap;
}

export function attribute(
  segments: Segment[],
  evidence: SpeakerInterval[],
  opts: AttributeOptions = {},
): LabelledSegment[] {
  const tolerance = opts.tolerance ?? 1;
  const fallback = { ...DEFAULT_FALLBACK, ...opts.fallback };
  const byChannel = new Map<ChannelId, SpeakerInterval[]>();
  for (const iv of evidence) {
    if (iv.end <= iv.start) continue;
    const list = byChannel.get(iv.channel) ?? [];
    list.push(iv);
    byChannel.set(iv.channel, list);
  }

  return segments.map((seg) => {
    const candidates: Candidate[] = [];
    for (const iv of byChannel.get(seg.channel) ?? []) {
      const overlap = Math.min(seg.end, iv.end) - Math.max(seg.start, iv.start);
      const gap = overlap > 0 ? 0 : -overlap;
      if (overlap > 0 || gap <= tolerance) candidates.push({ iv, overlap, gap });
    }
    candidates.sort(compare);
    const best = candidates[0];
    if (!best) return { ...seg, speaker: fallback[seg.channel], evidence: 'none' };
    return { ...seg, speaker: best.iv.speaker, evidence: best.iv.source };
  });
}

/**
 * Turn on/off toggles (what a platform adapter sees) into intervals. Toggles are
 * `{ t, speaker, speaking }` in recording-relative seconds, any order. A speaker still "on" at
 * `end` is closed there.
 */
export function togglesToIntervals(
  channel: ChannelId,
  toggles: Array<{ t: number; speaker: string; speaking: boolean }>,
  end: number,
  source: EvidenceSource = 'platform',
): SpeakerInterval[] {
  const sorted = [...toggles].sort((a, b) => a.t - b.t);
  const open = new Map<string, number>();
  const out: SpeakerInterval[] = [];
  for (const tg of sorted) {
    if (tg.speaking) {
      if (!open.has(tg.speaker)) open.set(tg.speaker, tg.t);
    } else {
      const start = open.get(tg.speaker);
      if (start !== undefined) {
        if (tg.t > start) out.push({ channel, speaker: tg.speaker, start, end: tg.t, source });
        open.delete(tg.speaker);
      }
    }
  }
  for (const [speaker, start] of open) {
    if (end > start) out.push({ channel, speaker, start, end, source });
  }
  return out;
}
