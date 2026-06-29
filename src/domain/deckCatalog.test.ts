/**
 * Curated catalog integrity. Pins the contract the "Add a deck" sheet and
 * DataContext.addCatalogDeck depend on:
 *  - the catalog is a view over the seed's BUILT-IN decks (no parallel corpus);
 *  - every curated card is FILTER-READY (non-null CEFR level AND word type) —
 *    this is the whole reason the Library FAB offers only these;
 *  - buildCatalogCards emits brand-new cards (reps 0, due now) bound to the
 *    entry's deck, preserving linguistics;
 *  - catalogAddPlan encodes the idempotent add/activate/create decision.
 */
import { describe, expect, it } from '@jest/globals';

import { buildCatalogCards, catalogAddPlan, CURATED_DECKS } from './deckCatalog';
import { buildSeedState, splitArticle } from './seed';
import { Deck } from './types';

const NOW = 1_700_000_000_000;

describe('CURATED_DECKS', () => {
  it('is non-empty and its ids are a subset of the seed built-in deck ids', () => {
    expect(CURATED_DECKS.length).toBeGreaterThan(0);
    const builtinIds = new Set(
      buildSeedState(NOW)
        .decks.filter((d) => d.builtin)
        .map((d) => d.id),
    );
    for (const entry of CURATED_DECKS) {
      expect(builtinIds.has(entry.id)).toBe(true);
    }
  });

  it('is FILTER-READY: every spec of every entry carries a non-null CEFR level AND word type', () => {
    for (const entry of CURATED_DECKS) {
      expect(entry.specs.length).toBeGreaterThan(0);
      for (const spec of entry.specs) {
        const level = spec[5];
        const type = spec[6];
        expect(level).not.toBeNull();
        expect(level).toBeTruthy();
        expect(type).not.toBeNull();
        expect(type).toBeTruthy();
      }
    }
  });
});

describe('buildCatalogCards', () => {
  it('emits one brand-new card per spec, bound to the deck, with preserved linguistics', () => {
    for (const entry of CURATED_DECKS) {
      const cards = buildCatalogCards(entry, NOW);
      expect(cards.length).toBe(entry.specs.length);
      cards.forEach((card, i) => {
        // brand new
        expect(card.reps).toBe(0);
        expect(card.stepIndex).toBeNull();
        expect(card.intervalDays).toBe(0);
        expect(card.due).toBe(NOW);
        expect(card.lastReviewedAt).toBeNull();
        // bound + filter-ready
        expect(card.deckId).toBe(entry.id);
        expect(card.level).not.toBeNull();
        expect(card.type).not.toBeNull();
        expect(card.lang).toBe(entry.lang);
        // preserved linguistics: content copied verbatim from the source spec
        const [word, tr, ipa, ex, exTr, level, type] = entry.specs[i];
        const { article, base } = splitArticle(word);
        expect(card.word).toBe(word);
        expect(card.tr).toBe(tr);
        expect(card.ipa).toBe(ipa);
        expect(card.ex).toBe(ex);
        expect(card.exTr).toBe(exTr);
        expect(card.article).toBe(article);
        expect(card.base).toBe(base);
        expect(card.level).toBe(level);
        expect(card.type).toBe(type);
      });
    }
  });

  it('mints a unique id for every card', () => {
    const all = CURATED_DECKS.flatMap((entry) => buildCatalogCards(entry, NOW));
    const ids = new Set(all.map((card) => card.id));
    expect(ids.size).toBe(all.length);
  });
});

describe('catalogAddPlan', () => {
  const base: Deck = {
    id: 'de-everyday',
    name: 'German — Everyday',
    flag: '🇩🇪',
    lang: 'German',
    level: 'A1',
    builtin: true,
    active: true,
    createdAt: NOW,
  };

  it("returns 'noop' for an existing active deck", () => {
    expect(catalogAddPlan([base], 'de-everyday')).toBe('noop');
  });

  it("returns 'activate' for an existing paused deck", () => {
    expect(catalogAddPlan([{ ...base, active: false }], 'de-everyday')).toBe('activate');
  });

  it("returns 'create' for an absent id", () => {
    expect(catalogAddPlan([], 'de-everyday')).toBe('create');
    expect(catalogAddPlan([base], 'fr-basics')).toBe('create');
  });
});
