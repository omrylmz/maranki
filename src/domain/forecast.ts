/**
 * The due forecast of Progress "NEXT 7 DAYS" (spec §8.8, unit W4-6): how
 * many cards come back on each of the next 7 local calendar days.
 *
 *   NEXT 7 DAYS   ▂ ▅ ▃ ▇ ▂ ▁ ▃
 *                 Today Thu Fri …
 *
 * Which cards count (spec §8.8):
 *   - status Learning, Review or Mastered (life.ts). New, Not started and
 *     Known cards have no review date, so they are never in the forecast;
 *   - not suspended;
 *   - the deck exists and is active (a paused deck adds nothing to Today,
 *     so it adds nothing to the forecast either);
 *   - the card's direction is on in its deck (`deck.options.directions`).
 *     A direction that is switched off never comes back, so counting it
 *     would promise reviews that never come. The rule is the same as the
 *     scheduler's (schedule.ts `directionEnabled`); it is written out here
 *     because the scheduler keeps that function private.
 *
 * Which day a card is on:
 *   - its `due` time, by LOCAL calendar day (the day boundaries are local
 *     midnights, so a daylight-saving change never moves a card to the
 *     wrong day);
 *   - an OVERDUE card (due before today) counts on day 1, "Today": it is
 *     waiting now;
 *   - a BURIED card comes back when its bury ends ("hidden until
 *     tomorrow"), so it counts on the later of its due day and the day its
 *     bury ends;
 *   - a card due after the last day is not counted; a card with a broken
 *     due time (not a finite number) is not counted either.
 *
 * This is NOT the "Study N" number. Study also has daily limits and a
 * session size; the forecast only says when cards come back. Progress shows
 * numbers only (spec §4.6): it never starts a session.
 *
 * Pure: no React, no clock (the caller passes `now`).
 */
import { life } from './life';
import type { Card, Deck, Id } from './model';
import { dayKeyOf } from './types';

/** How many days the Progress forecast shows (spec §8.8 "NEXT 7 DAYS"). */
export const FORECAST_DAYS = 7;

/** One day of the forecast. */
export interface ForecastDay {
  /** The local day, 'YYYY-MM-DD'. */
  dayKey: string;
  /** Local midnight at the start of the day (epoch ms). */
  start: number;
  /** Cards that come back on this day. The first day also holds every overdue card. */
  count: number;
}

/** What the forecast needs besides the cards. */
export interface ForecastCtx {
  now: number;
  /** Every deck by id. A card whose deck is missing is not counted. */
  decks: ReadonlyMap<Id, Deck>;
  /**
   * The card type of a card (its note's `typeId`), for the deck's
   * directions. Without it, or when it returns undefined, every direction
   * counts as on (the scheduler's rule for an unknown note).
   */
  typeIdOf?: (card: Card) => Id | undefined;
}

/**
 * The local midnights that bound the forecast days: `days + 1` numbers.
 * Day i is `[starts[i], starts[i + 1])`. Built with the Date constructor
 * from the local year, month and day, so every boundary is a real local
 * midnight, also on a daylight-saving day (that day is 23 or 25 hours long).
 *
 *   forecastDayStarts(Wed 10 Jun 2026 09:00, 2) → [Wed 00:00, Thu 00:00, Fri 00:00]
 */
export function forecastDayStarts(now: number, days: number = FORECAST_DAYS): number[] {
  const d = new Date(now);
  const out: number[] = [];
  for (let i = 0; i <= days; i++) {
    // A day of the month past its end (e.g. 31 + 3) rolls into the next month.
    out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getTime());
  }
  return out;
}

/** The statuses that have a review date. */
function isStudied(card: Card): boolean {
  const key = life(card);
  return key === 'learning' || key === 'review' || key === 'mastered';
}

/**
 * Is the card's direction on in its deck? The scheduler's rule
 * (schedule.ts `directionEnabled`): no directions map, no entry for the
 * card type, an unknown card type, or a damaged entry (not a list) all mean
 * "every direction is on".
 *
 *   directions: { 'nt-basic-reverse': [0] }  → ord 0 on, ord 1 off
 */
function directionOn(card: Card, deck: Deck, typeIdOf: ForecastCtx['typeIdOf']): boolean {
  const directions = (deck.options as Deck['options'] | undefined)?.directions;
  if (typeof directions !== 'object' || directions === null || !typeIdOf) return true;
  const typeId = typeIdOf(card);
  if (typeId === undefined) return true;
  // hasOwnProperty: a card type id is data, and 'constructor' must not find Object's function.
  const ords: unknown = Object.prototype.hasOwnProperty.call(directions, typeId) ? directions[typeId] : undefined;
  return Array.isArray(ords) ? ords.includes(card.ord) : true;
}

/**
 * The moment a card comes back: its due time, or the end of its bury when
 * that is later. null = not a usable time (a broken due).
 */
function backAt(card: Card, now: number): number | null {
  if (typeof card.due !== 'number' || !Number.isFinite(card.due)) return null;
  const buried = card.buriedUntil;
  if (typeof buried === 'number' && Number.isFinite(buried) && buried > now) return Math.max(card.due, buried);
  return card.due;
}

/**
 * The forecast: one entry per day, `days` entries, today first. One pass
 * over the cards.
 *
 *   dueForecast(cards, { now, decks }) →
 *     [{ dayKey: '2026-06-10', count: 12 }, { dayKey: '2026-06-11', count: 5 }, …]
 */
export function dueForecast(cards: readonly Card[], ctx: ForecastCtx, days: number = FORECAST_DAYS): ForecastDay[] {
  const count = Math.max(0, Math.floor(days));
  const starts = forecastDayStarts(ctx.now, count);
  const out: ForecastDay[] = [];
  for (let i = 0; i < count; i++) out.push({ dayKey: dayKeyOf(starts[i]), start: starts[i], count: 0 });
  if (count === 0) return out;
  const end = starts[count];

  for (const card of cards) {
    if (!isStudied(card) || card.suspended) continue;
    const deck = ctx.decks.get(card.deckId);
    if (!deck || deck.active === false) continue;
    if (!directionOn(card, deck, ctx.typeIdOf)) continue;
    const at = backAt(card, ctx.now);
    if (at === null || at >= end) continue;
    // Overdue and today both land on day 0; then find the day that holds `at`.
    let day = 0;
    while (day + 1 < count && at >= starts[day + 1]) day += 1;
    out[day].count += 1;
  }
  return out;
}

/** Every card of the forecast (the sum of its days). */
export function forecastTotal(days: readonly ForecastDay[]): number {
  let n = 0;
  for (const day of days) n += day.count;
  return n;
}

/** Short weekday names, Sunday first (Date.getDay order). Fixed English, like the rest of the app. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * The label under one forecast bar: "Today" for the first day, then the
 * short weekday name of the day.
 *
 *   forecastDayLabel(days[0], 0) → 'Today'
 *   forecastDayLabel(days[1], 1) → 'Thu'
 */
export function forecastDayLabel(day: Pick<ForecastDay, 'start'>, index: number): string {
  if (index === 0) return 'Today';
  return WEEKDAYS[new Date(day.start).getDay()];
}
