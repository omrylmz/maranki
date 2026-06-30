/**
 * The curated deck catalog — the single source of truth (shared with seed.ts)
 * for the app's built-in, filter-ready decks. The "Add a deck" sheet reads
 * CURATED_DECKS to offer them; DataContext.addCatalogDeck materializes a chosen
 * entry into a real Deck + brand-new Cards.
 *
 * Vocabulary is defined ONCE: the corpora and DECK_SEEDS live in seed.ts (which
 * now opens the app as a blank slate — nothing is auto-added). Here we only
 * re-shape those same built-in seeds into a catalog view, plus a card builder
 * that mints every card brand-new (reps 0, due now) when a deck is added. No
 * vocabulary is authored here.
 */
import { DECK_SEEDS, type Spec } from './seed';
import { splitArticle } from './words';
import { Card, CefrLevel, Deck, DEFAULT_SRS, Lang } from './types';

export type { Spec };

/** A curated deck as offered in the "Add a deck" sheet. */
export interface CatalogDeck {
  id: string;
  name: string;
  flag: string;
  /** Deck.lang — the human-readable display string, e.g. 'German'. */
  deckLang: string;
  /** Per-card language code, e.g. 'de'. */
  lang: Lang;
  level: CefrLevel | null;
  specs: Spec[];
}

/** The app's built-in, filter-ready decks, derived from the shared seed defs. */
export const CURATED_DECKS: CatalogDeck[] = DECK_SEEDS.filter((s) => s.deck.builtin).map((s) => ({
  id: s.deck.id,
  name: s.deck.name,
  flag: s.deck.flag,
  deckLang: s.deck.lang,
  lang: s.lang,
  level: s.deck.level,
  specs: s.specs,
}));

/** A curated language group — the by-language view the catalog UI browses. */
export interface CatalogLanguage {
  /** Per-card language code, e.g. 'de'. */
  lang: Lang;
  /** Display name, e.g. 'German' (= Deck.lang). */
  deckLang: string;
  flag: string;
  decks: CatalogDeck[];
}

/**
 * CURATED_DECKS grouped by language, preserving first-seen order. This is what
 * the "Add a deck" sheet and onboarding browse: a short list of languages that
 * stays legible no matter how many curated decks — or languages — we ship. The
 * decks themselves are only revealed once a language is chosen, so the create
 * surface never gets polluted as the catalog grows.
 */
export const CURATED_LANGUAGES: CatalogLanguage[] = (() => {
  const groups: CatalogLanguage[] = [];
  const byName = new Map<string, CatalogLanguage>();
  for (const deck of CURATED_DECKS) {
    let group = byName.get(deck.deckLang);
    if (!group) {
      group = { lang: deck.lang, deckLang: deck.deckLang, flag: deck.flag, decks: [] };
      byName.set(deck.deckLang, group);
      groups.push(group);
    }
    group.decks.push(deck);
  }
  return groups;
})();

/* Card-id minting: a uid('c')-style monotonic counter that mirrors
   DataContext's uid(). The "cat" infix keeps these ids provably disjoint from
   DataContext's `c-<t>-<n>` ids (numeric tail) and the seed's `<deckId>-<n>`
   ids, so re-adding a previously deleted curated deck can never collide with an
   existing card. */
let catalogCardCounter = 0;
function mintCatalogCardId(): string {
  catalogCardCounter += 1;
  return `c-${Date.now().toString(36)}-cat${catalogCardCounter}`;
}

/**
 * Materialize a catalog entry's specs into BRAND-NEW cards (reps 0, due now):
 * a freshly-added deck always starts unstudied. Linguistics (level/type) are
 * copied through non-null, which is precisely what makes these cards
 * Library-filterable.
 *
 * `mintId` defaults to the local collision-safe minter; a caller may inject its
 * own id source (e.g. DataContext's uid) without changing the result shape.
 */
export function buildCatalogCards(
  entry: CatalogDeck,
  now: number,
  mintId: () => string = mintCatalogCardId,
): Card[] {
  return entry.specs.map((spec, i) => {
    const [word, tr, ipa, ex, exTr, level, type] = spec;
    const { article, base } = splitArticle(word);
    return {
      id: mintId(),
      deckId: entry.id,
      word,
      article,
      base,
      tr,
      ipa,
      ex,
      exTr,
      level,
      type,
      lang: entry.lang,
      fav: false,
      flagged: false,
      suspended: false,
      buriedUntil: null,
      ease: DEFAULT_SRS.startingEase,
      intervalDays: 0,
      stepIndex: null,
      reps: 0,
      lapses: 0,
      due: now,
      createdAt: now + i,
      lastReviewedAt: null,
    };
  });
}

/**
 * Materialize a catalog entry into a real, ACTIVE Deck plus its brand-new Cards
 * — the transform behind DataContext.addCatalogDeck's 'create' path, and the one
 * place a fresh install gains a deck. Pulled out of the store so the mapping is
 * unit-testable. Mind the deliberate split: the Deck carries the DISPLAY language
 * name (Deck.lang, e.g. 'German') for grouping and filters, while each Card
 * carries the per-card CODE (Card.lang, e.g. 'de') for speech.
 */
export function materializeCatalogDeck(
  entry: CatalogDeck,
  now: number,
  mintId?: () => string,
): { deck: Deck; cards: Card[] } {
  const deck: Deck = {
    id: entry.id,
    name: entry.name,
    flag: entry.flag,
    lang: entry.deckLang,
    level: entry.level,
    builtin: true,
    active: true,
    createdAt: now,
  };
  return { deck, cards: buildCatalogCards(entry, now, mintId) };
}

/**
 * Pure decision behind addCatalogDeck, extracted so the idempotency rules are
 * unit-testable:
 *  - 'noop'     the deck already exists and is active — nothing to do.
 *  - 'activate' the deck exists but is paused — flip it back on (rejoin queue).
 *  - 'create'   no such deck — materialize it fresh.
 */
export function catalogAddPlan(decks: Deck[], id: string): 'noop' | 'activate' | 'create' {
  const existing = decks.find((d) => d.id === id);
  if (!existing) return 'create';
  return existing.active ? 'noop' : 'activate';
}
