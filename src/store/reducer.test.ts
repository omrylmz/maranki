/**
 * The pure reducer on the v3 note model (spec §3.6, invariants table §3.12,
 * units W1-3 → W3-2). Each block pins one behaviour:
 *   - rateCard by bucket: 'new' (M3: the new budget + newByDeck), 'review',
 *     'check' (Known: Good/Easy passes, Again/Hard → Learning);
 *   - H3   practice (and legacy cram) writes nothing but a day roll-over;
 *   - undo per bucket restores the exact snapshot (knownAt, newState) and
 *     untallies the bucket (newByDeck too); the review log is capped at 400;
 *   - "reschedule, then session undo" reverts the RATING, not the reschedule;
 *   - L10, M13, M5 (payout and marker clear are ONE state), the boot
 *     reconcile banks a killed session exactly once, silently; studyDay;
 *     M6 (the final card that just became mastered counts); Known is never
 *     mastered; practice is recorded and pays XP (D5);
 *   - the card-state, note, deck, list and settings commands are wired to the
 *     pure modules (triage, manualLog, noteOps, lists);
 *   - no-orphan deck delete (notes left without cards go too);
 *   - applyImport = ONE step; its result equals the plan's summary, and
 *     stays true when the library changed since the plan;
 *   - restore replaces; setGoals never writes limits; setLimits rounds and
 *     clamps (launch count === queue length, with the one scheduler);
 *   - a review-log seq is never given twice when the engine passes its floor
 *     (rate → undo → rate gets a new seq);
 *   - updateDeck ignores a blank name and an unknown default card type;
 *   - every command has the one call shape `command(state, input, ctx)`,
 *     never changes its input, and keeps random states valid.
 */
import { describe, expect, it } from '@jest/globals';

import { BUILTIN_TYPE_IDS } from '../domain/builtinTypes';
import { detectOrdinal, fieldFacetSpecs } from '../domain/facets';
import { MAX_FREEZES, STREAK_BONUS } from '../domain/gamification';
import { collectionFromRows } from '../domain/import/apkgRead';
import { readCsv } from '../domain/import/csvRead';
import { planImport, positionalFieldDefs } from '../domain/import/plan';
import { isMastered, life } from '../domain/life';
import type {
  AnkiCollection,
  Card,
  DataStateV3,
  Deck,
  Id,
  ImportChoices,
  ImportPlan,
  InProgressSession,
  LifeKey,
  Note,
  NoteType,
  Rating,
  ScheduleCtx,
  SessionKind,
} from '../domain/model';
import { RETIRED_TAG } from '../domain/noteOps';
import { isCheckSampled, planQueue, readyCounts, selectScheduled, studyEligible } from '../domain/schedule';
import { buildSessionQueue, matchCtxOf } from '../domain/scope';
import { buildSeedState } from '../domain/seed';
import { applyRating } from '../domain/srs';
import { addDays, DAY, dayKeyOf, HOUR, MIN } from '../domain/types';
import { FIXED_NOW, localTime } from '../test/clock';
import { ankiFixture, stateFixture } from '../test/factories';
import {
  deepReadOnly,
  lifeValues,
  makeDeckV3,
  makePersonV3,
  makeStateV3,
  noteWithCards,
  notesWithoutCards,
  randomStateV3,
  stateOfV3,
  stateProblemsV3,
} from '../test/factoriesV3';
import { createRandom, type Random } from '../test/random';
import type { CompleteSessionArgs } from './actions';
import { type DeleteStrategy, UNFILED_DECK_ID } from './deckOps';
import { migrate } from './migrate';
import * as reducer from './reducer';
import {
  addDeck,
  addNote,
  applyImport,
  applyPayout,
  bury,
  clampDailyLimits,
  Command,
  completeSession,
  computePayout,
  createNewId,
  DAILY_LIMIT_RANGES,
  deleteDeck,
  deleteList,
  deleteNotes,
  duplicateDeck,
  editNote,
  factoryReset,
  learn,
  LimitsPatch,
  markKnown,
  markOnboarded,
  MIN_DAILY_REVIEW_LIMIT,
  moveNotes,
  normalizedDayDone,
  rateCard,
  reconcileOnBoot,
  ReducerCtx,
  reorderDecks,
  reschedule,
  resetPreferences,
  resetProgress,
  restoreState,
  REVIEW_LOG_CAP,
  reviewBucket,
  saveList,
  scheduleOf,
  setDeckOptions,
  setDirections,
  setFlags,
  setGoals,
  setLimits,
  setListPref,
  setNotStarted,
  startOfNextDay,
  Step,
  tagNotes,
  trackSession,
  undoDelete,
  undoLastReview,
  undoManualEdit,
  updateAppSettings,
  updateDeck,
  updateNoteType,
  updateSrsSettings,
  writesSchedule,
} from './reducer';
import { tallyReview, untallyReview } from './tally';

/* ------------------------------------------------------------------ helpers */

const TODAY = dayKeyOf(FIXED_NOW); // '2026-06-10'
const YESTERDAY = addDays(TODAY, -1);
const DECK = 'deck-1';
const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy'];

// One id counter for the whole file, so two contexts never make the same id.
let idSeq = 0;
const newId = (prefix: string) => {
  idSeq += 1;
  return `${prefix}-t${idSeq}`;
};

/** A reducer context at `now` (default: the fixed test time). */
function ctxAt(now: number = FIXED_NOW): ReducerCtx {
  return { now, newId };
}

/**
 * One note with its card(s), in one status (`lifeValues`). The card of ord 0
 * has id `id` (ord 1: `${id}-1`), the note `n-${id}`.
 */
function item(
  id: string,
  kind: LifeKey = 'new',
  card: Partial<Card> = {},
  opts: { deckId?: Id; typeId?: Id; note?: Partial<Note> } = {},
): { note: Note; cards: Card[] } {
  return noteWithCards({
    deckId: opts.deckId ?? DECK,
    typeId: opts.typeId,
    note: { id: `n-${id}`, ...opts.note },
    card: (ord) => ({ id: ord === 0 ? id : `${id}-${ord}`, createdAt: FIXED_NOW - 30 * DAY, ...lifeValues(kind), ...card }),
  });
}

/** Deck 'deck-1' + the given notes, a learner who studied yesterday. */
function stateWith(groups: { note: Note; cards: Card[] }[], extra: Partial<DataStateV3> = {}): DataStateV3 {
  return stateOfV3({
    decks: [makeDeckV3({ id: DECK, name: 'Capitals', order: 0 })],
    groups,
    overrides: {
      person: makePersonV3({ streak: 2, bestStreak: 2, lastStudyDay: YESTERDAY, xp: 100 }),
      onboarded: true,
      ...extra,
    },
  });
}

/** A v3 day tally (default: today, empty). */
function day(o: Partial<DataStateV3['person']['dayDone']> = {}): DataStateV3['person']['dayDone'] {
  return { dayKey: TODAY, reviews: 0, neww: 0, checks: 0, newByDeck: {}, ...o };
}

/** An in-flight session marker. */
function marker(o: Partial<InProgressSession> = {}): InProgressSession {
  const counts = o.counts ?? { again: 0, hard: 1, good: 2, easy: 0 };
  return {
    kind: 'scheduled',
    label: 'All decks',
    counts,
    total: counts.again + counts.hard + counts.good + counts.easy,
    bestRun: 2,
    durationSec: 40,
    fastAnswers: 0,
    studyDay: TODAY,
    ...o,
  };
}

/** Session-end arguments, like the session screen passes them. */
function args(overrides: Partial<CompleteSessionArgs> = {}): CompleteSessionArgs {
  const counts = overrides.counts ?? { again: 1, hard: 1, good: 2, easy: 1 };
  return {
    kind: 'scheduled',
    label: 'All decks',
    counts,
    total: counts.again + counts.hard + counts.good + counts.easy,
    bestRun: 3,
    durationSec: 60,
    fastAnswers: 0,
    studyDay: TODAY,
    ...overrides,
  };
}

/** applyRating (srs.ts) with the state's SRS settings. */
const srsRate = (c: Card, rating: Rating, s: DataStateV3, now = FIXED_NOW): Card => applyRating(c, rating, s.settings.srs, now);

const card = (s: DataStateV3, id: string): Card => {
  const found = s.cards.find((c) => c.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
};
const last = <T>(list: readonly T[]): T => list[list.length - 1];
const hasStreakXp = (items: { label: string }[]) => items.some((i) => i.label.startsWith('Daily streak'));
/** A state is valid: no broken link, and no note was left without cards. */
const valid = (s: DataStateV3) => [...stateProblemsV3(s), ...notesWithoutCards(s).map((id) => `note ${id} has no card`)];

/* ----------------------------------------------------------------- rateCard */

describe('rateCard by bucket', () => {
  it("a new card: SM-2, the NEW budget only + its deck's newByDeck (M3), bucket 'new', returns the stored card", () => {
    const s = stateWith([item('c1')]);
    const fresh = card(s, 'c1');
    const { state, result } = rateCard(s, { cardId: 'c1', rating: 'good', durationMs: 2_400 }, ctxAt());

    expect(result).toEqual(srsRate(fresh, 'good', s));
    expect(card(state, 'c1')).toBe(result); // the returned card IS the stored card (M6)
    expect(state.person.dayDone).toEqual(day({ neww: 1, newByDeck: { [DECK]: 1 } }));
    expect(state.reviewLog).toEqual([
      {
        id: expect.any(String),
        seq: 1,
        cardId: 'c1',
        deckId: DECK,
        rating: 'good',
        atMs: FIXED_NOW,
        bucket: 'new',
        prev: scheduleOf(fresh),
        durationMs: 2_400,
      },
    ]);
  });

  it("a review card: the review budget only, bucket 'review'", () => {
    const s = stateWith([item('c1', 'review', { due: FIXED_NOW - HOUR })], {
      person: makePersonV3({ dayDone: day({ reviews: 4, neww: 2, newByDeck: { [DECK]: 2 } }) }),
    });
    const { state } = rateCard(s, { cardId: 'c1', rating: 'hard' }, ctxAt());
    expect(state.person.dayDone).toEqual(day({ reviews: 5, neww: 2, newByDeck: { [DECK]: 2 } }));
    expect(last(state.reviewLog).bucket).toBe('review');
  });

  it("a learning card is 'review' too (it was studied before)", () => {
    const s = stateWith([item('c1', 'learning', { due: FIXED_NOW - MIN })]);
    const { state } = rateCard(s, { cardId: 'c1', rating: 'good' }, ctxAt());
    expect(last(state.reviewLog).bucket).toBe('review');
    expect(state.person.dayDone).toEqual(day({ reviews: 1 }));
  });

  it('reviewBucket: Known → check, reps 0 → new, else review', () => {
    expect(reviewBucket({ knownAt: 5, reps: 0 })).toBe('check');
    expect(reviewBucket({ knownAt: 5, reps: 7 })).toBe('check');
    expect(reviewBucket({ knownAt: null, reps: 0 })).toBe('new');
    expect(reviewBucket({ reps: 3 })).toBe('review');
  });

  it('a card that is gone: nothing changes and the result is null', () => {
    const s = stateWith([item('c1')]);
    expect(rateCard(s, { cardId: 'nope', rating: 'good' }, ctxAt())).toEqual({ state: s, result: null });
    expect(rateCard(s, { cardId: 'nope', rating: 'good' }, ctxAt()).state).toBe(s);
  });

  it("the first rating of a new day starts the day's tally from zero", () => {
    const s = stateWith([item('c1')], {
      person: makePersonV3({ dayDone: day({ dayKey: YESTERDAY, reviews: 30, neww: 10, checks: 2, newByDeck: { [DECK]: 10 } }) }),
    });
    const { state } = rateCard(s, { cardId: 'c1', rating: 'good' }, ctxAt());
    expect(state.person.dayDone).toEqual(day({ neww: 1, newByDeck: { [DECK]: 1 } }));
  });

  it('keeps every other key of the card (note, ord, newPos, flags, legacy …) — applyRating spreads the card', () => {
    const legacy = { word: 'die Stunde', article: 'die', base: 'Stunde', tr: 'the hour', level: 'A1', type: 'noun', lang: 'de' };
    const s = stateWith([item('c1', 'new', { fav: true, flagColor: 3, newPos: 42, legacy })]);
    const { result } = rateCard(s, { cardId: 'c1', rating: 'easy' }, ctxAt());
    expect(result).toMatchObject({ noteId: 'n-c1', ord: 0, deckId: DECK, fav: true, flagColor: 3, newPos: 42, legacy });
  });

  it('rate → undo → rate with the engine\'s floor (minSeq): the new rating gets a NEW seq, never the freed one', () => {
    let s = stateWith([item('a'), item('b')]);
    let high = 0; // what engine.ts keeps: the highest seq it has seen
    const rate = (cardId: string) => {
      s = rateCard(s, { cardId, rating: 'good', minSeq: high + 1 }, ctxAt()).state;
      high = Math.max(high, last(s.reviewLog).seq);
    };
    rate('a');
    expect(last(s.reviewLog)).toMatchObject({ cardId: 'a', seq: 1 });
    s = undoLastReview(s, undefined, ctxAt()).state;
    rate('b');
    // The revlog row key of A (seq 1) is never reused for B, so a save can tell them apart.
    expect(s.reviewLog.map((e) => [e.cardId, e.seq])).toEqual([['b', 2]]);
    // The floor only lifts: a log that is already higher keeps last + 1; a bad floor is ignored.
    expect(last(rateCard(s, { cardId: 'a', rating: 'good', minSeq: 1 }, ctxAt()).state.reviewLog).seq).toBe(3);
    expect(last(rateCard(s, { cardId: 'a', rating: 'good', minSeq: Number.NaN }, ctxAt()).state.reviewLog).seq).toBe(3);
    expect(last(rateCard(s, { cardId: 'a', rating: 'good', minSeq: 9.5 }, ctxAt()).state.reviewLog).seq).toBe(10);
  });

  it('seq = last + 1 when no floor is given (also after an undo); a bad duration is not stored', () => {
    let s = stateWith([item('a'), item('b'), item('c')]);
    s = rateCard(s, { cardId: 'a', rating: 'good' }, ctxAt()).state;
    s = rateCard(s, { cardId: 'b', rating: 'good', durationMs: Number.NaN }, ctxAt()).state;
    expect(s.reviewLog.map((e) => e.seq)).toEqual([1, 2]);
    expect('durationMs' in last(s.reviewLog)).toBe(false);
    s = undoLastReview(s, undefined, ctxAt()).state;
    s = rateCard(s, { cardId: 'c', rating: 'good', durationMs: -5 }, ctxAt()).state;
    expect(s.reviewLog.map((e) => [e.cardId, e.seq])).toEqual([
      ['a', 1],
      ['c', 2],
    ]);
    expect('durationMs' in last(s.reviewLog)).toBe(false);
  });
});

describe("rateCard: the 'check' bucket (a Known card)", () => {
  const knownNew = () => stateWith([item('k', 'known')]);
  const knownStudied = () =>
    stateWith([item('k', 'review', { knownAt: FIXED_NOW - 40 * DAY, reps: 5, lapses: 1, intervalDays: 30 })]);

  it.each(['good', 'easy'] as Rating[])('%s passes the Check: knownCheckedAt = now, still Known, the schedule untouched', (rating) => {
    const s = knownNew();
    const before = card(s, 'k');
    const { state, result } = rateCard(s, { cardId: 'k', rating }, ctxAt());
    expect(result).toEqual({ ...before, knownCheckedAt: FIXED_NOW });
    expect(life(result as Card)).toBe('known');
    expect(isMastered(result as Card)).toBe(false);
    expect(state.person.dayDone).toEqual(day({ checks: 1 }));
    expect(last(state.reviewLog)).toMatchObject({ bucket: 'check', prev: scheduleOf(before) });
  });

  it('again misses it: not Known any more, Learning from step 0; a never-studied card gets no lapse', () => {
    const s = knownNew();
    const { state, result } = rateCard(s, { cardId: 'k', rating: 'again' }, ctxAt());
    const steps = s.settings.srs.learningStepsMin;
    expect(result).toMatchObject({ knownAt: null, knownCheckedAt: null, stepIndex: 0, reps: 1, lapses: 0 });
    expect(result?.due).toBe(FIXED_NOW + steps[0] * MIN);
    expect(life(result as Card)).toBe('learning');
    expect(state.person.dayDone).toEqual(day({ checks: 1 })); // never the new or review budget
  });

  it('hard on a studied Known card: Learning, reps kept (+1 for this rating), lapses + 1', () => {
    const s = knownStudied();
    const { result } = rateCard(s, { cardId: 'k', rating: 'hard' }, ctxAt());
    expect(result).toMatchObject({ knownAt: null, knownCheckedAt: null, stepIndex: 0, reps: 6, lapses: 2, intervalDays: 30 });
    expect(life(result as Card)).toBe('learning');
  });

  it('a check pass on a studied Known card leaves its schedule and lastReviewedAt as they were', () => {
    const s = knownStudied();
    const before = card(s, 'k');
    const { result } = rateCard(s, { cardId: 'k', rating: 'good' }, ctxAt());
    expect(result).toEqual({ ...before, knownCheckedAt: FIXED_NOW });
  });

  /**
   * A Basic + reverse note: direction 1 is Known, in the 10% Check sample and
   * ready (Known 100 days ago); direction 0 is `dir0`. The deck has Checks on.
   */
  function checkWithSibling(dir0: Partial<Card>, at: number): { state: DataStateV3; checkId: Id } {
    let i = 0;
    while (!isCheckSampled(`chk-${i}`)) i += 1;
    const checkId = `chk-${i}`;
    const deck = makeDeckV3({ id: DECK, name: 'Capitals', order: 0, options: { knownChecks: true } });
    const group = noteWithCards({
      deckId: DECK,
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      note: { id: 'nr' },
      card: (ord) => (ord === 0 ? { id: 'dir0', ...dir0 } : { id: checkId, ...lifeValues('known', at), knownAt: at - 100 * DAY }),
    });
    return { state: stateOfV3({ decks: [deck], groups: [group] }), checkId };
  }

  /** The cards a scheduled session over everything opens at `now` (the one scheduler: "Study N"). */
  const queueAt = (s: DataStateV3, now: number) => buildSessionQueue({ kind: 'scheduled', q: {} }, s, matchCtxOf(s, now)).map((c) => c.id);

  it.each([
    ['a review due at 09:30', (at: number): Partial<Card> => ({ ...lifeValues('review', at), due: at + 30 * MIN })],
    ['a new card', (at: number): Partial<Card> => lifeValues('new', at)],
  ])('a PASSED Check counts as "studied today": its sibling (%s) waits for another day with spaceSiblings on (final review)', (_name, dir0) => {
    const at = localTime(dayKeyOf(FIXED_NOW), '09:00');
    const { state, checkId } = checkWithSibling(dir0(at), at);
    // 09:00: the Check comes; one card per note in a run holds the sibling back.
    expect(queueAt(state, at)).toEqual([checkId]);
    const { state: passed } = rateCard(state, { cardId: checkId, rating: 'good' }, ctxAt(at + MIN));
    expect(card(passed, checkId).lastReviewedAt).toBeNull(); // the pass writes only knownCheckedAt …
    // … and still the other direction does not come later TODAY ("never both directions on one day") …
    expect(queueAt(passed, at + HOUR)).toEqual([]);
    expect(queueAt(passed, at + 14 * HOUR)).toEqual([]);
    // … but the next day.
    expect(queueAt(passed, at + DAY)).toEqual(['dir0']);
    // Spacing off: it may come today.
    const off = { ...passed, settings: { ...passed.settings, spaceSiblings: false } };
    expect(queueAt(off, at + HOUR)).toEqual(['dir0']);
  });
});

describe('review log cap', () => {
  it(`keeps the newest ${REVIEW_LOG_CAP} entries; the new one is last`, () => {
    let s = stateWith([item('c1', 'review')]);
    for (let i = 0; i < REVIEW_LOG_CAP; i++) s = rateCard(s, { cardId: 'c1', rating: 'good' }, ctxAt(FIXED_NOW + i)).state;
    expect(s.reviewLog).toHaveLength(REVIEW_LOG_CAP);
    expect(s.reviewLog[0].seq).toBe(1);
    const { state } = rateCard(s, { cardId: 'c1', rating: 'good' }, ctxAt(FIXED_NOW + REVIEW_LOG_CAP));
    expect(state.reviewLog).toHaveLength(REVIEW_LOG_CAP);
    expect(state.reviewLog[0].seq).toBe(2); // the oldest one fell off
    expect(last(state.reviewLog).seq).toBe(REVIEW_LOG_CAP + 1);
  });
});

/* ------------------------------------------------------------ practice (H3) */

describe('practice writes nothing (H3)', () => {
  it("writesSchedule: 'practice' and the legacy 'cram' are free practice", () => {
    const kinds: SessionKind[] = ['scheduled', 'ahead', 'practice', 'cram', 'hardest', 'deck', 'collection'];
    expect(kinds.filter((k) => !writesSchedule(k))).toEqual(['practice', 'cram']);
  });

  it("kind 'practice': the very same state, and the card is returned unchanged", () => {
    const s = stateWith([item('c1', 'review')]);
    const step = rateCard(s, { cardId: 'c1', rating: 'again', kind: 'practice' }, ctxAt());
    expect(step.state).toBe(s);
    expect(step.result).toBe(card(s, 'c1'));
  });

  it.each(['practice', 'cram'] as SessionKind[])("kind '%s' writes nothing, also for a Known card", (kind) => {
    const s = stateWith([item('c1'), item('k', 'known')]);
    expect(rateCard(s, { cardId: 'c1', rating: 'good', kind }, ctxAt()).state).toBe(s);
    expect(rateCard(s, { cardId: 'k', rating: 'again', kind }, ctxAt()).state).toBe(s);
  });

  it('a practice round of the missed cards (retry) changes no schedule, log or tally', () => {
    const s = stateWith([item('a', 'review'), item('b'), item('c', 'learning')]);
    const first = rateCard(s, { cardId: 'a', rating: 'again' }, ctxAt()).state;
    let state = first;
    const ratings: Rating[] = ['again', 'good', 'again', 'easy', 'good', 'hard'];
    ratings.forEach((rating, i) => {
      state = rateCard(state, { cardId: ['a', 'b', 'c'][i % 3], rating, kind: 'practice' }, ctxAt(FIXED_NOW + i * MIN)).state;
    });
    expect(state).toBe(first);
  });

  it('the only write is a calendar roll-over of dayDone', () => {
    const s = stateWith([item('c1')], { person: makePersonV3({ dayDone: day({ dayKey: YESTERDAY, reviews: 9, neww: 3 }) }) });
    const { state } = rateCard(s, { cardId: 'c1', rating: 'good', kind: 'practice' }, ctxAt());
    expect(state).not.toBe(s);
    expect(state.person.dayDone).toEqual(day());
    expect(state.cards).toBe(s.cards);
    expect(state.reviewLog).toBe(s.reviewLog);
    expect({ ...state, person: s.person }).toEqual(s);
  });
});

/* ------------------------------------------------------------------- undo */

describe('undoLastReview', () => {
  const buckets: [string, { note: Note; cards: Card[] }][] = [
    ['new', item('c1')],
    ['not started', item('c1', 'notStarted')],
    ['learning', item('c1', 'learning', { due: FIXED_NOW - MIN })],
    ['review', item('c1', 'review', { due: FIXED_NOW - HOUR })],
    ['mastered', item('c1', 'mastered', { due: FIXED_NOW - HOUR })],
    ['known (check)', item('c1', 'known')],
    ['known, studied (check)', item('c1', 'review', { knownAt: FIXED_NOW - 40 * DAY })],
  ];

  it.each(buckets)('rate then undo restores the exact snapshot and the tally (%s card)', (_bucket, group) => {
    const s = stateWith([group], { person: makePersonV3({ dayDone: day({ reviews: 3, neww: 1, checks: 1, newByDeck: { [DECK]: 1 } }) }) });
    const original = card(s, 'c1');
    for (const rating of RATINGS) {
      const rated = rateCard(s, { cardId: 'c1', rating }, ctxAt()).state;
      const undone = undoLastReview(rated, undefined, ctxAt(FIXED_NOW + MIN));
      expect(undone.result).toBe(true);
      expect(card(undone.state, 'c1')).toEqual(original);
      expect(Object.keys(card(undone.state, 'c1')).sort()).toEqual(Object.keys(original).sort()); // the same shape
      expect(undone.state.reviewLog).toEqual(s.reviewLog);
      expect(undone.state.person.dayDone).toEqual(s.person.dayDone);
    }
  });

  it("a new card's undo takes it out of its own deck's newByDeck (and drops a 0)", () => {
    const s = stateOfV3({
      decks: [makeDeckV3({ id: 'd1', order: 0 }), makeDeckV3({ id: 'd2', order: 1 })],
      groups: [item('a', 'new', {}, { deckId: 'd1' }), item('b', 'new', {}, { deckId: 'd2' })],
    });
    const afterA = rateCard(s, { cardId: 'a', rating: 'good' }, ctxAt()).state;
    const afterB = rateCard(afterA, { cardId: 'b', rating: 'good' }, ctxAt()).state;
    expect(afterB.person.dayDone).toEqual(day({ neww: 2, newByDeck: { d1: 1, d2: 1 } }));
    const undone = undoLastReview(afterB, undefined, ctxAt()).state;
    expect(undone.person.dayDone).toEqual(day({ neww: 1, newByDeck: { d1: 1 } }));
  });

  it('pops only the LAST rating', () => {
    const s = stateWith([item('a'), item('b')]);
    const afterA = rateCard(s, { cardId: 'a', rating: 'good' }, ctxAt()).state;
    const afterB = rateCard(afterA, { cardId: 'b', rating: 'easy' }, ctxAt()).state;
    const { state } = undoLastReview(afterB, undefined, ctxAt());
    expect(card(state, 'a')).toEqual(card(afterA, 'a')); // still rated
    expect(card(state, 'b')).toEqual(card(s, 'b')); // back to new
    expect(state.reviewLog).toEqual(afterA.reviewLog);
    expect(state.person.dayDone).toEqual(afterA.person.dayDone);
  });

  it('nothing to undo: false and the same state', () => {
    const s = stateWith([item('c1')]);
    expect(undoLastReview(s, undefined, ctxAt())).toEqual({ state: s, result: false });
    expect(undoLastReview(s, undefined, ctxAt()).state).toBe(s);
  });

  it('never takes a tally below zero (the rating was yesterday)', () => {
    const s = stateWith([item('c1')]);
    const rated = rateCard(s, { cardId: 'c1', rating: 'good' }, ctxAt()).state;
    const { state } = undoLastReview(rated, undefined, ctxAt(FIXED_NOW + DAY));
    expect(state.person.dayDone).toEqual(day({ dayKey: addDays(TODAY, 1) }));
    expect(card(state, 'c1')).toEqual(card(s, 'c1'));
  });

  it('the snapshot covers every key a rating changes (any card, any rating)', () => {
    const s = randomStateV3(createRandom('snapshot-keys'), { maxNotes: 40 });
    for (const c of s.cards) {
      for (const rating of RATINGS) {
        const rated = rateCard(s, { cardId: c.id, rating }, ctxAt()).result as Card;
        const snapshot = new Set([...Object.keys(scheduleOf(c)), 'knownAt', 'knownCheckedAt']);
        const keys = new Set([...Object.keys(c), ...Object.keys(rated)]);
        const changed = [...keys].filter(
          (k) => (rated as unknown as Record<string, unknown>)[k] !== (c as unknown as Record<string, unknown>)[k],
        );
        expect(changed.filter((k) => !snapshot.has(k))).toEqual([]);
      }
    }
  });

  it('property (60 seeded random states): rate a random card, then undo → the same cards, log and tally', () => {
    for (let seed = 0; seed < 60; seed++) {
      const rnd = createRandom(`rate-undo-${seed}`);
      const s = randomStateV3(rnd.fork('state'));
      if (s.cards.length === 0) continue;
      const target = rnd.pick(s.cards);
      const rating = rnd.pick<Rating>(RATINGS);
      const now = FIXED_NOW + rnd.int(0, 8) * HOUR; // same local day as FIXED_NOW (09:00 + ≤ 8 h)
      const rated = rateCard(s, { cardId: target.id, rating }, ctxAt(now)).state;
      const undone = undoLastReview(rated, undefined, ctxAt(now)).state;
      expect({ seed, cards: undone.cards, log: undone.reviewLog, day: undone.person.dayDone }).toEqual({
        seed,
        cards: s.cards,
        log: s.reviewLog,
        day: s.person.dayDone,
      });
    }
  });
});

describe('manual edits never break session undo (§3.12)', () => {
  it('reschedule, then session undo reverts the RATING, not the reschedule (two cards)', () => {
    const s = stateWith([item('a', 'review', { due: FIXED_NOW - HOUR }), item('b', 'review', { due: FIXED_NOW - HOUR })]);
    const rated = rateCard(s, { cardId: 'a', rating: 'good' }, ctxAt()).state;
    const tomorrow = startOfNextDay(FIXED_NOW);
    const moved = reschedule(rated, { cardIds: ['b'], dueMs: tomorrow }, ctxAt());
    expect(moved.state.reviewLog).toBe(rated.reviewLog); // a manual edit never touches the review log
    const undone = undoLastReview(moved.state, undefined, ctxAt()).state;
    expect(card(undone, 'a')).toEqual(card(s, 'a')); // the rating is gone
    expect(card(undone, 'b').due).toBe(tomorrow); // the reschedule stays
    expect(undone.manualLog).toEqual(moved.state.manualLog); // and can still be undone by its own Undo
    expect(undone.reviewLog).toEqual(s.reviewLog);
  });

  it('the same card: session undo reverts the rating; the reschedule Undo then skips the card (studied since)', () => {
    const s = stateWith([item('a', 'review', { due: FIXED_NOW - HOUR })]);
    const rated = rateCard(s, { cardId: 'a', rating: 'good' }, ctxAt()).state;
    const moved = reschedule(rated, { cardIds: ['a'], dueMs: startOfNextDay(FIXED_NOW) }, ctxAt());
    const undone = undoLastReview(moved.state, undefined, ctxAt()).state;
    expect(card(undone, 'a')).toEqual(card(s, 'a'));
    const edit = undoManualEdit(undone, { editId: moved.result.edit.id }, ctxAt());
    expect(edit.result).toEqual({ reverted: 0, skipped: 1 });
    expect(card(edit.state, 'a')).toEqual(card(s, 'a'));
  });

  it('every card-state command leaves the review log as it is', () => {
    const s = rateCard(stateWith([item('a'), item('b', 'review')]), { cardId: 'a', rating: 'good' }, ctxAt()).state;
    const ctx = ctxAt();
    const steps = [
      setFlags(s, { cardIds: ['a', 'b'], patch: { suspended: true } }, ctx),
      learn(s, { cardIds: ['a'] }, ctx),
      markKnown(s, { cardIds: ['a', 'b'] }, ctx),
      setNotStarted(s, { cardIds: ['a', 'b'] }, ctx),
      resetProgress(s, { cardIds: ['a', 'b'] }, ctx),
      reschedule(s, { cardIds: ['b'], dueMs: FIXED_NOW + DAY }, ctx),
      moveNotes(s, { noteIds: ['n-a'], deckId: DECK, section: 'X' }, ctx),
      tagNotes(s, { noteIds: ['n-a'], add: ['t'], remove: [] }, ctx),
    ];
    for (const step of steps) expect(step.state.reviewLog).toBe(s.reviewLog);
  });
});

/* ------------------------------------------------------- completeSession */

describe('completeSession', () => {
  it('M5: computePayout + applyPayout → sessions + 1 and inProgressSession === null in ONE object', () => {
    const m = marker();
    const s = stateWith([item('c1')], { inProgressSession: m });
    const plan = computePayout(s, m, ctxAt());
    const next = applyPayout(s, plan);
    expect(next.sessions).toHaveLength(s.sessions.length + 1);
    expect(next.inProgressSession).toBeNull();
    expect(last(next.sessions)).toBe(plan.session);
    const step = completeSession(s, m, ctxAt());
    expect(step.state.sessions).toHaveLength(s.sessions.length + 1);
    expect(step.state.inProgressSession).toBeNull();
  });

  it('pays the XP, records the session (with mode and scope label), rolls the streak and returns the payout', () => {
    const s = stateWith([item('c1')]);
    const { state, result } = completeSession(s, args({ durationSec: 75, fastAnswers: 2, mode: 'mix', label: 'Capitals' }), ctxAt());

    // 5 cards × 2 + 4 correct × 2 + daily streak 10 (bestRun 3 < 5: no run bonus)
    expect(result.xpItems).toEqual([
      { label: '5 cards reviewed', xp: 10 },
      { label: '4 correct', xp: 8 },
      { label: 'Daily streak · day 3', xp: STREAK_BONUS },
    ]);
    expect(result).toMatchObject({
      kind: 'scheduled',
      label: 'Capitals',
      total: 5,
      accuracy: 80,
      durationSec: 75,
      xpTotal: 28,
      streakDays: 3,
      freezeEarned: false,
    });
    expect(result.newAchievements.map((a) => a.id)).toEqual(['first-steps']);
    expect(result.levelBefore.level).toBe(1);

    expect(last(state.sessions)).toEqual({
      id: expect.any(String),
      dayKey: TODAY,
      atMs: FIXED_NOW,
      kind: 'scheduled',
      counts: { again: 1, hard: 1, good: 2, easy: 1 },
      total: 5,
      bestRun: 3,
      xp: 28,
      mode: 'mix',
      scopeLabel: 'Capitals',
    });
    expect(state.person).toMatchObject({
      xp: 128,
      streak: 3,
      bestStreak: 3,
      lastStudyDay: TODAY,
      fastAnswers: 2,
      achievements: { 'first-steps': FIXED_NOW },
    });
  });

  it('a boot-reconciled marker has no mode, so its record has none', () => {
    const { state } = completeSession(stateWith([]), marker(), ctxAt());
    expect('mode' in last(state.sessions)).toBe(false);
    expect(last(state.sessions).scopeLabel).toBe('All decks');
  });

  it("D5: a practice session is recorded with kind 'practice', pays XP and counts for the streak", () => {
    const s = stateWith([item('c1')]);
    const { state, result } = completeSession(s, args({ kind: 'practice', mode: 'article' }), ctxAt());
    expect(result.kind).toBe('practice');
    expect(last(state.sessions)).toMatchObject({ kind: 'practice', mode: 'article' });
    expect(result.xpTotal).toBeGreaterThan(0);
    expect(state.person.streak).toBe(3);
  });

  it('accuracy is 0 for an empty session (no division by zero)', () => {
    const { result } = completeSession(stateWith([]), args({ counts: { again: 0, hard: 0, good: 0, easy: 0 }, total: 0 }), ctxAt());
    expect(result.accuracy).toBe(0);
  });

  it('L10: a second session the same day pays no streak XP', () => {
    const s = stateWith([item('c1')]);
    const first = completeSession(s, args(), ctxAt());
    const second = completeSession(first.state, args(), ctxAt(FIXED_NOW + HOUR));
    expect(hasStreakXp(first.result.xpItems)).toBe(true);
    expect(hasStreakXp(second.result.xpItems)).toBe(false);
    expect(first.result.xpTotal - second.result.xpTotal).toBe(STREAK_BONUS);
    expect(second.state.person.streak).toBe(first.state.person.streak);
    expect(second.state.sessions).toHaveLength(2);
  });

  it('M13: the 7-day freeze reward never goes above MAX_FREEZES', () => {
    const atCap = stateWith([], { person: makePersonV3({ streak: 6, lastStudyDay: YESTERDAY, freezes: MAX_FREEZES }) });
    const capped = completeSession(atCap, args(), ctxAt());
    expect(capped.state.person.streak).toBe(7);
    expect(capped.state.person.freezes).toBe(MAX_FREEZES);
    const below = stateWith([], { person: makePersonV3({ streak: 6, lastStudyDay: YESTERDAY, freezes: 1 }) });
    expect(completeSession(below, args(), ctxAt()).state.person.freezes).toBe(2);
  });

  it('M13: an achievement freeze (Quick draw) is capped too', () => {
    const quick = (freezes: number) =>
      stateWith([], { person: makePersonV3({ streak: 1, lastStudyDay: YESTERDAY, freezes, fastAnswers: 49 }) });
    const atCap = completeSession(quick(MAX_FREEZES), args({ fastAnswers: 1 }), ctxAt());
    expect(atCap.result.newAchievements.map((a) => a.id)).toContain('quick-draw');
    expect(atCap.result.freezeEarned).toBe(false);
    expect(atCap.state.person.freezes).toBe(MAX_FREEZES);
    const earns = completeSession(quick(0), args({ fastAnswers: 1 }), ctxAt());
    expect(earns.result.freezeEarned).toBe(true);
    expect(earns.state.person.freezes).toBe(1);
  });

  describe('M6: the final card that just became mastered counts this session', () => {
    // 99 mastered cards + one review card that "good" pushes to 25 days (≥ 21 = mastered).
    const mastered = Array.from({ length: 99 }, (_, i) => item(`m${i}`, 'mastered'));
    const before = stateWith([...mastered, item('x', 'review', { intervalDays: 10, ease: 2.5, due: FIXED_NOW - HOUR })]);

    it('with finalCard, Centurion (100 mastered) unlocks now', () => {
      const rated = rateCard(before, { cardId: 'x', rating: 'good' }, ctxAt());
      expect(rated.result?.intervalDays).toBeGreaterThanOrEqual(21);
      // The snapshot is stale by one rating: `before`, not `rated.state`.
      const plan = computePayout(before, args({ finalCard: rated.result ?? undefined }), ctxAt());
      expect(plan.payout.newAchievements.map((a) => a.id)).toContain('centurion');
      expect(applyPayout(rated.state, plan).person.achievements.centurion).toBe(FIXED_NOW);
    });

    it('without finalCard the stale snapshot misses it (why M6 exists)', () => {
      const plan = computePayout(before, args(), ctxAt());
      expect(plan.payout.newAchievements.map((a) => a.id)).not.toContain('centurion');
    });
  });

  it('a Known card is never mastered: 100 Known cards with long intervals unlock no Centurion', () => {
    const known = Array.from({ length: 100 }, (_, i) =>
      item(`k${i}`, 'mastered', { knownAt: FIXED_NOW - DAY }),
    );
    const plan = computePayout(stateWith(known), args(), ctxAt());
    expect(plan.payout.newAchievements.map((a) => a.id)).not.toContain('centurion');
  });

  it("stale computePayout + latest applyPayout keeps the final rating's dayDone", () => {
    const s0 = stateWith([item('c1', 'review', { due: FIXED_NOW - HOUR })], {
      person: makePersonV3({ lastStudyDay: YESTERDAY, dayDone: day({ reviews: 2 }) }),
    });
    const plan = computePayout(s0, args(), ctxAt()); // computed BEFORE the final rating
    const s1 = rateCard(s0, { cardId: 'c1', rating: 'good' }, ctxAt()).state; // the final rating commits
    const done = applyPayout(s1, plan);
    expect(done.person.dayDone).toEqual(day({ reviews: 3 }));
    expect(card(done, 'c1')).toBe(card(s1, 'c1'));
    expect(done.reviewLog).toBe(s1.reviewLog);
    expect(done.person.xp).toBe(s1.person.xp + plan.xpTotal);
    expect(applyPayout(s0, plan).person.dayDone.reviews).toBe(2);
  });

  it('studyDay 23:58 → 00:02: a session that ends after midnight counts for the day it started', () => {
    const start = localTime('2026-06-10', '23:58');
    const end = localTime('2026-06-11', '00:02');
    const studyDay = dayKeyOf(start);
    let s = stateWith([item('c1')], {
      person: makePersonV3({ streak: 4, bestStreak: 4, lastStudyDay: '2026-06-09', dayDone: day({ dayKey: studyDay }) }),
    });
    s = rateCard(s, { cardId: 'c1', rating: 'good' }, ctxAt(start)).state;
    expect(s.person.dayDone).toEqual(day({ dayKey: '2026-06-10', neww: 1, newByDeck: { [DECK]: 1 } }));
    const m = marker({ counts: { again: 0, hard: 0, good: 1, easy: 0 }, studyDay });
    s = trackSession(s, { snapshot: m }).state;

    const done = completeSession(s, m, ctxAt(end));
    expect(last(done.state.sessions).dayKey).toBe('2026-06-10');
    expect(last(done.state.sessions).atMs).toBe(end);
    expect(done.state.person.lastStudyDay).toBe('2026-06-10');
    expect(done.state.person.streak).toBe(5);
    expect(done.state.person.dayDone).toEqual(day({ dayKey: '2026-06-11' })); // the new day starts empty

    const next = completeSession(done.state, args({ studyDay: '2026-06-11' }), ctxAt(localTime('2026-06-11', '08:00')));
    expect(next.state.person.streak).toBe(6);
    expect(hasStreakXp(next.result.xpItems)).toBe(true);

    // Without studyDay, the same session would land on 06-11, skip 06-10 and reset the streak.
    const legacy = completeSession(s, { ...m, studyDay: undefined }, ctxAt(end));
    expect(legacy.state.person.lastStudyDay).toBe('2026-06-11');
    expect(legacy.state.person.streak).toBe(1);
  });
});

/* ---------------------------------------------------- reconcileOnBoot (M5) */

describe('reconcileOnBoot (M5)', () => {
  it('banks the in-flight session once; a second run banks nothing (banked: false)', () => {
    const s = stateWith([item('c1')], { inProgressSession: marker() });
    const first = reconcileOnBoot(s, undefined, ctxAt());
    expect(first.result).toEqual({ banked: true });
    expect(first.state.sessions).toHaveLength(1);
    expect(first.state.inProgressSession).toBeNull();
    expect(first.state.person.xp).toBeGreaterThan(s.person.xp);
    const second = reconcileOnBoot(first.state, undefined, ctxAt(FIXED_NOW + MIN));
    expect(second.result).toEqual({ banked: false });
    expect(second.state).toBe(first.state);
  });

  it('a marker WITH a mode (wave 5h): the record gets that mode, like a normal completion; banked once, marker cleared in the same state', () => {
    const s = stateWith([item('c1')], { inProgressSession: marker({ mode: 'type' }) });
    const first = reconcileOnBoot(s, undefined, ctxAt());
    expect(first.result).toEqual({ banked: true });
    expect(first.state.sessions).toHaveLength(1);
    expect(last(first.state.sessions).mode).toBe('type');
    expect(first.state.inProgressSession).toBeNull(); // M5: the payout and the marker clear are ONE state
    // The same record a normal completion with that mode writes (only the id may differ).
    const normal = completeSession(s, { ...marker(), mode: 'type' }, ctxAt()).state;
    expect({ ...last(first.state.sessions), id: '' }).toEqual({ ...last(normal.sessions), id: '' });
    expect(first.state.person).toEqual(normal.person);
    // Once only.
    expect(reconcileOnBoot(first.state, undefined, ctxAt(FIXED_NOW + MIN)).result).toEqual({ banked: false });
  });

  it('a marker WITHOUT a mode (saved before wave 5h) banks exactly as before: no mode in the record', () => {
    const old = marker();
    expect('mode' in old).toBe(false);
    const s = stateWith([item('c1')], { inProgressSession: old });
    const boot = reconcileOnBoot(s, undefined, ctxAt());
    expect(boot.result).toEqual({ banked: true });
    expect('mode' in last(boot.state.sessions)).toBe(false);
    // The same payout as before wave 5h: completeSession with the marker as it is.
    const before = completeSession(s, old, ctxAt()).state;
    expect({ ...last(boot.state.sessions), id: '' }).toEqual({ ...last(before.sessions), id: '' });
    expect(boot.state.person).toEqual(before.person);
    expect(boot.state.inProgressSession).toBeNull();
    // A practice marker with a mode: still recorded as practice, with its mode (spec §6.6, D5).
    const practice = reconcileOnBoot(stateWith([], { inProgressSession: marker({ kind: 'practice', mode: 'article' }) }), undefined, ctxAt());
    expect(last(practice.state.sessions)).toMatchObject({ kind: 'practice', mode: 'article' });
  });

  it('no marker: banked false and the very same state', () => {
    const s = stateWith([item('c1')]);
    expect(reconcileOnBoot(s, undefined, ctxAt())).toEqual({ state: s, result: { banked: false } });
    expect(reconcileOnBoot(s, undefined, ctxAt()).state).toBe(s);
  });

  it('is silent: the result carries no payout to show', () => {
    const s = stateWith([], { inProgressSession: marker() });
    expect(Object.keys(reconcileOnBoot(s, undefined, ctxAt()).result)).toEqual(['banked']);
  });

  it('kill after 3 ratings → reboot: banks XP, streak and record once, and does not tally the ratings again', () => {
    let s = stateWith([item('a'), item('b', 'review', { due: FIXED_NOW - HOUR }), item('c')]);
    const ratings: Rating[] = ['good', 'hard', 'good'];
    const counts = { again: 0, hard: 0, good: 0, easy: 0 };
    ratings.forEach((rating, i) => {
      s = rateCard(s, { cardId: ['a', 'b', 'c'][i], rating }, ctxAt(FIXED_NOW + i * MIN)).state;
      counts[rating] += 1;
      s = trackSession(s, { snapshot: marker({ counts: { ...counts }, total: i + 1, bestRun: i + 1 }) }).state;
    });
    expect(s.person.dayDone).toEqual(day({ reviews: 1, neww: 2, newByDeck: { [DECK]: 2 } }));

    const boot = reconcileOnBoot(s, undefined, ctxAt(FIXED_NOW + HOUR));
    expect(boot.result.banked).toBe(true);
    expect(boot.state.sessions).toHaveLength(1);
    expect(last(boot.state.sessions).total).toBe(3);
    expect(boot.state.person.streak).toBe(3);
    expect(boot.state.person.dayDone).toEqual(s.person.dayDone); // not tallied twice
    expect(boot.state.cards).toBe(s.cards);
    expect(boot.state.reviewLog).toBe(s.reviewLog);
    expect(reconcileOnBoot(boot.state, undefined, ctxAt(FIXED_NOW + 2 * HOUR)).result.banked).toBe(false);
  });

  it('studyDay: a reconcile on a later day credits the day the user studied', () => {
    const s = stateWith([], {
      person: makePersonV3({ streak: 4, bestStreak: 4, lastStudyDay: '2026-06-09', dayDone: day({ dayKey: '2026-06-10', reviews: 3 }) }),
      inProgressSession: marker({ studyDay: '2026-06-10' }),
    });
    const reopen = localTime('2026-06-12', '09:00');
    const { state } = reconcileOnBoot(s, undefined, ctxAt(reopen));
    expect(last(state.sessions).dayKey).toBe('2026-06-10');
    expect(last(state.sessions).atMs).toBe(reopen);
    expect(state.person.lastStudyDay).toBe('2026-06-10');
    expect(state.person.streak).toBe(5);
    expect(state.person.dayDone).toEqual(day({ dayKey: '2026-06-12' }));
  });

  /** A real fixture, migrated to schema 3 (what the engine holds after the boot). */
  function fixtureV3(name: 'v1-main-1333d48' | 'v1-marker-no-studyDay'): DataStateV3 {
    const out = migrate(stateFixture(name), FIXED_NOW);
    if (out.kind !== 'ok') throw new Error(`fixture ${name} did not migrate`);
    return out.state;
  }

  it('real fixture v1-main-1333d48 (in v3): banks the killed session under its study day', () => {
    const s = fixtureV3('v1-main-1333d48');
    const m = s.inProgressSession as InProgressSession;
    expect(m.studyDay).toBe('2026-07-21');
    const { state, result } = reconcileOnBoot(s, undefined, ctxAt(localTime('2026-07-23', '10:00')));
    expect(result.banked).toBe(true);
    expect(state.inProgressSession).toBeNull();
    expect(state.sessions).toHaveLength(s.sessions.length + 1);
    expect(last(state.sessions)).toMatchObject({ dayKey: '2026-07-21', total: 3, counts: m.counts });
    expect(state.person.lastStudyDay).toBe('2026-07-21');
    expect(state.person.streak).toBe(2); // 2026-07-20 → 2026-07-21
    // 3 cards × 2 + 3 correct × 2 + streak 10 (bestRun 3: no run bonus)
    expect(state.person.xp).toBe(s.person.xp + 22);
    expect(state.person.fastAnswers).toBe(s.person.fastAnswers + m.fastAnswers);
    expect(state.cards).toBe(s.cards);
    expect(reconcileOnBoot(state, undefined, ctxAt(localTime('2026-07-23', '10:01'))).result.banked).toBe(false);
  });

  it('real fixture v1-marker-no-studyDay (in v3): an old marker falls back to the reopen day', () => {
    const s = fixtureV3('v1-marker-no-studyDay');
    expect(s.inProgressSession?.studyDay).toBeUndefined();
    const sameDay = reconcileOnBoot(s, undefined, ctxAt(localTime('2026-07-21', '19:00'))).state;
    expect(last(sameDay.sessions).dayKey).toBe('2026-07-21');
    expect(sameDay.person.streak).toBe(2);
    const later = reconcileOnBoot(s, undefined, ctxAt(localTime('2026-07-23', '10:00'))).state;
    expect(last(later.sessions).dayKey).toBe('2026-07-23');
    expect(later.person.streak).toBe(1);
  });

  it('banks the state migrate() returns as it is: schema 3, no extra step', () => {
    const out = migrate(stateFixture('v1-main-1333d48'), FIXED_NOW);
    if (out.kind !== 'ok') throw new Error('did not migrate');
    expect(out.state.schemaVersion).toBe(3);
    const boot = reconcileOnBoot(out.state, undefined, ctxAt(localTime('2026-07-23', '10:00')));
    expect(boot.result.banked).toBe(true);
    expect(boot.state.inProgressSession).toBeNull();
    expect(boot.state.sessions).toHaveLength(out.state.sessions.length + 1);
  });
});

describe('trackSession and bury', () => {
  it('trackSession stores the snapshot, and null clears it', () => {
    const s = stateWith([]);
    const m = marker();
    const tracked = trackSession(s, { snapshot: m }).state;
    expect(tracked.inProgressSession).toBe(m);
    expect(trackSession(tracked, { snapshot: null }).state.inProgressSession).toBeNull();
  });

  it('bury hides the given cards until the next local midnight; others keep their identity', () => {
    const s = stateWith([item('a'), item('b'), item('c')]);
    const late = localTime('2026-06-10', '23:58');
    const { state } = bury(s, { cardIds: ['a', 'c', 'missing'] }, ctxAt(late));
    expect(card(state, 'a').buriedUntil).toBe(localTime('2026-06-11', '00:00'));
    expect(card(state, 'c').buriedUntil).toBe(localTime('2026-06-11', '00:00'));
    expect(card(state, 'b')).toBe(card(s, 'b'));
    expect(startOfNextDay(FIXED_NOW)).toBe(localTime('2026-06-11', '00:00'));
    // Already buried until then: the same state.
    expect(bury(state, { cardIds: ['a'] }, ctxAt(late)).state).toBe(state);
  });

  // Final review (session area): a bury had no Undo — a mis-tap in a session hid the card until
  // midnight, and nothing in the app could clear `buriedUntil`. It is a ManualEdit now.
  it('bury records ONE ManualEdit; undoManualEdit un-buries the cards (only those still buried until then)', () => {
    const s = stateWith([item('a'), item('b'), item('c')]);
    const step = bury(s, { cardIds: ['a', 'b', 'missing'] }, ctxAt());
    expect(step.result).toMatchObject({ undoable: true, skipped: 0, edit: { kind: 'bury', label: '2 cards buried until tomorrow' } });
    expect(step.state.manualLog).toHaveLength(1);
    expect(step.state.manualLog[0].cards.map((e) => [e.id, e.before, e.after])).toEqual([
      ['a', { buriedUntil: null }, { buriedUntil: startOfNextDay(FIXED_NOW) }],
      ['b', { buriedUntil: null }, { buriedUntil: startOfNextDay(FIXED_NOW) }],
    ]);
    // Card b was buried again later (another day): its undo skips it, card a comes back.
    const later = startOfNextDay(FIXED_NOW + DAY);
    const rebury = { ...step.state, cards: step.state.cards.map((c) => (c.id === 'b' ? { ...c, buriedUntil: later } : c)) };
    const undone = undoManualEdit(rebury, { editId: step.result.edit.id }, ctxAt());
    expect(undone.result).toEqual({ reverted: 1, skipped: 1 });
    expect(card(undone.state, 'a').buriedUntil).toBeNull();
    expect(card(undone.state, 'b').buriedUntil).toBe(later);
    expect(undone.state.manualLog).toEqual([]);
    // Nothing to bury (already buried until then): no edit, nothing to undo.
    const again = bury(step.state, { cardIds: ['a'] }, ctxAt());
    expect(again.state).toBe(step.state);
    expect(again.result.undoable).toBe(false);
  });

  it('a bury never breaks the session undo: undoLastReview still takes back the last rating', () => {
    const s = stateWith([item('a', 'review', { due: FIXED_NOW - HOUR }), item('b', 'review', { due: FIXED_NOW - HOUR })]);
    const rated = rateCard(s, { cardId: 'a', rating: 'good' }, ctxAt()).state;
    const buried = bury(rated, { cardIds: ['b'] }, ctxAt()).state;
    expect(buried.reviewLog).toEqual(rated.reviewLog);
    const undone = undoLastReview(buried, undefined, ctxAt());
    expect(undone.result).toBe(true);
    expect(card(undone.state, 'a')).toEqual(card(s, 'a'));
    expect(card(undone.state, 'b').buriedUntil).toBe(startOfNextDay(FIXED_NOW)); // the bury stays
    // …and the bury's own Undo still works after it (a rating never touches buriedUntil).
    const edit = buried.manualLog[buried.manualLog.length - 1];
    const unburied = undoManualEdit(undone.state, { editId: edit.id }, ctxAt());
    expect(unburied.result).toEqual({ reverted: 1, skipped: 0 });
    expect(card(unburied.state, 'b').buriedUntil).toBeNull();
  });
});

/* -------------------------------------------------- card state (triage.ts) */

describe('card-state commands (triage.ts) record one ManualEdit each', () => {
  const s = () => stateWith([item('a', 'notStarted'), item('b'), item('c', 'review')]);

  it('setFlags: flags change, an edit is stored, undoManualEdit takes it back', () => {
    const step = setFlags(s(), { cardIds: ['a', 'b'], patch: { suspended: true } }, ctxAt());
    expect([card(step.state, 'a').suspended, card(step.state, 'b').suspended]).toEqual([true, true]);
    expect(step.result).toMatchObject({ undoable: true, skipped: 0, edit: { kind: 'flags', label: '2 cards suspended' } });
    expect(step.state.manualLog).toHaveLength(1);
    const undone = undoManualEdit(step.state, { editId: step.result.edit.id }, ctxAt());
    expect(undone.result).toEqual({ reverted: 2, skipped: 0 });
    expect(undone.state.cards).toEqual(s().cards);
    expect(undone.state.manualLog).toEqual([]);
  });

  it('setFlags copies only the three flag keys, even from a patch forced past the type check', () => {
    // (W5-3: ported from the deleted flag alias. The compile-time half lives in
    // actions.ts SetFlagsPatch and is pinned by engine.integration.test.ts.)
    const forced = { flagged: true, ease: 1.3, reps: 99, due: 0, noteId: 'x', deckId: 'y', buriedUntil: 1 } as never;
    const { state } = setFlags(s(), { cardIds: ['c'], patch: forced }, ctxAt());
    expect(card(state, 'c')).toEqual({ ...card(s(), 'c'), flagged: true });
  });

  it('learn: Not started → New; first puts the cards first in their deck', () => {
    const step = learn(s(), { cardIds: ['a'], first: true }, ctxAt());
    const a = card(step.state, 'a');
    expect(life(a)).toBe('new');
    expect(a.newPos).toBeLessThan(card(step.state, 'b').newPos);
    expect(step.result.edit.kind).toBe('learn');
  });

  it('markKnown sets knownAt = now only', () => {
    const step = markKnown(s(), { cardIds: ['b'] }, ctxAt());
    expect(card(step.state, 'b')).toEqual({ ...card(s(), 'b'), knownAt: FIXED_NOW });
  });

  it('setNotStarted skips studied cards and counts them', () => {
    const step = setNotStarted(s(), { cardIds: ['b', 'c'] }, ctxAt());
    expect(life(card(step.state, 'b'))).toBe('notStarted');
    expect(card(step.state, 'c')).toEqual(card(s(), 'c'));
    expect(step.result.skipped).toBe(1);
  });

  it('resetProgress: a studied card is New again', () => {
    const step = resetProgress(s(), { cardIds: ['c'] }, ctxAt());
    expect(card(step.state, 'c')).toMatchObject({ reps: 0, lapses: 0, intervalDays: 0, stepIndex: null, due: FIXED_NOW });
  });

  it('reschedule sets due only; New cards are skipped', () => {
    const step = reschedule(s(), { cardIds: ['b', 'c'], dueMs: FIXED_NOW + 3 * DAY }, ctxAt());
    expect(card(step.state, 'c')).toEqual({ ...card(s(), 'c'), due: FIXED_NOW + 3 * DAY });
    expect(step.result.skipped).toBe(1);
  });

  it('undoManualEdit of an unknown id changes nothing', () => {
    const state = s();
    expect(undoManualEdit(state, { editId: 'nope' }, ctxAt())).toEqual({ state, result: { reverted: 0, skipped: 0 } });
  });
});

/* -------------------------------------------------------- notes (noteOps.ts) */

describe('note commands (noteOps.ts)', () => {
  it('addNote: one card per enabled direction; the built-in type is written on first use', () => {
    const s = stateWith([]);
    const { state, result } = addNote(
      s,
      { deckId: DECK, typeId: BUILTIN_TYPE_IDS.basicReverse, fields: ['der Hund', 'the dog'], tags: ['animal'] },
      ctxAt(),
    );
    expect(result.cardIds).toHaveLength(2);
    expect(state.notes.find((n) => n.id === result.noteId)).toMatchObject({ fields: ['der Hund', 'the dog', '', ''], tags: ['animal'] });
    expect(state.cards.filter((c) => c.noteId === result.noteId).map((c) => c.ord)).toEqual([0, 1]);
    expect(state.noteTypes.map((t) => t.id)).toContain(BUILTIN_TYPE_IDS.basicReverse);
    expect(valid(state)).toEqual([]);
  });

  it('addNote into a deck that does not exist: nothing added, noteId empty, the same state', () => {
    const s = stateWith([]);
    const step = addNote(s, { deckId: 'nope', typeId: BUILTIN_TYPE_IDS.basic, fields: ['a', 'b'], tags: [] }, ctxAt());
    expect(step).toEqual({ state: s, result: { noteId: '', cardIds: [] } });
  });

  it('editNote changes the note, so every direction shows the new text', () => {
    const s = stateWith([item('a', 'new', {}, { typeId: BUILTIN_TYPE_IDS.basicReverse })]);
    const { state } = editNote(s, { noteId: 'n-a', patch: { fields: ['neu', 'new'], tags: ['x'] } }, ctxAt());
    expect(state.notes[0]).toMatchObject({ fields: ['neu', 'new', '', ''], tags: ['x'], updatedAt: FIXED_NOW });
    expect(state.cards).toBe(s.cards);
  });

  it('moveNotes moves every card of the note; tagNotes adds and removes tags', () => {
    const s = stateOfV3({
      decks: [makeDeckV3({ id: DECK }), makeDeckV3({ id: 'd2', name: 'Other' })],
      groups: [item('a', 'new', {}, { typeId: BUILTIN_TYPE_IDS.basicReverse })],
    });
    const moved = moveNotes(s, { noteIds: ['n-a'], deckId: 'd2' }, ctxAt());
    expect(moved.state.cards.map((c) => c.deckId)).toEqual(['d2', 'd2']);
    expect(moved.result.edit.kind).toBe('move');
    const tagged = tagNotes(moved.state, { noteIds: ['n-a'], add: ['verb'], remove: [] }, ctxAt());
    expect(tagged.state.notes[0].tags).toEqual(['verb']);
  });

  it('deleteNotes removes the notes with all their cards; undoDelete puts them back once', () => {
    const s = stateWith([item('a', 'review', {}, { typeId: BUILTIN_TYPE_IDS.basicReverse }), item('b')]);
    const del = deleteNotes(s, { noteIds: ['n-a'] });
    expect(del.state.notes.map((n) => n.id)).toEqual(['n-b']);
    expect(del.state.cards.map((c) => c.id)).toEqual(['b']);
    expect(del.result.label).toBe('2 cards deleted');
    const back = undoDelete(del.state, { deleted: del.result });
    expect(back.result).toBe(true);
    expect(back.state.notes).toEqual(s.notes);
    expect(back.state.cards).toEqual(s.cards);
    expect(undoDelete(back.state, { deleted: del.result }).result).toBe(false);
  });
});

/* ----------------------------------------------------------- deck commands */

describe('addDeck and updateDeck', () => {
  it('addDeck: a v3 deck at the end, made in the app, with its description and languages', () => {
    const s = stateWith([]);
    const { state, result } = addDeck(
      s,
      { input: { name: 'Birds', desc: 'Garden birds', language: 'de-DE', meaningLanguage: 'en-US', defaultTypeId: BUILTIN_TYPE_IDS.basicReverse } },
      ctxAt(),
    );
    expect(result).toEqual({
      id: expect.stringMatching(/^d-/),
      name: 'Birds',
      icon: '🗂️',
      desc: 'Garden birds',
      active: true,
      order: 1,
      source: 'manual',
      language: 'de-DE',
      meaningLanguage: 'en-US',
      defaultTypeId: BUILTIN_TYPE_IDS.basicReverse,
      options: { newPerDay: null, newOrder: 'source', newArrival: 'queued', knownChecks: true },
      createdAt: FIXED_NOW,
    });
    expect(last(state.decks)).toBe(result);
  });

  it('addDeck: an unknown card type is not used (Basic is the default)', () => {
    const { result } = addDeck(stateWith([]), { input: { name: 'x', defaultTypeId: 'nt-nope' } }, ctxAt());
    expect(result.defaultTypeId).toBe(BUILTIN_TYPE_IDS.basic);
  });

  it('updateDeck changes only the allowed keys; an explicit undefined clears the description', () => {
    const s = stateWith([], { decks: [makeDeckV3({ id: DECK, name: 'A', desc: 'old' })] });
    const forced = { name: 'Paused', active: false, desc: undefined, order: 99, options: {} } as never;
    const { state } = updateDeck(s, { deckId: DECK, patch: forced }, ctxAt());
    expect(state.decks[0]).toMatchObject({ id: DECK, name: 'Paused', active: false, order: s.decks[0].order });
    expect('desc' in state.decks[0]).toBe(false);
    expect(state.decks[0].options).toBe(s.decks[0].options);
    // Nothing really changes → the same state.
    expect(updateDeck(state, { deckId: DECK, patch: { name: 'Paused' } }, ctxAt()).state).toBe(state);
    expect(updateDeck(state, { deckId: 'nope', patch: { name: 'x' } }, ctxAt()).state).toBe(state);
  });

  it('updateDeck: a defaultTypeId that names no card type is ignored (like addDeck); a real one is kept', () => {
    const s = stateWith([]);
    const before = s.decks[0];
    expect(updateDeck(s, { deckId: DECK, patch: { defaultTypeId: 'nt-gone' } }, ctxAt()).state).toBe(s);
    const both = updateDeck(s, { deckId: DECK, patch: { defaultTypeId: 'nt-gone', icon: '🧪' } }, ctxAt()).state.decks[0];
    expect(both).toEqual({ ...before, icon: '🧪' }); // the other key still changes
    // A built-in type (not in the state yet) and a type in the state both count.
    const builtin = updateDeck(s, { deckId: DECK, patch: { defaultTypeId: BUILTIN_TYPE_IDS.cloze } }, ctxAt()).state;
    expect(builtin.decks[0].defaultTypeId).toBe(BUILTIN_TYPE_IDS.cloze);
    const withType = stateWith([item('a')]);
    const own: DataStateV3 = { ...withType, noteTypes: [...withType.noteTypes, { ...withType.noteTypes[0], id: 'nt-mine' }] };
    expect(updateDeck(own, { deckId: DECK, patch: { defaultTypeId: 'nt-mine' } }, ctxAt()).state.decks[0].defaultTypeId).toBe('nt-mine');
  });

  it('updateDeck: an empty or blank name is ignored; the deck keeps its name', () => {
    const s = stateWith([]);
    for (const name of ['', '   ', 42 as never]) {
      expect(updateDeck(s, { deckId: DECK, patch: { name } }, ctxAt()).state).toBe(s);
    }
    const paused = updateDeck(s, { deckId: DECK, patch: { name: ' ', active: false } }, ctxAt()).state.decks[0];
    expect(paused).toMatchObject({ name: 'Capitals', active: false });
  });

  it('updateDeck: defaultTypeChosen (the deck editor saved the card type as a choice) is kept; a non-boolean is ignored', () => {
    const s = stateWith([]);
    const chosen = updateDeck(
      s,
      { deckId: DECK, patch: { defaultTypeId: BUILTIN_TYPE_IDS.basic, defaultTypeChosen: true } },
      ctxAt(),
    ).state.decks[0];
    expect(chosen).toMatchObject({ defaultTypeId: BUILTIN_TYPE_IDS.basic, defaultTypeChosen: true });
    expect(updateDeck(s, { deckId: DECK, patch: { defaultTypeChosen: 'yes' as never } }, ctxAt()).state).toBe(s);
  });
});

describe('setDeckOptions, setDirections, updateNoteType, reorderDecks', () => {
  it('setDeckOptions: a whole new cap ≥ 0 or null; wrong kinds are ignored; directions copied or removed', () => {
    const s = stateWith([]);
    const step = setDeckOptions(s, {
      deckId: DECK,
      patch: { newPerDay: 7.6, newOrder: 'random', newArrival: 'notStarted', knownChecks: false, directions: { t: [2, 0, 0, -1] } },
    });
    expect(step.state.decks[0].options).toEqual({
      newPerDay: 8,
      newOrder: 'random',
      newArrival: 'notStarted',
      knownChecks: false,
      directions: { t: [0, 2] },
    });
    const bad = setDeckOptions(step.state, { deckId: DECK, patch: { newPerDay: Number.NaN, newOrder: 'x' as never } });
    expect(bad.state).toBe(step.state);
    const cleared = setDeckOptions(step.state, { deckId: DECK, patch: { newPerDay: null, directions: undefined } });
    expect(cleared.state.decks[0].options).toEqual({ newPerDay: null, newOrder: 'random', newArrival: 'notStarted', knownChecks: false });
  });

  it('setDirections creates the missing direction as New cards', () => {
    const s = stateWith([item('a', 'review', {}, { typeId: BUILTIN_TYPE_IDS.basicReverse })].map((g) => ({ ...g, cards: [g.cards[0]] })));
    const { state, result } = setDirections(s, { deckId: DECK, typeId: BUILTIN_TYPE_IDS.basicReverse, ords: [0, 1] }, ctxAt());
    expect(result).toEqual({ created: 1 });
    expect(state.cards.map((c) => [c.ord, life(c)])).toEqual([
      [0, 'review'],
      [1, 'new'],
    ]);
  });

  it('updateNoteType: roles, labels, language and facet change; names stay; a wrong length is ignored', () => {
    const s = stateWith([item('a')]);
    const type = s.noteTypes[0];
    const fields = type.fields.map((f, i) =>
      i === 1 ? { ...f, name: 'Renamed', role: 'badge' as const, label: 'Level', lang: 'de-DE', facet: 'on' as const } : f,
    );
    const { state } = updateNoteType(s, { typeId: type.id, patch: { name: ' Vocabulary ', fields } }, ctxAt(FIXED_NOW + MIN));
    const updated = state.noteTypes[0];
    expect(updated.name).toBe('Vocabulary');
    expect(updated.fields[1]).toEqual({ name: type.fields[1].name, role: 'badge', label: 'Level', lang: 'de-DE', facet: 'on' });
    expect(updated.updatedAt).toBe(FIXED_NOW + MIN);
    expect(updateNoteType(state, { typeId: type.id, patch: { fields: fields.slice(1) } }, ctxAt()).state).toBe(state);
    // A built-in type that is not in the state yet is written into it.
    const plain = makeStateV3();
    const written = updateNoteType(plain, { typeId: BUILTIN_TYPE_IDS.cloze, patch: { name: 'Gaps' } }, ctxAt());
    expect(written.state.noteTypes.map((t) => [t.id, t.name])).toEqual([[BUILTIN_TYPE_IDS.cloze, 'Gaps']]);
  });

  it('reorderDecks: the listed decks first, the rest in their old order; only `order` changes', () => {
    const decks = [makeDeckV3({ id: 'a', order: 0 }), makeDeckV3({ id: 'b', order: 1 }), makeDeckV3({ id: 'c', order: 2 })];
    const s = makeStateV3({ decks });
    const { state } = reorderDecks(s, { deckIds: ['c', 'missing', 'a'] });
    expect(state.decks.map((d) => [d.id, d.order])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 0],
    ]);
    expect(reorderDecks(state, { deckIds: ['c', 'a'] }).state).toBe(state);
  });
});

describe('deleteDeck — no orphan card or note, whatever the strategy', () => {
  const twoDecks = () =>
    stateOfV3({
      decks: [makeDeckV3({ id: 'a', name: 'A', order: 0 }), makeDeckV3({ id: 'b', name: 'B', order: 1 })],
      groups: [
        item('a1', 'review', {}, { deckId: 'a', typeId: BUILTIN_TYPE_IDS.basicReverse }),
        item('a2', 'new', {}, { deckId: 'a' }),
        item('b1', 'new', {}, { deckId: 'b' }),
      ],
      overrides: { pack: { id: 'german', installed: { vocabulary: 'a', verbs: 'b' } } },
    });

  const cases: [string, DeleteStrategy, string[], string | null][] = [
    ['delete: the cards go too', { kind: 'delete' }, ['b1'], null],
    ['move to a real deck', { kind: 'move', targetDeckId: 'b' }, ['a1', 'a1-1', 'a2', 'b1'], 'b'],
    ['keep: the cards go to Unfiled', { kind: 'keep' }, ['a1', 'a1-1', 'a2', 'b1'], UNFILED_DECK_ID],
    ['move to a missing deck acts like keep', { kind: 'move', targetDeckId: 'gone' }, ['a1', 'a1-1', 'a2', 'b1'], UNFILED_DECK_ID],
    ['move to the deleted deck itself acts like keep', { kind: 'move', targetDeckId: 'a' }, ['a1', 'a1-1', 'a2', 'b1'], UNFILED_DECK_ID],
    ['move to an empty id acts like keep', { kind: 'move', targetDeckId: '' }, ['a1', 'a1-1', 'a2', 'b1'], UNFILED_DECK_ID],
  ];

  it.each(cases)('%s', (_name, strategy, cardIds, newHome) => {
    const { state } = deleteDeck(twoDecks(), { deckId: 'a', strategy }, ctxAt());
    expect(state.decks.some((d) => d.id === 'a')).toBe(false);
    expect(state.cards.map((c) => c.id).sort()).toEqual(cardIds);
    if (newHome) expect(state.cards.filter((c) => c.noteId === 'n-a1').map((c) => c.deckId)).toEqual([newHome, newHome]);
    expect(valid(state)).toEqual([]); // no orphan card, no note without a card, notes stay in one deck
    expect(state.pack).toEqual({ id: 'german', installed: { verbs: 'b' } }); // the starter entry is gone
  });

  it('delete: the notes left without cards go too; the Unfiled deck is a valid v3 deck', () => {
    const del = deleteDeck(twoDecks(), { deckId: 'a', strategy: { kind: 'delete' } }, ctxAt()).state;
    expect(del.notes.map((n) => n.id)).toEqual(['n-b1']);
    const keep = deleteDeck(twoDecks(), { deckId: 'a', strategy: { kind: 'keep' } }, ctxAt()).state;
    expect(keep.decks.find((d) => d.id === UNFILED_DECK_ID)).toMatchObject({
      name: 'Unfiled cards',
      active: true,
      order: 2,
      source: 'manual',
      options: { newArrival: 'queued' },
    });
    expect(keep.notes.map((n) => n.id)).toEqual(['n-a1', 'n-a2', 'n-b1']); // keep: every note stays
  });

  it('a deck that does not exist: the same state', () => {
    const s = twoDecks();
    expect(deleteDeck(s, { deckId: 'nope', strategy: { kind: 'delete' } }, ctxAt())).toEqual({
      state: s,
      result: { deleted: false, movedTo: null },
    });
    expect(deleteDeck(s, { deckId: 'nope', strategy: { kind: 'delete' } }, ctxAt()).state).toBe(s);
  });

  it('the result says where the cards went, so the engine can move their image folder first', () => {
    const run = (strategy: DeleteStrategy, deckId = 'a') => deleteDeck(twoDecks(), { deckId, strategy }, ctxAt()).result;
    expect(run({ kind: 'delete' })).toEqual({ deleted: true, movedTo: null });
    expect(run({ kind: 'move', targetDeckId: 'b' })).toEqual({ deleted: true, movedTo: 'b' });
    expect(run({ kind: 'keep' })).toEqual({ deleted: true, movedTo: UNFILED_DECK_ID });
    expect(run({ kind: 'move', targetDeckId: 'gone' })).toEqual({ deleted: true, movedTo: UNFILED_DECK_ID });
    // A deck with no cards: nothing moved, so its folder needs no copy.
    const empty = stateOfV3({ decks: [makeDeckV3({ id: 'e', order: 0 }), makeDeckV3({ id: 'b', order: 1 })], groups: [] });
    expect(deleteDeck(empty, { deckId: 'e', strategy: { kind: 'move', targetDeckId: 'b' } }, ctxAt()).result).toEqual({
      deleted: true,
      movedTo: null,
    });
  });
});

describe('duplicateDeck', () => {
  it('a copy with new ids and guids and no progress; null for a missing deck', () => {
    const s = stateWith([item('a', 'mastered', { fav: true }), item('b')]);
    const { state, result } = duplicateDeck(s, { deckId: DECK }, ctxAt());
    if (!result) throw new Error('no copy');
    expect(result).toMatchObject({ name: 'Capitals (copy)', active: true, order: 1 });
    const copies = state.cards.filter((c) => c.deckId === result.id);
    expect(copies).toHaveLength(2);
    expect(copies.every((c) => c.reps === 0 && !c.fav)).toBe(true);
    expect(valid(state)).toEqual([]);
    expect(duplicateDeck(s, { deckId: 'nope' }, ctxAt())).toEqual({ state: s, result: null });
  });
});

/* --------------------------------------------------------------- import */

/** A CSV → a plan (the real reader and planner), into a new deck or an existing one. */
function csvPlan(state: DataStateV3, text: string, target: ImportChoices['target'], prefix: string): ImportPlan {
  const collection = readCsv(text, 'kitchen.csv');
  return planFor(state, collection, target, prefix, 'csv');
}

/** An .apkg fixture → a plan. */
function apkgPlan(state: DataStateV3, collection: AnkiCollection, target: ImportChoices['target'], prefix: string): ImportPlan {
  return planFor(state, collection, target, prefix, 'apkg');
}

function planFor(
  state: DataStateV3,
  collection: AnkiCollection,
  target: ImportChoices['target'],
  prefix: string,
  kind: 'csv' | 'apkg',
): ImportPlan {
  const types: ImportChoices['types'] = {};
  for (const mid of Object.keys(collection.models)) {
    const model = collection.models[mid];
    types[mid] = {
      fields: positionalFieldDefs(model.flds.map((f) => f.name)),
      ords: kind === 'csv' ? [0] : model.tmpls.map((t) => t.ord),
    };
  }
  let n = 0;
  return planImport(
    collection,
    state,
    {
      sections: new Set(Object.keys(collection.decks)),
      target,
      types,
      progress: 'keep',
      arrival: 'queued',
      elsewhere: 'update',
      images: true,
    },
    { now: FIXED_NOW, newId: () => `${prefix}-${(n += 1)}`, srs: state.settings.srs, fieldFacetSpecs, detectOrdinal },
  );
}

function verbsFixture(): AnkiCollection {
  const fx = ankiFixture('german_verbs');
  return collectionFromRows({ fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media });
}

/** The numbers of a summary that a result must repeat when nothing changed in between. */
function resultOfSummary(plan: ImportPlan) {
  const s = plan.summary;
  return {
    notesAdded: s.notesAdded,
    cardsAdded: s.cardsAdded,
    notesUpdated: s.notesUpdated,
    notesUnchanged: s.notesUnchanged,
    cardsUpdated: s.cardsUpdated,
    updatedDecks: s.updatedDecks,
    cardTypesUpdated: s.cardTypesUpdated,
    notesRetired: s.notesRetired,
    notesSkipped: s.notesSkipped,
    skipped: s.skipped,
    markedKnown: s.markedKnown,
    media: plan.media,
  };
}

describe('applyImport: ONE step, and the result says what really happened', () => {
  it('a CSV into a new deck: deck, card type, notes and cards in one state; the result equals the summary', () => {
    const s = stateWith([item('old')]);
    const plan = csvPlan(s, 'la cuchara,spoon\nel tenedor,fork\nel cuchillo,knife', { kind: 'new', name: 'Kitchen', icon: '🍴' }, 'k');
    const { state, result } = applyImport(s, { plan }, ctxAt());
    expect(result).toEqual({ deckId: plan.deck?.id, deckCreated: true, ...resultOfSummary(plan) });
    expect(result.cardsAdded).toBe(3);
    expect(state.decks).toEqual([...s.decks, plan.deck]);
    expect(state.notes).toEqual([...s.notes, ...plan.notes.add]);
    expect(state.cards).toEqual([...s.cards, ...plan.cards.add]);
    expect(state.noteTypes).toEqual([...s.noteTypes, ...plan.noteTypes.add]);
    expect(state.cards[0]).toBe(s.cards[0]); // old rows keep their identity
    expect(valid(state)).toEqual([]);
  });

  it('applying the same plan twice adds nothing the second time', () => {
    const s = stateWith([]);
    const plan = csvPlan(s, 'a,b\nc,d', { kind: 'new', name: 'Twice', icon: '' }, 't');
    const once = applyImport(s, { plan }, ctxAt()).state;
    const twice = applyImport(once, { plan }, ctxAt());
    expect(twice.state).toBe(once);
    expect(twice.result).toMatchObject({ notesAdded: 0, cardsAdded: 0, deckCreated: false });
    expect(twice.result.skipped).toEqual(plan.summary.skipped); // already added is not "skipped"
  });

  it('a real .apkg (German verbs), then the same file again with one change: an update in place, progress kept', () => {
    const s = stateWith([]);
    const verbs = verbsFixture();
    const first = apkgPlan(s, verbs, { kind: 'new', name: '', icon: '🇩🇪' }, 'v');
    const imported = applyImport(s, { plan: first }, ctxAt());
    expect(imported.result).toEqual({ deckId: first.deck?.id, deckCreated: true, ...resultOfSummary(first) });
    expect(valid(imported.state)).toEqual([]);
    const deckId = imported.result.deckId as Id;

    // Study one card, then re-import the file with one field changed.
    const studied = imported.state.cards.find((c) => c.deckId === deckId) as Card;
    const rated = rateCard(imported.state, { cardId: studied.id, rating: 'good' }, ctxAt()).state;
    const edited: AnkiCollection = {
      ...verbs,
      notes: verbs.notes.map((n, i) => (i === 0 ? { ...n, flds: n.flds.map((f, j) => (j === 1 ? `${f} (edited)` : f)) } : n)),
    };
    const second = apkgPlan(rated, edited, { kind: 'existing', deckId }, 'w');
    const updated = applyImport(rated, { plan: second }, ctxAt());
    expect(updated.result).toEqual({ deckId, deckCreated: false, ...resultOfSummary(second) });
    expect(updated.result.notesUpdated).toBe(1);
    expect(updated.result.notesAdded).toBe(0);
    expect(card(updated.state, studied.id)).toBe(card(rated, studied.id)); // the progress is kept
    const changedNote = updated.state.notes.find((n) => n.id === second.notes.update[0].id) as Note;
    expect(changedNote.fields[1]).toMatch(/\(edited\)$/);
  });

  it('the library changed after the plan: a deleted note is not updated, and the result says so', () => {
    const s = stateWith([]);
    const verbs = verbsFixture();
    const imported = applyImport(s, { plan: apkgPlan(s, verbs, { kind: 'new', name: '', icon: '' }, 'x') }, ctxAt());
    const deckId = imported.result.deckId as Id;
    const edited: AnkiCollection = {
      ...verbs,
      notes: verbs.notes.map((n, i) => (i < 2 ? { ...n, flds: n.flds.map((f, j) => (j === 1 ? `${f}!` : f)) } : n)),
    };
    const plan = apkgPlan(imported.state, edited, { kind: 'existing', deckId }, 'y');
    expect(plan.summary.notesUpdated).toBe(2);
    const gone = deleteNotes(imported.state, { noteIds: [plan.notes.update[0].id] }).state;
    const { result } = applyImport(gone, { plan }, ctxAt());
    expect(result.notesUpdated).toBe(1);
    expect(result.cardsUpdated).toBeLessThan(plan.summary.cardsUpdated);
  });

  it('the target deck was deleted after the plan: nothing lands, no orphan, and the result has no deck', () => {
    const s = stateWith([item('a')]);
    const plan = csvPlan(s, 'x,y', { kind: 'existing', deckId: DECK }, 'z');
    expect(plan.summary.notesAdded).toBe(1);
    const gone = deleteDeck(s, { deckId: DECK, strategy: { kind: 'delete' } }, ctxAt()).state;
    const { state, result } = applyImport(gone, { plan }, ctxAt());
    expect(state).toBe(gone);
    expect(result).toMatchObject({ deckId: null, deckCreated: false, notesAdded: 0, cardsAdded: 0 });
    expect(result.skipped.empty).toBe(plan.summary.skipped.empty + 1);
    expect(result.notesSkipped).toBe(plan.summary.notesSkipped + 1);
  });

  it('into an existing deck: the result names that deck', () => {
    const s = stateWith([item('a')]);
    const plan = csvPlan(s, 'neu,new', { kind: 'existing', deckId: DECK }, 'e');
    expect(plan.deck).toBeNull();
    const { result } = applyImport(s, { plan }, ctxAt());
    expect(result).toMatchObject({ deckId: DECK, deckCreated: false, notesAdded: 1, cardsAdded: 1 });
  });

  it('media: only the folders of decks that exist after the step', () => {
    const s = stateWith([]);
    const plan = csvPlan(s, 'a,b', { kind: 'new', name: 'M', icon: '' }, 'm');
    const withMedia: ImportPlan = {
      ...plan,
      media: [
        { deckFolder: `media/${plan.deck?.id}`, files: ['a.png'] },
        { deckFolder: 'media/gone', files: ['b.png'] },
      ],
    };
    expect(applyImport(s, { plan: withMedia }, ctxAt()).result.media).toEqual([{ deckFolder: `media/${plan.deck?.id}`, files: ['a.png'] }]);
  });
});

describe('applyImport: a card-type upgrade (a newer version of an Anki model) and retired notes', () => {
  const VOCAB_MID = '2710111000';
  const vocab = (name: 'german_vocabulary' | 'german_vocabulary_v2' | 'german_vocabulary_v1'): AnkiCollection => {
    const fx = ankiFixture(name);
    return collectionFromRows({ fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media });
  };

  /**
   * German Vocabulary version 1 imported; one card studied; and one note of the
   * learner's own with the same card type (it is in no file).
   */
  function v1Library() {
    const s = stateWith([]);
    const first = apkgPlan(s, vocab('german_vocabulary_v1'), { kind: 'new', name: '', icon: '🇩🇪' }, 'v');
    const imported = applyImport(s, { plan: first }, ctxAt()).state;
    const deckId = first.deck?.id as Id;
    const studied = imported.cards.find((c) => c.deckId === deckId) as Card;
    const rated = rateCard(imported, { cardId: studied.id, rating: 'good' }, ctxAt()).state;
    const type = rated.noteTypes.find((t) => t.source?.ankiMid === VOCAB_MID) as NoteType;
    const base = rated.notes[0];
    const own: Note = { ...base, id: 'n-own', guid: 'm-own', fields: type.fields.map((_, i) => (i === 0 ? 'mein Wort' : '')), source: { kind: 'manual' } };
    const ownCard: Card = { ...(rated.cards.find((c) => c.noteId === base.id) as Card), id: 'c-own', noteId: 'n-own' };
    const lib: DataStateV3 = { ...rated, notes: [...rated.notes, own], cards: [...rated.cards, ownCard] };
    return { lib, deckId, studiedId: studied.id, typeId: type.id };
  }

  it('the card type gets the new fields; EVERY note of it moves to the new order (also notes in no file); progress kept', () => {
    const { lib, deckId, studiedId, typeId } = v1Library();
    expect(valid(lib)).toEqual([]);
    const plan = apkgPlan(lib, vocab('german_vocabulary_v2'), { kind: 'existing', deckId }, 'w');
    expect(plan.noteTypes.upgrade.map((u) => u.type.id)).toEqual([typeId]);

    const { state, result } = applyImport(lib, { plan }, ctxAt());
    expect(result).toEqual({ deckId, deckCreated: false, ...resultOfSummary(plan) });
    expect(result).toMatchObject({ cardTypesUpdated: 1, notesUpdated: 18, notesAdded: 2, notesRetired: 0 });
    expect(valid(state)).toEqual([]); // every note fits its card type
    const type = state.noteTypes.find((t) => t.id === typeId) as NoteType;
    expect(type.fields.map((f) => f.name)).toEqual([
      'Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'MarankiExample', 'Level', 'Type', 'Plural',
    ]);
    expect(state.noteTypes.filter((t) => t.source?.ankiMid === VOCAB_MID)).toHaveLength(1);
    // The learner's own note and the notes version 2 dropped get two empty values.
    const before = (id: Id) => (lib.notes.find((n) => n.id === id) as Note).fields;
    const after = (id: Id) => (state.notes.find((n) => n.id === id) as Note).fields;
    expect(after('n-own')).toEqual([...before('n-own'), '', '']);
    const dropped = lib.notes.filter((n) => n.typeId === typeId && /\(Sg\.\)$/.test(n.fields[0]));
    expect(dropped).toHaveLength(2);
    for (const n of dropped) expect(after(n.id)).toEqual([...n.fields, '', '']);
    // A matched note has the new values, and its cards (with their progress) are the same objects.
    expect(card(state, studiedId)).toBe(card(lib, studiedId));
    expect(state.cards.slice(0, lib.cards.length)).toEqual(lib.cards);

    // The same plan again changes nothing: the type already has the new fields.
    const twice = applyImport(state, { plan }, ctxAt());
    expect(twice.state).toBe(state);
    expect(twice.result).toMatchObject({ cardTypesUpdated: 0, notesUpdated: 0, notesAdded: 0, notesUnchanged: 18 });
  });

  it('an upgrade planned on an older card type is skipped, and so is every value that would not fit the type', () => {
    const { lib, deckId, typeId } = v1Library();
    const plan = apkgPlan(lib, vocab('german_vocabulary_v2'), { kind: 'existing', deckId }, 'w');
    // After the plan, the card type changed (one more field), with its notes.
    const extra = { name: 'Gender', role: 'detail' as const, facet: 'off' as const };
    const changed: DataStateV3 = {
      ...lib,
      noteTypes: lib.noteTypes.map((t) => (t.id === typeId ? { ...t, fields: [...t.fields, extra] } : t)),
      notes: lib.notes.map((n) => (n.typeId === typeId ? { ...n, fields: [...n.fields, ''] } : n)),
    };
    expect(valid(changed)).toEqual([]);
    const { state, result } = applyImport(changed, { plan }, ctxAt());
    expect(result).toMatchObject({ cardTypesUpdated: 0, notesUpdated: 0, notesAdded: 0, cardsAdded: 0 });
    expect(result.skipped.empty).toBe(plan.summary.skipped.empty + 2); // the 2 new notes did not fit
    expect(state).toBe(changed);
    expect(valid(state)).toEqual([]);
  });

  /** German Vocabulary version 2 imported, and one note of the learner's own (MarankiExample = `ownExample`). */
  function v2Library(ownExample: string) {
    const s = stateWith([]);
    const first = apkgPlan(s, vocab('german_vocabulary_v2'), { kind: 'new', name: '', icon: '🇩🇪' }, 'v');
    const imported = applyImport(s, { plan: first }, ctxAt()).state;
    const type = imported.noteTypes.find((t) => t.source?.ankiMid === VOCAB_MID) as NoteType;
    const at = type.fields.findIndex((f) => f.name === 'MarankiExample');
    const base = imported.notes[0];
    const own: Note = {
      ...base,
      id: 'n-own',
      guid: 'm-own',
      fields: type.fields.map((_, i) => (i === 0 ? 'mein Wort' : i === at ? ownExample : '')),
      source: { kind: 'manual' },
    };
    const ownCard: Card = { ...(imported.cards.find((c) => c.noteId === base.id) as Card), id: 'c-own', noteId: 'n-own' };
    const lib: DataStateV3 = { ...imported, notes: [...imported.notes, own], cards: [...imported.cards, ownCard] };
    return { lib, deckId: first.deck?.id as Id, typeId: type.id, at };
  }

  it('a field the newer version REMOVED: the type loses it, every note moves, progress kept', () => {
    const { lib, deckId, typeId } = v2Library('');
    const plan = apkgPlan(lib, vocab('german_vocabulary'), { kind: 'existing', deckId }, 'w');
    expect(plan.noteTypes.upgrade.map((u) => u.type.id)).toEqual([typeId]);
    const { state, result } = applyImport(lib, { plan }, ctxAt());
    // The result says what the plan said: 20 updated. "braten" counts too: since version 3 it
    // has the same Examples (its MarankiExample sentence was dropped as a near-copy), so the
    // only change is that the removed field's text is gone.
    expect(result).toEqual({ deckId, deckCreated: false, ...resultOfSummary(plan) });
    expect(result).toMatchObject({ cardTypesUpdated: 1, notesUpdated: 20, notesUnchanged: 0, notesAdded: 0, cardsAdded: 0 });
    expect(valid(state)).toEqual([]);
    const type = state.noteTypes.find((t) => t.id === typeId) as NoteType;
    expect(type.fields.map((f) => f.name)).toEqual(['Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'Level', 'Type', 'Plural']);
    expect(state.noteTypes.filter((t) => t.source?.ankiMid === VOCAB_MID)).toHaveLength(1);
    const bad = state.notes.find((n) => n.fields[0] === 'das Bad') as Note;
    expect(bad.fields[3]).toContain('Fafefo nakute fafefo guno tirapuna sañomifo remüto?');
    const braten = state.notes.find((n) => n.fields[0] === 'braten') as Note;
    expect(braten.fields).toHaveLength(8);
    expect(braten.updatedAt).toBe(ctxAt().now);
    // The learner's own note had no text there: it only moves to the new order.
    expect((state.notes.find((n) => n.id === 'n-own') as Note).fields).toEqual(['mein Wort', '', '', '', '', '', '', '']);
    expect(state.cards).toEqual(lib.cards);
  });

  it('the removal is refused when a note that the plan does not update has text there NOW (the plan is out of date)', () => {
    const { lib, deckId, at } = v2Library('');
    const plan = apkgPlan(lib, vocab('german_vocabulary'), { kind: 'existing', deckId }, 'w');
    expect(plan.noteTypes.upgrade).toHaveLength(1);
    // After the plan, the learner typed a sentence into that field of their own card.
    const typed: DataStateV3 = {
      ...lib,
      notes: lib.notes.map((n) => (n.id === 'n-own' ? { ...n, fields: n.fields.map((v, i) => (i === at ? 'Mein Satz.' : v)) } : n)),
    };
    const { state, result } = applyImport(typed, { plan }, ctxAt());
    expect(result).toMatchObject({ cardTypesUpdated: 0, notesUpdated: 0, notesAdded: 0 });
    expect(state).toBe(typed);
  });

  it('version 1 → the current version: the removed field is KEPT (last, on no side) for the notes it does not have, with their text', () => {
    const { lib, deckId, typeId } = v1Library();
    const plan = apkgPlan(lib, vocab('german_vocabulary'), { kind: 'existing', deckId }, 'w');
    const { state, result } = applyImport(lib, { plan }, ctxAt());
    expect(result).toMatchObject({ cardTypesUpdated: 1, notesUpdated: 18, notesAdded: 2 });
    expect(valid(state)).toEqual([]);
    const type = state.noteTypes.find((t) => t.id === typeId) as NoteType;
    expect(type.fields.map((f) => f.name)).toEqual([
      'Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'Level', 'Type', 'Plural', 'MarankiExample',
    ]);
    expect(type.templates.flatMap((t) => [...t.prompt, ...t.answer])).not.toContain(8);
    const fieldsOf = (word: string) => (state.notes.find((n) => n.fields[0] === word) as Note).fields;
    expect(fieldsOf('das Internet (Sg.)')[8]).toBe('Radufome rite téradare nevebäfu.');
    expect(fieldsOf('das Bad')[8]).toBe('');
    expect(fieldsOf('das Bad')[3]).toContain('Fafefo nakute fafefo guno tirapuna sañomifo remüto?');
  });

  it('an update may move the note to another section (a starter deck follows its file); same values and section → unchanged', () => {
    const { lib, deckId } = v1Library();
    const note = lib.notes.find((n) => n.section === 'B1') as Note;
    const plain = apkgPlan(lib, vocab('german_vocabulary_v1'), { kind: 'existing', deckId }, 'w');
    const moveTo = (section: string): ImportPlan => ({
      ...plain,
      notes: { ...plain.notes, update: [{ id: note.id, fields: [...note.fields], tags: [...note.tags], section }] },
    });
    const { state, result } = applyImport(lib, { plan: moveTo('A2') }, ctxAt());
    expect(result.notesUpdated).toBe(1);
    expect(state.notes.find((n) => n.id === note.id)).toMatchObject({ section: 'A2', fields: note.fields });
    expect(state.cards).toBe(lib.cards); // its cards stay where they are, with their progress
    const same = applyImport(lib, { plan: moveTo('B1') }, ctxAt());
    expect(same.state).toBe(lib);
    expect(same.result.notesUpdated).toBe(0);
  });

  it('retired notes: the tag and suspended cards, progress kept, not counted as updated; a second time changes nothing', () => {
    const { lib, deckId, typeId } = v1Library();
    const dropped = lib.notes.filter((n) => n.typeId === typeId && /\(Sg\.\)$/.test(n.fields[0]));
    const studiedCard = lib.cards.find((c) => c.noteId === dropped[0].id) as Card;
    const studied: DataStateV3 = {
      ...lib,
      cards: lib.cards.map((c) => (c.id === studiedCard.id ? { ...c, reps: 5, intervalDays: 12 } : c)),
    };
    // The plan of the same file again (nothing to update), with the dropped notes to retire.
    const plain = apkgPlan(studied, vocab('german_vocabulary_v1'), { kind: 'existing', deckId }, 'w');
    const retire = dropped.map((n) => n.id);
    const plan: ImportPlan = { ...plain, notes: { ...plain.notes, retire }, summary: { ...plain.summary, notesRetired: 2 } };

    const { state, result } = applyImport(studied, { plan }, ctxAt());
    expect(result).toMatchObject({ notesRetired: 2, notesUpdated: 0, cardsUpdated: 0, updatedDecks: [] });
    for (const n of dropped) {
      expect(state.notes.find((x) => x.id === n.id)?.tags).toEqual([...n.tags, RETIRED_TAG]);
      const cards = state.cards.filter((c) => c.noteId === n.id);
      expect(cards).toHaveLength(2);
      expect(cards.every((c) => c.suspended === true)).toBe(true);
    }
    expect(card(state, studiedCard.id)).toMatchObject({ reps: 5, intervalDays: 12, suspended: true });
    // Nothing else changed.
    const others = (s: DataStateV3) => s.cards.filter((c) => !retire.includes(c.noteId));
    expect(others(state)).toEqual(others(studied));
    expect(valid(state)).toEqual([]);

    // Twice: already tagged and suspended → no change at all.
    const twice = applyImport(state, { plan }, ctxAt());
    expect(twice.state).toBe(state);
    expect(twice.result.notesRetired).toBe(0);
    // A retired note deleted since is skipped.
    const gone = deleteNotes(studied, { noteIds: [retire[0]] }).state;
    expect(applyImport(gone, { plan }, ctxAt()).result.notesRetired).toBe(1);
  });
});

/* -------------------------------------------------------------------- lists */

describe('lists', () => {
  it('saveList: a new list; saving over it keeps its id and createdAt; the list key is stripped', () => {
    const s = stateWith([]);
    const made = saveList(s, { input: { name: '  B1 verbs ', icon: '📗', query: { list: 'x', tags: ['verb'] } } }, ctxAt());
    expect(made.result).toEqual({
      id: expect.stringMatching(/^list-/),
      name: 'B1 verbs',
      icon: '📗',
      query: { tags: ['verb'] },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    const id = (made.result as { id: string }).id;
    const renamed = saveList(made.state, { input: { id, name: 'Verbs', icon: '📗', query: { tags: ['verb'] } } }, ctxAt(FIXED_NOW + MIN));
    expect(renamed.state.lists).toHaveLength(1);
    expect(renamed.result).toMatchObject({ id, name: 'Verbs', createdAt: FIXED_NOW, updatedAt: FIXED_NOW + MIN });
  });

  it('saveList: an empty name or a built-in id → null and the same state', () => {
    const s = stateWith([]);
    expect(saveList(s, { input: { name: '   ', icon: '', query: {} } }, ctxAt())).toEqual({ state: s, result: null });
    expect(saveList(s, { input: { id: 'builtin:hard', name: 'Hard', icon: '', query: {} } }, ctxAt())).toEqual({
      state: s,
      result: null,
    });
  });

  it('deleteList removes a user list and its prefs; a built-in list cannot be deleted', () => {
    const made = saveList(stateWith([]), { input: { name: 'Mine', icon: '', query: {} } }, ctxAt());
    const id = (made.result as { id: string }).id;
    const pinned = setListPref(made.state, { id, pref: { pinned: true } }).state;
    const { state } = deleteList(pinned, { id });
    expect(state.lists).toEqual([]);
    expect(id in state.listPrefs).toBe(false);
    expect(deleteList(state, { id: 'builtin:hard' }).state).toBe(state);
  });

  it('setListPref: merges, starts unpinned at the end, ignores wrong kinds', () => {
    const s = stateWith([], { listPrefs: { 'builtin:hard': { pinned: true, hidden: false, order: 3 } } });
    const hidden = setListPref(s, { id: 'builtin:hard', pref: { hidden: true, order: Number.NaN } }).state;
    expect(hidden.listPrefs['builtin:hard']).toEqual({ pinned: true, hidden: true, order: 3 });
    const fresh = setListPref(hidden, { id: 'builtin:leeches', pref: { pinned: true } }).state;
    expect(fresh.listPrefs['builtin:leeches']).toEqual({ pinned: true, hidden: false, order: 4 });
    expect(setListPref(fresh, { id: 'builtin:leeches', pref: { pinned: true } }).state).toBe(fresh);
  });
});

/* ------------------------------------------------------- settings commands */

describe('setGoals never writes limits', () => {
  it('changes only the goals', () => {
    const s = stateWith([]);
    const { state } = setGoals(s, { goalReviews: 0, goalNew: 0 });
    expect(state.person).toMatchObject({ goalReviews: 0, goalNew: 0 });
    expect(state.settings).toBe(s.settings);
  });
});

describe('setLimits', () => {
  const s = stateWith([]);
  const limits = (patch: LimitsPatch) => {
    const { srs } = setLimits(s, { patch }).state.settings;
    return [srs.dailyNewLimit, srs.dailyReviewLimit];
  };

  it(`clamps the review limit to at least ${MIN_DAILY_REVIEW_LIMIT}`, () => {
    expect(limits({ dailyReviewLimit: 0 })).toEqual([10, 10]);
    expect(limits({ dailyReviewLimit: 5 })).toEqual([10, 10]);
    expect(limits({ dailyReviewLimit: 10 })).toEqual([10, 10]);
    expect(limits({ dailyReviewLimit: 99_999 })).toEqual([10, 99_999]); // "No limit"
  });

  it('the new-card limit can be 0, never negative; non-finite values keep the limit', () => {
    expect(limits({ dailyNewLimit: 0 })).toEqual([0, 200]);
    expect(limits({ dailyNewLimit: -3 })).toEqual([0, 200]);
    expect(limits({ dailyNewLimit: 25, dailyReviewLimit: 150 })).toEqual([25, 150]);
    expect(limits({ dailyNewLimit: NaN, dailyReviewLimit: Infinity })).toEqual([10, 200]);
  });

  it('a missing, undefined or non-finite value keeps the current limit', () => {
    expect(limits({})).toEqual([10, 200]);
    expect(limits({ dailyNewLimit: undefined, dailyReviewLimit: undefined })).toEqual([10, 200]);
    expect(limits({ dailyNewLimit: NaN, dailyReviewLimit: Infinity })).toEqual([10, 200]);
  });

  it('rounds each limit to a whole number (2.5 → 3), then clamps it', () => {
    expect(limits({ dailyNewLimit: 2.5 })).toEqual([3, 200]);
    expect(limits({ dailyNewLimit: 2.4, dailyReviewLimit: 40.6 })).toEqual([2, 41]);
    expect(limits({ dailyNewLimit: -0.4 })).toEqual([0, 200]);
    expect(limits({ dailyReviewLimit: 9.6 })).toEqual([10, 10]);
  });

  it('rounds, then clamps; the §8.6 ranges', () => {
    expect(limits({ dailyNewLimit: 2.5 })).toEqual([3, 200]);
    expect(limits({ dailyNewLimit: 5000 })).toEqual([999, 200]);
    expect(DAILY_LIMIT_RANGES).toEqual({
      dailyNewLimit: { min: 0, max: 999 },
      dailyReviewLimit: { min: MIN_DAILY_REVIEW_LIMIT, max: 99_999 },
    });
    expect(clampDailyLimits({ dailyNewLimit: 2.5, dailyReviewLimit: 0 })).toEqual({ dailyNewLimit: 3, dailyReviewLimit: 10 });
    expect(clampDailyLimits({ dailyReviewLimit: 10_000 })).toEqual({ dailyReviewLimit: 99_999 });
  });

  it('caps at the top of the §8.6 range: new cards 999, reviews 99,999', () => {
    expect(limits({ dailyNewLimit: 999 })).toEqual([999, 200]);
    expect(limits({ dailyReviewLimit: 100_000 })).toEqual([10, 99_999]);
  });

  it('clampDailyLimits leaves out what it cannot use, and keeps whole values in range as they are', () => {
    expect(clampDailyLimits({ dailyNewLimit: NaN, dailyReviewLimit: 300 })).toEqual({ dailyReviewLimit: 300 });
    expect(clampDailyLimits({})).toEqual({});
    // Spec §8.6: real review limits are 10–9,999; anything above is "No limit" (99,999).
    expect(clampDailyLimits({ dailyReviewLimit: 9_999 })).toEqual({ dailyReviewLimit: 9_999 });
    expect(clampDailyLimits({ dailyReviewLimit: 50_000 })).toEqual({ dailyReviewLimit: 99_999 });
  });

  it('launch count === queue length after a fractional new-card limit (§3.12, the one scheduler)', () => {
    const fresh = Array.from({ length: 10 }, (_, i) => item(`n${i}`, 'new', { createdAt: FIXED_NOW - DAY + i }));
    const { state } = setLimits(stateWith(fresh), { patch: { dailyNewLimit: 2.5 } });
    const byNote = new Map<Id, Id[]>();
    for (const c of state.cards) byNote.set(c.noteId, [...(byNote.get(c.noteId) ?? []), c.id]);
    const ctx: ScheduleCtx = {
      now: FIXED_NOW,
      decks: new Map(state.decks.map((d) => [d.id, d])),
      typeIdOf: (c) => state.notes.find((n) => n.id === c.noteId)?.typeId,
      done: normalizedDayDone(state.person, FIXED_NOW),
      settings: state.settings,
      lookup: { cardById: new Map(state.cards.map((c) => [c.id, c])), cardIdsByNote: byNote },
    };
    const pool = state.cards.filter((c) => studyEligible(c, ctx, new Set()));
    const sel = selectScheduled(pool, ctx);
    expect(readyCounts(sel).total).toBe(3);
    expect(planQueue(sel)).toHaveLength(3);
  });

  it('never writes goals or other SRS settings', () => {
    const { state } = setLimits(s, { patch: { dailyNewLimit: 3, dailyReviewLimit: 40 } });
    expect(state.person).toBe(s.person);
    expect({ ...state.settings.srs, dailyNewLimit: 10, dailyReviewLimit: 200 }).toEqual(s.settings.srs);
  });
});

describe('other settings commands', () => {
  it('updateSrsSettings and updateAppSettings merge their patch', () => {
    const s = stateWith([]);
    const srs = updateSrsSettings(s, { patch: { learningStepsMin: [1, 10, 60], easyBonus: 1.5 } }).state.settings;
    expect(srs.srs).toEqual({ ...s.settings.srs, learningStepsMin: [1, 10, 60], easyBonus: 1.5 });
    const app = updateAppSettings(s, { patch: { sessionLimit: 20, spaceSiblings: false } }).state.settings;
    expect(app).toEqual({ ...s.settings, sessionLimit: 20, spaceSiblings: false });
  });

  it('resetPreferences: settings → defaults; the two records and every piece of data stay', () => {
    const s = updateAppSettings(stateWith([item('a')]), {
      patch: { sessionLimit: 5, hapticsEnabled: false, knownChecksPerDay: 0, lastAutoBackupAt: FIXED_NOW - DAY, reminderOfferSeen: true },
    }).state;
    const { state } = resetPreferences(s, undefined, ctxAt());
    expect(state.settings).toEqual({ ...buildSeedState(FIXED_NOW).settings, lastAutoBackupAt: FIXED_NOW - DAY, reminderOfferSeen: true });
    expect(state.cards).toBe(s.cards);
    expect(state.person).toBe(s.person);
  });

  it('markOnboarded', () => {
    expect(markOnboarded(stateWith([], { onboarded: false })).state.onboarded).toBe(true);
  });
});

/* ----------------------------------------------------------- data commands */

describe('restoreState and factoryReset', () => {
  it('restoreState replaces everything — nothing of the old state survives', () => {
    const old = stateWith([item('mine')], { inProgressSession: marker(), onboarded: true });
    const backup = randomStateV3(createRandom('backup'));
    const { state } = restoreState(old, { next: backup });
    expect(state).toBe(backup);
    expect(state.cards.some((c) => c.id === 'mine')).toBe(false);
  });

  it('restoreState does not merge: a key missing in the backup stays missing', () => {
    const old = stateWith([], { inProgressSession: marker() });
    const backup = { ...stateWith([]) } as Partial<DataStateV3>;
    delete backup.inProgressSession;
    const { state } = restoreState(old, { next: backup as DataStateV3 });
    expect('inProgressSession' in state).toBe(false);
  });

  it('factoryReset returns the first-run state (schema 3, an empty library)', () => {
    const later = FIXED_NOW + 5 * DAY;
    const { state } = factoryReset(randomStateV3(createRandom('reset')), undefined, ctxAt(later));
    expect(state).toEqual(buildSeedState(later));
    expect(state).toMatchObject({ schemaVersion: 3, minReaderVersion: 3, cards: [], notes: [], decks: [], reviewLog: [], manualLog: [] });
  });
});

/* --------------------------------------------------------------- helpers */

describe('helpers', () => {
  it('normalizedDayDone: the same day → the same object; a new day → an empty v3 tally; an old shape is completed', () => {
    const dayDone = day({ reviews: 4, neww: 1 });
    expect(normalizedDayDone({ dayDone }, FIXED_NOW)).toBe(dayDone);
    expect(normalizedDayDone({ dayDone }, FIXED_NOW + DAY)).toEqual(day({ dayKey: addDays(TODAY, 1) }));
    expect(normalizedDayDone({ dayDone: { dayKey: TODAY, reviews: 2, neww: 1 } }, FIXED_NOW)).toEqual(day({ reviews: 2, neww: 1 }));
  });

  // rateCard and undoLastReview count with tally.ts (the ONE M3 rule, spec §3.12).
  it('tallyReview / untallyReview: one budget each; a deck id like "constructor" is a plain key', () => {
    const d = tallyReview(day(), { bucket: 'new', deckId: 'constructor' });
    expect(d).toEqual(day({ neww: 1, newByDeck: { constructor: 1 } }));
    expect(tallyReview(d, { bucket: 'check', deckId: 'x' })).toEqual({ ...d, checks: 1 });
    expect(untallyReview(d, { bucket: 'new', deckId: 'constructor' })).toEqual(day());
    expect(untallyReview(day(), { bucket: 'review', deckId: DECK })).toEqual(day());
    expect(untallyReview(day(), { bucket: 'check', deckId: DECK })).toEqual(day());
  });

  it("createNewId: {prefix}-{base-36 time}-{counter}, unique", () => {
    const make = createNewId(() => FIXED_NOW);
    const t = FIXED_NOW.toString(36);
    expect(make('c')).toBe(`c-${t}-1`);
    expect(make('rl')).toBe(`rl-${t}-2`);
    expect(new Set(Array.from({ length: 1000 }, () => make('c'))).size).toBe(1000);
  });

  it('buildSeedState (the state of factoryReset and resetPreferences): schema 3, an empty library, the v3 settings and tally', () => {
    const seed = buildSeedState(FIXED_NOW);
    expect(seed).toMatchObject({ schemaVersion: 3, cards: [], notes: [], lists: [], pack: null, inProgressSession: null });
    expect(seed.person.dayDone).toEqual(day());
    expect(seed.settings).toMatchObject({ spaceSiblings: true, knownChecksPerDay: 5, autoBackup: true });
  });
});

/* ------------------------------------------------------------------ purity */

describe('purity', () => {
  /** Two decks, cards in every state, a log entry, a list, a marker — as a read-only view. */
  function readOnlyState(): DataStateV3 {
    const base = stateOfV3({
      decks: [makeDeckV3({ id: 'd1', name: 'One', order: 0 }), makeDeckV3({ id: 'd2', name: 'Two', order: 1 })],
      groups: [
        item('a', 'review', { due: FIXED_NOW - HOUR }, { deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basicReverse }),
        item('b', 'new', {}, { deckId: 'd1' }),
        item('c', 'learning', {}, { deckId: 'd2' }),
        item('k', 'known', {}, { deckId: 'd2' }),
      ],
      overrides: {
        person: makePersonV3({ lastStudyDay: YESTERDAY, streak: 3, dayDone: day({ reviews: 1 }) }),
        inProgressSession: marker(),
        listPrefs: { 'builtin:hard': { pinned: true, hidden: false, order: 0 } },
      },
    });
    const rated = rateCard(base, { cardId: 'a', rating: 'good' }, ctxAt()).state;
    return deepReadOnly(markKnown(rated, { cardIds: ['b'] }, ctxAt()).state);
  }

  it('no command changes its input state (an in-place write on the read-only view would throw)', () => {
    const s = readOnlyState();
    const snapshot = JSON.stringify(s);
    const ctx = ctxAt();
    const editId = s.manualLog[0].id;
    const plan = csvPlan(s, 'p,q', { kind: 'new', name: 'Imp', icon: '' }, 'p');
    const runs: (() => unknown)[] = [
      () => rateCard(s, { cardId: 'a', rating: 'good' }, ctx),
      () => rateCard(s, { cardId: 'k', rating: 'again' }, ctx),
      () => rateCard(s, { cardId: 'b', rating: 'again', kind: 'practice' }, ctxAt(FIXED_NOW + DAY)),
      () => undoLastReview(s, undefined, ctx),
      () => completeSession(s, args({ finalCard: rateCard(s, { cardId: 'a', rating: 'easy' }, ctx).result ?? undefined }), ctx),
      () => applyPayout(s, computePayout(s, args(), ctx)),
      () => reconcileOnBoot(s, undefined, ctx),
      () => trackSession(s, { snapshot: null }),
      () => bury(s, { cardIds: ['c'] }, ctx),
      () => setFlags(s, { cardIds: ['a', 'b'], patch: { fav: true } }, ctx),
      () => learn(s, { cardIds: ['b'], first: true }, ctx),
      () => markKnown(s, { cardIds: ['c'] }, ctx),
      () => setNotStarted(s, { cardIds: ['b', 'c'] }, ctx),
      () => resetProgress(s, { cardIds: ['a'] }, ctx),
      () => reschedule(s, { cardIds: ['a'], dueMs: FIXED_NOW + DAY }, ctx),
      () => undoManualEdit(s, { editId }, ctx),
      () => addNote(s, { deckId: 'd1', typeId: BUILTIN_TYPE_IDS.cloze, fields: ['{{c1::x}} {{c2::y}}', ''], tags: ['t'] }, ctx),
      () => editNote(s, { noteId: 'n-a', patch: { fields: ['x', 'y'], tags: ['z'] } }, ctx),
      () => moveNotes(s, { noteIds: ['n-a'], deckId: 'd2', section: 'S' }, ctx),
      () => tagNotes(s, { noteIds: ['n-a', 'n-b'], add: ['t'], remove: [] }, ctx),
      () => deleteNotes(s, { noteIds: ['n-a'] }),
      () => undoDelete(s, { deleted: deleteNotes(s, { noteIds: ['n-a'] }).result }),
      () => addDeck(s, { input: { name: 'New' } }, ctx),
      () => updateDeck(s, { deckId: 'd1', patch: { active: false, desc: undefined } }, ctx),
      () => setDeckOptions(s, { deckId: 'd1', patch: { newPerDay: 3, directions: { t: [0] } } }),
      () => setDirections(s, { deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basicReverse, ords: [0] }, ctx),
      () => updateNoteType(s, { typeId: BUILTIN_TYPE_IDS.basic, patch: { name: 'B' } }, ctx),
      () => deleteDeck(s, { deckId: 'd1', strategy: { kind: 'keep' } }, ctx),
      () => deleteDeck(s, { deckId: 'd1', strategy: { kind: 'move', targetDeckId: 'd2' } }, ctx),
      () => deleteDeck(s, { deckId: 'd1', strategy: { kind: 'delete' } }, ctx),
      () => duplicateDeck(s, { deckId: 'd1' }, ctx),
      () => reorderDecks(s, { deckIds: ['d2'] }),
      () => applyImport(s, { plan }, ctx),
      () => saveList(s, { input: { name: 'L', icon: '', query: { flags: ['fav'] } } }, ctx),
      () => deleteList(s, { id: 'x' }),
      () => setListPref(s, { id: 'builtin:hard', pref: { hidden: true } }),
      () => setGoals(s, { goalReviews: 5, goalNew: 5 }),
      () => setLimits(s, { patch: { dailyNewLimit: 1, dailyReviewLimit: 1 } }),
      () => updateSrsSettings(s, { patch: { easyBonus: 2 } }),
      () => updateAppSettings(s, { patch: { sessionLimit: 10 } }),
      () => resetPreferences(s, undefined, ctx),
      () => markOnboarded(s),
      () => restoreState(s, { next: stateWith([]) }),
      () => factoryReset(s, undefined, ctx),
    ];
    for (const run of runs) expect(run).not.toThrow();
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('keeps unchanged parts by identity (a later save compares by identity)', () => {
    const s = readOnlyState();
    const rated = rateCard(s, { cardId: 'c', rating: 'good' }, ctxAt()).state;
    expect(card(rated, 'b')).toBe(card(s, 'b'));
    expect(rated.decks).toBe(s.decks);
    expect(rated.notes).toBe(s.notes);
    expect(rated.settings).toBe(s.settings);
    expect(rated.sessions).toBe(s.sessions);
    expect(rated.manualLog).toBe(s.manualLog);
  });

  /** One random command with valid input, for the property test below. */
  function randomCommand(rnd: Random, s: DataStateV3, ctx: ReducerCtx): { name: string; state: DataStateV3 } {
    const someCard = () => rnd.pick(s.cards).id;
    const someNote = () => rnd.pick(s.notes).id;
    const someDeck = () => rnd.pick(s.decks).id;
    const counts = { again: rnd.int(0, 3), hard: rnd.int(0, 3), good: rnd.int(0, 5), easy: rnd.int(0, 2) };
    const total = counts.again + counts.hard + counts.good + counts.easy;
    const m = marker({ counts, total, bestRun: rnd.int(0, total), studyDay: dayKeyOf(ctx.now) });
    const ids = () => (s.cards.length ? rnd.sample(s.cards, rnd.int(1, Math.min(4, s.cards.length))).map((c) => c.id) : []);
    const options: [string, () => DataStateV3 | null][] = [
      ['rate', () => (s.cards.length ? rateCard(s, { cardId: someCard(), rating: rnd.pick<Rating>(RATINGS) }, ctx).state : null)],
      ['practice', () => (s.cards.length ? rateCard(s, { cardId: someCard(), rating: 'good', kind: 'practice' }, ctx).state : null)],
      ['undo', () => undoLastReview(s, undefined, ctx).state],
      ['track', () => trackSession(s, { snapshot: rnd.bool() ? m : null }).state],
      ['complete', () => completeSession(s, { ...m, kind: rnd.pick<SessionKind>(['scheduled', 'ahead', 'practice', 'deck']) }, ctx).state],
      ['reconcile', () => reconcileOnBoot(s, undefined, ctx).state],
      ['flags', () => setFlags(s, { cardIds: ids(), patch: { fav: rnd.bool(), suspended: rnd.bool(0.2) } }, ctx).state],
      ['bury', () => bury(s, { cardIds: ids() }, ctx).state],
      ['learn', () => learn(s, { cardIds: ids(), first: rnd.bool() }, ctx).state],
      ['known', () => markKnown(s, { cardIds: ids() }, ctx).state],
      ['notStarted', () => setNotStarted(s, { cardIds: ids() }, ctx).state],
      ['reset', () => resetProgress(s, { cardIds: ids() }, ctx).state],
      ['reschedule', () => reschedule(s, { cardIds: ids(), dueMs: ctx.now + rnd.int(1, 30) * DAY }, ctx).state],
      ['undoEdit', () => (s.manualLog.length ? undoManualEdit(s, { editId: rnd.pick(s.manualLog).id }, ctx).state : null)],
      ['addNote', () => (s.decks.length ? addNote(s, { deckId: someDeck(), typeId: rnd.pick([BUILTIN_TYPE_IDS.basic, BUILTIN_TYPE_IDS.basicReverse]), fields: [rnd.id('f'), 'b'], tags: [] }, ctx).state : null)],
      ['editNote', () => (s.notes.length ? editNote(s, { noteId: someNote(), patch: { tags: [rnd.id('t')] } }, ctx).state : null)],
      ['move', () => (s.notes.length ? moveNotes(s, { noteIds: [someNote()], deckId: someDeck() }, ctx).state : null)],
      ['delete', () => (s.notes.length && rnd.bool(0.3) ? deleteNotes(s, { noteIds: [someNote()] }).state : null)],
      ['addDeck', () => addDeck(s, { input: { name: rnd.id('deck') } }, ctx).state],
      ['updateDeck', () => updateDeck(s, { deckId: someDeck(), patch: { active: rnd.bool() } }, ctx).state],
      [
        'deleteDeck',
        () => {
          if (s.decks.length < 2) return null;
          const strategy = rnd.pick<DeleteStrategy>([
            { kind: 'delete' },
            { kind: 'keep' },
            { kind: 'move', targetDeckId: someDeck() },
            { kind: 'move', targetDeckId: 'missing' },
          ]);
          return deleteDeck(s, { deckId: someDeck(), strategy }, ctx).state;
        },
      ],
      ['duplicateDeck', () => duplicateDeck(s, { deckId: someDeck() }, ctx).state],
      ['options', () => setDeckOptions(s, { deckId: someDeck(), patch: { newPerDay: rnd.bool() ? null : rnd.int(0, 20) } }).state],
      ['import', () => applyImport(s, { plan: csvPlan(s, `${rnd.id('w')},x\n${rnd.id('w')},y`, { kind: 'new', name: 'Imp', icon: '' }, rnd.id('p')) }, ctx).state],
      ['goals', () => setGoals(s, { goalReviews: rnd.int(0, 100), goalNew: rnd.int(0, 30) }).state],
      ['limits', () => setLimits(s, { patch: { dailyNewLimit: rnd.int(-5, 50), dailyReviewLimit: rnd.int(-5, 500) } }).state],
    ];
    const [name, run] = rnd.pick(options);
    return { name, state: run() ?? s };
  }

  it('property (40 seeded states × 25 random commands): every state stays valid — no orphan, no split note, no NaN', () => {
    for (let seed = 0; seed < 40; seed++) {
      const rnd = createRandom(`commands-${seed}`);
      let s: DataStateV3 = randomStateV3(rnd.fork('state'));
      let now = FIXED_NOW;
      for (let step = 0; step < 25; step++) {
        now += rnd.int(0, 90) * MIN; // sometimes crosses midnight
        const { name, state } = randomCommand(rnd, s, ctxAt(now));
        s = state;
        expect({ seed, step, name, problems: valid(s) }).toEqual({ seed, step, name, problems: [] });
      }
    }
  });
});

/* ------------------------------------------------------- one call shape */

describe('one call shape: command(state, input, ctx)', () => {
  /**
   * The engine can run every command like this generic `run`: the input in
   * the second place, ctx ALWAYS in the third.
   */
  const run = <I, R>(command: Command<I, R>, s: DataStateV3, input: I, ctx: ReducerCtx): Step<R> => command(s, input, ctx);

  it('ctx in the input place is not a Command (compile-time check)', () => {
    const oldShape = (s: DataStateV3, ctx: ReducerCtx) => undoLastReview(s, undefined, ctx);
    // @ts-expect-error — `void` (no input) is not a ReducerCtx: ctx must be the THIRD parameter.
    const wrong: Command<void, boolean> = oldShape;
    expect(typeof wrong).toBe('function');
  });

  it('every command runs through the one generic call, and the list is complete', () => {
    const base = stateWith([item('a', 'review', { due: FIXED_NOW - HOUR }), item('b')], { inProgressSession: marker() });
    const s = markKnown(rateCard(base, { cardId: 'a', rating: 'good' }, ctxAt()).state, { cardIds: ['b'] }, ctxAt()).state;
    const ctx = ctxAt();
    const deleted = deleteNotes(s, { noteIds: ['n-b'] });
    const steps: Record<string, Step<unknown>> = {
      rateCard: run(rateCard, s, { cardId: 'a', rating: 'good' }, ctx),
      undoLastReview: run(undoLastReview, s, undefined, ctx),
      completeSession: run(completeSession, s, args(), ctx),
      trackSession: run(trackSession, s, { snapshot: null }, ctx),
      reconcileOnBoot: run(reconcileOnBoot, s, undefined, ctx),
      bury: run(bury, s, { cardIds: ['a'] }, ctx),
      setFlags: run(setFlags, s, { cardIds: ['a'], patch: { fav: true } }, ctx),
      learn: run(learn, s, { cardIds: ['b'] }, ctx),
      markKnown: run(markKnown, s, { cardIds: ['a'] }, ctx),
      setNotStarted: run(setNotStarted, s, { cardIds: ['b'] }, ctx),
      resetProgress: run(resetProgress, s, { cardIds: ['a'] }, ctx),
      reschedule: run(reschedule, s, { cardIds: ['a'], dueMs: FIXED_NOW + DAY }, ctx),
      undoManualEdit: run(undoManualEdit, s, { editId: s.manualLog[0].id }, ctx),
      addNote: run(addNote, s, { deckId: DECK, typeId: BUILTIN_TYPE_IDS.basic, fields: ['x', 'y'], tags: [] }, ctx),
      editNote: run(editNote, s, { noteId: 'n-a', patch: { tags: ['t'] } }, ctx),
      moveNotes: run(moveNotes, s, { noteIds: ['n-a'], deckId: DECK, section: 'S' }, ctx),
      tagNotes: run(tagNotes, s, { noteIds: ['n-a'], add: ['t'], remove: [] }, ctx),
      deleteNotes: run(deleteNotes, s, { noteIds: ['n-b'] }, ctx),
      undoDelete: run(undoDelete, deleted.state, { deleted: deleted.result }, ctx),
      addDeck: run(addDeck, s, { input: { name: 'New' } }, ctx),
      updateDeck: run(updateDeck, s, { deckId: DECK, patch: { name: 'Renamed' } }, ctx),
      setDeckOptions: run(setDeckOptions, s, { deckId: DECK, patch: { newPerDay: 5 } }, ctx),
      setDirections: run(setDirections, s, { deckId: DECK, typeId: BUILTIN_TYPE_IDS.basic, ords: [0] }, ctx),
      updateNoteType: run(updateNoteType, s, { typeId: BUILTIN_TYPE_IDS.basic, patch: { name: 'B' } }, ctx),
      deleteDeck: run(deleteDeck, s, { deckId: DECK, strategy: { kind: 'keep' } }, ctx),
      duplicateDeck: run(duplicateDeck, s, { deckId: DECK }, ctx),
      reorderDecks: run(reorderDecks, s, { deckIds: [DECK] }, ctx),
      applyImport: run(applyImport, s, { plan: csvPlan(s, 'p,q', { kind: 'new', name: 'Imp', icon: '' }, 'shape') }, ctx),
      saveList: run(saveList, s, { input: { name: 'L', icon: '', query: {} } }, ctx),
      deleteList: run(deleteList, s, { id: 'nope' }, ctx),
      setListPref: run(setListPref, s, { id: 'builtin:hard', pref: { pinned: true } }, ctx),
      setGoals: run(setGoals, s, { goalReviews: 5, goalNew: 5 }, ctx),
      setLimits: run(setLimits, s, { patch: { dailyNewLimit: 2.5 } }, ctx),
      updateSrsSettings: run(updateSrsSettings, s, { patch: { easyBonus: 2 } }, ctx),
      updateAppSettings: run(updateAppSettings, s, { patch: { sessionLimit: 10 } }, ctx),
      resetPreferences: run(resetPreferences, s, undefined, ctx),
      markOnboarded: run(markOnboarded, s, undefined, ctx),
      restoreState: run(restoreState, s, { next: stateWith([]) }, ctx),
      factoryReset: run(factoryReset, s, undefined, ctx),
    };

    // Complete: every exported function of reducer.ts is in `steps` above, or
    // is one of these helpers (they are not commands: no {state, result}).
    const helpers = [
      'applyPayout',
      'clampDailyLimits',
      'computePayout',
      'createNewId',
      'normalizedDayDone',
      'reviewBucket',
      'scheduleOf',
      'startOfNextDay',
      'writesSchedule',
    ];
    const exportedFunctions = Object.entries(reducer)
      .filter(([, value]) => typeof value === 'function')
      .map(([key]) => key);
    expect(exportedFunctions.filter((key) => !helpers.includes(key)).sort()).toEqual(Object.keys(steps).sort());

    // Every command gives a valid v3 state.
    for (const [name, step] of Object.entries(steps)) {
      expect({ name, problems: valid(step.state) }).toEqual({ name, problems: [] });
    }
    expect(steps.undoLastReview.result).toBe(true);
    expect(steps.reconcileOnBoot.result).toEqual({ banked: true });
    expect(steps.factoryReset.state).toEqual(buildSeedState(FIXED_NOW));
  });
});

describe('the Deck type of the result stays a v3 deck', () => {
  it('addDeck gives a deck the scheduler can use (order, options)', () => {
    const { result } = addDeck(stateWith([]), { input: { name: 'x' } }, ctxAt());
    const deck: Deck = result;
    expect(Number.isFinite(deck.order)).toBe(true);
    expect(deck.options.newArrival).toBe('queued');
  });
});
