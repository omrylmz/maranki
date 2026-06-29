/**
 * Seed integrity, asserting the separation the PR keeps intact: deck-level
 * `level` is PROVENANCE/UI (es-sentences is builtin with no single CEFR), while
 * each seeded card carries REAL per-card linguistics. The two concerns are
 * independent — a deck can have level=null yet hold cards across many levels.
 */
import { describe, expect, it } from '@jest/globals';

import { buildSeedState } from './seed';

const NOW = 1_700_000_000_000;

describe('es-sentences seed', () => {
  it('its cards span more than one distinct CEFR level', () => {
    const { cards } = buildSeedState(NOW);
    const es = cards.filter((c) => c.deckId === 'es-sentences');
    expect(es.length).toBeGreaterThan(0);
    const levels = new Set(es.map((c) => c.level));
    expect(levels.size).toBeGreaterThan(1);
  });

  it('every es-sentences card carries a real (non-null) level — linguistics live on the card', () => {
    const { cards } = buildSeedState(NOW);
    const es = cards.filter((c) => c.deckId === 'es-sentences');
    expect(es.every((c) => c.level !== null)).toBe(true);
    expect(es.every((c) => c.type !== null)).toBe(true);
  });

  it('the es-sentences deck itself is builtin with no deck-level CEFR (provenance, not linguistics)', () => {
    const { decks } = buildSeedState(NOW);
    const deck = decks.find((d) => d.id === 'es-sentences');
    expect(deck).toBeDefined();
    expect(deck?.builtin).toBe(true);
    expect(deck?.level).toBeNull();
  });
});
