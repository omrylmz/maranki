/**
 * Anki progress mapping (spec §5.5, unit W2-5): one test per row of the
 * table — each card `type`, `queue`, `flags`, the `marked` tag, 'reset' —
 * plus the safety rules (non-finite → New, clamping, reps ≥ 1).
 */
import { describe, expect, test } from '@jest/globals';

import { FIXED_NOW, localTime } from '../../test/clock';
import { DEFAULT_SRS } from '../types';
import {
  ankiDayToMs,
  hasAnkiProgress,
  isMarkedTag,
  mapAnkiCard,
  startOfLocalDay,
  type AnkiCardRow,
  type AnkiSrsOptions,
} from './ankiSrs';

/** The collection started on 1 Jan 2026 at 04:00 (Anki's default rollover hour). */
const CRT = localTime('2026-01-01', '04:00') / 1000;

const NEW: AnkiCardRow = { type: 0, queue: 0, due: 7, ivl: 0, factor: 0, reps: 0, lapses: 0, flags: 0 };

function opts(over: Partial<AnkiSrsOptions> = {}): AnkiSrsOptions {
  return {
    crt: CRT,
    progress: 'keep',
    arrival: 'queued',
    newPos: 42,
    marked: false,
    srs: { startingEase: DEFAULT_SRS.startingEase, maxIntervalDays: DEFAULT_SRS.maxIntervalDays },
    now: FIXED_NOW,
    ...over,
  };
}

describe('mapAnkiCard — card types', () => {
  test('type 0 (new) → reps 0, newPos from the planner, newState = arrival', () => {
    const queued = mapAnkiCard(NEW, opts());
    expect(queued).toMatchObject({
      reps: 0,
      lapses: 0,
      stepIndex: null,
      intervalDays: 0,
      ease: DEFAULT_SRS.startingEase,
      due: FIXED_NOW,
      newPos: 42,
      newState: 'queued',
      lastReviewedAt: null,
      suspended: false,
      flagged: false,
      fav: false,
    });
    expect(mapAnkiCard(NEW, opts({ arrival: 'notStarted' })).newState).toBe('notStarted');
  });

  test('type 2 (review) → graduated, interval, clamped ease, due on a local day', () => {
    const row: AnkiCardRow = { type: 2, queue: 2, due: 10, ivl: 15, factor: 2650, reps: 7, lapses: 1, flags: 0 };
    const out = mapAnkiCard(row, opts());
    expect(out).toMatchObject({ stepIndex: null, intervalDays: 15, ease: 2.65, reps: 7, lapses: 1, newPos: 42 });
    // crt + 10 days, at local midnight (the 04:00 rollover is dropped).
    expect(out.due).toBe(localTime('2026-01-11', '00:00'));
    expect(out.newState).toBeUndefined();
  });

  test('review ease is clamped to 1.3 … 5; a missing factor uses the starting ease', () => {
    const row: AnkiCardRow = { type: 2, queue: 2, due: 1, ivl: 3, factor: 900, reps: 2, lapses: 0, flags: 0 };
    expect(mapAnkiCard(row, opts()).ease).toBe(1.3);
    expect(mapAnkiCard({ ...row, factor: 9000 }, opts()).ease).toBe(5);
    expect(mapAnkiCard({ ...row, factor: 0 }, opts()).ease).toBe(DEFAULT_SRS.startingEase);
  });

  test('type 1 (learning, queue 1) → stepIndex 0, due = epoch seconds × 1000', () => {
    const dueSec = Math.floor(FIXED_NOW / 1000) + 600;
    const row: AnkiCardRow = { type: 1, queue: 1, due: dueSec, ivl: 0, factor: 0, reps: 1, lapses: 0, flags: 0 };
    const out = mapAnkiCard(row, opts());
    expect(out).toMatchObject({ stepIndex: 0, intervalDays: 0, reps: 1, lapses: 0, due: dueSec * 1000 });
    expect(out.ease).toBe(DEFAULT_SRS.startingEase);
  });

  test('type 3 (relearning) keeps its interval; a day-number due (queue 3) is read as a day', () => {
    const row: AnkiCardRow = { type: 3, queue: 3, due: 20, ivl: 4, factor: 2100, reps: 9, lapses: 3, flags: 0 };
    const out = mapAnkiCard(row, opts());
    expect(out).toMatchObject({ stepIndex: 0, intervalDays: 4, ease: 2.1, reps: 9, lapses: 3 });
    expect(out.due).toBe(localTime('2026-01-21', '00:00'));
  });

  test('a negative learning ivl (Anki seconds) becomes 0 days', () => {
    const row: AnkiCardRow = { type: 1, queue: 1, due: 1_800_000_000, ivl: -600, factor: 0, reps: 1, lapses: 0, flags: 0 };
    expect(mapAnkiCard(row, opts()).intervalDays).toBe(0);
  });

  test('a card with progress gets reps ≥ 1 (a "set due date" review card with reps 0 stays a review)', () => {
    const row: AnkiCardRow = { type: 2, queue: 2, due: 3, ivl: 5, factor: 2500, reps: 0, lapses: 0, flags: 0 };
    expect(mapAnkiCard(row, opts()).reps).toBe(1);
  });

  test('intervals are clamped to maxIntervalDays', () => {
    const row: AnkiCardRow = { type: 2, queue: 2, due: 3, ivl: 99_999, factor: 2500, reps: 30, lapses: 0, flags: 0 };
    const out = mapAnkiCard(row, opts({ srs: { startingEase: 2.5, maxIntervalDays: 365 } }));
    expect(out.intervalDays).toBe(365);
  });
});

describe('mapAnkiCard — queue, flags and marked', () => {
  test('queue -1 → suspended (on a new and on a review card)', () => {
    expect(mapAnkiCard({ ...NEW, queue: -1 }, opts()).suspended).toBe(true);
    const review: AnkiCardRow = { type: 2, queue: -1, due: 3, ivl: 5, factor: 2500, reps: 4, lapses: 0, flags: 0 };
    expect(mapAnkiCard(review, opts())).toMatchObject({ suspended: true, intervalDays: 5 });
  });

  test('queue -2 / -3 (buried) is ignored: the card keeps its schedule and is not suspended', () => {
    const row: AnkiCardRow = { type: 2, queue: -2, due: 3, ivl: 5, factor: 2500, reps: 4, lapses: 0, flags: 0 };
    const out = mapAnkiCard(row, opts());
    expect(out.suspended).toBe(false);
    expect(out).not.toHaveProperty('buriedUntil');
    expect(mapAnkiCard({ ...row, queue: -3 }, opts()).intervalDays).toBe(5);
  });

  test('flags & 7 → flagged + flagColor; other bits are ignored', () => {
    expect(mapAnkiCard({ ...NEW, flags: 3 }, opts())).toMatchObject({ flagged: true, flagColor: 3 });
    expect(mapAnkiCard({ ...NEW, flags: 8 + 2 }, opts())).toMatchObject({ flagged: true, flagColor: 2 });
    const plain = mapAnkiCard({ ...NEW, flags: 8 }, opts());
    expect(plain.flagged).toBe(false);
    expect(plain).not.toHaveProperty('flagColor');
  });

  test('the marked note tag → fav', () => {
    expect(mapAnkiCard(NEW, opts({ marked: true })).fav).toBe(true);
    expect(isMarkedTag('marked')).toBe(true);
    expect(isMarkedTag('Marked')).toBe(true);
    expect(isMarkedTag('marker')).toBe(false);
  });
});

describe('mapAnkiCard — reset and bad values', () => {
  test("progress 'reset' → every card New; flags, suspension and favorite stay", () => {
    const row: AnkiCardRow = { type: 2, queue: -1, due: 3, ivl: 30, factor: 2500, reps: 12, lapses: 2, flags: 1 };
    const out = mapAnkiCard(row, opts({ progress: 'reset', marked: true, arrival: 'notStarted' }));
    expect(out).toMatchObject({
      reps: 0,
      lapses: 0,
      stepIndex: null,
      intervalDays: 0,
      ease: DEFAULT_SRS.startingEase,
      due: FIXED_NOW,
      newPos: 42,
      newState: 'notStarted',
      suspended: true,
      flagged: true,
      flagColor: 1,
      fav: true,
    });
  });

  test('a non-finite value or an unknown type → New (NaN never reaches the scheduler)', () => {
    const base: AnkiCardRow = { type: 2, queue: 2, due: 3, ivl: 30, factor: 2500, reps: 12, lapses: 2, flags: 0 };
    for (const bad of [{ due: NaN }, { ivl: Infinity }, { factor: NaN }, { reps: NaN }, { type: 7 }, { type: NaN }]) {
      const out = mapAnkiCard({ ...base, ...bad }, opts());
      expect(out.reps).toBe(0);
      expect(Number.isFinite(out.due)).toBe(true);
      expect(Number.isFinite(out.ease)).toBe(true);
    }
  });

  test('hasAnkiProgress: learning / review / relearning with usable numbers', () => {
    expect(hasAnkiProgress(NEW)).toBe(false);
    for (const type of [1, 2, 3]) expect(hasAnkiProgress({ ...NEW, type, reps: 1 })).toBe(true);
    expect(hasAnkiProgress({ ...NEW, type: 2, ivl: NaN })).toBe(false);
  });
});

describe('day helpers', () => {
  test('startOfLocalDay and ankiDayToMs use local midnight', () => {
    expect(startOfLocalDay(localTime('2026-06-10', '23:58'))).toBe(localTime('2026-06-10', '00:00'));
    expect(ankiDayToMs(CRT, 0)).toBe(localTime('2026-01-01', '00:00'));
  });
});
