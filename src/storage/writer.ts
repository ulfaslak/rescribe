// Client of the storage worker (src/workers/storage.ts). One instance per recording.
import type { StorageRequest, StorageResponse } from '../workers/storage.ts';

export class StorageWriter {
  private readonly worker: Worker;
  private opened?: { resolve: () => void; reject: (e: Error) => void };
  private closed?: { resolve: (sizes: Record<string, number>) => void; reject: (e: Error) => void };
  private failed?: Error;
  private readonly onError: (err: Error) => void;

  /** `onError` fires once, on the first write failure; the recording cannot continue after it. */
  constructor(onError: (err: Error) => void) {
    this.onError = onError;
    this.worker = new Worker(chrome.runtime.getURL('workers/storage.js'), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<StorageResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) =>
      this.fail(new Error(`storage worker: ${e.message || 'failed to load or crashed'}`));
    this.worker.onmessageerror = () => this.fail(new Error('storage worker: message error'));
  }

  private post(msg: StorageRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private onMessage(msg: StorageResponse): void {
    switch (msg.type) {
      case 'opened':
        this.opened?.resolve();
        break;
      case 'closed':
        this.closed?.resolve(msg.sizes);
        this.worker.terminate();
        break;
      case 'error': {
        const err = new Error(`storage ${msg.op}${msg.file ? ` ${msg.file}` : ''}: ${msg.message}`);
        if (msg.op === 'open') this.opened?.reject(err);
        else if (msg.op === 'close') this.closed?.reject(err);
        else this.fail(err);
      }
    }
  }

  /** First failure wins; a pending open() or close() rejects with it, then the owner is told. */
  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    this.opened?.reject(err);
    this.closed?.reject(err);
    this.onError(err);
  }

  /** Create (truncate) the recording's files. Resolves when every sync access handle is open. */
  open(id: string, files: string[]): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.opened = { resolve, reject };
      this.post({ type: 'open', id, files });
    });
  }

  /** Append `data` to `file`. The buffer is transferred; do not touch it afterwards. */
  append(file: string, data: ArrayBuffer): void {
    if (this.failed) return;
    this.post({ type: 'append', file, data }, [data]);
  }

  /** Flush and close every file. Resolves with each file's final size in bytes. */
  close(): Promise<Record<string, number>> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.closed = { resolve, reject };
      this.post({ type: 'close' });
    });
  }

  /** Kill the worker. Safe after close(); the owner calls it when close() did not settle in time. */
  terminate(): void {
    this.worker.terminate();
  }
}
