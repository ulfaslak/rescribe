// The recorder. One instance per recording, app-tab only. Owns the MediaRecorder, the audio graph
// (graph.ts), the AudioWorklet taps and the storage writer; drives the Recording record through
// `recording → stopped | failed` (ARCHITECTURE § Pipeline 1–2). The export is not its job: a
// `stopped` recording waits for the human's decision (app/decide.ts), and `finalize` below is
// what that decision, a library row or the crash recovery calls.
//
// Memory is bounded by what is in flight: one MediaRecorder chunk per second being turned into an
// ArrayBuffer, and one 200 ms PCM block per channel. Everything is transferred to the storage
// worker and written to OPFS immediately (INVARIANTS "on disk within seconds").
import { pcmSeconds, PCM_SAMPLE_RATE } from '../lib/pcm.ts';
import type { ChannelId, Container, FrameRate, Recording, Source } from '../lib/types.ts';
import {
  ExportError,
  exportVideoData,
  exportVideoName,
  getExportDirectory,
  writeExportFile,
} from '../storage/export.ts';
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
import { GapDetector } from './gap.ts';
import { buildGraph, planGraph, TAP_SAMPLE_RATE, type BuiltGraph } from './graph.ts';
import type { TapCommand, TapMessage } from './tap.worklet.ts';

const TIMESLICE_MS = 1000;
/** "On disk within seconds" (INVARIANTS) needs a chunk per timeslice. Chrome's WebM muxer emits
 * one whatever the keyframe interval, so keyframes can be sparse (a keyframe of a static screen
 * costs as much as tens of its delta frames). Chrome's fragmented-MP4 muxer emits a fragment only
 * at a keyframe, and its default keyframe interval is about 5 s (measured 2026-09-24: first media
 * fragment at +10 s), so MP4 needs a keyframe per timeslice. */
const KEYFRAME_INTERVAL_MS: Record<Container, number> = { webm: 10_000, mp4: 1000 };
/** Video bitrate caps (DECISIONS § Storage and output). AV1 at 300 kbit/s, 1080p, 5 fps kept a
 * Meet call's shared screen legible and the faces clean at about 50 MB/h (2026-09-25, #27); the
 * higher frame rates scale the cap for their extra frames. The MP4 option keeps H.264 at the cap
 * it always had: it exists for players, not for size. */
const VIDEO_BPS: Record<Container, Record<FrameRate, number>> = {
  webm: { 5: 300_000, 10: 450_000, 30: 900_000 },
  mp4: { 5: 2_500_000, 10: 2_500_000, 30: 2_500_000 },
};
/** The mix is mono speech (graph.ts): Opus is transparent for it at 32 kbit/s; AAC-LC needs 64. */
const AUDIO_BPS: Record<Container, number> = { webm: 32_000, mp4: 64_000 };
/** MIME candidates per container, best first. WebM: AV1 (Chromium 153 and Brave 152 record it,
 * 2026-09-25), else VP9 with a note on the recording. */
const MIME: Record<Container, string[]> = {
  webm: ['video/webm;codecs=av1,opus', 'video/webm;codecs=vp9,opus'],
  mp4: ['video/mp4;codecs=avc1.42E01E,mp4a.40.2'],
};
const CODEC_FALLBACK_NOTE = 'No AV1 encoder in this browser; recorded VP9 (a larger file).';
/** Deadlines on the storage worker and the taps, so a dead worker or a stuck render thread ends
 * in a `failed` or `recorded`-with-note outcome instead of a hang. */
const OPEN_DEADLINE_MS = 5000;
const CLOSE_DEADLINE_MS = 5000;
const FLUSH_DEADLINE_MS = 2000;
const RECORDER_STOP_DEADLINE_MS = 5000;
/** Render-gap padding (ARCHITECTURE § Clock, gap.ts). */
const GAP = { sampleRate: PCM_SAMPLE_RATE, thresholdMs: 250, windowMs: 1000, maxPadMs: 600_000 };

export { exportVideoName };

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} (after ${ms} ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface StartOptions {
  display: Captured;
  mic?: Captured;
  title: string;
  container: Container;
  /** The rate the display was captured at (capture.ts); sets the video bitrate cap. */
  frameRate: FrameRate;
  /** Shown on the recording, e.g. that the microphone was unavailable. */
  note?: string;
}

/** `stopped` is the last phase: the record is at `stopped` (media complete on disk) or `failed`. */
export type RecorderPhase = 'recording' | 'stopping' | 'stopped';
export type RecorderListener = (rec: Recording, phase: RecorderPhase) => void;

interface Level {
  sumSquares: number;
  count: number;
}

export class Recorder {
  recording: Recording;
  private readonly listener: RecorderListener;
  private readonly streams: MediaStream[];
  private readonly mixCtx: AudioContext;
  private readonly tapCtx: AudioContext;
  private readonly graph: BuiltGraph;
  private readonly rec: MediaRecorder;
  private readonly writer: StorageWriter;
  private readonly videoFile: string;
  /** performance.now() when the taps were created; the monotonic twin of `recording.startedAt`. */
  private readonly startedPerf: number;
  private readonly gaps = new GapDetector(GAP);
  private gapCount = 0;
  private readonly levels = new Map<ChannelId, Level>();
  private pending: Promise<void> = Promise.resolve();
  private stopping?: Promise<Recording>;
  private failure?: Error;
  private readonly flushed = new Map<ChannelId, () => void>();

  private constructor(init: {
    recording: Recording;
    listener: RecorderListener;
    streams: MediaStream[];
    mixCtx: AudioContext;
    tapCtx: AudioContext;
    graph: BuiltGraph;
    rec: MediaRecorder;
    writer: StorageWriter;
    startedPerf: number;
  }) {
    this.recording = init.recording;
    this.listener = init.listener;
    this.streams = init.streams;
    this.mixCtx = init.mixCtx;
    this.tapCtx = init.tapCtx;
    this.graph = init.graph;
    this.rec = init.rec;
    this.writer = init.writer;
    this.startedPerf = init.startedPerf;
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
    let persisted = false;
    try {
      if (!videoTrack) throw new Error('The captured stream has no video track.');
      const mime = MIME[opts.container].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime)
        throw new Error(`This browser cannot record ${MIME[opts.container].join(' or ')}.`);
      const note = [opts.note, mime === MIME[opts.container][0] ? '' : CODEC_FALLBACK_NOTE]
        .filter(Boolean)
        .join(' ');

      // Until the recorder exists, a worker failure rejects open() (StorageWriter.fail).
      writer = new StorageWriter((err) => recorder?.fail(err));
      await withDeadline(
        writer.open(id, [videoFileName(opts.container), ...channels.map(pcmFileName), EVENTS_FILE]),
        OPEN_DEADLINE_MS,
        'The storage worker did not open the recording files',
      );

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
      const startedPerf = performance.now();
      const plan = planGraph(channels, opts.display.needsPlayback ? ['display'] : []);
      const graph = buildGraph(plan, mixCtx, tapCtx, tracks);
      const rec = new MediaRecorder(
        new MediaStream([videoTrack, ...graph.mixer.stream.getAudioTracks()]),
        {
          mimeType: mime,
          videoBitsPerSecond: VIDEO_BPS[opts.container][opts.frameRate],
          audioBitsPerSecond: AUDIO_BPS[opts.container],
          videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS[opts.container],
        } as MediaRecorderOptions,
      );
      const recording: Recording = {
        id,
        startedAt,
        title: opts.title,
        sources,
        status: 'recording',
        container: opts.container,
        ...(note ? { note } : {}),
      };
      // The record exists before anything can call stop(): the track and MediaRecorder listeners
      // are attached in wire(), and rec.start() follows in the same task, so no stop can race
      // the record into "not found".
      await putRecording(recording);
      persisted = true;
      recorder = new Recorder({
        recording,
        listener,
        streams,
        mixCtx,
        tapCtx,
        graph,
        rec,
        writer,
        startedPerf,
      });
      recorder.wire(videoTrack);
      rec.start(TIMESLICE_MS);
      listener(recording, 'recording');
      return recorder;
    } catch (err) {
      for (const s of streams) stopAll(s);
      await Promise.allSettled([mixCtx?.close(), tapCtx?.close()]);
      if (writer) {
        await withDeadline(writer.close(), CLOSE_DEADLINE_MS, 'close').catch(() => undefined);
        writer.terminate();
        await removeRecordingDir(id).catch(() => undefined);
      }
      if (persisted)
        await updateRecording(id, {
          status: 'failed',
          endedAt: Date.now(),
          error: message(err),
        }).catch(() => undefined);
      throw err;
    }
  }

  private wire(videoTrack: MediaStreamTrack): void {
    for (const [channel, tap] of this.graph.taps) {
      this.levels.set(channel, { sumSquares: 0, count: 0 });
      tap.port.onmessage = (e: MessageEvent<TapMessage>) => {
        if (e.data.type === 'block') this.onBlock(channel, e.data.pcm, e.data.position);
        else this.flushed.get(channel)?.();
      };
    }
    this.rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      // Each chunk is caught on its own: one failed arrayBuffer() must not skip every later chunk.
      this.pending = this.pending
        .then(() => e.data.arrayBuffer())
        .then((buf) => this.writer.append(this.videoFile, buf))
        .catch((err: unknown) => this.fail(new Error(`Video chunk lost: ${message(err)}`)));
    };
    this.rec.onerror = (e) =>
      this.fail(new Error(`MediaRecorder: ${String((e as ErrorEvent).error ?? e)}`));
    // Chrome's "Stop sharing" bar, the shared tab or window closed: same as Stop. The track's
    // `ended` is the normal signal; the MediaRecorder stopping on its own (a track stopped without
    // `ended`, an internal error) is the belt and braces. Both are idempotent through stop().
    videoTrack.addEventListener('ended', () => void this.stop());
    this.rec.addEventListener('stop', () => void this.stop());
  }

  /** One 200 ms block from a tap: pad render gaps, keep the level, write it. */
  private onBlock(channel: ChannelId, pcm: ArrayBuffer, position: number): void {
    const samples = new Int16Array(pcm);
    const pad = this.gaps.observe(performance.now() - this.startedPerf, position, samples.length);
    if (pad > 0) {
      this.gapCount++;
      for (const ch of this.graph.taps.keys())
        this.writer.append(pcmFileName(ch), new ArrayBuffer(pad * 2));
      this.appendEvent({ type: 'clock-gap', at: Date.now(), position, paddedSamples: pad });
    }
    const level = this.levels.get(channel);
    if (level) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] ?? 0) / 32768;
        sum += v * v;
      }
      level.sumSquares += sum;
      level.count += samples.length;
    }
    this.writer.append(pcmFileName(channel), pcm);
  }

  private levelsDb(): Recording['levels'] {
    const out: Partial<Record<ChannelId, number>> = {};
    for (const [ch, l] of this.levels) {
      if (l.count === 0) continue;
      const rms = Math.sqrt(l.sumSquares / l.count);
      out[ch] = Math.max(-120, Math.round(20 * Math.log10(rms || 1e-6) * 10) / 10);
    }
    return out;
  }

  /** A write failed or the recorder errored: stop, and finish as `failed`. */
  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    void this.stop();
  }

  /**
   * Append prose to the recording's note, in memory (so stop keeps it) and in the stored record
   * (so a crash keeps it): a platform adapter's diagnostic, say. The same text is added once.
   */
  addNote(text: string): void {
    const current = this.recording.note ?? '';
    if (current.includes(text)) return;
    const note = [current, text].filter(Boolean).join(' ');
    this.recording = { ...this.recording, note };
    void updateRecording(this.recording.id, { note }).catch(() => undefined);
  }

  /**
   * Append one JSON line to `events.jsonl`: an adapter message as received (app.ts forwards
   * speaker, roster and adapter-diagnostic messages while recording) or a recorder event
   * (clock-gap). The pipeline reads the file back through `parseEventLog` (lib/assemble.ts).
   */
  appendEvent(event: object): void {
    const bytes = new TextEncoder().encode(JSON.stringify(event) + '\n');
    this.writer.append(
      EVENTS_FILE,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }

  /**
   * Stop: drain, release, close the files, mark `stopped` (or `failed`). Nothing is exported;
   * that is the decision's job. Idempotent: every call resolves to the same final record.
   */
  stop(): Promise<Recording> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<Recording> {
    const endedAt = Date.now();
    this.recording = { ...this.recording, endedAt };
    this.listener(this.recording, 'stopping');
    const notes: string[] = [];
    let failure = this.failure;

    // 1. Drain: the recorder's last chunk, the chunk chain, the taps' partial blocks.
    try {
      if (this.rec.state !== 'inactive') {
        const stopped = new Promise<void>((r) =>
          this.rec.addEventListener('stop', () => r(), { once: true }),
        );
        this.rec.stop();
        await withDeadline(stopped, RECORDER_STOP_DEADLINE_MS, 'MediaRecorder did not stop');
      }
      await this.pending;
      await withDeadline(
        Promise.all(
          [...this.graph.taps].map(
            ([channel, tap]) =>
              new Promise<void>((resolve) => {
                this.flushed.set(channel, resolve);
                tap.port.postMessage({ type: 'flush' } satisfies TapCommand);
              }),
          ),
        ),
        FLUSH_DEADLINE_MS,
        'The audio taps did not flush',
      );
    } catch (err) {
      // A recorder that does not stop is a failure; taps that do not flush lose < 200 ms.
      if (String(message(err)).startsWith('The audio taps')) notes.push(message(err));
      else failure ??= err instanceof Error ? err : new Error(String(err));
    }

    // 2. Release everything, whatever happened above. Sync access handles must not stay open.
    for (const n of this.graph.nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    for (const s of this.streams) stopAll(s);
    await Promise.allSettled([this.mixCtx.close(), this.tapCtx.close()]);
    try {
      await withDeadline(
        this.writer.close(),
        CLOSE_DEADLINE_MS,
        'The storage worker did not close',
      );
    } catch (err) {
      // Every write was flushed as it happened, so the files are whole up to the last append.
      if (!failure) notes.push(`${message(err)}; the files were flushed per write.`);
    }
    this.writer.terminate();
    failure ??= this.failure;

    // 3. Record the outcome.
    try {
      if (failure) throw failure;
      if (this.gapCount > 0)
        notes.push(
          `${this.gapCount} render gap${this.gapCount > 1 ? 's' : ''} padded with silence (${pcmSeconds(this.gaps.paddedFrames * 2).toFixed(1)} s).`,
        );
      const note = [this.recording.note, ...notes].filter(Boolean).join(' ');
      this.recording = await updateRecording(this.recording.id, {
        status: 'stopped',
        endedAt,
        levels: this.levelsDb(),
        ...(note ? { note } : {}),
      });
    } catch (err) {
      this.recording = await updateRecording(this.recording.id, {
        status: 'failed',
        endedAt,
        error: message(err),
      }).catch(() => ({ ...this.recording, status: 'failed' as const, error: message(err) }));
    }
    this.listener(this.recording, 'stopped');
    return this.recording;
  }
}

/**
 * Pipeline step 2 for a recording whose files are complete on disk: export the video to its
 * folder (`rootFor`: the one from Settings, or its own after "Save as…") and mark `recorded` (a
 * `done` recording, re-exported from "Save now", stays `done`). An export failure still marks
 * `recorded` (the media is safe in OPFS) with `error` set and `exportPath` unset; the list then
 * offers "Save now", which runs this again from a click (so the folder permission can be
 * re-requested) and then `exportArtifacts`. Called by the decision (app/decide.ts), the library
 * and the crash recovery below; never by the recorder.
 */
export async function finalize(
  rec: Recording,
  pathTemplate: string,
  onExporting?: (rec: Recording) => void,
): Promise<Recording> {
  const video = await getVideoFile(rec.id, rec.container);
  if (!video || video.size === 0)
    return updateRecording(rec.id, { status: 'failed', error: 'No video reached disk.' });
  // A `done` or `failed` recording saved again from the library keeps its status; a failed one
  // also keeps its `error`, which is why it failed, not an export message.
  const status = rec.status === 'done' || rec.status === 'failed' ? rec.status : 'recorded';
  const keepError = rec.status === 'failed';
  onExporting?.(rec);
  try {
    const { dir, path } = await getExportDirectory(rec, pathTemplate);
    await writeExportFile(dir, exportVideoName(rec.container), await exportVideoData(video, rec));
    return await updateRecording(rec.id, {
      status,
      exportPath: path,
      ...(keepError ? {} : { error: undefined }),
    });
  } catch (err) {
    const msg = err instanceof ExportError ? err.message : String(err);
    return updateRecording(rec.id, {
      status,
      ...(keepError ? {} : { error: `Not exported: ${msg}` }),
    });
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
      note: [rec.note, 'Interrupted: the Rescribe tab closed while recording. Recovered from disk.']
        .filter(Boolean)
        .join(' '),
    });
    out.push(await finalize(updated, pathTemplate));
  }
  return out;
}
