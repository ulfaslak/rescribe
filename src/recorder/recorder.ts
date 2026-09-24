// The recorder. One instance per recording, app-tab only. Owns the MediaRecorder, the audio graph
// (graph.ts), the AudioWorklet taps and the storage writer; drives the Recording record through
// `recording → recorded | failed` and exports the video on stop (ARCHITECTURE § Pipeline 1–2).
//
// Memory is bounded by what is in flight: one MediaRecorder chunk per second being turned into an
// ArrayBuffer, and one 200 ms PCM block per channel. Everything is transferred to the storage
// worker and written to OPFS immediately (INVARIANTS "on disk within seconds").
import { pcmSeconds } from '../lib/pcm.ts';
import type { ChannelId, Container, Recording, Source } from '../lib/types.ts';
import { ExportError, getExportDirectory, writeExportFile } from '../storage/export.ts';
import { EVENTS_FILE, pcmFileName, removeRecordingDir, videoFileName } from '../storage/opfs.ts';
import {
  getChannelFile,
  getVideoFile,
  listRecordings,
  putRecording,
  updateRecording,
} from '../storage/store.ts';
import { StorageWriter } from '../storage/writer.ts';
import type { Captured } from './capture.ts';
import { stopAll } from './capture.ts';
import { buildGraph, planGraph, TAP_SAMPLE_RATE, type BuiltGraph } from './graph.ts';
import type { TapCommand, TapMessage } from './tap.worklet.ts';

const TIMESLICE_MS = 1000;
/** Chrome's fragmented-MP4 muxer emits a fragment only at a keyframe, and its default keyframe
 * interval is about 5 s (measured 2026-09-24: first media fragment at +10 s). A keyframe per
 * timeslice makes every timeslice a chunk on disk, which is what "on disk within seconds" needs. */
const KEYFRAME_INTERVAL_MS = 1000;
const VIDEO_BPS = 2_500_000;
const AUDIO_BPS = 128_000;
const MIME: Record<Container, string> = {
  mp4: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  webm: 'video/webm;codecs=vp9,opus',
};

export function exportVideoName(container: Container): string {
  return container === 'mp4' ? 'recording.mp4' : 'recording.webm';
}

export interface StartOptions {
  display: Captured;
  mic?: Captured;
  title: string;
  container: Container;
  /** Settings.pathTemplate at start; the export directory is named from it on stop. */
  pathTemplate: string;
  /** Shown on the recording, e.g. that the microphone was unavailable. */
  note?: string;
}

export type RecorderPhase = 'recording' | 'stopping' | 'exporting' | 'done';
export type RecorderListener = (rec: Recording, phase: RecorderPhase) => void;

export class Recorder {
  recording: Recording;
  private readonly listener: RecorderListener;
  private readonly pathTemplate: string;
  private readonly streams: MediaStream[];
  private readonly mixCtx: AudioContext;
  private readonly tapCtx: AudioContext;
  private readonly graph: BuiltGraph;
  private readonly rec: MediaRecorder;
  private readonly writer: StorageWriter;
  private readonly videoFile: string;
  private pending: Promise<void> = Promise.resolve();
  private stopping?: Promise<Recording>;
  private failure?: Error;
  private readonly flushed = new Map<ChannelId, () => void>();

  private constructor(init: {
    recording: Recording;
    listener: RecorderListener;
    pathTemplate: string;
    streams: MediaStream[];
    mixCtx: AudioContext;
    tapCtx: AudioContext;
    graph: BuiltGraph;
    rec: MediaRecorder;
    writer: StorageWriter;
  }) {
    this.recording = init.recording;
    this.listener = init.listener;
    this.pathTemplate = init.pathTemplate;
    this.streams = init.streams;
    this.mixCtx = init.mixCtx;
    this.tapCtx = init.tapCtx;
    this.graph = init.graph;
    this.rec = init.rec;
    this.writer = init.writer;
    this.videoFile = videoFileName(init.recording.container);
  }

  /**
   * Start recording. Resolves once data is flowing to OPFS and the Recording record exists at
   * status `recording`. Throws (with every stream stopped and nothing persisted) when it cannot.
   */
  static async start(opts: StartOptions, listener: RecorderListener): Promise<Recorder> {
    const id = crypto.randomUUID();
    const streams = [opts.display.stream, ...(opts.mic ? [opts.mic.stream] : [])];
    const videoTrack = opts.display.stream.getVideoTracks()[0];
    const tracks = new Map<ChannelId, MediaStreamTrack>();
    const displayAudio = opts.display.stream.getAudioTracks()[0];
    if (displayAudio) tracks.set('display', displayAudio);
    const micAudio = opts.mic?.stream.getAudioTracks()[0];
    if (micAudio) tracks.set('mic', micAudio);
    const channels = [...tracks.keys()];
    const sources: Source[] = [opts.display.source, ...(opts.mic ? [opts.mic.source] : [])];

    let writer: StorageWriter | undefined;
    let mixCtx: AudioContext | undefined;
    let tapCtx: AudioContext | undefined;
    let recorder: Recorder | undefined;
    try {
      if (!videoTrack) throw new Error('The captured stream has no video track.');
      const mime = MIME[opts.container];
      if (!MediaRecorder.isTypeSupported(mime))
        throw new Error(`This browser cannot record ${mime}.`);

      writer = new StorageWriter((err) => recorder?.fail(err));
      await writer.open(id, [
        videoFileName(opts.container),
        ...channels.map(pcmFileName),
        EVENTS_FILE,
      ]);

      mixCtx = new AudioContext();
      tapCtx = new AudioContext({ sampleRate: TAP_SAMPLE_RATE });
      await tapCtx.audioWorklet.addModule(chrome.runtime.getURL('recorder/tap.worklet.js'));
      await Promise.all([mixCtx.resume(), tapCtx.resume()]);
      if (mixCtx.state !== 'running' || tapCtx.state !== 'running')
        throw new Error(
          'Audio is blocked in this tab (autoplay policy); click in the Rescribe tab and try again.',
        );
      if (tapCtx.sampleRate !== TAP_SAMPLE_RATE)
        throw new Error(`Tap context runs at ${tapCtx.sampleRate} Hz, not ${TAP_SAMPLE_RATE}.`);

      // t = 0. Both taps are created in this same task and begin at the next render quantum.
      const startedAt = Date.now();
      const plan = planGraph(channels, opts.display.needsPlayback ? ['display'] : []);
      const graph = buildGraph(plan, mixCtx, tapCtx, tracks);
      const rec = new MediaRecorder(
        new MediaStream([videoTrack, ...graph.mixer.stream.getAudioTracks()]),
        {
          mimeType: mime,
          videoBitsPerSecond: VIDEO_BPS,
          audioBitsPerSecond: AUDIO_BPS,
          videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS,
        } as MediaRecorderOptions,
      );
      const recording: Recording = {
        id,
        startedAt,
        title: opts.title,
        sources,
        status: 'recording',
        container: opts.container,
        ...(opts.note ? { note: opts.note } : {}),
      };
      recorder = new Recorder({
        recording,
        listener,
        pathTemplate: opts.pathTemplate,
        streams,
        mixCtx,
        tapCtx,
        graph,
        rec,
        writer,
      });
      recorder.wire(videoTrack);
      rec.start(TIMESLICE_MS);
      await putRecording(recording);
      listener(recording, 'recording');
      return recorder;
    } catch (err) {
      for (const s of streams) stopAll(s);
      await Promise.allSettled([mixCtx?.close(), tapCtx?.close()]);
      if (writer) {
        await writer.close().catch(() => undefined);
        await removeRecordingDir(id).catch(() => undefined);
      }
      throw err;
    }
  }

  private wire(videoTrack: MediaStreamTrack): void {
    for (const [channel, tap] of this.graph.taps) {
      tap.port.onmessage = (e: MessageEvent<TapMessage>) => {
        if (e.data.type === 'block') this.writer.append(pcmFileName(channel), e.data.pcm);
        else this.flushed.get(channel)?.();
      };
    }
    this.rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.pending = this.pending.then(async () => {
        const buf = await e.data.arrayBuffer();
        this.writer.append(this.videoFile, buf);
      });
    };
    this.rec.onerror = (e) =>
      this.fail(new Error(`MediaRecorder: ${String((e as ErrorEvent).error ?? e)}`));
    // Chrome's "Stop sharing" bar, the shared tab or window closed: same as Stop. The track's
    // `ended` is the normal signal; the MediaRecorder stopping on its own (a track stopped without
    // `ended`, an internal error) is the belt and braces. Both are idempotent through stop().
    videoTrack.addEventListener('ended', () => void this.stop());
    this.rec.addEventListener('stop', () => void this.stop());
  }

  /** A write failed or the recorder errored: stop, and finish as `failed`. */
  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    void this.stop();
  }

  /** Append one JSON line to `events.jsonl` (speaker events; the consumer lands with #3). */
  appendEvent(event: object): void {
    const bytes = new TextEncoder().encode(JSON.stringify(event) + '\n');
    this.writer.append(
      EVENTS_FILE,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }

  /** Stop, finalize and export. Idempotent: every call resolves to the same final record. */
  stop(): Promise<Recording> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<Recording> {
    const endedAt = Date.now();
    this.recording = { ...this.recording, endedAt };
    this.listener(this.recording, 'stopping');
    try {
      if (this.rec.state !== 'inactive') {
        const stopped = new Promise<void>((r) =>
          this.rec.addEventListener('stop', () => r(), { once: true }),
        );
        this.rec.stop();
        await stopped;
      }
      await this.pending;
      await Promise.all(
        [...this.graph.taps].map(
          ([channel, tap]) =>
            new Promise<void>((resolve) => {
              this.flushed.set(channel, resolve);
              tap.port.postMessage({ type: 'flush' } satisfies TapCommand);
            }),
        ),
      );
      for (const n of this.graph.nodes) n.disconnect();
      for (const s of this.streams) stopAll(s);
      await Promise.allSettled([this.mixCtx.close(), this.tapCtx.close()]);
      await this.writer.close();
      if (this.failure) throw this.failure;
      await updateRecording(this.recording.id, { endedAt });
      this.recording = await finalize(this.recording, this.pathTemplate, (rec) =>
        this.listener(rec, 'exporting'),
      );
    } catch (err) {
      for (const s of this.streams) stopAll(s);
      this.recording = await updateRecording(this.recording.id, {
        status: 'failed',
        endedAt,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => ({ ...this.recording, status: 'failed' as const, error: String(err) }));
    }
    this.listener(this.recording, 'done');
    return this.recording;
  }
}

/**
 * Pipeline step 2 for a recording whose files are complete on disk: export the video to the
 * chosen folder and mark `recorded`. An export failure still marks `recorded` (the media is safe
 * in OPFS) with `error` set and `exportPath` unset, so a re-export can retry.
 */
export async function finalize(
  rec: Recording,
  pathTemplate: string,
  onExporting?: (rec: Recording) => void,
): Promise<Recording> {
  const video = await getVideoFile(rec.id, rec.container);
  if (!video || video.size === 0)
    return updateRecording(rec.id, { status: 'failed', error: 'No video reached disk.' });
  onExporting?.(rec);
  try {
    const { dir, path } = await getExportDirectory(rec, pathTemplate);
    await writeExportFile(dir, exportVideoName(rec.container), video.stream());
    return await updateRecording(rec.id, {
      status: 'recorded',
      exportPath: path,
      error: undefined,
    });
  } catch (err) {
    const message = err instanceof ExportError ? err.message : String(err);
    return updateRecording(rec.id, { status: 'recorded', error: `Not exported: ${message}` });
  }
}

/**
 * On app start: a record still at `recording` was interrupted (tab closed, browser crashed). If
 * its video is non-empty it becomes `recorded` and is exported; its end time is taken from the
 * PCM length (sample count is elapsed time). Otherwise it becomes `failed`.
 */
export async function recoverInterrupted(pathTemplate: string): Promise<Recording[]> {
  const out: Recording[] = [];
  for (const rec of await listRecordings()) {
    if (rec.status !== 'recording') continue;
    const video = await getVideoFile(rec.id, rec.container);
    if (!video || video.size === 0) {
      out.push(
        await updateRecording(rec.id, {
          status: 'failed',
          endedAt: rec.startedAt,
          error: 'Interrupted before any video reached disk.',
        }),
      );
      continue;
    }
    let seconds = 0;
    for (const channel of ['mic', 'display'] as const) {
      const f = await getChannelFile(rec.id, channel);
      if (f) seconds = Math.max(seconds, pcmSeconds(f.size));
    }
    const endedAt =
      seconds > 0
        ? rec.startedAt + Math.round(seconds * 1000)
        : Math.max(rec.startedAt, video.lastModified);
    const updated = await updateRecording(rec.id, {
      endedAt,
      note: 'Interrupted: the Rescribe tab closed while recording. Recovered from disk.',
    });
    out.push(await finalize(updated, pathTemplate));
  }
  return out;
}
