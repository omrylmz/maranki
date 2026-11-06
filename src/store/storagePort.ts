/**
 * The storage contract (spec W0-2, used from wave 1 on).
 *
 * A StoragePort is the ONLY thing that touches the disk for the app state.
 * The persistence controller (W1-2) and the engine (W2-1) talk to a port, never
 * to AsyncStorage or SQLite directly. So one controller works with every
 * backend, and tests use a memory port:
 *   - memory port      — web preview and tests (nothing is saved on web, D6),
 *   - kv port          — wave 2: `expo-sqlite/kv-store`, one JSON document,
 *   - row port         — wave 3: SQLite tables, only changed rows per save.
 *
 * Types only. The implementations live in src/store/storage/.
 */
import type { RevlogRow } from '../domain/model';
import type { DataState } from '../domain/types';

/**
 * What a SUCCESSFUL read found. A read FAILURE is not a value here: `load()`
 * rejects instead, and the caller blocks every write (C1).
 *   - empty   — nothing stored: a genuine first boot (the seed may be used).
 *   - doc     — a parsed document. `value` is still untrusted (any version, maybe
 *               not Maranki at all): the caller runs it through migrate().
 *               `raw` is the text it came from, when the port has it (for the
 *               pre-migration copy and "Save a copy of the raw data").
 *   - corrupt — something is stored but cannot be parsed. `raw` is kept so the
 *               caller can preserve it before using the seed.
 */
export type LoadResult =
  | { kind: 'empty' }
  | { kind: 'doc'; value: unknown; raw?: string }
  | { kind: 'corrupt'; raw: string };

/**
 * One storage backend. `S` is the state shape; it defaults to today's
 * `DataState` (it becomes the v3 state when W3-1 switches types.ts).
 *
 * Rules every implementation keeps:
 *   - Every method that writes resolves only after the data is on disk (for
 *     SQLite: after the transaction commits), and rejects on failure.
 *   - Nothing is deleted that the port did not load or was not told to replace.
 */
export interface StoragePort<S = DataState> {
  /** Read the stored state. REJECTS on a read failure — never resolves 'empty' for an error (C1). */
  load(): Promise<LoadResult>;
  /**
   * Save `next`. `prev` is the last state this port saved SUCCESSFULLY (null =
   * nothing saved yet, so write everything). A row port saves only the rows
   * that differ between `prev` and `next`; a whole-document port may ignore
   * `prev`. On rejection the caller keeps its old `prev`, so the next save
   * retries the full difference (M15).
   */
  save(next: S, prev: S | null): Promise<void>;
  /**
   * Replace EVERYTHING stored with `state`, in one transaction (restore,
   * factory reset, first copy forward).
   *
   * `history` (a restore): the review-history rows the restored library
   * gets — the backup's rows, or this phone's kept rows (backup.ts
   * `restoreHistoryRows`). A port with a history table (the row port)
   * writes them in the SAME transaction, right after it deletes the old
   * history, so no kill or failed write can leave the table empty; when the
   * write fails, the save that retries it writes them too. A port without
   * a history table (memory, kv) ignores them.
   */
  replaceAll(state: S, history?: readonly RevlogRow[]): Promise<void>;
  /** Keep a copy of an unreadable stored text before the seed is used. Never overwrites the live data. */
  preserveCorrupt(raw: string): Promise<void>;
  /**
   * The raw stored text, for "Save a copy of the raw data" (DataProblemScreen).
   * Resolves null when nothing is stored or the read fails: this is a rescue
   * path, so it must not reject.
   */
  readRaw(): Promise<string | null>;
}
