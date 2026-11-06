/**
 * The memory port (spec §3.7 "Web", unit W1-2): the app state lives only in
 * this JavaScript process. Nothing reaches the disk.
 *
 * Two users:
 *   - the web build, which is a dev preview only (decision D6): the app shows
 *     "Web preview — nothing is saved." (the banner comes with W2-1);
 *   - tests: the engine and round-trip tests need a port without native code.
 *
 * It is the SAME code as the kv port (`createKeyValuePort` in kvStoragePort.ts,
 * same keys), with a Map instead of SQLite. So it stores real JSON text: a
 * value that JSON cannot keep (for example a key that holds `undefined`) is
 * lost here exactly as it would be on a phone, and a test sees it.
 *
 * To "kill and restart the app" in a test, keep the store and build a new port:
 *   const store = createMemoryStore();
 *   const before = createMemoryPort({ store });   // first app run
 *   const after = createMemoryPort({ store });    // after the "kill": same data
 */
import type { DataState } from '../../domain/types';
import type { StoragePort } from '../storagePort';
import { createKeyValuePort, KV_CORRUPT_PREFIX, KV_STATE_KEY, type KeyValueStore } from './kvStoragePort';

/** An in-memory key-value store. All methods resolve on a later microtask, like a real store. */
export interface MemoryStore extends KeyValueStore {
  /** How many write calls (setItem or multiSet) this store has received. */
  readonly writes: number;
  /** A copy of everything stored, as `{ key: text }`. */
  snapshot(): Record<string, string>;
}

export function createMemoryStore(initial: Record<string, string> = {}): MemoryStore {
  const data = new Map<string, string>(Object.entries(initial));
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    snapshot: () => Object.fromEntries(data),
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      writes += 1;
      data.set(key, value);
    },
    async multiSet(pairs) {
      // All pairs in one step: no await between them, so it is atomic.
      writes += 1;
      for (const [key, value] of pairs) data.set(key, value);
    },
  };
}

/** A memory port and the store under it (so a test can look inside). */
export type MemoryPort<S = DataState> = StoragePort<S> & { readonly store: MemoryStore };

export interface MemoryPortOptions {
  /** Share a store between ports to simulate an app restart. Default: a new empty store. */
  store?: MemoryStore;
  /** The clock, for the stamp of a corrupt copy. Default: Date.now. */
  now?: () => number;
}

export function createMemoryPort<S = DataState>(options: MemoryPortOptions = {}): MemoryPort<S> {
  const store = options.store ?? createMemoryStore();
  const port = createKeyValuePort<S>(store, {
    stateKey: KV_STATE_KEY,
    corruptKey: (stamp) => `${KV_CORRUPT_PREFIX}${stamp}`,
    now: options.now ?? Date.now,
  });
  return { ...port, store };
}
