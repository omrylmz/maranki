/**
 * The kv port (spec §3.7 "Stopgap", unit W1-2): the whole app state as ONE
 * JSON document under one key of `expo-sqlite/kv-store`.
 *
 * WHY: today the state is one JSON string in AsyncStorage. On Android,
 * AsyncStorage reads about 2 MB per value and holds 6 MB in total, so a big
 * library (2.9 MB for German_Complete) cannot be read back after a restart.
 * `expo-sqlite/kv-store` has the same simple API but reads the value with its
 * own SQLite, so neither limit applies. It adds no new native package.
 *
 * Layout of the kv file `maranki-kv.db`:
 *   maranki.state                   — the live document (KV_STATE_KEY)
 *   maranki.state.corrupt.{stamp}   — a copy of a document that could not be parsed
 *   maranki.copiedFrom              — written by copyForward.ts on the first copy
 *
 * This file also holds the shared code for "one JSON document in a key-value
 * store" (`createKeyValuePort`). The AsyncStorage port and the memory port use
 * the same code with a different store, so the JSON rules live in one place:
 *   - nothing stored (null or '')        → load() gives { kind: 'empty' }
 *   - a text that JSON.parse can read    → { kind: 'doc', value, raw }
 *   - a text that JSON.parse cannot read → { kind: 'corrupt', raw }
 *   - the store REJECTS the read         → load() rejects too (never 'empty'), so
 *                                          the caller blocks every write (C1).
 *
 * Not wired yet: W2-1 makes the engine use it through createStoragePort()
 * (src/store/storage/index.ts).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { SQLiteStorage } from 'expo-sqlite/kv-store';

import type { DataState } from '../../domain/types';
import { backupStamp } from '../backup';
import type { LoadResult, StoragePort } from '../storagePort';

/** The kv-store database file (separate from the wave-3 row store `maranki-rows.db`). */
export const KV_DB_NAME = 'maranki-kv.db';
/** The key of the live document in the kv file. */
export const KV_STATE_KEY = 'maranki.state';
/** Prefix of the keys that keep a corrupt document: `maranki.state.corrupt.{stamp}`. */
export const KV_CORRUPT_PREFIX = 'maranki.state.corrupt.';

/**
 * The small part of a key-value store that the ports need. `SQLiteStorage`
 * (expo-sqlite/kv-store) and AsyncStorage both have these methods, so both fit
 * this type without a wrapper.
 */
export interface KeyValueStore {
  /** Resolves null when the key is not stored. REJECTS when the read fails. */
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  /** Writes all pairs together. In the kv-store this is one exclusive SQLite transaction. */
  multiSet(pairs: [string, string][]): Promise<void>;
}

export interface KeyValuePortOptions {
  /** Where the live document is stored. */
  stateKey: string;
  /** Where a corrupt document is copied. `stamp` is the time of the copy, e.g. "2026-06-30-21-04-07". */
  corruptKey: (stamp: string) => string;
  /** The clock, for the stamp of a corrupt copy. */
  now: () => number;
  /**
   * Optional second place for a corrupt copy (in the app: a file in
   * `Paths.document/backups`, spec §3.10). It may throw or reject: the copy in
   * the store is enough.
   */
  corruptFile?: (raw: string, stamp: string) => void | Promise<void>;
}

/**
 * Sort a stored text into the three LoadResult kinds (see the file comment).
 * Only JSON parsing happens here: whether the value is a real Maranki document
 * is decided later by migrate(), through the controller's `decode`.
 */
export function classifyRaw(raw: string | null): LoadResult {
  if (raw == null || raw === '') return { kind: 'empty' };
  try {
    return { kind: 'doc', value: JSON.parse(raw) as unknown, raw };
  } catch {
    return { kind: 'corrupt', raw };
  }
}

/**
 * A StoragePort that keeps the state as one JSON document under one key.
 * A whole-document port ignores `prev` in save(): it always writes everything.
 */
export function createKeyValuePort<S = DataState>(
  store: KeyValueStore,
  options: KeyValuePortOptions,
): StoragePort<S> {
  const { stateKey, corruptKey, now, corruptFile } = options;

  return {
    async load() {
      // No try/catch on purpose: a failed read must reject (C1).
      return classifyRaw(await store.getItem(stateKey));
    },

    async save(next) {
      // JSON.stringify runs inside the async function, so a value it cannot
      // write (for example a cycle) rejects the save instead of throwing.
      await store.setItem(stateKey, JSON.stringify(next));
    },

    async replaceAll(state) {
      // One key holds everything, so one write replaces everything.
      await store.setItem(stateKey, JSON.stringify(state));
    },

    async preserveCorrupt(raw) {
      const stamp = backupStamp(new Date(now()));
      // `Promise.resolve().then(...)` turns a synchronous throw into a
      // rejection, so one failing copy never stops the other one.
      const copies: Promise<void>[] = [Promise.resolve().then(() => store.setItem(corruptKey(stamp), raw))];
      if (corruptFile) copies.push(Promise.resolve().then(() => corruptFile(raw, stamp)));
      const results = await Promise.allSettled(copies);
      // One good copy is enough. If EVERY copy failed, reject: the controller
      // then blocks writes, so the corrupt text is never written over.
      if (!results.some((r) => r.status === 'fulfilled')) {
        const first = results[0];
        throw first.status === 'rejected' ? first.reason : new Error('preserveCorrupt failed');
      }
    },

    async readRaw() {
      // A rescue path: it must never reject.
      try {
        const raw = await store.getItem(stateKey);
        return raw == null || raw === '' ? null : raw;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Write a corrupt document to `Paths.document/backups/corrupt-{stamp}.json`
 * (spec §3.10). Synchronous: the SDK 56 File API writes synchronously. Throws
 * on failure.
 */
export function writeCorruptBackupFile(raw: string, stamp: string): void {
  const dir = new Directory(Paths.document, 'backups');
  dir.create({ idempotent: true, intermediates: true });
  const file = new File(dir, `corrupt-${stamp}.json`);
  file.create({ overwrite: true });
  file.write(raw);
}

let sharedKvStore: SQLiteStorage | null = null;

/**
 * The one `SQLiteStorage` of the app for `maranki-kv.db`. Shared, so the state
 * port and other kv users (the theme, in W2-1) use one connection. Creating it
 * does not open the file yet: SQLiteStorage opens it on the first call.
 */
export function getKvStore(): SQLiteStorage {
  if (!sharedKvStore) sharedKvStore = new SQLiteStorage(KV_DB_NAME);
  return sharedKvStore;
}

export interface KvStoragePortOptions {
  /** The store to use. Default: the app's kv-store (`getKvStore()`). Tests pass a fake. */
  store?: KeyValueStore;
  now?: () => number;
  /** Default: `writeCorruptBackupFile`. */
  corruptFile?: (raw: string, stamp: string) => void | Promise<void>;
}

/** The kv port: key `maranki.state` in `maranki-kv.db`. */
export function createKvStoragePort<S = DataState>(options: KvStoragePortOptions = {}): StoragePort<S> {
  return createKeyValuePort<S>(options.store ?? getKvStore(), {
    stateKey: KV_STATE_KEY,
    corruptKey: (stamp) => `${KV_CORRUPT_PREFIX}${stamp}`,
    now: options.now ?? Date.now,
    corruptFile: options.corruptFile ?? writeCorruptBackupFile,
  });
}
