// IndexedDB-backed Store for the market recorder. Falls back to memory where IndexedDB is missing
// (tests, private windows): recording then lasts while the panel is open.

import { MemStore, type Rec, type Store } from './replay.js';

const DB = 'bdiqvest-recordings';
const OS = 'chunks';

export function openStore(): Store {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return new MemStore();
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    db().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const req = fn(d.transaction(OS, mode).objectStore(OS));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  return {
    async put(key: string, recs: Rec[]) {
      const prev = ((await run('readonly', (os) => os.get(key))) as Rec[] | undefined) ?? [];
      await run('readwrite', (os) => os.put([...prev, ...recs], key));
    },
    async get(key: string) {
      return ((await run('readonly', (os) => os.get(key))) as Rec[] | undefined) ?? [];
    },
    async keys() {
      return ((await run('readonly', (os) => os.getAllKeys())) as IDBValidKey[]).map(String);
    },
    async del(key: string) {
      await run('readwrite', (os) => os.delete(key));
    },
  };
}
