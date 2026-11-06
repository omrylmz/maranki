/**
 * The store's action contracts — types only, no runtime code.
 *
 *   - `Actions`: the store API of spec §3.6. The engine (engine.ts)
 *     implements every one of them as a pure reducer step on the note model
 *     (reducer.ts).
 *   - `DataActions`: what `useData().actions` offers. It IS `Actions`, and
 *     nothing more: the temporary wave-3 aliases of spec §3.6 (the old flag,
 *     bury and card-patch actions, and the old card editor's and importer's
 *     actions) were removed in W5-3. A grep test (src/domain/scope.test.ts)
 *     keeps them out.
 *   - `CompleteSessionArgs`, `CompletionPayout`: what a session gives when it
 *     ends, and what the Complete screen shows.
 *   - `PersistError`: every reason the data layer can report to the UI.
 *   - `FlushResult`: what `flush()` resolves — saved, or why not.
 *
 * Every type here uses the live (v3) shapes of src/domain/model.ts. (Waves
 * 1–3 had a second, "screen-side" set of type names for the v2 shapes; since
 * W3-1 both sets were the same types, and W5-3 removed the second set.)
 */
import type { AchievementDef, LevelInfo, XpItem } from '../domain/gamification';
import type {
  AppSettings,
  Card,
  DataStateV3,
  Deck,
  DeckOptions,
  FieldDef,
  Id,
  ImportPlan,
  ImportResult,
  InProgressSession,
  ListDef,
  ListPref,
  Query,
  Rating,
  RevlogRow,
  SessionKind,
  SortSpec,
  SrsSettings,
  StudyMode,
} from '../domain/model';
import type { DeleteStrategy } from './deckOps';

/* ------------------------------------------------------------ session end */

/**
 * What a session gives `Actions.completeSession` when it ends. Two callers:
 *   - the session screen: its counts, its study day, the card `rateCard`
 *     returned last (`finalCard`, M6) and its study mode;
 *   - the boot reconcile (M5): the fields of the stored `InProgressSession`
 *     marker (its kind may be 'practice'; it has no final card; its `mode`
 *     only when the marker was saved from wave 5h on).
 *
 * How the `SessionRecord` is filled from these args: `kind` → `kind`,
 * `mode` → `mode`, `label` → `scopeLabel` (the label IS what was studied,
 * e.g. "German · Level A2", and the marker has it too, so a boot-reconciled
 * session keeps its scope label).
 */
export interface CompleteSessionArgs {
  /** 'practice' too: a practice session is recorded and pays XP (spec §6.6, D5). */
  kind: SessionKind;
  label: string;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  durationSec: number;
  fastAnswers: number;
  /**
   * The calendar day the session's reviews belong to (its start day). Threaded
   * from the session screen so the streak roll, SessionRecord and lastStudyDay
   * are attributed to the day the user studied — not completeSession's own
   * clock, which is a different day for a session finishing after local midnight
   * or one banked by the boot reconciler on a later day. Optional at runtime
   * (a legacy in-flight marker omits it → falls back to the completion instant).
   */
  studyDay?: string;
  /**
   * The session's final rated card: the value `Actions.rateCard` returned
   * (M6). The final rating and completeSession run in the same tap, so a
   * snapshot of the state can be "stale by one rating"; completeSession
   * scores the mastery achievements with this fresh card.
   */
  finalCard?: Card;
  /**
   * The study mode the session ran in, as the session screen knows it — not
   * `settings.studyMode`: 'article' exists only as a session mode, and
   * "Switch mode" (spec §6.5) can change it in the middle of a session. After
   * a switch, it is the mode the session ended in.
   * Written to `SessionRecord.mode` (the `mode` column of the history CSV,
   * §8.8). A boot-reconciled marker passes its own `mode` (the mode at its
   * last rating, wave 5h); an older marker has none, so that SessionRecord
   * has no mode either.
   */
  mode?: StudyMode;
}

/** The result of `Actions.completeSession`: what the Complete screen shows. */
export interface CompletionPayout {
  kind: SessionKind;
  label: string;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  accuracy: number;
  durationSec: number;
  xpItems: XpItem[];
  xpTotal: number;
  levelBefore: LevelInfo;
  levelAfter: LevelInfo;
  streakDays: number;
  newAchievements: AchievementDef[];
  freezeEarned: boolean;
}

/* ------------------------------------------------------------ persistence */

/**
 * Persistence health, shown to the user. null = all good.
 *   - 'read'    — the saved data could not be read. Every write is blocked, so
 *                 the intact data on disk is never overwritten (C1).
 *   - 'too-new' — the data was saved by a newer app version. Writes are blocked
 *                 (spec §3.1 rule 6).
 *   - 'migrate' — migrate() threw while updating the data. Writes are blocked;
 *                 it is never treated as "corrupt" (spec §3.1 rule 7).
 *   - 'write'   — a save failed. The next save tries again (M15).
 */
export type PersistError = 'read' | 'too-new' | 'migrate' | 'write' | null;

/**
 * What `flush()` tells the caller (W2 hardening). `flush()` never rejects:
 * it RESOLVES one of these, so a caller can tell "saved" from "not saved"
 * without a try/catch.
 *   - { ok: true }                     — the newest state is on the disk: every
 *                                        write that was queued has committed, or
 *                                        there was nothing new to write.
 *   - { ok: false, reason: 'blocked' } — writes are not allowed now (before the
 *                                        load, while read-blocked (C1), or after
 *                                        dispose). Nothing was written.
 *   - { ok: false, reason: 'write' }   — the newest write failed (M15). The UI
 *                                        also gets persistError 'write', and the
 *                                        next flush() tries the same state again.
 *                                        `cause` is the port's error.
 *
 * Example (the Restore flow, src/store/backup.ts `performRestore`):
 *   actions.restore(next, history);
 *   const saved = await actions.flush();
 *   if (!saved.ok) show(…);   // never "Restored — …" when the save failed
 */
export type FlushResult = { ok: true } | { ok: false; reason: 'blocked' | 'write'; cause?: unknown };

/* ------------------------------------------------ the store API (spec §3.6) */

/** The card keys `setFlags` may change: your own markers. */
type FlagPatchKey = 'fav' | 'flagged' | 'suspended';

/**
 * The patch of `setFlags`: favorite, flag and suspend — nothing else. The
 * `never` part makes every other card key a compile error, also inside a
 * wider value such as a `Partial<Card>` ("patch anything"): only rateCard
 * and the undo may write the schedule. (The deleted wave-3 flag alias had
 * this rule; W5-3 moved it here, so the real command keeps it.)
 *
 *   actions.setFlags(ids, { suspended: true });   // ok
 *   actions.setFlags(ids, { due: 0 });            // compile error
 *   const loose: Partial<Card> = { fav: true };
 *   actions.setFlags(ids, loose);                 // compile error
 *
 * At run time the reducer copies the three flag keys only (triage.ts
 * setFlags), so even a value forced past the type check cannot change more.
 */
export type SetFlagsPatch = Partial<Pick<Card, FlagPatchKey>> & { [K in Exclude<keyof Card, FlagPatchKey>]?: never };

/**
 * Every state change of the app. The engine implements each one as a pure
 * reducer step `(state, input, ctx: { now, newId }) => { state, result }`.
 * There is no "patch anything" action.
 *
 * Two return types differ from the spec's list (W3-2): `duplicateDeck` and
 * `saveList` return null when nothing could be made (the deck does not exist;
 * the list name is empty or the id is a built-in list). A made-up deck or list
 * would be worse, and a throw in a button handler would crash the app.
 */
export interface Actions {
  /* study */
  /**
   * Returns the rated card (the session passes it as `finalCard`, M6), or
   * null when the card is gone. The session `kind` decides whether the
   * rating changes the schedule: 'practice' (and the legacy 'cram') writes
   * nothing (H3, reducer.ts `writesSchedule`).
   */
  rateCard(cardId: Id, rating: Rating, opts?: { kind?: SessionKind; durationMs?: number }): Card | null;
  /** Pops reviewLog only (a manual edit never touches it). */
  undoLastReview(): boolean;
  /** Banks the session (M5: payout and marker clear in ONE state). Takes the marker as it is, too. */
  completeSession(args: CompleteSessionArgs): CompletionPayout;
  clearLastCompletion(): void;
  /**
   * Saves (or clears, with null) the marker of the session in flight (M5).
   * The session screen saves its `mode` in it too (wave 5h), so a session
   * banked by the boot reconcile keeps its mode in the record.
   */
  trackSession(snapshot: InProgressSession | null): void;
  /**
   * Hide cards until the next local midnight. Returns a ManualEdit id for the
   * snackbar Undo, like the card-state commands below (the session's "Bury
   * until tomorrow" · Undo).
   */
  bury(cardIds: Id[]): string;

  /* card state — every one returns a ManualEdit id for the snackbar Undo */
  /** Favorite / flag / suspend toggles (see SetFlagsPatch: no other key compiles). */
  setFlags(cardIds: Id[], patch: SetFlagsPatch): string;
  /** Not started → New. */
  learn(cardIds: Id[], opts?: { first?: boolean }): string;
  /** knownAt = now. */
  markKnown(cardIds: Id[]): string;
  /** Only cards with reps === 0. */
  setNotStarted(cardIds: Id[]): string;
  /** Back to New, knownAt cleared. */
  resetProgress(cardIds: Id[]): string;
  /** Sets `due` only; interval and ease are unchanged. */
  reschedule(cardIds: Id[], dueMs: number): string;
  undoManualEdit(editId: string): { reverted: number; skipped: number };

  /* notes */
  /** `noteId: ''` and no card ids = nothing was added (unknown deck or card type, or too many field values). */
  addNote(input: { deckId: Id; typeId: Id; fields: string[]; tags: string[]; section?: string }): {
    noteId: Id;
    cardIds: Id[];
  };
  /** Cloze: syncs the cards to the cloze numbers. */
  editNote(noteId: Id, patch: { fields?: string[]; tags?: string[] }): void;
  moveNotes(noteIds: Id[], deckId: Id, section?: string): string;
  tagNotes(noteIds: Id[], add: string[], remove: string[]): string;
  /** Returns an in-memory undo token (not persisted). */
  deleteNotes(noteIds: Id[]): string;
  undoDelete(token: string): boolean;

  /* decks and card types */
  addDeck(input: {
    name: string;
    icon?: string;
    desc?: string;
    defaultTypeId?: Id;
    language?: string;
    meaningLanguage?: string;
  }): Deck;
  updateDeck(
    deckId: Id,
    patch: Partial<
      Pick<
        Deck,
        'name' | 'icon' | 'desc' | 'active' | 'language' | 'meaningLanguage' | 'genderColors' | 'defaultTypeId' | 'defaultTypeChosen'
      >
    >,
  ): void;
  setDeckOptions(deckId: Id, patch: Partial<DeckOptions>): void;
  /** Creates missing cards as New (newPos = note.order). */
  setDirections(deckId: Id, typeId: Id, ords: number[]): { created: number };
  /** Roles, labels, lang, facet override. */
  updateNoteType(typeId: Id, patch: { name?: string; fields?: FieldDef[] }): void;
  /** No-orphan rule. Deletes the deck's media folder after the save commits. */
  deleteDeck(deckId: Id, strategy: DeleteStrategy): void;
  /** New ids and guids; progress NOT copied; media copied. null = no such deck. */
  duplicateDeck(deckId: Id): Deck | null;
  reorderDecks(deckIds: Id[]): void;

  /* import */
  /** One reducer step → one save transaction. */
  applyImport(plan: ImportPlan): ImportResult;

  /* lists */
  /** null = not saved (an empty name, or the id of a built-in list). */
  saveList(input: { id?: Id; name: string; icon: string; query: Query; sort?: SortSpec }): ListDef | null;
  deleteList(id: Id): void;
  setListPref(id: string, pref: Partial<ListPref>): void;

  /* settings */
  /** NEVER writes limits. */
  setGoals(goalReviews: number, goalNew: number): void;
  setLimits(patch: Partial<Pick<SrsSettings, 'dailyNewLimit' | 'dailyReviewLimit'>>): void;
  updateSrsSettings(patch: Partial<SrsSettings>): void;
  updateAppSettings(patch: Partial<AppSettings>): void;
  /** Settings → defaults; data untouched. */
  resetPreferences(): void;
  markOnboarded(): void;

  /* data */
  /**
   * REPLACE everything (one transaction). The caller runs migrate() first
   * (the Restore flow: backup.ts `readBackup`), so `state` is always schema 3
   * — also for a backup made by an old version (spec §3.1 rule 5).
   * `history` = the review history the restored library gets (the backup's
   * rows, or this phone's kept rows: backup.ts `restoreHistoryRows`). It is
   * written in the SAME transaction, so it is never lost between two writes.
   * Left out = the table keeps only the rows of `state.reviewLog`.
   */
  restore(state: DataStateV3, history?: readonly RevlogRow[]): void;
  factoryReset(): void;
  /**
   * Resolves after the save transaction commits, and says whether it did
   * (`FlushResult`; it never rejects).
   */
  flush(): Promise<FlushResult>;
}

/**
 * What `useData().actions` offers: exactly the store API of spec §3.6. (Until
 * W5-3 it also had the temporary wave-3 aliases.)
 */
export type DataActions = Actions;
