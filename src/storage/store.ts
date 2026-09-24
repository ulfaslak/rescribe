// The storage client for recording metadata (IndexedDB `recordings`, keyed by id) and the media in
// OPFS (layout in opfs.ts). App-tab only. Transcription and the library call these; the recorder
// owns the `recording → recorded | failed` transitions.
import { idb } from '../lib/idb.ts';
import { int16ToFloat32 } from '../lib/pcm.ts';
import type { ChannelId, Container, Recording } from '../lib/types.ts';
import { pcmFileName, recordingFile, removeRecordingDir, videoFileName } from './opfs.ts';

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

/** Delete the recording's OPFS directory (video, PCM, events). The record stays. */
export function deleteMedia(id: string): Promise<void> {
  return removeRecordingDir(id);
}

/** Delete the media and the record. */
export async function deleteRecording(id: string): Promise<void> {
  await deleteMedia(id);
  await idb.del('recordings', id);
}
