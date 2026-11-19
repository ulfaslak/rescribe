import { MODELS } from './asr/engine.ts';
import {
  DEFAULT_SETTINGS,
  FRAME_RATES,
  SETTINGS_VERSION,
  type FrameRate,
  type Settings,
} from './types.ts';

const KEY = 'settings';

/**
 * A stored settings object from any earlier version, brought to `SETTINGS_VERSION`. Pure; the
 * result is merged over `DEFAULT_SETTINGS` by `loadSettings` and written back by the next save.
 */
export function migrateSettings(stored: Partial<Settings>): Partial<Settings> {
  let out = stored;
  if ((out.settingsVersion ?? 0) < 1) {
    // 1 (2026-09-25, #27): WebM became the default container. The form had written
    // `container: 'mp4'` into every stored object whether or not the human ever chose it, so the
    // value is dropped once and the new default applies; picking MP4 again is one click.
    const { container: _container, ...rest } = out;
    out = rest;
  }
  if ((out.settingsVersion ?? 0) < 2) {
    // 2 (2026-11-19): the Danish + English model became the default. The form wrote Parakeet into
    // every stored object (it was the only option), so the stored value is dropped once and the
    // new default applies; Parakeet alone is one click away.
    const { model: _model, ...rest } = out;
    out = rest;
  }
  // A model this build does not offer (an older or newer key) would fail every transcription.
  if (out.model !== undefined && !(MODELS as readonly string[]).includes(out.model)) {
    const { model: _model, ...rest } = out;
    out = rest;
  }
  // What is read back from storage is input: a stored frame rate outside the offered ones would
  // reach the recorder as an undefined bitrate cap (Chrome's default, the large file again).
  if (out.frameRate !== undefined) out = { ...out, frameRate: toFrameRate(out.frameRate) };
  if (out.container !== undefined && out.container !== 'webm' && out.container !== 'mp4') {
    const { container: _container, ...rest } = out;
    out = rest;
  }
  return { ...out, settingsVersion: SETTINGS_VERSION };
}

/** A form value or stored value as a frame rate; anything else is the default. */
export function toFrameRate(value: unknown): FrameRate {
  const n = Number(value);
  return FRAME_RATES.includes(n as FrameRate) ? (n as FrameRate) : DEFAULT_SETTINGS.frameRate;
}

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...migrateSettings(stored ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
