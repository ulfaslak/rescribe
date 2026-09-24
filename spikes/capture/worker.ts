// OPFS storage worker for the capture spike: appends chunks with a sync access handle, flushing
// per write, so data is on disk as it arrives.
let handle: FileSystemSyncAccessHandle | undefined;
let offset = 0;
let queue: Promise<void> = Promise.resolve();

async function ensureHandle(): Promise<FileSystemSyncAccessHandle> {
  if (handle) return handle;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('spike', { create: true });
  const file = await dir.getFileHandle('video.mp4', { create: true });
  handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  offset = 0;
  return handle;
}

self.onmessage = (e: MessageEvent<{ type: 'append'; buf: ArrayBuffer } | { type: 'close' }>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    if (msg.type === 'append') {
      const h = await ensureHandle();
      offset += h.write(new Uint8Array(msg.buf), { at: offset });
      h.flush();
    } else {
      const bytes = handle?.getSize() ?? 0;
      handle?.close();
      handle = undefined;
      postMessage({ type: 'closed', bytes });
    }
  });
};
