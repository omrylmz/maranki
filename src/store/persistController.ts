/**
 * The persistence controller (spec §3.9, unit W1-2): every rule about WHEN the
 * app state may be read and written, as plain TypeScript with no React.
 *
 * WHY: these rules lived inside DataContext effects and refs (`canSaveRef`,
 * `readyRef`, the save timer), protected only by comments and device checks.
 * Each one fixed a real data-loss bug. Here they are one small object with
 * tests (persistController.test.ts, jest fake timers). It talks only to a
 * StoragePort (storagePort.ts), so it works with every backend.
 *
 * The engine (src/store/engine.ts, W2-1) uses it like this:
 *   const persist = createPersistController(port, { now: Date.now, seed, decode, onError });
 *   const boot = await persist.load();                 // once, at start
 *   store.subscribe(() => persist.scheduleSave(store.getState()));
 *   AppState 'background' → persist.flush();           // M16 (DataContext)
 *
 * Status:
 *   loading ──load ok──▶ ready
 *      └────load fails──▶ read-blocked ──unblockAfterReset()──▶ ready
 *   (load() may run again from read-blocked: "Try again".)
 *
 * The rules (each one is a test):
 *   - C1: a read that fails, a too-new document, or a migrate() that throws
 *     → 'read-blocked'. Nothing is ever written, so intact data on the disk is
 *     never replaced by the seed.
 *   - flushSave gate: flush() before ready writes nothing.
 *   - debounce gate: changes before ready are not saved.
 *   - debounce: many changes inside `debounceMs` (400 ms) → ONE save of the last state.
 *   - M16: flush() cancels the debounce and saves now.
 *   - flush() says what happened (W2 hardening): it resolves a FlushResult
 *     (actions.ts) — { ok: true } only when the NEWEST queued write committed
 *     (or there was nothing to write); { ok: false, reason: 'write' } when
 *     that write failed; { ok: false, reason: 'blocked' } when writes are not
 *     allowed. It still never rejects, so `void persist.flush()` is safe.
 *   - M15: a save that fails → onError('write'); the next save tries again.
 *   - corrupt: the unreadable text is copied away (preserveCorrupt) ONCE,
 *     then the seed is used AND saved after the debounce (like today's
 *     DataContext). So the next boot finds the seed, not the corrupt text, and
 *     does not copy the same text again. If no copy could be made → read-blocked.
 *   - one at a time: saves run one after another on one promise chain, never
 *     two at once. `prev` (the last state saved successfully) moves forward
 *     only after a save succeeds.
 *   - after a 'loaded' boot, `prev` IS the loaded state: the disk already
 *     holds it. So a row port (wave 3) writes only the rows that changed
 *     since the boot, not every row on the first save of every run. Only
 *     when decode says it CHANGED the document (`changed: true`) is `prev`
 *     null, so the first save writes everything in today's form. The
 *     controller trusts `changed`: the engine's decode sets it whenever its
 *     state differs from the document as read (a migrated older schema, a
 *     repaired value, a default filled in). A save of the very state that
 *     is on the disk already (`next === prev`) writes nothing.
 *   - a failed replaceAll() rejects for the caller AND is reported like a
 *     failed save (M15): onError('write'), and the next flush() tries again.
 *   - the gates are checked when a write is QUEUED, not when it runs. So
 *     dispose() stops new writes, but a write already on the chain still
 *     finishes: `persist.flush(); persist.dispose();` (a React cleanup, which
 *     cannot await) keeps the last change.
 *   - resume() undoes dispose(): React may run an effect's cleanup and then
 *     its setup AGAIN on the same component (StrictMode, Fast Refresh), so
 *     the same controller must be able to save again.
 *   - onError(null) whenever a problem ends: a save works again after a
 *     failed one, a load works after a blocked one ("Try again"), or
 *     unblockAfterReset() ends a block. So a UI that copies onError into
 *     React state never keeps showing an old problem.
 */
import type { RevlogRow } from '../domain/model';
import type { FlushResult, PersistError } from './actions';
import type { LoadResult, StoragePort } from './storagePort';

/** Wait this long after the last change before saving (today's DataContext value). */
export const SAVE_DEBOUNCE_MS = 400;

/* ------------------------------------------------ writes in flight (unit P4) */

/*
 * WHY: the dev timing of a save (perfMarks 'save', engine.ts timedPort) is
 * the time from the start of port.save() to its end. A save waits for the
 * native database several times; in those waits the JS thread runs other
 * timers — the Library's cache warm-up restarts 400 ms after new data, at
 * the same moment as this 400 ms save debounce, so its slice can run in the
 * middle of a save and is then counted as save time. `persistWrites` says
 * when a write runs, so that idle work can wait until it is done
 * (store/libraryWarmup.ts). It only WATCHES the writes: what is saved, and
 * when, does not change (every gate below is the same).
 *
 * Unit P4 review — what this does NOT explain: the warm-up's slice after a
 * rating was about 0.3 ms in the release build before P4 ("[perf] warm 0.3 ms
 * (1 of 16,260 cards)"; since P4 it also re-checks the Deck order, about
 * 1–4 ms in node --jitless), so it did not make the 25.5 / 43.5 / 42.0 ms saves of the release run. The
 * wait mainly keeps the warm-up's bigger parts (the note lookups and the
 * Deck order after an edit or an import: 20–75 ms of slices) out of a save.
 * The save's own JS work is about 0.6 ms in node --jitless; the rest of the
 * line is the native SQLite write and the load of the phone or emulator
 * (perfMarks.ts "WHAT 'save' MEASURES": the line names any GC and any other
 * line inside it).
 */

/** How many writes (save, replaceAll) of any controller are running now. */
let writesRunning = 0;
/** The listeners that wait for the moment no write runs any more. */
const idleListeners = new Set<() => void>();

function writeBegins(): void {
  writesRunning += 1;
}

function writeEnds(): void {
  writesRunning = Math.max(0, writesRunning - 1);
  if (writesRunning > 0) return;
  // Each waiting listener once. A throwing listener must never break a save.
  for (const listener of [...idleListeners]) {
    if (!idleListeners.delete(listener)) continue;
    try {
      listener();
    } catch {
      // Idle work failed to plan itself; the data rules must keep working.
    }
  }
}

/**
 * The app's storage writes, as idle work sees them (unit P4):
 *   busy()          true while a save or a replaceAll of any controller runs;
 *   onIdle(fn)      call `fn` ONCE, when no write runs any more (returns the
 *                   function that removes it).
 *
 *   if (persistWrites.busy()) off = persistWrites.onIdle(() => planNextSlice());
 */
export const persistWrites = {
  busy: (): boolean => writesRunning > 0,
  onIdle(listener: () => void): () => void {
    // A wrapper of its own, so two waits of one function are two.
    const once = () => listener();
    idleListeners.add(once);
    return () => {
      idleListeners.delete(once);
    };
  },
};

export type PersistStatus = 'loading' | 'ready' | 'read-blocked';

/**
 * Why writes are blocked: the PersistError values a LOAD can produce (same
 * words as PersistError in actions.ts). The ONE definition of this type;
 * persistence.ts re-exports it.
 */
export type BlockReason = Exclude<PersistError, 'write' | null>;

/**
 * What `decode` says about a parsed document. The shape fits migrate()'s
 * `MigrateOutcome` (spec §3.2), so the engine can pass migrate() straight in:
 *   decode: (doc, { now }) => migrate(doc, now)
 *   - ok      — use `state`. `changed: true` when `state` is NOT what the
 *               disk holds (an older schema was migrated, a value was
 *               repaired, or a missing or wrong-typed value got its
 *               default): then the first save writes everything. A decode
 *               that says `changed: false` for a state it did change makes
 *               a row port (wave 3) skip those rows until they change again.
 *   - too-new — saved by a newer app version → read-blocked ('too-new').
 *   - invalid — not a Maranki document → treated like a corrupt document.
 * If decode THROWS, it is a read error ('migrate'), never "corrupt" (§3.1 rule 7).
 */
export type DecodeResult<S> =
  | { kind: 'ok'; state: S; from?: number; repaired?: readonly string[]; changed?: boolean }
  | { kind: 'too-new'; version?: number }
  | { kind: 'invalid' };

/**
 * What load() does with a parsed document, after `decode` (the ONE place of
 * this rule; persistence.ts `decideLoad` uses it too):
 *   - decode THROWS        → blocked 'migrate' (a bug, never "corrupt": §3.1 rule 7);
 *   - decode says too-new  → blocked 'too-new' (§3.1 rule 6);
 *   - decode says invalid  → corrupt (a copy is kept, then the seed is used);
 *   - decode says ok       → use it.
 */
export type DocumentVerdict<S> =
  | { kind: 'ok'; decoded: Extract<DecodeResult<S>, { kind: 'ok' }> }
  | { kind: 'blocked'; reason: Extract<BlockReason, 'migrate' | 'too-new'>; cause?: unknown }
  | { kind: 'corrupt' };

/**
 * Run `decode` on a parsed document and say what it means (see
 * DocumentVerdict). Pure, never throws.
 *
 * Example: `judgeDocument((doc, { now }) => migrate(doc, now), JSON.parse(raw), { raw, now })`.
 */
export function judgeDocument<S>(
  decode: (value: unknown, ctx: DecodeContext) => DecodeResult<S>,
  value: unknown,
  ctx: DecodeContext,
): DocumentVerdict<S> {
  let decoded: DecodeResult<S>;
  try {
    decoded = decode(value, ctx);
  } catch (cause) {
    // A migrate() bug is a read error, never "corrupt": the data stays untouched.
    return { kind: 'blocked', reason: 'migrate', cause };
  }
  if (decoded.kind === 'too-new') return { kind: 'blocked', reason: 'too-new' };
  if (decoded.kind === 'invalid') return { kind: 'corrupt' };
  return { kind: 'ok', decoded };
}

export interface DecodeContext {
  /**
   * The stored text, when the port has it. The engine writes the pre-migration
   * copy from it before it migrates (spec §3.1 rule 3).
   */
  raw?: string;
  /** The time of this load. */
  now: number;
}

/** What load() found. The engine puts `state` in the store (except for 'blocked'). */
export type BootResult<S> =
  /** Nothing stored: a genuine first boot. `state` is the seed. */
  | { kind: 'first-boot'; state: S }
  /** A stored document, decoded. `from` = its schema version, `repaired` = what sanitize fixed. */
  | { kind: 'loaded'; state: S; from?: number; repaired: readonly string[] }
  /**
   * Stored but unreadable: a copy was kept (preserveCorrupt), `state` is the
   * seed. The controller saves this seed after `debounceMs` by itself (a
   * scheduleSave() or flush() before that saves the newer state instead), so
   * the corrupt text is replaced and the next boot does not copy it again.
   */
  | { kind: 'corrupt'; state: S }
  /** Writes are blocked. `raw` is the stored text when it is known (for "Save a copy of the raw data"). */
  | { kind: 'blocked'; reason: BlockReason; raw?: string; cause?: unknown };

export interface PersistControllerOptions<S> {
  /** The clock (a function, so tests pass a test clock). */
  now: () => number;
  /** Turn a parsed document into the state: migrate() in the app. */
  decode: (value: unknown, ctx: DecodeContext) => DecodeResult<S>;
  /** The state for a first boot or after a corrupt document: buildSeedState() in the app. */
  seed: (now: number) => S;
  /**
   * Called with every problem for the UI: 'read' | 'too-new' | 'migrate' when
   * writes become blocked, 'write' when a save fails. Called with `null` when
   * the problem is gone:
   *   - a save succeeds again after a failed one;
   *   - load() succeeds after a blocked load ("Try again"), before load() resolves;
   *   - unblockAfterReset() ends a block (factory reset).
   * While "Try again" is still loading, nothing is sent: the old reason stays.
   */
  onError?: (error: PersistError, cause?: unknown) => void;
  /** Default SAVE_DEBOUNCE_MS (400). */
  debounceMs?: number;
}

export interface PersistController<S> {
  readonly status: PersistStatus;
  /** True when a new save may be queued now: status is 'ready' and the controller is not disposed. */
  readonly canSave: boolean;
  /**
   * The current problem: the block reason while read-blocked (and while
   * "Try again" is loading after a block), 'write' while saves fail, else null.
   */
  readonly error: PersistError;
  /**
   * Read the stored state. A read or decode failure does NOT reject: it
   * resolves `{ kind: 'blocked' }`. A second call while loading gets the same
   * promise; a call after a blocked load tries again ("Try again"). It rejects
   * only when the state is already loaded (a bug in the caller).
   */
  load(): Promise<BootResult<S>>;
  /** Save `state` after `debounceMs` without new changes. A no-op unless canSave. */
  scheduleSave(state: S): void;
  /**
   * Save the newest unsaved state NOW (cancels the debounce) and wait for
   * every queued save. Resolves what happened (FlushResult): ok only when the
   * newest queued write committed. Writes nothing unless canSave (then it
   * resolves { ok: false, reason: 'blocked' }). Never rejects.
   */
  flush(): Promise<FlushResult>;
  /**
   * Replace everything stored with `state` (restore, factory reset). Rejects
   * when writes are blocked or the write fails. A failed write is ALSO
   * reported with onError('write'), and the next flush() saves `state` again.
   * `history` = the review-history rows of a restore, written in the same
   * transaction (StoragePort.replaceAll; the port keeps them for the retry).
   */
  replaceAll(state: S, history?: readonly RevlogRow[]): Promise<void>;
  /** Factory reset: the ONLY way out of 'read-blocked'. Sends onError(null). After it, the next save writes everything. */
  unblockAfterReset(): void;
  /**
   * Stop: cancel the debounce and never queue a new write. A change that only
   * waits in the debounce is dropped. A write that is already queued (by
   * flush(), replaceAll() or a debounce that already ran out) still finishes.
   * So call flush() first to keep the last change; it does not need an await:
   *   return () => { persist.flush(); persist.dispose(); };   // React cleanup
   */
  dispose(): void;
  /**
   * Undo dispose(): new writes may be queued again (the status, the last saved
   * state and every gate stay as they were). React may run an effect's
   * cleanup and then its setup again on the SAME component (StrictMode, Fast
   * Refresh); the setup calls this. A no-op when not disposed.
   */
  resume(): void;
}

export function createPersistController<S>(
  port: StoragePort<S>,
  options: PersistControllerOptions<S>,
): PersistController<S> {
  const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;

  let status: PersistStatus = 'loading';
  let error: PersistError = null;
  let disposed = false;
  /** The running load, so a second call gets the same promise. */
  let loading: Promise<BootResult<S>> | null = null;

  /** The last state the port saved SUCCESSFULLY (null = nothing yet → the port writes everything). */
  let lastSaved: S | null = null;
  /** The newest state that is not saved yet (null = nothing to save). */
  let pending: S | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Every write runs on this one chain, one after another. It never rejects. */
  let chain: Promise<void> = Promise.resolve();
  /** A number for each write put on the chain; the newest write has the highest. */
  let lastQueued = 0;
  /**
   * What the NEWEST write on the chain did (it resolves when that write ends,
   * and never rejects). flush() resolves it. The writes run one after
   * another, so when the newest one has ended, every older one has ended too.
   * Before the first write the disk holds what was loaded: nothing to report.
   */
  let lastWrite: Promise<FlushResult> = Promise.resolve(SAVED);

  const canSave = (): boolean => status === 'ready' && !disposed;

  /** Tell the UI. A throwing callback must never break the save chain. */
  function report(next: PersistError, cause?: unknown): void {
    try {
      options.onError?.(next, cause);
    } catch {
      // The UI callback failed; the data rules must keep working.
    }
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /* --------------------------------------------------------------- load */

  function block(reason: BlockReason, cause?: unknown, raw?: string): BootResult<S> {
    status = 'read-blocked';
    error = reason;
    cancelTimer();
    pending = null;
    report(reason, cause);
    return raw === undefined ? { kind: 'blocked', reason, cause } : { kind: 'blocked', reason, raw, cause };
  }

  /**
   * The load worked: saving is allowed from now on. `onDisk` is the state the
   * disk holds now (it becomes `prev` of the first save), or null when the
   * disk holds something else (nothing, a corrupt text, an older schema).
   */
  function becomeReady(onDisk: S | null): void {
    // `error` is not null only when an earlier load was blocked and this
    // "Try again" load worked: the block is over, so tell the UI.
    const blockEnded = error !== null;
    status = 'ready';
    error = null;
    lastSaved = onDisk;
    pending = null;
    if (blockEnded) report(null);
  }

  /** Keep a copy of an unreadable text, then use the seed. No copy → blocked (never write over it). */
  async function seedAfterCorrupt(raw: string, now: number): Promise<BootResult<S>> {
    try {
      await port.preserveCorrupt(raw);
    } catch (cause) {
      return block('read', cause, raw);
    }
    const state = options.seed(now); // before becomeReady(): a throwing seed() must not leave us writable
    becomeReady(null); // the disk still holds the corrupt text, not this seed
    // Save the seed over the corrupt text (a copy is kept now). Without this
    // save, the corrupt text stays in the live key, and EVERY boot takes this
    // path again and writes one more copy (up to ~3 MB each), until the user
    // changes something. It waits for the debounce like any change, so a
    // scheduleSave() or flush() right after boot just saves the newer state.
    if (canSave()) debounce(state);
    return { kind: 'corrupt', state };
  }

  async function readAndDecode(): Promise<BootResult<S>> {
    let stored: LoadResult;
    try {
      stored = await port.load();
    } catch (cause) {
      // C1: a FAILED read is not "nothing stored". Block every write.
      return block('read', cause);
    }
    const now = options.now();

    if (stored.kind === 'empty') {
      const state = options.seed(now);
      becomeReady(null); // nothing on the disk yet
      return { kind: 'first-boot', state };
    }
    if (stored.kind === 'corrupt') return seedAfterCorrupt(stored.raw, now);

    const verdict = judgeDocument(options.decode, stored.value, { raw: stored.raw, now });
    if (verdict.kind === 'blocked') return block(verdict.reason, verdict.cause, stored.raw);
    if (verdict.kind === 'corrupt') return seedAfterCorrupt(stored.raw ?? textOf(stored.value), now);
    const decoded = verdict.decoded;

    // The disk holds exactly this state, unless decode changed it (then the
    // first save must write all of it in today's form).
    becomeReady(decoded.changed ? null : decoded.state);
    return { kind: 'loaded', state: decoded.state, from: decoded.from, repaired: decoded.repaired ?? [] };
  }

  /* --------------------------------------------------------------- save */

  /** A successful write: the error (if any) is gone. */
  function clearWriteError(): void {
    if (error === 'write') {
      error = null;
      report(null);
    }
  }

  /**
   * One save on the chain. `order` is its number from writePending. Never rejects.
   *
   * It does NOT check `disposed`. The gates (ready, not disposed) are checked
   * when a write is QUEUED: in scheduleSave, flush and writePending. A save
   * runs one microtask (or one earlier save) later than it is queued, so a
   * check here would drop the last change of `persist.flush(); persist.dispose();`.
   */
  async function saveNow(next: S, order: number): Promise<FlushResult> {
    // Always true today: a write is queued only when ready, and once ready
    // the status never changes. Kept so that no write can ever run while
    // the stored data is not loaded or is blocked.
    if (status !== 'ready') return BLOCKED;
    // The disk holds this very state already (for example the state that was
    // just loaded): there is nothing to write.
    if (next === lastSaved) return SAVED;
    try {
      writeBegins();
      try {
        await port.save(next, lastSaved);
      } finally {
        writeEnds();
      }
      lastSaved = next;
      clearWriteError();
      return SAVED;
    } catch (cause) {
      // M15: tell the UI. `lastSaved` stays the same, so the next save sends
      // the full difference again. Remember the state, so the next flush()
      // tries again even without a new change — but ONLY when nothing newer
      // was queued or changed since: an old state must never be written over
      // a newer one. After dispose() nothing can write it, so do not keep it.
      if (!disposed && pending === null && order === lastQueued) pending = next;
      error = 'write';
      report('write', cause);
      return { ok: false, reason: 'write', cause };
    }
  }

  /** Remember `state` and save it after `debounceMs` without a new change. Callers check canSave() first. */
  function debounce(state: S): void {
    pending = state;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      void writePending();
    }, debounceMs);
  }

  /** Put the newest unsaved state on the chain. Returns what the newest write on the chain does. */
  function writePending(): Promise<FlushResult> {
    if (pending !== null && canSave()) {
      const next = pending;
      const order = ++lastQueued;
      pending = null;
      const done = chain.then(() => saveNow(next, order));
      lastWrite = done;
      chain = done.then(() => undefined);
    }
    return lastWrite;
  }

  return {
    get status() {
      return status;
    },
    get canSave() {
      return canSave();
    },
    get error() {
      return error;
    },

    load() {
      if (loading) return loading;
      if (status === 'ready') {
        return Promise.reject(new Error('PersistController.load: already loaded'));
      }
      // The first load, or "Try again" after a read-blocked load. On "Try
      // again", `error` keeps the old block reason until we know more: the UI
      // keeps showing the problem (no flicker). becomeReady() then sends null,
      // or block() sends the new reason.
      status = 'loading';
      loading = readAndDecode()
        // A bug in seed() or decode's caller must not leave the app writable.
        .catch((cause: unknown) => block('read', cause))
        .finally(() => {
          loading = null;
        });
      return loading;
    },

    scheduleSave(state) {
      // Debounce gate: before ready, while read-blocked, or after dispose,
      // a change is not saved (and not remembered for later).
      if (!canSave()) return;
      debounce(state);
    },

    flush() {
      // flushSave gate: before ready the in-memory state is not the user's data.
      if (!canSave()) return Promise.resolve(BLOCKED);
      cancelTimer(); // M16: save now, not in 400 ms
      // The NEWEST write's result: a failed restore (replaceAll) or save is
      // reported to the caller, not only to onError.
      return writePending();
    },

    replaceAll(state, history) {
      if (!canSave()) {
        return Promise.reject(new Error('PersistController.replaceAll: writes are blocked'));
      }
      // The replacement wins over every change that was waiting, and over
      // every older save that fails after this call (see saveNow).
      cancelTimer();
      pending = null;
      const order = ++lastQueued;
      const run = chain.then(async () => {
        try {
          writeBegins();
          try {
            await port.replaceAll(state, history);
          } finally {
            writeEnds();
          }
        } catch (cause) {
          // M15, like a failed save: tell the UI, and let the next flush()
          // try again with a normal save of `state` — unless something newer
          // was queued since. `lastSaved` stays: a failed transaction changed
          // nothing on the disk, so the next save still sends the whole
          // difference.
          if (!disposed && pending === null && order === lastQueued) pending = state;
          error = 'write';
          report('write', cause);
          throw cause;
        }
        lastSaved = state;
        clearWriteError();
      });
      // Keep the chain alive after a failure; the caller gets the rejection,
      // and a flush() after this call gets the result.
      lastWrite = run.then(
        (): FlushResult => SAVED,
        (cause: unknown): FlushResult => ({ ok: false, reason: 'write', cause }),
      );
      chain = lastWrite.then(() => undefined);
      return run;
    },

    unblockAfterReset() {
      if (status !== 'read-blocked' || disposed) return;
      status = 'ready';
      error = null;
      lastSaved = null; // nothing of the new state is on the disk yet
      pending = null;
      report(null); // the block is over (status was read-blocked, so `error` was a reason)
    },

    dispose() {
      // No new write after this. The chain is NOT cancelled: writes already
      // on it (from a flush() just before) still reach the disk.
      disposed = true;
      cancelTimer();
      pending = null;
    },

    resume() {
      // The change that dispose() dropped was saved by the flush() before it
      // (see dispose). The next scheduleSave() or flush() works again.
      disposed = false;
    },
  };
}

/** flush(): the newest state is on the disk. */
const SAVED: FlushResult = { ok: true };
/** flush(): writes are not allowed now, so nothing was written. */
const BLOCKED: FlushResult = { ok: false, reason: 'blocked' };

/** The text form of a parsed value, for a corrupt copy when the port gave no raw text. */
function textOf(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}
