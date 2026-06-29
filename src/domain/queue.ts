/**
 * Session-queue building and the "ready" arithmetic. ONE function computes
 * what is studiable right now and every surface reads it — the Home hero,
 * the Study-tab badge, deck rows, the launchpad. That is the redesign's
 * "trustworthy numbers" rule (plan B4/D1): never show a raw count where a
 * limit-aware ready count is meant.
 *
 * The load-bearing invariant for every launch control: the number printed on a
 * "Study N" button MUST equal buildQueue(...).length for the same args. A
 * deck/collection session tops up with new cards, so launch controls display
 * `sessionCount` (the limit-aware total, new cards included), NOT the due-only
 * `due` urgency count — otherwise "Study 11" opens an 18-card session.
 */
import {
  Card,
  Collection,
  CollectionQuery,
  DayDone,
  Deck,
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

/**
 * The cards every "ready now" surface must score: those belonging to a still
 * active deck. Centralised so the Home hero, Study badge, Study aggregate and
 * Progress screen can't drift to four subtly different active-filters (they
 * had: `activeIds.has(deckId)` vs `deck?.active !== false`). Orphan cards — no
 * matching deck — are excluded; they cannot be studied.
 */
export function activeCardPool(cards: Card[], decks: Deck[]): Card[] {
  const activeIds = new Set(decks.filter((d) => d.active).map((d) => d.id));
  return cards.filter((c) => activeIds.has(c.deckId));
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

/**
 * Brand-new cards eligible to be introduced now. Like its learningDue/reviewDue
 * siblings it honours studiable(now), so a buried (or suspended) new card is
 * excluded — bury's "skip today" promise must hold for new cards too, and the
 * count must not include a card buildQueue won't serve.
 */
function newCards(cards: Card[], now: number): Card[] {
  return cards.filter((c) => c.reps === 0 && studiable(c, now));
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
  const fresh = newCards(pool, now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, remainingNew(settings, done));
  return [...learn, ...reviews, ...fresh];
}

/**
 * Limit-aware counts for an already-scoped pool. This is the single definition
 * of "what is ready", shared by computeReady (deck/aggregate) and
 * collectionStats — and it is kept in lockstep with buildQueue's scheduled
 * branch so that `total` always equals the resulting queue length.
 */
function readyOfPool(pool: Card[], settings: SrsSettings, done: DayDone, now: number): ReadyCounts {
  const learning = learningDue(pool, now).length;
  const due = Math.min(reviewDue(pool, now).length, remainingReviews(settings, done));
  const neww = Math.min(newCards(pool, now).length, remainingNew(settings, done));
  const total = learning + due + neww;
  return {
    total,
    due,
    neww,
    learning,
    mins: total === 0 ? 0 : Math.max(1, Math.round((total * SECONDS_PER_CARD) / 60)),
  };
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
  return readyOfPool(pool, settings, done, now);
}

export interface DeckStats {
  total: number;
  mastered: number;
  learning: number;
  neww: number;
  /** Due-now urgency count (review + learning) for the row's "N due" label. */
  due: number;
  /**
   * Limit-aware size of the session a "Study" tap launches (learning + due +
   * new). This — not `due` — is what a launch control must display, so the
   * button number matches the session it opens.
   */
  sessionCount: number;
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
  return {
    total: pool.length,
    mastered,
    learning,
    neww,
    due: ready.due + ready.learning,
    sessionCount: ready.total,
  };
}

export interface CollectionStats {
  count: number;
  /** Due-now urgency count for the "N due" label. */
  due: number;
  /**
   * Limit-aware size of the session a "Study" tap launches over this
   * collection's pool — new cards included — so the launch number matches
   * buildQueue, exactly as deckStats.sessionCount does for decks.
   */
  sessionCount: number;
}

export function collectionStats(
  cards: Card[],
  collection: Collection,
  settings: SrsSettings,
  done: DayDone,
  now: number,
): CollectionStats {
  const f = collectionFilter(collection.query);
  const pool = cards.filter((c) => f(c, now));
  return {
    count: pool.length,
    due: pool.filter((c) => isDue(c, now)).length,
    sessionCount: readyOfPool(pool, settings, done, now).total,
  };
}
