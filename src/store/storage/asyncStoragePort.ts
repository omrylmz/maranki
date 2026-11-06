/**
 * The AsyncStorage port (spec §3.7 "Today", unit W1-2): today's storage, one
 * JSON document under the key `maranki.state.v1`.
 *
 * Two uses:
 *   - `readLegacyAsyncStorage()` — the READ-ONLY source of the copy-forward
 *     (copyForward.ts). The first kv build copies the old document from here
 *     into the kv-store. It never changes or deletes the old key: the old copy
 *     stays for 2 releases (spec §3.1 rule 3, "never destroy the source").
 *   - `createAsyncStoragePort()` — today's backend as a full StoragePort, for a
 *     build or a test that still runs on AsyncStorage.
 *
 * Same JSON rules as the kv port (`createKeyValuePort`, kvStoragePort.ts). A
 * corrupt document is copied to today's slot `maranki.state.v1.corrupt`
 * (BACKUP_KEY) and to a file in `Paths.document/backups`.
 *
 * Note for tests: importing this file needs the AsyncStorage jest mock
 * (`jest.mock('@react-native-async-storage/async-storage', ...)`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { DataState } from '../../domain/types';
import { BACKUP_KEY, STORAGE_KEY } from '../persistence';
import type { StoragePort } from '../storagePort';
import { createKeyValuePort, writeCorruptBackupFile, type KeyValueStore } from './kvStoragePort';

/**
 * Read today's document as text. Resolves null when nothing is stored.
 * REJECTS when the read fails — on Android that is what happens to a value
 * over the ~2 MB read window, and copy-forward then tries the RKStorage rescue.
 */
export function readLegacyAsyncStorage(
  store: Pick<KeyValueStore, 'getItem'> = AsyncStorage,
): Promise<string | null> {
  return store.getItem(STORAGE_KEY);
}

export interface AsyncStoragePortOptions {
  /** Default: the real AsyncStorage. */
  store?: KeyValueStore;
  now?: () => number;
  /** Default: `writeCorruptBackupFile`. */
  corruptFile?: (raw: string, stamp: string) => void | Promise<void>;
}

export function createAsyncStoragePort<S = DataState>(options: AsyncStoragePortOptions = {}): StoragePort<S> {
  return createKeyValuePort<S>(options.store ?? AsyncStorage, {
    stateKey: STORAGE_KEY,
    // Today's single corrupt slot: a newer corrupt copy replaces the older one
    // (the file copy keeps each one under its own stamp).
    corruptKey: () => BACKUP_KEY,
    now: options.now ?? Date.now,
    corruptFile: options.corruptFile ?? writeCorruptBackupFile,
  });
}
