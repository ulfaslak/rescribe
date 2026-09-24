// Google Meet platform adapter (content script, runs in Meet's page as an isolated world).
//
// Emits to the extension:
//   roster             the participant names currently on screen (on change)
//   speaker            a participant started/stopped speaking, stamped at the change itself
//   adapter-diagnostic when the page has tiles but no usable speaking signal, or no tiles at all
//
// Meet's markup is obfuscated and changes, so detection is data-driven and narrow:
//   TILE_SELECTOR  finds participant tiles.
//   METER_SELECTOR finds, inside a tile, the audio-level meter. Its class list flips between
//                  level classes while the participant speaks (observed on the human's own tile
//                  in a live call, 2026-09-24; assumed for remote tiles until LIVE_CHECKS confirms).
//                  For the record, that call showed the meter idle as `DYfzY cYKTje gjg47c`
//                  (mic RMS 0.002) and carrying `sxlEM` plus a level class while audio flowed.
//                  We do not depend on those names; motion is the signal.
//   NAME_SELECTOR  the participant's display name, a `span.notranslate` (same call). The text
//                  heuristic below is the fallback when it is absent.
// A MutationObserver stamps every meter class change at the moment it happens; ChangeActivity
// turns runs of changes into speaking intervals (start = first change of the run, stop = last
// change). The 250 ms poll only closes intervals, tracks the roster, and reports drift. Polling is
// throttled in background tabs, so nothing time-critical depends on it.
//
// Calibration mode, for a human in a live call (AGENTS/LIVE_CHECKS.md):
//   in the Meet tab's console:  postMessage({ rescribe: 'calibrate', seconds: 60 }, '*')
// It samples every tile for the window, correlates the meter signal with the human's own
// microphone level (ground truth for the self tile), lists name candidates and the page's media
// elements, and prints a JSON report to the console. Nothing leaves the page.
//
// When the document root carries `data-rescribe-harness` (set only by e2e fixtures), every message
// is also dispatched on window as a 'rescribe:event' CustomEvent. It is off on real pages because
// Chromium clones the detail into the page world, where Meet's scripts could read it.
import type { Message } from '../lib/messages.ts';
import { ChangeActivity } from '../lib/activity.ts';

const PLATFORM = 'meet' as const;
/** The messages this adapter emits: the platform-stamped members of the union. */
type AdapterMessage = Extract<Message, { platform: typeof PLATFORM }>;
const TILE_SELECTOR = '[data-participant-id]';
const METER_SELECTOR = '[jsname="QgSmzd"]';
const NAME_SELECTOR = 'span.notranslate';
const RECENT_EVENTS = 200;
const ACTIVITY_WINDOW_MS = 700;
const POLL_MS = 250;
const DIAGNOSTIC_AFTER_MS = 60_000;
const DIAGNOSTIC_EVERY_MS = 300_000;
/** Text inside these, within a tile, is UI chrome (menu items such as "Reframe"), never a name. */
const NAME_EXCLUDE =
  'button, [role="button"], [role="menu"], [role="menuitem"], [role="tooltip"], [aria-hidden="true"]';
/** Short status chips Meet renders next to a name. "You" is Meet's label for the human's own tile and stays. */
const NAME_STOPLIST = /^(muted|unmuted|pinned|host|co-host|presenting|hd|sd|live|new)$/i;

const harness = document.documentElement.hasAttribute('data-rescribe-harness');
/** The last messages this adapter emitted, so a calibration report can show its own behaviour. */
const recent: AdapterMessage[] = [];

function send(msg: AdapterMessage): void {
  recent.push(msg);
  if (recent.length > RECENT_EVENTS) recent.shift();
  if (harness) {
    try {
      window.dispatchEvent(new CustomEvent('rescribe:event', { detail: msg }));
    } catch {
      // never let a listener break the adapter
    }
  }
  try {
    void chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // extension reloaded underneath us, or not running as a content script
  }
}

function tileId(tile: Element): string {
  return tile.getAttribute('data-participant-id') ?? '?';
}

/** Participant tiles, one per id (Meet renders the self view twice: grid tile plus thumbnail). */
function tiles(): HTMLElement[] {
  const seen = new Set<string>();
  const out: HTMLElement[] = [];
  for (const tile of document.querySelectorAll<HTMLElement>(TILE_SELECTOR)) {
    const id = tileId(tile);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(tile);
  }
  return out;
}

interface TextCandidate {
  text: string;
  where: string;
}

/** Short visible texts inside a tile, shortest first, excluding UI chrome inside the tile. */
export function textCandidates(tile: HTMLElement): TextCandidate[] {
  const seen = new Set<string>();
  const out: TextCandidate[] = [];
  const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim() ?? '';
    const parent = n.parentElement;
    if (!text || !parent || text.length > 60 || !/\p{L}/u.test(text) || NAME_STOPLIST.test(text))
      continue;
    const excluded = parent.closest(NAME_EXCLUDE);
    if (excluded && excluded !== tile && tile.contains(excluded)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, where: describe(parent) });
  }
  return out.sort((a, b) => a.text.length - b.text.length);
}

/** Display name for a tile: the name span when present, else the shortest plausible text. */
export function tileName(tile: HTMLElement): string | undefined {
  for (const el of tile.querySelectorAll<HTMLElement>(NAME_SELECTOR)) {
    const text = el.textContent?.trim() ?? '';
    if (text && text.length <= 60 && !NAME_STOPLIST.test(text)) return text;
  }
  return textCandidates(tile)[0]?.text;
}

function meterOf(tile: Element): Element | null {
  return tile.querySelector(METER_SELECTOR);
}

// --- Live adapter ---------------------------------------------------------------------------
const activity = new ChangeActivity(ACTIVITY_WINDOW_MS);
/** Participants currently reported as speaking, with the name used at the start. */
const speaking = new Map<string, string>();
let lastRoster = '';
let signalMissingSince: number | undefined;
let lastDiagnostic = Number.NEGATIVE_INFINITY;

function start(id: string, tile: HTMLElement, at: number): void {
  if (speaking.has(id)) return;
  const name = tileName(tile) ?? id;
  speaking.set(id, name);
  send({ type: 'speaker', platform: PLATFORM, at, id, name, speaking: true });
}

function stop(id: string, at: number): void {
  const name = speaking.get(id);
  if (name === undefined) return;
  speaking.delete(id);
  send({ type: 'speaker', platform: PLATFORM, at, id, name, speaking: false });
}

const observer = new MutationObserver((records) => {
  const now = Date.now();
  for (const r of records) {
    const el = r.target;
    if (!(el instanceof Element) || !el.matches(METER_SELECTOR)) continue;
    if (r.oldValue === (el.getAttribute('class') ?? '')) continue;
    const tile = el.closest<HTMLElement>(TILE_SELECTOR);
    if (!tile) continue;
    const id = tileId(tile);
    const wasActive = activity.isActive(id, now);
    activity.touch(id, now);
    if (!wasActive && activity.isActive(id, now)) start(id, tile, activity.startedAt(id) ?? now);
  }
});
observer.observe(document.documentElement, {
  subtree: true,
  attributes: true,
  attributeFilter: ['class'],
  attributeOldValue: true,
});

function poll(): void {
  const now = Date.now();
  const found = tiles();
  const present = new Map(found.map((t) => [tileId(t), t]));

  const names = [...new Set(found.map(tileName).filter((n): n is string => !!n))];
  const rosterKey = [...names].sort().join('\u0000');
  if (rosterKey !== lastRoster) {
    lastRoster = rosterKey;
    send({ type: 'roster', platform: PLATFORM, at: now, names });
  }

  for (const id of [...speaking.keys()]) {
    const tile = present.get(id);
    if (!tile || !meterOf(tile)) {
      // Tile left the layout or the meter was swapped out (mute): the interval ends now.
      stop(id, now);
      activity.forget(id);
    } else if (!activity.isActive(id, now)) {
      stop(id, activity.lastChangeAt(id) ?? now);
    }
  }
  for (const id of [...speaking.keys()]) if (!present.has(id)) speaking.delete(id);

  const meters = found.filter((t) => meterOf(t)).length;
  const missing = found.length === 0 || meters === 0;
  if (!missing) {
    signalMissingSince = undefined;
  } else {
    signalMissingSince ??= now;
    if (
      now - signalMissingSince >= DIAGNOSTIC_AFTER_MS &&
      now - lastDiagnostic >= DIAGNOSTIC_EVERY_MS
    ) {
      lastDiagnostic = now;
      send({
        type: 'adapter-diagnostic',
        platform: PLATFORM,
        at: now,
        message:
          found.length === 0
            ? `no participant tiles match ${TILE_SELECTOR} (not in a call, or Meet's markup changed)`
            : `${found.length} participant tile(s) but no audio meter matches ${METER_SELECTOR} (everyone muted, or Meet's markup changed; see LIVE_CHECKS)`,
      });
    }
  }
}

// --- Calibration ----------------------------------------------------------------------------
function describe(el: Element): string {
  const cls = el.classList.length ? '.' + Array.from(el.classList).sort().join('.') : '';
  const attrs = ['jsname', 'role', 'aria-label', 'data-self-name']
    .filter((a) => el.hasAttribute(a))
    .map((a) => `[${a}="${el.getAttribute(a)}"]`)
    .join('');
  return `${el.tagName.toLowerCase()}${cls}${attrs}`;
}

function rms(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

interface Mic {
  read: () => number;
  state: () => AudioContextState;
  stop: () => void;
}

async function micLevel(): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  await ctx.resume();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  return {
    read: () => rms(an, buf),
    state: () => ctx.state,
    stop: () => {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}

interface Bucket {
  samples: number;
  micSum: number;
}

function bucket(map: Map<string, Bucket>, key: string, mic: number): void {
  const b = map.get(key) ?? { samples: 0, micSum: 0 };
  b.samples++;
  if (Number.isFinite(mic)) b.micSum += mic;
  map.set(key, b);
}

function mediaElements(): unknown[] {
  return Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    muted: el.muted,
    paused: el.paused,
    tracks: (el.srcObject instanceof MediaStream ? el.srcObject.getTracks() : []).map((t) => ({
      kind: t.kind,
      id: t.id,
      label: t.label,
      enabled: t.enabled,
      muted: t.muted,
    })),
  }));
}

let calibrating = false;

async function calibrate(requestedSeconds: number): Promise<void> {
  if (calibrating) {
    console.warn('[rescribe] calibration already running');
    return;
  }
  const seconds = Math.min(
    600,
    Math.max(5, Number.isFinite(requestedSeconds) ? requestedSeconds : 60),
  );
  calibrating = true;
  const cal = new ChangeActivity(ACTIVITY_WINDOW_MS);
  let mic: Mic | undefined;
  try {
    try {
      mic = await micLevel();
    } catch (err) {
      console.warn('[rescribe] no microphone for calibration ground truth:', err);
    }
    const perTile = new Map<
      string,
      {
        attrs: Record<string, string>;
        names: TextCandidate[];
        meterFound: boolean;
        meterStates: Map<string, Bucket>;
        speaking: Map<string, Bucket>;
      }
    >();
    const started = Date.now();
    const end = started + seconds * 1000;
    console.info(
      `[rescribe] calibrating for ${seconds}s: let different people speak, with pauses…`,
    );
    while (Date.now() < end) {
      const now = Date.now();
      const level = mic?.read() ?? Number.NaN;
      for (const tile of tiles()) {
        const id = tileId(tile);
        let entry = perTile.get(id);
        if (!entry) {
          entry = {
            attrs: Object.fromEntries(
              Array.from(tile.attributes).map((a) => [a.name, a.value.slice(0, 80)]),
            ),
            names: textCandidates(tile).slice(0, 8),
            meterFound: false,
            meterStates: new Map(),
            speaking: new Map(),
          };
          perTile.set(id, entry);
        }
        const m = meterOf(tile);
        if (!m) {
          bucket(entry.speaking, 'no-meter', level);
          continue;
        }
        entry.meterFound = true;
        const cls = m.getAttribute('class') ?? '';
        bucket(entry.meterStates, cls, level);
        bucket(entry.speaking, cal.observe(id, cls, now) ? 'speaking' : 'silent', level);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    const summarize = (map: Map<string, Bucket>) =>
      Object.fromEntries(
        [...map]
          .sort((a, b) => b[1].samples - a[1].samples)
          .map(([k, b]) => [
            k,
            {
              pct: Math.round((100 * b.samples * POLL_MS) / (seconds * 1000)),
              meanMic: Number((b.micSum / Math.max(1, b.samples)).toFixed(4)),
            },
          ]),
      );
    const report = {
      micGroundTruth: !!mic,
      audioContextState: mic?.state(),
      tileSelector: TILE_SELECTOR,
      meterSelector: METER_SELECTOR,
      tiles: Object.fromEntries(
        [...perTile].map(([id, e]) => [
          id,
          {
            attrs: e.attrs,
            nameGuess: e.names[0]?.text,
            nameCandidates: e.names,
            meterFound: e.meterFound,
            speakingVsMic: summarize(e.speaking),
            meterStates: summarize(e.meterStates),
          },
        ]),
      ),
      media: mediaElements(),
      adapterEvents: recent
        .filter((m) => m.type !== 'adapter-diagnostic' && m.at >= started)
        .map((m) => ({ ...m, at: Number(((m.at - started) / 1000).toFixed(2)) })),
    };
    console.info('[rescribe] calibration report (paste this to the agent):');
    console.info(JSON.stringify(report, null, 2));
  } finally {
    mic?.stop();
    calibrating = false;
  }
}

window.addEventListener('message', (e) => {
  const d = e.data as { rescribe?: string; seconds?: number } | undefined;
  if (e.source === window && d?.rescribe === 'calibrate') void calibrate(Number(d.seconds ?? 60));
});

window.setInterval(poll, POLL_MS);
console.info('[rescribe] Meet adapter loaded');
