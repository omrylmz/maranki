/**
 * Pure card-filtering pipeline for the Library (Browse) screen, lifted out of
 * browse.tsx so the search → filter → sort logic is unit-testable without React.
 *
 * Tags are freeform, per-card metadata: a card participates in a tag filter (or
 * the `tag:` search token) only when it actually carries that tag, so cards
 * without tags simply drop out of tag filters. Free-text search spans front,
 * back, example, notes and tags.
 */
import { collectionFilter } from './queue';
import { Card, CardState, Collection, Deck, displayState } from './types';

export type ChipScope = 'all' | 'due' | 'new' | 'fav';
export type SortMode = 'smart' | 'az' | 'newest' | 'hardest';

export const STATUS_FILTERS = [
  'New',
  'Learning',
  'Due',
  'Mastered',
  'Suspended',
  'Flagged',
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface ParsedQuery {
  text: string;
  tag?: string;
  deck?: string;
}

/** Parse `tag:verb deck:"My Deck"` tokens from a query. */
export function parseQuery(q: string): ParsedQuery {
  let text = q;
  const grab = (key: string): string | undefined => {
    const re = new RegExp(`${key}:(?:"([^"]+)"|(\\S+))`, 'i');
    const m = text.match(re);
    if (!m) return undefined;
    text = text.replace(m[0], '').trim();
    return (m[1] ?? m[2]).toLowerCase();
  };
  const tag = grab('tag');
  const deck = grab('deck');
  return { text: text.trim().toLowerCase(), tag, deck };
}

const STATE_PRIORITY: Record<CardState, number> = {
  due: 0,
  learning: 1,
  new: 2,
  review: 3,
  mastered: 4,
};

export interface BrowseFilterOpts {
  /** Optional saved-collection scope (matched against `collections`). */
  collectionId?: string;
  chip: ChipScope;
  /** Raw search box text, including any `tag:`/`deck:` tokens. */
  q: string;
  sort: SortMode;
  fTags: string[];
  fStatus: StatusFilter[];
  fDecks: string[];
}

/**
 * Apply collection scope → chip scope → filter-sheet chips → search tokens →
 * free text → sort, in the exact order the screen has always used. Pure:
 * returns a fresh array and never mutates its inputs.
 */
export function filterBrowseCards(
  cards: Card[],
  decks: Deck[],
  collections: Collection[],
  opts: BrowseFilterOpts,
  now: number,
): Card[] {
  const { collectionId, chip, q, sort, fTags, fStatus, fDecks } = opts;

  let pool = cards;
  if (collectionId) {
    const col = collections.find((x) => x.id === collectionId);
    if (col) {
      const f = collectionFilter(col.query);
      pool = pool.filter((x) => f(x, now));
    }
  }
  if (chip === 'due')
    pool = pool.filter((x) => {
      const s = displayState(x, now);
      return s === 'due' || s === 'learning';
    });
  if (chip === 'new') pool = pool.filter((x) => x.reps === 0);
  if (chip === 'fav') pool = pool.filter((x) => x.fav);

  if (fTags.length) pool = pool.filter((x) => !!x.tags && x.tags.some((t) => fTags.includes(t)));
  if (fDecks.length) pool = pool.filter((x) => fDecks.includes(x.deckId));
  if (fStatus.length) {
    pool = pool.filter((x) => {
      const s = displayState(x, now);
      return fStatus.some((f) => {
        if (f === 'Suspended') return !!x.suspended;
        if (f === 'Flagged') return !!x.flagged;
        return s === f.toLowerCase();
      });
    });
  }

  const parsed = parseQuery(q);
  if (parsed.tag)
    pool = pool.filter((x) => !!x.tags && x.tags.some((t) => t.toLowerCase() === parsed.tag));
  if (parsed.deck) {
    pool = pool.filter((x) => {
      const deck = decks.find((d) => d.id === x.deckId);
      return deck?.name.toLowerCase().includes(parsed.deck!);
    });
  }
  if (parsed.text) {
    const s = parsed.text;
    pool = pool.filter(
      (x) =>
        x.front.toLowerCase().includes(s) ||
        x.back.toLowerCase().includes(s) ||
        (x.example ?? '').toLowerCase().includes(s) ||
        (x.notes ?? '').toLowerCase().includes(s) ||
        (x.tags ?? []).some((t) => t.toLowerCase().includes(s)),
    );
  }

  const sorted = [...pool];
  switch (sort) {
    case 'az':
      sorted.sort((a, b) => a.front.localeCompare(b.front));
      break;
    case 'newest':
      sorted.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'hardest':
      sorted.sort((a, b) => a.ease - b.ease);
      break;
    default:
      sorted.sort(
        (a, b) =>
          STATE_PRIORITY[displayState(a, now)] - STATE_PRIORITY[displayState(b, now)] ||
          a.due - b.due,
      );
  }
  return sorted;
}
