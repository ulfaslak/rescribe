// The storage client for recording metadata (IndexedDB `recordings`, keyed by id) and the media in
// OPFS (layout in opfs.ts). App-tab only. Transcription and the library call these; the recorder
// owns the `recording → recorded | failed` transitions.
import { idb } from '../lib/idb.ts';
import { int16ToFloat32 } from '../lib/pcm.ts';
import type { ChannelId, Container, Recording } from '../lib/types.ts';
import {
  EVENTS_FILE,
  isExportableArtifact,
  isMediaFile,
  pcmFileName,
  recordingDir,
  recordingFile,
  removeRecordingDir,
  videoFileName,
} from './opfs.ts';

export async function listRecordings(): Promise<Recording[]> {
  const all = await idb.all<Recording>('recordings');
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export function getRecording(id: string): Promise<Recording | undefined> {
  return idb.get<Recording>('recordings', id);
}

export function putRecording(rec: Recording): Promise<void> {
  return idb.set('recordings', rec.id, rec);
}

/** Merge `patch` into the stored record. Throws when the recording does not exist. */
export async function updateRecording(id: string, patch: Partial<Recording>): Promise<Recording> {
  const current = await getRecording(id);
  if (!current) throw new Error(`recording ${id} not found`);
  const next = { ...current, ...patch, id };
  await putRecording(next);
  return next;
}

/** The OPFS video file, or undefined when it was never written or the media was deleted. */
export function getVideoFile(id: string, container: Container): Promise<File | undefined> {
  return recordingFile(id, videoFileName(container));
}

/** The OPFS PCM file of a channel (16 kHz mono Int16 LE, raw), for streaming with `File.slice`. */
export function getChannelFile(id: string, channel: ChannelId): Promise<File | undefined> {
  return recordingFile(id, pcmFileName(channel));
}

/**
 * A channel's whole PCM as Int16 samples, the on-disk representation (32 kB per second; a two-hour
 * channel is 230 MB). Hand the array to the transcribe worker as a transfer and convert to Float32
 * there, in pieces; never convert a whole channel in the app tab (twice the memory, on the UI
 * thread). For anything incremental use `getChannelFile` and `File.slice`.
 */
export async function readChannelPcm(
  id: string,
  channel: ChannelId,
): Promise<Int16Array | undefined> {
  const file = await getChannelFile(id, channel);
  if (!file) return undefined;
  const buf = await file.arrayBuffer();
  return new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
}

/** Int16 samples → Float32 in [-1, 1], what an ASR engine takes. */
export const pcmToFloat32 = int16ToFloat32;

// --- Transcript artifacts (pipeline steps 4–5; ARCHITECTURE § Storage) ----------------------

/**
 * One channel's recogniser output, kept so a re-run skips a channel already transcribed with the
 * same model, backend and Rescribe version (a re-run after a failure on the other channel, or
 * with another "my name"). Never exported.
 */
export function segmentsArtifactName(channel: ChannelId): string {
  return `segments.${channel}.json`;
}

/** Write (replace) a text file in the recording's OPFS directory. */
export async function writeArtifact(id: string, name: string, text: string): Promise<void> {
  const dir = await recordingDir(id, true);
  if (!dir) throw new Error(`recording directory ${id} could not be opened`);
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable({ keepExistingData: false });
  try {
    await writable.write(text);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
}

/** A text file from the recording's OPFS directory, or undefined when absent. */
export async function readArtifact(id: string, name: string): Promise<string | undefined> {
  const file = await recordingFile(id, name);
  return file ? file.text() : undefined;
}

/** The exportable artifacts present in OPFS (`isExportableArtifact`), sorted by name. */
export async function listArtifacts(id: string): Promise<string[]> {
  const dir = await recordingDir(id, false);
  if (!dir) return [];
  const out: string[] = [];
  for await (const [name, handle] of dir.entries())
    if (handle.kind === 'file' && isExportableArtifact(name)) out.push(name);
  return out.sort();
}

/** The recording's event log (events.jsonl) as text; empty when absent. */
export async function readEventLog(id: string): Promise<string> {
  return (await readArtifact(id, EVENTS_FILE)) ?? '';
}

/**
 * Delete the video and the PCM out of OPFS and mark the record `mediaDeleted`. The event log,
 * the artifacts and the segments cache stay, so the transcript can still be exported and, from
 * the cache, assembled again (a re-run with another "my name"); without the cache a re-run fails.
 */
export async function deleteMedia(id: string): Promise<void> {
  const dir = await recordingDir(id, false);
  if (dir) {
    const names: string[] = [];
    for await (const name of dir.keys()) if (isMediaFile(name)) names.push(name);
    for (const name of names) await dir.removeEntry(name);
  }
  await updateRecording(id, { mediaDeleted: true }).catch(() => undefined);
}

/** Delete the media and the record. */
export async function deleteRecording(id: string): Promise<void> {
  await deleteMedia(id);
  await idb.del('recordings', id);
}
