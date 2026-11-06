/**
 * Tests for the pure reminder plan (spec §8.7, unit W1-6).
 *
 * All moments are LOCAL times built with `localTime()` from the test clock, so
 * "20:00" means 20:00 on the phone, in whatever time zone the test runs.
 */
import { describe, expect, test } from '@jest/globals';

import { addDays, DAY, dayKeyOf } from '../domain/types';
import { rollStreak } from '../store/tally';
import { makePerson } from '../test/factories';
import { localTime } from '../test/clock';
import {
  DEFAULT_REMINDER_TIME,
  parseReminderTime,
  planReminders,
  REMINDER_DAYS,
  REMINDER_STUDIED_BODY,
  REMINDER_TITLE,
  reminderContent,
  reminderContentFor,
  ReminderPlanOptions,
  streakAliveOn,
  studiedOn,
} from './reminderPlan';

const TODAY = '2026-10-21';

function opts(overrides: Partial<ReminderPlanOptions> = {}): ReminderPlanOptions {
  return { enabled: true, time: '20:00', skipStudied: true, lastStudyDay: null, ...overrides };
}

/** 'YYYY-MM-DD HH:MM' in local time, easy to read in a failing test. */
function show(date: Date): string {
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  return `${dayKeyOf(date.getTime())} ${hh}:${mm}`;
}

describe('planReminders', () => {
  test('plans 14 dates, one per day, at the reminder time', () => {
    const dates = planReminders(localTime(TODAY, '09:00'), opts());
    expect(dates).toHaveLength(REMINDER_DAYS);
    expect(REMINDER_DAYS).toBe(14);
    dates.forEach((date, i) => {
      expect(show(date)).toBe(`${addDays(TODAY, i)} 20:00`);
    });
  });

  test('today is included when the time is still ahead', () => {
    const dates = planReminders(localTime(TODAY, '19:59'), opts());
    expect(show(dates[0])).toBe(`${TODAY} 20:00`);
  });

  test('a time that has passed (or is now) starts from tomorrow', () => {
    const passed = planReminders(localTime(TODAY, '20:01'), opts());
    expect(show(passed[0])).toBe(`${addDays(TODAY, 1)} 20:00`);
    expect(passed).toHaveLength(14);
    expect(show(passed[13])).toBe(`${addDays(TODAY, 14)} 20:00`);

    // Exactly now is not "ahead": a reminder for this very minute would be late.
    const exactly = planReminders(localTime(TODAY, '20:00'), opts());
    expect(show(exactly[0])).toBe(`${addDays(TODAY, 1)} 20:00`);
  });

  test('today is skipped when the learner studied today and skip is on', () => {
    const dates = planReminders(localTime(TODAY, '09:00'), opts({ lastStudyDay: TODAY }));
    expect(show(dates[0])).toBe(`${addDays(TODAY, 1)} 20:00`);
    expect(dates).toHaveLength(14);
  });

  test('today stays when the learner studied today but skip is off', () => {
    const dates = planReminders(localTime(TODAY, '09:00'), opts({ lastStudyDay: TODAY, skipStudied: false }));
    expect(show(dates[0])).toBe(`${TODAY} 20:00`);
  });

  test('studying yesterday does not skip today', () => {
    const dates = planReminders(localTime(TODAY, '09:00'), opts({ lastStudyDay: addDays(TODAY, -1) }));
    expect(show(dates[0])).toBe(`${TODAY} 20:00`);
  });

  test('empty when reminders are off', () => {
    expect(planReminders(localTime(TODAY, '09:00'), opts({ enabled: false }))).toEqual([]);
  });

  test('empty when now is not a real time', () => {
    expect(planReminders(Number.NaN, opts())).toEqual([]);
  });

  test('every date is in the future', () => {
    const now = localTime(TODAY, '23:59');
    for (const date of planReminders(now, opts({ time: '23:59' }))) {
      expect(date.getTime()).toBeGreaterThan(now);
    }
  });

  test('crosses month and year ends by calendar day', () => {
    const dates = planReminders(localTime('2026-12-25', '21:00'), opts({ time: '07:30' }));
    expect(show(dates[0])).toBe('2026-12-26 07:30');
    expect(show(dates[6])).toBe('2027-01-01 07:30');
    expect(show(dates[13])).toBe('2027-01-08 07:30');
  });

  test('an early-morning time and a one-digit hour', () => {
    const dates = planReminders(localTime(TODAY, '06:00'), opts({ time: '6:05' }));
    expect(show(dates[0])).toBe(`${TODAY} 06:05`);
  });

  test('an invalid time falls back to the default time', () => {
    const fallback = planReminders(localTime(TODAY, '09:00'), opts({ time: '25:99' }));
    const expected = planReminders(localTime(TODAY, '09:00'), opts({ time: DEFAULT_REMINDER_TIME }));
    expect(fallback.map(show)).toEqual(expected.map(show));
    expect(planReminders(localTime(TODAY, '09:00'), opts({ time: '' })).map(show)).toEqual(expected.map(show));
  });

  test('a time that is not a string (old or hand-edited data) falls back too, without throwing', () => {
    const expected = planReminders(localTime(TODAY, '09:00'), opts({ time: DEFAULT_REMINDER_TIME }));
    expect(show(expected[0])).toBe(`${TODAY} 20:00`);
    for (const bad of [undefined, null, 2000, {}]) {
      const time = bad as unknown as string; // what a typed cast at a call site would hand over
      expect(planReminders(localTime(TODAY, '09:00'), opts({ time })).map(show)).toEqual(expected.map(show));
    }
  });

  test('does not change its input and gives the same plan twice (pure)', () => {
    const input = opts({ lastStudyDay: TODAY });
    const copy = { ...input };
    const now = localTime(TODAY, '09:00');
    expect(planReminders(now, input).map(show)).toEqual(planReminders(now, input).map(show));
    expect(input).toEqual(copy);
  });
});

/**
 * Daylight saving time (DST). Jest cannot change the time zone of a running
 * test, so this test FINDS the DST switches of the zone it runs in (for
 * example the last Sundays of March and October in Europe). On a machine
 * without DST (UTC, often CI) it still checks the wall-time rule on a plain
 * month; on a DST machine it also proves that the plan really crossed a 23- or
 * 25-hour day.
 */
describe('planReminders across a daylight-saving switch', () => {
  /** Day keys whose length is not 24 hours, in the current time zone. */
  function dstSwitchDays(year: number): string[] {
    const days: string[] = [];
    for (let d = 1; d <= 366; d++) {
      const start = new Date(year, 0, d).getTime();
      const next = new Date(year, 0, d + 1).getTime();
      if (next - start !== DAY) days.push(dayKeyOf(start));
    }
    return days;
  }

  const switches = dstSwitchDays(2026);
  const starts = switches.length > 0 ? switches.map((day) => addDays(day, -3)) : ['2026-03-26'];

  test.each(starts)('from %s: every reminder keeps 20:00 local time', (start) => {
    const dates = planReminders(localTime(start, '09:00'), opts());
    expect(dates).toHaveLength(14);
    dates.forEach((date, i) => {
      expect(show(date)).toBe(`${addDays(start, i)} 20:00`);
    });
    if (switches.length > 0) {
      // The plan crossed a 23- or 25-hour day: one gap is not 24 hours.
      const gaps = dates.slice(1).map((date, i) => date.getTime() - dates[i].getTime());
      expect(gaps.some((gap) => gap !== DAY)).toBe(true);
    }
  });
});

describe('parseReminderTime', () => {
  test('reads HH:MM and H:MM', () => {
    expect(parseReminderTime('20:00')).toEqual({ hour: 20, minute: 0 });
    expect(parseReminderTime('08:05')).toEqual({ hour: 8, minute: 5 });
    expect(parseReminderTime('8:05')).toEqual({ hour: 8, minute: 5 });
    expect(parseReminderTime(' 23:59 ')).toEqual({ hour: 23, minute: 59 });
    expect(parseReminderTime('00:00')).toEqual({ hour: 0, minute: 0 });
  });

  test('rejects everything else', () => {
    for (const bad of ['24:00', '12:60', '12', '12:5', 'noon', '', '-1:00', '12:00 PM', '1200']) {
      expect(parseReminderTime(bad)).toBeNull();
    }
  });

  test('a value that is not a string → null, never a TypeError', () => {
    for (const bad of [undefined, null, 2000, 20, true, {}, ['20:00']]) {
      expect(parseReminderTime(bad)).toBeNull();
    }
  });
});

describe('reminder text', () => {
  test('exact copy: a streak of 2 or more is named', () => {
    expect(reminderContent(12)).toEqual({
      title: 'Your cards are ready',
      body: 'A few minutes keeps your 12-day streak.',
    });
    expect(reminderContent(2).body).toBe('A few minutes keeps your 2-day streak.');
  });

  test('exact copy: no streak, or a 1-day streak, starts a new one', () => {
    for (const n of [0, 1, Number.NaN]) {
      expect(reminderContent(n)).toEqual({
        title: REMINDER_TITLE,
        body: 'A few minutes today starts a new streak.',
      });
    }
  });

  test('exact copy: on a day the learner already studied, the text names no streak (release pass C1-2)', () => {
    expect(REMINDER_STUDIED_BODY).toBe('You studied today. A few more minutes helps you remember.');
    for (const n of [0, 1, 2, 12, Number.NaN]) {
      expect(reminderContent(n, true)).toEqual({
        title: REMINDER_TITLE,
        body: 'You studied today. A few more minutes helps you remember.',
      });
    }
    // Without the flag the texts stay as before.
    expect(reminderContent(12, false).body).toBe('A few minutes keeps your 12-day streak.');
    expect(reminderContent(1, false).body).toBe('A few minutes today starts a new streak.');
  });

  test('C1-2: skip OFF and studied today → today’s reminder never says "starts a new streak"', () => {
    // The device case: a first session today (streak 1), "Skip days when I already studied" off.
    const person = { streak: 1, lastStudyDay: TODAY, freezes: 0 };
    const [today, tomorrow] = planReminders(
      localTime(TODAY, '09:00'),
      opts({ lastStudyDay: TODAY, skipStudied: false }),
    );
    expect(show(today)).toBe(`${TODAY} 20:00`);
    expect(reminderContentFor(today, person).body).toBe(REMINDER_STUDIED_BODY);
    // Tomorrow the learner has not studied yet: the streak text, as before.
    expect(reminderContentFor(tomorrow, person).body).toBe('A few minutes today starts a new streak.');
    // A longer streak: today names no streak either (it is already counted for today).
    const longer = { ...person, streak: 12 };
    expect(reminderContentFor(today, longer).body).toBe(REMINDER_STUDIED_BODY);
    expect(reminderContentFor(tomorrow, longer).body).toBe('A few minutes keeps your 12-day streak.');
  });

  test('a reminder on a studied day never says "starts a new streak" or "keeps your …" (any streak, any freezes)', () => {
    const now = localTime(TODAY, '09:00');
    for (const streak of [0, 1, 2, 5, 30]) {
      for (const freezes of [0, 1, 2]) {
        const person = { streak, lastStudyDay: TODAY, freezes };
        const [today] = planReminders(now, opts({ lastStudyDay: TODAY, skipStudied: false }));
        const { body } = reminderContentFor(today, person);
        expect(body).not.toContain('starts a new streak');
        expect(body).not.toContain('keeps your');
      }
    }
  });

  test('studiedOn: only the last study day itself', () => {
    expect(studiedOn({ lastStudyDay: TODAY }, TODAY)).toBe(true);
    expect(studiedOn({ lastStudyDay: addDays(TODAY, -1) }, TODAY)).toBe(false);
    expect(studiedOn({ lastStudyDay: addDays(TODAY, 1) }, TODAY)).toBe(false);
    expect(studiedOn({ lastStudyDay: null }, TODAY)).toBe(false);
    expect(studiedOn({ lastStudyDay: '' }, '')).toBe(false);
  });

  test('a reminder in a few days does not promise a streak that will be broken by then', () => {
    const person = { streak: 12, lastStudyDay: addDays(TODAY, -1), freezes: 0 };
    const [today, tomorrow] = planReminders(localTime(TODAY, '09:00'), opts({ lastStudyDay: person.lastStudyDay }));
    expect(reminderContentFor(today, person).body).toBe('A few minutes keeps your 12-day streak.');
    expect(reminderContentFor(tomorrow, person).body).toBe('A few minutes today starts a new streak.');
  });

  test('a freeze keeps the streak alive for one missed day', () => {
    const person = { streak: 9, lastStudyDay: addDays(TODAY, -1), freezes: 1 };
    expect(streakAliveOn(person, TODAY)).toBe(9);
    expect(streakAliveOn(person, addDays(TODAY, 1))).toBe(9);
    expect(streakAliveOn(person, addDays(TODAY, 2))).toBe(0);
  });

  test('never studied → no streak', () => {
    expect(streakAliveOn({ streak: 0, lastStudyDay: null, freezes: 2 }, TODAY)).toBe(0);
    expect(streakAliveOn({ streak: 0, lastStudyDay: '', freezes: 2 }, TODAY)).toBe(0);
  });

  test('agrees with rollStreak: alive exactly when studying that day continues the streak', () => {
    for (const lastOffset of [0, -1, -2, -3, -10]) {
      for (const freezes of [0, 1, 2]) {
        for (const streak of [1, 2, 5, 30]) {
          const person = makePerson({ streak, freezes, lastStudyDay: addDays(TODAY, lastOffset) });
          const roll = rollStreak(person, TODAY);
          // rollStreak continues the streak (or keeps it, on a second session
          // the same day); a broken streak starts again at 1.
          const continues = !roll.advanced || roll.streak === streak + 1;
          expect(streakAliveOn(person, TODAY)).toBe(continues ? streak : 0);
        }
      }
    }
  });
});
