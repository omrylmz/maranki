/**
 * A test clock (spec W0-1): time that only moves when a test moves it.
 *
 * The store and the domain code never read the real clock in a pure function:
 * they take `now` as an argument (or a `now()` function). Tests pass this clock
 * instead, so a test is the same on every run and on every machine.
 *
 * Days are LOCAL calendar days — `dayKeyOf()` in src/domain/types.ts uses the
 * phone's local time. So build moments with `localTime('2026-10-21', '23:58')`,
 * not with `Date.UTC(...)`: then "23:58 → 00:02" really crosses local midnight,
 * whatever time zone the test machine uses.
 *
 * Example:
 *   const clock = createClock(localTime('2026-06-10', '23:58'));
 *   startSession(clock.now());
 *   clock.advance(4 * MIN);           // 00:02 on 2026-06-11
 *   expect(clock.dayKey()).toBe('2026-06-11');
 */
import { dayKeyOf } from '../domain/types';

/**
 * Epoch ms for a local wall-clock time. `dayKey` is 'YYYY-MM-DD', `hhmm` is
 * 'HH:MM' (24 h). Throws on a malformed input, so a typo never becomes NaN.
 */
export function localTime(dayKey: string, hhmm = '09:00'): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  const time = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!day || !time) throw new Error(`localTime: bad input ${dayKey} ${hhmm}`);
  const [, y, m, d] = day;
  const [, h, min] = time;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
}

/**
 * The default "now" of the test helpers: Wednesday 10 June 2026, 09:00 local
 * time. A plain weekday morning — far from midnight and weeks away from every
 * daylight-saving switch (Europe, USA, Australia), so a test that does not
 * care about days never trips on them.
 */
export const FIXED_NOW = localTime('2026-06-10', '09:00');

/** Move `ms` by whole LOCAL calendar days and keep the wall-clock time. */
export function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export interface TestClock {
  /** The current time. A plain function: safe to pass as `{ now: clock.now }`. */
  now: () => number;
  /** Jump to an exact moment (it may go back in time). */
  set: (ms: number) => void;
  /** Move forward by `ms` and return the new time. */
  advance: (ms: number) => number;
  /** Jump to the next local day, at `hhmm` (default: the same wall-clock time). */
  nextDay: (hhmm?: string) => number;
  /** The local day of the current time, e.g. '2026-10-21'. */
  dayKey: () => string;
}

export function createClock(start: number = FIXED_NOW): TestClock {
  if (!Number.isFinite(start)) throw new Error('createClock: start must be a finite number');
  let current = start;
  const now = () => current;
  return {
    now,
    set: (ms) => {
      if (!Number.isFinite(ms)) throw new Error('TestClock.set: ms must be a finite number');
      current = ms;
    },
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('TestClock.advance: ms must be ≥ 0');
      current += ms;
      return current;
    },
    nextDay: (hhmm) => {
      const next = addLocalDays(current, 1);
      current = hhmm === undefined ? next : localTime(dayKeyOf(next), hhmm);
      return current;
    },
    dayKey: () => dayKeyOf(current),
  };
}
