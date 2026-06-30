/**
 * Unit tests for the shared "ready" arithmetic and session-queue builder.
 *
 * These PIN the load-bearing contract the redesign calls "trustworthy numbers":
 * the count a surface shows must equal the session buildQueue actually opens.
 * Four latent defects (all present on `main`, all shipped because queue.ts had
 * zero coverage) are guarded here:
 *
 *   1. PRIMARY — a deck/collection "Study N" launch control under-reported its
 *      own session by the new-card allowance (it showed due+learning, but the
 *      session tops up with new cards). Now `sessionCount` === queue length.
 *   2. collectionStats was neither limit-aware nor new-inclusive.
 *   3. Stats counted due over ALL decks incl. paused (activeCardPool fixes the
 *      shared active-scope so the four surfaces can't drift).
 *   4. newCards() ignored buriedUntil, so a buried NEW card re-entered the next
 *      same-day session — bury's "skip today" silently no-op'd for new cards.
 */
import { describe, expect, it } from '@jest/globals';

import {
  activeCardPool,
  buildQueue,
  collectionStats,
  computeReady,
  deckStats,
} from './queue';
import { Card, Collection, DAY, DayDone, Deck, DEFAULT_SRS, MIN, SrsSettings } from './types';

const NOW = 1_700_000_000_000;
const SRS: SrsSettings = DEFAULT_SRS;
const noneDone: DayDone = { dayKey: 'k', reviews: 0, neww: 0 };

function makeCard(o: Partial<Card> & Pick<Card, 'id'>): Card {
  return {
    deckId: 'd1',
    word: 'word',
    article: null,
    base: 'word',
    tr: 'translation',
    level: null,
    type: null,
    lang: 'de',
    ease: 2.5,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: NOW,
    createdAt: NOW,
    lastReviewedAt: null,
    ...o,
  };
}

function makeDeck(o: Partial<Deck> & Pick<Deck, 'id' | 'name'>): Deck {
  return { flag: '🏳️', lang: 'de', level: null, builtin: false, active: true, createdAt: 0, ...o };
}

/* Card archetypes (deck 'd1' by default). */
const newCard = (id: string, o: Partial<Card> = {}): Card =>
  makeCard({ id, reps: 0, stepIndex: null, intervalDays: 0, due: NOW, ...o });
const learningDueCard = (id: string, o: Partial<Card> = {}): Card =>
  makeCard({ id, reps: 1, stepIndex: 0, intervalDays: 0, due: NOW - 5 * MIN, ...o });
const reviewDueCard = (id: string, o: Partial<Card> = {}): Card =>
  makeCard({ id, reps: 5, stepIndex: null, intervalDays: 10, due: NOW - DAY, ...o });
const reviewFutureCard = (id: string, o: Partial<Card> = {}): Card =>
  makeCard({ id, reps: 5, stepIndex: null, intervalDays: 10, due: NOW + DAY, ...o });

describe('activeCardPool', () => {
  it('keeps only cards whose deck is active; drops paused and orphan cards', () => {
    const decks = [
      makeDeck({ id: 'a', name: 'A', active: true }),
      makeDeck({ id: 'b', name: 'B', active: false }),
    ];
    const cards = [
      makeCard({ id: '1', deckId: 'a' }),
      makeCard({ id: '2', deckId: 'b' }), // paused deck
      makeCard({ id: '3', deckId: 'ghost' }), // orphan — no such deck
    ];
    expect(activeCardPool(cards, decks).map((c) => c.id)).toEqual(['1']);
  });
});

describe('computeReady is a clean partition of learning / review / new', () => {
  it('counts each studiable card exactly once', () => {
    const cards = [learningDueCard('L'), reviewDueCard('R'), newCard('N'), reviewFutureCard('F')];
    const r = computeReady(cards, SRS, noneDone, NOW);
    expect(r).toMatchObject({ learning: 1, due: 1, neww: 1 });
    expect(r.total).toBe(3); // the future review (F) is not ready
  });
});

describe('hero invariant: computeReady(scheduled).total === buildQueue(scheduled).length', () => {
  const cards = [
    ...Array.from({ length: 3 }, (_, i) => learningDueCard(`L${i}`)),
    ...Array.from({ length: 14 }, (_, i) => reviewDueCard(`R${i}`)),
    ...Array.from({ length: 24 }, (_, i) => newCard(`N${i}`, { createdAt: NOW - i * DAY })),
    ...Array.from({ length: 5 }, (_, i) => reviewFutureCard(`F${i}`)),
  ];
  // Span the daily limits: nothing done, seed-like, review-limit nearly binding,
  // both limits fully binding. Learning is never capped — in both count & queue.
  const cases: DayDone[] = [
    { dayKey: 'k', reviews: 0, neww: 0 },
    { dayKey: 'k', reviews: 14, neww: 3 },
    { dayKey: 'k', reviews: 198, neww: 8 },
    { dayKey: 'k', reviews: 200, neww: 10 },
  ];
  it.each(cases)('holds for done=%o', (done) => {
    const ready = computeReady(cards, SRS, done, NOW);
    const queue = buildQueue(cards, { kind: 'scheduled', now: NOW, settings: SRS, done });
    expect(queue.length).toBe(ready.total);
  });
});

describe('deckStats: the launch count equals the deck session it opens (PRIMARY fix)', () => {
  // d1: 1 learning-due + 8 review-due + 10 new; a foreign deck adds noise.
  const cards = [
    learningDueCard('L', { deckId: 'd1' }),
    ...Array.from({ length: 8 }, (_, i) => reviewDueCard(`R${i}`, { deckId: 'd1' })),
    ...Array.from({ length: 10 }, (_, i) => newCard(`N${i}`, { deckId: 'd1', createdAt: NOW - i * DAY })),
    reviewDueCard('X', { deckId: 'd2' }),
  ];
  const done: DayDone = { dayKey: 'k', reviews: 14, neww: 3 }; // remainingNew = 7

  it('sessionCount === buildQueue(kind:deck).length', () => {
    const s = deckStats(cards, 'd1', SRS, done, NOW);
    const queue = buildQueue(cards, { kind: 'deck', deckId: 'd1', now: NOW, settings: SRS, done });
    expect(s.sessionCount).toBe(queue.length);
  });

  it('sessionCount includes the new cards the due-only count omits (9 due -> 16-card session)', () => {
    const s = deckStats(cards, 'd1', SRS, done, NOW);
    expect(s.due).toBe(9); // 8 review-due + 1 learning-due, no new cards
    expect(s.sessionCount).toBe(16); // + min(10 new, remainingNew 7) = 7
    expect(s.sessionCount - s.due).toBe(7); // exactly the gap the bug exposed
  });
});

describe('collectionStats: limit-aware & new-inclusive, matching its session', () => {
  const favorites: Collection = { id: 'c', name: 'Favorites', icon: 'star', desc: '', query: 'favorites' };
  const cards = [
    reviewDueCard('R0', { fav: true }),
    reviewDueCard('R1', { fav: true }),
    newCard('N0', { fav: true, createdAt: NOW - 1 * DAY }),
    newCard('N1', { fav: true, createdAt: NOW - 2 * DAY }),
    reviewDueCard('NOPE'), // not a favorite
  ];

  it('sessionCount counts the new favorites the session introduces', () => {
    const s = collectionStats(cards, favorites, SRS, noneDone, NOW);
    const queue = buildQueue(cards, { kind: 'collection', collection: favorites, now: NOW, settings: SRS, done: noneDone });
    expect(s.due).toBe(2); // only reps>0 favorites are "due"
    expect(s.sessionCount).toBe(4); // + 2 new favorites
    expect(s.sessionCount).toBe(queue.length);
  });
});

describe('bury excludes a card from BOTH the count and the queue, for every card type', () => {
  const buriedUntil = NOW + DAY; // buried until tomorrow

  it.each([
    ['new', () => newCard('B', { buriedUntil })],
    ['learning', () => learningDueCard('B', { buriedUntil })],
    ['review', () => reviewDueCard('B', { buriedUntil })],
  ])('a buried %s card is neither ready nor queued today', (_label, makeBuried) => {
    const cards = [makeBuried(), reviewDueCard('keep')];
    const ready = computeReady(cards, SRS, noneDone, NOW);
    const queue = buildQueue(cards, { kind: 'scheduled', now: NOW, settings: SRS, done: noneDone });
    expect(ready.total).toBe(1); // only 'keep' survives
    expect(queue.map((c) => c.id)).toEqual(['keep']);
  });

  it('the buried NEW card specifically is excluded (the regressed case)', () => {
    const cards = [newCard('B', { buriedUntil }), newCard('keep')];
    const ready = computeReady(cards, SRS, noneDone, NOW);
    const queue = buildQueue(cards, { kind: 'scheduled', now: NOW, settings: SRS, done: noneDone });
    expect(ready.neww).toBe(1); // not 2 — bury now counts for new cards
    expect(queue.map((c) => c.id)).toEqual(['keep']);
  });
});

describe('a paused deck does not inflate the active-scoped count (Stats fix)', () => {
  it('active-scoped ready excludes paused-deck due cards and matches its session', () => {
    const decks = [
      makeDeck({ id: 'a', name: 'A', active: true }),
      makeDeck({ id: 'p', name: 'P', active: false }),
    ];
    const cards = [reviewDueCard('a1', { deckId: 'a' }), reviewDueCard('p1', { deckId: 'p' })];
    const pool = activeCardPool(cards, decks);
    const ready = computeReady(pool, SRS, noneDone, NOW);
    const queue = buildQueue(pool, { kind: 'scheduled', now: NOW, settings: SRS, done: noneDone });
    expect(ready.due).toBe(1); // p1 (paused) is not counted
    expect(queue.length).toBe(ready.total);
  });
});

describe('deckStats.due is the TRUE urgency count, uncapped by the daily limit (M4)', () => {
  it('reports every overdue card even when dailyReviewLimit is lower', () => {
    const cards = [reviewDueCard('a'), reviewDueCard('b'), reviewDueCard('c')];
    const settings: SrsSettings = { ...SRS, dailyReviewLimit: 1 };
    const s = deckStats(cards, 'd1', settings, noneDone, NOW);
    expect(s.due).toBe(3); // all three overdue — not capped at the limit
    expect(s.sessionCount).toBe(1); // launch size stays limit-aware
  });

  it('uses the same isDue definition as collectionStats (review + learning, not new)', () => {
    const cards = [reviewDueCard('a'), learningDueCard('b'), newCard('c')];
    const settings: SrsSettings = { ...SRS, dailyReviewLimit: 1 };
    expect(deckStats(cards, 'd1', settings, noneDone, NOW).due).toBe(2); // a + b, not the new card
  });
});
