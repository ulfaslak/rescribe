// The export folder (File System Access API). The human's directory handle lives in IndexedDB
// `handles` under `export` (handles.ts); a recording saved with "Save as…" has a folder of its
// own under `export:<id>`, and `rootFor` says which one a recording uses. Each recording gets
// `<template>/` inside its folder, named by src/lib/pathtemplate.ts, with " (2)", " (3)"… on
// collision. App-tab only, except `ensureExportPermission`, `getExportRoot`, `setExportRoot` and
// `setRecordingExportRoot`, which the stop dialog calls inside its own clicks.
import { candidateName, renderPathTemplate } from '../lib/pathtemplate.ts';
import type { Container, Recording } from '../lib/types.ts';
import { withDuration } from '../lib/webm.ts';
import { getExportRoot, getRecordingExportRoot } from './handles.ts';
import { listArtifacts, readArtifact } from './store.ts';

export {
  EXPORT_HANDLE_KEY,
  getExportRoot,
  setExportRoot,
  getRecordingExportRoot,
  setRecordingExportRoot,
} from './handles.ts';

/** `missing`: the recording's directory or its video is not under the current export folder. */
export type ExportFailure = 'no-folder' | 'permission' | 'io' | 'missing';

export function exportVideoName(container: Container): string {
  return container === 'mp4' ? 'recording.mp4' : 'recording.webm';
}

/** Enough of a WebM to hold its EBML header, Segment header and Info (Chrome's end under 100 bytes in). */
const WEBM_HEAD_BYTES = 64 * 1024;

/**
 * The bytes to export for the video: the OPFS file as it is, except that a WebM gets its
 * duration written into the header (`withDuration`, lib/webm.ts). MediaRecorder writes a live
 * stream without one, and a browser then plays the file as endless. The OPFS copy is left as
 * recorded: it is the append-only copy the crash recovery reads. A WebM whose header cannot be
 * patched, or a recording without an end time, is exported unchanged.
 */
export async function exportVideoData(
  video: Blob,
  rec: Pick<Recording, 'container' | 'startedAt' | 'endedAt'>,
): Promise<ReadableStream<Uint8Array>> {
  if (rec.container !== 'webm' || rec.endedAt === undefined) return video.stream();
  const head = new Uint8Array(await video.slice(0, WEBM_HEAD_BYTES).arrayBuffer());
  const patched = withDuration(head, rec.endedAt - rec.startedAt);
  if (!patched) return video.stream();
  // A Blob over a Blob slice references the file; nothing but the head is copied.
  return new Blob([patched.bytes, video.slice(patched.consumed)]).stream();
}

export class ExportError extends Error {
  readonly reason: ExportFailure;
  constructor(reason: ExportFailure, message: string) {
    super(message);
    this.name = 'ExportError';
    this.reason = reason;
  }
}

/**
 * The folder a recording is exported under: its own (`exportRoot` set, handle under
 * `export:<id>`) or the one from Settings. A recording that names its own folder but has no
 * handle for it is an error, not a fallback: the video would land in a folder the row does not
 * show.
 */
export async function rootFor(
  rec: Pick<Recording, 'id' | 'exportRoot'>,
): Promise<FileSystemDirectoryHandle> {
  if (rec.exportRoot !== undefined) {
    const own = await getRecordingExportRoot(rec.id);
    if (!own)
      throw new ExportError(
        'no-folder',
        `The folder "${rec.exportRoot}" chosen for this recording is no longer known to Rescribe.`,
      );
    return own;
  }
  const root = await getExportRoot();
  if (!root) throw new ExportError('no-folder', 'No export folder chosen in Settings.');
  return root;
}

/** `rootFor` with the permission checked: the folder is there and may be written to. */
async function writableRoot(
  rec: Pick<Recording, 'id' | 'exportRoot'>,
): Promise<FileSystemDirectoryHandle> {
  const root = await rootFor(rec);
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted')
    throw new ExportError('permission', 'Rescribe needs permission to write to the export folder.');
  return root;
}

/**
 * Make sure we may write to the export folder: the recording's own when given one that has it,
 * else the one from Settings. `requestPermission` only prompts inside a user gesture, so call
 * this from the click that leads to the export (Stop, Save, Save now). Returns 'none' when no
 * folder was chosen.
 */
export async function ensureExportPermission(
  rec?: Pick<Recording, 'id' | 'exportRoot'>,
): Promise<PermissionState | 'none'> {
  let root: FileSystemDirectoryHandle | undefined;
  try {
    root = rec ? await rootFor(rec) : await getExportRoot();
  } catch {
    root = undefined;
  }
  if (!root) return 'none';
  const state = await root.queryPermission({ mode: 'readwrite' });
  if (state === 'granted') return state;
  try {
    return await root.requestPermission({ mode: 'readwrite' });
  } catch {
    return state;
  }
}

export type ExportedFileState = 'present' | 'missing' | 'no-folder' | 'permission';

/**
 * Whether the recording's exported video is in the export folder right now (`findExportDirectory`
 * as a question). `missing` covers the file, its directory and a root that was deleted or moved
 * on disk; a folder that cannot be looked at because none is chosen or its permission is not
 * granted is reported as that, never as `missing`, so a caller about to delete the local copy can
 * refuse instead of guessing. Anything else (an I/O error) throws.
 */
export async function exportedFileState(rec: Recording): Promise<ExportedFileState> {
  try {
    await findExportDirectory(rec);
    return 'present';
  } catch (err) {
    if (err instanceof ExportError && err.reason !== 'io') return err.reason;
    throw err;
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
 * The recording's directory in its export folder (`rootFor`). Reuses `rec.exportPath` when set, otherwise
 * creates `<template>/` (nested when the template contains `/`), suffixing the last segment on
 * collision. Returns the handle and the relative path to store as `exportPath`.
 */
export async function getExportDirectory(
  rec: Pick<Recording, 'id' | 'exportRoot' | 'startedAt' | 'title' | 'exportPath'>,
  pathTemplate: string,
): Promise<{ dir: FileSystemDirectoryHandle; path: string }> {
  const root = await writableRoot(rec);
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
  const root = await writableRoot(rec);
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
