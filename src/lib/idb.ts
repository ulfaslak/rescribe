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
  /**
   * Read-modify-write inside one readwrite transaction: IndexedDB serialises readwrite
   * transactions on a store, so two concurrent updates of the same key never lose each other's
   * fields (a get-then-put in two transactions can). `fn` runs synchronously inside the
   * transaction with the current value (undefined when absent) and returns the value to store, or
   * undefined to store nothing. Resolves with what was stored.
   */
  update<T>(
    store: StoreName,
    key: string,
    fn: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined> {
    return open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite');
          const s = tx.objectStore(store);
          const get = s.get(key) as IDBRequest<T | undefined>;
          let next: T | undefined;
          let failure: unknown;
          get.onsuccess = () => {
            try {
              next = fn(get.result);
              if (next !== undefined) s.put(next, key);
            } catch (err) {
              failure = err;
              tx.abort();
            }
          };
          get.onerror = () => reject(get.error);
          tx.oncomplete = () => resolve(next);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(failure ?? tx.error);
        }),
    );
  },
};
