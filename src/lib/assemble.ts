// Pipeline steps 4–5 as one pure function: the recogniser's segments for every channel, the
// recording's event log (events.jsonl) and the settings → labelled segments, transcript.md,
// transcript.json and meta.json. Node-tested. src/app/pipeline.ts is its one caller and does the
// reading and writing around it; the library can call it again from disk with other settings
// (another "my name") without transcribing again.
import type { Backend } from './asr/engine.ts';
import { attribute, channelIdentity } from './attribution.ts';
import { eventsToEvidence, type AdapterEvent } from './evidence.ts';
import type { Message } from './messages.ts';
import { renderMarkdown, toJson, toTurns, type TranscriptJson } from './transcript.ts';
import type {
  LabelledSegment,
  Recording,
  Segment,
  Settings,
  Source,
  SpeakerInterval,
} from './types.ts';

/** A render gap the recorder padded (ARCHITECTURE § Clock); `Recorder.onBlock` writes it. */
export interface ClockGapEvent {
  type: 'clock-gap';
  /** Wall-clock ms of the detection. */
  at: number;
  /** Sample position of the block that revealed the gap. */
  position: number;
  paddedSamples: number;
}

export type DiagnosticEvent = Extract<Message, { type: 'adapter-diagnostic' }>;

/** One line of events.jsonl: an adapter message as received, or a recorder event. */
export type EventLine = AdapterEvent | DiagnosticEvent | ClockGapEvent;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * events.jsonl text → typed lines. A line that does not parse or does not have the shape its
 * `type` promises is skipped (a crash can truncate the last line), so the log is never fatal.
 */
export function parseEventLog(text: string): EventLine[] {
  const out: EventLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    switch (e['type']) {
      case 'speaker':
        if (
          isNum(e['at']) &&
          isStr(e['id']) &&
          isStr(e['name']) &&
          typeof e['speaking'] === 'boolean' &&
          isStr(e['platform'])
        )
          out.push(e as unknown as AdapterEvent);
        break;
      case 'roster':
        if (
          isNum(e['at']) &&
          Array.isArray(e['names']) &&
          e['names'].every(isStr) &&
          isStr(e['platform'])
        )
          out.push(e as unknown as AdapterEvent);
        break;
      case 'adapter-diagnostic':
        if (isNum(e['at']) && isStr(e['message']) && isStr(e['platform']))
          out.push(e as unknown as DiagnosticEvent);
        break;
      case 'clock-gap':
        if (isNum(e['at']) && isNum(e['position']) && isNum(e['paddedSamples']))
          out.push(e as unknown as ClockGapEvent);
        break;
    }
  }
  return out;
}

export interface AssembleInput {
  recording: Recording;
  settings: Pick<Settings, 'myName' | 'model' | 'backend'>;
  /** Every channel's segments, any order. */
  segments: Segment[];
  /** The whole event log; only speaker and roster lines become evidence. */
  events: EventLine[];
  /** The extension's manifest version, recorded in meta.json. */
  rescribeVersion: string;
  /** Epoch ms of this assembly. Default Date.now(). */
  now?: number;
}

export interface ClockGap {
  /** Recording-relative seconds of the block that revealed the gap. */
  at: number;
  /** Seconds of silence padded into both channel files before it. */
  seconds: number;
}

/** meta.json: when, what was captured, who was there, what transcribed it. */
export interface TranscriptMetaFile {
  version: 1;
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  sources: Source[];
  /** From the platform adapter's roster and speaker events; empty without one. */
  participants: string[];
  model: string;
  backend: Backend;
  container: Recording['container'];
  exportPath?: string;
  levels?: Recording['levels'];
  clockGaps: ClockGap[];
  transcribedAt: number;
  rescribeVersion: string;
}

/** transcript.json: the turns, every segment with its label and evidence, and the intervals. */
export interface TranscriptFile extends TranscriptJson {
  model: string;
  backend: Backend;
  /**
   * The evidence `attribute()` chose from: platform intervals (cleaned, lead applied, see
   * `MEET_LEAD`) and the channel-identity intervals spanning the recording.
   */
  intervals: SpeakerInterval[];
}

export interface Assembled {
  markdown: string;
  json: TranscriptFile;
  meta: TranscriptMetaFile;
  labelled: LabelledSegment[];
}

const DISPLAY_FALLBACK = 'Speaker';

export function assembleTranscript(input: AssembleInput): Assembled {
  const { recording, settings, segments, events } = input;
  const now = input.now ?? Date.now();
  const maxEnd = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const endedAt = recording.endedAt ?? recording.startedAt + Math.ceil(maxEnd * 1000);
  const duration = Math.max(0, (endedAt - recording.startedAt) / 1000, maxEnd);

  const adapterEvents = events.filter(
    (e): e is AdapterEvent => e.type === 'speaker' || e.type === 'roster',
  );
  const platform = eventsToEvidence(adapterEvents, recording.startedAt, endedAt, {
    selfLabel: settings.myName,
  });

  // Layers (DECISIONS § Audio channels): platform events, then channel identity. Channel identity
  // spans the whole recording, so a display segment with no platform interval near it reads as
  // the generic remote speaker and a mic segment always reads as the human.
  const identity: SpeakerInterval[] = [
    channelIdentity('mic', settings.myName, duration),
    channelIdentity('display', DISPLAY_FALLBACK, duration),
  ];
  const intervals = [...platform.intervals, ...identity];
  const labelled = attribute(segments, intervals, {
    fallback: { mic: settings.myName, display: DISPLAY_FALLBACK },
  });
  const turns = toTurns(labelled);
  const meta = {
    title: recording.title,
    startedAt: recording.startedAt,
    participants: platform.participants,
  };

  const clockGaps: ClockGap[] = events
    .filter((e): e is ClockGapEvent => e.type === 'clock-gap')
    .map((g) => ({ at: g.position / 16000, seconds: g.paddedSamples / 16000 }));

  return {
    markdown: renderMarkdown(turns, meta),
    json: {
      ...toJson(turns, labelled, meta),
      model: settings.model,
      backend: settings.backend,
      intervals,
    },
    meta: {
      version: 1,
      id: recording.id,
      title: recording.title,
      startedAt: recording.startedAt,
      endedAt,
      sources: recording.sources,
      participants: platform.participants,
      model: settings.model,
      backend: settings.backend,
      container: recording.container,
      ...(recording.exportPath !== undefined ? { exportPath: recording.exportPath } : {}),
      ...(recording.levels !== undefined ? { levels: recording.levels } : {}),
      clockGaps,
      transcribedAt: now,
      rescribeVersion: input.rescribeVersion,
    },
    labelled,
  };
}
