// Transcription progress as the human sees it (issue #31): the job's steps in order, which one
// runs, how far it is, how far the whole job is, and a rough time left. Pure. The pipeline
// (src/app/pipeline.ts) plans the steps from what is on disk and feeds a ProgressTracker with
// what the transcribe worker reports; the views (the library row, the processing tab, the Record
// section's line, the start dialog) render the PipelineProgress it produces and never see a
// channel id or a region count: the microphone is the human, the display is the call.
//
// The order is the pipeline's (DECISIONS § Speech recognition: one channel after another), and the
// plan is complete from the first event, so the step count never changes while the human watches.
import { formatDuration } from './format.ts';
import type { ChannelId } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';

/** `queued`: the record was just marked `transcribing`; `done`: its final status is written. */
export type PipelinePhase =
  'queued' | 'download' | 'load' | 'transcribe' | 'attribute' | 'export' | 'done';

export type StepKind = 'model' | 'channel' | 'attribute' | 'export';
export type StepState = 'pending' | 'running' | 'done';

export interface PipelineStep {
  kind: StepKind;
  /** The channel a `channel` step transcribes. Data for the pipeline; the views show `label`. */
  channel?: ChannelId;
  /** What the human reads: "Speech model", "Your microphone", "The call", "Who said what"… */
  label: string;
  state: StepState;
  /** 0–1 for the running step when known; absent while it cannot be measured. */
  fraction?: number;
  /** One short phrase under the step: "120 of 650 MB", "at 18:12 of 35:10", "kept from the last run". */
  detail?: string;
  /** A channel whose recogniser output was kept from an earlier run: done before the job began. */
  cached?: true;
}

export interface PipelineProgress {
  phase: PipelinePhase;
  channel?: ChannelId;
  /** The running step's fraction, when known. */
  fraction?: number;
  /** The headline: "Transcribing the call", "Downloading the speech model", "Transcribed."… */
  message: string;
  /** The whole job, in order; empty while queued (the plan is made when the run starts). */
  steps: PipelineStep[];
  /** 0–1 across the whole job, each step weighted by its usual cost. */
  overall: number;
  /** Epoch ms when the run began; absent while queued. */
  startedAt?: number;
  /** Rough seconds left, only once the job's own pace can be measured. */
  remainingS?: number;
}

/** What a channel's job reports: the transcribe worker's progress without its envelope. */
export interface ChannelReport {
  phase: 'download' | 'load' | 'transcribe';
  /** Bytes of `file` while downloading; regions done while transcribing. */
  loaded: number;
  total: number;
  file?: string;
  /** Transcribing: where in the recording the region about to be recognised starts, seconds. */
  positionS?: number;
  /** Transcribing: where the channel's audio ends, recording-relative seconds. */
  lengthS?: number;
  /** Transcribing: voiced seconds recognised so far, and in the whole channel. */
  voicedDoneS?: number;
  voicedTotalS?: number;
}

export interface PlanInput {
  /** The channels with audio on disk, in the pipeline's order, and whether each is already cached. */
  channels: { channel: ChannelId; cached: boolean }[];
  /** The speech model must be fetched or loaded before the first channel that is transcribed. */
  model: boolean;
  /** The transcript files will be written next to the video (it has an export path). */
  exportFiles: boolean;
  /** Settings "my name": how the microphone channel is named. */
  myName: string;
}

const CACHED_DETAIL = 'kept from the last run';

/** The usual share of a job's time; a cached channel costs nothing. */
const WEIGHT: Record<StepKind, number> = { model: 0.3, channel: 1, attribute: 0.05, export: 0.05 };

/** Time left is shown only once the running channel has this much wall time behind it. */
const RATE_MIN_MS = 5000;

export function stepWeight(step: PipelineStep): number {
  return step.cached ? 0 : WEIGHT[step.kind];
}

/** The microphone is the human, by the name Settings gives them; the display is the call. */
function channelPhrase(channel: ChannelId, myName: string): { label: string; inSentence: string } {
  if (channel === 'display') return { label: 'The call', inSentence: 'the call' };
  const name = myName.trim();
  if (!name || name === DEFAULT_SETTINGS.myName)
    return { label: 'Your microphone', inSentence: 'your microphone' };
  const phrase = `${name}’s microphone`;
  return { label: phrase, inSentence: phrase };
}

export function channelLabel(channel: ChannelId, myName: string): string {
  return channelPhrase(channel, myName).label;
}

export function planSteps(input: PlanInput): PipelineStep[] {
  const steps: PipelineStep[] = [];
  if (input.model && input.channels.some((c) => !c.cached))
    steps.push({ kind: 'model', label: 'Speech model', state: 'pending' });
  for (const { channel, cached } of input.channels)
    steps.push({
      kind: 'channel',
      channel,
      label: channelLabel(channel, input.myName),
      state: cached ? 'done' : 'pending',
      ...(cached ? { cached: true, detail: CACHED_DETAIL } : {}),
    });
  steps.push({ kind: 'attribute', label: 'Who said what', state: 'pending' });
  if (input.exportFiles)
    steps.push({ kind: 'export', label: 'Transcript files', state: 'pending' });
  return steps;
}

export function overallFraction(steps: PipelineStep[]): number {
  let total = 0;
  let done = 0;
  for (const s of steps) {
    const w = stepWeight(s);
    total += w;
    if (s.state === 'done') done += w;
    else if (s.state === 'running') done += w * Math.min(1, Math.max(0, s.fraction ?? 0));
  }
  return total > 0 ? Math.min(1, done / total) : 0;
}

/** The index of the running step, or -1. */
export function runningIndex(steps: PipelineStep[]): number {
  return steps.findIndex((s) => s.state === 'running');
}

const mb = (bytes: number): string => (bytes / 1e6).toFixed(0);

function headline(phase: PipelinePhase, step: PipelineStep | undefined, myName: string): string {
  switch (phase) {
    case 'queued':
      return 'Waiting to transcribe…';
    case 'download':
      return 'Downloading the speech model';
    case 'load':
      return 'Loading the speech model';
    case 'transcribe':
      return step?.channel
        ? `Transcribing ${channelPhrase(step.channel, myName).inSentence}`
        : 'Transcribing';
    case 'attribute':
      return 'Working out who said what';
    case 'export':
      return 'Writing the transcript files';
    case 'done':
      return 'Transcribed.';
  }
}

/**
 * One job's progress, driven by the pipeline. `now` is passed in (epoch ms) so the pace and the
 * time left are testable.
 */
export class ProgressTracker {
  readonly steps: PipelineStep[];
  readonly startedAt: number;
  private readonly myName: string;
  /** Bytes per model file seen so far; the download is one bar over all of them. */
  private readonly downloads = new Map<string, { loaded: number; total: number }>();
  /** When the running channel's recognition began (its first region), and where it is. */
  private pace: { startedAt: number; doneS: number; totalS: number } | undefined;
  /** The last finished channel's pace: voiced seconds recognised per wall second, and its size. */
  private lastPace: { rate: number; totalS: number } | undefined;

  constructor(input: PlanInput, startedAt: number) {
    this.steps = planSteps(input);
    this.startedAt = startedAt;
    this.myName = input.myName;
  }

  private stepFor(channel: ChannelId): PipelineStep | undefined {
    return this.steps.find((s) => s.kind === 'channel' && s.channel === channel);
  }

  /** The model step ahead of `channel`'s, made on the spot when the plan did not expect one. */
  private modelStepBefore(channel: ChannelId): PipelineStep {
    const existing = this.steps.find((s) => s.kind === 'model');
    if (existing) return existing;
    const step: PipelineStep = { kind: 'model', label: 'Speech model', state: 'pending' };
    const at = this.steps.findIndex((s) => s.kind === 'channel' && s.channel === channel);
    this.steps.splice(at < 0 ? 0 : at, 0, step);
    return step;
  }

  /**
   * `channel`'s job is about to be posted: its step runs from here (reading the audio and finding
   * the speech in it take a while before the first region is reported), without a share yet.
   */
  startChannel(channel: ChannelId): void {
    const step = this.stepFor(channel);
    if (!step) return;
    step.state = 'running';
    delete step.fraction;
    delete step.detail;
  }

  /** The worker's progress for `channel`'s job. Returns the phase the job is in. */
  report(channel: ChannelId, r: ChannelReport, now: number): PipelinePhase {
    const step = this.stepFor(channel);
    if (!step) return r.phase;
    if (r.phase === 'download' || r.phase === 'load') {
      // The model is what runs now; the channel waits behind it.
      const model = this.modelStepBefore(channel);
      model.state = 'running';
      if (step.state === 'running') step.state = 'pending';
      if (r.phase === 'download') {
        if (r.file && r.total > 0) this.downloads.set(r.file, { loaded: r.loaded, total: r.total });
        let loaded = 0;
        let total = 0;
        for (const d of this.downloads.values()) {
          loaded += d.loaded;
          total += d.total;
        }
        if (total > 0) {
          model.fraction = Math.min(1, loaded / total);
          model.detail = `${mb(loaded)} of ${mb(total)} MB`;
        } else {
          delete model.fraction;
          delete model.detail;
        }
      } else {
        // The bytes are all here; the share stays full so the job never moves backwards.
        model.fraction = 1;
        model.detail = 'loading';
      }
      return r.phase;
    }
    // Recognising: the model, if it was a step, is in place.
    const model = this.steps.find((s) => s.kind === 'model');
    if (model && model.state !== 'done') {
      model.state = 'done';
      delete model.fraction;
      delete model.detail;
    }
    for (const s of this.steps)
      if (s.kind === 'channel' && s.state === 'running' && s !== step) s.state = 'done';
    step.state = 'running';
    if (r.total <= 0) {
      step.fraction = 1;
      step.detail = 'no speech found';
      return r.phase;
    }
    const finished = r.loaded >= r.total;
    step.fraction = finished
      ? 1
      : r.voicedTotalS && r.voicedTotalS > 0 && r.voicedDoneS !== undefined
        ? Math.min(1, r.voicedDoneS / r.voicedTotalS)
        : r.loaded / r.total;
    step.detail =
      !finished && r.positionS !== undefined && r.lengthS !== undefined
        ? `at ${formatDuration(r.positionS * 1000)} of ${formatDuration(r.lengthS * 1000)}`
        : undefined;
    if (r.voicedTotalS !== undefined && r.voicedDoneS !== undefined) {
      this.pace ??= { startedAt: now, doneS: 0, totalS: r.voicedTotalS };
      this.pace.doneS = r.voicedDoneS;
      this.pace.totalS = r.voicedTotalS;
    }
    return r.phase;
  }

  /** `channel`'s job finished: its step is done and its pace is kept for the ones behind it. */
  finishChannel(channel: ChannelId, now: number): void {
    const step = this.stepFor(channel);
    if (!step) return;
    step.state = 'done';
    delete step.fraction;
    delete step.detail;
    if (this.pace) {
      const rate = this.rate(now);
      if (rate) this.lastPace = { rate, totalS: this.pace.totalS };
      this.pace = undefined;
    }
  }

  /** Steps 4 and 5: everything ahead is done, nothing behind has started. */
  begin(kind: 'attribute' | 'export'): void {
    const at = this.steps.findIndex((s) => s.kind === kind);
    if (at < 0) return;
    this.steps.forEach((s, i) => {
      if (i < at) {
        s.state = 'done';
        delete s.fraction;
        if (!s.cached) delete s.detail;
      } else if (i === at) s.state = 'running';
    });
  }

  /** Every step done, for the final snapshot. */
  finish(): void {
    for (const s of this.steps) {
      s.state = 'done';
      delete s.fraction;
      if (!s.cached) delete s.detail;
    }
  }

  /** Voiced seconds recognised per wall second on the running channel, once there is enough to go on. */
  private rate(now: number): number | undefined {
    if (!this.pace || this.pace.doneS <= 0) return undefined;
    const elapsedMs = now - this.pace.startedAt;
    if (elapsedMs < RATE_MIN_MS) return undefined;
    return this.pace.doneS / (elapsedMs / 1000);
  }

  /**
   * Seconds left, from this job's own pace: the running channel's, or the last finished one's
   * until the running one has shown its own. Nothing before a channel has been recognised for a
   * while (a model download says nothing about the recognition to come), and nothing for the
   * steps after the channels (they take seconds).
   */
  remainingS(now: number): number | undefined {
    const rate = this.rate(now) ?? this.lastPace?.rate;
    const totalS = this.pace?.totalS ?? this.lastPace?.totalS;
    if (!rate || totalS === undefined) return undefined;
    let left = this.pace ? Math.max(0, this.pace.totalS - this.pace.doneS) : 0;
    for (const s of this.steps) if (s.kind === 'channel' && s.state === 'pending') left += totalS;
    return Math.round(left / rate);
  }

  snapshot(phase: PipelinePhase, now: number, message?: string): PipelineProgress {
    const i = runningIndex(this.steps);
    const step = i >= 0 ? this.steps[i] : undefined;
    const channel = step?.kind === 'channel' ? step.channel : undefined;
    const remainingS = phase === 'transcribe' ? this.remainingS(now) : undefined;
    return {
      phase,
      ...(channel ? { channel } : {}),
      ...(step?.fraction !== undefined ? { fraction: step.fraction } : {}),
      message: message ?? headline(phase, step, this.myName),
      steps: this.steps.map((s) => ({ ...s })),
      overall: phase === 'done' ? 1 : overallFraction(this.steps),
      startedAt: this.startedAt,
      ...(remainingS !== undefined ? { remainingS } : {}),
    };
  }
}

/** "step 3 of 5", or undefined while nothing runs. */
export function stepOf(p: PipelineProgress): { index: number; count: number } | undefined {
  const i = runningIndex(p.steps);
  return i >= 0 ? { index: i + 1, count: p.steps.length } : undefined;
}

/** "under a minute left", "about 3 min left", "about 1 h 20 min left". */
export function formatRemaining(s: number): string {
  if (s < 60) return 'under a minute left';
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `about ${h} h ${m} min left` : `about ${h} h left`;
}

/**
 * One line for a status readout: the headline, the step, and how far ("Transcribing the call ·
 * step 3 of 5 · 34% overall"; a download shows its bytes instead of a share).
 */
export function summaryLine(p: PipelineProgress): string {
  const parts = [p.message];
  const at = stepOf(p);
  if (at) {
    parts.push(`step ${at.index} of ${at.count}`);
    const step = p.steps[at.index - 1];
    if (step?.kind === 'model' && step.detail) parts.push(step.detail);
    else parts.push(`${Math.round(p.overall * 100)}% overall`);
  }
  return parts.join(' · ');
}
