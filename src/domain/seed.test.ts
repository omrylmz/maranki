/**
 * First-boot contract: Maranki opens as a BLANK SLATE. Curated decks are never
 * auto-added — they're materialized on demand (onboarding's language pick or the
 * "Add a deck" sheet). The curated corpus itself, and its per-card linguistics,
 * are covered in deckCatalog.test.ts.
 *
 * W1-1: the seed is a fixed point of migrate(), and the daily-limit ranges
 * live next to the default settings (clampLimits).
 * W3-1: the seed is a SCHEMA-3 document (the note model): no card types, no
 * notes, the v3 day tally and settings, and the same pinned lists that the
 * migration gives an updated install.
 * Wave 5d: the daily pace is the tour's MIDDLE answer (`DEFAULT_PACE`: 10
 * new a day, goals 30 and 10 — "10 new a day · about 15 min"). Wave 5c had
 * lowered it to 6 new a day only to make a "10 min" label true; wave 5d
 * restores the familiar pace on purpose and makes the labels honest
 * instead. onboardingDiff.test.ts checks that the tour and "Reset
 * preferences" agree with it.
 */
import { describe, expect, it } from '@jest/globals';

import { migrate } from '../store/migrate';
import { v2toV3 } from '../store/migrateV3';
import { makeState } from '../test/factories';
import { stateProblemsV3 } from '../test/factoriesV3';
import { buildSeedState, DEFAULT_PACE } from './seed';
import {
  clampLimits,
  CURRENT_SCHEMA,
  DEFAULT_APP_SETTINGS,
  DEFAULT_SRS,
  LIMIT_RANGES,
  MIN_READER,
} from './types';

const NOW = 1_700_000_000_000;

describe('buildSeedState — blank slate', () => {
  it('adds no decks, no card types, no notes and no cards', () => {
    const s = buildSeedState(NOW);
    expect(s.decks).toEqual([]);
    expect(s.noteTypes).toEqual([]);
    expect(s.notes).toEqual([]);
    expect(s.cards).toEqual([]);
  });

  it('has zeroed progress: no sessions, no review log, no manual edits, a fresh person', () => {
    const { person, sessions, reviewLog, manualLog } = buildSeedState(NOW);
    expect(sessions).toEqual([]);
    expect(reviewLog).toEqual([]);
    expect(manualLog).toEqual([]);
    expect(person.xp).toBe(0);
    expect(person.streak).toBe(0);
    expect(person.bestStreak).toBe(0);
    expect(person.freezes).toBe(0);
    expect(person.achievements).toEqual({});
    expect(person.dayDone).toEqual({ dayKey: expect.any(String), reviews: 0, neww: 0, checks: 0, newByDeck: {} });
  });

  // Wave 5d (a deliberate reversal of wave 5c, which used 20 / 6): the goals are the tour's
  // middle answer (DEFAULT_PACE), 30 reviews and 10 new — "10 new a day · about 15 min".
  it('keeps sensible default daily goals (NOT zeroed) so study math never divides by zero: 10 new a day', () => {
    const { person } = buildSeedState(NOW);
    expect(person.goalReviews).toBe(30);
    expect(person.goalNew).toBe(10);
    expect(DEFAULT_PACE).toEqual({ dailyNewLimit: 10, goalReviews: 30, goalNew: 10 });
    expect([person.goalReviews, person.goalNew]).toEqual([DEFAULT_PACE.goalReviews, DEFAULT_PACE.goalNew]);
  });

  it('the new-card LIMIT is the same pace (10 a day); the review limit and the repair value stay the defaults', () => {
    const { settings } = buildSeedState(NOW);
    expect(settings.srs.dailyNewLimit).toBe(DEFAULT_PACE.dailyNewLimit);
    expect(settings.srs.dailyNewLimit).toBe(10);
    expect(settings.srs.dailyReviewLimit).toBe(DEFAULT_SRS.dailyReviewLimit);
    // DEFAULT_SRS.dailyNewLimit is only what a damaged or missing stored limit is read as.
    expect(DEFAULT_SRS.dailyNewLimit).toBe(10);
  });

  it('starts un-onboarded so the first launch routes into onboarding', () => {
    expect(buildSeedState(NOW).onboarded).toBe(false);
  });

  it('keeps the smart-filter collections (live queries own no cards of their own)', () => {
    const ids = buildSeedState(NOW)
      .collections.map((c) => c.id)
      .sort();
    expect(ids).toEqual(['daily', 'fav', 'hard']);
  });

  it('has no user lists, no starter pack, and no session in flight', () => {
    const s = buildSeedState(NOW);
    expect(s.lists).toEqual([]);
    expect(s.pack).toBeNull();
    expect(s.inProgressSession).toBeNull();
  });
});

describe('buildSeedState — a schema-3 document (W3-1)', () => {
  it('is written in this build’s schema', () => {
    const s = buildSeedState(NOW);
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA);
    expect(s.minReaderVersion).toBe(MIN_READER);
    expect([CURRENT_SCHEMA, MIN_READER]).toEqual([3, 3]);
  });

  it('is a valid v3 document', () => {
    expect(stateProblemsV3(buildSeedState(NOW))).toEqual([]);
  });

  it('pins the same built-in lists that the migration gives the three seed collections', () => {
    const seed = buildSeedState(NOW);
    expect(seed.listPrefs).toEqual({
      'builtin:hard': { pinned: true, hidden: false, order: 0 },
      'builtin:favorites': { pinned: true, hidden: false, order: 1 },
      'builtin:recent': { pinned: true, hidden: false, order: 2 },
    });
    // An updated install (a v2 document with the old seed's collections) gets the very same prefs.
    expect(v2toV3(makeState({ collections: seed.collections }), NOW).listPrefs).toEqual(seed.listPrefs);
  });

  it('has every v3 setting, with the values of the v2 → v3 mapping (spec §3.5)', () => {
    const { settings } = buildSeedState(NOW);
    // Every default: the new-card limit of the tour's middle answer (DEFAULT_PACE, wave 5d) is
    // the default limit again (10), so the seed's settings ARE the defaults.
    expect(settings).toEqual({
      ...DEFAULT_APP_SETTINGS,
      srs: { ...DEFAULT_APP_SETTINGS.srs, dailyNewLimit: DEFAULT_PACE.dailyNewLimit },
    });
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(settings).toMatchObject({
      reminderSkipStudied: true,
      spaceSiblings: true,
      knownChecksPerDay: 5,
      autoBackup: true,
      lastAutoBackupAt: null,
      backupImages: true,
      reminderOfferSeen: false,
      reminderTime: '20:00',
    });
  });

  it('starts with the reminder OFF and automatic read-aloud OFF (spec §3.3)', () => {
    const { settings } = buildSeedState(NOW);
    expect(settings.reminderEnabled).toBe(false);
    expect(settings.autoReadAloud).toBe(false);
    expect(settings.readAloudEnabled).toBe(true);
  });

  it('is a fixed point of migrate(): nothing to repair, nothing to fill', () => {
    const seed = buildSeedState(NOW);
    expect(migrate(JSON.parse(JSON.stringify(seed)), NOW)).toEqual({ kind: 'ok', state: seed, from: 3, repaired: [] });
  });

  it('copies the default settings (a change to the seed never changes the defaults)', () => {
    const s = buildSeedState(NOW);
    s.settings.srs.learningStepsMin.push(99);
    s.settings.reminderEnabled = true;
    expect(DEFAULT_APP_SETTINGS.srs.learningStepsMin).toEqual([1, 10]);
    expect(DEFAULT_APP_SETTINGS.reminderEnabled).toBe(false);
    // Setting the seed's own new-card limit never changes the shared DEFAULT_SRS either.
    expect(DEFAULT_APP_SETTINGS.srs.dailyNewLimit).toBe(10);
    expect(DEFAULT_SRS.dailyNewLimit).toBe(10);
  });
});

describe('clampLimits — the allowed daily limits (spec §8.6)', () => {
  it('the review limit is never below 10, nor above 99,999 ("No limit")', () => {
    expect(clampLimits({ dailyReviewLimit: 0 })).toEqual({ dailyReviewLimit: 10 });
    expect(clampLimits({ dailyReviewLimit: -5 })).toEqual({ dailyReviewLimit: 10 });
    expect(clampLimits({ dailyReviewLimit: 10 })).toEqual({ dailyReviewLimit: 10 });
    expect(clampLimits({ dailyReviewLimit: 200 })).toEqual({ dailyReviewLimit: 200 });
    expect(clampLimits({ dailyReviewLimit: 1e9 })).toEqual({ dailyReviewLimit: LIMIT_RANGES.dailyReviewLimit.max });
  });

  it('the new-card limit is 0–999', () => {
    expect(clampLimits({ dailyNewLimit: 0 })).toEqual({ dailyNewLimit: 0 });
    expect(clampLimits({ dailyNewLimit: -1 })).toEqual({ dailyNewLimit: 0 });
    expect(clampLimits({ dailyNewLimit: 1000 })).toEqual({ dailyNewLimit: 999 });
  });

  it('rounds to whole cards and leaves out a value that is not a finite number', () => {
    expect(clampLimits({ dailyNewLimit: 7.6, dailyReviewLimit: 12.2 })).toEqual({ dailyNewLimit: 8, dailyReviewLimit: 12 });
    expect(clampLimits({ dailyNewLimit: Number.NaN, dailyReviewLimit: Infinity })).toEqual({});
    expect(clampLimits({})).toEqual({});
  });

  it('the default limits are inside the ranges', () => {
    expect(clampLimits({ dailyNewLimit: DEFAULT_SRS.dailyNewLimit, dailyReviewLimit: DEFAULT_SRS.dailyReviewLimit })).toEqual({
      dailyNewLimit: DEFAULT_SRS.dailyNewLimit,
      dailyReviewLimit: DEFAULT_SRS.dailyReviewLimit,
    });
  });
});
