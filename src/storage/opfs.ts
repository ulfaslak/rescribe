// The OPFS layout (ARCHITECTURE § Storage): `recordings/<id>/` holds `video.mp4|webm`,
// `mic.pcm`, `display.pcm` (16 kHz mono Int16 LE, raw), `events.jsonl` and, once transcribed, the
// artifacts (transcript.md, transcript.json, meta.json). Shared by the storage worker (which
// writes) and the store (which reads, lists and deletes).
import type { ChannelId, Container } from '../lib/types.ts';

export const RECORDINGS_DIR = 'recordings';
export const EVENTS_FILE = 'events.jsonl';

export function videoFileName(container: Container): string {
  return container === 'mp4' ? 'video.mp4' : 'video.webm';
}

export function pcmFileName(channel: ChannelId): string {
  return `${channel}.pcm`;
}

/** Raw media: the video and the PCM channels. What "Delete media" removes; the events log and the
 * artifacts are everything else in the directory. */
export function isMediaFile(name: string): boolean {
  return /^video\.(mp4|webm)$/.test(name) || /^(mic|display)\.pcm$/.test(name);
}

/** The pipeline's per-channel recogniser cache (`segments.<channel>.json`): local only, never exported. */
export function isSegmentsCache(name: string): boolean {
  return /^segments\.(mic|display)\.json$/.test(name);
}

/** An artifact the export folder gets (transcript.md, transcript.json, meta.json): everything in
 * the directory that is neither raw media, nor the events log, nor the segments cache. */
export function isExportableArtifact(name: string): boolean {
  return !isMediaFile(name) && name !== EVENTS_FILE && !isSegmentsCache(name);
}

export async function recordingsRoot(
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(RECORDINGS_DIR, { create });
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError') return undefined;
    throw err;
  }
}

export async function recordingDir(
  id: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  const root = await recordingsRoot(create);
  if (!root) return undefined;
  try {
    return await root.getDirectoryHandle(id, { create });
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError') return undefined;
    throw err;
  }
}

/** The OPFS file, or undefined when the recording or the file does not exist. */
export async function recordingFile(id: string, name: string): Promise<File | undefined> {
  const dir = await recordingDir(id, false);
  if (!dir) return undefined;
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError') return undefined;
    throw err;
  }
}

export async function removeRecordingDir(id: string): Promise<void> {
  const root = await recordingsRoot(false);
  if (!root) return;
  try {
    await root.removeEntry(id, { recursive: true });
  } catch (err) {
    if ((err as DOMException).name !== 'NotFoundError') throw err;
  }
}

/** `entries()` is declared in lib.dom.asynciterable, which the tsconfig `lib` does not include. */
type IterableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** name → byte size of the files directly in `dir`. A file that vanishes mid-walk is skipped. */
async function fileSizes(dir: FileSystemDirectoryHandle): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for await (const [name, handle] of (dir as IterableDirectory).entries()) {
    if (handle.kind !== 'file') continue;
    try {
      out[name] = (await (handle as FileSystemFileHandle).getFile()).size;
    } catch (err) {
      if ((err as DOMException).name !== 'NotFoundError') throw err;
    }
  }
  return out;
}

/** The files of one recording directory: name → byte size. Empty when the directory is missing. */
export async function listRecordingFiles(id: string): Promise<Record<string, number>> {
  const dir = await recordingDir(id, false);
  return dir ? fileSizes(dir) : {};
}

/** Every directory under `recordings/`: id → (name → byte size). One walk; the storage figure. */
export async function walkRecordings(): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  const root = await recordingsRoot(false);
  if (!root) return out;
  for await (const [id, handle] of (root as IterableDirectory).entries()) {
    if (handle.kind !== 'directory') continue;
    out[id] = await fileSizes(handle as FileSystemDirectoryHandle);
  }
  return out;
}

/** Remove one file of a recording. Missing directory or file: nothing to do. */
export async function removeRecordingFile(id: string, name: string): Promise<void> {
  const dir = await recordingDir(id, false);
  if (!dir) return;
  try {
    await dir.removeEntry(name);
  } catch (err) {
    if ((err as DOMException).name !== 'NotFoundError') throw err;
  }
}
