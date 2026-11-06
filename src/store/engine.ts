/**
 * The engine (spec §3.9, units W2-1 → W3-2): the app's data layer without React.
 *
 *   const engine = createEngine(appStoragePort());
 *   await engine.boot();                       // load, migrate, reconcile (M5)
 *   engine.actions.rateCard(cardId, 'good');   // a pure reducer step
 *   engine.store.getState();                   // the newest state, at once
 *   await engine.flush();                      // save now (app goes to background)
 *   const saved = await engine.actions.flush(); // { ok: true } — or why not
 *
 * It joins three tested pieces:
 *   - the STORE (store.ts): the state, synchronous. `getState()` is never
 *     "one rating old", so actions always work on the newest state;
 *   - the REDUCER (reducer.ts): every state change is one pure command
 *     `(state, input, ctx) → { state, result }` on the v3 note model. The
 *     engine only runs them; it decides nothing about the data itself;
 *   - the PERSIST CONTROLLER (persistController.ts): when the state may be
 *     read and written (C1, the flush and debounce gates, M15, M16). It
 *     listens to the store OUTSIDE React (no effect, no render).
 *
 * Plus `meta`, a second small store with what the UI shows besides the data:
 * `ready`, `persistError` and `lastCompletion` (the Complete screen's payout).
 * And four things that are not data, so they live here and not in the
 * reducer: the in-memory undo tokens of deleteNotes, the deck image folders
 * (a deck copy at once, the images of moved cards and a removal only AFTER
 * the save commits), the highest
 * review-log seq given so far (so a seq is never given twice), and the dev
 * timings (perfMarks.ts).
 *
 * Boot (spec §3.10; the row store of W3-3 is the port on a phone):
 *   1. persist.load() — the port reads the stored data, and `decode` runs
 *      migrate() (schema 3). A document from an older schema is first
 *      copied to `backups/premigrate-v{from}-to-v{to}-{stamp}.json`.
 *      A read failure, a too-new document or a throwing migrate() → blocked:
 *      the seed stays in memory, nothing is ever written (C1).
 *   2. The loaded state (or the seed) goes into the store.
 *   3. The first boot of this build found the data in the OLD storage (the
 *      row port's `firstCopyPending()`): it is copied into the rows NOW, in
 *      one transaction with `meta.copiedFrom` (spec §3.10 step 3), not at
 *      the first change. So the next boot reads the rows, and does not read
 *      and migrate the old document again. A CORRUPT boot (a copy of the
 *      unusable data was kept) saves the seed now in the same way, so the
 *      next boot does not copy the same data again. A failed write is a
 *      write error like any other (M15): the next save tries again.
 *   4. M5: if a session was in flight when the app was killed, it is banked
 *      now — once per engine, and silently (no Complete screen).
 *   5. `ready` becomes true — ALWAYS, also when step 2, 3 or 4 throws (a bug):
 *      then boot() rejects with that error, so DataProvider can show the
 *      crash screen instead of a splash that never goes away.
 *
 * One engine per DataProvider: a new provider ("Try again") makes a new
 * engine. After dispose() the engine never writes again — until resume():
 * React may run the provider's effect cleanup and then its setup again on
 * the same component (StrictMode, Fast Refresh), and the setup resumes it.
 *
 * Type names: `DataState` (src/domain/types.ts) and `DataStateV3`
 * (src/domain/model.ts) are two names of the SAME type, the note model, so
 * no cast is ever needed between them. `actions` is exactly the §3.6 API
 * (actions.ts `Actions`); the temporary wave-3 aliases were removed in W5-3.
 */
import { imageRefs, isImageName, isSafeMediaName, renameImageRefs } from '../domain/import/mediaPlan';
import type * as v3 from '../domain/model';
import type { DeletedNotes } from '../domain/noteOps';
import { buildSeedState } from '../domain/seed';
import type { DataState } from '../domain/types';
import type { Actions, CompletionPayout, DataActions, FlushResult, PersistError } from './actions';
import { DEV_FREEZE, DEV_FREEZE_GUARDS, deepFreeze } from './devFreeze';
import { migrate, type MigrateOutcome } from './migrate';
import { perfMarks, type PerfMarks } from './perfMarks';
import {
  createPersistController,
  type BootResult,
  type DecodeResult,
  type PersistStatus,
  SAVE_DEBOUNCE_MS,
} from './persistController';
import { writePremigrateCopy } from './premigrate';
import * as R from './reducer';
import type { StoragePort } from './storagePort';
import { createStore, type Store } from './store';

/** What the UI shows besides the data itself. */
export interface EngineMeta {
  /** True once boot() finished — also when it ended blocked (the UI then shows the problem). */
  ready: boolean;
  /** The current storage problem (actions.ts `PersistError`), or null. */
  persistError: PersistError;
  /** The payout of the session just completed, for the Complete screen. Never set by the boot reconcile. */
  lastCompletion: CompletionPayout | null;
}

/** useData().actions: exactly the actions of spec §3.6 (actions.ts). */
export type EngineActions = DataActions;

/**
 * The deck image folders (`media/<deckId>`, relative to the app's document
 * folder). A card shows the images of the deck it is in. src/platform/media.ts
 * (W3-3) gives the real functions (deleteDeckMedia, mergeDeckMedia), and
 * DataContext passes them in. When the engine calls them: see "deck image
 * folders" in createEngine.
 *
 * What each one must do (the engine relies on it):
 *   - removeDeckFolder: delete the folder and every file in it. A missing
 *     folder is not an error.
 *   - copyDeckFolder: copy every file of `from` into `to` (make `to` when it
 *     is missing). A missing `from` is not an error (nothing to copy). A file
 *     that `to` already has is NEVER overwritten (the cards of `to` need it).
 *     Throw (or reject) when not every file of `from` is now in `to` — a disk
 *     error, or a file of the same name with other bytes: the engine then
 *     keeps the `from` folder, because it is the only copy of those images.
 *     `names` (optional) is given by "Move to deck…" (moveNotes): the image
 *     files that the moved cards show. Copy ONLY those (with the same
 *     never-overwrite rule, and throw when one that `from` has is not in
 *     `to`). WHY: copying the whole folder would fill `to` with images no
 *     card of it shows, and they count toward the backup's 50 MB image
 *     limit (over it, a backup holds no images at all). The phone's
 *     implementation (DataContext.tsx → media.ts mergeDeckMedia) does this.
 *     `renamed` (optional, from `imageNames`): copy the file `name` of
 *     `from` as `renamed.get(name)` into `to`, AND into `from` too (an Undo
 *     of the move puts the cards back in `from`, and their notes now name
 *     the new file).
 *   - imageNames (optional, synchronous): for the images of `from` (only
 *     `names`, or every file) that `to` already has under the same name with
 *     OTHER bytes, the name each one gets instead: free (or the same picture)
 *     in both folders (media.ts `moveImageNames`). The others are not in the
 *     map. The engine rewrites the moved notes' `<img src>` to those names in
 *     the same state change as the move, so a moved card never shows the
 *     other deck's picture of the same name.
 */
export interface DeckMedia {
  removeDeckFolder(deckId: v3.Id): void | Promise<void>;
  copyDeckFolder(
    fromDeckId: v3.Id,
    toDeckId: v3.Id,
    names?: readonly string[],
    renamed?: ReadonlyMap<string, string>,
  ): void | Promise<void>;
  imageNames?(fromDeckId: v3.Id, toDeckId: v3.Id, names?: readonly string[]): ReadonlyMap<string, string>;
}

/** The images that cards moved from one deck to another still show (see imagesToCopy). */
export interface ImageCopy {
  fromDeckId: v3.Id;
  toDeckId: v3.Id;
  /** The image file names (`<img src>`) of the moved notes' fields: safe names, no repeats, in field order. */
  names: string[];
  /** Files copied under another name (DeckMedia.imageNames): `to` has another picture under theirs. */
  renamed?: ReadonlyMap<string, string>;
}

/**
 * Which images must follow the cards of `noteIds` that changed deck between
 * `before` and `after` ("Move to deck…"). A card shows the images of the
 * folder of the deck it is in (`media/<deckId>/<name>`), so after a move its
 * `<img src="map.png">` must also be in the NEW deck's folder.
 *
 * One entry per (old deck → new deck) pair, with the image names of those
 * notes' fields. Names that are not safe file names (isSafeMediaName) or not
 * images are left out; a pair with no images is left out. Pure; one pass
 * over the cards and one over the notes.
 *
 *   note n1 in d1 shows <img src="map.png">; moveNotes(['n1'], 'd2')
 *   imagesToCopy(before, after, ['n1']) → [{ fromDeckId: 'd1', toDeckId: 'd2', names: ['map.png'] }]
 */
export function imagesToCopy(
  before: Pick<v3.DataStateV3, 'cards'>,
  after: Pick<v3.DataStateV3, 'cards' | 'notes'>,
  noteIds: readonly v3.Id[],
): ImageCopy[] {
  return movedImagePairs(before, after, noteIds).map((p) => p.copy);
}

/** imagesToCopy, with the notes that moved each way (the engine rewrites their `<img src>` when a name is taken). */
function movedImagePairs(
  before: Pick<v3.DataStateV3, 'cards'>,
  after: Pick<v3.DataStateV3, 'cards' | 'notes'>,
  noteIds: readonly v3.Id[],
): { copy: ImageCopy; noteIds: v3.Id[] }[] {
  if (noteIds.length === 0 || before.cards === after.cards) return [];
  const wanted = new Set(noteIds);
  const deckBefore = new Map<v3.Id, v3.Id>();
  for (const card of before.cards) if (wanted.has(card.noteId)) deckBefore.set(card.id, card.deckId);
  // "from→to" → the pair and the notes that moved that way.
  const pairs = new Map<string, { fromDeckId: v3.Id; toDeckId: v3.Id; notes: Set<v3.Id> }>();
  for (const card of after.cards) {
    const from = deckBefore.get(card.id);
    if (from === undefined || from === card.deckId) continue;
    const key = JSON.stringify([from, card.deckId]);
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { fromDeckId: from, toDeckId: card.deckId, notes: new Set() }));
    pair.notes.add(card.noteId);
  }
  if (pairs.size === 0) return [];
  const noteById = new Map<v3.Id, v3.Note>();
  for (const note of after.notes) if (wanted.has(note.id)) noteById.set(note.id, note);
  const out: { copy: ImageCopy; noteIds: v3.Id[] }[] = [];
  for (const pair of pairs.values()) {
    const names = imageNamesOf(pair.notes, noteById);
    if (names.length > 0) out.push({ copy: { fromDeckId: pair.fromDeckId, toDeckId: pair.toDeckId, names }, noteIds: [...pair.notes] });
  }
  return out;
}

/** The safe image names (`<img src>`) of some notes' fields, each once, in field order. */
function imageNamesOf(noteIds: Iterable<v3.Id>, noteById: ReadonlyMap<v3.Id, v3.Note>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const noteId of noteIds) {
    for (const field of noteById.get(noteId)?.fields ?? []) {
      for (const name of imageRefs(typeof field === 'string' ? field : '')) {
        if (seen.has(name) || !isSafeMediaName(name) || !isImageName(name)) continue;
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * The state with the `<img src>` of `noteIds` pointing at the names of
 * `renamed` (old → new), for notes whose cards moved into a deck whose
 * folder has another picture under the old name. Pure; the same state when
 * nothing changes.
 */
export function withRenamedImages(
  state: v3.DataStateV3,
  noteIds: readonly v3.Id[],
  renamed: ReadonlyMap<string, string>,
  now: number,
): v3.DataStateV3 {
  if (renamed.size === 0 || noteIds.length === 0) return state;
  const ids = new Set(noteIds);
  let changed = false;
  const notes = state.notes.map((note) => {
    if (!ids.has(note.id)) return note;
    const fields = note.fields.map((f) => renameImageRefs(f, (name) => renamed.get(name)));
    if (fields.every((f, i) => f === note.fields[i])) return note;
    changed = true;
    return { ...note, fields, updatedAt: now };
  });
  return changed ? { ...state, notes } : state;
}

export interface Engine {
  /** The app state (`DataState`, the note model). */
  readonly store: Store<DataState>;
  /** ready / persistError / lastCompletion. */
  readonly meta: Store<EngineMeta>;
  readonly actions: EngineActions;
  /**
   * Load the stored data (see the file comment). A second call gets the same
   * promise; after a blocked boot it tries again. Rejects after dispose(), and
   * with the error when the reconcile throws (`ready` is true even then).
   */
  boot(): Promise<BootResult<DataState>>;
  /** Save the newest state now (M16). The same function as `actions.flush`: resolves a FlushResult, never rejects. */
  flush(): Promise<FlushResult>;
  /** The persistence status: 'loading' | 'ready' | 'read-blocked'. */
  readonly status: PersistStatus;
  /** Stop: no new write after this (a write already queued still finishes). Call flush() first. */
  dispose(): void;
  /**
   * Undo dispose(): save changes again, from the newest state on. For a React
   * effect that runs setup → cleanup → setup on the same component. A no-op
   * when not disposed.
   */
  resume(): void;
}

export interface EngineOptions {
  /** The clock. Default Date.now. */
  now?: () => number;
  /** Fresh ids. Default `createNewId(now)` (`{prefix}-{time}-{counter}`). */
  newId?: (prefix: string) => string;
  /** Default SAVE_DEBOUNCE_MS (400). */
  debounceMs?: number;
  /** Deep-freeze every new state (devFreeze.ts). Default: on in development builds. */
  freeze?: boolean;
  /**
   * With `freeze`: also add the assignment guards (devFreeze.ts), so a plain
   * `card.flagged = true` throws in non-strict code too. They make every
   * read of the state slower. Default DEV_FREEZE_GUARDS: on, unless the
   * build sets EXPO_PUBLIC_DEV_FREEZE_GUARDS=0 (timing checks such as E2).
   */
  freezeGuards?: boolean;
  /** The schema migration. Default migrate(); tests inject one that throws. */
  migrateFn?: (doc: unknown, now: number) => MigrateOutcome;
  /**
   * Keep the raw text of an older-schema document before its first save in
   * the new schema (spec §3.1 rule 3). Default: `writePremigrateCopy` into
   * `Paths.document/backups/`. May throw: the migration is lossless, so a
   * missing copy does not stop the load.
   */
  preservePremigrate?: (raw: string, from: number, to: number, now: number) => void;
  /** The deck image folders. Absent = no folder is touched (tests). DataContext passes media.ts's. */
  media?: DeckMedia;
  /** Dev timings of boot, load and save. Default: the app's `perfMarks` (on in development builds). */
  perf?: PerfMarks;
}

/** How many deleteNotes undo tokens are kept (the snackbar shows only the newest). */
export const DELETE_TOKENS_KEPT = 20;

/* ---------------------------------------------------- reading a document */

/** What `readDocument` says about a stored document (migrate()'s outcome, in schema 3). */
export type DocumentOutcome =
  | { kind: 'ok'; state: v3.DataStateV3; from: number; repaired: string[] }
  | { kind: 'too-new'; version: number }
  | { kind: 'invalid' };

/**
 * A stored document → the v3 state (the engine's `decode`, and the round-trip
 * tests). It is migrate()'s outcome: since W3-1 the whole chain ends in
 * schema 3 (v2toV3 → checkIntegrity → sanitize → mergeDefaults, migrate.ts),
 * and a schema-3 document — which this engine writes itself — is never
 * 'too-new' for this build.
 *
 * migrate() may THROW: the caller treats that as a read error ('migrate'),
 * never as "corrupt" (spec §3.1 rule 7).
 */
export function readDocument(
  doc: unknown,
  now: number,
  migrateFn: (doc: unknown, now: number) => MigrateOutcome = migrate,
): DocumentOutcome {
  return migrateFn(doc, now);
}

/* ------------------------------------------------- compile-time checks */

type Assert<T extends true> = T;
/**
 * This type only compiles when useData().actions (`EngineActions`) offers
 * every action of spec §3.6 (`Actions`) with an assignable type. A test file
 * uses it, so a broken contract fails `tsc`.
 */
export type ActionsMatchSpec = Assert<EngineActions extends Actions ? true : false>;

/* ------------------------------------------------------------- the engine */

export function createEngine(port: StoragePort<DataState>, options: EngineOptions = {}): Engine {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? R.createNewId(now);
  const migrateFn = options.migrateFn ?? migrate;
  const preservePremigrate = options.preservePremigrate ?? defaultPreservePremigrate;
  const freezeOn = options.freeze ?? DEV_FREEZE;
  const guards = options.freezeGuards ?? DEV_FREEZE_GUARDS;
  const perf = options.perf ?? perfMarks;
  const media = options.media;

  const store = createStore<v3.DataStateV3>(buildSeedState(now()), {
    freeze: freezeOn ? (state) => deepFreeze(state, { guards }) : undefined,
  });
  const meta = createStore<EngineMeta>({ ready: false, persistError: null, lastCompletion: null });
  const setMeta = (patch: Partial<EngineMeta>) => meta.update((m) => ({ ...m, ...patch }));

  /** migrate() → schema 3 as the controller's decode, plus the pre-migration copy. */
  function decode(value: unknown, ctx: { raw?: string; now: number }): DecodeResult<v3.DataStateV3> {
    const out = readDocument(value, ctx.now, migrateFn); // a throw → read-blocked ('migrate')
    if (out.kind !== 'ok') return out;
    // A version jump: the document was older than what this build writes.
    const olderSchema = out.from < out.state.schemaVersion;
    if (olderSchema) {
      try {
        preservePremigrate(ctx.raw ?? JSON.stringify(value), out.from, out.state.schemaVersion, ctx.now);
      } catch {
        // Lossless step (legacy copies): a missing safety copy is no reason to stop.
      }
    }
    return {
      kind: 'ok',
      state: out.state,
      from: out.from,
      repaired: out.repaired,
      // True = the disk does not hold this state yet, so the first save
      // writes all of it (and the repair reaches the disk once). `repaired`
      // is not enough: migrate()'s mergeDefaults also fills MISSING keys and
      // lists none of that. So compare the state with the document as read.
      // A document from the OLD storage is not in the rows yet either (boot step 3).
      changed: olderSchema || out.repaired.length > 0 || firstCopyPending() || !sameJson(out.state, value),
    };
  }

  /** True while the port must still copy the old storage into the rows (rowStore.ts firstCopyPending). */
  function firstCopyPending(): boolean {
    return copiesForward(port) && port.firstCopyPending() === true;
  }

  const persist = createPersistController<v3.DataStateV3>(timedPort(port, perf), {
    now,
    decode,
    seed: buildSeedState,
    debounceMs: options.debounceMs ?? SAVE_DEBOUNCE_MS,
    onError: (error) => {
      setMeta({ persistError: error });
      // A save works again after a failed one: the moves and deck deletions
      // of the failed saves are on the disk now. First the moved cards'
      // images go to their new decks, THEN the folders of deleted decks go
      // (one of them may be the old deck those images come from).
      if (error === null) {
        copyWaitingImages();
        removeWaitingFolders();
      }
    },
  });

  // The persister listens OUTSIDE React. Before ready (and while
  // read-blocked) scheduleSave does nothing: that is the C1/debounce gate.
  const saveOnChange = () => persist.scheduleSave(store.getState());
  let unsubscribe = store.subscribe(saveOnChange);

  /* ------------------------------------------- the review-log seq */

  /*
   * The highest review-log `seq` this engine has seen in its state (and in
   * the history rows a restore writes, see replaceStored). rateCard
   * gets `minSeq` above it (see nextMinSeq), so a seq is never given twice —
   * also after an undo (reducer.ts RateCardInput.minSeq tells why: the
   * revlog row key). It is never lowered, not even by a restore or a factory
   * reset (a gap in the numbers is harmless; a repeat is not).
   *
   * The state alone is NOT enough: the port's history table can hold a
   * higher seq that the state does not have — a review-log entry that
   * migrate() removed at load (it had no usable card id) keeps its revlog row, and
   * so do the rows of a restored backup's history. So nextMinSeq also asks
   * the port (the row port's `highestRevlogSeq()`).
   *
   * This listener stays for the whole life of the engine (dispose() stops
   * only the saves): the store belongs to the engine, so nothing leaks.
   */
  let seqHighWater = 0;
  let seenLog: readonly v3.ReviewLogEntry[] | null = null;
  store.subscribe(() => {
    const log = store.getState().reviewLog;
    if (log === seenLog) return;
    seenLog = log;
    for (const entry of log) if (Number.isFinite(entry.seq) && entry.seq > seqHighWater) seqHighWater = entry.seq;
  });

  /**
   * The lowest seq the next rating may get: above every seq of the state
   * (seqHighWater) AND above every seq of the port's history table.
   *
   *   state log [1], revlog rows [1, 2] (entry 2 was removed by migrate())
   *   → nextMinSeq() = 3, so the new rating never writes over row 2.
   */
  function nextMinSeq(): number {
    const stored = keepsHistory(port) ? port.highestRevlogSeq() : 0;
    return Math.max(seqHighWater, Number.isFinite(stored) ? stored : 0) + 1;
  }

  /* ------------------------------------------------------ run a command */

  const ctx = (): R.ReducerCtx => ({ now: now(), newId });

  /**
   * Run one reducer command on the newest state, store the next state, and
   * return the command's result. The store is synchronous, so nothing can
   * change the state between `getState()` and `update()`.
   */
  function run<I, Res>(command: R.Command<I, Res>, input: I): Res {
    const step = command(store.getState(), input, ctx());
    store.update(() => step.state);
    return step.result;
  }

  /**
   * Replace everything stored (restore, factory reset). A failed write is
   * reported by the controller (onError('write') → persistError), the next
   * flush() RESOLVES that failure ({ ok: false, reason: 'write' }) and tries
   * again. So the rejection itself needs no handling here: a caller that must
   * know (the Restore flow) awaits `actions.flush()`.
   *
   * `history` = a restore's review-history rows: the port writes them in the
   * replace's own transaction (StoragePort.replaceAll). The next rating's seq
   * must be above them at once, also while that write waits or failed (its
   * retry writes them), so the high-water mark takes them now.
   */
  function replaceStored(state: v3.DataStateV3, history?: readonly v3.RevlogRow[]): void {
    for (const row of history ?? []) if (Number.isFinite(row.seq) && row.seq > seqHighWater) seqHighWater = row.seq;
    persist.replaceAll(state, history).catch(() => undefined);
  }

  /* ------------------------------------------------ deck image folders */

  /*
   * A deck's images live in `media/<deckId>`, and a card shows the images of
   * the deck it is in. The rule: a LEFT-OVER folder only costs disk space, a
   * MISSING one loses images that the saved data still shows. So:
   *   - a COPY may run before the save: duplicateDeck copies at once, and so
   *     does a deleteDeck that keeps or moves the cards (their images go with
   *     them to the new home deck). If that save fails, a later save stores
   *     the change, and the images are already there: nothing is lost. A copy
   *     is made only when the change can reach the disk (`persist.canSave`):
   *     a read-blocked engine (C1) touches no folder.
   *   - a REMOVAL waits until the save that removed the deck has committed.
   *     When that save fails, it waits for the next save that works
   *     (onError(null)). It never runs when writes are blocked, when the copy
   *     before it failed (the old folder is then the only copy), or when the
   *     deck is back in the state (a restore with the same deck id).
   *   - "Move to deck…" (moveNotes) copies the images that the moved cards
   *     show into the new deck's folder AFTER the move is on the disk, with
   *     the same never-overwrite merge as above (DeckMedia.copyDeckFolder,
   *     with the image names). The old folder is never removed by a move:
   *     the deck's other cards, and an Undo, still need it. Why after the
   *     commit: the target can be a deck that is not saved yet, and files
   *     written for a deck that never reaches the disk would stay in a folder
   *     no saved deck owns (W3-5 hardening). When that save fails, the copy
   *     waits for the next save that works (onError(null)), and it runs
   *     BEFORE the removals that waited too (the old deck may be one of
   *     them). A target deck that is gone by then gets no folder.
   *   - one name, one picture: when the new deck's folder already has a
   *     picture with OTHER bytes under the name a moved card shows
   *     (DeckMedia.imageNames), the moved notes' `<img src>` point at a name
   *     of its own in the SAME state change as the move (runMove, and
   *     deleteDeck), and the copy writes the file under that name. Before, the
   *     copy refused the file and the moved card showed the other picture.
   *   - every folder change runs on ONE promise chain, one after another, so
   *     a copy never meets a removal of the same folder half-way (duplicate a
   *     deck, then delete it at once).
   * A folder error never reaches the screen: the data is safe either way.
   */
  let mediaChain: Promise<void> = Promise.resolve();
  /** Deck ids whose folder removal waits for a save that works (their delete's save failed). */
  const removalsWaiting = new Set<v3.Id>();
  /** Image copies of moved cards that wait for a save that works (their move's save failed). */
  let copiesWaiting: ImageCopy[] = [];
  /** +1 at each restore or factory reset: a move in the library before it never copies into the new one. */
  let libraryNumber = 0;

  /** Run `task` after every folder change queued before it. Resolves true when it worked, false when it threw. */
  function queueMedia(task: () => void | Promise<void>): Promise<boolean> {
    const done = mediaChain.then(task).then(
      () => true,
      () => false,
    );
    mediaChain = done.then(() => undefined);
    return done;
  }

  /** Remove the deck's folder now (on the chain) — unless the deck is back in the state. */
  function removeFolder(deckId: v3.Id): void {
    if (!media) return;
    void queueMedia(() => {
      if (store.getState().decks.some((d) => d.id === deckId)) return;
      return media.removeDeckFolder(deckId);
    });
  }

  /**
   * Remove the deck's folder once the save that removed the deck is on the
   * disk, and only when `copied` (the copy of its images to the new home
   * deck, if any) worked.
   */
  function removeFolderAfterCommit(deckId: v3.Id, copied: Promise<boolean>): void {
    void Promise.all([persist.flush(), copied]).then(([saved, copyWorked]) => {
      if (!copyWorked) return;
      if (saved.ok) {
        removeFolder(deckId);
      } else if (saved.reason === 'write') {
        removalsWaiting.add(deckId);
        // A save may already have worked again in the meantime.
        if (persist.error === null) removeWaitingFolders();
      }
      // 'blocked' (C1, or the engine is gone): the deck is still on the disk, so is its folder.
    });
  }

  /** A save worked again: remove the folders that waited for it. */
  function removeWaitingFolders(): void {
    for (const deckId of removalsWaiting) removeFolder(deckId);
    removalsWaiting.clear();
  }

  /** Copy the images of moved cards into the new deck's folder now (on the chain) — unless that deck is gone. */
  function copyImages(copy: ImageCopy): void {
    if (!media) return;
    void queueMedia(() => {
      if (!store.getState().decks.some((d) => d.id === copy.toDeckId)) return;
      return copy.renamed && copy.renamed.size > 0
        ? media.copyDeckFolder(copy.fromDeckId, copy.toDeckId, copy.names, copy.renamed)
        : media.copyDeckFolder(copy.fromDeckId, copy.toDeckId, copy.names);
    });
  }

  /**
   * The names the images of `from` get in `to` when `to` holds another
   * picture under the same name (DeckMedia.imageNames). Empty when the
   * phone gives no such answer, or it throws (the copy then keeps the
   * never-overwrite rule: the old folder is kept).
   */
  function takenImageNames(from: v3.Id, to: v3.Id, names?: readonly string[]): ReadonlyMap<string, string> {
    if (!media?.imageNames || !persist.canSave) return new Map();
    try {
      return media.imageNames(from, to, names);
    } catch {
      return new Map();
    }
  }

  /**
   * Run a reducer step that moves cards to other decks, and in the SAME
   * state change point the moved notes' `<img src>` at a name of their own
   * where the new deck's folder has another picture under that name
   * (takenImageNames). So a moved card never shows the new deck's picture
   * of the same name. Returns the step's result and the image copies.
   */
  function runMove<I, Res>(
    command: R.Command<I, Res>,
    input: I,
    noteIds: readonly v3.Id[],
  ): { result: Res; copies: ImageCopy[] } {
    const before = store.getState();
    const c = ctx();
    const step = command(before, input, c);
    let state = step.state;
    const copies: ImageCopy[] = [];
    if (media && persist.canSave) {
      for (const pair of movedImagePairs(before, state, noteIds)) {
        const renamed = takenImageNames(pair.copy.fromDeckId, pair.copy.toDeckId, pair.copy.names);
        if (renamed.size === 0) {
          copies.push(pair.copy);
          continue;
        }
        state = withRenamedImages(state, pair.noteIds, renamed, c.now);
        copies.push({ ...pair.copy, renamed });
      }
    }
    store.update(() => state);
    return { result: step.result, copies };
  }

  /**
   * After a move (moveNotes): the images that the moved cards show follow
   * them to their new deck, once the move is on the disk (`copies`, from runMove).
   */
  function copyMovedImagesAfterCommit(copies: ImageCopy[]): void {
    if (!media || !persist.canSave) return; // read-blocked (C1): the move never reaches the disk
    if (copies.length === 0) return;
    const movedIn = libraryNumber;
    void persist.flush().then((saved) => {
      // A restore or a factory reset came in between: that move is not part of the library now.
      if (movedIn !== libraryNumber) return;
      if (saved.ok) {
        for (const copy of copies) copyImages(copy);
      } else if (saved.reason === 'write') {
        copiesWaiting.push(...copies);
        // A save may already have worked again in the meantime.
        if (persist.error === null) copyWaitingImages();
      }
      // 'blocked' (the engine is gone): the move is not on the disk, so nothing to copy.
    });
  }

  /** A save worked again: make the image copies that waited for it. */
  function copyWaitingImages(): void {
    const waiting = copiesWaiting;
    copiesWaiting = [];
    for (const copy of waiting) copyImages(copy);
  }

  /* ------------------------------------------ deleteNotes undo tokens */

  const deleted = new Map<string, DeletedNotes>();

  function keepDeleted(removed: DeletedNotes): string {
    const token = newId('del');
    if (removed.notes.length === 0) return token; // nothing to undo: the token finds nothing
    deleted.set(token, removed);
    while (deleted.size > DELETE_TOKENS_KEPT) deleted.delete(deleted.keys().next().value as string);
    return token;
  }

  /* --------------------------------------------------------------- boot */

  let booting: Promise<BootResult<v3.DataStateV3>> | null = null;
  let reconciled = false;
  let disposed = false;

  async function bootOnce(): Promise<BootResult<v3.DataStateV3>> {
    const started = perf.clock();
    const result = await persist.load();
    try {
      if (result.kind === 'blocked') {
        // Keep the seed in memory; nothing will be written (C1). Allow a retry.
        booting = null;
      } else {
        // Also after dispose(): a disposed engine writes nothing (no
        // persister, and the controller is stopped), and if resume() comes
        // later, the store must hold the loaded data, never the seed.
        store.update(() => result.state);
        // Boot step 3 (spec §3.10), one transaction before the app is ready:
        //   - 'loaded' from the OLD storage: copy it into the rows, with
        //     meta.copiedFrom;
        //   - 'corrupt': a copy of the unusable data is kept already, and the
        //     SEED replaces it on the disk now. Without this, a kill in the
        //     first 400 ms leaves the unusable data in place, and the next
        //     boot writes one more copy of it (up to ~3 MB each).
        // A genuine first boot (nothing stored anywhere) writes NOTHING here:
        // its seed is no user data, and it is saved with the first change
        // (the onboarding's first action). This is a recorded deviation from
        // spec §3.10 step 3 (W4-7): until that change, a later boot reads the
        // old places again, and a failed read there blocks writes (C1) —
        // with no data at risk, and "Try again" works.
        // The store update above queued the save; flush() writes it now
        // instead of in 400 ms. It never rejects: a failed write is reported
        // like any failed save (M15), and the next save tries again.
        if ((result.kind === 'loaded' && firstCopyPending()) || result.kind === 'corrupt') await persist.flush();
        // M5: bank a session the app was killed in. Once per engine, silent:
        // reconcileOnBoot never sets lastCompletion, so no Complete screen.
        if (!reconciled) {
          reconciled = true;
          run(R.reconcileOnBoot, undefined);
        }
      }
    } finally {
      // Always, even when the reconcile threw (a bug): a `ready` that never
      // comes would keep the splash screen up forever. boot() then rejects
      // with the error, and DataProvider shows the crash screen.
      setMeta({ ready: true });
      perf.mark('boot', perf.clock() - started, result.kind);
    }
    return result;
  }

  /* ------------------------------------------------------------ actions */

  /** Forget everything that belongs to the library being replaced (restore, factory reset). */
  function startOver(): void {
    setMeta({ lastCompletion: null });
    deleted.clear();
    // The new library may have decks with the same ids: never remove their
    // folders, and never copy the old library's moved images into them.
    removalsWaiting.clear();
    copiesWaiting = [];
    libraryNumber += 1;
    // A deliberate replace is the one way out of a read failure: the user
    // chose this data, so saving is allowed again.
    persist.unblockAfterReset();
  }

  const actions: EngineActions = {
    /* study */
    rateCard: (cardId, rating, opts) =>
      run(R.rateCard, {
        cardId,
        rating,
        kind: opts?.kind,
        durationMs: opts?.durationMs,
        minSeq: nextMinSeq(), // never a seq that an undo freed or that the history table holds
      }),
    undoLastReview: () => run(R.undoLastReview, undefined),
    completeSession: (args) => {
      const payout = run(R.completeSession, args);
      setMeta({ lastCompletion: payout });
      return payout;
    },
    clearLastCompletion: () => setMeta({ lastCompletion: null }),
    trackSession: (snapshot) => run(R.trackSession, { snapshot }),
    bury: (cardIds) => run(R.bury, { cardIds }).edit.id,

    /* card state: each returns the ManualEdit id for the snackbar Undo */
    setFlags: (cardIds, patch) => run(R.setFlags, { cardIds, patch }).edit.id,
    learn: (cardIds, opts) => run(R.learn, { cardIds, first: opts?.first }).edit.id,
    markKnown: (cardIds) => run(R.markKnown, { cardIds }).edit.id,
    setNotStarted: (cardIds) => run(R.setNotStarted, { cardIds }).edit.id,
    resetProgress: (cardIds) => run(R.resetProgress, { cardIds }).edit.id,
    reschedule: (cardIds, dueMs) => run(R.reschedule, { cardIds, dueMs }).edit.id,
    undoManualEdit: (editId) => run(R.undoManualEdit, { editId }),

    /* notes */
    addNote: (input) => run(R.addNote, input),
    editNote: (noteId, patch) => {
      run(R.editNote, { noteId, patch });
    },
    moveNotes: (noteIds, deckId, section) => {
      // The moved cards show `<img src>` files of their OLD deck's folder: copy them (after the
      // commit), under a name of their own where the new deck has another picture of that name.
      const { result, copies } = runMove(R.moveNotes, { noteIds, deckId, section }, noteIds);
      copyMovedImagesAfterCommit(copies);
      return result.edit.id;
    },
    tagNotes: (noteIds, add, remove) => run(R.tagNotes, { noteIds, add, remove }).edit.id,
    deleteNotes: (noteIds) => keepDeleted(run(R.deleteNotes, { noteIds })),
    undoDelete: (token) => {
      const removed = deleted.get(token);
      if (!removed) return false;
      deleted.delete(token);
      return run(R.undoDelete, { deleted: removed });
    },

    /* decks and card types */
    addDeck: (input) => run(R.addDeck, { input }),
    updateDeck: (deckId, patch) => run(R.updateDeck, { deckId, patch }),
    setDeckOptions: (deckId, patch) => run(R.setDeckOptions, { deckId, patch }),
    setDirections: (deckId, typeId, ords) => run(R.setDirections, { deckId, typeId, ords }),
    updateNoteType: (typeId, patch) => run(R.updateNoteType, { typeId, patch }),
    deleteDeck: (deckId, strategy) => {
      const before = store.getState();
      const c = ctx();
      const step = R.deleteDeck(before, { deckId, strategy }, c);
      const done = step.result;
      let state = step.state;
      // Kept or moved cards still show `<img src>` from this folder: their
      // images go with them first (at once), the old folder only after the commit.
      const home = done.deleted && media && persist.canSave ? done.movedTo : null;
      // A file the home deck has under the same name with OTHER bytes is
      // copied under a name of its own, and the moved notes point at it, in
      // the SAME state change as the delete. Before, the copy refused it, the
      // moved cards showed the home deck's picture, and the old folder stayed
      // with no deck that owns it.
      const renamed = home ? takenImageNames(deckId, home) : new Map<string, string>();
      if (home && renamed.size > 0) {
        const movedNotes = new Set(before.cards.filter((x) => x.deckId === deckId).map((x) => x.noteId));
        // Only notes whose cards are ALL in the home deck now (their pictures come from its folder).
        for (const x of state.cards) if (movedNotes.has(x.noteId) && x.deckId !== home) movedNotes.delete(x.noteId);
        state = withRenamedImages(state, [...movedNotes], renamed, c.now);
      }
      store.update(() => state);
      if (!done.deleted || !media || !persist.canSave) return;
      const copied = home
        ? queueMedia(() =>
            renamed.size > 0 ? media.copyDeckFolder(deckId, home, undefined, renamed) : media.copyDeckFolder(deckId, home),
          )
        : Promise.resolve(true);
      removeFolderAfterCommit(deckId, copied);
    },
    duplicateDeck: (deckId) => {
      const copy = run(R.duplicateDeck, { deckId });
      // At once, not after the commit: if this save fails, the copy is saved
      // by a later one, and its cards need the images then.
      if (copy && media && persist.canSave) void queueMedia(() => media.copyDeckFolder(deckId, copy.id));
      return copy;
    },
    reorderDecks: (deckIds) => run(R.reorderDecks, { deckIds }),

    /* import: one reducer step → one save */
    applyImport: (plan) => run(R.applyImport, { plan }),

    /* lists */
    saveList: (input) => run(R.saveList, { input }),
    deleteList: (id) => run(R.deleteList, { id }),
    setListPref: (id, pref) => run(R.setListPref, { id, pref }),

    /* settings */
    setGoals: (goalReviews, goalNew) => run(R.setGoals, { goalReviews, goalNew }),
    setLimits: (patch) => run(R.setLimits, { patch }),
    updateSrsSettings: (patch) => run(R.updateSrsSettings, { patch }),
    updateAppSettings: (patch) => run(R.updateAppSettings, { patch }),
    resetPreferences: () => run(R.resetPreferences, undefined),
    markOnboarded: () => run(R.markOnboarded, undefined),

    /* data */
    factoryReset: () => {
      startOver();
      run(R.factoryReset, undefined);
      // One replace-all write (it cancels the debounced save the change above
      // just scheduled). The old AsyncStorage copy is never deleted (spec
      // §3.1 rule 3); the stored document now holds the seed.
      replaceStored(store.getState());
    },
    restore: (next, history) => {
      startOver();
      // A backup went through migrate() (the Restore flow, backup.ts
      // readBackup), so it is schema 3 already — also an old backup.
      run(R.restoreState, { next });
      // Saved at once, not after the debounce; it wins over any waiting
      // change. The review history goes into the same transaction.
      replaceStored(store.getState(), history);
    },
    flush: () => persist.flush(),
  };

  return {
    store,
    meta,
    actions,
    boot() {
      if (disposed) return Promise.reject(new Error('Engine.boot: the engine was disposed'));
      if (!booting) booting = bootOnce();
      return booting;
    },
    flush: () => persist.flush(),
    get status() {
      return persist.status;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      persist.dispose();
    },
    resume() {
      if (!disposed) return;
      disposed = false;
      unsubscribe = store.subscribe(saveOnChange);
      persist.resume();
      // A change made while disposed was not scheduled: save the newest
      // state (no write when the disk holds it already, or before ready).
      saveOnChange();
    },
  };
}

/** The port with dev timings for its reads and writes (perfMarks.ts: 'load', 'save', 'replaceAll'). */
function timedPort(port: StoragePort<v3.DataStateV3>, perf: PerfMarks): StoragePort<v3.DataStateV3> {
  if (!perf.enabled) return port;
  return {
    load: () => perf.timeAsync('load', () => port.load()),
    save: (next, prev) => perf.timeAsync('save', () => port.save(next, prev)),
    replaceAll: (state, history) => perf.timeAsync('replaceAll', () => port.replaceAll(state, history)),
    preserveCorrupt: (raw) => port.preserveCorrupt(raw),
    readRaw: () => port.readRaw(),
  };
}

/**
 * True when `a` and `b` hold the same JSON data: the same keys with the same
 * values, in any key order. A key whose value is `undefined` counts as
 * missing (JSON.stringify drops it too).
 *
 * Fast for an intact document: two values that are the SAME object are equal
 * at once, without a walk.
 *
 *   sameJson({ a: 1, b: [2] }, { b: [2], a: 1 })  // true (order does not matter)
 *   sameJson({ limit: 20 }, { limit: null })      // false
 *   sameJson({ x: undefined }, {})                // true
 *
 * A wrong "false" only costs one full save; so when in doubt it says false.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJson(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightCount = Object.keys(right).filter((key) => right[key] !== undefined).length;
  if (leftKeys.length !== rightCount) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
}

/** A port that copies the old storage into its own at the first boot of a build (the row port, rowStore.ts). */
interface CopyForwardPort {
  firstCopyPending(): boolean;
}

/** True for a port with `firstCopyPending` (the row port). The other ports have nothing to copy. */
function copiesForward(port: StoragePort<DataState>): port is StoragePort<DataState> & CopyForwardPort {
  return 'firstCopyPending' in port && typeof port.firstCopyPending === 'function';
}

/** A port that keeps the review history in its own table (the row port, rowStore.ts). */
interface HistoryPort {
  highestRevlogSeq(): number;
}

/** True for a port with `highestRevlogSeq` (the row port). The other ports keep no history table. */
function keepsHistory(port: StoragePort<DataState>): port is StoragePort<DataState> & HistoryPort {
  return 'highestRevlogSeq' in port && typeof port.highestRevlogSeq === 'function';
}

/** The real pre-migration copy: a file in Paths.document/backups/. */
function defaultPreservePremigrate(raw: string, from: number, to: number, now: number): void {
  writePremigrateCopy(raw, from, to, now);
}
