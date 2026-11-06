/**
 * Anki study progress → Maranki card fields (spec §5.5, unit W2-5). Pure.
 *
 * Every Anki card row carries its scheduling: `type` (0 new, 1 learning,
 * 2 review, 3 relearning), `queue` (-1 suspended, -2/-3 buried), `due`,
 * `ivl` (interval in days), `factor` (ease × 1000), `reps`, `lapses` and
 * `flags` (the colour flag in the low 3 bits). This file turns one row into
 * the SRS and marker fields of a Maranki card:
 *
 *   | Anki card                      | Maranki card                                          |
 *   |--------------------------------|-------------------------------------------------------|
 *   | type 0 (new)                   | reps 0, newState = choices.arrival                    |
 *   | type 1 / 3 (learning)          | stepIndex 0, due from Anki, intervalDays = max(0, ivl)|
 *   | type 2 (review)                | stepIndex null, intervalDays = ivl,                   |
 *   |                                | ease = clamp(factor / 1000, 1.3, 5),                  |
 *   |                                | due = startOfLocalDay((crt + due × 86400) × 1000)     |
 *   | queue -1                       | suspended                                             |
 *   | queue -2 / -3 (buried)         | ignored (bury lasts one day)                          |
 *   | flags & 7 ≠ 0                  | flagged, flagColor = flags & 7                        |
 *   | note tag `marked`              | fav (the planner removes the tag)                     |
 *   | progress 'reset'               | every card New                                        |
 *
 * Where `due` comes from. Anki stores two kinds of `due`:
 *   - a review card (and a learning card that waits a day or more, queue 3)
 *     stores a DAY NUMBER counted from the collection start `crt` (seconds);
 *   - a learning card in queue 1 stores a moment in EPOCH SECONDS.
 * A suspended or buried learning card has lost its queue, so the kind is read
 * from the value: a day number is small (< 1e9), epoch seconds are not.
 *
 * Safety rules:
 *   - A value that is not a finite number (or an unknown `type`) → the card
 *     starts as New. NaN must never reach the scheduler.
 *   - intervalDays is clamped to settings.maxIntervalDays.
 *   - A card with progress gets reps ≥ 1. Why: Maranki reads `reps === 0`
 *     as "New" (life.ts) before anything else, and Anki can have a review
 *     card with reps 0 ("Set due date" on a new card).
 *   - `newPos` (the new-card feed position) is the note's place in Anki's
 *     new-card order, given by the planner. Siblings share it.
 */
import type { AnkiCollection, Card, SrsSettings } from '../model';

/** The lowest and highest ease Maranki accepts from Anki (§5.5). */
export const ANKI_EASE_MIN = 1.3;
export const ANKI_EASE_MAX = 5;

/** A due value at or above this is epoch seconds (2001-09-09), below it a day number. */
const EPOCH_SECONDS_FLOOR = 1e9;

/** One Anki card row (only the columns the mapping reads). */
export type AnkiCardRow = Pick<
  AnkiCollection['cards'][number],
  'type' | 'queue' | 'due' | 'ivl' | 'factor' | 'reps' | 'lapses' | 'flags'
>;

/** What the mapping returns: only Card keys, so makeCard never receives a stray key. */
export type AnkiCardFields = Pick<
  Card,
  | 'ease'
  | 'intervalDays'
  | 'stepIndex'
  | 'reps'
  | 'lapses'
  | 'due'
  | 'newPos'
  | 'lastReviewedAt'
  | 'fav'
  | 'flagged'
  | 'suspended'
> &
  Partial<Pick<Card, 'newState' | 'flagColor'>>;

export interface AnkiSrsOptions {
  /** col.crt in seconds (the collection's first day). */
  crt: number;
  /** choices.progress: keep Anki's scheduling, or start every card as New. */
  progress: 'keep' | 'reset';
  /** choices.arrival: what a New card becomes ('queued' = New, or 'notStarted'). */
  arrival: 'queued' | 'notStarted';
  /** The note's place in the new-card order (siblings share it). */
  newPos: number;
  /** True when the note has the Anki tag `marked` → the card is a favorite. */
  marked: boolean;
  srs: Pick<SrsSettings, 'startingEase' | 'maxIntervalDays'>;
  now: number;
}

/** Midnight (local time) at the start of the day of `ms`. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Epoch ms of an Anki day number: local midnight of day `crt + dueDays`. */
export function ankiDayToMs(crt: number, dueDays: number): number {
  return startOfLocalDay((crt + dueDays * 86_400) * 1000);
}

/** True for the Anki tag `marked` (Anki tags ignore case). */
export function isMarkedTag(tag: string): boolean {
  return tag.toLowerCase() === 'marked';
}

const allFinite = (...values: number[]): boolean => values.every((v) => Number.isFinite(v));

/** True when the row's numbers are all usable. */
function usable(row: AnkiCardRow): boolean {
  return allFinite(row.type, row.queue, row.due, row.ivl, row.factor, row.reps, row.lapses);
}

/**
 * True when the card carries Anki study progress that 'keep' would import
 * (a learning, review or relearning card with usable numbers). The preview's
 * "Study progress in this file: {n} cards" counts these.
 */
export function hasAnkiProgress(row: AnkiCardRow): boolean {
  return usable(row) && (row.type === 1 || row.type === 2 || row.type === 3);
}

/** Ease from Anki's factor (ease × 1000). 0 or less means "not set" → the starting ease. */
function easeOf(factor: number, startingEase: number): number {
  if (!(factor > 0)) return startingEase;
  return Math.min(ANKI_EASE_MAX, Math.max(ANKI_EASE_MIN, factor / 1000));
}

/**
 * Map one Anki card row to Maranki card fields (see the table at the top).
 * The result has only Card keys; pass it to makeCard with a fresh id.
 */
export function mapAnkiCard(row: AnkiCardRow, opts: AnkiSrsOptions): AnkiCardFields {
  const { srs, now } = opts;
  const flagColor = Number.isFinite(row.flags) ? row.flags & 7 : 0;
  const markers = {
    fav: opts.marked,
    flagged: flagColor !== 0,
    ...(flagColor !== 0 ? { flagColor } : {}),
    suspended: row.queue === -1,
  };
  const fresh: AnkiCardFields = {
    ease: srs.startingEase,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: now,
    newPos: opts.newPos,
    lastReviewedAt: null,
    newState: opts.arrival,
    ...markers,
  };

  if (opts.progress === 'reset' || !hasAnkiProgress(row)) return fresh;

  const reps = Math.max(1, Math.round(row.reps));
  const lapses = Math.max(0, Math.round(row.lapses));
  const maxIvl = Math.max(1, srs.maxIntervalDays);

  if (row.type === 2) {
    const due = ankiDayToMs(opts.crt, row.due);
    if (!Number.isFinite(due)) return fresh;
    return {
      ease: easeOf(row.factor, srs.startingEase),
      intervalDays: Math.min(maxIvl, Math.max(1, Math.round(row.ivl))),
      stepIndex: null,
      reps,
      lapses,
      due,
      newPos: opts.newPos,
      lastReviewedAt: null,
      ...markers,
    };
  }

  // type 1 (learning) or 3 (relearning).
  const due = row.due >= EPOCH_SECONDS_FLOOR ? row.due * 1000 : ankiDayToMs(opts.crt, row.due);
  if (!Number.isFinite(due)) return fresh;
  return {
    ease: easeOf(row.factor, srs.startingEase),
    // A negative ivl is Anki's "seconds" form of a learning interval → 0 days.
    intervalDays: Math.min(maxIvl, Math.max(0, Math.round(row.ivl))),
    stepIndex: 0,
    reps,
    lapses,
    due,
    newPos: opts.newPos,
    lastReviewedAt: null,
    ...markers,
  };
}
