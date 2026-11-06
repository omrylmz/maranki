/**
 * The storage adapters (spec §3.7) and `createStoragePort()`, the one place
 * that picks the port for the platform.
 *
 *   native (Android, iOS) → the ROW STORE `maranki-rows.db` (wave 3,
 *                           rowStore.ts). When it is still empty, the boot
 *                           reads the legacy chain (legacyChain.ts):
 *                           kv 'maranki.state' → AsyncStorage
 *                           'maranki.state.v1' → the RKStorage rescue
 *                           (Android only). The old copies are only read.
 *   web                   → memory port: a dev preview, nothing is saved (D6).
 *                           The app shows WEB_PREVIEW_NOTICE (DataContext).
 *
 * `appStoragePort()` is the app's ONE port. The engine (DataContext) saves
 * through it, and "Save a copy of the raw data" (rescueExport.ts) reads the
 * raw text through the same port, so both always see the same storage.
 * `appRevlogStore()` is the review history in the same row database
 * (history.ts, the Restore flow). `markAppBootOk()` counts a boot that
 * reached "ready" (`meta.bootOkCount`, spec §3.10 step 6).
 *
 * The app's row port gets migrate() as its `decode` (`decodedState`): the
 * same decode the engine runs. The port uses it only for the first save
 * after a rows load that the decode changed, to keep ONLY the rows the
 * integrity check set aside (rowStore.ts).
 *
 * `buildStoragePort(deps)` holds the platform choice with every native piece
 * injected, so the wiring (which port, and the Android-only rescue) is tested
 * with fakes. Without `deps.rows` it builds the wave-2 kv port (copy-forward
 * into the kv file), which tests and tools without a row database still use.
 * `createStoragePort()` itself, with the real pieces, is tested in
 * index.test.ts.
 *
 * ONE WRITER AT A TIME in the kv file (W2 hardening, kept in wave 3): a kv
 * writer outside the app port (the theme, src/theme/ThemeContext.tsx) waits
 * for `afterAppStorageLoad()`, so it never writes while the app port's load
 * runs. In wave 3 that load only READS the kv file (the copy goes into the
 * row file), but a corrupt kv text is still copied into the kv file right
 * after it, and the wave-2 port (no row database) still copies forward with
 * an exclusive transaction on a second connection during its load.
 */
import { Platform } from 'react-native';

import type { DataState } from '../../domain/types';
import { migrate } from '../migrate';
import { STORAGE_KEY } from '../persistence';
import type { StoragePort } from '../storagePort';
import { readLegacyAsyncStorage } from './asyncStoragePort';
import { createCopyForwardPort } from './copyForward';
import { getKvStore, KV_STATE_KEY, type KeyValueStore } from './kvStoragePort';
import { createMemoryPort } from './memoryPort';
import { EMPTY_REVLOG_STORE, type RevlogStore } from './revlogStore';
import { createRowPort, openRowDb, type RowDb } from './rowStore';
import { rescueRkStorage } from './rkRescue';

export { createAsyncStoragePort, readLegacyAsyncStorage } from './asyncStoragePort';
export {
  createCopyForwardPort,
  KV_COPIED_FROM_KEY,
  LegacyReadError,
  readCopiedFrom,
  type CopiedFrom,
  type CopyForwardOptions,
  type CopySource,
  type LegacySources,
} from './copyForward';
export {
  classifyRaw,
  createKeyValuePort,
  createKvStoragePort,
  getKvStore,
  KV_CORRUPT_PREFIX,
  KV_DB_NAME,
  KV_STATE_KEY,
  writeCorruptBackupFile,
  type KeyValuePortOptions,
  type KeyValueStore,
} from './kvStoragePort';
export {
  copiedFromOf,
  readLegacyChain,
  readLegacyRaw,
  readStoreChain,
  type LegacyChainSources,
  type LegacyFound,
  type LegacySource,
  type RowCopiedFrom,
  type StoreRead,
} from './legacyChain';
export { createMemoryPort, createMemoryStore, type MemoryPort, type MemoryStore } from './memoryPort';
export {
  assembleDoc,
  diffSize,
  diffState,
  emptyDiff,
  isEmptyDiff,
  ROW_TABLES,
  STORE_META_KEYS,
  type RowDiff,
  type RowTable,
} from './rowDiff';
export {
  cleanRevlogRow,
  createRevlogStore,
  EMPTY_REVLOG_STORE,
  revlogRowOf,
  type RevlogStore,
} from './revlogStore';
export {
  createMemoryRowDb,
  createRowPort,
  openRowDb,
  ROW_LAYOUT_VERSION,
  ROWS_DB_NAME,
  RowStoreError,
  sqliteRowDb,
  type MemoryRowDb,
  type MemoryRowSnapshot,
  type RowDb,
  type RowPort,
  type RowPortOptions,
  type RowPortStats,
  type SqlDatabase,
  type SqlRunner,
} from './rowStore';
export { rescueRkStorage, RK_FILES, RK_RESCUE_DIR } from './rkRescue';

/** The quiet banner of the web preview (spec §3.7, decision D6). Exact copy. */
export const WEB_PREVIEW_NOTICE = 'Web preview — nothing is saved.';

/** True when the app state lives only in memory on this platform (the web preview). */
export function isMemoryOnlyStorage(os: string = Platform.OS): boolean {
  return os === 'web';
}

/** Everything the platform choice needs. The app passes the real pieces; tests pass fakes. */
export interface StoragePortDeps {
  /** `Platform.OS`: 'android', 'ios', 'web', … */
  os: string;
  /** The clock, for the stamps of corrupt copies and of `maranki.copiedFrom`. */
  now: () => number;
  /** The kv-store. A function, so the web preview never opens the kv file. */
  kv: () => KeyValueStore;
  /** Read the old AsyncStorage document (read only). Rejects when the read fails. */
  readAsyncStorage: () => Promise<string | null>;
  /** The RKStorage rescue. Used on Android ONLY; resolves null on any failure. */
  rescue: () => Promise<string | null>;
  /** Where a corrupt text is copied as a file. Default: `writeCorruptBackupFile`. */
  corruptFile?: (raw: string, stamp: string) => void | Promise<void>;
  /**
   * Open the row database (the app: `openRowDb`). Given → the row store
   * (wave 3) with the legacy chain. Left out → the wave-2 kv port.
   */
  rows?: () => Promise<RowDb>;
  /** The row port's decode of a loaded document (the app: `decodedState`). See RowPortOptions.decode. */
  decode?: (doc: Record<string, unknown>) => object | null;
}

/**
 * A storage port, plus what only the row store has: the review history, the
 * boot counter (`markBootOk`), the first copy from the old storage
 * (`firstCopyPending`, which the engine reads at boot) and the highest seq of
 * the history table (`highestRevlogSeq`, which the engine reads on every
 * rating so a seq is never given twice), see RowPort.
 */
export type AppStoragePort<S = DataState> = StoragePort<S> & {
  readonly revlog?: RevlogStore;
  markBootOk?: () => Promise<void>;
  firstCopyPending?: () => boolean;
  highestRevlogSeq?: () => number;
};

/**
 * migrate()'s state for a loaded document, or null when migrate() gives
 * none (too new, not a Maranki document). The app row port's `decode`: the
 * SAME function the engine decodes with, so both agree on which rows the
 * integrity check set aside. May throw like migrate() (the port then keeps
 * every loaded row).
 */
export function decodedState(doc: unknown, now: number): object | null {
  const out = migrate(doc, now);
  return out.kind === 'ok' ? out.state : null;
}

/** The port for `deps.os`, built from the injected pieces. */
export function buildStoragePort<S = DataState>(deps: StoragePortDeps): AppStoragePort<S> {
  if (isMemoryOnlyStorage(deps.os)) return createMemoryPort<S>({ now: deps.now });
  // Only Android keeps AsyncStorage in the RKStorage SQLite file (§3.11).
  const rescue = deps.os === 'android' ? deps.rescue : undefined;
  if (deps.rows) {
    const kv = deps.kv();
    return createRowPort<S>({
      open: deps.rows,
      kv,
      legacy: {
        readKv: () => kv.getItem(KV_STATE_KEY),
        readAsyncStorage: deps.readAsyncStorage,
        rescue,
      },
      now: deps.now,
      corruptFile: deps.corruptFile,
      decode: deps.decode,
    });
  }
  return createCopyForwardPort<S>({
    kv: deps.kv(),
    legacy: { readAsyncStorage: deps.readAsyncStorage, rescue },
    now: deps.now,
    corruptFile: deps.corruptFile,
  });
}

/**
 * A new storage port for this platform: the row store on a phone. `now`
 * stamps corrupt copies and `copiedFrom`. The two AsyncStorage sources read
 * the old key `maranki.state.v1` (STORAGE_KEY): the rescue gets it
 * explicitly, so the test can see it.
 */
export function createStoragePort<S = DataState>(now: () => number = Date.now): AppStoragePort<S> {
  return buildStoragePort<S>({
    os: Platform.OS,
    now,
    kv: getKvStore,
    readAsyncStorage: () => readLegacyAsyncStorage(),
    rescue: () => rescueRkStorage(STORAGE_KEY),
    rows: openRowDb,
    decode: (doc) => decodedState(doc, now()),
  });
}

let appPort: StoragePort | null = null;
let appRevlog: RevlogStore | null = null;
let appMarkBootOk: (() => Promise<void>) | null = null;

/** The running load of the app port (it never rejects), or null. */
let loadRunning: Promise<void> | null = null;
/** Resolves once the app port's FIRST load has ended (well or not). */
let markFirstLoadDone: () => void = () => {};
const firstLoadDone = new Promise<void>((resolve) => {
  markFirstLoadDone = resolve;
});

/**
 * `port`, but every load() is watched: afterAppStorageLoad() waits for it.
 * Every other member of the port is kept as it is (the spread copies the
 * row port's own methods, `firstCopyPending` and `highestRevlogSeq` too, so
 * the engine still sees them).
 */
function watchLoads(port: AppStoragePort): AppStoragePort {
  return {
    ...port,
    load: () => {
      const loading = port.load();
      const ended = loading.then(
        () => undefined,
        () => undefined,
      );
      loadRunning = ended;
      void ended.then(() => {
        if (loadRunning === ended) loadRunning = null;
        markFirstLoadDone();
      });
      return loading;
    },
  };
}

/**
 * The app's one storage port, made on the first call. One instance matters on
 * the web preview: the memory port keeps the data in the port itself, so a
 * second port would see nothing.
 */
export function appStoragePort(): StoragePort {
  if (!appPort) {
    const port = createStoragePort();
    appRevlog = port.revlog ?? null;
    appMarkBootOk = port.markBootOk ?? null;
    appPort = watchLoads(port);
  }
  return appPort;
}

/**
 * Count one boot of the app that reached "ready": `meta.bootOkCount` + 1 in
 * the row store (spec §3.10 step 6; the old storage copies may be deleted
 * only in the release after bootOkCount ≥ 3 has shipped). Call it once,
 * after `engine.boot()` resolved a result that is NOT 'blocked'. A no-op on
 * the web preview (nothing is saved) and when the count of this boot is on
 * the disk already. Never rejects.
 *
 * DataContext.tsx calls it after the boot: `if (result.kind !== 'blocked') void markAppBootOk();`
 * (If a count cannot be written, the row port writes it with the next
 * commit, rowStore.ts.)
 */
export function markAppBootOk(): Promise<void> {
  appStoragePort();
  return appMarkBootOk ? appMarkBootOk() : Promise.resolve();
}

/**
 * The review history of the app's storage (the `revlog` table of the row
 * store). On the web preview nothing is saved, so it is always empty
 * (EMPTY_REVLOG_STORE).
 *
 * Example (CardSheet "History"): `const rows = await appRevlogStore().forCard(card.id);`
 */
export function appRevlogStore(): RevlogStore {
  appStoragePort();
  return appRevlog ?? EMPTY_REVLOG_STORE;
}

/**
 * Resolves when another writer may write to the kv file: after the app
 * port's FIRST load has ended (see the file comment), and while no other
 * load of it ("Try again") runs. Never rejects — a failed load ends the
 * wait too.
 *
 * It waits until the first load has STARTED and ended: the theme asks for it
 * on the first render, before DataProvider's effect starts the boot.
 *
 * Example (ThemeContext.tsx): `await afterAppStorageLoad(); await getKvStore().setItem(THEME_KEY, mode);`
 */
export async function afterAppStorageLoad(): Promise<void> {
  await firstLoadDone;
  while (loadRunning !== null) await loadRunning;
}
