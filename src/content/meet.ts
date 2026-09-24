// Google Meet platform adapter (content script, runs in Meet's page as an isolated world).
//
// Emits to the extension:
//   roster             the participant names currently on screen (on change)
//   speaker            a participant started/stopped speaking
//   adapter-diagnostic when tiles are found but the speaking signal is missing
//
// Meet's markup is obfuscated and changes, so detection is data-driven and narrow:
//   TILE_SELECTOR  finds participant tiles.
//   METER_SELECTOR finds, inside a tile, the audio-level meter. Its class list flips between
//                  level classes while the participant speaks and holds still otherwise, so
//                  "changed within ACTIVITY_WINDOW_MS" is the speaking signal. No dependence on
//                  which class means what (calibrated 2026-09-24, see spikes/README.md).
//
// Calibration mode, for a human in a live call (AGENTS/LIVE_CHECKS.md):
//   in the Meet tab's console:  postMessage({ rescribe: 'calibrate', seconds: 60 }, '*')
// It samples every tile for the window, correlates the meter signal with the human's own
// microphone level (ground truth for the self tile), lists name candidates and the page's media
// elements, and prints a JSON report.
//
// Every emitted message is also dispatched on window as a 'rescribe:event' CustomEvent so the e2e
// harness can observe the adapter on a fake page; Meet's own scripts cannot read the detail.
import type { Message } from '../lib/messages.ts';
import { ChangeActivity } from '../lib/activity.ts';

const PLATFORM = 'meet' as const;
const TILE_SELECTOR = '[data-participant-id]';
const METER_SELECTOR = '[jsname="QgSmzd"]';
const ACTIVITY_WINDOW_MS = 700;
const POLL_MS = 250;
const DIAGNOSTIC_EVERY_MS = 60_000;
/** Text inside these is UI chrome (menu items such as "Reframe"), never a participant name. */
const NAME_EXCLUDE =
  'button, [role="button"], [role="menu"], [role="menuitem"], [role="tooltip"], [aria-hidden="true"]';

function send(msg: Message): void {
  try {
    window.dispatchEvent(new CustomEvent('rescribe:event', { detail: msg }));
  } catch {
    // never let a listener break the adapter
  }
  try {
    void chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // extension reloaded underneath us, or not running as a content script
  }
}

function tiles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(TILE_SELECTOR));
}

function tileId(tile: HTMLElement): string {
  return tile.getAttribute('data-participant-id') ?? '?';
}

interface TextCandidate {
  text: string;
  where: string;
}

/** Short visible texts inside a tile, shortest first, excluding UI chrome. */
export function textCandidates(tile: HTMLElement): TextCandidate[] {
  const seen = new Set<string>();
  const out: TextCandidate[] = [];
  const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim() ?? '';
    const parent = n.parentElement;
    if (!text || !parent || text.length > 60 || /^[\d:.\s]+$/.test(text)) continue;
    if (parent.closest(NAME_EXCLUDE)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, where: describe(parent) });
  }
  return out.sort((a, b) => a.text.length - b.text.length);
}

/** Best-effort display name for a tile. Meet labels the human's own tile "You". */
export function tileName(tile: HTMLElement): string | undefined {
  const self =
    tile.getAttribute('data-self-name') ??
    tile.querySelector('[data-self-name]')?.getAttribute('data-self-name');
  if (self) return self;
  return textCandidates(tile)[0]?.text;
}

function meter(tile: HTMLElement): Element | null {
  return tile.querySelector(METER_SELECTOR);
}

const activity = new ChangeActivity(ACTIVITY_WINDOW_MS);

/** true/false when the tile has a meter; undefined when the selector no longer matches. */
function isSpeaking(tile: HTMLElement, now: number): boolean | undefined {
  const m = meter(tile);
  if (!m) return undefined;
  return activity.observe(tileId(tile), m.className, now);
}

// --- Live adapter ---------------------------------------------------------------------------
let lastRoster = '';
const speaking = new Map<string, boolean>();
let lastDiagnostic = 0;

function poll(): void {
  const now = Date.now();
  const found = tiles();
  const names = [...new Set(found.map(tileName).filter((n): n is string => !!n))];
  const rosterKey = [...names].sort().join('\u0000');
  if (rosterKey !== lastRoster) {
    lastRoster = rosterKey;
    send({ type: 'roster', platform: PLATFORM, at: now, names });
  }
  let metersMissing = 0;
  for (const tile of found) {
    const id = tileId(tile);
    const state = isSpeaking(tile, now);
    if (state === undefined) {
      metersMissing++;
      continue;
    }
    const prev = speaking.get(id);
    if (prev === undefined) {
      // A tile we have not seen: it starts silent. Only transitions are events.
      speaking.set(id, false);
      if (!state) continue;
    }
    if (prev !== state) {
      speaking.set(id, state);
      send({
        type: 'speaker',
        platform: PLATFORM,
        at: now,
        name: tileName(tile) ?? id,
        speaking: state,
      });
    }
  }
  for (const id of speaking.keys()) {
    if (!found.some((t) => tileId(t) === id)) {
      speaking.delete(id);
      activity.forget(id);
    }
  }
  if (
    found.length &&
    metersMissing === found.length &&
    now - lastDiagnostic > DIAGNOSTIC_EVERY_MS
  ) {
    lastDiagnostic = now;
    send({
      type: 'adapter-diagnostic',
      platform: PLATFORM,
      at: now,
      message: `${found.length} participant tiles but no audio meter matches ${METER_SELECTOR}; Meet's markup changed. Re-run calibration (LIVE_CHECKS).`,
    });
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

async function micLevel(): Promise<{ read: () => number; stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  return {
    read: () => rms(an, buf),
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

async function calibrate(seconds: number): Promise<void> {
  const cal = new ChangeActivity(ACTIVITY_WINDOW_MS);
  let mic: { read: () => number; stop: () => void } | undefined;
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
  console.info(`[rescribe] calibrating for ${seconds}s: let different people speak, with pauses…`);
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
      const m = meter(tile);
      if (!m) {
        bucket(entry.speaking, 'no-meter', level);
        continue;
      }
      entry.meterFound = true;
      bucket(entry.meterStates, m.className, level);
      bucket(entry.speaking, cal.observe(id, m.className, now) ? 'speaking' : 'silent', level);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  mic?.stop();
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
  };
  console.info('[rescribe] calibration report (paste this to the agent):');
  console.info(JSON.stringify(report, null, 2));
}

window.addEventListener('message', (e) => {
  const d = e.data as { rescribe?: string; seconds?: number } | undefined;
  if (e.source === window && d?.rescribe === 'calibrate') void calibrate(d.seconds ?? 60);
});

window.setInterval(poll, POLL_MS);
console.info('[rescribe] Meet adapter loaded');
