/**
 * Pure daily-allowance + streak accounting, extracted from DataContext so the
 * budget math is testable. Fixes the audit's accounting cluster:
 *   - H3: practice and cram ("free practice") must not touch the day's tallies.
 *     Since W5-3 that gate lives in ONE place: reducer.ts rateCard returns
 *     before it tallies anything when `writesSchedule(kind)` is false. So
 *     every rating that reaches tallyReview is counted.
 *   - M3: a NEW card consumes the NEW budget only, not the review budget — every
 *     rating used to bump `reviews`, so new-card study silently ate the daily
 *     review allowance and double-counted on the goal bars.
 *   - L10: the +10 daily-streak XP is paid once per day — rollStreak reports
 *     whether THIS session is the day's first.
 *
 * v3 (W3-1, spec §3.6 "rateCard rules"): a rating counts in ONE of three
 * buckets, and the v3 day tally (`DayDone`) has a counter for each:
 *   - 'new'    (the card's first study)  → `neww + 1` AND `newByDeck[deckId] + 1`
 *              (the per-deck new cap of the scheduler reads newByDeck);
 *   - 'review' (a studied card)          → `reviews + 1`;
 *   - 'check'  (a Known card's Check)    → `checks + 1`.
 * `untallyReview` is the exact inverse, for undo: it never goes below zero,
 * and a `newByDeck` entry that comes back to 0 is removed, so "rate, then
 * undo" gives back the very same day tally.
 *
 * Example:
 *   tallyReview(day, { bucket: 'new', deckId: 'd1' })   // neww + 1, newByDeck.d1 + 1
 *   untallyReview(next, { bucket: 'new', deckId: 'd1' }) // back to `day`
 */
import { MAX_FREEZES } from '../domain/gamification';
import { addDays, DayDone, dayKeyOf, Id, Person, ReviewBucket } from '../domain/types';

/**
 * The calendar day a completed session's payout (streak roll, SessionRecord,
 * lastStudyDay) is attributed to. Prefer the session's own study day — the day
 * its reviews were tallied — falling back to the completion instant only when
 * it's absent (a legacy in-flight marker).
 *
 * Attributing by the completion instant alone is wrong twice over: a session
 * that finishes just after local midnight would credit the next day (resetting
 * the streak or burning a freeze for a day the user actually studied), and an
 * interrupted session banked by the boot reconciler would credit the reopen day
 * rather than the study day.
 */
export function attributionDay(studyDay: string | undefined, nowMs: number): string {
  return studyDay ?? dayKeyOf(nowMs);
}

/** An empty day tally for `dayKey`: nothing studied yet. */
export function emptyDayDone(dayKey: string): DayDone {
  return { dayKey, reviews: 0, neww: 0, checks: 0, newByDeck: {} };
}

/**
 * Which budget one rating uses, and in which deck.
 *
 *   - `bucket` + `deckId`: the v3 form (spec §3.6). `deckId` is the deck of
 *     the rated card; a 'new' rating counts in `newByDeck[deckId]`.
 *   - `wasNew`: the v2 form, kept so a caller that does not know buckets yet
 *     still compiles: `wasNew: true` = 'new', else 'review'. Without a
 *     `deckId` the per-deck count is not changed.
 * Free practice (H3) never gets here: rateCard stops before the tally.
 */
export type TallyInput = { bucket: ReviewBucket; deckId: Id } | { wasNew: boolean; deckId?: Id };

/** The bucket of a TallyInput. */
function bucketOf(opts: TallyInput): ReviewBucket {
  if ('bucket' in opts) return opts.bucket;
  return opts.wasNew ? 'new' : 'review';
}

/** A counter as a whole number ≥ 0 (a damaged or missing value counts as 0). */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * `byDeck` with the count of `deckId` changed by `delta` (never below 0; an
 * entry at 0 is removed). A new object: the input is never changed.
 *
 * Built with Object.fromEntries, not with a spread: a spread compiles to
 * `Object.assign`, which loses a key named "__proto__" (it runs the setter).
 */
function withDeckCount(byDeck: Record<Id, number> | undefined, deckId: Id, delta: number): Record<Id, number> {
  const entries = Object.entries(byDeck ?? {}).filter(([id]) => id !== deckId);
  const next = Math.max(0, count(byDeck && Object.prototype.hasOwnProperty.call(byDeck, deckId) ? byDeck[deckId] : 0) + delta);
  if (next > 0) entries.push([deckId, next]);
  return Object.fromEntries(entries);
}

/** The day's tallies after rating one card (see TallyInput and the file comment). */
export function tallyReview(dayDone: DayDone, opts: TallyInput): DayDone {
  return addToBucket(dayDone, bucketOf(opts), opts.deckId, 1);
}

/** Inverse of one tallyReview, for undo. Never drops below zero. */
export function untallyReview(dayDone: DayDone, opts: TallyInput): DayDone {
  return addToBucket(dayDone, bucketOf(opts), opts.deckId, -1);
}

/**
 * `dayDone` with the counter of `bucket` changed by `delta` (never below zero).
 *
 * It ALWAYS returns a DayDone. A bucket that is not 'new', 'review' or
 * 'check' (damaged data: a stored review-log entry without a bucket) changes
 * no counter. Without the `default` branch the switch returned `undefined`,
 * and an undo then wrote `person.dayDone = undefined`: the next rating
 * threw on `dayDone.dayKey`.
 */
function addToBucket(dayDone: DayDone, bucket: ReviewBucket, deckId: Id | undefined, delta: number): DayDone {
  // The v3 counters, also when an older tally lacks them.
  const base: DayDone = { ...dayDone, checks: count(dayDone.checks), newByDeck: dayDone.newByDeck ?? {} };
  switch (bucket) {
    case 'new':
      return {
        ...base,
        neww: Math.max(0, base.neww + delta),
        newByDeck: deckId === undefined ? base.newByDeck : withDeckCount(base.newByDeck, deckId, delta),
      };
    case 'review':
      return { ...base, reviews: Math.max(0, base.reviews + delta) };
    case 'check':
      return { ...base, checks: Math.max(0, base.checks + delta) };
    default:
      // An unknown bucket: nothing to count (see the comment above).
      return base;
  }
}

export interface StreakRoll {
  streak: number;
  freezes: number;
  freezeUsedDays: string[];
  /** True only on the day's FIRST session — gates the once-per-day streak XP. */
  advanced: boolean;
}

/**
 * Advance the streak for today's first session. A freeze bridges a single
 * missed day (yesterday). A second same-day session returns advanced:false with
 * the streak unchanged, so the streak XP bonus is not paid twice in one day.
 */
export function rollStreak(
  person: Pick<Person, 'streak' | 'freezes' | 'freezeUsedDays' | 'lastStudyDay'>,
  today: string,
): StreakRoll {
  if (person.lastStudyDay === today) {
    return {
      streak: person.streak,
      freezes: person.freezes,
      freezeUsedDays: person.freezeUsedDays,
      advanced: false,
    };
  }
  const yesterday = addDays(today, -1);
  const dayBefore = addDays(today, -2);
  let streak = person.streak;
  let freezes = person.freezes;
  const freezeUsedDays = [...person.freezeUsedDays];
  if (person.lastStudyDay === yesterday) {
    streak += 1;
  } else if (person.lastStudyDay === dayBefore && freezes > 0) {
    freezes -= 1;
    freezeUsedDays.push(yesterday);
    streak += 1;
  } else {
    streak = 1;
  }
  // Reward a streak freeze at each 7-day milestone — the promise the settings
  // copy makes ("earn one at every 7-day milestone"). Capped (never reduces an
  // existing surplus from other sources) so freezes can't grow without bound (M13).
  if (streak % 7 === 0 && freezes < MAX_FREEZES) {
    freezes += 1;
  }
  return { streak, freezes, freezeUsedDays, advanced: true };
}
