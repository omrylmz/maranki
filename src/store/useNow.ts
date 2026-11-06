/**
 * Render-safe "now": ONE shared clock for every screen (final review).
 *
 * React Compiler forbids impure calls (Date.now) during render, so render
 * code reads the time from this hook. Event handlers and store actions keep
 * calling Date.now() directly.
 *
 * WHY one shared clock: every Study count (the Today hero, the tab badge,
 * the deck rows, the deck page, the Library) reads this time. Before, each
 * hook had its OWN clock with its own one-minute phase, so two numbers on
 * the screen could count at different times, and the session (built with
 * Date.now()) could open one card more than its button said: a learning
 * card that became due after the button's last tick. Now:
 *   - every hook reads the SAME time, so all counts agree;
 *   - it ticks on every full minute (so also at local midnight: a new day's
 *     budget shows at once), and when the app comes back to the foreground;
 *   - the session builds its queue at this same time while it is fresh
 *     (sessionLogic.ts `sessionQueueTime`): "Study N" opens exactly N cards.
 *
 * The clock runs only while a screen listens. The first listener reads the
 * time again (the clock may have stopped long ago).
 *
 *   const now = useNow();                         // render: counts, labels
 *   onPress={() => actions.reschedule(ids, Date.now() + DAY)}   // handlers: the real clock
 */
import { useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/** One minute: the clock ticks on every full minute. */
export const TICK_MS = 60_000;

/**
 * The wait from `ms` to the next full minute (1 … 60 000 ms), so the ticks
 * fall on 09:01:00, 09:02:00 … and on 00:00:00 (a new local day). Time
 * zones are whole or half hours, so a full minute is a full minute
 * everywhere.
 *
 *   msToNextMinute(09:00:59.500) → 500
 *   msToNextMinute(09:01:00.000) → 60 000
 */
export function msToNextMinute(ms: number): number {
  const into = ((ms % TICK_MS) + TICK_MS) % TICK_MS;
  return TICK_MS - into;
}

/** The shared clock: a time, the screens that listen, and its timer. */
let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let appState: { remove(): void } | null = null;

/** Read the time and tell every listener. */
function tick(): void {
  current = Date.now();
  for (const listener of [...listeners]) listener();
}

/** Tick on the next full minute, and again after that. */
function scheduleTick(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    tick();
    if (listeners.size > 0) scheduleTick();
  }, msToNextMinute(Date.now()));
}

/** The app is in front again: its timers may have slept, so read the time now. */
function onAppState(status: AppStateStatus): void {
  if (status !== 'active' || listeners.size === 0) return;
  tick();
  scheduleTick();
}

function start(): void {
  scheduleTick();
  try {
    appState = AppState.addEventListener('change', onAppState);
  } catch {
    appState = null; // no AppState (a test without React Native): the minute ticks still run
  }
}

function stop(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  appState?.remove();
  appState = null;
}

/**
 * The shared clock as a store (useSyncExternalStore). Exported for tests
 * and for code outside React that must read the time the screens show.
 */
export const nowClock = {
  /** The time every screen shows now. */
  getSnapshot: (): number => current,
  /** Listen to the ticks. The first listener starts the clock (and reads the time again). */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) {
      // The clock stood still while no screen listened: read the time again.
      current = Date.now();
      start();
      listener();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  },
};

export function useNow(): number {
  return useSyncExternalStore(nowClock.subscribe, nowClock.getSnapshot, nowClock.getSnapshot);
}
