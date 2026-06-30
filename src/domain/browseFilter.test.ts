/**
 * Unit tests for the pure Library (Browse) filter pipeline.
 *
 * These PIN the PR #1 "Path A" decision: the ABSENCE of linguistic metadata is
 * represented in the TYPE (Card.level / Card.type are nullable) and level/type
 * are gated PER CARD on `!= null` — not on deck provenance. The key regression
 * guarded here is that an imported card with level=null must NOT behave like a
 * real A1 card under a level filter, while Deck / Status / free-text filters
 * keep working for every card regardless of null linguistics.
 */
import { describe, expect, it } from '@jest/globals';

import {
  BrowseFilterOpts,
  filterBrowseCards,
  parseQuery,
} from './browseFilter';
import { Card, Collection, DAY, Deck } from './types';

const NOW = 1_700_000_000_000;

function makeCard(o: Partial<Card> & Pick<Card, 'id'>): Card {
  return {
    deckId: 'd',
    word: 'word',
    article: null,
    base: 'word',
    tr: 'translation',
    level: null,
    type: null,
    lang: 'es',
    ease: 2.5,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: NOW,
    createdAt: NOW,
    lastReviewedAt: null,
    ...o,
  };
}

function makeDeck(o: Partial<Deck> & Pick<Deck, 'id' | 'name'>): Deck {
  return {
    flag: '🏳️',
    lang: 'es',
    level: null,
    builtin: false,
    active: true,
    createdAt: 0,
    ...o,
  };
}

function makeOpts(o: Partial<BrowseFilterOpts> = {}): BrowseFilterOpts {
  return {
    chip: 'all',
    q: '',
    sort: 'smart',
    fLevels: [],
    fStatus: [],
    fDecks: [],
    ...o,
  };
}

// A curated, built-in card carrying real linguistic metadata.
const curatedA1 = makeCard({
  id: 'curated-a1',
  deckId: 'de-everyday',
  word: 'die Stunde',
  base: 'Stunde',
  tr: 'the hour',
  level: 'A1',
  type: 'noun',
  lang: 'de',
});
const curatedB1 = makeCard({
  id: 'curated-b1',
  deckId: 'de-everyday',
  word: 'entwickeln',
  base: 'entwickeln',
  tr: 'to develop',
  level: 'B1',
  type: 'verb',
  lang: 'de',
});
// An imported card: the source carried NO level/type, so both are null.
const imported = makeCard({
  id: 'imported-1',
  deckId: 'imp-deck',
  word: 'hola',
  base: 'hola',
  tr: 'hello',
  level: null,
  type: null,
  lang: 'es',
});

const DECKS: Deck[] = [
  makeDeck({ id: 'de-everyday', name: 'German — Everyday', lang: 'de', builtin: true, level: 'A1' }),
  makeDeck({ id: 'imp-deck', name: 'Imported CSV', lang: 'es', builtin: false, level: null }),
];

const ALL = [curatedA1, curatedB1, imported];
const ids = (cards: Card[]) => cards.map((c) => c.id).sort();

describe('parseQuery', () => {
  it('extracts level/type/deck tokens, lowercases them, and leaves the free text', () => {
    const parsed = parseQuery('Hola level:B1 type:Verb deck:"German — Everyday"');
    expect(parsed).toEqual({
      text: 'hola',
      level: 'b1',
      type: 'verb',
      deck: 'german — everyday',
    });
  });

  it('returns undefined tokens and the lowercased free text when no tokens are present', () => {
    expect(parseQuery('Hello World')).toEqual({
      text: 'hello world',
      level: undefined,
      type: undefined,
      deck: undefined,
    });
  });

  it('handles a lone token with empty residual text', () => {
    expect(parseQuery('level:A1')).toEqual({
      text: '',
      level: 'a1',
      type: undefined,
      deck: undefined,
    });
  });
});

describe('filterBrowseCards — per-card level/type gating (PR #1 Path A)', () => {
  it('EXCLUDES a null-level card from a level filter and INCLUDES the real A1 card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fLevels: ['A1'] }), NOW);
    expect(ids(res)).toEqual(['curated-a1']);
    // the regression guard: the null-level import must NOT be treated as an A1.
    expect(res.map((c) => c.id)).not.toContain('imported-1');
  });

  it('keeps excluding the null-level card even under a multi-level filter', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fLevels: ['A1', 'B1'] }), NOW);
    expect(ids(res)).toEqual(['curated-a1', 'curated-b1']);
    expect(res.map((c) => c.id)).not.toContain('imported-1');
  });

  it('search "level:a1" matches the A1 card and EXCLUDES the null-level card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'level:a1' }), NOW);
    expect(ids(res)).toEqual(['curated-a1']);
  });

  it('search "level:b1" matches only the B1 card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'level:b1' }), NOW);
    expect(ids(res)).toEqual(['curated-b1']);
  });

  it('search "type:noun" EXCLUDES the null-type card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'type:noun' }), NOW);
    expect(ids(res)).toEqual(['curated-a1']);
    expect(res.map((c) => c.id)).not.toContain('imported-1');
  });

  it('search "type:verb" matches only the verb card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'type:verb' }), NOW);
    expect(ids(res)).toEqual(['curated-b1']);
  });

  it('a CSV-style card with a REAL level participates in its level filter (old builtin gate would have hidden it)', () => {
    const csvCard = makeCard({
      id: 'csv-real',
      deckId: 'imp-deck', // imported provenance (builtin: false)...
      level: 'A2', // ...but it carries a real Level column
      type: 'noun',
      word: 'gato',
      tr: 'cat',
    });
    const res = filterBrowseCards([csvCard, imported], DECKS, [], makeOpts({ fLevels: ['A2'] }), NOW);
    expect(ids(res)).toEqual(['csv-real']);
  });
});

describe('filterBrowseCards — universal filters work for ALL cards regardless of null linguistics', () => {
  it('deck filter includes the imported (null-meta) card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fDecks: ['imp-deck'] }), NOW);
    expect(ids(res)).toEqual(['imported-1']);
  });

  it('deck filter across both decks returns every card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fDecks: ['de-everyday', 'imp-deck'] }), NOW);
    expect(ids(res)).toEqual(['curated-a1', 'curated-b1', 'imported-1']);
  });

  it('free-text search matches the null-meta card by word', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'hola' }), NOW);
    expect(ids(res)).toEqual(['imported-1']);
  });

  it('free-text search matches a curated card by its translation', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'hour' }), NOW);
    expect(ids(res)).toEqual(['curated-a1']);
  });

  it('"deck:" token matches by deck name and resolves the null-meta deck', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'deck:imported' }), NOW);
    expect(ids(res)).toEqual(['imported-1']);
  });

  it('status filter (New) includes every new card, including the null-level import', () => {
    // all three fixtures have reps:0 → displayState "new"
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fStatus: ['New'] }), NOW);
    expect(ids(res)).toEqual(['curated-a1', 'curated-b1', 'imported-1']);
  });

  it('chip "new" keeps only unreviewed cards, irrespective of level/type nullness', () => {
    const reviewed = makeCard({
      id: 'reviewed',
      level: null,
      type: null,
      reps: 5,
      stepIndex: null,
      intervalDays: 30,
      due: NOW - DAY,
      lastReviewedAt: NOW - DAY,
    });
    const res = filterBrowseCards([curatedA1, reviewed], DECKS, [], makeOpts({ chip: 'new' }), NOW);
    expect(ids(res)).toEqual(['curated-a1']);
  });

  it('collection scope ("favorites") includes a starred null-level card', () => {
    const favImport = makeCard({
      id: 'fav-import',
      deckId: 'imp-deck',
      level: null,
      type: null,
      fav: true,
      word: 'gracias',
      tr: 'thanks',
    });
    const collections: Collection[] = [
      { id: 'fav', name: 'Favorites', icon: 'heart', desc: '', query: 'favorites' },
    ];
    const res = filterBrowseCards(
      [curatedA1, favImport],
      DECKS,
      collections,
      makeOpts({ collectionId: 'fav' }),
      NOW,
    );
    expect(ids(res)).toEqual(['fav-import']);
  });
});

describe('filterBrowseCards — purity', () => {
  it('does not mutate or reorder its input array', () => {
    const input = [curatedB1, curatedA1, imported];
    const snapshot = [...input];
    filterBrowseCards(input, DECKS, [], makeOpts({ sort: 'az' }), NOW);
    expect(input).toEqual(snapshot);
  });
});
