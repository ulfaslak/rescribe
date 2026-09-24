// Storage worker: appends video chunks and PCM blocks to OPFS files through sync access handles,
// one per file, flushing after every write, so captured data is on disk within seconds of capture
// (INVARIANTS). One request queue keeps writes in arrival order; nothing is retained in memory.
// Protocol below; the client is src/storage/writer.ts.
import { RECORDINGS_DIR } from '../storage/opfs.ts';

/** App tab → worker. `data` is transferred, never copied. */
export type StorageRequest =
  | { type: 'open'; id: string; files: string[] }
  | { type: 'append'; file: string; data: ArrayBuffer }
  | { type: 'close' };

/** Worker → app tab. `error` after `append` means the write failed; the recording cannot continue. */
export type StorageResponse =
  | { type: 'opened'; id: string }
  | { type: 'closed'; sizes: Record<string, number> }
  | { type: 'error'; op: StorageRequest['type']; file?: string; message: string };

interface Open {
  handle: FileSystemSyncAccessHandle;
  offset: number;
}

const files = new Map<string, Open>();
let queue: Promise<void> = Promise.resolve();
const port = self as unknown as { postMessage(msg: StorageResponse): void };

async function open(id: string, names: string[]): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle(RECORDINGS_DIR, { create: true });
  const dir = await recordings.getDirectoryHandle(id, { create: true });
  for (const name of names) {
    const fh = await dir.getFileHandle(name, { create: true });
    const handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    files.set(name, { handle, offset: 0 });
  }
  port.postMessage({ type: 'opened', id });
}

function append(name: string, data: ArrayBuffer): void {
  const f = files.get(name);
  if (!f) throw new Error(`file not open: ${name}`);
  const bytes = new Uint8Array(data);
  let written = 0;
  while (written < bytes.length) {
    const n = f.handle.write(bytes.subarray(written), { at: f.offset });
    if (n <= 0) throw new Error(`short write on ${name}`);
    written += n;
    f.offset += n;
  }
  f.handle.flush();
}

function close(): void {
  const sizes: Record<string, number> = {};
  for (const [name, f] of files) {
    try {
      f.handle.flush();
      sizes[name] = f.handle.getSize();
    } finally {
      f.handle.close();
    }
  }
  files.clear();
  port.postMessage({ type: 'closed', sizes });
}

self.onmessage = (e: MessageEvent<StorageRequest>) => {
  const msg = e.data;
  queue = queue
    .then(async () => {
      if (msg.type === 'open') await open(msg.id, msg.files);
      else if (msg.type === 'append') append(msg.file, msg.data);
      else close();
    })
    .catch((err: unknown) => {
      port.postMessage({
        type: 'error',
        op: msg.type,
        file: msg.type === 'append' ? msg.file : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    });
};
