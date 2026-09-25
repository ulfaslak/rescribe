// Pipeline steps 3–5 for one recording (ARCHITECTURE § Pipeline), app-tab only: each channel's
// PCM from OPFS through the transcribe worker (transcriber.ts), the segments plus the event log
// through assembleTranscript (lib/assemble.ts), the artifacts into OPFS and then next to the
// video, the record through `recorded → transcribing → done | failed`.
//
// Recordings run one at a time and channels one after another: the worker restarts after a
// transcribe failure and rejects every job queued behind it, so nothing else may sit in its queue
// while a channel runs. The record says `transcribing` from the moment it is queued, so what the
// library reads is what is happening (a queued recording lost to a reload is found at
// `transcribing` on startup and run again once). Each channel's segments are kept as
// `segments.<channel>.json`, so a re-run after a failure on the other channel, with another
// "my name", or after the media was deleted, does not transcribe it again.
//
// Progress goes out as a step plan (lib/progress.ts): the steps of the job in order, which one
// runs and how far, the whole job's share and a rough time left, in the human's words. The plan
// is made before the first step from what is on disk, so it is complete from the first event.
import { assembleTranscript, parseEventLog } from '../lib/assemble.ts';
import { channelPhrase, ProgressTracker, type PipelineProgress } from '../lib/progress.ts';
import { loadSettings } from '../lib/settings.ts';
import type { ChannelId, Recording, Segment } from '../lib/types.ts';
import { exportArtifacts, ExportError } from '../storage/export.ts';
import {
  getChannelFile,
  getRecording,
  getVideoFile,
  listRecordings,
  readArtifact,
  readChannelPcm,
  readEventLog,
  segmentsArtifactName,
  updateRecording,
  writeArtifact,
} from '../storage/store.ts';
import { Transcriber, type TranscribeProgress } from './transcriber.ts';

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

/** True while this recording is queued or transcribing (the library must not delete it then). */
export function isTranscribing(id: string): boolean {
  return running.has(id);
}

/**
 * Stages 3–5 for one recording. Resolves with the record at `done` or `failed`; rejects only
 * when the recording does not exist, is still recording, or its record cannot be written.
 * Idempotent per id: a second call while one is queued or running returns that promise.
 * Recordings run one at a time, in call order; the record is marked `transcribing` at once.
 */
export function transcribeRecording(id: string): Promise<Recording> {
  const existing = running.get(id);
  if (existing) return existing;
  const previous = chain;
  const p: Promise<Recording> = enqueue(id, previous).finally(() => {
    if (running.get(id) === p) running.delete(id);
  });
  chain = p.catch(() => undefined);
  running.set(id, p);
  return p;
}

/**
 * On app start: a recording left at `transcribing` was interrupted (the tab reloaded or closed
 * while it was queued or running). It goes back to `recorded` with a note; the caller runs it
 * again.
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

/** A channel with audio on disk: a step of the plan. */
async function hasAudio(id: string, channel: ChannelId): Promise<boolean> {
  const file = await getChannelFile(id, channel);
  return file !== undefined && file.size > 0;
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

/** Mark the record, then wait for the turn. */
async function enqueue(id: string, previous: Promise<unknown>): Promise<Recording> {
  const rec = await getRecording(id);
  if (!rec) throw new Error(`recording ${id} not found`);
  if (rec.status === 'recording') throw new Error('the recording has not stopped');
  if (rec.status === 'stopped')
    throw new Error('the recording is waiting to be saved or discarded');
  // A failed run's message is stale now, but the reason must survive: it moves to the note. A
  // `recorded` record's error says why the video is not exported and stays until an export
  // succeeds.
  const earlier = rec.status === 'failed' ? rec.error : undefined;
  await updateRecording(id, {
    status: 'transcribing',
    ...(earlier !== undefined
      ? { error: undefined, note: appendNote(rec.note, `Earlier failure: ${earlier}`) }
      : {}),
  });
  emit(id, { phase: 'queued', message: 'Waiting to transcribe…', steps: [], overall: 0 });
  await previous;
  return run(id, earlier);
}

function finish(rec: Recording, tracker: ProgressTracker | undefined): Recording {
  const message =
    rec.status === 'failed'
      ? `Transcription failed: ${rec.error ?? 'unknown error'}`
      : 'Transcribed.';
  if (tracker && rec.status !== 'failed') tracker.finish();
  emit(
    rec.id,
    tracker
      ? tracker.snapshot('done', Date.now(), message)
      : { phase: 'done', message, steps: [], overall: 1 },
  );
  return rec;
}

async function run(id: string, earlier: string | undefined): Promise<Recording> {
  const settings = await loadSettings();
  const rescribeVersion = chrome.runtime.getManifest().version;
  const key = { model: settings.model, backend: settings.backend, rescribeVersion };
  let tracker: ProgressTracker | undefined;
  const fail = async (error: string): Promise<Recording> =>
    finish(await updateRecording(id, { status: 'failed', error }), tracker);

  // The plan, complete before the first step, so the step count the human sees never changes:
  // each channel with audio (cached ones done already), the model unless the worker holds it
  // (`holdsModel`: a worker that died since forgot it; a model step it turns out not to need
  // finishes at once, and one it needs without being planned is added at its first report), who
  // said what, and the files when there is a folder to write them to.
  const before = await getRecording(id);
  if (!before) throw new Error(`recording ${id} not found`);
  const cache = new Map<ChannelId, Segment[]>();
  const channels: { channel: ChannelId; cached: boolean }[] = [];
  for (const channel of CHANNELS) {
    const cached = await cachedSegments(id, channel, key);
    if (cached) {
      cache.set(channel, cached);
      channels.push({ channel, cached: true });
    } else if (await hasAudio(id, channel)) channels.push({ channel, cached: false });
  }
  tracker = new ProgressTracker(
    {
      channels,
      model: !transcriber?.holdsModel(key),
      exportFiles: before.exportPath !== undefined,
      myName: settings.myName,
    },
    Date.now(),
  );
  const t = tracker;
  const progress = (phase: Parameters<typeof t.snapshot>[0]): void =>
    emit(id, t.snapshot(phase, Date.now()));
  // In the human's words, for a failure: "the call", "your microphone", "Ulf’s microphone".
  const name = (channel: ChannelId): string => channelPhrase(channel, settings.myName).inSentence;

  // 3. Transcribe, one channel at a time.
  const segments: Segment[] = [];
  let found = false;
  for (const { channel, cached } of channels) {
    const kept = cache.get(channel);
    if (cached && kept) {
      found = true;
      segments.push(...kept);
      continue;
    }
    t.startChannel(channel);
    progress('transcribe');
    const pcm = await readChannelPcm(id, channel);
    if (!pcm || pcm.length === 0) {
      // Nothing to transcribe after all (a file too short for one sample; a guard against a
      // delete between the plan and now): the step is over, and `found` stays as it was.
      t.finishChannel(channel, Date.now());
      continue;
    }
    found = true;
    let last: TranscribeProgress['phase'] | undefined;
    let out: Segment[];
    try {
      transcriber ??= new Transcriber();
      out = await transcriber.transcribeChannel(pcm, channel, key, (p) => {
        last = p.phase;
        progress(t.report(channel, p, Date.now()));
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
      return fail(`Transcribing ${name(channel)} failed while ${stage}: ${message(err)}`);
    }
    t.finishChannel(channel, Date.now());
    try {
      await writeArtifact(
        id,
        segmentsArtifactName(channel),
        JSON.stringify({ ...key, segments: out } satisfies CachedSegments),
      );
    } catch (err) {
      return fail(`Could not save the transcription of ${name(channel)}: ${message(err)}`);
    }
    segments.push(...out);
  }

  // The record as it is now, not as it was when queued: the title, the export path and the
  // notes may have moved while the channels ran.
  const rec = await getRecording(id);
  if (!rec) throw new Error(`recording ${id} was deleted while transcribing`);

  // No channel and no cache: a video-only recording has nothing to transcribe and is done with
  // an empty transcript; a recording whose media was deleted must not be. The earlier failure's
  // reason stays in front.
  if (!found && !(await getVideoFile(id, rec.container)))
    return fail(
      [earlier, "Nothing to transcribe: the recording's media is no longer in Rescribe's storage."]
        .filter(Boolean)
        .join(' '),
    );

  // 4–5. Attribute and render from what is on disk: the segments and the event log.
  t.begin('attribute');
  progress('attribute');
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
    return fail(`Could not write the transcript: ${message(err)}`);
  }

  // Export next to the video, so only where the video already went (its directory must still
  // be under the current export folder, with the video in it). Otherwise the artifacts wait in
  // OPFS and `error` says so; "Save now" exports the video and the artifacts together. A `done`
  // recording without an export path always says why.
  let error: string | undefined;
  if (rec.exportPath) {
    t.begin('export');
    progress('export');
    try {
      await exportArtifacts(rec);
      error = undefined;
    } catch (err) {
      error =
        err instanceof ExportError && err.reason === 'missing'
          ? `Not exported: ${err.message}`
          : `Transcript not exported: ${message(err)}`;
    }
  } else {
    error = rec.error?.startsWith('Not exported')
      ? rec.error
      : 'Not exported: the video is not in the export folder; use Save now.';
  }
  return finish(
    await updateRecording(id, {
      status: 'done',
      model: settings.model,
      backend: settings.backend,
      transcribedAt,
      error,
    }),
    t,
  );
}
