// Minimal IndexedDB key-value access. One database, named object stores. Handles
// (FileSystemDirectoryHandle) can be stored here; chrome.storage cannot hold them.
const DB_NAME = 'rescribe';
const DB_VERSION = 1;
export const STORES = ['handles', 'recordings'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES)
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return request<T | undefined>(
      store,
      'readonly',
      (s) => s.get(key) as IDBRequest<T | undefined>,
    );
  },
  set(store: StoreName, key: string, value: unknown): Promise<void> {
    return request(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined);
  },
  del(store: StoreName, key: string): Promise<void> {
    return request(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
  },
  all<T>(store: StoreName): Promise<T[]> {
    return request<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
};
