// The data model. Everything in src/lib is pure and context-free: no chrome.*, no DOM.
// All times in Segment, Word, SpeakerInterval and Turn are seconds from recording start
// (t = 0 at the first captured sample). Only Recording.startedAt/endedAt are wall-clock epoch ms.

export type ChannelId = 'mic' | 'display';

export type SourceKind = 'microphone' | 'tab' | 'window' | 'screen';

export interface Source {
  channel: ChannelId;
  kind: SourceKind;
  /** Human-readable, e.g. the tab title or "Built-in Microphone". */
  label?: string;
}

export type RecordingStatus = 'recording' | 'recorded' | 'transcribing' | 'done' | 'failed';

export type Container = 'mp4' | 'webm';

export interface Recording {
  id: string;
  startedAt: number;
  endedAt?: number;
  title: string;
  sources: Source[];
  status: RecordingStatus;
  container: Container;
  /** Relative path of the export directory under the chosen folder, once exported. */
  exportPath?: string;
  /** Why it failed, or why it is `recorded` without an export path. */
  error?: string;
  /** Something the human should know that is not a failure (e.g. recovered after an interruption). */
  note?: string;
  /** RMS level of each channel over the whole recording, dBFS. A silent mic sits far below the display. */
  levels?: Partial<Record<ChannelId, number>>;
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

export interface Settings {
  /** Directory name template under the export folder. Tokens: {date} {time} {title}. */
  pathTemplate: string;
  /** Speaker label for the microphone channel. */
  myName: string;
  container: Container;
  micByDefault: boolean;
  /** parakeet.js model key. */
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  pathTemplate: '{date} {time} {title}',
  myName: 'Me',
  container: 'mp4',
  micByDefault: true,
  model: 'parakeet-tdt-0.6b-v3',
};
