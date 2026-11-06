/**
 * The store's commands as PURE functions, on the v3 NOTE MODEL (spec §3.6,
 * units W1-3 → W2-1 → W3-2). This file is the ONE place where the app state
 * changes: the engine (src/store/engine.ts) runs these functions for every
 * action of useData().actions, and reducer.test.ts pins their behaviour.
 *
 * Every command has the same shape:
 *
 *   command(state, input, ctx) → { state, result }
 *
 *   - `state`  the current DataStateV3. It is NEVER changed in place. A
 *              command builds new objects for what changes and keeps the old
 *              objects for the rest (a later save compares rows by object
 *              identity, spec §3.8).
 *   - `input`  what the screen passes, as ONE object with a named key for
 *              each value (for example `{ cardId, rating }`, or `{ patch }`).
 *   - `ctx`    the outside world: `now` (the clock) and `newId` (fresh ids).
 *              They come in as arguments, so a command is pure and a test can
 *              fix the time.
 *   - output   `{ state, result }`: the next state, plus the value the action
 *              returns to the screen (the rated card, a ManualEdit, the new
 *              deck…). `result` is `undefined` when the action returns nothing.
 *
 * The type `Command<I, R>` below is this shape. So the engine can run every
 * command in the same way: `command(state, input, ctx)`.
 *   - ctx is ALWAYS the third argument. A command that needs ctx but no input
 *     still has the input slot: `undoLastReview(state, _input: void, ctx)`.
 *   - A command may leave out its LAST parameters when it does not use them
 *     (for example `markOnboarded(state)`).
 *
 * Most commands are thin: the real rules live in tested pure modules, and
 * this file only joins them to the state:
 *   - triage.ts     learn, markKnown, setNotStarted, resetProgress, reschedule, setFlags
 *   - manualLog.ts  undoManualEdit (the undo of an edit made OUTSIDE a review)
 *   - noteOps.ts    addNote, editNote, moveNotes, tagNotes, deleteNotes,
 *                   restoreNotes, duplicateDeck, setDirections
 *   - lists.ts      saveList (makeListDef)
 *   - srs.ts        applyRating (the SM-2 step)
 *   - seed.ts       buildSeedState (the first-run state: factoryReset, resetPreferences)
 * What lives HERE: rateCard by bucket (new / review / check) and its undo,
 * the session payout (M5, M6, L10, M13, studyDay), applyImport, deck
 * deletion (no orphan), deck options and order, card types, lists and
 * settings. (The temporary wave-3 aliases of §3.6 were removed in W5-3:
 * every command here is a real §3.6 command.)
 *
 * Invariants kept here (spec §3.12): H3 (practice writes nothing but a day
 * roll-over), M3 (a new card uses only the new budget, plus its deck's
 * `newByDeck`), L10, M13, M5 (payout + marker clear in ONE state), M6
 * (`finalCard`), studyDay attribution, undo snapshots (incl. `knownAt` and
 * `newState`), "manual edits never break session undo" (manualLog and
 * reviewLog are separate), no-orphan deck delete.
 *
 * Not here: `clearLastCompletion`, the in-memory undo tokens of deleteNotes,
 * media folders, and the save gates (C1, flushSave, M15, M16). They change no
 * DataState: they live in the engine and the PersistController.
 */
import { levelInfo, MAX_FREEZES, newlyUnlocked, sessionXpItems, sessionXpTotal } from '../domain/gamification';
import { isBuiltinListId, makeListDef } from '../domain/lists';
import { editCards, type EditResult, undoManualEdit as undoEdit } from '../domain/manualLog';
import { makeDeck, nextDeckOrder } from '../domain/makeV3';
import type {
  AppSettings,
  Card,
  DataStateV3,
  DayDone,
  Deck,
  DeckOptions,
  FieldDef,
  FieldRole,
  Id,
  ImportPlan,
  ImportResult,
  InProgressSession,
  ListDef,
  ListPref,
  Note,
  NoteType,
  Person,
  Query,
  Rating,
  ReviewBucket,
  ReviewLogEntry,
  SessionKind,
  SessionRecord,
  SortSpec,
  SrsSettings,
} from '../domain/model';
import * as Notes from '../domain/noteOps';
import { buildSeedState } from '../domain/seed';
import { applyRating } from '../domain/srs';
import { plural } from '../domain/text';
import * as Triage from '../domain/triage';
import { clampLimits, dayKeyOf, LIMIT_RANGES } from '../domain/types';
import type { CompleteSessionArgs, CompletionPayout } from './actions';
import { type DeleteStrategy, resolveDeckDeletion } from './deckOps';
import { attributionDay, rollStreak, tallyReview, untallyReview } from './tally';

/** The review log keeps only the newest entries (enough for any session undo). */
export const REVIEW_LOG_CAP = 400;

/**
 * The allowed range of each daily limit (spec §8.6, "Study & limits"):
 * new cards 0–999; reviews 10–9,999, and "No limit" is stored as 99,999.
 * The rule lives in ONE place: `LIMIT_RANGES` and `clampLimits` in
 * src/domain/types.ts. The names below are the same values.
 */
export const DAILY_LIMIT_RANGES = LIMIT_RANGES;

/**
 * The smallest daily review limit setLimits accepts. A limit of 0 would hide
 * every review (spec §8.6: "goal 0 hides every review").
 */
export const MIN_DAILY_REVIEW_LIMIT = LIMIT_RANGES.dailyReviewLimit.min;

/* ------------------------------------------------------------- the shape */

/** What every command gets from outside: the clock and an id maker (the same shape as manualLog's OpCtx). */
export interface ReducerCtx {
  /** The current time, epoch ms. */
  now: number;
  /** A new unique id that starts with `prefix`, for example 'c-lx3k9q-12'. */
  newId: (prefix: string) => string;
}

/** The output of one command: the next state and the action's return value. */
export interface Step<R> {
  state: DataStateV3;
  result: R;
}

/**
 * The ONE shape of every command (spec §3.6). `I` is the input (`void` when
 * the command needs none), `R` is the result. The engine can then run any
 * command with one line: `const step = command(state, input, ctx)`.
 */
export type Command<I, R> = (state: DataStateV3, input: I, ctx: ReducerCtx) => Step<R>;

/**
 * The id maker the engine puts in `ReducerCtx.newId`: `{prefix}-{time in
 * base 36}-{counter}`. The counter makes two ids of the same millisecond
 * different; the time makes ids of different app launches different.
 */
export function createNewId(clock: () => number): (prefix: string) => string {
  let counter = 0;
  return (prefix) => {
    counter += 1;
    return `${prefix}-${clock().toString(36)}-${counter}`;
  };
}

/* ---------------------------------------------------------------- helpers */

/** A day tally that may come from an older shape (no `checks` / `newByDeck` yet). */
type DayDoneInput = Pick<DayDone, 'dayKey' | 'reviews' | 'neww'> & Partial<Pick<DayDone, 'checks' | 'newByDeck'>>;

/**
 * The person's day tally for the day of `now`: the stored one, or a new empty
 * one when the calendar day changed since the last write. A stored v3 tally of
 * today comes back as the SAME object (so practice keeps the same state, H3).
 * The ONE copy: DataContext.tsx re-exports it for the screens.
 */
export function normalizedDayDone(person: { dayDone: DayDoneInput }, now: number): DayDone {
  const today = dayKeyOf(now);
  const d = person.dayDone;
  if (d.dayKey !== today) return { dayKey: today, reviews: 0, neww: 0, checks: 0, newByDeck: {} };
  if (typeof d.checks === 'number' && d.newByDeck !== undefined) return d as DayDone;
  return { ...d, checks: d.checks ?? 0, newByDeck: d.newByDeck ?? {} };
}

/**
 * Does a session of this kind change the schedule? Practice (and the legacy
 * Cram) is free practice: it writes nothing (H3, spec §3.6).
 */
export function writesSchedule(kind: SessionKind): boolean {
  return !(kind === 'practice' || kind === 'cram');
}

/**
 * Which daily budget a rating of this card uses (spec §3.6):
 * a Known card → 'check'; a card never studied → 'new'; every other → 'review'.
 */
export function reviewBucket(card: Pick<Card, 'knownAt' | 'reps'>): ReviewBucket {
  if (card.knownAt != null) return 'check';
  return card.reps === 0 ? 'new' : 'review';
}

/**
 * The card's values before a rating, as the review log stores them (the
 * undo snapshot). The three optional keys (`knownAt`, `knownCheckedAt`,
 * `newState`) are stored only when the card has them, so undo can give the
 * card back its exact shape.
 */
export function scheduleOf(card: Card): ReviewLogEntry['prev'] {
  const prev: ReviewLogEntry['prev'] = {
    ease: card.ease,
    intervalDays: card.intervalDays,
    stepIndex: card.stepIndex,
    reps: card.reps,
    lapses: card.lapses,
    due: card.due,
    lastReviewedAt: card.lastReviewedAt,
  };
  if (card.knownAt !== undefined) prev.knownAt = card.knownAt;
  if (card.knownCheckedAt !== undefined) prev.knownCheckedAt = card.knownCheckedAt;
  if (card.newState !== undefined) prev.newState = card.newState;
  return prev;
}

/**
 * Put a snapshot back on a card. A rating may ADD `knownAt` / `knownCheckedAt`
 * (a Check), so a key the snapshot does not have is removed again.
 * (`newState` is never changed by a rating, so it is only restored.)
 */
function restorePrev(card: Card, prev: ReviewLogEntry['prev']): Card {
  const next: Card = { ...card };
  if (!('knownAt' in prev)) delete next.knownAt;
  if (!('knownCheckedAt' in prev)) delete next.knownCheckedAt;
  return { ...next, ...prev };
}

/** Local midnight at the start of the day after `now` (a buried card comes back then). */
export function startOfNextDay(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * The `seq` of the next review-log entry: the last one + 1 (monotonic inside
 * the log), and never below `minSeq` (see RateCardInput.minSeq).
 */
function nextSeq(log: readonly ReviewLogEntry[], minSeq: number | undefined): number {
  const floor = typeof minSeq === 'number' && Number.isFinite(minSeq) ? Math.ceil(minSeq) : 0;
  const last = log[log.length - 1]?.seq;
  if (typeof last === 'number' && Number.isFinite(last)) return Math.max(last + 1, floor);
  // Broken data: fall back to the largest seq in the log.
  let max = 0;
  for (const entry of log) if (Number.isFinite(entry.seq) && entry.seq > max) max = entry.seq;
  return Math.max(max + 1, floor);
}

/* ------------------------------------------------------------------ study */

export interface RateCardInput {
  cardId: Id;
  rating: Rating;
  /**
   * The session kind. It ALONE decides whether the rating changes the
   * schedule: 'practice' (and legacy 'cram') writes nothing (H3,
   * `writesSchedule`). No kind = a normal study rating.
   */
  kind?: SessionKind;
  /** Reveal → rate, in ms. Stored in the review log entry. */
  durationMs?: number;
  /**
   * The smallest `seq` the new review-log entry may get. A seq is also the
   * revlog row key (spec §3.8), so it must never be given twice. But
   * `last + 1` alone gives a seq again after an undo:
   *
   *   rate A → seq 5 (saved) → undo (pops 5) → rate B → seq 5 again
   *
   * and the next save then finds seq 5 in the saved state AND in the new one:
   * nothing is inserted, and the revlog keeps A instead of B. So the engine
   * passes the highest seq it has seen + 1 (engine.ts `seqHighWater`), and B
   * gets 6. Without it (a direct reducer call, as in most tests) the rule
   * is spec §3.6's `last + 1`.
   */
  minSeq?: number;
}

/**
 * The card after one rating, by bucket (spec §3.6):
 *   - 'new' / 'review': applyRating (SM-2);
 *   - 'check', Good/Easy: the Check is passed → `knownCheckedAt = now`; the
 *     card stays Known and its schedule is not touched;
 *   - 'check', Again/Hard: the Check is missed → not Known any more, and the
 *     card starts Learning: applyRating from step 0 (reps kept; lapses + 1
 *     when it was studied before).
 */
function rateByBucket(card: Card, bucket: ReviewBucket, rating: Rating, srs: SrsSettings, now: number): Card {
  if (bucket !== 'check') return applyRating(card, rating, srs, now);
  if (rating === 'good' || rating === 'easy') return { ...card, knownCheckedAt: now };
  const start: Card = {
    ...card,
    knownAt: null,
    knownCheckedAt: null,
    stepIndex: 0,
    lapses: card.reps > 0 ? card.lapses + 1 : card.lapses,
  };
  return applyRating(start, rating, srs, now);
}

/**
 * Rate one card. Returns the rated card (the session passes it as `finalCard`,
 * M6), the unchanged card for practice, or null when the card is gone.
 *
 *   - H3: practice changes nothing. The only write is a calendar roll-over of
 *     `dayDone` (a new day starts with an empty tally).
 *   - M3: the bucket decides the budget. 'new' → `neww + 1` and
 *     `newByDeck[deckId] + 1`; 'review' → `reviews + 1`; 'check' → `checks + 1`.
 *   - The card's values before the rating go into the review log (the undo
 *     snapshot), with `seq = last + 1` (and at least `input.minSeq`, so a seq
 *     is never given twice). The log keeps the newest REVIEW_LOG_CAP entries.
 */
export function rateCard(state: DataStateV3, input: RateCardInput, ctx: ReducerCtx): Step<Card | null> {
  const card = state.cards.find((c) => c.id === input.cardId);
  if (!card) return { state, result: null };

  const write = input.kind === undefined || writesSchedule(input.kind);
  const dayDone = normalizedDayDone(state.person, ctx.now);

  if (!write) {
    // Free practice touches neither the schedule nor the day's budgets. The
    // only possible write is a genuine calendar roll-over. Same day → the very
    // same state object.
    const next = state.person.dayDone === dayDone ? state : { ...state, person: { ...state.person, dayDone } };
    return { state: next, result: card };
  }

  const bucket = reviewBucket(card);
  const rated = rateByBucket(card, bucket, input.rating, state.settings.srs, ctx.now);
  const entry: ReviewLogEntry = {
    id: ctx.newId('rl'),
    seq: nextSeq(state.reviewLog, input.minSeq),
    cardId: card.id,
    deckId: card.deckId,
    rating: input.rating,
    atMs: ctx.now,
    bucket,
    prev: scheduleOf(card),
    ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? { durationMs: Math.round(input.durationMs) }
      : {}),
  };
  return {
    state: {
      ...state,
      cards: state.cards.map((c) => (c.id === card.id ? rated : c)),
      // slice(-399) keeps the newest 399, so the log is at most 400 with the new entry.
      reviewLog: [...state.reviewLog.slice(-REVIEW_LOG_CAP + 1), entry],
      // M3: the bucket decides the budget (tally.ts tallyReview, pinned by tally.test.ts).
      person: { ...state.person, dayDone: tallyReview(dayDone, { bucket, deckId: card.deckId }) },
    },
    result: rated,
  };
}

/**
 * Undo the LAST rating: put the card's old values back (incl. `knownAt`,
 * `knownCheckedAt`, `newState`), remove the log entry, and take the rating
 * out of today's tally by its bucket (`newByDeck` too; never below zero).
 * Returns false when there is nothing to undo (the state is unchanged).
 * It pops reviewLog ONLY: a manual edit (manualLog) is never taken back here.
 */
export function undoLastReview(state: DataStateV3, _input: void, ctx: ReducerCtx): Step<boolean> {
  const entry = state.reviewLog[state.reviewLog.length - 1];
  if (!entry) return { state, result: false };
  const dayDone = normalizedDayDone(state.person, ctx.now);
  return {
    state: {
      ...state,
      cards: state.cards.map((c) => (c.id === entry.cardId ? restorePrev(c, entry.prev) : c)),
      reviewLog: state.reviewLog.slice(0, -1),
      person: { ...state.person, dayDone: untallyReview(dayDone, { bucket: entry.bucket, deckId: entry.deckId }) },
    },
    result: true,
  };
}

/* ------------------------------------------------------ session completion */

/**
 * Everything completeSession decides, computed from a SNAPSHOT of the state.
 * applyPayout then writes it onto the LATEST state.
 *
 * Why two halves: the session's final rateCard and completeSession run in the
 * same tap. So a snapshot can be "stale by one rating". Each value here
 * depends only on what rateCard never changes (streak, xp, freezes,
 * achievements), so it stays right on a newer state. The values rateCard does
 * change (dayDone, cards) are read again from the latest state in applyPayout.
 */
export interface PayoutPlan {
  /** When the session was completed: the record's `atMs`. dayDone rolls over to this day. */
  now: number;
  /** The day the payout belongs to: the session's start day (studyDay attribution). */
  studyDay: string;
  /** The new session record. */
  session: SessionRecord;
  /** What the Complete screen shows. */
  payout: CompletionPayout;
  /** XP to add to the person. */
  xpTotal: number;
  /** The streak after this session (rollStreak, attributed to `studyDay`). */
  streak: number;
  /** Freezes after the streak roll and the achievement rewards (both capped, M13). */
  freezes: number;
  freezeUsedDays: string[];
  /** Fast answers of this session, to add to the lifetime count. */
  fastAnswers: number;
  /** Achievement id → unlock time, for the achievements this session unlocked. */
  achievements: Record<string, number>;
}

/**
 * The first half of completeSession: decide the payout from a snapshot.
 *
 *   - studyDay: the streak roll, the SessionRecord's day and `lastStudyDay`
 *     use the session's start day (`args.studyDay`), not the completion
 *     instant.
 *   - L10: the +10 daily-streak XP is paid only by the session that advanced
 *     the streak (the day's first one).
 *   - M6: `args.finalCard` replaces its stale copy in the snapshot before the
 *     mastery achievements are scored.
 *   - Mastery counts `isMastered` cards only: a Known card is never mastered
 *     (2,000 cards marked Known do not unlock Scholar).
 *   - M13: a freeze from an achievement never goes above MAX_FREEZES.
 *   - The record gets `mode` (when given) and `scopeLabel` = the label.
 *   - Practice is recorded and pays XP like any session (spec §6.6, D5).
 */
export function computePayout(
  snapshot: Pick<DataStateV3, 'person' | 'cards' | 'sessions'>,
  args: CompleteSessionArgs,
  ctx: ReducerCtx,
): PayoutPlan {
  const now = ctx.now;
  const studyDay = attributionDay(args.studyDay, now);
  const person = snapshot.person;

  const roll = rollStreak(person, studyDay);
  const streak = roll.streak;

  const xpItems = sessionXpItems(args.counts, args.total, args.bestRun, roll.advanced ? streak : 0);
  const xpTotal = sessionXpTotal(xpItems);
  const levelBefore = levelInfo(person.xp);
  const levelAfter = levelInfo(person.xp + xpTotal);

  const session: SessionRecord = {
    id: ctx.newId('s'),
    dayKey: studyDay,
    atMs: now,
    kind: args.kind,
    counts: args.counts,
    total: args.total,
    bestRun: args.bestRun,
    xp: xpTotal,
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(typeof args.label === 'string' ? { scopeLabel: args.label } : {}),
  };

  const finalCard = args.finalCard;
  const cards = finalCard ? snapshot.cards.map((c) => (c.id === finalCard.id ? finalCard : c)) : snapshot.cards;
  const projectedPerson: Person = {
    ...person,
    xp: person.xp + xpTotal,
    streak,
    bestStreak: Math.max(person.bestStreak, streak),
    fastAnswers: person.fastAnswers + args.fastAnswers,
  };
  // newlyUnlocked counts the mastered cards itself, with isMastered (gamification.ts).
  const unlocked = newlyUnlocked({
    person: projectedPerson,
    cards,
    sessions: [...snapshot.sessions, session],
    fastAnswers: projectedPerson.fastAnswers,
  });

  let freezes = roll.freezes;
  let freezeEarned = false;
  const achievements: Record<string, number> = {};
  for (const def of unlocked) {
    achievements[def.id] = now;
    if (def.grantsFreeze && freezes < MAX_FREEZES) {
      freezes += 1;
      freezeEarned = true;
    }
  }

  const accuracy = args.total === 0 ? 0 : Math.round(((args.total - args.counts.again) / args.total) * 100);

  const payout: CompletionPayout = {
    kind: args.kind,
    label: args.label,
    counts: args.counts,
    total: args.total,
    bestRun: args.bestRun,
    accuracy,
    durationSec: args.durationSec,
    xpItems,
    xpTotal,
    levelBefore,
    levelAfter,
    streakDays: streak,
    newAchievements: unlocked,
    freezeEarned,
  };

  return {
    now,
    studyDay,
    session,
    payout,
    xpTotal,
    streak,
    freezes,
    freezeUsedDays: roll.freezeUsedDays,
    fastAnswers: args.fastAnswers,
    achievements,
  };
}

/**
 * The second half of completeSession: write a plan onto the LATEST state.
 *
 * M5: the payout (person + SessionRecord) and the cleared in-flight marker
 * are ONE new state object, so one save writes both. The boot reconcile can
 * therefore never bank the same session twice.
 *
 * The person is rebuilt from `latest`, so the final rating's dayDone tally
 * (and any other change made after the snapshot) is kept.
 */
export function applyPayout(latest: DataStateV3, plan: PayoutPlan): DataStateV3 {
  const p = latest.person;
  return {
    ...latest,
    person: {
      ...p,
      xp: p.xp + plan.xpTotal,
      streak: plan.streak,
      bestStreak: Math.max(p.bestStreak, plan.streak),
      freezes: plan.freezes,
      freezeUsedDays: plan.freezeUsedDays,
      lastStudyDay: plan.studyDay,
      dayDone: normalizedDayDone(p, plan.now),
      fastAnswers: p.fastAnswers + plan.fastAnswers,
      achievements: { ...p.achievements, ...plan.achievements },
    },
    sessions: [...latest.sessions, plan.session],
    inProgressSession: null,
  };
}

/** Bank a finished (or partly finished) session: computePayout + applyPayout on the same state. */
export function completeSession(
  state: DataStateV3,
  args: CompleteSessionArgs,
  ctx: ReducerCtx,
): Step<CompletionPayout> {
  const plan = computePayout(state, args, ctx);
  return { state: applyPayout(state, plan), result: plan.payout };
}

/**
 * Save (or clear, with null) the snapshot of the session in flight. If the
 * app is killed before completeSession, the next boot banks it (M5).
 */
export function trackSession(state: DataStateV3, input: { snapshot: InProgressSession | null }): Step<void> {
  return { state: { ...state, inProgressSession: input.snapshot }, result: undefined };
}

/**
 * M5, run once after the saved data is loaded: if a session was in flight
 * when the app was killed, bank it now — completeSession with the stored
 * marker, which also clears the marker in the same state. So a second run
 * finds no marker and banks nothing.
 *
 * Silent: the result has no payout, so there is nothing to show.
 * It reads and writes only the person, the sessions and the marker.
 *
 * The marker's `mode` (wave 5h) is passed on, so the record gets the same
 * `mode` as a normal completion (computePayout). A marker saved before
 * wave 5h has no mode: its record has none either, and it banks exactly as
 * before. The marker has no final card (M6 needs none here: its last rating
 * is already in the saved cards).
 */
export function reconcileOnBoot(state: DataStateV3, _input: void, ctx: ReducerCtx): Step<{ banked: boolean }> {
  const marker = state.inProgressSession;
  if (!marker) return { state, result: { banked: false } };
  const args: CompleteSessionArgs = {
    kind: marker.kind,
    label: marker.label,
    counts: marker.counts,
    total: marker.total,
    bestRun: marker.bestRun,
    durationSec: marker.durationSec,
    fastAnswers: marker.fastAnswers,
    ...(marker.studyDay !== undefined ? { studyDay: marker.studyDay } : {}),
    ...(marker.mode !== undefined ? { mode: marker.mode } : {}),
  };
  return { state: completeSession(state, args, ctx).state, result: { banked: true } };
}

/**
 * Hide cards until the next local midnight ("Bury until tomorrow").
 *
 * Records ONE ManualEdit (kind 'bury', the `buriedUntil` before and after,
 * manualLog.ts `editCards`), so the session's snackbar "Undo" takes it back
 * like a Suspend or a Reschedule: `undoManualEdit` clears `buriedUntil` of
 * a card that is still buried until that midnight. (A bury had no Undo:
 * a mis-tap hid the card until tomorrow, and nothing could bring it back.)
 * It never reads or writes reviewLog, so a session undo still takes back the
 * last rating (spec §3.12). Unknown ids are ignored; a card already buried
 * until then changes nothing (the state is returned as it is, no edit).
 */
export function bury(state: DataStateV3, input: { cardIds: readonly Id[] }, ctx: ReducerCtx): Step<EditResult> {
  const until = startOfNextDay(ctx.now);
  return editCards(
    state,
    {
      cardIds: input.cardIds,
      kind: 'bury',
      plan: () => ({ buriedUntil: until }),
      label: (n) => `${plural(n, 'card')} buried until tomorrow`,
    },
    ctx,
  );
}

/* -------------------------------------------- card state (triage.ts) */

/*
 * Each one records ONE ManualEdit (manualLog.ts) and returns the EditResult:
 * the engine gives the screen `edit.id` for the snackbar "Undo". None of them
 * reads or writes reviewLog, so a session undo always takes back the last
 * rating (spec §3.12 "Manual edits never break session undo").
 */

/** Favorite / flag / suspend toggles. */
export function setFlags(
  state: DataStateV3,
  input: { cardIds: readonly Id[]; patch: Triage.FlagsPatch },
  ctx: ReducerCtx,
): Step<EditResult> {
  return Triage.setFlags(state, input, ctx);
}

/** Not started → New ("Learn"). `first`: these cards come first in their deck's feed. */
export function learn(state: DataStateV3, input: Triage.LearnInput, ctx: ReducerCtx): Step<EditResult> {
  return Triage.learn(state, input, ctx);
}

/** "I know it": knownAt = now. */
export function markKnown(state: DataStateV3, input: { cardIds: readonly Id[] }, ctx: ReducerCtx): Step<EditResult> {
  return Triage.markKnown(state, input, ctx);
}

/** "Move back to Not started": only cards with reps === 0 (the others are skipped and counted). */
export function setNotStarted(
  state: DataStateV3,
  input: { cardIds: readonly Id[] },
  ctx: ReducerCtx,
): Step<EditResult> {
  return Triage.setNotStarted(state, input, ctx);
}

/** "Reset progress…": back to New; Known and its Check are cleared. */
export function resetProgress(
  state: DataStateV3,
  input: { cardIds: readonly Id[] },
  ctx: ReducerCtx,
): Step<EditResult> {
  return Triage.resetProgress(state, input, ctx);
}

/** "Reschedule…": `due` only; interval and ease stay. */
export function reschedule(
  state: DataStateV3,
  input: { cardIds: readonly Id[]; dueMs: number },
  ctx: ReducerCtx,
): Step<EditResult> {
  return Triage.reschedule(state, input, ctx);
}

/**
 * Take back one ManualEdit (the snackbar "Undo"). Only the cards that still
 * have the edit's values are changed back (spec §3.6 "ManualEdit undo rule").
 */
export function undoManualEdit(
  state: DataStateV3,
  input: { editId: string },
  ctx: ReducerCtx,
): Step<{ reverted: number; skipped: number }> {
  const step = undoEdit(state, input, ctx);
  return { state: step.state, result: { reverted: step.result.reverted, skipped: step.result.skipped } };
}

/* ------------------------------------------------------- notes (noteOps.ts) */

/**
 * Add one note and its cards (one per enabled direction; cloze: per cloze
 * number). `noteId: ''` and no card ids = nothing was added: the deck or the
 * card type does not exist, or `fields` has more values than the type.
 */
export function addNote(
  state: DataStateV3,
  input: Notes.AddNoteInput,
  ctx: ReducerCtx,
): Step<{ noteId: Id; cardIds: Id[] }> {
  const step = Notes.addNote(state, input, ctx);
  return { state: step.state, result: step.result ?? { noteId: '', cardIds: [] } };
}

/** New field values and/or tags. A cloze note keeps its cards in sync with the cloze numbers. */
export function editNote(
  state: DataStateV3,
  input: Notes.EditNoteInput,
  ctx: ReducerCtx,
): Step<Notes.EditNoteResult | null> {
  return Notes.editNote(state, input, ctx);
}

/** Move whole notes (ALL their cards) to a deck, optionally into a section. Records a ManualEdit. */
export function moveNotes(state: DataStateV3, input: Notes.MoveNotesInput, ctx: ReducerCtx): Step<EditResult> {
  return Notes.moveNotes(state, input, ctx);
}

/** Add and remove tags. Records a ManualEdit. */
export function tagNotes(state: DataStateV3, input: Notes.TagNotesInput, ctx: ReducerCtx): Step<EditResult> {
  return Notes.tagNotes(state, input, ctx);
}

/** Delete whole notes and all their cards. The result is what was removed (the engine keeps it for "Undo"). */
export function deleteNotes(state: DataStateV3, input: { noteIds: readonly Id[] }): Step<Notes.DeletedNotes> {
  return Notes.deleteNotes(state, input);
}

/** Put deleted notes back (the in-memory "Undo" of deleteNotes). True when at least one note came back. */
export function undoDelete(state: DataStateV3, input: { deleted: Notes.DeletedNotes }): Step<boolean> {
  const step = Notes.restoreNotes(state, input);
  return { state: step.state, result: step.result.restoredNotes > 0 };
}

/* ---------------------------------------------------- decks and card types */

/** What addDeck takes (spec §3.6). */
export interface AddDeckInput {
  name: string;
  icon?: string;
  desc?: string;
  defaultTypeId?: Id;
  language?: string;
  meaningLanguage?: string;
}

/**
 * Create an empty deck at the end of the deck list (`order`), made in the app
 * (`source: 'manual'`). A `defaultTypeId` that names no card type (in state,
 * or built in) is not used: the deck then gets the default, Basic.
 */
export function addDeck(state: DataStateV3, input: { input: AddDeckInput }, ctx: ReducerCtx): Step<Deck> {
  const given = input.input;
  const typeOk =
    given.defaultTypeId !== undefined && Notes.findNoteType(state, given.defaultTypeId, ctx.now) !== null;
  const deck = makeDeck(
    {
      id: ctx.newId(Notes.DECK_ID_PREFIX),
      name: given.name,
      icon: given.icon,
      desc: given.desc,
      defaultTypeId: typeOk ? given.defaultTypeId : undefined,
      language: given.language,
      meaningLanguage: given.meaningLanguage,
      order: nextDeckOrder(state.decks),
      source: 'manual',
    },
    ctx.now,
  );
  return { state: { ...state, decks: [...state.decks, deck] }, result: deck };
}

/** The deck keys updateDeck may change (spec §3.6). */
export const DECK_PATCH_KEYS = [
  'name',
  'icon',
  'desc',
  'active',
  'language',
  'meaningLanguage',
  'genderColors',
  'defaultTypeId',
  'defaultTypeChosen',
] as const satisfies readonly (keyof Deck)[];
export type DeckPatch = Partial<Pick<Deck, (typeof DECK_PATCH_KEYS)[number]>>;

/** Keys that may be removed with an explicit `undefined` ("clear the description"). */
const DECK_OPTIONAL_KEYS: ReadonlySet<string> = new Set([
  'desc',
  'language',
  'meaningLanguage',
  'genderColors',
  'defaultTypeId',
  'defaultTypeChosen',
]);

/**
 * Change some keys of one deck: name, icon, description, paused/active, the
 * languages, gender colours, the default card type (and `defaultTypeChosen`:
 * the learner chose it in the deck editor). Only these keys are
 * copied. An explicit `undefined` removes an optional key (the deck editor
 * clears a description this way); for name, icon and active it is ignored.
 *
 * Three values are checked (addDeck checks the card type in the same way):
 *   - a `name` that is not a text or is blank ('', '  ') is ignored: a deck
 *     always keeps a name the user can see;
 *   - a `defaultTypeId` that names no card type (in the state, or built in)
 *     is ignored: new cards of the deck would otherwise get no card type, and
 *     nothing would be added (addNote gives `noteId: ''`) without a word;
 *   - a `defaultTypeChosen` that is not true/false is ignored.
 */
export function updateDeck(state: DataStateV3, input: { deckId: Id; patch: DeckPatch }, ctx: ReducerCtx): Step<void> {
  const deck = state.decks.find((d) => d.id === input.deckId);
  if (!deck) return { state, result: undefined };
  const next: Record<string, unknown> = { ...deck };
  let changed = false;
  for (const key of DECK_PATCH_KEYS) {
    if (!(key in input.patch)) continue;
    const value = input.patch[key];
    if (value === undefined) {
      if (DECK_OPTIONAL_KEYS.has(key) && key in next) {
        delete next[key];
        changed = true;
      }
      continue;
    }
    if (key === 'name' && (typeof value !== 'string' || value.trim() === '')) continue;
    if (key === 'defaultTypeId' && (typeof value !== 'string' || Notes.findNoteType(state, value, ctx.now) === null)) {
      continue;
    }
    if (key === 'defaultTypeChosen' && typeof value !== 'boolean') continue;
    if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }
  if (!changed) return { state, result: undefined };
  const updated = next as unknown as Deck;
  return { state: { ...state, decks: state.decks.map((d) => (d === deck ? updated : d)) }, result: undefined };
}

/**
 * Change a deck's options (spec §3.4 DeckOptions): the per-deck new cap
 * (null = only the global limit; else a whole number ≥ 0), the new-card order,
 * the arrival state of new cards, the directions per card type, and the Known
 * checks switch. A value of the wrong kind is ignored; `directions: undefined`
 * removes the list ("every ord that has cards").
 */
export function setDeckOptions(state: DataStateV3, input: { deckId: Id; patch: Partial<DeckOptions> }): Step<void> {
  const deck = state.decks.find((d) => d.id === input.deckId);
  if (!deck) return { state, result: undefined };
  const p = input.patch;
  const options: DeckOptions = { ...deck.options };
  if ('newPerDay' in p) {
    if (p.newPerDay === null) options.newPerDay = null;
    else if (typeof p.newPerDay === 'number' && Number.isFinite(p.newPerDay)) {
      options.newPerDay = Math.max(0, Math.round(p.newPerDay));
    }
  }
  if (p.newOrder === 'source' || p.newOrder === 'random') options.newOrder = p.newOrder;
  if (p.newArrival === 'queued' || p.newArrival === 'notStarted') options.newArrival = p.newArrival;
  if (typeof p.knownChecks === 'boolean') options.knownChecks = p.knownChecks;
  if ('directions' in p) {
    if (p.directions === undefined) delete options.directions;
    else if (p.directions && typeof p.directions === 'object') {
      const copy: Record<Id, number[]> = {};
      for (const [typeId, ords] of Object.entries(p.directions)) {
        if (!Array.isArray(ords)) continue;
        copy[typeId] = [...new Set(ords.filter((o) => Number.isInteger(o) && o >= 0))].sort((a, b) => a - b);
      }
      options.directions = copy;
    }
  }
  const same = JSON.stringify(options) === JSON.stringify(deck.options);
  if (same) return { state, result: undefined };
  const updated: Deck = { ...deck, options };
  return { state: { ...state, decks: state.decks.map((d) => (d === deck ? updated : d)) }, result: undefined };
}

/**
 * Turn directions on or off for one card type in one deck. Missing cards are
 * created as the deck's newArrival, or Not started when the item's other
 * never-studied cards are all Not started (noteOps.siblingArrival).
 */
export function setDirections(
  state: DataStateV3,
  input: Notes.SetDirectionsInput,
  ctx: ReducerCtx,
): Step<{ created: number }> {
  const step = Notes.setDirections(state, input, ctx);
  return { state: step.state, result: { created: step.result.created } };
}

const FIELD_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>([
  'term',
  'meaning',
  'example',
  'exampleMeaning',
  'pronunciation',
  'detail',
  'badge',
  'hidden',
]);
const FACET_MODES: ReadonlySet<FieldDef['facet']> = new Set<FieldDef['facet']>(['auto', 'on', 'off']);
const MULTI_SEPS: ReadonlySet<string> = new Set([',', ';', '|']);

/** One stored field with the allowed changes of `wanted` (the field NAME never changes: notes are aligned by it). */
function patchField(stored: FieldDef, wanted: FieldDef): FieldDef {
  const out: FieldDef = { ...stored };
  if (FIELD_ROLES.has(wanted.role)) out.role = wanted.role;
  if (FACET_MODES.has(wanted.facet)) out.facet = wanted.facet;
  if (typeof wanted.label === 'string' && wanted.label.trim() !== '') out.label = wanted.label;
  else delete out.label;
  if (typeof wanted.lang === 'string' && wanted.lang.trim() !== '') out.lang = wanted.lang;
  else delete out.lang;
  if (wanted.multiSep !== undefined && MULTI_SEPS.has(wanted.multiSep)) out.multiSep = wanted.multiSep;
  else delete out.multiSep;
  return out;
}

/**
 * Change a card type's name and its fields' roles, labels, languages and
 * filter-group override (the CardTypeSheet). The list of fields stays the
 * same: a `fields` patch with another length is ignored, and each field
 * keeps its name (the note values are aligned with the fields). A built-in
 * card type that is not in the state yet is written into it.
 */
export function updateNoteType(
  state: DataStateV3,
  input: { typeId: Id; patch: { name?: string; fields?: FieldDef[] } },
  ctx: ReducerCtx,
): Step<void> {
  const type = Notes.findNoteType(state, input.typeId, ctx.now);
  if (!type) return { state, result: undefined };
  let next: NoteType = type;
  const name = typeof input.patch.name === 'string' ? input.patch.name.trim() : '';
  if (name !== '' && name !== type.name) next = { ...next, name };
  const wanted = input.patch.fields;
  if (Array.isArray(wanted) && wanted.length === type.fields.length) {
    const fields = type.fields.map((f, i) => patchField(f, wanted[i]));
    if (JSON.stringify(fields) !== JSON.stringify(type.fields)) next = { ...next, fields };
  }
  const stored = state.noteTypes.includes(type);
  if (next === type && stored) return { state, result: undefined };
  const updated: NoteType = next === type ? type : { ...next, updatedAt: ctx.now };
  return {
    state: {
      ...state,
      noteTypes: stored ? state.noteTypes.map((t) => (t === type ? updated : t)) : [...state.noteTypes, updated],
    },
    result: undefined,
  };
}

/**
 * Delete a deck. NEVER leaves an orphan card (spec §3.12 "No-orphan"):
 *   - 'delete': the deck's cards go too, and so does every note that has no
 *     card left (a note always lives where its cards are);
 *   - 'move': the cards go to the target deck — only when the target is a
 *     real OTHER deck; else it acts like 'keep';
 *   - 'keep': the cards go to the "Unfiled cards" deck (made when needed).
 * A starter-pack entry that points at the deck is removed, so "Add starter
 * decks" can add it again.
 *
 * The result tells the engine what to do with the deck's image folder
 * (`media/<deckId>`), after the save:
 *   - `movedTo: null` — the cards are gone (or there were none): the folder
 *     can go;
 *   - `movedTo: <deck id>` — the cards live on in that deck, and their
 *     `<img src>` still need the files: the engine first copies the folder
 *     into that deck's folder, and only then removes the old one.
 *
 * The cards, decks and notes come from deckOps.resolveDeckDeletion: the ONE
 * no-orphan rule (spec §3.12), pinned by deckOps.test.ts. This step adds the
 * starter-pack entry and the image-folder result.
 */
export function deleteDeck(
  state: DataStateV3,
  input: { deckId: Id; strategy: DeleteStrategy },
  ctx: ReducerCtx,
): Step<DeleteDeckResult> {
  if (!state.decks.some((d) => d.id === input.deckId)) return { state, result: { deleted: false, movedTo: null } };
  const deckId = input.deckId;
  const { decks, cards, notes } = resolveDeckDeletion(state, deckId, input.strategy, ctx.now);
  const pack = withoutPackDeck(state.pack, deckId);
  // 'move' and 'keep' keep every card in its place, so the deck's first card
  // tells where its cards went. 'delete' removes them: nothing moved.
  const first = state.cards.findIndex((c) => c.deckId === deckId);
  const movedTo = input.strategy.kind === 'delete' || first < 0 ? null : (cards[first]?.deckId ?? null);
  return { state: { ...state, decks, cards, notes, pack }, result: { deleted: true, movedTo } };
}

/** What deleteDeck did, for the engine's image folders (see deleteDeck). */
export interface DeleteDeckResult {
  /** False when there was no such deck: nothing changed. */
  deleted: boolean;
  /** The deck the cards went to ('move' or 'keep'), or null: they were deleted too, or there were none. */
  movedTo: Id | null;
}

/** The pack record without the entries that point at `deckId` (the same object when none does). */
function withoutPackDeck(pack: DataStateV3['pack'], deckId: Id): DataStateV3['pack'] {
  if (!pack || !Object.values(pack.installed).includes(deckId)) return pack;
  const installed: Record<string, Id> = {};
  for (const [key, id] of Object.entries(pack.installed)) if (id !== deckId) installed[key] = id;
  return { ...pack, installed };
}

/** Copy a deck: new ids and guids, NO progress. null when the deck does not exist. */
export function duplicateDeck(state: DataStateV3, input: { deckId: Id }, ctx: ReducerCtx): Step<Deck | null> {
  return Notes.duplicateDeck(state, input, ctx);
}

/**
 * Put decks in a new order (the deck list and the new-card round robin). The
 * listed decks come first, in the given order; every other deck follows in
 * its current order. Only `order` changes; unknown ids are ignored.
 */
export function reorderDecks(state: DataStateV3, input: { deckIds: readonly Id[] }): Step<void> {
  const known = new Set(state.decks.map((d) => d.id));
  const listed = [...new Set(input.deckIds)].filter((id) => known.has(id));
  const listedSet = new Set(listed);
  const rest = state.decks
    .map((d, index) => ({ d, index }))
    .filter(({ d }) => !listedSet.has(d.id))
    .sort((a, b) => (a.d.order - b.d.order) || (a.index - b.index))
    .map(({ d }) => d.id);
  const position = new Map<Id, number>([...listed, ...rest].map((id, i) => [id, i]));
  let changed = false;
  const decks = state.decks.map((d) => {
    const order = position.get(d.id) as number;
    if (order === d.order) return d;
    changed = true;
    return { ...d, order };
  });
  return { state: changed ? { ...state, decks } : state, result: undefined };
}

/* ------------------------------------------------------------------ import */

/** Deck folder of a media entry ('media/<deckId>') → the deck id. */
function deckOfFolder(folder: string): Id {
  return folder.startsWith('media/') ? folder.slice('media/'.length) : folder;
}

/**
 * Apply an import plan (import/plan.ts) in ONE step, so one save writes all of
 * it (spec §3.6 "one reducer step → one save transaction").
 *
 * The plan was made from the library as it was when the preview opened. If
 * the library changed since, the step stays safe and the RESULT says what
 * really happened (the Done screen reads the result, never plan.summary):
 *   - a card type, note or card whose id is already in the state is not
 *     added twice (applying the same plan again adds nothing);
 *   - a new note is added only with at least one card, and a card only when
 *     its deck exists and its note has no card for that direction yet;
 *   - a new card of a note that was already in the library goes to the deck
 *     where that note's cards are NOW (all cards of a note stay in one deck);
 *   - an update of a note that was deleted since is skipped;
 *   - the new deck is added only when at least one card lands in it.
 * `result.deckId`: the new deck; else the deck the added cards went to; else,
 * when every note of the file that was already in the library was in one
 * target deck, that deck; else null. `result.media` lists only the folders of
 * decks that exist after the step.
 *
 * Card-type upgrades (`plan.noteTypes.upgrade`, a newer version of an Anki
 * model, plan.ts `upgradeNoteType`) come first. One is applied only while the
 * type still has the field names the plan was made from, and only when no
 * text is lost: a field the upgrade removes must be empty (noteOps
 * `fieldHasText`) in every note of the type that this plan does not update.
 * (The plan's updates are written in the new field order, so their values of
 * a removed field are gone on purpose: the newer version has no such field.)
 * Then EVERY note of the type gets its values moved to the new field order by
 * name (noteOps `remapFields`, a new field gets ''): the notes of the file,
 * and also the learner's own notes and the ones a newer file dropped, so
 * Note.fields stays aligned with NoteType.fields. A new note or an update
 * whose values do not fit its card type NOW (an upgrade that could not be
 * applied) is skipped.
 *
 * Retired notes (`plan.notes.retire`, starter deck updates): the note gets the
 * tag RETIRED_TAG and every card of it is suspended. Nothing is deleted, the
 * progress stays, and they do not count as updated.
 */
export function applyImport(state: DataStateV3, input: { plan: ImportPlan }, ctx: ReducerCtx): Step<ImportResult> {
  const plan = input.plan;
  const summary = plan.summary;

  // Card-type upgrades: only for a type that still has the planned field names,
  // and only when every field it removes is empty outside the plan's updates.
  const updatedIds = new Set(plan.notes.update.map((u) => u.id));
  const upgrades = new Map<Id, { from: string[]; type: NoteType }>();
  for (const u of plan.noteTypes.upgrade) {
    const current = state.noteTypes.find((t) => t.id === u.type.id);
    if (!current || upgrades.has(current.id)) continue;
    const from = current.fields.map((f) => f.name);
    const to = u.type.fields.map((f) => f.name);
    const asPlanned = from.length === u.fromFields.length && from.every((name, i) => name === u.fromFields[i]);
    if (!asPlanned) continue;
    const removed = from.map((name, i) => (to.includes(name) ? -1 : i)).filter((i) => i >= 0);
    const losesText =
      removed.length > 0 &&
      state.notes.some(
        (n) => n.typeId === current.id && !updatedIds.has(n.id) && removed.some((i) => Notes.fieldHasText(n.fields[i])),
      );
    if (losesText) continue;
    upgrades.set(current.id, { from, type: u.type });
  }

  // Card types: new ones (once each), plus a built-in type the first time a note uses it.
  const typeIds = new Set(state.noteTypes.map((t) => t.id));
  const noteTypes = upgrades.size > 0 ? state.noteTypes.map((t) => upgrades.get(t.id)?.type ?? t) : [...state.noteTypes];
  for (const t of plan.noteTypes.add) {
    if (typeIds.has(t.id)) continue;
    typeIds.add(t.id);
    noteTypes.push(t);
  }
  const typeKnown = (typeId: Id): boolean => {
    if (typeIds.has(typeId)) return true;
    const builtin = Notes.findNoteType({ noteTypes: [] }, typeId, ctx.now);
    if (!builtin) return false;
    typeIds.add(typeId);
    noteTypes.push(builtin);
    return true;
  };
  /** True when `fields` fits the card type `typeId` as it is after this step (an unknown type: no check). */
  const fitsType = (typeId: Id, fields: readonly string[]): boolean => {
    const type = noteTypes.find((t) => t.id === typeId);
    return type === undefined || type.fields.length === fields.length;
  };

  // The decks a card may land in: the existing ones, plus the plan's new deck.
  const deckIds = new Set(state.decks.map((d) => d.id));
  const newDeck = plan.deck && !deckIds.has(plan.deck.id) ? plan.deck : null;
  const landable = new Set(deckIds);
  if (newDeck) landable.add(newDeck.id);

  // The notes of an upgraded card type, moved to its new field order (all of them).
  // `lostText`: the notes whose text in a removed field the move dropped (only the
  // plan's updates can be such notes, see above): their update counts as a change
  // even when its values equal the moved note.
  const remapped = new Map<Id, Note>();
  const lostText = new Set<Id>();
  if (upgrades.size > 0) {
    for (const n of state.notes) {
      const up = upgrades.get(n.typeId);
      if (!up) continue;
      const to = up.type.fields.map((f) => f.name);
      const fields = Notes.remapFields(n.fields, up.from, to);
      const same = fields.length === n.fields.length && fields.every((v, i) => v === n.fields[i]);
      if (!same) remapped.set(n.id, { ...n, fields });
      if (up.from.some((name, i) => !to.includes(name) && Notes.fieldHasText(n.fields[i]))) lostText.add(n.id);
    }
  }

  // The library's notes (in their new field order) and the (note, ord) pairs and homes of their cards.
  const noteById = new Map(state.notes.map((n) => [n.id, remapped.get(n.id) ?? n]));
  const cardIds = new Set(state.cards.map((c) => c.id));
  const ordsOf = new Map<Id, Set<number>>();
  const homeOf = new Map<Id, { deckId: Id; ord: number }>();
  for (const c of state.cards) {
    const ords = ordsOf.get(c.noteId) ?? new Set<number>();
    ords.add(c.ord);
    ordsOf.set(c.noteId, ords);
    const home = homeOf.get(c.noteId);
    if (!home || c.ord < home.ord) homeOf.set(c.noteId, { deckId: c.deckId, ord: c.ord });
  }

  // New notes: those whose id is new, whose card type is known, and whose values fit it.
  const candidates = new Map<Id, Note>();
  for (const n of plan.notes.add) {
    if (noteById.has(n.id) || candidates.has(n.id) || !typeKnown(n.typeId) || !fitsType(n.typeId, n.fields)) continue;
    candidates.set(n.id, n);
  }

  // Cards: each must have its note, a deck that exists, and a free (note, ord).
  // A note that already has cards keeps them all in ONE deck: a new card goes
  // where its siblings are now (the first card of a new note sets that place).
  const cardsAdd: Card[] = [];
  const notesWithNewCards = new Set<Id>();
  for (const c of plan.cards.add) {
    if (cardIds.has(c.id)) continue;
    if (!candidates.has(c.noteId) && !noteById.has(c.noteId)) continue;
    const deckId = homeOf.get(c.noteId)?.deckId ?? c.deckId;
    if (!landable.has(deckId)) continue;
    const ords = ordsOf.get(c.noteId) ?? new Set<number>();
    if (ords.has(c.ord)) continue;
    ords.add(c.ord);
    ordsOf.set(c.noteId, ords);
    if (!homeOf.has(c.noteId)) homeOf.set(c.noteId, { deckId, ord: c.ord });
    cardIds.add(c.id);
    cardsAdd.push(deckId === c.deckId ? c : { ...c, deckId });
    notesWithNewCards.add(c.noteId);
  }
  // A new note without a card would be invisible in the Library: it is not added.
  const notesAdd = [...candidates.values()].filter((n) => notesWithNewCards.has(n.id));
  // Notes the plan wanted to add that are not added now. A note whose id is
  // already in the state was added before (the same plan again): not a skip.
  const droppedNotes = plan.notes.add.filter((n) => !noteById.has(n.id)).length - notesAdd.length;

  // Updates: fields and tags of notes that still exist (and values that fit their card type).
  const updated = new Map<Id, Note>();
  let unchangedNow = 0;
  for (const u of plan.notes.update) {
    const note = noteById.get(u.id);
    if (!note || updated.has(u.id) || !fitsType(note.typeId, u.fields)) continue;
    // A starter deck update may move the note to another section (ImportChoices.followSections).
    const section = typeof u.section === 'string' ? u.section : note.section;
    const same =
      !lostText.has(u.id) &&
      note.fields.length === u.fields.length &&
      note.fields.every((f, i) => f === u.fields[i]) &&
      note.tags.length === u.tags.length &&
      note.tags.every((t, i) => t === u.tags[i]) &&
      section === note.section;
    if (same) {
      unchangedNow += 1;
      continue;
    }
    updated.set(u.id, { ...note, fields: [...u.fields], tags: [...u.tags], section, updatedAt: ctx.now });
  }

  // Retired notes: the tag, and every card suspended (nothing is deleted). Only a change counts.
  const retagged = new Map<Id, Note>();
  const retiredIds = new Set<Id>();
  for (const id of plan.notes.retire) {
    const note = updated.get(id) ?? noteById.get(id);
    if (!note || retiredIds.has(id)) continue;
    retiredIds.add(id);
    if (!note.tags.includes(Notes.RETIRED_TAG)) {
      retagged.set(id, { ...note, tags: [...note.tags, Notes.RETIRED_TAG], updatedAt: ctx.now });
    }
  }
  const suspendedNotes = new Set<Id>();
  for (const c of state.cards) if (retiredIds.has(c.noteId) && c.suspended !== true) suspendedNotes.add(c.noteId);
  const notesRetired = [...retiredIds].filter((id) => retagged.has(id) || suspendedNotes.has(id)).length;

  // The new deck only when a card landed in it (never an empty phantom deck).
  const deckLanded = newDeck !== null && cardsAdd.some((c) => c.deckId === newDeck.id);
  const decks = deckLanded && newDeck ? [...state.decks, newDeck] : state.decks;
  const liveDecks = new Set(decks.map((d) => d.id));

  // What the Done screen shows.
  const deckNames = new Map(decks.map((d) => [d.id, d.name]));
  const updatedDeckIds: Id[] = [];
  let cardsUpdated = 0;
  for (const c of state.cards) {
    if (!updated.has(c.noteId)) continue;
    cardsUpdated += 1;
    if (!updatedDeckIds.includes(c.deckId)) updatedDeckIds.push(c.deckId);
  }
  const addedToDeck = cardsAdd.find((c) => candidates.has(c.noteId))?.deckId;
  const firstUpdated = updated.size > 0 ? homeOf.get([...updated.keys()][0])?.deckId : undefined;
  const deckId =
    (deckLanded && newDeck ? newDeck.id : undefined) ??
    addedToDeck ??
    (summary.inOtherDecks === 0 ? firstUpdated : undefined) ??
    null;
  // Notes of the plan that could not be added now (their deck or card type is
  // gone, or they got no card) count as "no card" skips.
  const skipped = { ...summary.skipped, empty: summary.skipped.empty + droppedNotes };

  const result: ImportResult = {
    deckId,
    deckCreated: deckLanded,
    notesAdded: notesAdd.length,
    cardsAdded: cardsAdd.length,
    notesUpdated: updated.size,
    notesUnchanged: summary.notesUnchanged + unchangedNow,
    cardsUpdated,
    updatedDecks: [...new Set(updatedDeckIds.map((id) => deckNames.get(id) ?? ''))],
    cardTypesUpdated: upgrades.size,
    notesRetired,
    notesSkipped: skipped.alreadyHere + skipped.elsewhere + skipped.overlap + skipped.empty,
    skipped,
    markedKnown: cardsAdd.filter((c) => c.knownAt != null).length,
    media: plan.media.filter((f) => liveDecks.has(deckOfFolder(f.deckFolder))).map((f) => ({ ...f, files: [...f.files] })),
  };

  if (cardsAdd.length === 0 && updated.size === 0 && upgrades.size === 0 && notesRetired === 0) return { state, result };
  // Card types: the ones already there (upgraded ones in their new form), plus the ones the added notes use.
  const usedTypes = new Set([...state.noteTypes.map((t) => t.id), ...notesAdd.map((n) => n.typeId)]);
  const typesChanged = upgrades.size > 0 || noteTypes.length !== state.noteTypes.length;
  // A note: retired (from its update, if any) > updated > moved to an upgraded type's field order > as it was.
  const noteChanged = updated.size > 0 || remapped.size > 0 || retagged.size > 0;
  const suspend = (c: Card): Card => (suspendedNotes.has(c.noteId) && c.suspended !== true ? { ...c, suspended: true } : c);
  const cards = suspendedNotes.size > 0 ? state.cards.map(suspend) : state.cards;
  return {
    state: {
      ...state,
      noteTypes: typesChanged ? noteTypes.filter((t) => usedTypes.has(t.id)) : state.noteTypes,
      decks,
      notes: [
        ...(noteChanged
          ? state.notes.map((n) => retagged.get(n.id) ?? updated.get(n.id) ?? remapped.get(n.id) ?? n)
          : state.notes),
        ...notesAdd,
      ],
      cards: cardsAdd.length > 0 ? [...cards, ...cardsAdd] : cards,
    },
    result,
  };
}

/* -------------------------------------------------------------------- lists */

/** What saveList takes: a new list (no id), or new values for a user list (its id). */
export interface SaveListInput {
  id?: Id;
  name: string;
  icon: string;
  query: Query;
  sort?: SortSpec;
}

/**
 * Save a user list ("Save as list", "Update list", "Rename"). The name is
 * trimmed and cut to 40 characters, the query loses its `list` key (lists.ts
 * `makeListDef`). Saving over an existing list keeps its id and createdAt.
 * Returns null (and changes nothing) for an empty name or a built-in list id
 * (built-in lists are code: only their prefs change, setListPref).
 */
export function saveList(state: DataStateV3, input: { input: SaveListInput }, ctx: ReducerCtx): Step<ListDef | null> {
  const given = input.input;
  if (given.id !== undefined && isBuiltinListId(given.id)) return { state, result: null };
  const existing = given.id !== undefined ? state.lists.find((l) => l.id === given.id) : undefined;
  const list = makeListDef(given, { now: ctx.now, newId: () => ctx.newId('list') }, existing);
  if (!list) return { state, result: null };
  const lists = existing ? state.lists.map((l) => (l === existing ? list : l)) : [...state.lists, list];
  return { state: { ...state, lists }, result: list };
}

/** Delete a user list (and its prefs). A built-in list cannot be deleted (hide it with setListPref). */
export function deleteList(state: DataStateV3, input: { id: Id }): Step<void> {
  if (isBuiltinListId(input.id)) return { state, result: undefined };
  const has = state.lists.some((l) => l.id === input.id);
  const hasPref = Object.prototype.hasOwnProperty.call(state.listPrefs, input.id);
  if (!has && !hasPref) return { state, result: undefined };
  const listPrefs: Record<string, ListPref> = {};
  for (const [id, pref] of Object.entries(state.listPrefs)) if (id !== input.id) listPrefs[id] = pref;
  return { state: { ...state, lists: state.lists.filter((l) => l.id !== input.id), listPrefs }, result: undefined };
}

/**
 * Change how a list shows: pinned on Today, hidden, its place. Works for user
 * lists and built-in lists. A list without prefs starts from "not pinned,
 * not hidden, at the end". Values of the wrong kind are ignored.
 */
export function setListPref(state: DataStateV3, input: { id: string; pref: Partial<ListPref> }): Step<void> {
  const own = Object.prototype.hasOwnProperty.call(state.listPrefs, input.id) ? state.listPrefs[input.id] : undefined;
  let maxOrder = -1;
  for (const p of Object.values(state.listPrefs)) if (Number.isFinite(p.order) && p.order > maxOrder) maxOrder = p.order;
  const base: ListPref = own ?? { pinned: false, hidden: false, order: maxOrder + 1 };
  const next: ListPref = { ...base };
  if (typeof input.pref.pinned === 'boolean') next.pinned = input.pref.pinned;
  if (typeof input.pref.hidden === 'boolean') next.hidden = input.pref.hidden;
  if (typeof input.pref.order === 'number' && Number.isFinite(input.pref.order)) next.order = input.pref.order;
  if (own && own.pinned === next.pinned && own.hidden === next.hidden && own.order === next.order) {
    return { state, result: undefined };
  }
  return { state: { ...state, listPrefs: { ...state.listPrefs, [input.id]: next } }, result: undefined };
}

/* --------------------------------------------------------------- settings */

/**
 * Set the daily goals (the bars on Today). A goal NEVER writes a limit: a
 * goal never blocks cards (spec §8.6).
 */
export function setGoals(state: DataStateV3, input: { goalReviews: number; goalNew: number }): Step<void> {
  return {
    state: { ...state, person: { ...state.person, goalReviews: input.goalReviews, goalNew: input.goalNew } },
    result: undefined,
  };
}

/** The two daily limits, as setLimits takes them. */
export type LimitsPatch = Partial<Pick<SrsSettings, 'dailyNewLimit' | 'dailyReviewLimit'>>;

/**
 * Make a limits patch safe. It IS `clampLimits` (types.ts), so DataContext and
 * the reducer can never use two different rules:
 *   - each limit is ROUNDED to a whole number (the launch count must equal
 *     the queue length);
 *   - then it is moved into its DAILY_LIMIT_RANGES range (5000 new → 999);
 *   - a missing, `undefined` or non-finite value is left out (the current
 *     limit stays).
 * Example: `{ dailyNewLimit: 2.5, dailyReviewLimit: 0 }` → `{ dailyNewLimit: 3, dailyReviewLimit: 10 }`.
 */
export const clampDailyLimits: (patch: LimitsPatch) => LimitsPatch = clampLimits;

/** Set the daily limits. Each value goes through clampDailyLimits. Goals are never touched. */
export function setLimits(state: DataStateV3, input: { patch: LimitsPatch }): Step<void> {
  const safe = clampDailyLimits(input.patch);
  return {
    state: { ...state, settings: { ...state.settings, srs: { ...state.settings.srs, ...safe } } },
    result: undefined,
  };
}

/** Change any SM-2 settings (learning steps, ease, multipliers, …). */
export function updateSrsSettings(state: DataStateV3, input: { patch: Partial<SrsSettings> }): Step<void> {
  return {
    state: { ...state, settings: { ...state.settings, srs: { ...state.settings.srs, ...input.patch } } },
    result: undefined,
  };
}

/** Change any app settings (read-aloud, haptics, session size, …). */
export function updateAppSettings(state: DataStateV3, input: { patch: Partial<AppSettings> }): Step<void> {
  return { state: { ...state, settings: { ...state.settings, ...input.patch } }, result: undefined };
}

/**
 * Settings → defaults ("Reset preferences"); the data is untouched. Two
 * settings keys are records, not preferences, so they stay: when the last
 * automatic backup was made, and whether the one-time reminder offer was seen.
 */
export function resetPreferences(state: DataStateV3, _input: void, ctx: ReducerCtx): Step<void> {
  const defaults = buildSeedState(ctx.now).settings;
  const settings: AppSettings = {
    ...defaults,
    lastAutoBackupAt: state.settings.lastAutoBackupAt,
    reminderOfferSeen: state.settings.reminderOfferSeen,
  };
  return { state: { ...state, settings }, result: undefined };
}

/** The first-run tour is done. */
export function markOnboarded(state: DataStateV3): Step<void> {
  return { state: { ...state, onboarded: true }, result: undefined };
}

/* ------------------------------------------------------------------- data */

/**
 * Replace EVERYTHING with `next` (a restored backup). Nothing of the old
 * state survives: restore is replace, never merge (spec §3.6, §3.8). The
 * caller runs migrate() on the backup first (spec §3.1 rule 5).
 */
export function restoreState(_state: DataStateV3, input: { next: DataStateV3 }): Step<void> {
  return { state: input.next, result: undefined };
}

/** Erase everything: back to the first-run state. */
export function factoryReset(_state: DataStateV3, _input: void, ctx: ReducerCtx): Step<void> {
  return { state: buildSeedState(ctx.now), result: undefined };
}
