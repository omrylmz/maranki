/**
 * Tests for the RescheduleSheet rules (src/components/study/rescheduleLogic.ts,
 * spec §6.5, unit A1):
 *   - which cards can move (Learning / Review / Mastered only) and the
 *     "Not studied yet — nothing to reschedule" case;
 *   - the four quick choices are LOCAL calendar days: right across both
 *     daylight-saving switches, and in a zone whose midnight does not exist
 *     on the switch day; "In a month" keeps the day or uses the month's last
 *     day;
 *   - the date picker's time zone rules (Android reads and returns UTC days,
 *     iOS local time) in every zone from UTC-12 to UTC+14; the open iOS
 *     calendar is shown alone, so its Reschedule button is in view;
 *   - a picked value is CHECKED, never clamped: 1 January 1970 (Android's
 *     keyboard mode with an empty or wrong date), an Invalid Date and a day
 *     before tomorrow are rejected (pickedDue, confirmedPickDay);
 *   - the copy ("Next review: Tue 28 Oct · difficulty unchanged");
 *   - the store selector keeps the same array while nothing changed;
 *   - a choice through the REAL reducer moves `due` only, and Undo puts it back.
 *
 * Time zones: jest cannot change the time zone of its own process. So
 * `inZone` replaces the global Date for a moment by one whose LOCAL parts
 * (new Date(y, m, d), getFullYear … getDay) follow a given offset rule,
 * with a daylight-saving switch when the rule has one. The code under test
 * only uses those parts, so this is what a phone in that zone computes.
 */
import { describe, expect, it } from '@jest/globals';

import type { Card, DataStateV3 } from '../../domain/model';
import { startOfLocalDay } from '../../domain/schedule';
import { DAY, HOUR, MIN } from '../../domain/types';
import * as reducer from '../../store/reducer';
import { FIXED_NOW, localTime } from '../../test/clock';
import { cardInLifeV3, lifeValues, makeDeckV3, makeStateV3, noteWithCards, stateOfV3, testCtx } from '../../test/factoriesV3';
import {
  addLocalDays,
  addLocalMonths,
  canReschedule,
  cardsReader,
  choiceDueMs,
  clampDueDay,
  confirmedPickDay,
  formatDayShort,
  isUndoableEdit,
  NOTHING_TO_RESCHEDULE,
  pickedDayStart,
  pickedDue,
  pickerMinimumDate,
  pickerPresentation,
  pickerStartDay,
  pickerValue,
  RESCHEDULE_CHOICE_IDS,
  rescheduleChoices,
  rescheduleIntro,
  rescheduleSnack,
  rescheduleTargets,
  rescheduleView,
  skippedNote,
  startOfTomorrow,
  undoManualEditAndReport,
} from './rescheduleLogic';

/* ------------------------------------------------------------ timing */

/**
 * The CPU time this process has used, in ms (the wall clock where
 * `process.cpuUsage` is missing). CPU time, not the wall clock: the time the
 * test waits while other programs use the processor is not counted.
 */
const clockMs = (): number => {
  if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
  }
  return Date.now();
};

/** One run: the CPU time of one call of `fn` in ms, the call repeated for at least 10 ms. */
function runMs(fn: () => void): number {
  let calls = 0;
  let elapsed = 0;
  const start = clockMs();
  do {
    fn();
    calls += 1;
    elapsed = clockMs() - start;
  } while (elapsed < 10);
  return elapsed / calls;
}

/**
 * How many times longer the BIG input (4 × the small one) takes: linear work
 * ≈ 4, quadratic work ≈ 16. Robust on a busy machine: the two sizes are
 * measured in turns (big, small, big, small …), the fastest of 5 runs per
 * size counts, and a spoiled try is measured again (up to 3 tries).
 */
function linearRatio(small: () => void, big: () => void): number {
  small(); // warm up
  big();
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3 && best >= 10; attempt++) {
    let bigMs = Number.POSITIVE_INFINITY;
    let smallMs = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn < 5; turn++) {
      bigMs = Math.min(bigMs, runMs(big));
      smallMs = Math.min(smallMs, runMs(small));
    }
    best = Math.min(best, bigMs / smallMs);
  }
  return best;
}

/* ------------------------------------------------------------ simulated time zones */

/** Minutes EAST of UTC at a UTC instant. */
type OffsetRule = (utcMs: number) => number;

/**
 * Run `fn` as if the phone were in a zone with the offset rule `offsetAt`.
 * Local parts → instant follows JS: a local time that exists twice (autumn)
 * takes the earlier instant; a local time that does not exist (spring) is
 * read with the offset from before the switch, so it lands after the gap.
 */
function inZone<T>(offsetAt: OffsetRule, fn: () => T): T {
  const RealDate = Date;
  const local = (ms: number) => new RealDate(ms + offsetAt(ms) * MIN);
  const fromLocal = (parts: number[]): number => {
    const wall = RealDate.UTC(parts[0], parts[1], parts[2] ?? 1, parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0, parts[6] ?? 0);
    const before = offsetAt(wall - DAY);
    const after = offsetAt(wall + DAY);
    for (const offset of [before, after]) {
      const utc = wall - offset * MIN;
      if (offsetAt(utc) === offset) return utc;
    }
    return wall - before * MIN;
  };
  class ZonedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now());
      else if (args.length === 1) super(args[0] as number);
      else super(fromLocal(args as number[]));
    }
    getFullYear() {
      return local(this.getTime()).getUTCFullYear();
    }
    getMonth() {
      return local(this.getTime()).getUTCMonth();
    }
    getDate() {
      return local(this.getTime()).getUTCDate();
    }
    getDay() {
      return local(this.getTime()).getUTCDay();
    }
    getHours() {
      return local(this.getTime()).getUTCHours();
    }
    getMinutes() {
      return local(this.getTime()).getUTCMinutes();
    }
    getSeconds() {
      return local(this.getTime()).getUTCSeconds();
    }
  }
  globalThis.Date = ZonedDate as unknown as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** A fixed offset (no daylight saving). */
const fixed = (minutes: number): OffsetRule => () => minutes;

/** Berlin in 2026: CET (+60), CEST (+120) from 29 March 01:00 UTC to 25 October 01:00 UTC. */
const berlin: OffsetRule = (utc) =>
  utc >= Date.UTC(2026, 2, 29, 1) && utc < Date.UTC(2026, 9, 25, 1) ? 120 : 60;

/** Santiago de Chile in 2026: -240, then -180 from 6 September 04:00 UTC (local midnight does not exist that day). */
const santiago: OffsetRule = (utc) => (utc >= Date.UTC(2026, 8, 6, 4) ? -180 : -240);

/** The local wall time of an instant in a zone, as 'YYYY-MM-DD HH:mm'. */
function wall(offsetAt: OffsetRule, ms: number): string {
  const d = new Date(ms + offsetAt(ms) * MIN);
  const two = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/* ------------------------------------------------------------ which cards move */

describe('canReschedule / rescheduleTargets', () => {
  it('only Learning, Review and Mastered cards have a schedule to move', () => {
    expect(canReschedule(cardInLifeV3('learning'))).toBe(true);
    expect(canReschedule(cardInLifeV3('review'))).toBe(true);
    expect(canReschedule(cardInLifeV3('mastered'))).toBe(true);
    expect(canReschedule(cardInLifeV3('new'))).toBe(false);
    expect(canReschedule(cardInLifeV3('notStarted'))).toBe(false);
    expect(canReschedule(cardInLifeV3('known'))).toBe(false);
    // A studied card that was then marked Known has no schedule to move either (Known wins).
    expect(canReschedule(cardInLifeV3('review', { knownAt: FIXED_NOW }))).toBe(false);
  });

  it('counts the cards without a schedule; a deleted card (null) is not counted', () => {
    const review = cardInLifeV3('review', { id: 'r' });
    const fresh = cardInLifeV3('new', { id: 'n' });
    const known = cardInLifeV3('known', { id: 'k' });
    expect(rescheduleTargets([review, fresh, null, known, undefined])).toEqual({ ids: ['r'], dues: [review.due], skipped: 2 });
    expect(rescheduleTargets([fresh])).toEqual({ ids: [], dues: [], skipped: 1 });
    expect(rescheduleTargets([])).toEqual({ ids: [], dues: [], skipped: 0 });
  });

  it('gives the due of each card that can move, in the order asked (dues[i] belongs to ids[i])', () => {
    const a = cardInLifeV3('review', { id: 'a', due: FIXED_NOW + 3 * DAY });
    const b = cardInLifeV3('learning', { id: 'b', due: FIXED_NOW + 10 * MIN });
    const c = cardInLifeV3('mastered', { id: 'c', due: FIXED_NOW + 40 * DAY });
    const fresh = cardInLifeV3('new', { id: 'n' });
    expect(rescheduleTargets([c, fresh, a, null, b])).toEqual({
      ids: ['c', 'a', 'b'],
      dues: [c.due, a.due, b.due],
      skipped: 1,
    });
  });

  it('a Library selection of 20,000 cards: one pass, so a bigger selection costs only a little more', () => {
    // Every 4th card is New (skipped); the others are Review cards with their own due day.
    const cardsOf = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        i % 4 === 3
          ? cardInLifeV3('new', { id: `c${i}` })
          : cardInLifeV3('review', { id: `c${i}`, due: FIXED_NOW + (i % 30) * DAY }),
      );
    const big = cardsOf(20_000);
    const out = rescheduleTargets(big);
    expect(out.ids).toHaveLength(15_000);
    expect(out.skipped).toBe(5_000);
    // In input order, and each due belongs to its card.
    expect(out.ids.slice(0, 4)).toEqual(['c0', 'c1', 'c2', 'c4']);
    const dueOf = new Map(big.map((card) => [card.id, card.due]));
    expect(out.dues.every((due, i) => due === dueOf.get(out.ids[i]))).toBe(true);
    // Linear, not cards × ids: 4 times the cards take far less than 16 times as long.
    // (The old `ids.includes` search took about 2.4 s for 16,000 cards.)
    const small = cardsOf(5_000);
    expect(linearRatio(() => rescheduleTargets(small), () => rescheduleTargets(big))).toBeLessThan(10);
  });

  it('has the exact copy of spec §6.5', () => {
    expect(NOTHING_TO_RESCHEDULE).toBe('Not studied yet — nothing to reschedule');
    expect(skippedNote(0)).toBeNull();
    expect(skippedNote(1)).toBe('1 card is not studied yet and stays as it is.');
    expect(skippedNote(3)).toBe('3 cards are not studied yet and stay as they are.');
  });
});

/* ------------------------------------------------------------ calendar days */

describe('the quick choices are local calendar days', () => {
  const now = localTime('2026-06-10', '15:30'); // Wednesday afternoon

  it('Tomorrow · In 3 days · In a week · In a month → the START of that local day', () => {
    const choices = rescheduleChoices(now);
    expect(choices.map((c) => c.id)).toEqual([...RESCHEDULE_CHOICE_IDS]);
    expect(choices.map((c) => c.title)).toEqual(['Tomorrow', 'In 3 days', 'In a week', 'In a month']);
    expect(choices.map((c) => c.dueMs)).toEqual([
      localTime('2026-06-11', '00:00'),
      localTime('2026-06-13', '00:00'),
      localTime('2026-06-17', '00:00'),
      localTime('2026-07-10', '00:00'),
    ]);
    expect(choices.map((c) => c.dateLabel)).toEqual(['Thu 11 Jun', 'Sat 13 Jun', 'Wed 17 Jun', 'Fri 10 Jul']);
    for (const c of choices) expect(c.dueMs).toBe(startOfLocalDay(c.dueMs));
  });

  it('just before midnight, "Tomorrow" is the next calendar day (not 24 hours later)', () => {
    const late = localTime('2026-06-10', '23:59');
    expect(choiceDueMs('tomorrow', late)).toBe(localTime('2026-06-11', '00:00'));
    expect(startOfTomorrow(late)).toBe(localTime('2026-06-11', '00:00'));
    const early = localTime('2026-06-11', '00:01');
    expect(choiceDueMs('tomorrow', early)).toBe(localTime('2026-06-12', '00:00'));
  });

  it('"In a month" keeps the day, or takes the last day of a shorter month', () => {
    expect(addLocalMonths(localTime('2026-01-31', '10:00'), 1)).toBe(localTime('2026-02-28', '00:00'));
    expect(addLocalMonths(localTime('2028-01-31', '10:00'), 1)).toBe(localTime('2028-02-29', '00:00')); // leap year
    expect(addLocalMonths(localTime('2026-03-31', '10:00'), 1)).toBe(localTime('2026-04-30', '00:00'));
    expect(addLocalMonths(localTime('2026-12-15', '10:00'), 1)).toBe(localTime('2027-01-15', '00:00'));
    expect(addLocalMonths(localTime('2026-08-31', '10:00'), 1)).toBe(localTime('2026-09-30', '00:00'));
  });

  it('autumn DST switch (Berlin, 25 Oct 2026): "In a week" is local midnight 7 days later, not 7 × 24 h', () => {
    inZone(berlin, () => {
      const now = new Date(2026, 9, 24, 12, 0).getTime(); // Sat 24 Oct, 12:00 CEST
      const week = choiceDueMs('inWeek', now);
      expect(wall(berlin, week)).toBe('2026-10-31 00:00');
      // The naive sum lands on the evening before (the day of the switch has 25 hours).
      expect(wall(berlin, startOfLocalDay(now) + 7 * DAY)).toBe('2026-10-30 23:00');
      expect(wall(berlin, choiceDueMs('tomorrow', now))).toBe('2026-10-25 00:00');
      expect(wall(berlin, choiceDueMs('in3days', now))).toBe('2026-10-27 00:00');
      expect(formatDayShort(week, now)).toBe('Sat 31 Oct');
      expect(rescheduleSnack(week, now)).toBe('Next review: Sat 31 Oct · difficulty unchanged');
    });
  });

  it('spring DST switch (Berlin, 29 Mar 2026): every choice is still local midnight', () => {
    inZone(berlin, () => {
      const now = new Date(2026, 2, 28, 20, 0).getTime(); // Sat 28 Mar, 20:00 CET
      expect(wall(berlin, choiceDueMs('tomorrow', now))).toBe('2026-03-29 00:00');
      expect(wall(berlin, choiceDueMs('in3days', now))).toBe('2026-03-31 00:00');
      expect(wall(berlin, choiceDueMs('inWeek', now))).toBe('2026-04-04 00:00');
      expect(wall(berlin, choiceDueMs('inMonth', now))).toBe('2026-04-28 00:00');
      // The day of the switch has 23 hours: 3 × 24 h would be 01:00 on Tuesday.
      expect(wall(berlin, startOfLocalDay(now) + 3 * DAY)).toBe('2026-03-31 01:00');
    });
  });

  it('a zone whose midnight does not exist on the switch day (Santiago, 6 Sep 2026): the first moment of that day', () => {
    inZone(santiago, () => {
      const now = new Date(2026, 8, 5, 18, 0).getTime(); // Sat 5 Sep, 18:00
      const tomorrow = choiceDueMs('tomorrow', now);
      expect(wall(santiago, tomorrow)).toBe('2026-09-06 01:00');
      expect(tomorrow).toBe(startOfLocalDay(tomorrow));
      expect(formatDayShort(tomorrow, now)).toBe('Sun 6 Sep');
      expect(wall(santiago, choiceDueMs('in3days', now))).toBe('2026-09-08 00:00');
      // The clamp agrees: the start of that day IS 01:00.
      expect(clampDueDay(new Date(2026, 8, 6, 15).getTime(), now)).toBe(tomorrow);
    });
  });

  it('addLocalDays goes back too, and keeps the start of the day', () => {
    const now = localTime('2026-06-10', '15:30');
    expect(addLocalDays(now, 0)).toBe(localTime('2026-06-10', '00:00'));
    expect(addLocalDays(now, -1)).toBe(localTime('2026-06-09', '00:00'));
    expect(addLocalDays(now, 30)).toBe(localTime('2026-07-10', '00:00'));
  });
});

describe('clampDueDay', () => {
  const now = localTime('2026-06-10', '15:30');

  it('a future day → the start of that day', () => {
    expect(clampDueDay(localTime('2026-06-20', '17:45'), now)).toBe(localTime('2026-06-20', '00:00'));
  });

  it('today or the past → tomorrow (a reschedule never makes a card due at once)', () => {
    expect(clampDueDay(localTime('2026-06-10', '23:00'), now)).toBe(localTime('2026-06-11', '00:00'));
    expect(clampDueDay(localTime('2025-01-01', '10:00'), now)).toBe(localTime('2026-06-11', '00:00'));
  });

  it('a value that is not a number → null (a NaN due date would break the scheduler)', () => {
    expect(clampDueDay(Number.NaN, now)).toBeNull();
    expect(clampDueDay(Number.POSITIVE_INFINITY, now)).toBeNull();
    expect(clampDueDay(localTime('2026-06-20'), Number.NaN)).toBeNull();
  });
});

/* ------------------------------------------------------------ copy */

describe('dates and lines as text', () => {
  const now = localTime('2026-10-24', '10:00'); // a Saturday

  it('formatDayShort: "Tue 28 Oct", with the year only when it is another year', () => {
    expect(formatDayShort(localTime('2026-10-28'), now)).toBe('Wed 28 Oct');
    expect(formatDayShort(localTime('2026-10-27'))).toBe('Tue 27 Oct');
    expect(formatDayShort(localTime('2027-01-05'), now)).toBe('Tue 5 Jan 2027');
  });

  it('rescheduleSnack is the exact copy of spec §6.5', () => {
    expect(rescheduleSnack(localTime('2026-10-27', '00:00'), now)).toBe('Next review: Tue 27 Oct · difficulty unchanged');
  });

  it('rescheduleIntro says when the card is due now', () => {
    const rest = 'The difficulty stays the same.';
    expect(rescheduleIntro([now - HOUR], now)).toBe(`Due now. ${rest}`);
    expect(rescheduleIntro([now + 10 * MIN], now)).toBe(`Due later today. ${rest}`);
    expect(rescheduleIntro([localTime('2026-10-25', '08:00')], now)).toBe(`Due tomorrow. ${rest}`);
    expect(rescheduleIntro([localTime('2026-10-31', '08:00')], now)).toBe(`Due Sat 31 Oct. ${rest}`);
    expect(rescheduleIntro([now, now + DAY, now + 2 * DAY], now)).toBe(`3 cards. ${rest}`);
    expect(rescheduleIntro([Number.NaN], now)).toBe(`Due now. ${rest}`);
  });
});

/* ------------------------------------------------------------ the date picker */

describe('the date picker', () => {
  it('is a dialog on Android, inline on iOS, and not offered on the web', () => {
    expect(pickerPresentation('android')).toBe('dialog');
    expect(pickerPresentation('ios')).toBe('inline');
    expect(pickerPresentation('web')).toBeNull();
  });

  it('iOS: the open inline calendar is shown ALONE (no intro, no rows), so it and its button are in view', () => {
    const day = localTime('2026-06-20', '00:00');
    // The calendar is open (a day is picked) → only the calendar.
    expect(rescheduleView(1, 'inline', day)).toBe('calendar');
    // Closed (Cancel, or not opened yet) → the intro and the rows.
    expect(rescheduleView(1, 'inline', null)).toBe('choices');
    // Android: the picker is a dialog OVER the sheet, so the rows stay under it.
    expect(rescheduleView(1, 'dialog', day)).toBe('choices');
    expect(rescheduleView(3, null, null)).toBe('choices');
    // No card with a schedule: the note, never the calendar.
    expect(rescheduleView(0, 'inline', day)).toBe('nothing');
    expect(rescheduleView(0, 'dialog', null)).toBe('nothing');
  });

  it('opens on the card’s next review when that is tomorrow or later, else on tomorrow', () => {
    const now = localTime('2026-06-10', '15:30');
    expect(pickerStartDay([localTime('2026-06-20', '09:00')], now)).toBe(localTime('2026-06-20', '00:00'));
    expect(pickerStartDay([now - DAY], now)).toBe(localTime('2026-06-11', '00:00'));
    expect(pickerStartDay([now + HOUR], now)).toBe(localTime('2026-06-11', '00:00'));
    // Several cards: tomorrow.
    expect(pickerStartDay([localTime('2026-06-20'), localTime('2026-06-21')], now)).toBe(localTime('2026-06-11', '00:00'));
    expect(pickerMinimumDate(now).getTime()).toBe(localTime('2026-06-11', '00:00'));
  });

  it('Android: the value is UTC noon of the local day, and a picked UTC day maps back to that LOCAL day — in every zone', () => {
    for (let hours = -12; hours <= 14; hours += 1) {
      const rule = fixed(hours * 60);
      inZone(rule, () => {
        const day = new Date(2026, 9, 31).getTime(); // local 31 Oct
        const value = pickerValue(day, 'android');
        expect([value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), value.getUTCHours()]).toEqual([
          2026, 9, 31, 12,
        ]);
        // Material returns UTC midnight of the picked day.
        const picked = pickedDayStart(new Date(Date.UTC(2026, 9, 31)), 'android');
        expect(wall(rule, picked)).toBe('2026-10-31 00:00');
        // The naive reading would be the day before west of UTC.
        if (hours < 0) expect(wall(rule, startOfLocalDay(Date.UTC(2026, 9, 31)))).toBe('2026-10-30 00:00');
      });
    }
  });

  it('iOS: local noon in, the local day of the picked time out — in every zone', () => {
    for (let hours = -12; hours <= 14; hours += 1) {
      const rule = fixed(hours * 60);
      inZone(rule, () => {
        const day = new Date(2026, 9, 31).getTime();
        const value = pickerValue(day, 'ios');
        expect(wall(rule, value.getTime())).toBe('2026-10-31 12:00');
        expect(wall(rule, pickedDayStart(value, 'ios'))).toBe('2026-10-31 00:00');
        expect(wall(rule, pickedDayStart(new Date(2026, 9, 31, 23, 59), 'ios'))).toBe('2026-10-31 00:00');
      });
    }
  });

  it('Android across the autumn DST switch: the picked Sunday is Sunday 00:00 local', () => {
    inZone(berlin, () => {
      const picked = pickedDayStart(new Date(Date.UTC(2026, 9, 25)), 'android');
      expect(wall(berlin, picked)).toBe('2026-10-25 00:00');
      const value = pickerValue(picked, 'android');
      expect(value.toISOString()).toBe('2026-10-25T12:00:00.000Z');
    });
  });
});

describe('pickedDue / confirmedPickDay — a picked value is checked, never moved to another day', () => {
  const now = localTime('2026-06-10', '15:30');

  it('1 January 1970 is rejected: Android sends it for an empty or wrong typed date (`new Date(null)`)', () => {
    expect(new Date(null as unknown as number).getTime()).toBe(0); // what the @expo/ui wrapper builds
    expect(pickedDue(new Date(0), 'android', now)).toBeNull();
    expect(pickedDue(new Date(0), 'ios', now)).toBeNull();
    // The old path clamped it to tomorrow, a day the learner never picked.
    expect(clampDueDay(pickedDayStart(new Date(0), 'android'), now)).toBe(startOfTomorrow(now));
  });

  it('a missing value, an Invalid Date, a time before 1970 or a broken clock is rejected', () => {
    expect(pickedDue(null, 'android', now)).toBeNull();
    expect(pickedDue(undefined, 'ios', now)).toBeNull();
    expect(pickedDue(new Date(Number.NaN), 'android', now)).toBeNull();
    expect(pickedDue(new Date(-DAY), 'android', now)).toBeNull();
    expect(pickedDue(new Date(Date.UTC(2026, 5, 20)), 'android', Number.NaN)).toBeNull();
  });

  it('a day before tomorrow is rejected: today, yesterday, a typed 01/01/2020', () => {
    expect(pickedDue(new Date(Date.UTC(2026, 5, 10)), 'android', now)).toBeNull(); // today
    expect(pickedDue(new Date(Date.UTC(2026, 5, 9)), 'android', now)).toBeNull();
    expect(pickedDue(new Date(Date.UTC(2020, 0, 1)), 'android', now)).toBeNull();
    expect(pickedDue(new Date(2026, 5, 10, 23, 59), 'ios', now)).toBeNull();
    expect(pickedDue(new Date(2020, 0, 1, 12), 'ios', now)).toBeNull();
  });

  it('tomorrow and later → the start of that LOCAL day', () => {
    expect(pickedDue(new Date(Date.UTC(2026, 5, 11)), 'android', now)).toBe(localTime('2026-06-11', '00:00'));
    expect(pickedDue(new Date(Date.UTC(2026, 5, 20)), 'android', now)).toBe(localTime('2026-06-20', '00:00'));
    expect(pickedDue(new Date(2026, 5, 11, 12), 'ios', now)).toBe(localTime('2026-06-11', '00:00'));
    expect(pickedDue(new Date(2027, 0, 5, 18), 'ios', now)).toBe(localTime('2027-01-05', '00:00'));
  });

  it('tomorrow is accepted and today rejected late in the evening — in every zone from UTC-12 to UTC+14', () => {
    for (let hours = -12; hours <= 14; hours += 1) {
      const rule = fixed(hours * 60);
      inZone(rule, () => {
        const at = new Date(2026, 9, 24, 23, 30).getTime(); // Sat 24 Oct, 23:30 local
        expect(wall(rule, pickedDue(new Date(Date.UTC(2026, 9, 25)), 'android', at)!)).toBe('2026-10-25 00:00');
        expect(pickedDue(new Date(Date.UTC(2026, 9, 24)), 'android', at)).toBeNull();
        expect(wall(rule, pickedDue(new Date(2026, 9, 25, 12), 'ios', at)!)).toBe('2026-10-25 00:00');
        expect(pickedDue(new Date(2026, 9, 24, 12), 'ios', at)).toBeNull();
        expect(pickedDue(new Date(0), 'android', at)).toBeNull();
      });
    }
  });

  it('across both DST switches (Berlin) and on a day without a midnight (Santiago)', () => {
    inZone(berlin, () => {
      const autumn = new Date(2026, 9, 24, 12).getTime(); // the day before the 25-hour day
      expect(wall(berlin, pickedDue(new Date(Date.UTC(2026, 9, 25)), 'android', autumn)!)).toBe('2026-10-25 00:00');
      expect(wall(berlin, pickedDue(new Date(Date.UTC(2026, 9, 26)), 'android', autumn)!)).toBe('2026-10-26 00:00');
      expect(wall(berlin, pickedDue(new Date(2026, 9, 25, 12), 'ios', autumn)!)).toBe('2026-10-25 00:00');
      const spring = new Date(2026, 2, 28, 20).getTime(); // the evening before the 23-hour day
      expect(wall(berlin, pickedDue(new Date(Date.UTC(2026, 2, 29)), 'android', spring)!)).toBe('2026-03-29 00:00');
      expect(pickedDue(new Date(Date.UTC(2026, 2, 28)), 'android', spring)).toBeNull();
    });
    inZone(santiago, () => {
      const at = new Date(2026, 8, 5, 18).getTime(); // Sat 5 Sep, 18:00
      const due = pickedDue(new Date(Date.UTC(2026, 8, 6)), 'android', at)!;
      expect(wall(santiago, due)).toBe('2026-09-06 01:00'); // the first moment of that day
      expect(due).toBe(startOfTomorrow(at));
    });
  });

  it('confirmedPickDay: the iOS "Reschedule" checks the day again (midnight may have passed)', () => {
    const picked = localTime('2026-06-11', '00:00');
    expect(confirmedPickDay(picked, localTime('2026-06-10', '23:59'))).toBe(picked);
    // After midnight the picked day is today: rejected, not moved to the next day.
    expect(confirmedPickDay(picked, localTime('2026-06-11', '00:01'))).toBeNull();
    expect(confirmedPickDay(localTime('2026-06-20', '15:00'), now)).toBe(localTime('2026-06-20', '00:00'));
    expect(confirmedPickDay(Number.NaN, now)).toBeNull();
    expect(confirmedPickDay(picked, Number.NaN)).toBeNull();
  });
});

/* ------------------------------------------------------------ store helpers */

describe('cardsReader', () => {
  const deck = makeDeckV3({ id: 'd1' });
  const a = noteWithCards({ deckId: 'd1', note: { id: 'na' }, card: { ...lifeValues('review'), id: 'ca' } });
  const b = noteWithCards({ deckId: 'd1', note: { id: 'nb' }, card: { id: 'cb' } });
  const state = stateOfV3({ decks: [deck], groups: [a, b] });

  it('returns the cards in order, null for a missing id', () => {
    const read = cardsReader(JSON.stringify(['cb', 'gone', 'ca']));
    expect(read(state).map((c) => c?.id ?? null)).toEqual(['cb', null, 'ca']);
  });

  it('keeps the SAME array while the cards are the same objects, a new one when one changed', () => {
    const read = cardsReader(JSON.stringify(['ca']));
    const first = read(state);
    // A change to ANOTHER card: a new cards array, the same card object.
    const other = { ...state, cards: state.cards.map((c) => (c.id === 'cb' ? { ...c, fav: true } : c)) };
    expect(read(other)).toBe(first);
    const changed = { ...state, cards: state.cards.map((c) => (c.id === 'ca' ? { ...c, due: c.due + DAY } : c)) };
    const next = read(changed);
    expect(next).not.toBe(first);
    expect(next[0]?.due).toBe(first[0]!.due + DAY);
  });

  it('a broken key reads no cards (never throws)', () => {
    expect(cardsReader('not json')(state)).toEqual([]);
    expect(cardsReader('{"a":1}')(state)).toEqual([]);
    expect(cardsReader(JSON.stringify(['ca', 7, null]))(state).map((c) => c?.id)).toEqual(['ca']);
  });
});

describe('isUndoableEdit / undoManualEditAndReport', () => {
  it('an edit is undoable only while it is in the log', () => {
    expect(isUndoableEdit([{ id: 'e1' }, { id: 'e2' }], 'e2')).toBe(true);
    expect(isUndoableEdit([{ id: 'e1' }], 'e9')).toBe(false);
    expect(isUndoableEdit(undefined, 'e1')).toBe(false);
    expect(isUndoableEdit([{ id: '' }], '')).toBe(false);
  });

  it('reports the partial-undo text only when cards were studied since', () => {
    const reports: string[] = [];
    const full = undoManualEditAndReport(() => ({ reverted: 1, skipped: 0 }), 'e1', (t) => reports.push(t));
    expect(full).toEqual({ reverted: 1, skipped: 0 });
    expect(reports).toEqual([]);
    undoManualEditAndReport(() => ({ reverted: 0, skipped: 1 }), 'e1', (t) => reports.push(t));
    expect(reports).toEqual(['Undone for 0 cards. 1 was studied since and was not changed back.']);
  });
});

/* ------------------------------------------------------------ through the real reducer */

describe('a choice through the real reducer (reschedule + undoManualEdit)', () => {
  const now = FIXED_NOW;
  const deck = makeDeckV3({ id: 'd1' });
  const group = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { ...lifeValues('review', now), id: 'c1' } });
  const state: DataStateV3 = stateOfV3({ decks: [deck], groups: [group] });
  const before = state.cards[0];

  it('moves due ONLY to the start of the chosen day; interval and ease stay; Undo puts due back', () => {
    const dueMs = choiceDueMs('inWeek', now);
    const step = reducer.reschedule(state, { cardIds: ['c1'], dueMs }, testCtx(now));
    const moved = step.state.cards[0];
    expect(moved.due).toBe(dueMs);
    expect(moved.due).toBe(startOfLocalDay(now + 7 * DAY));
    const { due: _due, ...restAfter } = moved;
    const { due: _dueBefore, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(isUndoableEdit(step.state.manualLog, step.result.edit.id)).toBe(true);

    const undone = reducer.undoManualEdit(step.state, { editId: step.result.edit.id }, testCtx(now + MIN));
    expect(undone.result).toEqual({ reverted: 1, skipped: 0 });
    expect(undone.state.cards[0].due).toBe(before.due);
  });

  it('a New card is skipped by the reducer too (the sheet does not offer it)', () => {
    const fresh = noteWithCards({ deckId: 'd1', note: { id: 'n2' }, card: { id: 'c2' } });
    const withNew = stateOfV3({ decks: [deck], groups: [fresh] });
    const card: Card = withNew.cards[0];
    expect(canReschedule(card)).toBe(false);
    const step = reducer.reschedule(withNew, { cardIds: ['c2'], dueMs: choiceDueMs('tomorrow', now) }, testCtx(now));
    expect(step.state.cards[0].due).toBe(card.due);
    expect(step.result.skipped).toBe(1);
    expect(isUndoableEdit(step.state.manualLog, step.result.edit.id)).toBe(false);
  });

  it('an empty state has nothing to move', () => {
    expect(rescheduleTargets(cardsReader(JSON.stringify(['x']))(makeStateV3()))).toEqual({ ids: [], dues: [], skipped: 0 });
  });
});
