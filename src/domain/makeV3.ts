/**
 * Shared constructors for the v3 note model (spec §3.4, unit W0-2).
 *
 * Every place that creates a note, a card or a deck (card editor, import
 * planner, migration v2 → v3, duplicate deck, starter decks) builds it here,
 * so the defaults live in ONE place.
 *
 * Pure: the clock (`now`) and ids come in as arguments. Two rules for every
 * constructor:
 *   - Every optional key the caller passes survives into the result.
 *   - An explicit `undefined` never replaces a default. (A missing value must
 *     never become `undefined` in SRS math — that gives NaN due dates.)
 */
import { BUILTIN_TYPE_IDS } from './builtinTypes';
import type { Card, Deck, DeckOptions, Id, Note, SrsSettings } from './model';

/** Deck emoji when none is given (same as today's addDeck). */
export const DEFAULT_DECK_ICON = '🗂️';

/** Options of a new deck (spec §3.5 uses the same values for migrated decks). */
export const DEFAULT_DECK_OPTIONS: Readonly<DeckOptions> = Object.freeze({
  newPerDay: null,
  newOrder: 'source',
  newArrival: 'queued',
  knownChecks: true,
});

/** Copy only the keys whose value is not `undefined`. */
function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (o[key] !== undefined) out[key] = o[key];
  }
  return out;
}

/* ------------------------------------------------------------------ notes */

/** `id`, `typeId` and `fields` are required; every other Note key is optional. */
export type MakeNoteInput = Pick<Note, 'id' | 'typeId' | 'fields'> &
  Partial<Omit<Note, 'id' | 'typeId' | 'fields'>>;

/**
 * Build a Note. Defaults: no tags, section '' (deck root), guid 'm-<id>',
 * order = createdAt (so notes keep their creation order), source 'manual',
 * createdAt = updatedAt = now.
 * The fields and tags arrays are copied, so the caller's arrays are never shared
 * with the stored note.
 */
export function makeNote(input: MakeNoteInput, now: number): Note {
  const given = definedOnly(input);
  return {
    tags: [],
    section: '',
    // The note id is already unique, so 'm-' + id is a unique manual guid.
    guid: `m-${input.id}`,
    // Default order = the GIVEN createdAt, not `now`: a caller that passes
    // only createdAt (e.g. a migration step) must not give every note the
    // same order. makeCard copies it to newPos, the 'source' feed order.
    order: given.createdAt ?? now,
    source: { kind: 'manual' },
    createdAt: now,
    updatedAt: now,
    ...given,
    id: input.id,
    typeId: input.typeId,
    fields: [...input.fields],
    ...(given.tags ? { tags: [...given.tags] } : {}),
    ...(given.source ? { source: { ...given.source } } : {}),
  };
}

/* ------------------------------------------------------------------ cards */

/**
 * Everything on a Card except what the positional arguments set.
 *
 * `id` is REQUIRED, and there is no default id made from (note, ord). Why: a
 * card id must never be used twice. The review history (the `revlog` table,
 * spec §3.8) keeps the rows of a deleted card, and undo entries point at card
 * ids. Cloze sync can delete card c2 of a note and later create c2 again. A
 * default like '<noteId>:<ord>' would give the new card the old card's id, so
 * `cardHistory(id)` would show the old reviews on a brand-new card, and an
 * undo could copy the old card's SRS values onto it. So the caller decides:
 *   - a NEW card (addNote, import, cloze sync, setDirections, duplicateDeck)
 *     → a fresh id from `ctx.newId()`;
 *   - the SAME card built again in the new shape (migration v2 → v3 keeps
 *     every v2 card id, spec §3.5) → its existing id.
 *
 * Also pass `newState`/`newPos` for the new-card feed, and the SRS keys to
 * keep imported Anki progress.
 */
export type MakeCardOpts = Pick<Card, 'id'> & Partial<Omit<Card, 'id' | 'noteId' | 'deckId' | 'ord'>>;

/**
 * Build a Card for direction `ord` of `note`, in deck `deckId`, with the id
 * `opts.id` (see MakeCardOpts: never reuse the id of a deleted card).
 *
 * The SRS defaults equal today's addCard (DataContext): ease =
 * srs.startingEase, intervalDays 0, stepIndex null, reps 0, lapses 0,
 * due = now, createdAt = now, lastReviewedAt null; and fav/flagged/suspended
 * false, buriedUntil null.
 *
 * Feed defaults: newPos = note.order (siblings share it), newState absent
 * (= 'queued', a New card). Pass `{ newState: 'notStarted' }` for a deck whose
 * newArrival is 'notStarted'.
 */
export function makeCard(
  note: Pick<Note, 'id' | 'order'>,
  ord: number,
  deckId: Id,
  srs: Pick<SrsSettings, 'startingEase'>,
  now: number,
  opts: MakeCardOpts,
): Card {
  const { id, ...rest } = opts;
  return {
    newPos: note.order,
    fav: false,
    flagged: false,
    suspended: false,
    buriedUntil: null,
    ease: srs.startingEase,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: now,
    createdAt: now,
    lastReviewedAt: null,
    ...definedOnly(rest),
    id,
    noteId: note.id,
    deckId,
    ord,
  };
}

/* ------------------------------------------------------------------ decks */

/**
 * `id` and `name` are required; every other Deck key is optional. `options`
 * may be partial: the missing keys come from DEFAULT_DECK_OPTIONS.
 */
export type MakeDeckInput = Pick<Deck, 'id' | 'name'> &
  Partial<Omit<Deck, 'id' | 'name' | 'options'>> & { options?: Partial<DeckOptions> };

/**
 * Build a Deck. Defaults: icon 🗂️, active (not paused), order 0, source
 * 'manual', defaultTypeId 'nt-basic', DEFAULT_DECK_OPTIONS, createdAt = now.
 * A caller that adds the deck at the END of the list passes
 * `order: nextDeckOrder(state.decks)`.
 */
export function makeDeck(input: MakeDeckInput, now: number): Deck {
  const { options, ...rest } = input;
  return {
    icon: DEFAULT_DECK_ICON,
    active: true,
    order: 0,
    source: 'manual',
    defaultTypeId: BUILTIN_TYPE_IDS.basic,
    createdAt: now,
    ...definedOnly(rest),
    id: input.id,
    name: input.name,
    options: { ...DEFAULT_DECK_OPTIONS, ...definedOnly(options ?? {}) },
  };
}

/** The `order` that puts a new deck after every existing deck (0 for the first deck). */
export function nextDeckOrder(decks: readonly Pick<Deck, 'order'>[]): number {
  let max = -1;
  for (const d of decks) {
    if (Number.isFinite(d.order) && d.order > max) max = d.order;
  }
  return max + 1;
}
