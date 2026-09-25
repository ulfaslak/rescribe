// The data model. Everything in src/lib is pure and context-free: no chrome.*, no DOM.
// All times in Segment, Word, SpeakerInterval and Turn are seconds from recording start
// (t = 0 at the first captured sample). Only Recording.startedAt/endedAt/transcribedAt are
// wall-clock epoch ms.
import type { Backend } from './asr/engine.ts';

export type ChannelId = 'mic' | 'display';

export type SourceKind = 'microphone' | 'tab' | 'window' | 'screen';

export interface Source {
  channel: ChannelId;
  kind: SourceKind;
  /** Human-readable, e.g. the tab title or "Built-in Microphone". */
  label?: string;
}

/**
 * `stopped`: the media is complete on disk and nothing has been exported; the recording waits
 * for the human's decision (save, save elsewhere, discard). `recorded`: the export was attempted.
 */
export type RecordingStatus =
  'recording' | 'stopped' | 'recorded' | 'transcribing' | 'done' | 'failed';

export type Container = 'mp4' | 'webm';

export interface Recording {
  id: string;
  startedAt: number;
  endedAt?: number;
  title: string;
  sources: Source[];
  status: RecordingStatus;
  container: Container;
  /**
   * The name of the folder this recording was saved under with "Save as…", when it was not the
   * folder from Settings; its handle lives in IndexedDB `handles` under `export:<id>`
   * (src/storage/handles.ts). Display only: the handle is the truth.
   */
  exportRoot?: string;
  /** Relative path of the export directory under its folder, once the video is in it. */
  exportPath?: string;
  /**
   * Why it failed; or, on a recording that did not fail, why it is not fully exported: a
   * `recorded` one without an export path, or a `done` one whose transcript could not be written
   * next to the video (the artifacts wait in OPFS). Cleared by a successful export.
   */
  error?: string;
  /** Something the human should know that is not a failure (e.g. recovered after an interruption). */
  note?: string;
  /** RMS level of each channel over the whole recording, dBFS. A silent mic sits far below the display. */
  levels?: Partial<Record<ChannelId, number>>;
  /** What transcribed it, set at `done`. */
  model?: string;
  backend?: Backend;
  transcribedAt?: number;
  /** The video and PCM were deleted from OPFS; artifacts and the segments cache stay. */
  mediaDeleted?: boolean;
}

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

/** One stretch of recognised speech on one channel. Output of the ASR engine. */
export interface Segment {
  channel: ChannelId;
  start: number;
  end: number;
  text: string;
  words?: Word[];
}

/** Where a piece of speaker evidence came from. Higher-priority sources win in attribution. */
export type EvidenceSource = 'platform' | 'model' | 'channel';

/** The unit of speaker evidence: "on this channel, this speaker was talking from start to end". */
export interface SpeakerInterval {
  channel: ChannelId;
  speaker: string;
  start: number;
  end: number;
  source: EvidenceSource;
}

export interface LabelledSegment extends Segment {
  speaker: string;
  evidence: EvidenceSource | 'none';
}

/** Consecutive labelled segments by the same speaker, merged for rendering. */
export interface Turn {
  speaker: string;
  start: number;
  end: number;
  text: string;
  segments: LabelledSegment[];
}

/** Frames per second the display is captured at (DECISIONS § Capture: 5 by default). */
export type FrameRate = 5 | 10 | 30;
export const FRAME_RATES: readonly FrameRate[] = [5, 10, 30];

/**
 * Bumped when a stored setting must be read against a new default; `migrateSettings` in
 * lib/settings.ts carries a stored object from each older version to this one.
 */
export const SETTINGS_VERSION = 1;

export interface Settings {
  /** Directory name template under the export folder. Tokens: {date} {time} {title}. */
  pathTemplate: string;
  /** Speaker label for the microphone channel. */
  myName: string;
  /** Video format (DECISIONS § Storage and output: WebM by default, MP4 for QuickTime). */
  container: Container;
  frameRate: FrameRate;
  micByDefault: boolean;
  /** parakeet.js model key. */
  model: string;
  /** Where the speech engine runs (DECISIONS § Speech recognition: WASM by default). */
  backend: Backend;
  /** Run the transcription pipeline as soon as a recording stops. Off: the library's re-run. */
  autoTranscribe: boolean;
  /** The version the stored object was written at; see `SETTINGS_VERSION`. */
  settingsVersion: number;
}

export const DEFAULT_SETTINGS: Settings = {
  pathTemplate: '{date} {time} {title}',
  myName: 'Me',
  container: 'webm',
  frameRate: 5,
  micByDefault: true,
  model: 'parakeet-tdt-0.6b-v3',
  backend: 'wasm',
  autoTranscribe: true,
  settingsVersion: SETTINGS_VERSION,
};
