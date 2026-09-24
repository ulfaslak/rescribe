// The export folder (File System Access API). The human's directory handle lives in IndexedDB
// `handles` under `export`; each recording gets `<template>/` inside it, named by
// src/lib/pathtemplate.ts, with " (2)", " (3)"… on collision. App-tab only.
import { idb } from '../lib/idb.ts';
import { candidateName, renderPathTemplate } from '../lib/pathtemplate.ts';
import type { Container, Recording } from '../lib/types.ts';
import { listArtifacts, readArtifact } from './store.ts';

export const EXPORT_HANDLE_KEY = 'export';

/** `missing`: the recording's directory or its video is not under the current export folder. */
export type ExportFailure = 'no-folder' | 'permission' | 'io' | 'missing';

export function exportVideoName(container: Container): string {
  return container === 'mp4' ? 'recording.mp4' : 'recording.webm';
}

export class ExportError extends Error {
  readonly reason: ExportFailure;
  constructor(reason: ExportFailure, message: string) {
    super(message);
    this.name = 'ExportError';
    this.reason = reason;
  }
}

export function getExportRoot(): Promise<FileSystemDirectoryHandle | undefined> {
  return idb.get<FileSystemDirectoryHandle>('handles', EXPORT_HANDLE_KEY);
}

export function setExportRoot(handle: FileSystemDirectoryHandle): Promise<void> {
  return idb.set('handles', EXPORT_HANDLE_KEY, handle);
}

/**
 * Make sure we may write to the export folder. `requestPermission` only prompts inside a user
 * gesture, so call this from the Stop click, before the recorder stops. Returns 'none' when no
 * folder was chosen.
 */
export async function ensureExportPermission(): Promise<PermissionState | 'none'> {
  const root = await getExportRoot();
  if (!root) return 'none';
  const state = await root.queryPermission({ mode: 'readwrite' });
  if (state === 'granted') return state;
  try {
    return await root.requestPermission({ mode: 'readwrite' });
  } catch {
    return state;
  }
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError') return false;
    if ((err as DOMException).name === 'TypeMismatchError') return true;
    throw err;
  }
}

function wrap(err: unknown): ExportError {
  if (err instanceof ExportError) return err;
  const name = (err as DOMException).name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new ExportError('permission', 'Rescribe may not write to the export folder.');
  return new ExportError('io', `Export folder: ${String(err)}`);
}

/**
 * The recording's directory in the export folder. Reuses `rec.exportPath` when set, otherwise
 * creates `<template>/` (nested when the template contains `/`), suffixing the last segment on
 * collision. Returns the handle and the relative path to store as `exportPath`.
 */
export async function getExportDirectory(
  rec: Pick<Recording, 'startedAt' | 'title' | 'exportPath'>,
  pathTemplate: string,
): Promise<{ dir: FileSystemDirectoryHandle; path: string }> {
  const root = await getExportRoot();
  if (!root) throw new ExportError('no-folder', 'No export folder chosen in Settings.');
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted')
    throw new ExportError('permission', 'Rescribe needs permission to write to the export folder.');
  try {
    const segments = rec.exportPath
      ? rec.exportPath.split('/')
      : renderPathTemplate(pathTemplate, rec);
    let dir = root;
    for (const seg of segments.slice(0, -1))
      dir = await dir.getDirectoryHandle(seg, { create: true });
    let leaf = segments[segments.length - 1]!;
    if (!rec.exportPath) {
      const base = leaf;
      for (let n = 1; ; n++) {
        if (n > 1000) throw new ExportError('io', `Too many folders named "${base}".`);
        const candidate = candidateName(base, n);
        if (!(await exists(dir, candidate))) {
          leaf = candidate;
          break;
        }
      }
    }
    dir = await dir.getDirectoryHandle(leaf, { create: true });
    return { dir, path: [...segments.slice(0, -1), leaf].join('/') };
  } catch (err) {
    throw wrap(err);
  }
}

export type ExportData = Blob | BufferSource | ReadableStream<Uint8Array> | string;

/** Write `data` as `name` inside `dir`, replacing an existing file. Streams when given a stream. */
export async function writeExportFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ExportData,
): Promise<void> {
  try {
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable({ keepExistingData: false });
    if (data instanceof ReadableStream) {
      await data.pipeTo(writable);
    } else {
      try {
        await writable.write(data);
        await writable.close();
      } catch (err) {
        await writable.abort().catch(() => undefined);
        throw err;
      }
    }
  } catch (err) {
    throw wrap(err);
  }
}

/**
 * The recording's directory as it is: `exportPath` resolved under the current export folder,
 * creating nothing, with the exported video in it. Throws ExportError `missing` when either is
 * not there (the export folder was changed, the directory moved or deleted, the video never
 * exported), so the caller redoes the video and the artifacts together with `finalize`.
 */
export async function findExportDirectory(rec: Recording): Promise<FileSystemDirectoryHandle> {
  if (!rec.exportPath)
    throw new ExportError('missing', 'the video has not been saved to the export folder yet');
  const root = await getExportRoot();
  if (!root) throw new ExportError('no-folder', 'No export folder chosen in Settings.');
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted')
    throw new ExportError('permission', 'Rescribe needs permission to write to the export folder.');
  try {
    let dir = root;
    for (const seg of rec.exportPath.split('/')) dir = await dir.getDirectoryHandle(seg);
    await dir.getFileHandle(exportVideoName(rec.container));
    return dir;
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === 'NotFoundError' || name === 'TypeMismatchError')
      throw new ExportError(
        'missing',
        "the recording's folder was not found under the current export folder",
      );
    throw wrap(err);
  }
}

/**
 * Export the transcript artifacts present in OPFS (`listArtifacts`) into the recording's
 * directory, next to the exported video (`findExportDirectory`: never a directory without it).
 * Returns the names written. Throws ExportError. The pipeline calls it once the video is
 * exported; "Save now" calls it after `finalize`.
 */
export async function exportArtifacts(rec: Recording): Promise<{ path: string; names: string[] }> {
  const dir = await findExportDirectory(rec);
  const names = await listArtifacts(rec.id);
  for (const name of names) {
    const text = await readArtifact(rec.id, name);
    if (text !== undefined) await writeExportFile(dir, name, text);
  }
  return { path: rec.exportPath!, names };
}
