/**
 * The one scheduler (spec §4.5, unit W2-6).
 *
 * The most important promise of the app is "the number on a Study button is
 * exactly the session it opens". These tests pin it in two ways:
 *   1. Example tests, one per rule: each bucket, each cap, each sibling rule,
 *      eligibility (paused, direction, suspended, buried), study ahead,
 *      practice, minutesFor.
 *   2. A seeded property test over 300 random states × 3 scope kinds. A
 *      failing case prints its seed; run it again with the same seed to see
 *      it. It checks: no duplicate card, no ineligible card, every cap,
 *      `readyCounts(sel).total === planQueue(sel).length`, and that the
 *      buckets are as FULL as the caps allow (a brute-force count).
 *
 * Cards are built with the shared v3 constructors (makeV3.ts), so they look
 * exactly like the cards the app will make.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW, localTime } from '../test/clock';
import { createRandom, type Random } from '../test/random';
import { fnv1a } from './hash';
import { isBuried, isDueNow, life } from './life';
import { makeCard, makeDeck, makeNote, type MakeDeckInput } from './makeV3';
import type { Card, DayDone, Deck, Id, Note, ScheduleCtx, Selection, SortSpec, SrsSettings } from './model';
import {
  checkReadyAt,
  compareSortKeys,
  isCheckSampled,
  minutesFor,
  NO_SORT_KEY,
  ORDER_STEPS_PER_STOP,
  orderCards,
  orderPositions,
  planQueue,
  readyCounts,
  repairPositions,
  selectAhead,
  selectPractice,
  selectScheduled,
  selectScheduledWithDue,
  sortCards,
  sortFieldsOf,
  sortIsStrict,
  type SourceOrderStep,
  sourceOrderJob,
  spreadDays,
  startOfLocalDay,
  studyEligible,
} from './schedule';
import { addDays, DAY, dayKeyOf, DEFAULT_SRS, HOUR, MIN, NO_REVIEW_LIMIT } from './types';

const NOW = FIXED_NOW; // Wednesday 10 June 2026, 09:00 local time
const TODAY = dayKeyOf(NOW);
const NONE = new Set<Id>(); // no deck named by the scope

/* ------------------------------------------------------------------ card states */

type State = Partial<Omit<Card, 'id' | 'noteId' | 'deckId' | 'ord'>>;

const NEW: State = {};
const NOT_STARTED: State = { newState: 'notStarted' };
/** In learning since yesterday, due again now. */
const LEARNING_DUE: State = { reps: 1, stepIndex: 0, intervalDays: 0, due: NOW - MIN, lastReviewedAt: NOW - DAY };
/** In learning, due again in 10 minutes. */
const LEARNING_LATER: State = { ...LEARNING_DUE, due: NOW + 10 * MIN };
const REVIEW_DUE: State = { reps: 4, stepIndex: null, intervalDays: 6, due: NOW - HOUR, lastReviewedAt: NOW - 6 * DAY };
const REVIEW_LATER: State = { ...REVIEW_DUE, due: NOW + 2 * DAY };
const MASTERED_DUE: State = { reps: 9, stepIndex: null, intervalDays: 30, due: NOW - 2 * DAY, lastReviewedAt: NOW - 32 * DAY };
/** A review card that was studied an hour ago (today). */
const STUDIED_TODAY: State = { reps: 5, stepIndex: null, intervalDays: 8, due: NOW + 8 * DAY, lastReviewedAt: NOW - HOUR };
/** Known 100 days ago: every Check spread (21–90 days) has passed. */
const KNOWN_LONG_AGO: State = { knownAt: NOW - 100 * DAY };

/** Card ids whose hash puts them IN (sampled = true) or OUT of the 10% Check sample. */
function idsWithSample(prefix: string, count: number, sampled: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i++) {
    const id = `${prefix}-${i}`;
    if (isCheckSampled(id) === sampled) out.push(id);
  }
  return out;
}

/* ------------------------------------------------------------------ a small world builder */

class World {
  decks: Deck[] = [];
  notes: Note[] = [];
  cards: Card[] = [];
  private seq = 0;

  deck(id: Id, input: Partial<Omit<MakeDeckInput, 'id'>> = {}): Deck {
    const deck = makeDeck({ name: id, order: this.decks.length, ...input, id }, NOW - 60 * DAY);
    this.decks.push(deck);
    return deck;
  }

  /**
   * One note in `deckId` with one card per state (ord 0, 1, …). One state →
   * a Basic note; two states → a Basic + reverse note (two directions).
   */
  note(
    deckId: Id,
    states: State[],
    opts: { id?: Id; order?: number; cardIds?: Id[]; typeId?: Id } = {},
  ): Card[] {
    this.seq += 1;
    const id = opts.id ?? `n${this.seq}`;
    const typeId = opts.typeId ?? (states.length > 1 ? 'nt-basic-reverse' : 'nt-basic');
    const note = makeNote(
      { id, typeId, fields: ['front', 'back', '', ''], order: opts.order ?? this.seq },
      NOW - 60 * DAY,
    );
    this.notes.push(note);
    const made = states.map((state, ord) =>
      makeCard(note, ord, deckId, DEFAULT_SRS, NOW - 60 * DAY, {
        ...state,
        id: opts.cardIds?.[ord] ?? `${id}-c${ord}`,
      }),
    );
    this.cards.push(...made);
    return made;
  }

  /** A note per state (each a one-card Basic note). */
  many(deckId: Id, count: number, state: State, prefix = deckId): Card[] {
    const out: Card[] = [];
    for (let i = 0; i < count; i++) out.push(...this.note(deckId, [state], { id: `${prefix}-n${i}` }));
    return out;
  }
}

interface CtxOptions {
  now?: number;
  srs?: Partial<SrsSettings>;
  sessionLimit?: number;
  knownChecksPerDay?: number;
  spaceSiblings?: boolean;
  done?: Partial<DayDone>;
  sortKey?: ScheduleCtx['sortKey'];
  scope?: ScheduleCtx['scope'];
}

/** The data of a world without its builder methods (for example a world after a card was rated). */
type Library = Pick<World, 'decks' | 'notes' | 'cards'>;

/** The ScheduleCtx for a world. Defaults: no session cap, 10 new / 200 reviews, 5 checks, siblings spaced. */
function ctxOf(world: Library, o: CtxOptions = {}): ScheduleCtx {
  const now = o.now ?? NOW;
  const typeById = new Map(world.notes.map((n) => [n.id, n.typeId]));
  const cardById = new Map(world.cards.map((c) => [c.id, c]));
  const cardIdsByNote = new Map<Id, Id[]>();
  for (const c of world.cards) {
    const ids = cardIdsByNote.get(c.noteId);
    if (ids) ids.push(c.id);
    else cardIdsByNote.set(c.noteId, [c.id]);
  }
  return {
    now,
    decks: new Map(world.decks.map((d) => [d.id, d])),
    typeIdOf: (card) => typeById.get(card.noteId),
    done: { dayKey: dayKeyOf(now), reviews: 0, neww: 0, checks: 0, newByDeck: {}, ...o.done },
    settings: {
      srs: { ...DEFAULT_SRS, ...o.srs },
      sessionLimit: o.sessionLimit ?? 0,
      knownChecksPerDay: o.knownChecksPerDay ?? 5,
      spaceSiblings: o.spaceSiblings ?? true,
    },
    lookup: { cardById, cardIdsByNote },
    ...(o.sortKey ? { sortKey: o.sortKey } : {}),
    ...(o.scope ? { scope: o.scope } : {}),
  };
}

/** The Study pool of a world: every card that is studyEligible (scope "All"). */
function studyPool(world: Library, ctx: ScheduleCtx, explicit: ReadonlySet<Id> = NONE): Card[] {
  return world.cards.filter((c) => studyEligible(c, ctx, explicit));
}

function ids(cards: readonly Card[]): Id[] {
  return cards.map((c) => c.id);
}

function run(world: Library, o: CtxOptions = {}): Selection {
  const ctx = ctxOf(world, o);
  return selectScheduled(studyPool(world, ctx), ctx);
}

/**
 * The world after the learner rated `card` "Good" at the moment `at`: the
 * card is a review again, due in `days` days, and was studied at `at`.
 * (The real rating is done by the SRS code; the scheduler only reads these fields.)
 */
function afterRating(world: Library, card: Card, at: number, days: number): Library {
  const rated: Card = {
    ...card,
    reps: card.reps + 1,
    stepIndex: null,
    intervalDays: days,
    due: at + days * DAY,
    lastReviewedAt: at,
  };
  return { ...world, cards: world.cards.map((c) => (c.id === card.id ? rated : c)) };
}

/**
 * The scheduler's settings as damaged saved data can have them: JSON turns
 * NaN and Infinity into null, and an old file may miss a key. The type says
 * "number", so the test must force it.
 */
function brokenSettings(ctx: ScheduleCtx, patch: Record<string, unknown>): ScheduleCtx {
  const { srs: srsPatch, ...rest } = patch;
  return {
    ...ctx,
    settings: {
      ...ctx.settings,
      ...(rest as Partial<ScheduleCtx['settings']>),
      srs: { ...ctx.settings.srs, ...(srsPatch as Partial<SrsSettings>) },
    },
  };
}

/* ================================================================== minutesFor */

describe('minutesFor — the one time formula', () => {
  it('is max(1, round(cards × 23 / 60)), and 0 cards → 0 min', () => {
    expect(minutesFor(0)).toBe(0);
    expect(minutesFor(1)).toBe(1); // 23 s → at least 1 min
    expect(minutesFor(3)).toBe(1); // 69 s → 1.15 → 1
    expect(minutesFor(4)).toBe(2); // 92 s → 1.53 → 2
    expect(minutesFor(30)).toBe(12); // 690 s → 11.5 → 12
    expect(minutesFor(100)).toBe(38); // 2300 s → 38.3 → 38
  });

  it('a negative or broken count means 0 min', () => {
    expect(minutesFor(-3)).toBe(0);
    expect(minutesFor(Number.NaN)).toBe(0);
  });

  it('readyCounts uses it for `mins`', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 30, REVIEW_DUE);
    const rc = readyCounts(run(w));
    expect(rc.total).toBe(30);
    expect(rc.mins).toBe(minutesFor(30));
  });
});

describe('startOfLocalDay', () => {
  it('is local midnight of the same day', () => {
    expect(startOfLocalDay(NOW)).toBe(localTime('2026-06-10', '00:00'));
    expect(startOfLocalDay(localTime('2026-06-10', '23:59'))).toBe(localTime('2026-06-10', '00:00'));
    expect(startOfLocalDay(localTime('2026-06-11', '00:00'))).toBe(localTime('2026-06-11', '00:00'));
  });
});

/* ================================================================== eligibility */

describe('studyEligible — who may be studied', () => {
  it('a card of an active deck is eligible', () => {
    const w = new World();
    w.deck('d1');
    const [c] = w.note('d1', [NEW]);
    expect(studyEligible(c, ctxOf(w), NONE)).toBe(true);
  });

  it('a paused deck is excluded, unless the scope names it (deck page, deck query)', () => {
    const w = new World();
    w.deck('d1', { active: false });
    const [c] = w.note('d1', [REVIEW_DUE]);
    const ctx = ctxOf(w);
    expect(studyEligible(c, ctx, NONE)).toBe(false);
    expect(studyEligible(c, ctx, new Set(['d1']))).toBe(true);
    expect(studyEligible(c, ctx, new Set(['other']))).toBe(false);
  });

  it('a card whose deck does not exist is never eligible', () => {
    const w = new World();
    const [c] = w.note('ghost', [REVIEW_DUE]);
    expect(studyEligible(c, ctxOf(w), new Set(['ghost']))).toBe(false);
  });

  it('a disabled direction is excluded; no directions map = every direction is on', () => {
    const w = new World();
    w.deck('on');
    w.deck('off', { options: { directions: { 'nt-basic-reverse': [0] } } });
    const [onFwd, onRev] = w.note('on', [REVIEW_DUE, REVIEW_DUE]);
    const [offFwd, offRev] = w.note('off', [REVIEW_DUE, REVIEW_DUE]);
    const ctx = ctxOf(w);
    expect(studyEligible(onFwd, ctx, NONE)).toBe(true);
    expect(studyEligible(onRev, ctx, NONE)).toBe(true);
    expect(studyEligible(offFwd, ctx, NONE)).toBe(true);
    expect(studyEligible(offRev, ctx, NONE)).toBe(false);
  });

  it('the directions map only limits the card types it names', () => {
    const w = new World();
    w.deck('d1', { options: { directions: { 'nt-other': [1] } } });
    const [fwd, rev] = w.note('d1', [REVIEW_DUE, REVIEW_DUE]);
    const ctx = ctxOf(w);
    expect(studyEligible(fwd, ctx, NONE)).toBe(true);
    expect(studyEligible(rev, ctx, NONE)).toBe(true);
  });

  it('suspended and buried cards are excluded; a bury from the past is over', () => {
    const w = new World();
    w.deck('d1');
    const [susp] = w.note('d1', [{ ...REVIEW_DUE, suspended: true }]);
    const [buried] = w.note('d1', [{ ...REVIEW_DUE, buriedUntil: NOW + HOUR }]);
    const [wasBuried] = w.note('d1', [{ ...REVIEW_DUE, buriedUntil: NOW - HOUR }]);
    const ctx = ctxOf(w);
    expect(studyEligible(susp, ctx, NONE)).toBe(false);
    expect(studyEligible(buried, ctx, NONE)).toBe(false);
    expect(studyEligible(wasBuried, ctx, NONE)).toBe(true);
  });

  it('selectScheduled re-checks deck, direction, suspended and buried even when the pool is careless', () => {
    const w = new World();
    w.deck('d1', { options: { directions: { 'nt-basic-reverse': [0] } } });
    const [fwd, rev] = w.note('d1', [REVIEW_DUE, MASTERED_DUE]);
    w.note('d1', [{ ...REVIEW_DUE, suspended: true }]);
    w.note('d1', [{ ...LEARNING_DUE, buriedUntil: NOW + HOUR }]);
    w.note('ghost', [REVIEW_DUE]);
    const ctx = ctxOf(w);
    const sel = selectScheduled(w.cards, ctx); // the whole library, unfiltered
    expect(ids(planQueue(sel))).toEqual([fwd.id]);
    expect(ids(planQueue(sel))).not.toContain(rev.id);
  });

  it('a card that is in the pool twice is in the queue once', () => {
    const w = new World();
    w.deck('d1');
    const [r] = w.note('d1', [REVIEW_DUE]);
    const [n] = w.note('d1', [NEW]);
    const ctx = ctxOf(w);
    const sel = selectScheduled([r, n, r, n, r], ctx);
    expect(ids(planQueue(sel))).toEqual([r.id, n.id]);
    expect(readyCounts(sel).total).toBe(2);
  });
});

/* ================================================================== damaged saved data */

describe('damaged saved data never breaks a count', () => {
  // A hand-edited or half-broken backup can hold values the types do not allow.
  // The scheduler runs for EVERY Study count on every screen, so it must not
  // throw, and a broken value must never make a card "due".

  it('a directions entry that is not a list counts as no entry: every direction is on, nothing throws', () => {
    for (const damaged of [1, null, 'x', { 0: 1 }]) {
      const w = new World();
      w.deck('d1', { options: { directions: { 'nt-basic-reverse': damaged as never } } });
      // Direction 0 is due now; direction 1 is due in 2 days (a Study-ahead card).
      const [fwd, rev] = w.note('d1', [REVIEW_DUE, REVIEW_LATER]);
      const ctx = ctxOf(w);
      const where = JSON.stringify(damaged);
      expect({ where, fwd: studyEligible(fwd, ctx, NONE), rev: studyEligible(rev, ctx, NONE) }).toEqual({
        where, fwd: true, rev: true,
      });
      expect(() => selectScheduled(w.cards, ctx)).not.toThrow();
      expect(ids(selectScheduled(w.cards, ctx).reviews)).toEqual([fwd.id]);
      expect(() => selectAhead(w.cards, ctx)).not.toThrow();
      expect(ids(selectAhead(w.cards, ctx))).toEqual([rev.id]); // direction 1 is on
    }
  });

  it('a directions map that is not an object, or a deck with no options at all, never throws', () => {
    const w = new World();
    w.deck('d1', { options: { directions: 5 as never } });
    const noOptions = w.deck('d2');
    w.decks[1] = { ...noOptions, options: undefined as never };
    const [, rev] = w.note('d1', [REVIEW_LATER, REVIEW_DUE]);
    const [review] = w.note('d2', [REVIEW_DUE]);
    const [fresh] = w.note('d2', [NEW]);
    const [checkId] = idsWithSample('no-options', 1, true);
    w.note('d2', [KNOWN_LONG_AGO], { cardIds: [checkId] });
    const ctx = ctxOf(w);
    expect(studyEligible(rev, ctx, NONE)).toBe(true);
    const sel = selectScheduled(w.cards, ctx);
    expect(ids(sel.reviews)).toEqual([rev.id, review.id]); // the same due → by id ('n1-c1' < 'n2-c0')
    // No options: no per-deck new cap, source order, and no Checks (knownChecks is not true).
    expect(ids(sel.fresh)).toEqual([fresh.id]);
    expect(sel.checks).toEqual([]);
  });

  it('a due that is not a real time (null or NaN from JSON, Infinity) is never due: not now, not ahead', () => {
    const w = new World();
    w.deck('d1');
    w.note('d1', [{ ...LEARNING_DUE, due: null as never }]);
    w.note('d1', [{ ...REVIEW_DUE, due: null as never }]);
    w.note('d1', [{ ...MASTERED_DUE, due: Number.NaN }]);
    w.note('d1', [{ ...REVIEW_DUE, due: Infinity }]);
    const [ok] = w.note('d1', [REVIEW_DUE]);
    const [later] = w.note('d1', [REVIEW_LATER]);
    const ctx = ctxOf(w);
    const sel = selectScheduled(studyPool(w, ctx), ctx);
    expect(sel.learn).toEqual([]);
    expect(ids(sel.reviews)).toEqual([ok.id]);
    expect(ids(selectAhead(studyPool(w, ctx), ctx))).toEqual([later.id]);
    expect(readyCounts(sel).total).toBe(planQueue(sel).length);
  });
});

/* ================================================================== bucket 1: learn */

describe('bucket 1 — learn', () => {
  it('due learning cards come first, by due; learning cards due later wait', () => {
    const w = new World();
    w.deck('d1');
    const [late] = w.note('d1', [{ ...LEARNING_DUE, due: NOW - MIN }]);
    const [early] = w.note('d1', [{ ...LEARNING_DUE, due: NOW - 5 * MIN }]);
    w.note('d1', [LEARNING_LATER]);
    const [rev] = w.note('d1', [REVIEW_DUE]);
    const sel = run(w);
    expect(ids(sel.learn)).toEqual([early.id, late.id]);
    expect(ids(planQueue(sel))).toEqual([early.id, late.id, rev.id]);
  });

  it('is never capped by a daily limit', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 15, LEARNING_DUE);
    const sel = run(w, { srs: { dailyReviewLimit: 10, dailyNewLimit: 0 }, done: { reviews: 10, neww: 50 } });
    expect(sel.learn).toHaveLength(15);
    expect(sel.reviews).toHaveLength(0);
  });

  it('learning is exempt from the sibling rules: two learning siblings both come', () => {
    const w = new World();
    w.deck('d1');
    const [a, b] = w.note('d1', [LEARNING_DUE, { ...LEARNING_DUE, lastReviewedAt: NOW - HOUR }]);
    expect(ids(run(w).learn)).toEqual([a.id, b.id]);
  });

  it('a learning card does not hold back a due review sibling, and the review does not hold it back', () => {
    const w = new World();
    w.deck('d1');
    const [learning, review] = w.note('d1', [LEARNING_DUE, REVIEW_DUE]);
    const sel = run(w);
    expect(ids(sel.learn)).toEqual([learning.id]);
    expect(ids(sel.reviews)).toEqual([review.id]);
  });
});

/* ================================================================== bucket 2: reviews */

describe('bucket 2 — reviews', () => {
  it('due review and mastered cards, by due; not-due ones wait', () => {
    const w = new World();
    w.deck('d1');
    const [r] = w.note('d1', [REVIEW_DUE]); // due 1 h ago
    const [m] = w.note('d1', [MASTERED_DUE]); // due 2 days ago
    w.note('d1', [REVIEW_LATER]);
    expect(ids(run(w).reviews)).toEqual([m.id, r.id]);
  });

  it('capped by dailyReviewLimit − done.reviews (never below 0)', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 30, REVIEW_DUE);
    expect(run(w, { srs: { dailyReviewLimit: 20 }, done: { reviews: 15 } }).reviews).toHaveLength(5);
    expect(run(w, { srs: { dailyReviewLimit: 20 }, done: { reviews: 40 } }).reviews).toHaveLength(0);
    expect(run(w, { srs: { dailyReviewLimit: NO_REVIEW_LIMIT } }).reviews).toHaveLength(30);
  });

  it('a missing or broken review limit uses the default limit (200), never 0', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 30, REVIEW_DUE, 'a');
    const ctx = ctxOf(w);
    for (const dailyReviewLimit of [undefined, null, Number.NaN]) {
      const broken = brokenSettings(ctx, { srs: { dailyReviewLimit } });
      expect(selectScheduled(studyPool(w, broken), broken).reviews).toHaveLength(30);
    }
    w.many('d1', 250, REVIEW_DUE, 'b');
    const big = brokenSettings(ctxOf(w), { srs: { dailyReviewLimit: undefined } });
    expect(selectScheduled(studyPool(w, big), big).reviews).toHaveLength(DEFAULT_SRS.dailyReviewLimit);
  });

  it("a dayDone of another day counts as nothing done (yesterday's reviews do not cap today)", () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 30, REVIEW_DUE);
    const sel = run(w, { srs: { dailyReviewLimit: 20 }, done: { dayKey: addDays(TODAY, -1), reviews: 20 } });
    expect(sel.reviews).toHaveLength(20);
  });

  it('review-sibling rule: two due cards of one note → only the earlier one; the other waits', () => {
    const w = new World();
    w.deck('d1');
    const [laterDue, earlierDue] = w.note('d1', [REVIEW_DUE, MASTERED_DUE]);
    const sel = run(w);
    expect(ids(sel.reviews)).toEqual([earlierDue.id]);
    expect(ids(planQueue(sel))).not.toContain(laterDue.id);
  });

  it('review-sibling rule: after the first sibling is rated, the other still waits until the next day', () => {
    const w = new World();
    w.deck('d1');
    // A Basic + reverse note: direction 0 due 2 days ago, direction 1 due 1 hour ago.
    const [first, second] = w.note('d1', [MASTERED_DUE, REVIEW_DUE]);
    expect(ids(planQueue(run(w)))).toEqual([first.id]);

    // The learner rates direction 0 "Good" 5 minutes later. 10 minutes after that, on the
    // same day, Today must NOT offer direction 1: both directions never come on one day.
    const after = afterRating(w, first, NOW + 5 * MIN, 15);
    const sameDay = run(after, { now: NOW + 15 * MIN });
    expect(planQueue(sameDay)).toEqual([]);
    expect(readyCounts(sameDay).total).toBe(0);
    // Late in the evening it still waits.
    expect(planQueue(run(after, { now: localTime('2026-06-10', '23:59') }))).toEqual([]);

    // The next day it comes.
    const nextDay = run(after, { now: NOW + DAY });
    expect(ids(planQueue(nextDay))).toEqual([second.id]);
    expect(readyCounts(nextDay).total).toBe(1);
  });

  it('review-sibling rule: a due review waits when a sibling was studied today; yesterday does not count', () => {
    const w = new World();
    w.deck('d1');
    const [, waits] = w.note('d1', [STUDIED_TODAY, REVIEW_DUE]);
    const [, comes] = w.note('d1', [{ ...STUDIED_TODAY, lastReviewedAt: startOfLocalDay(NOW) - 1 }, REVIEW_DUE]);
    const reviews = ids(run(w).reviews);
    expect(reviews).not.toContain(waits.id);
    expect(reviews).toEqual([comes.id]);
  });

  it('review-sibling rule: a sibling in learning (studied today) does not hold a due review back', () => {
    const w = new World();
    w.deck('d1');
    // Direction 0 was missed an hour ago and is in learning again; learning is exempt.
    const [learning, review] = w.note('d1', [{ ...LEARNING_DUE, lastReviewedAt: NOW - HOUR }, REVIEW_DUE]);
    const sel = run(w);
    expect(ids(sel.learn)).toEqual([learning.id]);
    expect(ids(sel.reviews)).toEqual([review.id]);
  });

  it('with spaceSiblings off, only the "both due now" part of the review-sibling rule applies', () => {
    const w = new World();
    w.deck('d1');
    const [first, second] = w.note('d1', [MASTERED_DUE, REVIEW_DUE]);
    expect(ids(run(w, { spaceSiblings: false }).reviews)).toEqual([first.id]);
    // After the first is rated, the learner allowed both directions on one day: the second comes.
    const after = afterRating(w, first, NOW + 5 * MIN, 15);
    expect(ids(run(after, { now: NOW + 15 * MIN, spaceSiblings: false }).reviews)).toEqual([second.id]);
  });

  it('the review-sibling rule runs BEFORE the daily cap (the cap counts notes, not hidden siblings)', () => {
    const w = new World();
    w.deck('d1');
    for (let i = 0; i < 5; i++) w.note('d1', [{ ...REVIEW_DUE, due: NOW - (10 - i) * MIN }, MASTERED_DUE]);
    w.many('d1', 5, { ...REVIEW_DUE, due: NOW - MIN });
    // 5 notes with two due cards + 5 single cards = 10 notes; the limit 10 fits all of them.
    expect(run(w, { srs: { dailyReviewLimit: 10 } }).reviews).toHaveLength(10);
  });

  it('a suspended sibling does not hold a due review back', () => {
    const w = new World();
    w.deck('d1');
    const [, shown] = w.note('d1', [{ ...MASTERED_DUE, suspended: true }, REVIEW_DUE]);
    expect(ids(run(w).reviews)).toEqual([shown.id]);
  });

  it('Known cards are never reviews, even with review SRS values and an old due date', () => {
    const w = new World();
    w.deck('d1', { options: { knownChecks: false } });
    w.note('d1', [{ ...MASTERED_DUE, knownAt: NOW - 3 * DAY }]);
    w.note('d1', [{ ...REVIEW_DUE, knownAt: NOW - 200 * DAY }]);
    const sel = run(w);
    expect(sel.reviews).toHaveLength(0);
    expect(planQueue(sel)).toHaveLength(0);
  });
});

/* ================================================================== bucket 3: checks */

describe('bucket 3 — checks (Known cards)', () => {
  it('sampled (fnv1a % 10 === 0) and past their spread → one Check', () => {
    const w = new World();
    w.deck('d1');
    const [inId] = idsWithSample('k', 1, true);
    const [outId] = idsWithSample('k', 1, false);
    const [sampled] = w.note('d1', [KNOWN_LONG_AGO], { cardIds: [inId] });
    w.note('d1', [KNOWN_LONG_AGO], { cardIds: [outId] });
    expect(fnv1a(inId) % 10).toBe(0);
    expect(ids(run(w).checks)).toEqual([sampled.id]);
  });

  it('spreadDays is 21–90 and the Check comes exactly at knownAt + spreadDays × DAY', () => {
    const [id] = idsWithSample('spread', 1, true);
    const days = spreadDays(id);
    expect(days).toBeGreaterThanOrEqual(21);
    expect(days).toBeLessThanOrEqual(90);
    expect(days).toBe(21 + (Math.floor(fnv1a(id) / 10) % 70));

    const w = new World();
    w.deck('d1');
    const knownAt = NOW - days * DAY;
    w.note('d1', [{ knownAt }], { cardIds: [id] });
    const card = w.cards[0];
    expect(checkReadyAt(card)).toBe(NOW);
    expect(run(w, { now: NOW }).checks).toHaveLength(1);
    expect(run(w, { now: NOW - 1 }).checks).toHaveLength(0);
  });

  it('a card is checked at most once (knownCheckedAt set → no Check)', () => {
    const w = new World();
    w.deck('d1');
    const [id] = idsWithSample('once', 1, true);
    w.note('d1', [{ ...KNOWN_LONG_AGO, knownCheckedAt: NOW - 5 * DAY }], { cardIds: [id] });
    expect(run(w).checks).toHaveLength(0);
  });

  it('the deck option knownChecks: false turns Checks off for that deck', () => {
    const w = new World();
    w.deck('on');
    w.deck('off', { options: { knownChecks: false } });
    const [a, b] = idsWithSample('opt', 2, true);
    const [onCard] = w.note('on', [KNOWN_LONG_AGO], { cardIds: [a] });
    w.note('off', [KNOWN_LONG_AGO], { cardIds: [b] });
    expect(ids(run(w).checks)).toEqual([onCard.id]);
  });

  it('capped by knownChecksPerDay − done.checks; 0 = no checks', () => {
    const w = new World();
    w.deck('d1');
    for (const id of idsWithSample('cap', 12, true)) w.note('d1', [KNOWN_LONG_AGO], { cardIds: [id] });
    expect(run(w, { knownChecksPerDay: 5 }).checks).toHaveLength(5);
    expect(run(w, { knownChecksPerDay: 5, done: { checks: 3 } }).checks).toHaveLength(2);
    expect(run(w, { knownChecksPerDay: 5, done: { checks: 9 } }).checks).toHaveLength(0);
    expect(run(w, { knownChecksPerDay: 0 }).checks).toHaveLength(0);
  });

  it('a missing or broken knownChecksPerDay uses the default (5), never 0', () => {
    const w = new World();
    w.deck('d1');
    for (const id of idsWithSample('bad', 12, true)) w.note('d1', [KNOWN_LONG_AGO], { cardIds: [id] });
    for (const knownChecksPerDay of [undefined, null, Number.NaN]) {
      const ctx = brokenSettings(ctxOf(w), { knownChecksPerDay });
      expect(selectScheduled(studyPool(w, ctx), ctx).checks).toHaveLength(5);
    }
  });

  it('the card whose Check became ready first comes first', () => {
    const w = new World();
    w.deck('d1');
    const [a, b] = idsWithSample('ord', 2, true);
    // b became ready 30 days ago, a only 1 day ago.
    w.note('d1', [{ knownAt: NOW - (spreadDays(a) + 1) * DAY }], { cardIds: [a] });
    w.note('d1', [{ knownAt: NOW - (spreadDays(b) + 30) * DAY }], { cardIds: [b] });
    expect(ids(run(w).checks)).toEqual([b, a]);
  });

  describe('check-sibling rule (a Check is never urgent, so it waits for its siblings)', () => {
    /** A Basic + reverse note in d1: direction 0 in `dir0`, direction 1 Known, sampled and ready for its Check. */
    function knownReverse(w: World, dir0: State, tag: string): { dir0: Card; check: Card } {
      const [checkId] = idsWithSample(tag, 1, true);
      const [a, b] = w.note('d1', [dir0, KNOWN_LONG_AGO], { cardIds: [`${tag}-dir0`, checkId] });
      return { dir0: a, check: b };
    }

    it('(a) direction 0 is a due review → the review comes, the Check waits (also with spacing off)', () => {
      const w = new World();
      w.deck('d1');
      const { dir0, check } = knownReverse(w, REVIEW_DUE, 'a');
      for (const spaceSiblings of [true, false]) {
        const sel = run(w, { spaceSiblings });
        expect(ids(sel.reviews)).toEqual([dir0.id]);
        expect(sel.checks).toEqual([]);
      }
      // The learner rates direction 0 at 09:00. Spacing on: no Check later today; it comes tomorrow.
      const rated = afterRating(w, dir0, NOW, 5);
      expect(run(rated, { now: NOW + 10 * MIN }).checks).toEqual([]);
      expect(ids(run(rated, { now: NOW + DAY }).checks)).toEqual([check.id]);
      // Spacing off: the next session today may give it.
      expect(ids(run(rated, { now: NOW + 10 * MIN, spaceSiblings: false }).checks)).toEqual([check.id]);
    });

    it('(a) direction 0 is a due learning card → the Check waits too', () => {
      const w = new World();
      w.deck('d1');
      const { dir0 } = knownReverse(w, LEARNING_DUE, 'al');
      const sel = run(w);
      expect(ids(sel.learn)).toEqual([dir0.id]);
      expect(sel.checks).toEqual([]);
    });

    it('(b) direction 0 was reviewed this morning → no Check today (spacing on); it comes the next day', () => {
      const w = new World();
      w.deck('d1');
      const { check } = knownReverse(w, STUDIED_TODAY, 'b');
      expect(run(w).checks).toEqual([]);
      expect(ids(run(w, { now: NOW + DAY }).checks)).toEqual([check.id]);
      expect(ids(run(w, { spaceSiblings: false }).checks)).toEqual([check.id]);
    });

    it('(b) direction 0 is in learning (due later today) → no Check now (spacing on)', () => {
      const w = new World();
      w.deck('d1');
      const { check } = knownReverse(w, LEARNING_LATER, 'bl');
      expect(run(w).checks).toEqual([]);
      expect(ids(run(w, { spaceSiblings: false }).checks)).toEqual([check.id]);
    });

    it('(c) both directions Known and ready → one Check today, the other on another day', () => {
      const w = new World();
      w.deck('d1');
      const [c0, c1] = idsWithSample('c', 2, true);
      w.note('d1', [KNOWN_LONG_AGO, KNOWN_LONG_AGO], { cardIds: [c0, c1] });
      // Spacing off too: one card per note in one session.
      for (const spaceSiblings of [true, false]) expect(run(w, { spaceSiblings }).checks).toHaveLength(1);
      const [first] = run(w).checks;
      const other = first.id === c0 ? c1 : c0;
      // The learner passes the first Check at 09:00.
      const passed = { ...w, cards: w.cards.map((c) => (c.id === first.id ? { ...c, knownCheckedAt: NOW, lastReviewedAt: NOW } : c)) };
      expect(run(passed, { now: NOW + 10 * MIN }).checks).toEqual([]); // spacing on: not the same day
      expect(ids(run(passed, { now: NOW + DAY }).checks)).toEqual([other]);
      expect(ids(run(passed, { now: NOW + 10 * MIN, spaceSiblings: false }).checks)).toEqual([other]);
      // A pass as the reducer REALLY writes it (rateByBucket): knownCheckedAt only, lastReviewedAt untouched (final review).
      const realPass = { ...w, cards: w.cards.map((c) => (c.id === first.id ? { ...c, knownCheckedAt: NOW } : c)) };
      expect(run(realPass, { now: NOW + 10 * MIN }).checks).toEqual([]); // spacing on: not the same day
      expect(ids(run(realPass, { now: NOW + DAY }).checks)).toEqual([other]);
      expect(ids(run(realPass, { now: NOW + 10 * MIN, spaceSiblings: false }).checks)).toEqual([other]);
    });

    it('(d) a Check passed this morning (knownCheckedAt only) → its sibling review waits for another day (spacing on, final review)', () => {
      const w = new World();
      w.deck('d1');
      const { dir0, check } = knownReverse(w, REVIEW_LATER, 'd');
      const passed = { ...w, cards: w.cards.map((c) => (c.id === check.id ? { ...c, knownCheckedAt: NOW - HOUR } : c)) };
      // Direction 0 becomes due later today.
      const dueToday = { ...passed, cards: passed.cards.map((c) => (c.id === dir0.id ? { ...c, due: NOW - MIN } : c)) };
      expect(run(dueToday).reviews).toEqual([]);
      expect(ids(run(dueToday, { spaceSiblings: false }).reviews)).toEqual([dir0.id]);
      expect(ids(run(dueToday, { now: NOW + DAY }).reviews)).toEqual([dir0.id]);
      // A Check passed YESTERDAY does not hold it back.
      const yesterday = { ...dueToday, cards: dueToday.cards.map((c) => (c.id === check.id ? { ...c, knownCheckedAt: NOW - DAY } : c)) };
      expect(ids(run(yesterday).reviews)).toEqual([dir0.id]);
    });

    it('a Check that waits does not use the daily cap: the next ready Check comes instead', () => {
      const w = new World();
      w.deck('d1');
      knownReverse(w, REVIEW_DUE, 'waits');
      const [free] = idsWithSample('free', 1, true);
      w.note('d1', [KNOWN_LONG_AGO], { cardIds: [free] });
      expect(ids(run(w, { knownChecksPerDay: 1 }).checks)).toEqual([free]);
    });

    it('a sibling review cut by the daily review limit is not in this run, so the Check may come', () => {
      const w = new World();
      w.deck('d1');
      w.many('d1', 3, { ...REVIEW_DUE, due: NOW - DAY });
      const { dir0, check } = knownReverse(w, REVIEW_DUE, 'cut'); // its review is the 4th by due
      const sel = run(w, { srs: { dailyReviewLimit: 3 } });
      expect(ids(sel.reviews)).not.toContain(dir0.id);
      expect(ids(sel.checks)).toEqual([check.id]);
    });
  });

  it('about 10% of Known cards are sampled, spread evenly over 21–90 days', () => {
    let sampled = 0;
    const perSpread = new Map<number, number>();
    for (let i = 0; i < 20_000; i++) {
      const id = `card-${i}`;
      if (!isCheckSampled(id)) continue;
      sampled += 1;
      const d = spreadDays(id);
      perSpread.set(d, (perSpread.get(d) ?? 0) + 1);
    }
    expect(sampled / 20_000).toBeGreaterThan(0.09);
    expect(sampled / 20_000).toBeLessThan(0.11);
    // Every one of the 70 spread days is used, and none is crowded.
    expect([...perSpread.keys()].sort((x, y) => x - y)).toEqual(Array.from({ length: 70 }, (_, k) => 21 + k));
    for (const n of perSpread.values()) expect(n).toBeLessThan((sampled / 70) * 1.6);
  });

  it('the spec example: 1,530 cards marked Known → ~153 Checks over ~70 days, never more than 5 a day', () => {
    const w = new World();
    w.deck('d1');
    const markedAt = localTime('2026-01-05', '20:00');
    w.many('d1', 1530, { knownAt: markedAt }, 'a1');
    const sampled = w.cards.filter((c) => isCheckSampled(c.id)).length;
    expect(sampled).toBeGreaterThan(120);
    expect(sampled).toBeLessThan(190);

    // Simulate 120 days of studying every Check that Study gives.
    const checkedAt = new Map<Id, number>();
    const perDay: number[] = [];
    for (let day = 0; day < 120; day++) {
      const now = localTime(addDays('2026-01-06', day), '09:00');
      const cards = w.cards.map((c) => (checkedAt.has(c.id) ? { ...c, knownCheckedAt: checkedAt.get(c.id) } : c));
      const sel = selectScheduled(cards, ctxOf({ ...w, cards }, { now, knownChecksPerDay: 5 }));
      for (const c of sel.checks) checkedAt.set(c.id, now);
      perDay.push(sel.checks.length);
    }
    expect(Math.max(...perDay)).toBeLessThanOrEqual(5);
    expect(checkedAt.size).toBe(sampled); // every sampled card got its one Check
    // Nothing before day 21 after marking; the busy part lasts about 70 days.
    expect(perDay.slice(0, 20).every((n) => n === 0)).toBe(true);
    const busyDays = perDay.filter((n) => n > 0).length;
    expect(busyDays).toBeGreaterThan(40);
  });
});

/* ================================================================== bucket 4: fresh (new cards) */

describe('bucket 4 — fresh (new cards)', () => {
  it('round robin: 3 decks, limit 10 → all three decks get new cards on day 1', () => {
    const w = new World();
    w.deck('vocab', { order: 0 });
    w.deck('grammar', { order: 1 });
    w.deck('verbs', { order: 2 });
    w.many('vocab', 40, NEW);
    w.many('grammar', 40, NEW);
    w.many('verbs', 40, NEW);
    const sel = run(w, { srs: { dailyNewLimit: 10 } });
    expect(sel.fresh).toHaveLength(10);
    expect(sel.fresh.map((c) => c.deckId)).toEqual([
      'vocab', 'grammar', 'verbs',
      'vocab', 'grammar', 'verbs',
      'vocab', 'grammar', 'verbs',
      'vocab',
    ]);
  });

  it('decks take turns in deck.order, not in the order they were created', () => {
    const w = new World();
    w.deck('b', { order: 5 });
    w.deck('a', { order: 1 });
    w.many('b', 3, NEW);
    w.many('a', 3, NEW);
    expect(run(w, { srs: { dailyNewLimit: 4 } }).fresh.map((c) => c.deckId)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('the global new budget is dailyNewLimit − done.neww', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 20, NEW);
    expect(run(w, { srs: { dailyNewLimit: 10 }, done: { neww: 7 } }).fresh).toHaveLength(3);
    expect(run(w, { srs: { dailyNewLimit: 10 }, done: { neww: 12 } }).fresh).toHaveLength(0);
    expect(run(w, { srs: { dailyNewLimit: 0 } }).fresh).toHaveLength(0);
  });

  it('a missing or broken new-card limit uses the default (10), never 0', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 20, NEW);
    for (const dailyNewLimit of [undefined, null, Number.NaN]) {
      const ctx = brokenSettings(ctxOf(w), { srs: { dailyNewLimit } });
      expect(selectScheduled(studyPool(w, ctx), ctx).fresh).toHaveLength(DEFAULT_SRS.dailyNewLimit);
    }
  });

  it('a broken per-deck newPerDay (not a finite number) means no per-deck cap, like null', () => {
    const w = new World();
    w.deck('d1', { options: { newPerDay: Number.NaN } });
    w.many('d1', 20, NEW);
    expect(run(w, { srs: { dailyNewLimit: 10 } }).fresh).toHaveLength(10);
  });

  it('per-deck caps use newPerDay − done.newByDeck; null = only the global limit', () => {
    const w = new World();
    w.deck('capped', { order: 0, options: { newPerDay: 3 } });
    w.deck('free', { order: 1, options: { newPerDay: null } });
    w.deck('closed', { order: 2, options: { newPerDay: 0 } });
    w.many('capped', 20, NEW);
    w.many('free', 20, NEW);
    w.many('closed', 20, NEW);
    const sel = run(w, { srs: { dailyNewLimit: 10 }, done: { neww: 0, newByDeck: { capped: 1 } } });
    const perDeck = (deckId: Id) => sel.fresh.filter((c) => c.deckId === deckId).length;
    expect(perDeck('capped')).toBe(2); // 3 − 1 already studied today
    expect(perDeck('free')).toBe(8); // takes the rest of the global 10
    expect(perDeck('closed')).toBe(0);
  });

  it("yesterday's newByDeck does not cap today", () => {
    const w = new World();
    w.deck('d1', { options: { newPerDay: 3 } });
    w.many('d1', 10, NEW);
    const sel = run(w, { done: { dayKey: addDays(TODAY, -1), neww: 10, newByDeck: { d1: 3 } } });
    expect(sel.fresh).toHaveLength(3);
  });

  it("'source' order: newPos, then ord, then id", () => {
    const w = new World();
    w.deck('d1');
    const [third] = w.note('d1', [NEW], { order: 30 });
    const [first] = w.note('d1', [NEW], { order: 10 });
    const [second] = w.note('d1', [NEW], { order: 20 });
    expect(ids(run(w).fresh)).toEqual([first.id, second.id, third.id]);
  });

  it("'source' order with siblings spacing off: ord 0 before ord 1 of the same note", () => {
    const w = new World();
    w.deck('d1');
    const [fwd, rev] = w.note('d1', [NEW, NEW], { order: 1 });
    expect(ids(run(w, { spaceSiblings: false }).fresh)).toEqual([fwd.id, rev.id]);
  });

  it("'random' order is a stable hash of id + day: the same all day, different the next day", () => {
    const w = new World();
    w.deck('d1', { options: { newOrder: 'random' } });
    w.many('d1', 30, NEW);
    const today = ids(run(w, { srs: { dailyNewLimit: 30 } }).fresh);
    const expected = [...w.cards]
      .sort((a, b) => fnv1a(a.id + TODAY) - fnv1a(b.id + TODAY))
      .map((c) => c.id);
    expect(today).toEqual(expected);
    expect(ids(run(w, { srs: { dailyNewLimit: 30 }, now: NOW + 5 * HOUR }).fresh)).toEqual(today);
    const tomorrow = ids(run(w, { srs: { dailyNewLimit: 30 }, now: NOW + DAY }).fresh);
    expect(tomorrow).not.toEqual(today);
    expect([...tomorrow].sort()).toEqual([...today].sort());
  });

  it('Not started cards are never fed, whatever the limits', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 10, NOT_STARTED);
    const [queued] = w.note('d1', [{ newState: 'queued' }]);
    const sel = run(w, { srs: { dailyNewLimit: 999 } });
    expect(ids(sel.fresh)).toEqual([queued.id]);
  });

  describe('new-sibling rule (settings.spaceSiblings)', () => {
    it('two new cards of one note → only one per day (the first in feed order)', () => {
      const w = new World();
      w.deck('d1');
      const [fwd] = w.note('d1', [NEW, NEW]);
      const [single] = w.note('d1', [NEW]);
      expect(ids(run(w).fresh)).toEqual([fwd.id, single.id]);
    });

    it('waits when a sibling was studied today; a sibling studied yesterday does not block', () => {
      const w = new World();
      w.deck('d1');
      const [, blocked] = w.note('d1', [STUDIED_TODAY, NEW]);
      const [, free] = w.note('d1', [{ ...STUDIED_TODAY, lastReviewedAt: startOfLocalDay(NOW) - 1 }, NEW]);
      const fresh = ids(run(w).fresh);
      expect(fresh).not.toContain(blocked.id);
      expect(fresh).toContain(free.id);
    });

    it('waits when a sibling is in learning now (even one due later today)', () => {
      const w = new World();
      w.deck('d1');
      const [, blockedA] = w.note('d1', [LEARNING_DUE, NEW]);
      const [, blockedB] = w.note('d1', [LEARNING_LATER, NEW]);
      const fresh = ids(run(w).fresh);
      expect(fresh).not.toContain(blockedA.id);
      expect(fresh).not.toContain(blockedB.id);
    });

    it('a learning sibling that can never come back (suspended, direction off) does not block forever', () => {
      const w = new World();
      w.deck('d1', { options: { directions: { 'nt-basic-reverse': [1] } } });
      // Direction 0 is off: its learning card can never be shown, so the new reverse card is free.
      const [, freeA] = w.note('d1', [LEARNING_DUE, NEW]);
      w.deck('d2');
      const [, freeB] = w.note('d2', [{ ...LEARNING_DUE, suspended: true }, NEW]);
      const fresh = ids(run(w).fresh);
      expect(fresh).toContain(freeA.id);
      expect(fresh).toContain(freeB.id);
    });

    it('a learning sibling with a broken due (null, NaN, Infinity) is never shown, so it blocks no sibling (W3-4)', () => {
      const w = new World();
      w.deck('d1');
      const [checkId] = idsWithSample('broken-check', 1, true);
      const broken = [null as never, Number.NaN, Infinity];
      // A broken learning card + a new sibling, for each kind of broken due.
      const pairs = broken.map((due, i) => w.note('d1', [{ ...LEARNING_DUE, due }, NEW], { id: `nb${i}` }));
      // A broken learning card + a Known sibling that is ready for its Check.
      const [brokenOfCheck, check] = w.note('d1', [{ ...LEARNING_DUE, due: Number.NaN }, KNOWN_LONG_AGO], {
        id: 'nc',
        cardIds: ['nc-c0', checkId],
      });
      const sel = run(w);
      // The broken cards are never shown …
      const shown = ids(planQueue(sel));
      for (const [brokenCard] of pairs) expect(shown).not.toContain(brokenCard.id);
      expect(shown).not.toContain(brokenOfCheck.id);
      // … so they do not hold their siblings back forever.
      expect(ids(sel.fresh)).toEqual(pairs.map(([, fresh]) => fresh.id));
      expect(ids(sel.checks)).toEqual([check.id]);
      expect(readyCounts(sel).total).toBe(planQueue(sel).length);
    });

    it('a learning sibling with a real due later today still blocks (only a broken due is exempt)', () => {
      const w = new World();
      w.deck('d1');
      const [, waiting] = w.note('d1', [LEARNING_LATER, NEW]);
      expect(ids(run(w).fresh)).not.toContain(waiting.id);
    });

    it('waits when a sibling is already picked as a review or a Check today', () => {
      const w = new World();
      w.deck('d1');
      const [, afterReview] = w.note('d1', [REVIEW_DUE, NEW]);
      const [checkId] = idsWithSample('pick', 1, true);
      const [, afterCheck] = w.note('d1', [KNOWN_LONG_AGO, NEW], { cardIds: [checkId, 'pick-new'] });
      const sel = run(w);
      expect(ids(sel.checks)).toEqual([checkId]);
      expect(ids(sel.fresh)).not.toContain(afterReview.id);
      expect(ids(sel.fresh)).not.toContain(afterCheck.id);
    });

    it('a sibling review cut by the daily review limit is not picked, so the new card may come', () => {
      const w = new World();
      w.deck('d1');
      w.many('d1', 3, { ...REVIEW_DUE, due: NOW - DAY });
      const [, newSibling] = w.note('d1', [REVIEW_DUE, NEW]); // its review is the 4th by due
      const sel = run(w, { srs: { dailyReviewLimit: 3 } });
      expect(sel.reviews).toHaveLength(3);
      expect(ids(sel.fresh)).toContain(newSibling.id);
    });

    it('a blocked card does not use the budget: the next card in the deck comes instead', () => {
      const w = new World();
      w.deck('d1');
      w.note('d1', [STUDIED_TODAY, NEW], { order: 1 });
      const [next] = w.note('d1', [NEW], { order: 2 });
      expect(ids(run(w, { srs: { dailyNewLimit: 1 } }).fresh)).toEqual([next.id]);
    });

    it('with spaceSiblings off, siblings are free (studied today, in learning, or both new)', () => {
      const w = new World();
      w.deck('d1');
      const [, a] = w.note('d1', [STUDIED_TODAY, NEW]);
      const [, b] = w.note('d1', [LEARNING_DUE, NEW]);
      const [c1, c2] = w.note('d1', [NEW, NEW]);
      const fresh = ids(run(w, { spaceSiblings: false }).fresh);
      expect(fresh).toEqual(expect.arrayContaining([a.id, b.id, c1.id, c2.id]));
    });
  });
});

/* ================================================================== session size + counts */

describe('session size and readyCounts', () => {
  function fullWorld(): World {
    const w = new World();
    w.deck('d1');
    w.many('d1', 3, LEARNING_DUE, 'l');
    w.many('d1', 5, REVIEW_DUE, 'r');
    for (const id of idsWithSample('s', 1, true)) w.note('d1', [KNOWN_LONG_AGO], { cardIds: [id] });
    w.many('d1', 5, NEW, 'n');
    return w;
  }

  it('cuts [...learn, ...reviews, ...checks, ...fresh] from the end', () => {
    const sel = run(fullWorld(), { sessionLimit: 6 });
    expect(sel.learn).toHaveLength(3);
    expect(sel.reviews).toHaveLength(3);
    expect(sel.checks).toHaveLength(0);
    expect(sel.fresh).toHaveLength(0);
    expect(sel.uncappedTotal).toBe(14);
    expect(readyCounts(sel)).toEqual({
      total: 6,
      learning: 3,
      due: 3,
      checks: 0,
      neww: 0,
      mins: minutesFor(6),
      capped: true,
      uncappedTotal: 14,
    });
  });

  it('0 = no cap; a cap above the total changes nothing', () => {
    for (const sessionLimit of [0, 14, 50]) {
      const sel = run(fullWorld(), { sessionLimit });
      const rc = readyCounts(sel);
      expect(rc.total).toBe(14);
      expect(rc.capped).toBe(false);
      expect([rc.learning, rc.due, rc.checks, rc.neww]).toEqual([3, 5, 1, 5]);
    }
  });

  it('planQueue is learn, reviews, checks, fresh — and its length is readyCounts.total', () => {
    const sel = run(fullWorld(), { sessionLimit: 11 });
    const queue = planQueue(sel);
    expect(queue).toEqual([...sel.learn, ...sel.reviews, ...sel.checks, ...sel.fresh]);
    expect(queue.map((c) => life(c))).toEqual([
      'learning', 'learning', 'learning',
      'review', 'review', 'review', 'review', 'review',
      'known',
      'new', 'new',
    ]);
    expect(readyCounts(sel).total).toBe(queue.length);
  });

  it('an empty pool gives an empty, honest selection', () => {
    const w = new World();
    w.deck('d1');
    const sel = run(w, { sessionLimit: 20 });
    expect(planQueue(sel)).toEqual([]);
    expect(readyCounts(sel)).toEqual({
      total: 0, learning: 0, due: 0, checks: 0, neww: 0, mins: 0, capped: false, uncappedTotal: 0,
    });
  });
});

/* ================================================================== study ahead */

describe('selectAhead — study ahead', () => {
  it('review and mastered cards that are not due yet, soonest first', () => {
    const w = new World();
    w.deck('d1');
    const [soon] = w.note('d1', [{ ...REVIEW_DUE, due: NOW + HOUR }]);
    const [later] = w.note('d1', [{ ...MASTERED_DUE, due: NOW + 9 * DAY }]);
    const [mid] = w.note('d1', [REVIEW_LATER]);
    w.note('d1', [REVIEW_DUE]); // already due → Study, not ahead
    w.note('d1', [LEARNING_LATER]);
    w.note('d1', [NEW]);
    w.note('d1', [{ ...REVIEW_LATER, knownAt: NOW - DAY }]); // Known
    w.note('d1', [{ ...REVIEW_LATER, suspended: true }]);
    w.note('d1', [{ ...REVIEW_LATER, buriedUntil: NOW + HOUR }]);
    const ctx = ctxOf(w);
    expect(ids(selectAhead(w.cards, ctx))).toEqual([soon.id, mid.id, later.id]);
  });

  it('is capped by the session size, and skips a disabled direction', () => {
    const w = new World();
    w.deck('d1', { options: { directions: { 'nt-basic-reverse': [0] } } });
    w.many('d1', 12, REVIEW_LATER);
    const [, rev] = w.note('d1', [{ ...REVIEW_LATER, due: NOW + 9 * DAY }, { ...REVIEW_LATER, due: NOW + MIN }]);
    expect(selectAhead(w.cards, ctxOf(w, { sessionLimit: 5 }))).toHaveLength(5);
    expect(ids(selectAhead(w.cards, ctxOf(w)))).not.toContain(rev.id);
    expect(selectAhead(w.cards, ctxOf(w))).toHaveLength(13);
  });

  it('review-sibling rule: two not-yet-due cards of one note → only the sooner one (never back to back)', () => {
    const w = new World();
    w.deck('d1');
    const [sooner, later] = w.note('d1', [{ ...REVIEW_DUE, due: NOW + HOUR }, { ...REVIEW_DUE, due: NOW + 2 * HOUR }]);
    const [other] = w.note('d1', [{ ...REVIEW_DUE, due: NOW + 3 * HOUR }]);
    const ahead = ids(selectAhead(w.cards, ctxOf(w)));
    expect(ahead).toEqual([sooner.id, other.id]);
    expect(ahead).not.toContain(later.id);
    // The one-per-note rule runs BEFORE the session-size cut: a cap of 2 still gets 2 notes.
    expect(ids(selectAhead(w.cards, ctxOf(w, { sessionLimit: 2 })))).toEqual([sooner.id, other.id]);
  });

  it('a card whose sibling was studied today waits (spaceSiblings on), like in Study', () => {
    const w = new World();
    w.deck('d1');
    // `studied` was studied an hour ago (due in 8 days); its sibling `waits` is due in 2 days.
    const [studied, waits] = w.note('d1', [STUDIED_TODAY, REVIEW_LATER]);
    const [single] = w.note('d1', [{ ...REVIEW_LATER, due: NOW + 3 * DAY }]);
    // `waits` is held back by its sibling. (`studied` itself is not held back: no OTHER card
    // of its note was studied today.)
    expect(ids(selectAhead(w.cards, ctxOf(w)))).toEqual([single.id, studied.id]);
    // With spaceSiblings off only the one-per-note part applies: the soonest card of the note.
    expect(ids(selectAhead(w.cards, ctxOf(w, { spaceSiblings: false })))).toEqual([waits.id, single.id]);
  });
});

/* ================================================================== practice */

describe('selectPractice — free practice', () => {
  function practiceWorld() {
    const w = new World();
    w.deck('d1', { order: 0 });
    w.deck('paused', { order: 1, active: false });
    const [review] = w.note('d1', [REVIEW_LATER], { id: 'review' });
    const [known] = w.note('d1', [{ ...REVIEW_LATER, knownAt: NOW - DAY }], { id: 'known' });
    const [notStarted] = w.note('d1', [NOT_STARTED], { id: 'notStarted' });
    const [suspended] = w.note('d1', [{ ...REVIEW_DUE, suspended: true }], { id: 'suspended' });
    const [buried] = w.note('d1', [{ ...REVIEW_DUE, buriedUntil: NOW + HOUR }], { id: 'buried' });
    const [fresh] = w.note('d1', [NEW], { id: 'fresh' });
    const [inPaused] = w.note('paused', [REVIEW_DUE], { id: 'inPaused' });
    return { w, review, known, notStarted, suspended, buried, fresh, inPaused };
  }

  it('removes Known, Not started, suspended and buried cards by default (paused decks and New stay)', () => {
    const p = practiceWorld();
    const out = ids(selectPractice(p.w.cards, null, ctxOf(p.w)));
    expect(out).toEqual([p.review.id, p.fresh.id, p.inPaused.id]);
  });

  it('keeps each group the practice scope asks for', () => {
    const p = practiceWorld();
    const keep = (scope: ScheduleCtx['scope']) => ids(selectPractice(p.w.cards, null, ctxOf(p.w, { scope })));
    expect(keep({ life: ['known'] })).toContain(p.known.id);
    expect(keep({ life: ['notStarted'] })).toContain(p.notStarted.id);
    expect(keep({ flags: ['suspended'] })).toContain(p.suspended.id);
    expect(keep({ flags: ['buried'] })).toContain(p.buried.id);
    expect(keep({ life: ['review'], flags: ['fav'] })).toEqual([p.review.id, p.fresh.id, p.inPaused.id]);
  });

  it("sort null keeps the pool order ('Practice the n you missed' keeps the miss order)", () => {
    const p = practiceWorld();
    const missOrder = [p.inPaused, p.fresh, p.review];
    expect(ids(selectPractice(missOrder, null, ctxOf(p.w)))).toEqual(ids(missOrder));
  });

  it("'hardest' = ease ascending, then lapses descending", () => {
    const w = new World();
    w.deck('d1');
    const [easy] = w.note('d1', [{ ...REVIEW_DUE, ease: 2.6, lapses: 0 }]);
    const [hardFew] = w.note('d1', [{ ...REVIEW_DUE, ease: 1.5, lapses: 1 }]);
    const [hardMany] = w.note('d1', [{ ...REVIEW_DUE, ease: 1.5, lapses: 6 }]);
    const [mid] = w.note('d1', [{ ...REVIEW_DUE, ease: 2.0, lapses: 9 }]);
    const out = ids(selectPractice(w.cards, { by: 'hardest' }, ctxOf(w)));
    expect(out).toEqual([hardMany.id, hardFew.id, mid.id, easy.id]);
  });

  it("'due', 'newest' and 'source' sorts; dir 'desc' reverses", () => {
    const w = new World();
    w.deck('b', { order: 1 });
    w.deck('a', { order: 0 });
    const [b1] = w.note('b', [{ ...REVIEW_DUE, due: NOW - DAY, createdAt: NOW - 3 * DAY }], { order: 1 });
    const [a2] = w.note('a', [{ ...REVIEW_DUE, due: NOW - HOUR, createdAt: NOW - 1 * DAY }], { order: 2 });
    const [a1] = w.note('a', [{ ...REVIEW_DUE, due: NOW + DAY, createdAt: NOW - 2 * DAY }], { order: 1 });
    const ctx = ctxOf(w);
    expect(ids(selectPractice(w.cards, { by: 'due' }, ctx))).toEqual([b1.id, a2.id, a1.id]);
    expect(ids(selectPractice(w.cards, { by: 'newest' }, ctx))).toEqual([a2.id, a1.id, b1.id]);
    expect(ids(selectPractice(w.cards, { by: 'source' }, ctx))).toEqual([a1.id, a2.id, b1.id]);
    expect(ids(selectPractice(w.cards, { by: 'source', dir: 'desc' }, ctx))).toEqual([b1.id, a2.id, a1.id]);
  });

  it("'az' and 'field' use ctx.sortKey; without it they fall back to the source order", () => {
    const w = new World();
    w.deck('d1');
    const [zebra] = w.note('d1', [REVIEW_DUE], { order: 1 });
    const [apple] = w.note('d1', [REVIEW_DUE], { order: 2 });
    const [mango] = w.note('d1', [REVIEW_DUE], { order: 3 });
    const words: Record<Id, string> = { [zebra.id]: 'zebra', [apple.id]: 'apple', [mango.id]: 'mango' };
    const levels: Record<Id, number> = { [zebra.id]: 1, [apple.id]: 3, [mango.id]: 2 };
    const sortKey: ScheduleCtx['sortKey'] = (card, sort) =>
      sort.by === 'field' ? levels[card.id] : words[card.id];
    const ctx = ctxOf(w, { sortKey });
    expect(ids(selectPractice(w.cards, { by: 'az' }, ctx))).toEqual([apple.id, mango.id, zebra.id]);
    expect(ids(selectPractice(w.cards, { by: 'az', dir: 'desc' }, ctx))).toEqual([zebra.id, mango.id, apple.id]);
    expect(ids(selectPractice(w.cards, { by: 'field', field: 'level' }, ctx))).toEqual([zebra.id, mango.id, apple.id]);
    expect(ids(selectPractice(w.cards, { by: 'az' }, ctxOf(w)))).toEqual([zebra.id, apple.id, mango.id]);
  });

  it('is capped by the session size and never repeats a card', () => {
    const w = new World();
    w.deck('d1');
    const cards = w.many('d1', 40, REVIEW_DUE);
    expect(selectPractice(cards, { by: 'due' }, ctxOf(w, { sessionLimit: 30 }))).toHaveLength(30);
    expect(selectPractice([...cards, ...cards], null, ctxOf(w))).toHaveLength(40);
  });

  it("a card with NO value (NO_SORT_KEY) stays last in both directions — dir 'desc' never puts it first", () => {
    const w = new World();
    w.deck('d1');
    const [b1, none, a2, c1] = w.many('d1', 4, REVIEW_DUE);
    const level: Record<Id, number> = { [b1.id]: 3, [none.id]: NO_SORT_KEY, [a2.id]: 2, [c1.id]: 5 };
    const ctx = ctxOf(w, { sortKey: (card) => level[card.id] });
    expect(ids(selectPractice(w.cards, { by: 'field', field: 'level' }, ctx))).toEqual([a2.id, b1.id, c1.id, none.id]);
    expect(ids(selectPractice(w.cards, { by: 'field', field: 'level', dir: 'desc' }, ctx))).toEqual([c1.id, b1.id, a2.id, none.id]);
    // Text keys: the same rule.
    const text: Record<Id, string | number> = { [b1.id]: 'b', [none.id]: NO_SORT_KEY, [a2.id]: 'a', [c1.id]: 'c' };
    const byText = ctxOf(w, { sortKey: (card) => text[card.id] });
    expect(ids(selectPractice(w.cards, { by: 'field', field: 'type' }, byText))).toEqual([a2.id, b1.id, c1.id, none.id]);
    expect(ids(selectPractice(w.cards, { by: 'field', field: 'type', dir: 'desc' }, byText))).toEqual([c1.id, b1.id, a2.id, none.id]);
  });
});

describe('the one sort rule (sortCards, compareSortKeys)', () => {
  it('compareSortKeys: text by code points (digits and "_" before letters, "~" after), numbers by value, numbers before text', () => {
    expect(['_x', '10 apples', '2 pears', 'apple', '~tilde'].sort(compareSortKeys)).toEqual(['10 apples', '2 pears', '_x', 'apple', '~tilde']);
    expect([10, 2, 'b', 1, 'a'].sort(compareSortKeys)).toEqual([1, 2, 10, 'a', 'b']);
    expect(compareSortKeys(NO_SORT_KEY, NO_SORT_KEY)).toBe(0);
  });

  it('sortCards is the order of selectPractice (the Library and Practice never disagree)', () => {
    const w = new World();
    w.deck('d1');
    const cards = w.many('d1', 5, REVIEW_DUE);
    const words = ['_x', '10 apples', '2 pears', 'apple', '~tilde'];
    const key = new Map(cards.map((c, i) => [c.id, words[i]]));
    const ctx = ctxOf(w, { sortKey: (card) => key.get(card.id) ?? '' });
    for (const sort of [{ by: 'az' }, { by: 'az', dir: 'desc' }, { by: 'due' }, { by: 'hardest' }] as const) {
      expect(ids(sortCards(w.cards, sort, ctx))).toEqual(ids(selectPractice(w.cards, sort, ctx)));
    }
    expect(sortCards(w.cards, { by: 'az' }, ctx).map((c) => key.get(c.id))).toEqual(['10 apples', '2 pears', '_x', 'apple', '~tilde']);
    // A new array: the input keeps its order.
    expect(ids(w.cards)).toEqual(ids(cards));
  });
});

/* ================================================================== unit P1: orderCards */

/** Every sort of the Library menu, both ways (a field sort with a number key and one with a text key). */
const ALL_SORTS: SortSpec[] = (['source', 'due', 'az', 'newest', 'hardest', 'field'] as const).flatMap((by) => [
  { by, ...(by === 'field' ? { field: 'level' } : {}) },
  { by, dir: 'desc' as const, ...(by === 'field' ? { field: 'level' } : {}) },
]);

/**
 * A random library for the sort: several decks (one paused, two with the
 * same order), cards out of deck order, siblings, equal keys, cards with no
 * field value, number and text keys, and the same due / ease / createdAt
 * on many cards (so the id must decide).
 */
function sortWorld(rnd: Random): { world: World; key: Map<Id, string | number>; level: Map<Id, number> } {
  const w = new World();
  w.deck('d0', { order: 1 });
  w.deck('d1', { order: 0 });
  w.deck('d2', { order: 1, active: false });
  const words = ['apfel', 'Apfel', 'birne', '10 x', '2 y', '_z', '~t', 'über', ''];
  const key = new Map<Id, string | number>();
  const level = new Map<Id, number>();
  const states = [NEW, LEARNING_DUE, REVIEW_DUE, REVIEW_LATER, MASTERED_DUE, KNOWN_LONG_AGO];
  const count = rnd.int(0, 60);
  for (let i = 0; i < count; i++) {
    const two = rnd.bool(0.4);
    const made = w.note(rnd.pick(['d0', 'd1', 'd2']), two ? [rnd.pick(states), rnd.pick(states)] : [rnd.pick(states)], {
      order: rnd.int(0, 8),
    });
    for (const card of made) {
      key.set(card.id, rnd.bool(0.1) ? rnd.int(0, 3) : rnd.pick(words));
      level.set(card.id, rnd.bool(0.2) ? NO_SORT_KEY : rnd.int(1, 4));
    }
  }
  // Some cards share due / ease / createdAt / lapses values; the order of the array is shuffled.
  w.cards = rnd
    .sample(w.cards, w.cards.length)
    .map((c) => ({ ...c, ease: rnd.pick([1.3, 2.5]), lapses: rnd.int(0, 2), createdAt: NOW - rnd.int(0, 3) * DAY }));
  return { world: w, key, level };
}

describe('unit P1 — orderCards gives EXACTLY the order of sortCards, with far fewer comparisons', () => {
  it('300 random libraries × every sort and direction (cards out of order, equal keys, no-value cards)', () => {
    let checked = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = createRandom(`order-${seed}`);
      const { world, key, level } = sortWorld(rnd);
      const ctx = ctxOf(world, {
        sortKey: (card, sort) => (sort.by === 'field' ? (level.get(card.id) ?? NO_SORT_KEY) : (key.get(card.id) ?? '')),
      });
      // The whole library, and a random part of it in a random order.
      const part = rnd.sample(world.cards, rnd.int(0, world.cards.length));
      for (const cards of [world.cards, part]) {
        for (const sort of ALL_SORTS) {
          expect([seed, sort, ids(orderCards(cards, sort, ctx))]).toEqual([seed, sort, ids(sortCards(cards, sort, ctx))]);
          checked += 1;
        }
      }
      // Without a key function A–Z and field sorts are the deck order (like cardComparator).
      expect(ids(orderCards(world.cards, { by: 'az' }, ctxOf(world)))).toEqual(ids(sortCards(world.cards, { by: 'az' }, ctxOf(world))));
    }
    expect(checked).toBe(300 * 2 * ALL_SORTS.length);
  });

  it('cards already in deck order need no sort: the positions are 0 … n − 1', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 50, NEW);
    expect(orderPositions(w.cards, { by: 'source' }, ctxOf(w))).toEqual(w.cards.map((_, i) => i));
    expect(orderCards(w.cards, { by: 'source' }, ctxOf(w))).not.toBe(w.cards); // a new array
  });

  it('two cards with the SAME id (damaged data): equal cards keep the input order, in both directions', () => {
    const w = new World();
    w.deck('d1');
    const [a] = w.note('d1', [NEW], { id: 'same', order: 1 });
    const twin = { ...a, fav: true }; // the same id, deck, position and ord
    const later = w.note('d1', [NEW], { order: 2 });
    const cards = [twin, ...later, a];
    const key = () => 'k'; // every key equal: only the deck order and the input order decide
    for (const sort of ALL_SORTS) {
      const ctx = ctxOf({ ...w, cards }, { sortKey: key });
      expect(orderCards(cards, sort, ctx)).toEqual(sortCards(cards, sort, ctx));
    }
  });

  it('a NaN in a number the comparator reads (damaged data): no real order, so sortCards itself decides', () => {
    const w = new World();
    w.deck('d1');
    const cards = w.many('d1', 6, REVIEW_DUE);
    const broken = cards.map((c, i) => (i === 2 ? { ...c, newPos: Number.NaN, due: Number.NaN } : c));
    const ctx = ctxOf({ ...w, cards: broken });
    expect(sortIsStrict(broken, { by: 'source' }, ctx)).toBe(false);
    expect(sortIsStrict(broken, { by: 'due' }, ctx)).toBe(false);
    expect(sortIsStrict(broken, { by: 'hardest' }, ctx)).toBe(true); // it reads ease and lapses only
    expect(orderPositions(broken, { by: 'source' }, ctx)).toBeNull();
    for (const sort of ALL_SORTS) expect(orderCards(broken, sort, ctx)).toEqual(sortCards(broken, sort, ctx));
    // A deck order that is not a number, and an id that is not text.
    const badDeck = ctxOf({ ...w, decks: [{ ...w.decks[0], order: Number.NaN }] });
    expect(sortIsStrict(cards, { by: 'source' }, badDeck)).toBe(false);
    expect(sortIsStrict([{ ...cards[0], id: 7 as unknown as Id }], { by: 'due' }, ctxOf(w))).toBe(false);
  });

  it('unit P2: the column sort (numbers read once into typed arrays) gives sortCards\' order on odd values too — ∞, −∞, −0, text numbers, null, odd deck orders, a card of a missing deck, one id twice', () => {
    const odd = <T>(value: unknown) => value as T;
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = createRandom(`p2-columns-${seed}`);
      const w = new World();
      // Deck orders the comparator subtracts: a number, ∞ twice, −∞, null (→ MAX_SAFE_INTEGER), text that is a number.
      w.deck('d0', { order: 2 });
      w.deck('d1', { order: odd<number>(Number.POSITIVE_INFINITY) });
      w.deck('d2', { order: odd<number>(Number.POSITIVE_INFINITY) });
      w.deck('d3', { order: odd<number>(Number.NEGATIVE_INFINITY) });
      w.deck('d4', { order: odd<number>(null) });
      w.deck('d5', { order: odd<number>('1') });
      const deckIds = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'gone']; // 'gone': a card whose deck does not exist
      const numbers: unknown[] = [0, -0, 1, 2.5, -3, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '7', null, true];
      const count = rnd.int(0, 50);
      for (let i = 0; i < count; i++) w.note(rnd.pick(deckIds), rnd.bool(0.4) ? [REVIEW_DUE, NEW] : [REVIEW_DUE], { order: rnd.int(0, 6) });
      w.cards = rnd.sample(w.cards, w.cards.length).map((c) => ({
        ...c,
        due: odd<number>(rnd.pick(numbers)),
        createdAt: odd<number>(rnd.pick(numbers)),
        ease: odd<number>(rnd.pick(numbers)),
        lapses: odd<number>(rnd.pick(numbers)),
        newPos: odd<number>(rnd.pick(numbers)),
        ord: odd<number>(rnd.bool(0.8) ? c.ord : rnd.pick(numbers)),
      }));
      // Sometimes a card twice (one id: damaged data): equal cards keep the input order.
      if (w.cards.length > 2 && rnd.bool(0.3)) w.cards.splice(rnd.int(0, w.cards.length), 0, { ...rnd.pick(w.cards) });
      const ctx = ctxOf(w);
      for (const sort of ALL_SORTS) {
        expect([seed, sort, ids(orderCards(w.cards, sort, ctx))]).toEqual([seed, sort, ids(sortCards(w.cards, sort, ctx))]);
        const at = orderPositions(w.cards, sort, ctx);
        expect([seed, sort, at === null]).toEqual([seed, sort, !sortIsStrict(w.cards, sort, ctx)]);
        if (at) expect([seed, sort, at.map((i) => w.cards[i])]).toEqual([seed, sort, sortCards(w.cards, sort, ctx)]);
        checked += 1;
      }
    }
    expect(checked).toBe(200 * ALL_SORTS.length);
  });

  it('sortFieldsOf: the card keys each comparator reads (scope.ts reuses an order while they stay the same)', () => {
    expect(sortFieldsOf({ by: 'source' })).toEqual(['id', 'deckId', 'newPos', 'ord']);
    expect(sortFieldsOf({ by: 'az' })).toEqual(['id', 'deckId', 'newPos', 'ord', 'noteId']);
    expect(sortFieldsOf({ by: 'field' })).toEqual(['id', 'deckId', 'newPos', 'ord', 'noteId']);
    // Final pass: 'reps' and 'knownAt' decide the two groups of "Due date" (a review date or none).
    expect(sortFieldsOf({ by: 'due' })).toEqual(['id', 'due', 'reps', 'knownAt']);
    expect(sortFieldsOf({ by: 'newest' })).toEqual(['id', 'createdAt']);
    expect(sortFieldsOf({ by: 'hardest' })).toEqual(['id', 'ease', 'lapses']);
  });
});

/* ================================================================== unit P4 review: sourceOrderJob */

/** Run a sourceOrderJob to its end; how many calls it needed and how often stop() was asked. */
function runOrderJob(cards: readonly Card[], ctx: ScheduleCtx, stop: () => boolean): { step: SourceOrderStep; calls: number } {
  const next = sourceOrderJob(cards, ctx);
  let calls = 0;
  for (;;) {
    calls += 1;
    const step = next(stop);
    if (step.done) return { step, calls };
  }
}

/** `n` light cards in `decks` (only what the Deck order reads), in a seeded random order or in Deck order. */
function bigDeckWorld(n: number, rnd: Random | null): { cards: Card[]; ctx: ScheduleCtx } {
  const w = new World();
  for (let d = 0; d < 6; d++) w.deck(`d${d}`, { order: d });
  w.many('d0', 1, NEW);
  const proto = w.cards[0];
  const cards: Card[] = [];
  for (let i = 0; i < n; i++) {
    cards.push({ ...proto, id: `c${String(i).padStart(6, '0')}`, deckId: `d${Math.floor((i * 6) / n)}`, newPos: i, ord: i % 2 });
  }
  return { cards: rnd ? rnd.sample(cards, cards.length) : cards, ctx: ctxOf({ ...w, cards }) };
}

describe('unit P4 review — sourceOrderJob makes the Deck order a part at a time: EXACTLY orderPositions', () => {
  it('300 random libraries (cards out of order, one id twice) and 200 with odd values: the same positions, in one call or in many', () => {
    let merged = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = createRandom(`p4r-job-${seed}`);
      const { world } = sortWorld(rnd);
      if (world.cards.length > 2 && rnd.bool(0.2)) world.cards.splice(rnd.int(0, world.cards.length), 0, { ...rnd.pick(world.cards) });
      // Sometimes in Deck order already (the usual case), sometimes a few cards moved to the end.
      if (rnd.bool(0.3)) world.cards = sortCards(world.cards, { by: 'source' }, ctxOf(world));
      if (rnd.bool(0.2) && world.cards.length > 3) world.cards = [...world.cards.slice(3), ...world.cards.slice(0, 3)];
      const ctx = ctxOf(world);
      const expected = orderPositions(world.cards, { by: 'source' }, ctx);
      for (const stop of [() => false, () => true, () => rnd.bool(0.5)]) {
        const { step } = runOrderJob(world.cards, ctx, stop);
        expect(step.done && [seed, step.positions]).toEqual([seed, expected]);
        expect(step.done && step.inOrder).toBe(expected !== null && expected.every((p, i) => p === i));
        if (step.done && !step.inOrder) merged += 1;
      }
    }
    expect(merged).toBeGreaterThan(300);
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = createRandom(`p4r-job-odd-${seed}`);
      const odd = <T>(value: unknown) => value as T;
      const w = new World();
      w.deck('d0', { order: 2 });
      w.deck('d1', { order: odd<number>(Number.POSITIVE_INFINITY) });
      w.deck('d2', { order: odd<number>(null) });
      w.deck('d3', { order: odd<number>(rnd.bool(0.1) ? Number.NaN : '1') });
      const numbers: unknown[] = [0, -0, 1, 2.5, -3, Number.POSITIVE_INFINITY, '7', null, rnd.bool(0.05) ? Number.NaN : 4];
      for (let i = rnd.int(0, 40); i > 0; i--) w.note(rnd.pick(['d0', 'd1', 'd2', 'd3', 'gone']), [REVIEW_DUE], { order: rnd.int(0, 6) });
      w.cards = rnd.sample(w.cards, w.cards.length).map((c) => ({ ...c, newPos: odd<number>(rnd.pick(numbers)) }));
      const ctx = ctxOf(w);
      const { step } = runOrderJob(w.cards, ctx, () => rnd.bool(0.5));
      expect(step.done && [seed, step.positions]).toEqual([seed, orderPositions(w.cards, { by: 'source' }, ctx)]);
    }
  });

  it('20,000 cards out of order: stop() is asked after every 1,024 steps, and a yes ends the call at once', () => {
    const { cards, ctx } = bigDeckWorld(20_000, createRandom('p4r-job-big'));
    let asked = 0;
    const { step, calls } = runOrderJob(cards, ctx, () => {
      asked += 1;
      return true;
    });
    expect(step.done && step.positions).toEqual(orderPositions(cards, { by: 'source' }, ctx));
    // Every call but the last ended at its first yes: one question per call.
    expect(asked).toBe(calls - 1);
    // The columns are one step; then about 20,000 comparisons to find the runs and ~15 merge passes.
    expect(ORDER_STEPS_PER_STOP).toBe(1024);
    expect(calls).toBeGreaterThan(Math.floor((20_000 * 10) / ORDER_STEPS_PER_STOP));
    // With no yes, the same order in one call; after the end, the same result at once.
    const once = sourceOrderJob(cards, ctx);
    const all = once(() => false);
    expect(all).toEqual(step);
    expect(once(() => true)).toBe(all);
  });

  it('20,000 cards in Deck order: no merge — the columns, one pass (about 20 questions), positions 0 … n − 1', () => {
    const { cards, ctx } = bigDeckWorld(20_000, null);
    let asked = 0;
    const { step, calls } = runOrderJob(cards, ctx, () => {
      asked += 1;
      return false;
    });
    expect(calls).toBe(1);
    expect(asked).toBe(1 + Math.floor((20_000 - 1) / ORDER_STEPS_PER_STOP));
    expect(step).toEqual({ done: true, positions: cards.map((_, i) => i), inOrder: true });
  });

  it('no strict order (a NaN position): null, like orderPositions; an empty library: no positions, in order', () => {
    const w = new World();
    w.deck('d1');
    const cards = w.many('d1', 5, NEW).map((c, i) => (i === 2 ? { ...c, newPos: Number.NaN } : c));
    expect(runOrderJob(cards, ctxOf(w), () => true).step).toEqual({ done: true, positions: null, inOrder: false });
    expect(orderPositions(cards, { by: 'source' }, ctxOf(w))).toBeNull();
    expect(runOrderJob([], ctxOf(w), () => true).step).toEqual({ done: true, positions: [], inOrder: true });
  });
});

/* ================================================================== unit P1 review 2: repairPositions */

describe('unit P1 review 2 — repairPositions places only the changed cards again: EXACTLY the new order', () => {
  /**
   * New values for the card at position `i`, in every field some sort reads
   * (never the id: the ids stay unique). Its A–Z and field keys may change too.
   * Final pass: `reps` (0 or more) and `knownAt` (null or set) change too, so
   * a card can move between the two groups of "Due date" (a review date or
   * none) — also with its `due` unchanged ("I know it" changes only knownAt).
   */
  function change(rnd: Random, card: Card, key: Map<Id, string | number>, level: Map<Id, number>, decks: readonly Deck[]): Card {
    if (rnd.bool(0.3)) key.set(card.id, rnd.pick(['apfel', 'Zebra', '0', 'mitte', '']));
    if (rnd.bool(0.3)) level.set(card.id, rnd.bool(0.2) ? NO_SORT_KEY : rnd.int(1, 4));
    return {
      ...card,
      due: rnd.bool(0.7) ? NOW + rnd.int(-5, 30) * DAY : card.due,
      ease: rnd.bool(0.5) ? rnd.pick([1.3, 1.9, 2.5]) : card.ease,
      lapses: rnd.bool(0.3) ? rnd.int(0, 4) : card.lapses,
      createdAt: rnd.bool(0.2) ? NOW - rnd.int(0, 3) * DAY : card.createdAt,
      newPos: rnd.bool(0.2) ? rnd.int(-3, 40) : card.newPos,
      deckId: rnd.bool(0.1) ? rnd.pick(decks).id : card.deckId,
      reps: rnd.bool(0.3) ? (rnd.bool(0.5) ? 0 : rnd.int(1, 9)) : card.reps,
      knownAt: rnd.bool(0.3) ? (rnd.bool(0.5) ? null : NOW) : card.knownAt,
    };
  }

  it('300 random libraries × a random sort: from no card to every card changed, repaired === sorted again', () => {
    let repaired = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = createRandom(`repair-${seed}`);
      const { world, key, level } = sortWorld(rnd);
      const keyFn: ScheduleCtx['sortKey'] = (card, sort) =>
        sort.by === 'field' ? (level.get(card.id) ?? NO_SORT_KEY) : (key.get(card.id) ?? '');
      const sort = rnd.pick(ALL_SORTS);
      const before = world.cards;
      const kept = orderPositions(before, sort, ctxOf(world, { sortKey: keyFn }));
      if (!kept) continue;
      // k cards change (0 … all of them), each at its own position.
      const changed = rnd.sample(before.map((_, i) => i), rnd.int(0, before.length));
      const after = [...before];
      for (const i of changed) after[i] = change(rnd, before[i], key, level, world.decks);
      const ctx = ctxOf({ ...world, cards: after }, { sortKey: keyFn });
      const fresh = orderPositions(after, sort, ctx);
      if (!fresh) continue;
      expect([seed, sort, repairPositions(after, kept, changed, sort, ctx)]).toEqual([seed, sort, fresh]);
      repaired += 1;
    }
    expect(repaired).toBeGreaterThan(250);
  });

  it('one rating in a sorted list: only that card moves; no change keeps the order; an empty list', () => {
    const w = new World();
    w.deck('d1');
    const cards = w.many('d1', 40, REVIEW_DUE).map((c, i) => ({ ...c, due: NOW + (i % 7) * DAY, ease: 1.3 + (i % 5) * 0.3 }));
    const ctx = ctxOf({ ...w, cards });
    for (const sort of [{ by: 'due' }, { by: 'hardest' }, { by: 'due', dir: 'desc' }] as SortSpec[]) {
      const kept = orderPositions(cards, sort, ctx)!;
      expect(repairPositions(cards, kept, [], sort, ctx)).toEqual(kept);
      // A rating: card 10 is due much later and is easier now.
      const rated = cards.map((c, i) => (i === 10 ? { ...c, due: NOW + 99 * DAY, ease: 2.9 } : c));
      const rctx = ctxOf({ ...w, cards: rated });
      const out = repairPositions(rated, kept, [10], sort, rctx);
      expect(out).toEqual(orderPositions(rated, sort, rctx));
      expect(ids(out.map((i) => rated[i]))).toEqual(ids(sortCards(rated, sort, rctx)));
      // Every other card keeps its order.
      expect(out.filter((i) => i !== 10)).toEqual(kept.filter((i) => i !== 10));
    }
    expect(repairPositions([], [], [], { by: 'due' }, ctxOf(new World()))).toEqual([]);
  });

  it('orderCards for Due date, Recently added and Hardest first IS sortCards (also with a NaN: the same rule)', () => {
    const w = new World();
    w.deck('d1');
    const cards = w.many('d1', 30, REVIEW_DUE).map((c, i) => ({ ...c, due: i === 4 ? Number.NaN : NOW + (i % 3) * DAY }));
    const ctx = ctxOf({ ...w, cards });
    for (const by of ['due', 'newest', 'hardest'] as const) {
      for (const dir of ['asc', 'desc'] as const) expect(ids(orderCards(cards, { by, dir }, ctx))).toEqual(ids(sortCards(cards, { by, dir }, ctx)));
    }
  });
});

/* ================================================================== final pass: "Due date" */

describe('final pass — "Due date": cards with a review date first (soonest first), New / Not started / Known after them, in both directions', () => {
  /**
   * The device case: a New card's `due` is the time it was made or
   * imported, so by `due` alone a whole imported library of New cards came
   * BEFORE the Learning card that is due now. Every card here has another
   * due time, so only the rule decides (no tie on the id).
   */
  function dueWorld() {
    const w = new World();
    w.deck('d1');
    const [fresh] = w.note('d1', [{ createdAt: NOW - 7 * DAY, due: NOW - 7 * DAY }], { id: 'fresh' });
    const [review] = w.note('d1', [{ ...REVIEW_LATER, due: NOW + 3 * DAY }], { id: 'review' });
    const [known] = w.note('d1', [{ ...REVIEW_DUE, due: NOW - 30 * DAY, knownAt: NOW - 2 * DAY }], { id: 'known' });
    const [learning] = w.note('d1', [{ ...LEARNING_DUE, due: NOW }], { id: 'learning' });
    const [notStarted] = w.note('d1', [{ ...NOT_STARTED, createdAt: NOW - 5 * DAY, due: NOW - 5 * DAY }], { id: 'notStarted' });
    return { w, fresh, review, known, learning, notStarted };
  }
  const ASC: SortSpec = { by: 'due' };
  const DESC: SortSpec = { by: 'due', dir: 'desc' };

  it('asc: learning, review, then the no-date cards by due; desc: review, learning, then the no-date cards by due, latest first', () => {
    const d = dueWorld();
    expect([d.fresh, d.review, d.known, d.learning, d.notStarted].map(life)).toEqual(['new', 'review', 'known', 'learning', 'notStarted']);
    const ctx = ctxOf(d.w);
    const asc = [d.learning.id, d.review.id, d.known.id, d.fresh.id, d.notStarted.id];
    const desc = [d.review.id, d.learning.id, d.notStarted.id, d.fresh.id, d.known.id];
    // Every input order gives the same result (the store's order, reversed, and shuffled).
    const inputs = [d.w.cards, [...d.w.cards].reverse(), createRandom('due-groups').sample(d.w.cards, d.w.cards.length)];
    for (const cards of inputs) {
      expect(ids(sortCards(cards, ASC, ctx))).toEqual(asc);
      expect(ids(orderCards(cards, ASC, ctx))).toEqual(asc);
      expect(orderPositions(cards, ASC, ctx)!.map((i) => cards[i].id)).toEqual(asc);
      expect(ids(sortCards(cards, DESC, ctx))).toEqual(desc);
      expect(ids(orderCards(cards, DESC, ctx))).toEqual(desc);
      expect(orderPositions(cards, DESC, ctx)!.map((i) => cards[i].id)).toEqual(desc);
    }
    // The old rule (due alone) put the Known and New cards first: this order is the intended change.
    expect(ids([...d.w.cards].sort((a, b) => a.due - b.due))).toEqual([d.known.id, d.fresh.id, d.notStarted.id, d.learning.id, d.review.id]);
    // Practice sorted by due date uses the same rule (the Library and Practice never disagree).
    const all = ctxOf(d.w, { scope: { life: ['known', 'notStarted'] } });
    expect(ids(selectPractice(d.w.cards, ASC, all))).toEqual(asc);
    expect(ids(selectPractice(d.w.cards, DESC, all))).toEqual(desc);
  });

  it('a card with no knownAt key or knownAt null is a strict order (sortIsStrict); the scheduler\'s queues are not touched', () => {
    const d = dueWorld();
    const ctx = ctxOf(d.w);
    expect(d.fresh.knownAt).toBeUndefined(); // makeCard leaves the key out
    const withNull = d.w.cards.map((c) => (c.knownAt == null ? { ...c, knownAt: null } : c));
    expect(sortIsStrict(d.w.cards, ASC, ctx)).toBe(true);
    expect(sortIsStrict(withNull, ASC, ctx)).toBe(true);
    expect(ids(orderCards(withNull, ASC, ctx))).toEqual(ids(sortCards(d.w.cards, ASC, ctx)));
    // Study ahead still takes only future reviews, soonest first (byDue, unchanged).
    expect(ids(selectAhead(d.w.cards, ctx))).toEqual([d.review.id]);
    // Study: the learning card that is due now, then the new card; never Not started or Known (by due).
    const queue = planQueue(selectScheduled(studyPool(d.w, ctx), ctx));
    expect(ids(queue)).toEqual([d.learning.id, d.fresh.id]);
  });

  it('repairPositions after a first rating of the New card and after "I know it" on the Review card === orderPositions of the new cards', () => {
    const d = dueWorld();
    const before = d.w.cards;
    const at = (id: Id) => before.findIndex((c) => c.id === id);
    const steps: [string, number, (c: Card) => Card][] = [
      // A first rating: reps 0 → 1, in learning, due in 10 minutes. It moves INTO the review-date group.
      ['first rating', at(d.fresh.id), (c) => ({ ...c, reps: 1, stepIndex: 0, due: NOW + 10 * MIN, lastReviewedAt: NOW })],
      // "I know it": ONLY knownAt changes (the due stays). It moves OUT of the review-date group.
      ['I know it', at(d.review.id), (c) => ({ ...c, knownAt: NOW })],
    ];
    for (const sort of [ASC, DESC]) {
      for (const [label, i, edit] of steps) {
        const kept = orderPositions(before, sort, ctxOf(d.w))!;
        const after = before.map((c, k) => (k === i ? edit(c) : c));
        const actx = ctxOf({ ...d.w, cards: after });
        // scope.ts repairs only when a field of sortFieldsOf changed: it must see this change.
        expect([label, sortFieldsOf(sort).some((f) => before[i][f] !== after[i][f])]).toEqual([label, true]);
        const repaired = repairPositions(after, kept, [i], sort, actx);
        expect([label, sort, repaired]).toEqual([label, sort, orderPositions(after, sort, actx)]);
        expect([label, sort, repaired.map((k) => after[k].id)]).toEqual([label, sort, ids(sortCards(after, sort, actx))]);
        // The card really moved to the other group (else this step would test nothing).
        expect([label, sort, repaired]).not.toEqual([label, sort, kept]);
      }
    }
    // The rated card now comes right after the learning card (asc): due in 10 minutes.
    const rated = before.map((c) => (c.id === d.fresh.id ? { ...c, reps: 1, stepIndex: 0, due: NOW + 10 * MIN } : c));
    expect(ids(orderCards(rated, ASC, ctxOf({ ...d.w, cards: rated })))).toEqual([d.learning.id, d.fresh.id, d.review.id, d.known.id, d.notStarted.id]);
  });
});

describe("selectScheduledWithDue — the deck row's \"{n} due\"", () => {
  it('counts the due learning cards and due reviews of the run, BEFORE the daily review limit and the session size', () => {
    const w = new World();
    w.deck('d1');
    w.many('d1', 3, LEARNING_DUE, 'l');
    w.many('d1', 6, REVIEW_DUE, 'r');
    w.many('d1', 2, NEW, 'n');
    w.many('d1', 2, REVIEW_LATER, 'later');
    const ctx = ctxOf(w, { srs: { dailyReviewLimit: 4 }, sessionLimit: 5 });
    const out = selectScheduledWithDue(studyPool(w, ctx), ctx);
    expect(out.dueNow).toBe(9);
    expect(out.selection).toEqual(selectScheduled(studyPool(w, ctx), ctx)); // the same run
    expect(readyCounts(out.selection).total).toBe(5);
    // No limit and no session size: dueNow is exactly what Study shows as due.
    const open = ctxOf(w, { srs: { dailyReviewLimit: NO_REVIEW_LIMIT } });
    const all = selectScheduledWithDue(studyPool(w, open), open);
    expect(all.dueNow).toBe(readyCounts(all.selection).learning + readyCounts(all.selection).due);
  });

  it('never counts a card that Study cannot show: a broken due (null), or a review whose sibling waits', () => {
    const w = new World();
    w.deck('d1');
    // A learning card whose due is null (damaged data): `null <= now` is true in JavaScript.
    const [broken] = w.note('d1', [{ ...LEARNING_DUE, due: null as unknown as number }]);
    // Both directions of one item are due: Study shows one today, the other waits.
    w.note('d1', [REVIEW_DUE, { ...REVIEW_DUE, due: NOW - 2 * HOUR }], { id: 'twins' });
    const ctx = ctxOf(w);
    const out = selectScheduledWithDue(studyPool(w, ctx), ctx);
    expect(isDueNowCount(w.cards)).toBe(3); // what a count with life.ts isDueNow would say
    expect(out.dueNow).toBe(1);
    expect(ids(planQueue(out.selection))).toEqual(['twins-c1']);
    expect(ids(planQueue(out.selection))).not.toContain(broken.id);
  });
});

/** How many cards life.ts `isDueNow` calls due (the old count of the deck rows). */
function isDueNowCount(cards: readonly Card[]): number {
  return cards.filter((c) => isDueNow(c, NOW)).length;
}

/* ================================================================== property test */

/** One random library: decks, notes (1 or 2 cards each), cards in every state. */
function randomWorld(rnd: Random, tag: string): World {
  const w = new World();
  const deckCount = rnd.int(1, 4);
  const orders = rnd.shuffle(Array.from({ length: deckCount }, (_, i) => i));
  for (let d = 0; d < deckCount; d++) {
    w.deck(`${tag}d${d}`, {
      order: rnd.bool(0.2) ? 0 : orders[d], // sometimes two decks share an order
      active: rnd.bool(0.75),
      options: {
        newPerDay: rnd.pick([null, null, 0, 1, 2, 3, 5, 10]),
        newOrder: rnd.bool(0.3) ? 'random' : 'source',
        knownChecks: rnd.bool(0.7),
        ...(rnd.bool(0.25) ? { directions: { 'nt-basic-reverse': [rnd.pick([0, 1])] } } : {}),
      },
    });
  }
  const dayStart = startOfLocalDay(NOW);
  const noteCount = rnd.int(0, 60);
  for (let n = 0; n < noteCount; n++) {
    const deck = rnd.pick(w.decks);
    const cardCount = rnd.bool(0.45) ? 2 : 1;
    const states: State[] = [];
    const cardIds: Id[] = [];
    for (let k = 0; k < cardCount; k++) {
      const kind = rnd.pick([
        'notStarted', 'new', 'new', 'learning', 'review', 'review', 'mastered', 'known', 'known',
      ] as const);
      const due = rnd.bool(0.6) ? NOW - rnd.int(0, 20) * HOUR : NOW + rnd.int(1, 300) * HOUR;
      const lastReviewedAt = rnd.bool(0.2) ? dayStart + rnd.int(0, 8) * HOUR : NOW - rnd.int(1, 40) * DAY;
      let state: State = NEW;
      switch (kind) {
        case 'notStarted':
          state = NOT_STARTED;
          break;
        case 'new':
          state = rnd.bool(0.5) ? { newState: 'queued' } : NEW;
          break;
        case 'learning':
          state = { reps: rnd.int(1, 5), stepIndex: rnd.int(0, 1), intervalDays: 0, due, lastReviewedAt };
          break;
        case 'review':
        case 'mastered':
          state = {
            reps: rnd.int(2, 12),
            stepIndex: null,
            intervalDays: kind === 'review' ? rnd.int(1, 20) : rnd.int(21, 200),
            due,
            lastReviewedAt,
          };
          break;
        case 'known':
          // Half of the Known cards get an id inside the 10% Check sample, so Checks are common here.
          if (rnd.bool(0.5)) cardIds[k] = idsWithSample(`${tag}n${n}-c${k}`, 1, true)[0];
          state = {
            ...(rnd.bool(0.4) ? { reps: 3, stepIndex: null, intervalDays: 9, due, lastReviewedAt } : {}),
            knownAt: NOW - rnd.int(0, 120) * DAY - rnd.int(0, 23) * HOUR,
            knownCheckedAt: rnd.bool(0.2) ? NOW - rnd.int(1, 30) * DAY : null,
          };
          break;
      }
      states.push({
        ...state,
        suspended: rnd.bool(0.08),
        buriedUntil: rnd.bool(0.08) ? NOW + rnd.int(1, 20) * HOUR : rnd.bool(0.05) ? NOW - HOUR : null,
        ease: 1.3 + rnd.int(0, 15) / 10,
        lapses: rnd.int(0, 9),
      });
      cardIds[k] ??= `${tag}n${n}-c${k}`;
    }
    w.note(deck.id, states, { id: `${tag}n${n}`, order: rnd.int(0, 30), cardIds });
  }
  return w;
}

function randomOptions(rnd: Random, w: World): CtxOptions {
  const newByDeck: Record<Id, number> = {};
  for (const d of w.decks) if (rnd.bool(0.4)) newByDeck[d.id] = rnd.int(0, 4);
  return {
    srs: {
      dailyNewLimit: rnd.pick([0, 1, 3, 5, 10, 20]),
      dailyReviewLimit: rnd.pick([10, 12, 20, 50, NO_REVIEW_LIMIT]),
    },
    sessionLimit: rnd.pick([0, 0, 3, 5, 8, 15, 30]),
    knownChecksPerDay: rnd.pick([0, 1, 2, 5]),
    spaceSiblings: rnd.bool(0.7),
    done: {
      dayKey: rnd.bool(0.15) ? addDays(TODAY, -1) : TODAY,
      reviews: rnd.int(0, 15),
      neww: rnd.int(0, 6),
      checks: rnd.int(0, 3),
      newByDeck,
    },
  };
}

type ScopeKind = 'all' | 'deck' | 'subset';

/** A Study pool like scope.ts builds it, for three kinds of scope. */
function scopedPool(w: World, ctx: ScheduleCtx, kind: ScopeKind, rnd: Random): { pool: Card[]; explicit: Set<Id> } {
  if (kind === 'deck') {
    const deck = rnd.pick(w.decks);
    const explicit = new Set([deck.id]); // a deck page names its deck: paused or not
    return { pool: w.cards.filter((c) => c.deckId === deck.id && studyEligible(c, ctx, explicit)), explicit };
  }
  if (kind === 'subset') {
    // Like a tag or Level filter: about half of the notes, no deck named.
    const salt = rnd.id('salt');
    return {
      pool: w.cards.filter((c) => fnv1a(c.noteId + salt) % 2 === 0 && studyEligible(c, ctx, NONE)),
      explicit: new Set(),
    };
  }
  return { pool: w.cards.filter((c) => studyEligible(c, ctx, NONE)), explicit: new Set() };
}

/** `remaining` as the spec writes it: max(0, limit − used). */
const left = (limit: number, used: number) => Math.max(0, limit - used);

/** Brute force: was ANOTHER card of c's note, one that is not in learning, studied today? */
function siblingStudiedToday(c: Card, ctx: ScheduleCtx): boolean {
  const dayStart = startOfLocalDay(ctx.now);
  return (ctx.lookup.cardIdsByNote.get(c.noteId) ?? []).some((id) => {
    const s = ctx.lookup.cardById.get(id);
    if (!s || s.id === c.id || life(s) === 'learning') return false;
    return s.lastReviewedAt != null && s.lastReviewedAt >= dayStart;
  });
}

/**
 * Brute force of the review-sibling rule: by due (then id), drop a card whose
 * sibling was studied today (only with spaceSiblings on), then keep the first
 * card of each note.
 */
function reviewSiblingRule(cards: Card[], ctx: ScheduleCtx): Card[] {
  const sorted = [...cards].sort((a, b) => a.due - b.due || (a.id < b.id ? -1 : 1));
  const notToday = sorted.filter((c) => !(ctx.settings.spaceSiblings && siblingStudiedToday(c, ctx)));
  const notes = new Set<Id>();
  return notToday.filter((c) => !notes.has(c.noteId) && notes.add(c.noteId));
}

/**
 * Brute force: the bucket sizes BEFORE the session cut, written as plainly as
 * possible (no round robin). Used to check that the scheduler fills every
 * bucket as far as the caps allow.
 */
function expectedUncut(pool: Card[], ctx: ScheduleCtx) {
  const now = ctx.now;
  const today = dayKeyOf(now);
  const done = ctx.done.dayKey === today ? ctx.done : { reviews: 0, neww: 0, checks: 0, newByDeck: {} as Record<Id, number> };
  const unique = [...new Map(pool.map((c) => [c.id, c])).values()];

  const learn = unique.filter((c) => life(c) === 'learning' && c.due <= now);
  const dueReviews = unique.filter((c) => (life(c) === 'review' || life(c) === 'mastered') && c.due <= now);
  const onePerNote = reviewSiblingRule(dueReviews, ctx);
  const reviews = onePerNote.slice(0, left(ctx.settings.srs.dailyReviewLimit, done.reviews));
  const checkCandidates = unique.filter((c) => {
    const deck = ctx.decks.get(c.deckId);
    return (
      c.knownAt != null &&
      c.knownCheckedAt == null &&
      deck?.options.knownChecks === true &&
      fnv1a(c.id) % 10 === 0 &&
      c.knownAt + (21 + (Math.floor(fnv1a(c.id) / 10) % 70)) * DAY <= now
    );
  });
  const dayStart = startOfLocalDay(now);
  // Is another card of c's note studied today, or in learning now (and able to come back)?
  const siblingBusy = (c: Card): boolean =>
    (ctx.lookup.cardIdsByNote.get(c.noteId) ?? []).some((id) => {
      const s = ctx.lookup.cardById.get(id);
      if (!s || s.id === c.id) return false;
      if (s.lastReviewedAt != null && s.lastReviewedAt >= dayStart) return true;
      if (life(s) !== 'learning' || s.suspended) return false;
      const deck = ctx.decks.get(s.deckId);
      const ords = deck?.options.directions?.[ctx.typeIdOf(s) ?? ''];
      return deck !== undefined && (ords === undefined || ords.includes(s.ord));
    });

  // The check-sibling rule, written plainly: in Check order, a Check waits when its note
  // already has a card in learn, in reviews or in an earlier Check; with spacing on, also
  // when a sibling is busy (studied today or in learning). Then the daily cap.
  const runNotes = new Set([...learn, ...reviews].map((c) => c.noteId));
  const allowedChecks = [...checkCandidates]
    .sort((a, b) => checkReadyAt(a) - checkReadyAt(b) || (a.id < b.id ? -1 : 1))
    .filter((c) => {
      if (runNotes.has(c.noteId)) return false;
      if (ctx.settings.spaceSiblings && siblingBusy(c)) return false;
      runNotes.add(c.noteId);
      return true;
    });
  const pickedChecks = allowedChecks.slice(0, left(ctx.settings.knownChecksPerDay, done.checks));
  const checks = pickedChecks.length;

  const picked = new Set([...learn, ...reviews, ...pickedChecks].map((c) => c.noteId));
  const blocked = (c: Card): boolean => ctx.settings.spaceSiblings && (picked.has(c.noteId) || siblingBusy(c));
  // Per deck: how many new cards it could give (distinct notes when siblings are spaced).
  const possible = new Map<Id, number>();
  for (const deck of ctx.decks.values()) {
    const cands = unique.filter((c) => c.deckId === deck.id && life(c) === 'new' && !blocked(c));
    const avail = ctx.settings.spaceSiblings ? new Set(cands.map((c) => c.noteId)).size : cands.length;
    const cap = deck.options.newPerDay == null ? Infinity : left(deck.options.newPerDay, done.newByDeck[deck.id] ?? 0);
    if (avail > 0) possible.set(deck.id, Math.min(avail, cap));
  }
  const sumPossible = [...possible.values()].reduce((a, b) => a + b, 0);
  const fresh = Math.min(left(ctx.settings.srs.dailyNewLimit, done.neww), sumPossible);
  // Did a sibling rule hold a card back in this run? (Only to prove the generator reaches the rule.)
  const siblingWaited =
    onePerNote.length < dueReviews.length ||
    unique.some((c) => life(c) === 'new' && ctx.settings.spaceSiblings && blocked(c));
  // Did a due review wait because a sibling was studied today? (Same reason: to prove the generator reaches it.)
  const reviewWaitedForToday =
    ctx.settings.spaceSiblings && dueReviews.some((c) => siblingStudiedToday(c, ctx));
  // Did a ready Check wait for a sibling? (Same reason.)
  const checkWaited = allowedChecks.length < checkCandidates.length;
  return {
    learn: learn.length,
    reviews,
    checks,
    fresh,
    possible,
    done,
    siblingWaited,
    reviewWaitedForToday,
    checkWaited,
    siblingBusy,
  };
}

describe('property: 300 seeded random states × 3 scope kinds', () => {
  const STATES = 300;
  const KINDS: ScopeKind[] = ['all', 'deck', 'subset'];

  it('no duplicate, no ineligible card, every cap, total === queue length, buckets as full as allowed', () => {
    let nonEmpty = 0;
    let cappedRuns = 0;
    let withChecks = 0;
    let freshFromTwoDecks = 0;
    let siblingWaited = 0;
    let reviewWaitedForToday = 0;
    let checkWaited = 0;
    for (let i = 0; i < STATES; i++) {
      const seed = `schedule-${i}`;
      const rnd = createRandom(seed);
      const w = randomWorld(rnd.fork('world'), `s${i}`);
      const ctx = ctxOf(w, randomOptions(rnd.fork('options'), w));
      for (const kind of KINDS) {
        const { pool, explicit } = scopedPool(w, ctx, kind, rnd.fork(kind));
        const where = `seed ${seed}, scope ${kind}`;
        const sel = selectScheduled(pool, ctx);
        const queue = planQueue(sel);
        const rc = readyCounts(sel);

        // Launch count === queue length (and the parts add up).
        expect({ where, total: rc.total }).toEqual({ where, total: queue.length });
        expect(rc.learning + rc.due + rc.checks + rc.neww).toBe(rc.total);
        expect(rc.mins).toBe(minutesFor(rc.total));
        expect(rc.capped).toBe(rc.total < rc.uncappedTotal);
        if (queue.length > 0) nonEmpty += 1;
        if (rc.capped) cappedRuns += 1;
        if (sel.checks.length > 0) withChecks += 1;
        if (new Set(sel.fresh.map((c) => c.deckId)).size >= 2) freshFromTwoDecks += 1;

        // No duplicate card.
        expect({ where, unique: new Set(ids(queue)).size }).toEqual({ where, unique: queue.length });

        // No ineligible card, and each card is in the right bucket.
        const inPool = new Set(ids(pool));
        for (const c of queue) {
          expect({ where, id: c.id, ok: inPool.has(c.id) && studyEligible(c, ctx, explicit) }).toEqual({
            where, id: c.id, ok: true,
          });
          expect(c.suspended === true || isBuried(c, NOW)).toBe(false);
        }
        for (const c of sel.learn) expect(life(c) === 'learning' && c.due <= NOW).toBe(true);
        for (const c of sel.reviews) expect(['review', 'mastered'].includes(life(c)) && c.due <= NOW).toBe(true);
        for (const c of sel.checks) {
          expect(life(c)).toBe('known');
          expect(c.knownCheckedAt == null && isCheckSampled(c.id) && checkReadyAt(c) <= NOW).toBe(true);
          expect(ctx.decks.get(c.deckId)?.options.knownChecks).toBe(true);
        }
        for (const c of sel.fresh) expect(life(c)).toBe('new'); // never Not started, never Known

        // Caps.
        const exp = expectedUncut(pool, ctx);
        const sessionCap = ctx.settings.sessionLimit > 0 ? ctx.settings.sessionLimit : Infinity;
        expect(queue.length).toBeLessThanOrEqual(sessionCap);
        expect(sel.reviews.length).toBeLessThanOrEqual(left(ctx.settings.srs.dailyReviewLimit, exp.done.reviews));
        expect(sel.checks.length).toBeLessThanOrEqual(left(ctx.settings.knownChecksPerDay, exp.done.checks));
        expect(sel.fresh.length).toBeLessThanOrEqual(left(ctx.settings.srs.dailyNewLimit, exp.done.neww));
        const freshPerDeck = new Map<Id, number>();
        for (const c of sel.fresh) freshPerDeck.set(c.deckId, (freshPerDeck.get(c.deckId) ?? 0) + 1);
        for (const [deckId, n] of freshPerDeck) {
          const perDay = ctx.decks.get(deckId)?.options.newPerDay ?? null;
          if (perDay != null) expect(n).toBeLessThanOrEqual(left(perDay, exp.done.newByDeck[deckId] ?? 0));
        }

        // Sibling rules: one review per note; with spacing on, no review whose sibling was
        // studied today, one card per note among new cards, and a new card never shares a
        // note with another picked card.
        const reviewNotes = sel.reviews.map((c) => c.noteId);
        expect(new Set(reviewNotes).size).toBe(reviewNotes.length);
        // Checks: one per note, and never a note that already has a card in learn or reviews.
        const checkNotes = sel.checks.map((c) => c.noteId);
        expect(new Set(checkNotes).size).toBe(checkNotes.length);
        const learnOrReview = new Set([...sel.learn, ...sel.reviews].map((c) => c.noteId));
        for (const id of checkNotes) expect({ where, id, inRun: learnOrReview.has(id) }).toEqual({ where, id, inRun: false });
        if (ctx.settings.spaceSiblings) {
          for (const c of sel.reviews) expect({ where, id: c.id, waits: siblingStudiedToday(c, ctx) }).toEqual({
            where, id: c.id, waits: false,
          });
          for (const c of sel.checks) expect({ where, id: c.id, busy: exp.siblingBusy(c) }).toEqual({
            where, id: c.id, busy: false,
          });
          const others = new Set([...sel.learn, ...sel.reviews, ...sel.checks].map((c) => c.noteId));
          const freshNotes = sel.fresh.map((c) => c.noteId);
          expect(new Set(freshNotes).size).toBe(freshNotes.length);
          for (const id of freshNotes) expect(others.has(id)).toBe(false);
        }

        // Buckets as full as the caps allow (brute force), then the session cut is a prefix.
        const uncut = exp.learn + exp.reviews.length + exp.checks + exp.fresh;
        if (exp.siblingWaited) siblingWaited += 1;
        if (exp.reviewWaitedForToday) reviewWaitedForToday += 1;
        if (exp.checkWaited) checkWaited += 1;
        expect({ where, uncappedTotal: sel.uncappedTotal }).toEqual({ where, uncappedTotal: uncut });
        expect(queue.length).toBe(Math.min(uncut, sessionCap));
        if (!rc.capped) {
          expect(ids(sel.reviews)).toEqual(ids(exp.reviews));
          expect(sel.checks.length).toBe(exp.checks);
          expect(sel.fresh.length).toBe(exp.fresh);
        }

        // Round robin is fair: a deck that could give more never trails another deck by 2+.
        for (const [a, possibleA] of exp.possible) {
          const countA = freshPerDeck.get(a) ?? 0;
          if (countA >= possibleA) continue;
          for (const [b, countB] of freshPerDeck) {
            expect({ where, a, b, fair: countB <= countA + 1 }).toEqual({ where, a, b, fair: true });
          }
        }

        // The order of the pool does not matter.
        const again = selectScheduled(rnd.fork('shuffle').shuffle(pool), ctx);
        expect(ids(planQueue(again))).toEqual(ids(queue));
      }
    }
    // The generator really reached the interesting cases.
    expect(nonEmpty).toBeGreaterThan(STATES);
    expect(cappedRuns).toBeGreaterThan(100);
    expect(withChecks).toBeGreaterThan(80);
    expect(freshFromTwoDecks).toBeGreaterThan(50);
    expect(siblingWaited).toBeGreaterThan(200);
    expect(reviewWaitedForToday).toBeGreaterThan(50);
    expect(checkWaited).toBeGreaterThan(40);
  });

  it('study ahead and practice: no duplicate, right cards only, capped by the session size, as full as allowed', () => {
    for (let i = 0; i < STATES; i++) {
      const seed = `ahead-practice-${i}`;
      const rnd = createRandom(seed);
      const w = randomWorld(rnd.fork('world'), `p${i}`);
      const ctx = ctxOf(w, randomOptions(rnd.fork('options'), w));
      const cap = ctx.settings.sessionLimit > 0 ? ctx.settings.sessionLimit : Infinity;

      const { pool } = scopedPool(w, ctx, rnd.pick(['all', 'deck', 'subset'] as const), rnd.fork('scope'));
      const ahead = selectAhead([...pool, ...pool], ctx);
      const aheadCandidates = reviewSiblingRule(
        pool.filter((c) => ['review', 'mastered'].includes(life(c)) && c.due > NOW),
        ctx,
      );
      expect({ seed, n: ahead.length }).toEqual({ seed, n: Math.min(aheadCandidates.length, cap) });
      expect(ids(ahead)).toEqual(ids(aheadCandidates.slice(0, cap)));
      expect(new Set(ids(ahead)).size).toBe(ahead.length);
      expect(new Set(ahead.map((c) => c.noteId)).size).toBe(ahead.length); // one card per note
      for (let k = 1; k < ahead.length; k++) expect(ahead[k - 1].due).toBeLessThanOrEqual(ahead[k].due);

      // Practice uses the browse pool: every card of the scope, paused decks included.
      const browse = w.cards.filter((c) => fnv1a(c.noteId) % 3 !== 0);
      const practice = selectPractice(browse, { by: 'hardest' }, ctx);
      const allowed = browse.filter(
        (c) => !['known', 'notStarted'].includes(life(c)) && !c.suspended && !isBuried(c, NOW),
      );
      expect({ seed, n: practice.length }).toEqual({ seed, n: Math.min(allowed.length, cap) });
      for (const c of practice) {
        expect(['known', 'notStarted'].includes(life(c))).toBe(false);
        expect(c.suspended === true || isBuried(c, NOW)).toBe(false);
      }
      for (let k = 1; k < practice.length; k++) {
        const [a, b] = [practice[k - 1], practice[k]];
        expect(a.ease < b.ease || (a.ease === b.ease && a.lapses >= b.lapses)).toBe(true);
      }
    }
  });
});
