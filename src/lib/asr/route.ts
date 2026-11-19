// Which recogniser hears which voiced region, pure. The Danish + English model (DECISIONS § Speech
// recognition) asks a small Whisper which language a stretch of speech is in, restricted to the
// two it routes between, and sends Danish to Edda and the rest to Parakeet.
//
// Language ID is asked per window, not per region: consecutive regions are packed into windows of
// at most `maxVoicedS` voiced seconds (one Whisper input) spanning at most `maxSpanS`, so a call of
// short turns costs one encoder pass per half minute of speech, not one per "mm". A window's score
// is then smoothed with its neighbours' (a duration-weighted mean over the windows centred within
// `radiusS`): a single window that sounds English in a Danish call (a name, a quote, a laugh) does
// not flip, a minute of English does. A window sure of itself (`minSureS` of voice and a score
// past `sure` either way) keeps its own language: an English guest's 20 s answer in a Danish call
// stays English, which smoothing alone would hand to Edda. Measured on the human's calls
// (2026-11-19): 125 Danish windows of 25 s, lowest P(Danish) 0.65; every English window 0.00.
// Windows of 10 s did dip to 0.02 inside Danish, hence the 15 s floor.
import type { Region } from '../vad.ts';

export type RouteLanguage = 'da' | 'en';

export interface RouteOptions {
  maxVoicedS: number;
  maxSpanS: number;
  radiusS: number;
  /** A smoothed P(Danish) at or above this goes to Edda. */
  threshold: number;
  /** A window with this much voice whose own P(Danish) is under 1 − `sure` or over `sure`… */
  minSureS: number;
  /** …is not smoothed. */
  sure: number;
}

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
  maxVoicedS: 30,
  maxSpanS: 60,
  radiusS: 45,
  threshold: 0.5,
  minSureS: 15,
  sure: 0.9,
};

/** Region indices grouped into language-ID windows, in order. Every region is in exactly one. */
export function lidWindows(
  regions: readonly Region[],
  opts: RouteOptions = DEFAULT_ROUTE_OPTIONS,
): number[][] {
  const windows: number[][] = [];
  let current: number[] = [];
  let voiced = 0;
  regions.forEach((r, i) => {
    const length = r.end - r.start;
    const first = current.length > 0 ? regions[current[0]!]! : undefined;
    if (first && (voiced + length > opts.maxVoicedS || r.end - first.start > opts.maxSpanS)) {
      windows.push(current);
      current = [];
      voiced = 0;
    }
    current.push(i);
    voiced += length;
  });
  if (current.length > 0) windows.push(current);
  return windows;
}

/**
 * The language of every region from the windows' P(Danish), smoothed as described above. Returns
 * one language per region, in region order.
 */
export function routeRegions(
  regions: readonly Region[],
  windows: readonly number[][],
  pDanish: readonly number[],
  opts: RouteOptions = DEFAULT_ROUTE_OPTIONS,
): RouteLanguage[] {
  const out: RouteLanguage[] = new Array<RouteLanguage>(regions.length).fill('en');
  const info = windows.map((w) => {
    const first = regions[w[0]!]!;
    const last = regions[w[w.length - 1]!]!;
    const voiced = w.reduce((sum, i) => sum + (regions[i]!.end - regions[i]!.start), 0);
    return { centre: (first.start + last.end) / 2, voiced };
  });
  windows.forEach((w, i) => {
    let weight = 0;
    let sum = 0;
    info.forEach((other, j) => {
      if (Math.abs(other.centre - info[i]!.centre) > opts.radiusS) return;
      weight += other.voiced;
      sum += other.voiced * (pDanish[j] ?? 0);
    });
    const own = pDanish[i] ?? 0;
    const sure = info[i]!.voiced >= opts.minSureS && (own >= opts.sure || own <= 1 - opts.sure);
    const p = sure ? own : weight > 0 ? sum / weight : own;
    const lang: RouteLanguage = p >= opts.threshold ? 'da' : 'en';
    for (const r of w) out[r] = lang;
  });
  return out;
}
