// Google Meet platform adapter (content script, runs in Meet's page as an isolated world).
//
// Emits to the extension:
//   roster   — the participant names currently on screen (on change)
//   speaker  — a participant started/stopped speaking (needs calibrated selectors)
//   adapter-diagnostic — when tiles are found but no speaking signal is configured or seen
//
// Meet's markup is obfuscated and changes. Detection is therefore data-driven: TILE_SELECTOR
// finds participant tiles, SPEAKING_SELECTORS (empty until calibrated) find the speaking
// indicator inside a tile. Calibration mode records which descendants toggle inside each tile
// over a window of time, so a human in a live call can find the signal in one go:
//   in the Meet tab's console:  postMessage({ rescribe: 'calibrate', seconds: 60 }, '*')
// See AGENTS/LIVE_CHECKS.md § "Calibrate the Meet adapter".
import type { Message } from '../lib/messages.ts';

const PLATFORM = 'meet' as const;
const TILE_SELECTOR = '[data-participant-id]';
/** Selectors, relative to a tile, whose presence means "this participant is speaking now". */
const SPEAKING_SELECTORS: string[] = [];
const POLL_MS = 250;
const DIAGNOSTIC_EVERY_MS = 60_000;

function send(msg: Message): void {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // extension reloaded underneath us
  }
}

function tiles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(TILE_SELECTOR));
}

/** Best-effort display name for a tile: the self tile carries data-self-name; others show a short label. */
export function tileName(tile: HTMLElement): string | undefined {
  const self = tile.querySelector<HTMLElement>('[data-self-name]')?.dataset['selfName'];
  if (self) return self;
  let best: string | undefined;
  const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim() ?? '';
    if (!text || text.length > 60 || /^[\d:.\s]+$/.test(text)) continue;
    if (!best || text.length < best.length) best = text;
  }
  return best;
}

function isSpeaking(tile: HTMLElement): boolean {
  return SPEAKING_SELECTORS.some((s) => tile.matches(s) || tile.querySelector(s) !== null);
}

// --- Live adapter ---------------------------------------------------------------------------
let lastRoster = '';
const speaking = new Map<string, boolean>();
let lastDiagnostic = 0;

function poll(): void {
  const found = tiles();
  const names = found.map(tileName).filter((n): n is string => !!n);
  const rosterKey = [...new Set(names)].sort().join('\u0000');
  if (rosterKey !== lastRoster) {
    lastRoster = rosterKey;
    send({ type: 'roster', platform: PLATFORM, at: Date.now(), names: [...new Set(names)] });
  }
  if (SPEAKING_SELECTORS.length === 0) {
    if (found.length && Date.now() - lastDiagnostic > DIAGNOSTIC_EVERY_MS) {
      lastDiagnostic = Date.now();
      send({
        type: 'adapter-diagnostic',
        platform: PLATFORM,
        at: Date.now(),
        message: `${found.length} participant tiles, but no speaking selectors are calibrated (LIVE_CHECKS).`,
      });
    }
    return;
  }
  for (const tile of found) {
    const name = tileName(tile);
    if (!name) continue;
    const now = isSpeaking(tile);
    if (speaking.get(name) !== now) {
      speaking.set(name, now);
      send({ type: 'speaker', platform: PLATFORM, at: Date.now(), name, speaking: now });
    }
  }
}

// --- Calibration ----------------------------------------------------------------------------
interface Presence {
  present: boolean;
  toggles: number;
  presentMs: number;
  firstSeen: number;
}

function describe(el: Element): string {
  const cls = el.classList.length ? '.' + Array.from(el.classList).sort().join('.') : '';
  const attrs = ['jsname', 'role', 'aria-label', 'aria-hidden', 'data-is-muted', 'data-is-speaking']
    .filter((a) => el.hasAttribute(a))
    .map((a) => `[${a}="${el.getAttribute(a)}"]`)
    .join('');
  return `${el.tagName.toLowerCase()}${cls}${attrs}`;
}

async function calibrate(seconds: number): Promise<void> {
  const perTile = new Map<string, { name?: string; signals: Map<string, Presence> }>();
  const started = Date.now();
  const end = started + seconds * 1000;
  console.info(`[rescribe] calibrating for ${seconds}s: let different people speak, with pauses…`);
  while (Date.now() < end) {
    for (const tile of tiles()) {
      const id = tile.getAttribute('data-participant-id') ?? '?';
      const entry = perTile.get(id) ?? { name: tileName(tile), signals: new Map() };
      entry.name ??= tileName(tile);
      perTile.set(id, entry);
      const nowPresent = new Set<string>([describe(tile)]);
      for (const el of tile.querySelectorAll('*')) nowPresent.add(describe(el));
      for (const key of nowPresent) {
        const p = entry.signals.get(key) ?? {
          present: false,
          toggles: -1,
          presentMs: 0,
          firstSeen: Date.now(),
        };
        if (!p.present) p.toggles++;
        p.present = true;
        p.presentMs += POLL_MS;
        entry.signals.set(key, p);
      }
      for (const [key, p] of entry.signals) {
        if (!nowPresent.has(key) && p.present) {
          p.present = false;
          p.toggles++;
        }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const total = Date.now() - started;
  const report: Record<string, unknown> = {};
  for (const [id, entry] of perTile) {
    const candidates = [...entry.signals]
      .filter(([, p]) => p.toggles >= 2 && p.presentMs < total * 0.9)
      .sort((a, b) => b[1].toggles - a[1].toggles)
      .slice(0, 15)
      .map(([key, p]) => ({
        selector: key,
        toggles: p.toggles,
        presentPct: Math.round((100 * p.presentMs) / total),
      }));
    report[id] = { name: entry.name, candidates };
  }
  console.info('[rescribe] calibration report (paste this to the agent):');
  console.info(JSON.stringify(report, null, 2));
}

window.addEventListener('message', (e) => {
  const d = e.data as { rescribe?: string; seconds?: number } | undefined;
  if (e.source === window && d?.rescribe === 'calibrate') void calibrate(d.seconds ?? 60);
});

window.setInterval(poll, POLL_MS);
console.info('[rescribe] Meet adapter loaded');
