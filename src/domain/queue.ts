/**
 * Session-queue building and the "ready" arithmetic. ONE function computes
 * what is studiable right now and every surface reads it — the Home hero,
 * the Study-tab badge, deck rows, the launchpad. That is the redesign's
 * "trustworthy numbers" rule (plan B4/D1): never show a raw count where a
 * limit-aware ready count is meant.
 */
import {
  Card,
  Collection,
  CollectionQuery,
  DayDone,
  isDue,
  SessionKind,
  SrsSettings,
} from './types';

export interface ReadyCounts {
  total: number;
  due: number;
  neww: number;
  learning: number;
  /** Honest estimate, ~23s per card, ≥1 min when anything is ready. */
  mins: number;
}

const SECONDS_PER_CARD = 23;

export function studiable(card: Card, now: number): boolean {
  return !card.suspended && (!card.buriedUntil || card.buriedUntil <= now);
}

/** Cards in their learning/relearning steps that are ready now. */
function learningDue(cards: Card[], now: number): Card[] {
  return cards.filter(
    (c) => c.reps > 0 && c.stepIndex !== null && c.due <= now && studiable(c, now),
  );
}

/** Graduated cards whose review is due. */
function reviewDue(cards: Card[], now: number): Card[] {
  return cards.filter(
    (c) => c.reps > 0 && c.stepIndex === null && c.due <= now && studiable(c, now),
  );
}

function newCards(cards: Card[]): Card[] {
  return cards.filter((c) => c.reps === 0 && !c.suspended);
}

function remainingNew(s: SrsSettings, done: DayDone): number {
  return Math.max(0, s.dailyNewLimit - done.neww);
}

function remainingReviews(s: SrsSettings, done: DayDone): number {
  return Math.max(0, s.dailyReviewLimit - done.reviews);
}

export interface QueueOptions {
  kind: SessionKind;
  deckId?: string;
  collection?: Collection;
  now: number;
  settings: SrsSettings;
  done: DayDone;
  /** Cap for ahead/cram sessions. */
  cap?: number;
}

export function collectionFilter(query: CollectionQuery): (c: Card, now: number) => boolean {
  switch (query) {
    case 'hardest':
      return (c) => c.reps > 0 && c.ease <= 2.2;
    case 'favorites':
      return (c) => !!c.fav;
    case 'young':
      return (c) => c.reps > 0 && c.intervalDays <= 7;
    case 'flagged':
      return (c) => !!c.flagged;
  }
}

/** Build the ordered queue for a session. */
export function buildQueue(cards: Card[], opts: QueueOptions): Card[] {
  const { kind, now, settings, done } = opts;
  let pool = cards;
  if (opts.deckId) pool = pool.filter((c) => c.deckId === opts.deckId);
  if (opts.collection) {
    const f = collectionFilter(opts.collection.query);
    pool = pool.filter((c) => f(c, now));
  }

  if (kind === 'ahead') {
    // next reviews not yet due, soonest first
    return pool
      .filter((c) => c.reps > 0 && c.due > now && studiable(c, now))
      .sort((a, b) => a.due - b.due)
      .slice(0, opts.cap ?? 20);
  }
  if (kind === 'cram' || kind === 'hardest') {
    return pool
      .filter((c) => c.reps > 0 && studiable(c, now))
      .sort((a, b) => a.ease - b.ease || a.due - b.due)
      .slice(0, opts.cap ?? 20);
  }

  // scheduled (also deck/collection scoped): learning first, then due
  // reviews, then new cards up to the daily allowance.
  const learn = learningDue(pool, now).sort((a, b) => a.due - b.due);
  const reviews = reviewDue(pool, now)
    .sort((a, b) => a.due - b.due)
    .slice(0, remainingReviews(settings, done));
  const fresh = newCards(pool)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, remainingNew(settings, done));
  return [...learn, ...reviews, ...fresh];
}

/** The numbers the Home hero, Study badge and launchpad all share. */
export function computeReady(
  cards: Card[],
  settings: SrsSettings,
  done: DayDone,
  now: number,
  deckId?: string,
): ReadyCounts {
  const pool = deckId ? cards.filter((c) => c.deckId === deckId) : cards;
  const learning = learningDue(pool, now).length;
  const due = Math.min(reviewDue(pool, now).length, remainingReviews(settings, done));
  const neww = Math.min(newCards(pool).length, remainingNew(settings, done));
  const total = learning + due + neww;
  return {
    total,
    due,
    neww,
    learning,
    mins: total === 0 ? 0 : Math.max(1, Math.round((total * SECONDS_PER_CARD) / 60)),
  };
}

export interface DeckStats {
  total: number;
  mastered: number;
  learning: number;
  neww: number;
  /** Limit-aware ready count for the deck row badge. */
  due: number;
}

export function deckStats(
  cards: Card[],
  deckId: string,
  settings: SrsSettings,
  done: DayDone,
  now: number,
): DeckStats {
  const pool = cards.filter((c) => c.deckId === deckId);
  let mastered = 0;
  let learning = 0;
  let neww = 0;
  for (const c of pool) {
    if (c.reps === 0) neww += 1;
    else if (c.stepIndex !== null) learning += 1;
    else if (c.intervalDays >= 21) mastered += 1;
  }
  const ready = computeReady(cards, settings, done, now, deckId);
  return { total: pool.length, mastered, learning, neww, due: ready.due + ready.learning };
}

export function collectionStats(
  cards: Card[],
  collection: Collection,
  now: number,
): { count: number; due: number } {
  const f = collectionFilter(collection.query);
  const pool = cards.filter((c) => f(c, now));
  return { count: pool.length, due: pool.filter((c) => isDue(c, now)).length };
}
