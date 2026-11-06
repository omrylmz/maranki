/**
 * Copy-forward (spec §3.7 + §3.10, unit W1-2): the kv port, plus a one-time
 * copy of the old AsyncStorage document into the kv-store.
 *
 * The first build with the kv-store finds the kv key empty, but the user's
 * data is still in AsyncStorage. load() then walks the "legacy chain":
 *
 *   kv 'maranki.state'
 *     ├─ read FAILS            → reject (read-blocked). Never fall back to the
 *     │                          old copy: it may be older than the kv data.
 *     ├─ found                 → use it (the copy was done on an earlier boot)
 *     └─ empty → AsyncStorage 'maranki.state.v1'
 *          ├─ found, parses    → copy the RAW text to kv + `maranki.copiedFrom`
 *          │                     (one transaction), then use it
 *          ├─ found, no parse  → { kind: 'corrupt' }: the controller keeps a
 *          │                     copy, then uses the seed. Nothing is copied.
 *          ├─ empty            → { kind: 'empty' }: a genuine first boot
 *          └─ read FAILS       → Android RKStorage rescue (rkRescue.ts)
 *               ├─ found       → copied and used, like above
 *               └─ null        → reject (read-blocked). Never seed over data.
 *
 * The raw text is copied BEFORE migration, byte for byte. So migrate() runs on
 * it on every boot until the first save, and a migrate() that throws leaves
 * both copies untouched (spec §3.1 rule 7).
 *
 * AsyncStorage is NEVER deleted or changed here: `LegacySources` only has
 * read functions. The old copy stays for 2 releases (spec §3.1 rule 3); it is
 * deleted in the release after `bootOkCount ≥ 3` has shipped.
 *
 * Live since W2-1: createStoragePort() (index.ts) builds this port on a phone.
 * The copy's `multiSet` is an EXCLUSIVE transaction on a second connection,
 * so no other kv writer may run during this load: the theme waits for
 * `afterAppStorageLoad()` (index.ts, W2 hardening).
 */
import type { DataState } from '../../domain/types';
import { STORAGE_KEY } from '../persistence';
import type { LoadResult, StoragePort } from '../storagePort';
import { classifyRaw, createKvStoragePort, KV_STATE_KEY, type KeyValueStore } from './kvStoragePort';

/** The kv key that records where the first copy came from. */
export const KV_COPIED_FROM_KEY = 'maranki.copiedFrom';

/** Where the copied document was found. */
export type CopySource = 'asyncStorage' | 'rkRescue';

/** The value of `maranki.copiedFrom` (stored as JSON). */
export interface CopiedFrom {
  source: CopySource;
  /** The old key, `maranki.state.v1`. */
  key: string;
  /** When the copy was made (epoch ms). */
  at: number;
  /** Length of the copied text, to compare with the old copy by hand if needed. */
  length: number;
}

/** The old places to read from. READ ONLY on purpose: nothing here can delete. */
export interface LegacySources {
  /** Today's AsyncStorage document. Resolves null when not stored; rejects when the read fails. */
  readAsyncStorage: () => Promise<string | null>;
  /** Android only: the RKStorage rescue. Resolves null on any failure. Leave it out on other platforms. */
  rescue?: () => Promise<string | null>;
}

/** Thrown by load() when the kv key is empty and NO old source could be read. */
export class LegacyReadError extends Error {
  /** Why AsyncStorage failed (for logs). */
  readonly asyncStorageError: unknown;

  constructor(asyncStorageError: unknown) {
    super('The old AsyncStorage data could not be read, and the rescue found nothing.');
    this.name = 'LegacyReadError';
    this.asyncStorageError = asyncStorageError;
  }
}

export interface CopyForwardOptions {
  /** The new storage (the kv-store in the app). */
  kv: KeyValueStore;
  legacy: LegacySources;
  now: () => number;
  /** Passed to the kv port (default: `writeCorruptBackupFile`). Tests pass a fake. */
  corruptFile?: (raw: string, stamp: string) => void | Promise<void>;
}

/** The old document and where it came from, or null when nothing is stored. Rejects when no source is readable. */
async function readLegacy(legacy: LegacySources): Promise<{ raw: string; source: CopySource } | null> {
  let raw: string | null;
  try {
    raw = await legacy.readAsyncStorage();
  } catch (asyncStorageError) {
    // AsyncStorage could not read it (on Android: a value over ~2 MB). The
    // data may still be in the RKStorage file: try the rescue.
    const rescued = legacy.rescue ? await legacy.rescue().catch(() => null) : null;
    if (rescued == null || rescued === '') throw new LegacyReadError(asyncStorageError);
    return { raw: rescued, source: 'rkRescue' };
  }
  if (raw == null || raw === '') return null;
  return { raw, source: 'asyncStorage' };
}

export function createCopyForwardPort<S = DataState>(options: CopyForwardOptions): StoragePort<S> {
  const { kv, legacy, now } = options;
  const kvPort = createKvStoragePort<S>({ store: kv, now, corruptFile: options.corruptFile });

  return {
    ...kvPort,

    async load(): Promise<LoadResult> {
      // A kv read failure rejects here (C1), even when the old copy is readable.
      const current = await kv.getItem(KV_STATE_KEY);
      if (current != null && current !== '') return classifyRaw(current);

      const found = await readLegacy(legacy);
      if (found === null) return { kind: 'empty' };

      const result = classifyRaw(found.raw);
      // Corrupt: do not copy it into the live key. The controller keeps a copy
      // (preserveCorrupt), then uses the seed; the old key still has it too.
      if (result.kind !== 'doc') return result;

      const copiedFrom: CopiedFrom = { source: found.source, key: STORAGE_KEY, at: now(), length: found.raw.length };
      // The document and the record in ONE transaction. If this write fails,
      // load() rejects (read-blocked): we never run on data that is not in the
      // live storage, and the next boot simply tries the copy again.
      await kv.multiSet([
        [KV_STATE_KEY, found.raw],
        [KV_COPIED_FROM_KEY, JSON.stringify(copiedFrom)],
      ]);
      return result;
    },

    async readRaw() {
      // For "Save a copy of the raw data". Must never reject.
      let current: string | null;
      try {
        current = await kv.getItem(KV_STATE_KEY);
      } catch {
        // The live data is in kv but unreadable. Do not offer the OLDER copy
        // from AsyncStorage as if it were the user's current data.
        return null;
      }
      if (current != null && current !== '') return current;
      try {
        return (await readLegacy(legacy))?.raw ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** The `maranki.copiedFrom` record, or null when there is none (or it cannot be read). */
export async function readCopiedFrom(kv: Pick<KeyValueStore, 'getItem'>): Promise<CopiedFrom | null> {
  try {
    const raw = await kv.getItem(KV_COPIED_FROM_KEY);
    return raw ? (JSON.parse(raw) as CopiedFrom) : null;
  } catch {
    return null;
  }
}
