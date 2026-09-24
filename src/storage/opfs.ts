// The OPFS layout (ARCHITECTURE § Storage): `recordings/<id>/` holds `video.mp4|webm`,
// `mic.pcm`, `display.pcm` (16 kHz mono Int16 LE, raw) and `events.jsonl`. Shared by the storage
// worker (which writes) and the store (which reads and deletes).
import type { ChannelId, Container } from '../lib/types.ts';

export const RECORDINGS_DIR = 'recordings';
export const EVENTS_FILE = 'events.jsonl';

export function videoFileName(container: Container): string {
  return container === 'mp4' ? 'video.mp4' : 'video.webm';
}

export function pcmFileName(channel: ChannelId): string {
  return `${channel}.pcm`;
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
