// Pipeline steps 3–5 for one recording (ARCHITECTURE § Pipeline), app-tab only: each channel's
// PCM from OPFS through the transcribe worker (transcriber.ts), the segments plus the event log
// through assembleTranscript (lib/assemble.ts), the artifacts into OPFS and then next to the
// video, the record through `recorded → transcribing → done | failed`.
//
// Recordings run one at a time and channels one after another: the worker restarts after a
// transcribe failure and rejects every job queued behind it, so nothing else may sit in its queue
// while a channel runs. Each channel's segments are kept as `segments.<channel>.json`, so a re-run
// after a failure on the other channel, or with another "my name", does not transcribe it again.
import { assembleTranscript, parseEventLog } from '../lib/assemble.ts';
import { loadSettings } from '../lib/settings.ts';
import type { ChannelId, Recording, Segment } from '../lib/types.ts';
import { exportArtifacts } from '../storage/export.ts';
import {
  getRecording,
  listRecordings,
  readArtifact,
  readChannelPcm,
  readEventLog,
  segmentsArtifactName,
  updateRecording,
  writeArtifact,
} from '../storage/store.ts';
import { Transcriber, type TranscribeProgress } from './transcriber.ts';

export type PipelinePhase = 'download' | 'load' | 'transcribe' | 'attribute' | 'export';

export interface PipelineProgress {
  phase: PipelinePhase;
  channel?: ChannelId;
  /** 0–1 when known. */
  fraction?: number;
  /** One line for a status readout, e.g. "Transcribing mic · downloading encoder 312/652 MB". */
  message: string;
}

type Listener = (id: string, p: PipelineProgress) => void;

const CHANNELS: ChannelId[] = ['mic', 'display'];
const listeners = new Set<Listener>();
/** Recordings queued or running, by id; each promise settles when the pipeline is done with it. */
const running = new Map<string, Promise<Recording>>();
/** Serialises recordings. Never rejects. */
let chain: Promise<unknown> = Promise.resolve();
/** One worker for the tab, spawned on the first channel, kept (with its model) afterwards. */
let transcriber: Transcriber | undefined;

/** Subscribe to progress for any recording; returns the unsubscribe function. */
export function onPipelineProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while any recording is queued or transcribing (beforeunload, badge). */
export function isPipelineBusy(): boolean {
  return running.size > 0;
}

/**
 * Stages 3–5 for one recording. Resolves with the record at `done` or `failed`; rejects only
 * when the recording does not exist, is still recording, or its record cannot be written.
 * Idempotent per id: a second call while one is queued or running returns that promise.
 * Recordings run one at a time, in call order.
 */
export function transcribeRecording(id: string): Promise<Recording> {
  const existing = running.get(id);
  if (existing) return existing;
  const p: Promise<Recording> = chain
    .then(() => run(id))
    .finally(() => {
      if (running.get(id) === p) running.delete(id);
    });
  chain = p.catch(() => undefined);
  running.set(id, p);
  return p;
}

/**
 * On app start: a recording left at `transcribing` was interrupted (the tab reloaded or closed
 * mid-transcription). It goes back to `recorded` with a note; the caller runs it again.
 */
export async function recoverInterruptedTranscriptions(): Promise<Recording[]> {
  const out: Recording[] = [];
  for (const rec of await listRecordings()) {
    if (rec.status !== 'transcribing') continue;
    out.push(
      await updateRecording(rec.id, {
        status: 'recorded',
        note: appendNote(rec.note, 'Transcription was interrupted by a reload and started again.'),
      }),
    );
  }
  return out;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function appendNote(note: string | undefined, text: string): string {
  if (note?.includes(text)) return note;
  return [note, text].filter(Boolean).join(' ');
}

function emit(id: string, p: PipelineProgress): void {
  for (const listener of listeners) {
    try {
      listener(id, p);
    } catch (err) {
      console.error('[rescribe] pipeline listener', err);
    }
  }
}

const mb = (bytes: number): string => (bytes / 1e6).toFixed(0);

/** The worker's per-job progress → one status line. */
function describe(channel: ChannelId, p: TranscribeProgress): PipelineProgress {
  const prefix = `Transcribing ${channel}`;
  switch (p.phase) {
    case 'download': {
      const file = p.file ? p.file.replace(/^.*\//, '') : 'model';
      return p.total > 0
        ? {
            phase: 'download',
            channel,
            fraction: p.loaded / p.total,
            message: `${prefix} · downloading ${file} ${mb(p.loaded)}/${mb(p.total)} MB`,
          }
        : { phase: 'download', channel, message: `${prefix} · downloading ${file}…` };
    }
    case 'load':
      return { phase: 'load', channel, message: `${prefix} · loading model…` };
    case 'transcribe':
      return p.total > 0
        ? {
            phase: 'transcribe',
            channel,
            fraction: p.loaded / p.total,
            message: `${prefix} ${Math.min(p.loaded + 1, p.total)}/${p.total} regions`,
          }
        : { phase: 'transcribe', channel, fraction: 1, message: `${prefix} · no speech found` };
  }
}

interface CachedSegments {
  model: string;
  backend: string;
  rescribeVersion: string;
  segments: Segment[];
}

async function cachedSegments(
  id: string,
  channel: ChannelId,
  key: Omit<CachedSegments, 'segments'>,
): Promise<Segment[] | undefined> {
  const text = await readArtifact(id, segmentsArtifactName(channel));
  if (!text) return undefined;
  try {
    const c = JSON.parse(text) as Partial<CachedSegments>;
    if (
      c.model === key.model &&
      c.backend === key.backend &&
      c.rescribeVersion === key.rescribeVersion &&
      Array.isArray(c.segments)
    )
      return c.segments;
  } catch {
    // unreadable: transcribe again
  }
  return undefined;
}

async function run(id: string): Promise<Recording> {
  let rec = await getRecording(id);
  if (!rec) throw new Error(`recording ${id} not found`);
  if (rec.status === 'recording') throw new Error('the recording has not stopped');
  const settings = await loadSettings();
  const rescribeVersion = chrome.runtime.getManifest().version;
  const key = { model: settings.model, backend: settings.backend, rescribeVersion };
  // A failed run's message is stale now. A `recorded` record's error says why the video is not
  // exported and stays until an export succeeds.
  rec = await updateRecording(id, {
    status: 'transcribing',
    ...(rec.status === 'failed' ? { error: undefined } : {}),
  });

  // 3. Transcribe, one channel at a time.
  const segments: Segment[] = [];
  for (const channel of CHANNELS) {
    const cached = await cachedSegments(id, channel, key);
    if (cached) {
      segments.push(...cached);
      continue;
    }
    const pcm = await readChannelPcm(id, channel);
    if (!pcm || pcm.length === 0) continue;
    let last: TranscribeProgress['phase'] | undefined;
    let out: Segment[];
    try {
      transcriber ??= new Transcriber();
      out = await transcriber.transcribeChannel(pcm, channel, key, (p) => {
        last = p.phase;
        emit(id, describe(channel, p));
      });
    } catch (err) {
      const stage =
        last === 'transcribe'
          ? 'transcribing'
          : last === 'load'
            ? 'loading the model'
            : last === 'download'
              ? 'downloading the model'
              : 'starting the transcriber';
      return updateRecording(id, {
        status: 'failed',
        error: `Transcription failed on the ${channel} channel while ${stage}: ${message(err)}`,
      });
    }
    try {
      await writeArtifact(
        id,
        segmentsArtifactName(channel),
        JSON.stringify({ ...key, segments: out } satisfies CachedSegments),
      );
    } catch (err) {
      return updateRecording(id, {
        status: 'failed',
        error: `Could not save the ${channel} transcription: ${message(err)}`,
      });
    }
    segments.push(...out);
  }

  // 4–5. Attribute and render from what is on disk: the segments and the event log.
  emit(id, { phase: 'attribute', message: 'Attributing speakers…' });
  const transcribedAt = Date.now();
  try {
    const events = parseEventLog(await readEventLog(id));
    const assembled = assembleTranscript({
      recording: rec,
      settings,
      segments,
      events,
      rescribeVersion,
      now: transcribedAt,
    });
    await writeArtifact(id, 'transcript.md', assembled.markdown);
    await writeArtifact(id, 'transcript.json', JSON.stringify(assembled.json, null, 2));
    await writeArtifact(id, 'meta.json', JSON.stringify(assembled.meta, null, 2));
  } catch (err) {
    return updateRecording(id, {
      status: 'failed',
      error: `Could not write the transcript: ${message(err)}`,
    });
  }

  // Export next to the video, so only where the video already went. Without an export path the
  // artifacts wait in OPFS and "Save now" exports everything at once; `error` keeps saying why.
  let error = rec.error;
  if (rec.exportPath) {
    emit(id, { phase: 'export', message: 'Saving transcript…' });
    try {
      await exportArtifacts(rec, settings.pathTemplate);
      error = undefined;
    } catch (err) {
      error = `Transcript not exported: ${message(err)}`;
    }
  }
  return updateRecording(id, {
    status: 'done',
    model: settings.model,
    backend: settings.backend,
    transcribedAt,
    error,
  });
}
