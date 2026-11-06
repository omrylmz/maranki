/**
 * Tests for src/store/useNow.ts — the ONE shared clock of the screens — and
 * for the session's queue time (sessionLogic.ts `sessionQueueTime`), final
 * review:
 *   - every hook shows the SAME time (the Today hero and the tab badge used
 *     to tick in their own one-minute phases);
 *   - it ticks on every full minute (so also at local midnight) and when the
 *     app comes back to the foreground; it stops when no screen listens;
 *   - "Study N" opens exactly N cards: the session builds its queue at the
 *     time the button counted with, while that time is fresh.
 *
 * AppState is React Native's jest mock: a test catches the listener the
 * clock gives to `addEventListener('change', …)` to play "back in front".
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { COUNTED_TIME_MAX_AGE_MS, sessionQueueTime } from '../components/study/sessionLogic';
import { buildSessionQueue, matchCtxOf, readyFor } from '../domain/scope';
import { DAY, MIN } from '../domain/types';
import { localTime } from '../test/clock';
import { lifeValues, makeDeckV3, noteWithCards, stateOfV3 } from '../test/factoriesV3';
import { msToNextMinute, nowClock, TICK_MS, useNow } from './useNow';

/** 09:00:20 on a fixed local day. */
const T0 = localTime('2026-07-08', '09:00') + 20_000;

const addListener = jest.spyOn(AppState, 'addEventListener');
/** The AppState listeners the clock gave, with their remove() spies. */
let appHandlers: { handler: (s: string) => void; remove: jest.Mock }[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  appHandlers = [];
  addListener.mockImplementation(((_event: string, handler: (s: string) => void) => {
    const remove = jest.fn();
    appHandlers.push({ handler, remove });
    return { remove };
  }) as never);
});

const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  for (const r of renderers.splice(0)) act(() => r.unmount());
  jest.useRealTimers();
});

/** Two screens that both show the time (the Today hero and the tab badge). */
function mountTwo(): { seen: number[][] } {
  const seen: number[][] = [[], []];
  const Probe = ({ i }: { i: number }) => {
    seen[i].push(useNow());
    return null;
  };
  act(() => {
    renderers.push(TestRenderer.create(React.createElement(Probe, { i: 0 })));
  });
  // The second screen mounts 25 s later (its own clock used to tick 25 s after the first).
  act(() => {
    jest.advanceTimersByTime(25_000);
  });
  act(() => {
    renderers.push(TestRenderer.create(React.createElement(Probe, { i: 1 })));
  });
  return { seen };
}

const last = (list: number[]) => list[list.length - 1];

describe('useNow: ONE shared clock (final review)', () => {
  test('msToNextMinute: the wait to the next full minute', () => {
    const nine = localTime('2026-07-08', '09:00');
    expect(msToNextMinute(nine)).toBe(TICK_MS);
    expect(msToNextMinute(nine + 59_500)).toBe(500);
    expect(msToNextMinute(nine + 20_000)).toBe(40_000);
  });

  test('every screen shows the SAME time, and all tick together on each full minute', () => {
    const { seen } = mountTwo();
    // The first listener read the time at mount: 09:00:20. The second screen gets that same time.
    expect(last(seen[0])).toBe(T0);
    expect(last(seen[1])).toBe(T0);
    // 09:01:00: both tick, at once, to the same time.
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(last(seen[0])).toBe(localTime('2026-07-08', '09:01'));
    expect(last(seen[1])).toBe(localTime('2026-07-08', '09:01'));
    act(() => {
      jest.advanceTimersByTime(TICK_MS);
    });
    expect([last(seen[0]), last(seen[1])]).toEqual([localTime('2026-07-08', '09:02'), localTime('2026-07-08', '09:02')]);
  });

  test('it ticks AT local midnight: a new day shows at once', () => {
    jest.setSystemTime(localTime('2026-07-08', '23:59') + 30_000);
    const { seen } = mountTwo(); // now 23:59:55
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(last(seen[0])).toBe(localTime('2026-07-09', '00:00'));
    expect(last(seen[1])).toBe(localTime('2026-07-09', '00:00'));
  });

  test('back in front: the time is read again at once (the timers slept in the background)', () => {
    const { seen } = mountTwo();
    expect(appHandlers).toHaveLength(1); // one listener for the whole app, not one per screen
    // The phone slept for 3 hours: the clock did not tick.
    jest.setSystemTime(T0 + 3 * 60 * MIN);
    act(() => appHandlers[0].handler('active'));
    expect(last(seen[0])).toBe(T0 + 3 * 60 * MIN);
    expect(last(seen[1])).toBe(T0 + 3 * 60 * MIN);
  });

  test('no screen listens → the clock stops; the next screen reads the time again', () => {
    const { seen } = mountTwo();
    for (const r of renderers.splice(0)) act(() => r.unmount());
    expect(appHandlers[0].remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.setSystemTime(T0 + DAY);
    const seenAgain: number[] = [];
    const Probe = () => {
      seenAgain.push(useNow());
      return null;
    };
    act(() => {
      renderers.push(TestRenderer.create(React.createElement(Probe)));
    });
    expect(last(seenAgain)).toBe(T0 + DAY);
    expect(seen[0].length).toBeGreaterThan(0);
    expect(nowClock.getSnapshot()).toBe(T0 + DAY);
  });
});

describe('the session builds its queue at the time its button counted with (final review)', () => {
  test('sessionQueueTime: the counted time while it is fresh and of the same day, else the real time', () => {
    expect(sessionQueueTime(T0, T0 + 40_000)).toBe(T0);
    expect(sessionQueueTime(T0, T0 + COUNTED_TIME_MAX_AGE_MS)).toBe(T0);
    expect(sessionQueueTime(T0, T0 + COUNTED_TIME_MAX_AGE_MS + 1)).toBe(T0 + COUNTED_TIME_MAX_AGE_MS + 1); // too old
    expect(sessionQueueTime(T0 + 1, T0)).toBe(T0); // from the future: the real time
    expect(sessionQueueTime(Number.NaN, T0)).toBe(T0);
    const lateNight = localTime('2026-07-08', '23:59');
    const afterMidnight = localTime('2026-07-09', '00:00') + 1_000;
    expect(sessionQueueTime(lateNight, afterMidnight)).toBe(afterMidnight); // a new day: today's budget
  });

  test('"Study N" opens exactly N cards: a learning card that becomes due between two ticks waits for the next session', () => {
    // A review overdue by an hour, and a card rated "Hard" on step 0 a moment ago: due again at 09:00:50.
    const deck = makeDeckV3({ id: 'd1', name: 'Capitals' });
    const review = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'rev', ...lifeValues('review', T0), due: T0 - 60 * MIN } });
    const learning = noteWithCards({ deckId: 'd1', note: { id: 'n2' }, card: { id: 'lrn', ...lifeValues('learning', T0), due: T0 + 30_000 } });
    const state = stateOfV3({ decks: [deck], groups: [review, learning] });
    const countedAt = T0; // the shared clock's last tick: the button says "Study 1"
    const n = readyFor(state, {}, matchCtxOf(state, countedAt)).total;
    expect(n).toBe(1);
    const startedAt = T0 + 50_000; // the tap, 50 s later (before the next tick)
    const scheduled = { kind: 'scheduled' as const, q: {} };
    // At the real time the queue had one card MORE than the button said (the bug).
    expect(buildSessionQueue(scheduled, state, matchCtxOf(state, startedAt))).toHaveLength(n + 1);
    // At the session's queue time it is exactly the button's number.
    const queue = buildSessionQueue(scheduled, state, matchCtxOf(state, sessionQueueTime(countedAt, startedAt)));
    expect(queue.map((c) => c.id)).toEqual(['rev']);
  });
});
