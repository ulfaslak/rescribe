// The directory handles in IndexedDB `handles` (lib/idb.ts): the export folder from Settings
// under `export`, and a per-recording folder under `export:<id>` for a recording saved with
// "Save as…" into a folder of its own, before routines replaced it (2026-10-23): such a recording
// keeps its folder, nothing writes a new one. Handles cannot live in chrome.storage or travel in a
// runtime message.
import { idb } from '../lib/idb.ts';

export const EXPORT_HANDLE_KEY = 'export';

export function recordingRootKey(id: string): string {
  return `${EXPORT_HANDLE_KEY}:${id}`;
}

export function getExportRoot(): Promise<FileSystemDirectoryHandle | undefined> {
  return idb.get<FileSystemDirectoryHandle>('handles', EXPORT_HANDLE_KEY);
}

export function setExportRoot(handle: FileSystemDirectoryHandle): Promise<void> {
  return idb.set('handles', EXPORT_HANDLE_KEY, handle);
}

export function getRecordingExportRoot(id: string): Promise<FileSystemDirectoryHandle | undefined> {
  return idb.get<FileSystemDirectoryHandle>('handles', recordingRootKey(id));
}

export function deleteRecordingExportRoot(id: string): Promise<void> {
  return idb.del('handles', recordingRootKey(id));
}
