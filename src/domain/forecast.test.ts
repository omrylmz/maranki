/**
 * The due forecast of Progress "NEXT 7 DAYS" (spec §8.8, unit W4-6):
 * which cards count, which local day each one lands on, overdue on day 1,
 * buried cards on the day their bury ends, and the day labels.
 */
import { describe, expect, test } from '@jest/globals';

import { FIXED_NOW, localTime } from '../test/clock';
import { cardInLifeV3, makeDeckV3 } from '../test/factoriesV3';
import {
  dueForecast,
  FORECAST_DAYS,
  forecastDayLabel,
  forecastDayStarts,
  forecastTotal,
} from './forecast';
import type { Card, Deck, Id, LifeKey } from './model';
import { DAY, HOUR, MIN } from './types';

/** FIXED_NOW is Wednesday 10 June 2026, 09:00 local time. */
const NOW = FIXED_NOW;

const deck = makeDeckV3({ id: 'd1', name: 'German' });
const paused = makeDeckV3({ id: 'd2', name: 'Paused', active: false });
const decks: ReadonlyMap<Id, Deck> = new Map([deck, paused].map((d) => [d.id, d]));

/** A card in `kind`, due at `due`, in deck d1 unless the overrides say otherwise. */
function card(kind: LifeKey, due: number, overrides: Partial<Card> = {}): Card {
  return cardInLifeV3(kind, { deckId: 'd1', due, ...overrides }, NOW);
}

/** The counts of the 7 days, today first. */
function counts(cards: Card[], extra: Partial<Parameters<typeof dueForecast>[1]> = {}): number[] {
  return dueForecast(cards, { now: NOW, decks, ...extra }).map((d) => d.count);
}

describe('dueForecast — the days', () => {
  test('7 days, today first, with local day keys and local midnights', () => {
    const days = dueForecast([], { now: NOW, decks });
    expect(days).toHaveLength(FORECAST_DAYS);
    expect(days.map((d) => d.dayKey)).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
      '2026-06-15',
      '2026-06-16',
    ]);
    expect(days[0].start).toBe(localTime('2026-06-10', '00:00'));
    expect(days[6].start).toBe(localTime('2026-06-16', '00:00'));
    expect(days.every((d) => d.count === 0)).toBe(true);
  });

  test('a card lands on the local day of its due time', () => {
    const cards = [
      card('review', localTime('2026-06-10', '23:59')), // later today
      card('review', localTime('2026-06-11', '00:00')), // tomorrow, at midnight
      card('mastered', localTime('2026-06-13', '18:00')),
      card('review', localTime('2026-06-16', '23:59')), // the last day
    ];
    expect(counts(cards)).toEqual([1, 1, 0, 1, 0, 0, 1]);
  });

  test('an overdue card counts on day 1 ("Today")', () => {
    const cards = [card('review', NOW - 40 * DAY), card('learning', NOW - 5 * MIN), card('review', NOW + HOUR)];
    expect(counts(cards)).toEqual([3, 0, 0, 0, 0, 0, 0]);
  });

  test('a card due after the last day is not counted', () => {
    expect(counts([card('review', localTime('2026-06-17', '00:00')), card('mastered', NOW + 60 * DAY)])).toEqual([
      0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  test('a broken due time is not counted (never NaN, never a crash)', () => {
    expect(counts([card('review', Number.NaN), card('review', Number.POSITIVE_INFINITY)])).toEqual([
      0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  test('forecastTotal is the sum of the days', () => {
    const days = dueForecast([card('review', NOW), card('review', NOW + 2 * DAY), card('learning', NOW)], {
      now: NOW,
      decks,
    });
    expect(forecastTotal(days)).toBe(3);
  });
});

describe('dueForecast — which cards count (spec §8.8)', () => {
  test('only Learning, Review and Mastered cards: never New, Not started or Known', () => {
    const cards = [
      card('learning', NOW),
      card('review', NOW),
      card('mastered', NOW),
      card('new', NOW),
      card('notStarted', NOW),
      card('known', NOW),
    ];
    expect(counts(cards)[0]).toBe(3);
  });

  test('a Known card that was studied before is not counted (it is not studied any more)', () => {
    expect(counts([card('mastered', NOW, { knownAt: NOW - DAY })])[0]).toBe(0);
  });

  test('suspended cards are not counted', () => {
    expect(counts([card('review', NOW, { suspended: true }), card('review', NOW)])[0]).toBe(1);
  });

  test('a paused deck adds nothing; a card whose deck is missing adds nothing', () => {
    const cards = [card('review', NOW, { deckId: 'd2' }), card('review', NOW, { deckId: 'gone' }), card('review', NOW)];
    expect(counts(cards)[0]).toBe(1);
  });

  test('a direction that is switched off in its deck is not counted', () => {
    const twoWay = makeDeckV3({ id: 'd3', options: { directions: { 'nt-basic-reverse': [0] } } });
    const map = new Map([...decks, [twoWay.id, twoWay]]);
    const cards = [
      card('review', NOW, { deckId: 'd3', ord: 0, noteId: 'n1' }),
      card('review', NOW, { deckId: 'd3', ord: 1, noteId: 'n1' }),
      card('review', NOW, { deckId: 'd3', ord: 1, noteId: 'n-other-type' }),
    ];
    const typeIdOf = (c: Card) => (c.noteId === 'n1' ? 'nt-basic-reverse' : c.noteId === 'n-other-type' ? 'nt-basic' : undefined);
    const days = dueForecast(cards, { now: NOW, decks: map, typeIdOf });
    // ord 1 of the reverse type is off; the other card type has no entry: every direction is on.
    expect(days[0].count).toBe(2);
    // Without typeIdOf every direction counts as on.
    expect(dueForecast(cards, { now: NOW, decks: map })[0].count).toBe(3);
  });

  test('a damaged directions entry (not a list) counts every direction as on', () => {
    const broken = makeDeckV3({ id: 'd4', options: { directions: { 'nt-basic': 1 as unknown as number[] } } });
    const map = new Map([[broken.id, broken]]);
    const cards = [card('review', NOW, { deckId: 'd4', ord: 0 })];
    expect(dueForecast(cards, { now: NOW, decks: map, typeIdOf: () => 'nt-basic' })[0].count).toBe(1);
  });
});

describe('dueForecast — buried cards come back when the bury ends', () => {
  test('a card buried until tomorrow counts tomorrow, not today', () => {
    const tomorrow = localTime('2026-06-11', '04:00');
    expect(counts([card('review', NOW - DAY, { buriedUntil: tomorrow })])).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  test('a bury that already ended changes nothing', () => {
    expect(counts([card('review', NOW - DAY, { buriedUntil: NOW - HOUR })])).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });

  test('a buried card due later than the bury ends counts on its due day', () => {
    const due = localTime('2026-06-14', '10:00');
    expect(counts([card('review', due, { buriedUntil: localTime('2026-06-11', '04:00') })])).toEqual([
      0, 0, 0, 0, 1, 0, 0,
    ]);
  });
});

describe('forecastDayStarts — local midnights, also over a daylight-saving change', () => {
  test('every boundary is a local midnight, one calendar day apart', () => {
    // Late March: Europe moves its clocks; elsewhere these are plain days.
    const now = localTime('2026-03-27', '22:30');
    const starts = forecastDayStarts(now, 7);
    expect(starts).toHaveLength(8);
    for (let i = 0; i < starts.length; i++) {
      const d = new Date(starts[i]);
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
      expect(starts[i]).toBe(new Date(2026, 2, 27 + i).getTime());
    }
  });

  test('a month end rolls into the next month', () => {
    const starts = forecastDayStarts(localTime('2026-06-29', '12:00'), 3);
    expect(starts.map((ms) => new Date(ms).getDate())).toEqual([29, 30, 1, 2]);
  });

  test('days = 0 gives no day', () => {
    expect(dueForecast([card('review', NOW)], { now: NOW, decks }, 0)).toEqual([]);
  });
});

describe('forecastDayLabel', () => {
  test('"Today" first, then short weekday names', () => {
    const days = dueForecast([], { now: NOW, decks });
    expect(days.map((d, i) => forecastDayLabel(d, i))).toEqual(['Today', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue']);
  });

  test('the weekday follows the local calendar day', () => {
    const days = dueForecast([], { now: localTime('2026-06-10', '23:50'), decks });
    expect(forecastDayLabel(days[1], 1)).toBe('Thu');
  });
});
