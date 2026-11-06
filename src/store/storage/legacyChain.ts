/**
 * The legacy read chain (spec §3.10 step 3, §3.11, unit W3-3): where the
 * boot finds the user's data when the row store `maranki-rows.db` is still
 * empty — the first launch of the wave-3 build.
 *
 *   row store (maranki-rows.db)
 *     ├─ read FAILS              → reject (read-blocked). Never fall back: the
 *     │                            old copies may be OLDER than the rows.
 *     ├─ has the data            → use it
 *     └─ empty → kv 'maranki.state' (maranki-kv.db, the wave-2 stopgap,
 *                already on real phones since v2.2.0)
 *          ├─ read FAILS         → reject (read-blocked), for the same reason
 *          ├─ found              → use it (copied into the rows at boot)
 *          └─ empty → AsyncStorage 'maranki.state.v1' (v2.0.x – v2.1.x)
 *               ├─ found         → use it (copied into the rows at boot)
 *               ├─ empty         → nothing anywhere: a genuine first boot (the seed)
 *               └─ read FAILS    → Android RKStorage rescue (rkRescue.ts, §3.11)
 *                    ├─ found    → use it (copied into the rows at boot)
 *                    └─ null     → reject (read-blocked). Never seed over data.
 *
 * READ ONLY: `LegacyChainSources` has only read functions, so nothing here
 * can delete or change an old copy. The copies stay for 2 releases (spec
 * §3.1 rule 3); they are deleted in the release after `meta.bootOkCount ≥ 3`
 * has shipped.
 *
 * The raw text is used BEFORE migration, byte for byte: the engine migrates
 * it, and copies the result into the rows in ONE transaction during the same
 * boot (spec §3.10 step 3; rowStore.ts `firstCopyPending`). Until that copy
 * commits (a kill or a failed write rolls it back), every boot reads and
 * migrates the old text again, so a migrate() that throws leaves every copy
 * untouched (spec §3.1 rule 7). Whether a found text is a document or
 * corrupt is decided by the row port (`classifyRaw`).
 */
import { STORAGE_KEY } from '../persistence';
import { LegacyReadError } from './copyForward';
import { KV_STATE_KEY } from './kvStoragePort';

/** Where an old copy was found. */
export type LegacySource = 'kv' | 'asyncStorage' | 'rkRescue';

/** The old places. READ ONLY on purpose. */
export interface LegacyChainSources {
  /** kv 'maranki.state' (maranki-kv.db). Resolves null when not stored; REJECTS when the read fails. */
  readKv: () => Promise<string | null>;
  /** AsyncStorage 'maranki.state.v1'. Resolves null when not stored; rejects when the read fails. */
  readAsyncStorage: () => Promise<string | null>;
  /** Android only: the RKStorage rescue. Resolves null on any failure. Leave it out on other platforms. */
  rescue?: () => Promise<string | null>;
}

/** An old copy that was found. */
export interface LegacyFound {
  source: LegacySource;
  /** The key it was stored under: 'maranki.state' (kv) or 'maranki.state.v1' (AsyncStorage, rescue). */
  key: string;
  raw: string;
}

/** The value of `meta.copiedFrom` in the row store (stored as JSON). */
export interface RowCopiedFrom {
  source: LegacySource;
  key: string;
  /** When the copy was made (epoch ms). */
  at: number;
  /** Length of the copied text, to compare with the old copy by hand if needed. */
  length: number;
}

/** The `meta.copiedFrom` record of a copy made at `at`. */
export function copiedFromOf(found: LegacyFound, at: number): RowCopiedFrom {
  return { source: found.source, key: found.key, at, length: found.raw.length };
}

const isEmpty = (raw: string | null): raw is null => raw == null || raw === '';

/**
 * The newest old copy, or null when no old place holds anything. REJECTS
 * when the kv read fails, and when AsyncStorage fails and the rescue finds
 * nothing (`LegacyReadError`).
 */
export async function readLegacyChain(sources: LegacyChainSources): Promise<LegacyFound | null> {
  // No try/catch: a failed kv read must reject. The kv copy is newer than
  // the AsyncStorage one, so the AsyncStorage one must not be used instead.
  const kv = await sources.readKv();
  if (!isEmpty(kv)) return { source: 'kv', key: KV_STATE_KEY, raw: kv };

  let raw: string | null;
  try {
    raw = await sources.readAsyncStorage();
  } catch (asyncStorageError) {
    // On Android: a value over the ~2 MB read window. The data may still be
    // in the RKStorage file: try the rescue.
    const rescued = sources.rescue ? await sources.rescue().catch(() => null) : null;
    if (isEmpty(rescued)) throw new LegacyReadError(asyncStorageError);
    return { source: 'rkRescue', key: STORAGE_KEY, raw: rescued };
  }
  if (isEmpty(raw)) return null;
  return { source: 'asyncStorage', key: STORAGE_KEY, raw };
}

/**
 * The raw text of the newest old copy, for "Save a copy of the raw data".
 * Never rejects. When the kv read fails it resolves null: the kv copy is the
 * user's current data, and an OLDER AsyncStorage copy must not look like it.
 */
export async function readLegacyRaw(sources: LegacyChainSources): Promise<string | null> {
  try {
    return (await readLegacyChain(sources))?.raw ?? null;
  } catch {
    return null;
  }
}

/** What the boot read found (spec §3.10 step 3). */
export type StoreRead<R> =
  /** The row store holds the data. */
  | { from: 'rows'; rows: R }
  /** The row store is empty; an old copy was found. */
  | { from: 'legacy'; found: LegacyFound }
  /** Nothing anywhere: a genuine first boot. */
  | { from: 'nothing' };

/**
 * The whole boot read: the row store first, then the legacy chain.
 * `readRows` resolves null when the row store is EMPTY and rejects when it
 * cannot be read. Every rejection passes through: the caller is read-blocked.
 */
export async function readStoreChain<R>(
  readRows: () => Promise<R | null>,
  legacy: LegacyChainSources,
): Promise<StoreRead<R>> {
  const rows = await readRows();
  if (rows !== null) return { from: 'rows', rows };
  const found = await readLegacyChain(legacy);
  return found ? { from: 'legacy', found } : { from: 'nothing' };
}
