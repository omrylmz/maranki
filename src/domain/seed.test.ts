/**
 * First-boot contract: Maranki opens as a BLANK SLATE. Curated decks are never
 * auto-added — they're materialized on demand (onboarding's language pick or the
 * "Add a deck" sheet). The curated corpus itself, and its per-card linguistics,
 * are covered in deckCatalog.test.ts.
 */
import { describe, expect, it } from '@jest/globals';

import { buildSeedState } from './seed';

const NOW = 1_700_000_000_000;

describe('buildSeedState — blank slate', () => {
  it('adds no decks and no cards', () => {
    const s = buildSeedState(NOW);
    expect(s.decks).toEqual([]);
    expect(s.cards).toEqual([]);
  });

  it('has zeroed progress: no sessions, no review log, a fresh person', () => {
    const { person, sessions, reviewLog } = buildSeedState(NOW);
    expect(sessions).toEqual([]);
    expect(reviewLog).toEqual([]);
    expect(person.xp).toBe(0);
    expect(person.streak).toBe(0);
    expect(person.bestStreak).toBe(0);
    expect(person.freezes).toBe(0);
    expect(person.achievements).toEqual({});
    expect(person.dayDone).toEqual({ dayKey: expect.any(String), reviews: 0, neww: 0 });
  });

  it('keeps sensible default daily goals (NOT zeroed) so study math never divides by zero', () => {
    const { person } = buildSeedState(NOW);
    expect(person.goalReviews).toBe(30);
    expect(person.goalNew).toBe(10);
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
});
