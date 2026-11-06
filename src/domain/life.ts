/**
 * The lifecycle of a card (spec §4.5, glossary §1.2): ONE function decides
 * which status a card is in, so the Library status filter, the facets, the
 * scheduler and Progress can never disagree.
 *
 *   Not started → (Learn) → New → Learning → Review → Mastered
 *                                       Known (you said you know it; never studied, never "mastered")
 *
 * "Due" is NOT a status. It is a separate filter (`isDueNow`): a Learning,
 * Review or Mastered card whose time has come. Only these three statuses
 * have a review date at all (`hasReviewDate`).
 *
 * Works on BOTH card shapes:
 *   - today's v2 card (src/domain/types.ts), which has no `knownAt` / `newState`
 *     yet → it is never Known or Not started;
 *   - the v3 card (src/domain/model.ts), which has them.
 * `LifeCard` lists only the keys these functions read, and both shapes fit it.
 *
 * Pure: no React, no clock. The caller passes `now`.
 */
import type { LifeKey } from './model';
import { MASTERED_INTERVAL_DAYS } from './types';

/** The card keys the lifecycle reads. Both the v2 and the v3 Card fit this type. */
export interface LifeCard {
  reps: number;
  /** Index into the learning steps. null once graduated. */
  stepIndex: number | null;
  intervalDays: number;
  /** Next review, epoch ms. */
  due: number;
  /** v3 only: set by "I know it". */
  knownAt?: number | null;
  /** v3 only: read only while reps === 0. Absent = 'queued' (= New). */
  newState?: 'queued' | 'notStarted';
  suspended?: boolean;
  /** Epoch ms until which the card is buried, or null. */
  buriedUntil?: number | null;
}

/** Every status, in the order the UI lists them. */
export const LIFE_KEYS: readonly LifeKey[] = Object.freeze([
  'notStarted',
  'new',
  'learning',
  'review',
  'mastered',
  'known',
]);

/** The UI word for each status (glossary §1.2). */
export const LIFE_LABELS: Readonly<Record<LifeKey, string>> = Object.freeze({
  notStarted: 'Not started',
  new: 'New',
  learning: 'Learning',
  review: 'Review',
  mastered: 'Mastered',
  known: 'Known',
});

/**
 * The status of a card. Exactly one of the six.
 *
 *   knownAt set                     → 'known'       (wins over everything)
 *   reps 0 + newState 'notStarted'  → 'notStarted'
 *   reps 0                          → 'new'
 *   stepIndex not null              → 'learning'
 *   interval ≥ 21 days              → 'mastered'
 *   else                            → 'review'
 */
export function life(card: LifeCard): LifeKey {
  if (card.knownAt != null) return 'known';
  if (card.reps === 0) return card.newState === 'notStarted' ? 'notStarted' : 'new';
  if (card.stepIndex !== null) return 'learning';
  return card.intervalDays >= MASTERED_INTERVAL_DAYS ? 'mastered' : 'review';
}

/** True while the card is buried ("hidden until tomorrow"). */
export function isBuried(card: Pick<LifeCard, 'buriedUntil'>, now: number): boolean {
  return card.buriedUntil != null && card.buriedUntil > now;
}

/**
 * True when the card has a real NEXT REVIEW: status Learning, Review or
 * Mastered. Only these cards can ever be "due" (isDueNow below).
 *
 * New, Not started and Known cards have no review date yet. They still have
 * a `due` number, but it means nothing for the schedule: for a New or Not
 * started card it is the time the card was made or imported. So the
 * Library's "Due date" sort puts these cards AFTER the cards with a review
 * date (schedule.ts cardComparator, final pass).
 *
 *   hasReviewDate(learningCard)   → true
 *   hasReviewDate(newCard)        → false   (reps 0)
 *   hasReviewDate(knownCard)      → false   (knownAt set)
 *
 * It is EXACTLY "life(card) is 'learning', 'review' or 'mastered'": life()
 * returns 'known' when knownAt is set, then 'notStarted' / 'new' when reps
 * is 0, and only after that one of the three studied statuses. So the two
 * tests below are the first two steps of life(). (life.test.ts checks the
 * equality on thousands of random cards and on odd values.) It does not
 * call life() because the Library's "Due date" sort runs it once for every
 * card of the library: with life() the first sort of the device's 16,264
 * cards was about 0.8 ms slower in node --jitless (5.2 ms, not 4.4 ms).
 */
export function hasReviewDate(card: LifeCard): boolean {
  return card.knownAt == null && card.reps !== 0;
}

/**
 * True when the card's review time has come and it can be studied now:
 * status Learning, Review or Mastered, `due <= now`, not suspended, not buried.
 * New, Not started and Known cards are never "due".
 * (The deck's pause state is NOT checked here: that is the scheduler's
 * eligibility rule, because a paused deck can still be studied from its own page.)
 */
export function isDueNow(card: LifeCard, now: number): boolean {
  if (!hasReviewDate(card)) return false;
  return card.due <= now && !card.suspended && !isBuried(card, now);
}

/**
 * True only for status Mastered. A Known card is NEVER mastered: you said you
 * know it, but the app has not tested it over time. Achievements and Progress
 * use this, so marking 2,000 cards Known unlocks nothing.
 */
export function isMastered(card: LifeCard): boolean {
  return life(card) === 'mastered';
}
