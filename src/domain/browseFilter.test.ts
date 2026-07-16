/**
 * Unit tests for the pure Library (Browse) filter pipeline, lifted out of
 * browse.tsx so search → filter → sort is testable without React.
 *
 * Pipeline order: collection scope → chip → tag/deck/status filters → search
 * tokens (tag:/deck:) → free text (over front/back/example/notes/tags) → sort.
 * The pipeline is pure: it returns a fresh array and never mutates its inputs.
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
    front: 'front',
    back: 'back',
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
    icon: '🗂️',
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
    fTags: [],
    fStatus: [],
    fDecks: [],
    ...o,
  };
}

const cardApple = makeCard({
  id: 'apple',
  deckId: 'deck-basics',
  front: 'apple',
  back: 'a round fruit',
  example: 'She ate a crisp apple.',
  tags: ['fruit', 'food'],
});
const cardRun = makeCard({
  id: 'run',
  deckId: 'deck-basics',
  front: 'run',
  back: 'to move quickly',
  notes: 'irregular past tense: ran',
  tags: ['verbs'],
});
const cardCat = makeCard({
  id: 'cat',
  deckId: 'deck-extra',
  front: 'cat',
  back: 'a small feline',
  tags: ['animals'],
});

const DECKS: Deck[] = [
  makeDeck({ id: 'deck-basics', name: 'Basics', builtin: true }),
  makeDeck({ id: 'deck-extra', name: 'Extra Vocabulary', builtin: false }),
];

const ALL = [cardApple, cardRun, cardCat];
const ids = (cards: Card[]) => cards.map((c) => c.id).sort();

describe('parseQuery', () => {
  it('extracts tag/deck tokens, lowercases them, and leaves the free text', () => {
    const parsed = parseQuery('Apple tag:Food deck:"Extra Vocabulary"');
    expect(parsed).toEqual({
      text: 'apple',
      tag: 'food',
      deck: 'extra vocabulary',
    });
  });

  it('returns undefined tokens and the lowercased free text when no tokens are present', () => {
    expect(parseQuery('Hello World')).toEqual({
      text: 'hello world',
      tag: undefined,
      deck: undefined,
    });
  });

  it('handles a lone token with empty residual text', () => {
    expect(parseQuery('tag:verbs')).toEqual({
      text: '',
      tag: 'verbs',
      deck: undefined,
    });
  });
});

describe('filterBrowseCards — tag filtering (fTags + tag: token)', () => {
  it('fTags includes only cards carrying a selected tag', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fTags: ['animals'] }), NOW);
    expect(ids(res)).toEqual(['cat']);
  });

  it('fTags across multiple tags unions the matches', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fTags: ['food', 'verbs'] }), NOW);
    expect(ids(res)).toEqual(['apple', 'run']);
  });

  it('search "tag:verbs" matches only the tagged card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'tag:verbs' }), NOW);
    expect(ids(res)).toEqual(['run']);
  });

  it('a tag filter excludes cards without any tags', () => {
    const untagged = makeCard({ id: 'untagged', deckId: 'deck-basics', front: 'x', back: 'y' });
    const res = filterBrowseCards([...ALL, untagged], DECKS, [], makeOpts({ fTags: ['food'] }), NOW);
    expect(res.map((c) => c.id)).not.toContain('untagged');
  });
});

describe('filterBrowseCards — deck / status / collection filters', () => {
  it('deck filter includes only the selected deck', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fDecks: ['deck-extra'] }), NOW);
    expect(ids(res)).toEqual(['cat']);
  });

  it('deck filter across both decks returns every card', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fDecks: ['deck-basics', 'deck-extra'] }), NOW);
    expect(ids(res)).toEqual(['apple', 'cat', 'run']);
  });

  it('"deck:" token matches by deck name', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'deck:extra' }), NOW);
    expect(ids(res)).toEqual(['cat']);
  });

  it('status filter (New) includes every new card', () => {
    // all three fixtures have reps:0 → displayState "new"
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ fStatus: ['New'] }), NOW);
    expect(ids(res)).toEqual(['apple', 'cat', 'run']);
  });

  it('chip "new" keeps only unreviewed cards', () => {
    const reviewed = makeCard({
      id: 'reviewed',
      reps: 5,
      stepIndex: null,
      intervalDays: 30,
      due: NOW - DAY,
      lastReviewedAt: NOW - DAY,
    });
    const res = filterBrowseCards([cardApple, reviewed], DECKS, [], makeOpts({ chip: 'new' }), NOW);
    expect(ids(res)).toEqual(['apple']);
  });

  it('collection scope ("favorites") includes only starred cards', () => {
    const favCard = makeCard({
      id: 'fav-card',
      deckId: 'deck-extra',
      fav: true,
      front: 'thanks',
      back: 'gratitude',
    });
    const collections: Collection[] = [
      { id: 'fav', name: 'Favorites', icon: 'heart', desc: '', query: 'favorites' },
    ];
    const res = filterBrowseCards(
      [cardApple, favCard],
      DECKS,
      collections,
      makeOpts({ collectionId: 'fav' }),
      NOW,
    );
    expect(ids(res)).toEqual(['fav-card']);
  });
});

describe('filterBrowseCards — free-text search over front/back/example/notes/tags', () => {
  it('matches by front', () => {
    expect(ids(filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'apple' }), NOW))).toEqual(['apple']);
  });

  it('matches by back', () => {
    expect(ids(filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'feline' }), NOW))).toEqual(['cat']);
  });

  it('matches by example', () => {
    expect(ids(filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'crisp' }), NOW))).toEqual(['apple']);
  });

  it('matches by notes', () => {
    expect(ids(filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'irregular' }), NOW))).toEqual(['run']);
  });

  it('matches by tag text', () => {
    expect(ids(filterBrowseCards(ALL, DECKS, [], makeOpts({ q: 'animals' }), NOW))).toEqual(['cat']);
  });
});

describe('filterBrowseCards — sort', () => {
  it('sorts az by front', () => {
    const res = filterBrowseCards(ALL, DECKS, [], makeOpts({ sort: 'az' }), NOW);
    expect(res.map((c) => c.front)).toEqual(['apple', 'cat', 'run']);
  });
});

describe('filterBrowseCards — purity', () => {
  it('does not mutate or reorder its input array', () => {
    const input = [cardRun, cardApple, cardCat];
    const snapshot = [...input];
    filterBrowseCards(input, DECKS, [], makeOpts({ sort: 'az' }), NOW);
    expect(input).toEqual(snapshot);
  });
});
