/**
 * The note commands of the note model (spec §3.6 "notes" and "decks and card
 * types", unit W2-7). Pure, not wired yet: the v3 reducer (W3-2) calls them;
 * screens do not.
 *
 *   addNote        a note + one card per enabled direction (cloze: per cloze number)
 *   editNote       new field values / tags; cloze notes keep their cards in sync
 *                  (returns the cards it removed, for an in-memory "Undo")
 *   moveNotes      move whole notes (ALL their cards) to a deck, optionally to a section
 *   tagNotes       add and remove tags
 *   deleteNotes    remove notes and all their cards; returns what it removed
 *   restoreNotes   put deleted notes back (the in-memory "Undo" of a delete)
 *   restoreCards   put back the cards a cloze edit removed (the editor's "Undo")
 *   duplicateDeck  a copy of a deck: new ids and guids, no progress
 *   setDirections  turn directions on or off for one card type in one deck
 *
 * A NOTE is the information you enter once; it has one CARD per enabled
 * direction (glossary §1.2). Rules every command keeps:
 *   - all cards of one note are in ONE deck (`Card.deckId` is the home deck;
 *     a move is per note, never per card);
 *   - a new card always gets a FRESH id from `ctx.newId` — never the id of a
 *     deleted card (makeV3.ts explains why: the review history keeps it);
 *   - a new card gets the feed position of its never-studied siblings in
 *     the deck (siblings share it, spec §3.4), or `note.order` when it has
 *     none; and `newState = deck.options.newArrival`, except that it stays
 *     Not started when every never-studied sibling in the deck is Not
 *     started (siblingArrival: Not started is a state of the ITEM);
 *   - a note that has a card keeps at least one (editNote's cloze sync too),
 *     so it never disappears from the Library;
 *   - the state is never changed in place; unchanged objects keep their
 *     identity (the row store saves by object identity, §3.8).
 *
 * Pure: no React, no clock. Time and ids come in through `ctx`.
 */
import { builtinKindOf, builtinType } from './builtinTypes';
import { clozeNumbers } from './cloze';
import { omitKeys } from './make';
import {
  commitEdit,
  type EditResult,
  newEdit,
  type NoteModelState,
  type OpCtx,
  type OpStep,
} from './manualLog';
import { makeCard, makeDeck, makeNote, nextDeckOrder } from './makeV3';
import type { Card, Deck, Id, ManualEdit, Note, NoteType } from './model';
import { clozeFields } from './render';
import { plural } from './text';

/** Id prefixes of the objects these commands create. */
export const NOTE_ID_PREFIX = 'n';
export const CARD_ID_PREFIX = 'c';
export const DECK_ID_PREFIX = 'd';

/* ---------------------------------------------------------------- helpers */

/**
 * The card type with this id: the one in state, or — for a built-in id that
 * is not in state yet — a fresh built-in definition (built-in types are
 * written into state the first time a note uses them, builtinTypes.ts).
 * null = unknown id.
 */
export function findNoteType(state: Pick<NoteModelState, 'noteTypes'>, typeId: Id, now: number): NoteType | null {
  const stored = state.noteTypes.find((t) => t.id === typeId);
  if (stored) return stored;
  const kind = builtinKindOf(typeId);
  return kind ? builtinType(kind, now) : null;
}

/**
 * Clean a tag list: trim each tag, drop empty ones, and drop repeats (Anki
 * compares tags without case, so "Verb" and "verb" are one tag; the first
 * spelling wins).
 *
 *   cleanTags([' verb', 'Verb', '', 'a1']) → ['verb', 'a1']
 */
export function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = String(raw ?? '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * The tag a starter deck update gives to an item that the newer version of
 * the deck no longer has (a "retired" note, starterDecks.ts). Its cards are
 * suspended, nothing is deleted. The Tags filter shows it as "not in new
 * version" (underscores show as spaces), so the learner can find these items
 * and delete them, or unsuspend them to keep studying.
 */
export const RETIRED_TAG = 'not_in_new_version';

/**
 * A note's values moved from one field list to another, by field NAME: a
 * value goes to the field with the same name, and a field that is new gets
 * ''. Used when a card type follows a newer version of its Anki model
 * (plan.ts `upgradeNoteType`, reducer `applyImport`). A value whose field is
 * not in `to` is dropped, so callers check first that no such value has text
 * (`fieldHasText`).
 *
 *   remapFields(['Haus', 'house'], ['Word', 'Meaning'], ['Word', 'Meaning', 'Type'])
 *   → ['Haus', 'house', '']
 */
export function remapFields(values: readonly string[], from: readonly string[], to: readonly string[]): string[] {
  return to.map((name) => {
    const i = from.indexOf(name);
    return i >= 0 ? (values[i] ?? '') : '';
  });
}

/**
 * True when a field value has text: anything but spaces. The one rule for
 * "may this field be removed?" (plan.ts and the reducer must agree): a value
 * of only `<br>` counts as text, so nothing is ever removed by mistake.
 */
export function fieldHasText(value: string | undefined): boolean {
  return (value ?? '').trim() !== '';
}

/**
 * Field values aligned with the card type: a short list is padded with ''.
 * A longer list is accepted only when the extra values are empty (they are
 * dropped); otherwise null — a caller bug that must never silently lose text.
 */
function alignFields(fields: readonly string[], type: NoteType): string[] | null {
  const out = fields.map((f) => (typeof f === 'string' ? f : String(f ?? '')));
  if (out.slice(type.fields.length).some((f) => f !== '')) return null;
  out.length = Math.min(out.length, type.fields.length);
  while (out.length < type.fields.length) out.push('');
  return out;
}

/**
 * The card ords of a cloze note: one per cloze number (ord = number − 1),
 * sorted. The markup is read by cloze.ts, the one cloze parser that
 * renderFace also uses: {{c1,2::…}} gives cards 1 and 2, {{c0::…}} gives no
 * card. Only the fields where renderFace hides deletions are read
 * (render.clozeFields: the question fields of the template, where Anki's
 * {{cloze:Field}} is). So every ord made here has a face with its deletion
 * hidden. A note with NO cloze number still gets ord 0, like Anki (every
 * note has at least one card, so it never disappears from the Library).
 *
 *   "{{c1::Berlin}} is in {{c3::Germany}}" → [0, 2]
 *   "{{c1,2::Paris}}"                       → [0, 1]
 */
export function clozeOrds(type: NoteType, fields: readonly string[]): number[] {
  const ords = new Set<number>();
  for (const i of clozeFields(type)) {
    const value = fields[i];
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    for (const n of clozeNumbers(text)) ords.add(n - 1);
  }
  if (ords.size === 0) return [0];
  return [...ords].sort((a, b) => a - b);
}

/** The ords of a standard type's templates, sorted, without repeats. */
function templateOrds(type: NoteType): number[] {
  return [...new Set(type.templates.map((t) => t.ord))].sort((a, b) => a - b);
}

/**
 * The directions (ords) a NEW note of `type` gets in `deck` (spec §3.4
 * `DeckOptions.directions`):
 *   - the deck lists ords for this type → those (that exist as templates);
 *   - no list → "every ord that has cards": the ords the deck's cards of this
 *     type already have;
 *   - no list and no cards of this type yet → every template.
 * Never empty when the type has a template: if every direction is turned off,
 * the first one is used, so a new note never becomes invisible (no cards).
 * Cloze types: the cloze numbers decide (see clozeOrds), not this function.
 */
export function enabledOrds(state: Pick<NoteModelState, 'notes' | 'cards'>, deck: Deck, type: NoteType): number[] {
  const all = templateOrds(type);
  if (all.length === 0) return [];
  let picked: number[];
  const listed = deck.options.directions?.[type.id];
  if (listed) {
    picked = all.filter((ord) => listed.includes(ord));
  } else {
    const typeNotes = new Set(state.notes.filter((n) => n.typeId === type.id).map((n) => n.id));
    const withCards = new Set<number>();
    for (const c of state.cards) if (c.deckId === deck.id && typeNotes.has(c.noteId)) withCards.add(c.ord);
    picked = withCards.size > 0 ? all.filter((ord) => withCards.has(ord)) : all;
  }
  return picked.length > 0 ? picked : [all[0]];
}

/** The ords a note's cards should have: cloze numbers, or the deck's enabled directions. */
function wantedOrds(
  state: Pick<NoteModelState, 'notes' | 'cards'>,
  deck: Deck,
  type: NoteType,
  fields: readonly string[],
): number[] {
  return type.kind === 'cloze' ? clozeOrds(type, fields) : enabledOrds(state, deck, type);
}

/**
 * The feed position a NEW card of a note gets in a deck (spec §3.4 `newPos`:
 * "Siblings share it"): the position of the note's never-studied cards in
 * that deck (the smallest one, if they differ), or `note.order` when the note
 * has none there.
 *
 * WHY not always note.order: learn({ first }) moves a note's never-studied
 * cards to the front of the feed (newPos 4 instead of 40). A direction turned
 * on later must follow its sibling to the front, not wait at the old place.
 * A studied card's position is not used: it has a schedule, so its feed
 * position no longer means anything.
 */
function siblingNewPos(cards: readonly Card[], note: Pick<Note, 'id' | 'order'>, deckId: Id): number {
  let pos = Infinity;
  for (const c of cards) {
    if (c.noteId === note.id && c.deckId === deckId && c.reps === 0 && Number.isFinite(c.newPos) && c.newPos < pos) {
      pos = c.newPos;
    }
  }
  return Number.isFinite(pos) ? pos : note.order;
}

/**
 * The arrival state of a NEW card of a note in a deck: Not started when the
 * note already has never-studied cards in that deck and EVERY one of them is
 * Not started; otherwise the deck's `newArrival`.
 *
 * WHY: "Not started" is a choice about the ITEM, not about one card. Triage
 * works per item (spec §8.5), and the glossary says Study never shows a Not
 * started card "until you choose it". A direction turned on later, or a new
 * cloze number, must not put the item into Study while its other cards still
 * wait in "Choose what to learn". This follows the siblings in the same way
 * siblingNewPos does for the feed position.
 * Known cards (`knownAt`) and studied cards (`reps > 0`) are not
 * never-studied siblings, so they do not decide this.
 */
function siblingArrival(
  cards: readonly Card[],
  note: Pick<Note, 'id'>,
  deck: Pick<Deck, 'id' | 'options'>,
): 'queued' | 'notStarted' {
  let fresh = 0;
  for (const c of cards) {
    if (c.noteId !== note.id || c.deckId !== deck.id || c.reps !== 0 || c.knownAt != null) continue;
    if (c.newState !== 'notStarted') return deck.options.newArrival;
    fresh += 1;
  }
  return fresh > 0 ? 'notStarted' : deck.options.newArrival;
}

/** Where a new card arrives: its feed position and its arrival state. */
interface Arrival {
  newPos: number;
  newState: 'queued' | 'notStarted';
}

/** The arrival of a new card of `note` in `deck`, from the note's existing cards (siblingNewPos + siblingArrival). */
function siblingsArrival(cards: readonly Card[], note: Pick<Note, 'id' | 'order'>, deck: Deck): Arrival {
  return { newPos: siblingNewPos(cards, note, deck.id), newState: siblingArrival(cards, note, deck) };
}

/** New cards for `ords` of `note` in `deck` (fresh ids, the feed position and arrival state of `arrival`). */
function newCardsFor(
  note: Pick<Note, 'id' | 'order'>,
  ords: readonly number[],
  deck: Deck,
  arrival: Arrival,
  state: Pick<NoteModelState, 'settings'>,
  ctx: OpCtx,
): Card[] {
  return ords.map((ord) =>
    makeCard(note, ord, deck.id, state.settings.srs, ctx.now, {
      id: ctx.newId(CARD_ID_PREFIX),
      newPos: arrival.newPos,
      newState: arrival.newState,
    }),
  );
}

/** Add `type` to the state's card types when it is not there yet (first use of a built-in type). */
function withNoteType<S extends NoteModelState>(state: S, type: NoteType): S {
  if (state.noteTypes.some((t) => t.id === type.id)) return state;
  return { ...state, noteTypes: [...state.noteTypes, type] };
}

/** Same strings in the same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/* --------------------------------------------------------------- addNote */

export interface AddNoteInput {
  deckId: Id;
  typeId: Id;
  /** Aligned with the card type's fields; a short list is padded with ''. */
  fields: string[];
  tags: string[];
  /** Section path below the deck root ('Verbs::B1'). Default '' (the deck root). */
  section?: string;
}

/**
 * Add one note and its cards (the card editor's Save).
 *   - Standard type: one card per enabled direction of the deck (enabledOrds).
 *   - Cloze type: one card per cloze number in the text.
 *   - Every card: newPos = note.order (a new note has no siblings yet),
 *     newState = deck.options.newArrival.
 *   - A built-in card type is written into state on its first use.
 * The note gets a manual guid ('m-<id>'), order = now (it comes after the
 * deck's existing cards in deck order), and cleaned tags.
 *
 * Returns null (and changes nothing) when the deck or the card type does not
 * exist, or when `fields` has more non-empty values than the type has fields.
 */
export function addNote<S extends NoteModelState>(
  state: S,
  input: AddNoteInput,
  ctx: OpCtx,
): OpStep<S, { noteId: Id; cardIds: Id[] } | null> {
  const deck = state.decks.find((d) => d.id === input.deckId);
  const type = findNoteType(state, input.typeId, ctx.now);
  const fields = type ? alignFields(input.fields, type) : null;
  if (!deck || !type || !fields) return { state, result: null };

  const note = makeNote(
    {
      id: ctx.newId(NOTE_ID_PREFIX),
      typeId: type.id,
      fields,
      tags: cleanTags(input.tags),
      section: input.section ?? '',
      source: { kind: 'manual' },
    },
    ctx.now,
  );
  // A new note has no siblings yet: its cards start at note.order.
  const cards = newCardsFor(
    note,
    wantedOrds(state, deck, type, fields),
    deck,
    { newPos: note.order, newState: deck.options.newArrival },
    state,
    ctx,
  );
  const next = withNoteType(state, type);
  return {
    state: { ...next, notes: [...next.notes, note], cards: [...next.cards, ...cards] },
    result: { noteId: note.id, cardIds: cards.map((c) => c.id) },
  };
}

/* -------------------------------------------------------------- editNote */

export interface EditNoteInput {
  noteId: Id;
  patch: { fields?: string[]; tags?: string[] };
}

/** What editNote changed in the cards (only a cloze note's cards change). */
export interface EditNoteResult {
  /** Cards made for new cloze numbers. */
  addedCardIds: Id[];
  /** Cards removed because their cloze number is gone from the text. */
  removedCardIds: Id[];
  /**
   * The same removed cards, WHOLE (with their progress), each with its index
   * in the old `state.cards` (ascending) — the shape of DeletedNotes.cards.
   * The editor keeps this in memory for its "Undo": restoreCards puts the
   * cards back, then editNote with the old text keeps them (see restoreCards).
   */
  removedCards: { index: number; card: Card }[];
}

/**
 * Change a note's field values and/or tags (the card editor's Save on an
 * existing card). Every direction shows the new text, because the cards read
 * the note.
 *
 * Cloze sync: a cloze note has one card per cloze number. It runs only when
 * the text REALLY changed (a save with the same fields, or a tags-only save,
 * never touches the cards). It changes only what the edit changed:
 *   - a card whose number the edit REMOVED (in the old text, not in the new
 *     one) is removed — and returned whole in `removedCards`, so a mistake
 *     ("{{c2::" deleted by accident) can be undone without losing that
 *     card's progress;
 *   - a number the edit ADDED (in the new text, not in the old one) gets a
 *     new card (fresh id, in the note's deck, at its siblings' feed position)
 *     when the note has no card for it;
 *   - every other card is KEPT as it is (its progress survives:
 *     "{{c1::…}}" stays card 1 with its schedule);
 *   - the note always keeps AT LEAST ONE card: when the edit would remove
 *     every card it has and add none, it gets a new card for the smallest
 *     ord of the new text (also when that number was in the old text).
 *     Example: the text is "{{c1::a}} {{c2::b}}" but the note has only card
 *     2 (one subdeck was imported). The edit "{{c1::a}} b" removes card 2
 *     and adds card 1. Without that card the note would vanish from the
 *     Library for good (a cloze type has no Directions to give it a card).
 *     The removed card is still returned in `removedCards`. (If the old
 *     cards point at a deck that no longer exists, no card can be made, so
 *     the old cards are kept instead.)
 * WHY "only what the edit changed": an Anki import can bring a card whose
 * number is no longer in the text (Anki keeps it until "Empty Cards"), or
 * only some cards of a note (only some subdecks were chosen). Fixing a typo
 * must not delete such a card with its progress, or add a card the learner
 * did not import.
 * A standard note's cards never change here (directions are a deck setting,
 * see setDirections).
 *
 * Returns null (and changes nothing) when the note does not exist, or when
 * `fields` has more non-empty values than the card type has fields.
 */
export function editNote<S extends NoteModelState>(
  state: S,
  input: EditNoteInput,
  ctx: OpCtx,
): OpStep<S, EditNoteResult | null> {
  const note = state.notes.find((n) => n.id === input.noteId);
  if (!note) return { state, result: null };
  const type = findNoteType(state, note.typeId, ctx.now);

  let fields = note.fields;
  if (input.patch.fields) {
    const aligned = type ? alignFields(input.patch.fields, type) : [...input.patch.fields];
    if (!aligned) return { state, result: null };
    if (!sameList(aligned, note.fields)) fields = aligned;
  }
  let tags = note.tags;
  if (input.patch.tags) {
    const cleaned = cleanTags(input.patch.tags);
    if (!sameList(cleaned, note.tags)) tags = cleaned;
  }
  const noteChanged = fields !== note.fields || tags !== note.tags;
  const nextNote: Note = noteChanged ? { ...note, fields, tags, updatedAt: ctx.now } : note;

  // Cloze sync: only when the text changed, and only for the numbers the edit changed.
  const result: EditNoteResult = { addedCardIds: [], removedCardIds: [], removedCards: [] };
  let cards = state.cards;
  if (type?.kind === 'cloze' && fields !== note.fields) {
    const own = state.cards.filter((c) => c.noteId === note.id);
    const before = new Set(clozeOrds(type, note.fields));
    const afterOrds = clozeOrds(type, fields); // sorted, never empty (ord 0 when there is no number)
    const after = new Set(afterOrds);
    const have = new Set(own.map((c) => c.ord));
    const removed = new Set(own.filter((c) => before.has(c.ord) && !after.has(c.ord)).map((c) => c.id));
    // New cards go to the note's deck. A note with no cards has no deck, so
    // no card can be made for it here.
    const deck = own.length > 0 ? state.decks.find((d) => d.id === own[0].deckId) : undefined;
    const missing = [...after].filter((ord) => !before.has(ord) && !have.has(ord));
    // At least one card stays. A note that has only SOME of its cards (one
    // subdeck imported, or an Anki "empty card") can lose all of them here,
    // and a cloze note has no Directions to get a card back: it would vanish
    // from the Library. So it gets a card for its smallest ord, even when
    // that number was in the old text too.
    if (own.length > 0 && removed.size === own.length && missing.length === 0) missing.push(afterOrds[0]);
    // A new cloze number follows the note's never-studied cards (feed position and Not started state).
    const added = deck ? newCardsFor(nextNote, missing, deck, siblingsArrival(own, note, deck), state, ctx) : [];
    // No deck to make that card in (broken data: the cards point at a deleted
    // deck): keep the old cards rather than leave the note with none.
    if (removed.size === own.length && added.length === 0) removed.clear();
    if (removed.size > 0 || added.length > 0) {
      const kept: Card[] = [];
      state.cards.forEach((card, index) => {
        if (removed.has(card.id)) result.removedCards.push({ index, card });
        else kept.push(card);
      });
      cards = [...kept, ...added];
      result.removedCardIds = result.removedCards.map((r) => r.card.id);
      result.addedCardIds = added.map((c) => c.id);
    }
  }

  if (!noteChanged && cards === state.cards) return { state, result };
  return {
    state: {
      ...state,
      notes: noteChanged ? state.notes.map((n) => (n === note ? nextNote : n)) : state.notes,
      cards,
    },
    result,
  };
}

/* ------------------------------------------------------------- moveNotes */

export interface MoveNotesInput {
  noteIds: readonly Id[];
  /** The deck that gets ALL cards of these notes. */
  deckId: Id;
  /** The new section path in that deck. Absent = each note keeps its section. */
  section?: string;
}

/**
 * Move whole notes to a deck ("Move to deck…"). EVERY card of each note goes
 * to `deckId`, so the cards of one note are never split over two decks. With
 * `section`, the notes also get that section path.
 *
 * Records a ManualEdit of kind 'move': each moved card's deckId
 * (before/after), and each note whose section changed. `undoManualEdit` takes
 * a move back per note, all or nothing: the note's deck and its section go
 * back together, or neither does. A missing target deck changes nothing.
 */
export function moveNotes<S extends NoteModelState>(
  state: S,
  input: MoveNotesInput,
  ctx: OpCtx,
): OpStep<S, EditResult> {
  const deck = state.decks.find((d) => d.id === input.deckId);
  const label = (n: number) => `${plural(n, 'card')} moved to ${deck?.name ?? 'another deck'}`;
  if (!deck) return { state, result: { edit: newEdit('move', label(0), ctx), undoable: false, skipped: 0 } };

  const ids = new Set(input.noteIds);
  const cardEntries: ManualEdit['cards'] = [];
  const noteEntries: NonNullable<ManualEdit['notes']> = [];
  const changedNotes = new Set<Id>();

  const notes = state.notes.map((note) => {
    if (!ids.has(note.id) || input.section === undefined || note.section === input.section) return note;
    noteEntries.push({
      id: note.id,
      before: { tags: [...note.tags], section: note.section },
      after: { tags: [...note.tags], section: input.section },
    });
    changedNotes.add(note.id);
    return { ...note, section: input.section, updatedAt: ctx.now };
  });
  const cards = state.cards.map((card) => {
    if (!ids.has(card.noteId) || card.deckId === deck.id) return card;
    cardEntries.push({ id: card.id, before: { deckId: card.deckId }, after: { deckId: deck.id } });
    changedNotes.add(card.noteId);
    return { ...card, deckId: deck.id };
  });

  // "{n} cards moved": every card of a note that moved or changed section.
  let moved = 0;
  for (const card of cards) if (changedNotes.has(card.noteId)) moved += 1;
  const edit: ManualEdit = {
    ...newEdit('move', label(moved), ctx),
    cards: cardEntries,
    ...(noteEntries.length > 0 ? { notes: noteEntries } : {}),
  };
  if (changedNotes.size === 0) return { state, result: { edit, undoable: false, skipped: 0 } };
  return commitEdit(
    {
      ...state,
      notes: noteEntries.length > 0 ? notes : state.notes,
      cards: cardEntries.length > 0 ? cards : state.cards,
    },
    edit,
    0,
  );
}

/* -------------------------------------------------------------- tagNotes */

export interface TagNotesInput {
  noteIds: readonly Id[];
  /** Tags to add (a tag the note already has, in any case, is not added twice). */
  add: readonly string[];
  /** Tags to remove (compared without case; only the exact tag, not its children). */
  remove: readonly string[];
}

/**
 * Add and remove tags on whole notes ("Add tag…", "Remove tag…"). A note
 * keeps the order of its tags; added tags go to the end. Records a
 * ManualEdit of kind 'tags' with each changed note's tags before and after.
 */
export function tagNotes<S extends NoteModelState>(
  state: S,
  input: TagNotesInput,
  ctx: OpCtx,
): OpStep<S, EditResult> {
  const ids = new Set(input.noteIds);
  const add = cleanTags(input.add);
  const remove = new Set(cleanTags(input.remove).map((t) => t.toLowerCase()));
  const entries: NonNullable<ManualEdit['notes']> = [];

  const notes = state.notes.map((note) => {
    if (!ids.has(note.id)) return note;
    const kept = note.tags.filter((t) => !remove.has(t.toLowerCase()));
    const present = new Set(kept.map((t) => t.toLowerCase()));
    const tags = [...kept, ...add.filter((t) => !present.has(t.toLowerCase()) && !remove.has(t.toLowerCase()))];
    if (sameList(tags, note.tags)) return note;
    entries.push({ id: note.id, before: { tags: [...note.tags] }, after: { tags: [...tags] } });
    return { ...note, tags, updatedAt: ctx.now };
  });

  const changed = new Set(entries.map((e) => e.id));
  let count = 0;
  for (const card of state.cards) if (changed.has(card.noteId)) count += 1;
  const verb = add.length > 0 && remove.size > 0 ? 'retagged' : remove.size > 0 ? 'untagged' : 'tagged';
  const edit: ManualEdit = { ...newEdit('tags', `${plural(count, 'card')} ${verb}`, ctx), notes: entries };
  if (entries.length === 0) return { state, result: { edit, undoable: false, skipped: 0 } };
  return commitEdit({ ...state, notes }, edit, 0);
}

/* ----------------------------------------------------- delete and restore */

/**
 * Everything deleteNotes removed, for the in-memory "Undo" (spec §3.6:
 * `deleteNotes` returns a token that is NOT persisted; the engine keeps this
 * object under that token). Each item keeps its index in the old array, so
 * restoreNotes can put it back in the same place.
 */
export interface DeletedNotes {
  /** The removed notes, by ascending index in the old `state.notes`. */
  notes: { index: number; note: Note }[];
  /** The removed cards (every card of those notes), by ascending index in the old `state.cards`. */
  cards: { index: number; card: Card }[];
  /** The snackbar text, e.g. "3 cards deleted". */
  label: string;
}

/**
 * Delete whole notes ("Delete card…" deletes the item = every direction).
 * Removes the notes and ALL their cards, and returns them (DeletedNotes).
 * Unknown ids are ignored. Card types are kept (other notes may use them).
 * The review history (revlog) keeps the rows of the deleted cards.
 */
export function deleteNotes<S extends NoteModelState>(
  state: S,
  input: { noteIds: readonly Id[] },
): OpStep<S, DeletedNotes> {
  const ids = new Set(input.noteIds);
  const removedNotes: DeletedNotes['notes'] = [];
  const removedCards: DeletedNotes['cards'] = [];
  const notes = state.notes.filter((note, index) => {
    if (!ids.has(note.id)) return true;
    removedNotes.push({ index, note });
    return false;
  });
  const cards = state.cards.filter((card, index) => {
    if (!ids.has(card.noteId)) return true;
    removedCards.push({ index, card });
    return false;
  });
  const label = `${plural(removedCards.length, 'card')} deleted`;
  if (removedNotes.length === 0 && removedCards.length === 0) {
    return { state, result: { notes: [], cards: [], label } };
  }
  return { state: { ...state, notes, cards }, result: { notes: removedNotes, cards: removedCards, label } };
}

/**
 * Put `items` back into `list` at their old indexes (ascending), in one pass.
 * When `list` is exactly the old list without `items`, the result equals the
 * old list.
 */
function insertAt<T>(list: readonly T[], items: readonly { index: number; item: T }[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < list.length || j < items.length) {
    if (j < items.length && (items[j].index <= out.length || i >= list.length)) {
      out.push(items[j].item);
      j += 1;
    } else {
      out.push(list[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Put deleted notes and their cards back (the "Undo" of deleteNotes).
 *
 * Safe to call at any time later:
 *   - a note or card whose id is in the state again is not added twice
 *     (so a second restore does nothing);
 *   - a note whose cards' deck no longer exists is NOT restored, with its
 *     cards (spec §3.12 "No-orphan": a card must never point at a missing deck).
 * Returns how many notes and cards came back (0 notes = nothing to undo).
 */
export function restoreNotes<S extends NoteModelState>(
  state: S,
  input: { deleted: DeletedNotes },
): OpStep<S, { restoredNotes: number; restoredCards: number }> {
  const deckIds = new Set(state.decks.map((d) => d.id));
  const noteIds = new Set(state.notes.map((n) => n.id));
  const cardIds = new Set(state.cards.map((c) => c.id));

  // A note comes back only when every one of its cards can come back too.
  const blocked = new Set<Id>();
  for (const { card } of input.deleted.cards) if (!deckIds.has(card.deckId)) blocked.add(card.noteId);

  const notes = input.deleted.notes
    .filter(({ note }) => !noteIds.has(note.id) && !blocked.has(note.id))
    .map(({ index, note }) => ({ index, item: note }));
  const back = new Set(notes.map((n) => n.item.id));
  const cards = input.deleted.cards
    .filter(({ card }) => back.has(card.noteId) && !cardIds.has(card.id))
    .map(({ index, card }) => ({ index, item: card }));

  if (notes.length === 0) return { state, result: { restoredNotes: 0, restoredCards: 0 } };
  return {
    state: { ...state, notes: insertAt(state.notes, notes), cards: insertAt(state.cards, cards) },
    result: { restoredNotes: notes.length, restoredCards: cards.length },
  };
}

/**
 * Put back the cards that editNote's cloze sync removed (`removedCards`),
 * with all their progress. This is the first half of the editor's in-memory
 * "Undo" of a cloze edit:
 *
 *   const edited = editNote(state, { noteId, patch: { fields: newFields } }, ctx);
 *   // … the learner taps Undo:
 *   const back = restoreCards(edited.state, { cards: edited.result.removedCards });
 *   const undone = editNote(back.state, { noteId, patch: { fields: oldFields } }, ctx);
 *
 * The old text has the old cloze numbers again, so the second editNote keeps
 * the restored cards (same ids, same schedule) and removes the cards that
 * the first edit had made for new numbers. One exception: the card the first
 * edit made only so the note keeps a card (see editNote) is for a number of
 * the old text too, so it stays (a New card, with no progress to lose).
 *
 * Safe to call at any time later. A card is NOT put back when:
 *   - its id is in the state again (so a second restore does nothing);
 *   - its note is gone (a card needs its note);
 *   - its note has a card for the same ord again (one card per direction);
 *   - its deck is gone and the note has no other card (spec §3.12 "No-orphan").
 * A card whose note has other cards goes into THEIR deck (the note may have
 * been moved since), so the cards of one note stay in one deck.
 * Returns how many cards came back.
 */
export function restoreCards<S extends NoteModelState>(
  state: S,
  input: { cards: readonly { index: number; card: Card }[] },
): OpStep<S, { restoredCards: number }> {
  const deckIds = new Set(state.decks.map((d) => d.id));
  const noteIds = new Set(state.notes.map((n) => n.id));
  const cardIds = new Set(state.cards.map((c) => c.id));
  // Each note's current deck (the deck of its lowest-ord card, the
  // checkIntegrity rule) and the ords it has. Both grow while cards come back.
  const homeOf = new Map<Id, { deckId: Id; ord: number }>();
  const ordsOf = new Map<Id, Set<number>>();
  for (const c of state.cards) {
    const home = homeOf.get(c.noteId);
    if (!home || c.ord < home.ord) homeOf.set(c.noteId, { deckId: c.deckId, ord: c.ord });
    const ords = ordsOf.get(c.noteId) ?? new Set<number>();
    ords.add(c.ord);
    ordsOf.set(c.noteId, ords);
  }

  const back: { index: number; item: Card }[] = [];
  for (const { index, card } of input.cards) {
    const ords = ordsOf.get(card.noteId) ?? new Set<number>();
    const home = homeOf.get(card.noteId)?.deckId ?? card.deckId;
    if (cardIds.has(card.id) || !noteIds.has(card.noteId) || ords.has(card.ord) || !deckIds.has(home)) continue;
    back.push({ index, item: home === card.deckId ? card : { ...card, deckId: home } });
    cardIds.add(card.id);
    ords.add(card.ord);
    ordsOf.set(card.noteId, ords);
    if (!homeOf.has(card.noteId)) homeOf.set(card.noteId, { deckId: home, ord: card.ord });
  }

  if (back.length === 0) return { state, result: { restoredCards: 0 } };
  // insertAt needs the old indexes in ascending order.
  back.sort((a, b) => a.index - b.index);
  return { state: { ...state, cards: insertAt(state.cards, back) }, result: { restoredCards: back.length } };
}

/* --------------------------------------------------------- duplicateDeck */

/** Deck keys a copy sets itself: identity, name, place, and the re-import key. */
const DUPLICATE_DECK_OWNED_KEYS = [
  'id',
  'name',
  'order',
  'createdAt',
  'active',
  'sourceKey',
  'builtin',
  'options',
] as const satisfies readonly (keyof Deck)[];

/**
 * Note keys a copy sets itself: identity (id, guid), times, the source (minus
 * the Anki note id), and the two arrays (fields, tags — passed again, so
 * makeNote copies them). Every other key (typeId, section, order, and any key
 * this code does not know) is copied as it is.
 */
const DUPLICATE_NOTE_OWNED_KEYS = [
  'id',
  'guid',
  'createdAt',
  'updatedAt',
  'source',
  'fields',
  'tags',
] as const satisfies readonly (keyof Note)[];

/**
 * Card keys a copy does NOT take: identity, home, and all PROGRESS (the
 * schedule, Known, Not started, bury, suspend and your markers). Every other
 * key (ord, newPos, and any key this code does not know) is copied — the
 * "field-whitelist trap" lesson of make.ts.
 */
const DUPLICATE_CARD_RESET_KEYS = [
  'id',
  'noteId',
  'deckId',
  'createdAt',
  'newState',
  'knownAt',
  'knownCheckedAt',
  'fav',
  'flagged',
  'flagColor',
  'suspended',
  'buriedUntil',
  'ease',
  'intervalDays',
  'stepIndex',
  'reps',
  'lapses',
  'due',
  'lastReviewedAt',
] as const satisfies readonly (keyof Card)[];

/**
 * Copy a deck ("Duplicate deck"): a new deck "{name} (copy)" at the end of
 * the deck list, with a copy of every note and card.
 *   - Deck: every setting is copied (icon, description, languages, options
 *     and directions …). Not copied: the re-import key `sourceKey` (the copy
 *     is not the same import source) and the deprecated `builtin`. The copy is
 *     active.
 *   - Notes: new ids and NEW guids ('m-<id>'), so a later import never
 *     confuses the copy with the original. Fields, tags, section and order
 *     are copied. The Anki note id is dropped.
 *   - Cards: same directions (ord) and feed positions; NO progress — each
 *     card is a brand-new card with `newState = deck.options.newArrival`.
 *   - Card types are shared (the copy's notes use the same type ids).
 * Images are copied by the caller (media folders are not part of the state).
 * Returns the new deck, or null when the deck does not exist.
 */
export function duplicateDeck<S extends NoteModelState>(
  state: S,
  input: { deckId: Id },
  ctx: OpCtx,
): OpStep<S, Deck | null> {
  const source = state.decks.find((d) => d.id === input.deckId);
  if (!source) return { state, result: null };

  const directions = source.options.directions;
  const deck = makeDeck(
    {
      ...omitKeys(source, DUPLICATE_DECK_OWNED_KEYS),
      id: ctx.newId(DECK_ID_PREFIX),
      name: `${source.name} (copy)`,
      order: nextDeckOrder(state.decks),
      active: true,
      options: {
        ...source.options,
        ...(directions
          ? { directions: Object.fromEntries(Object.entries(directions).map(([k, ords]) => [k, [...ords]])) }
          : {}),
      },
      ...(source.legacy ? { legacy: { ...source.legacy } } : {}),
    },
    ctx.now,
  );

  // The notes of the deck = the notes of its cards, in the notes' own order.
  const deckCards = state.cards.filter((c) => c.deckId === source.id);
  const noteIdsInDeck = new Set(deckCards.map((c) => c.noteId));
  const copyOf = new Map<Id, Note>();
  for (const note of state.notes) {
    if (!noteIdsInDeck.has(note.id)) continue;
    copyOf.set(
      note.id,
      makeNote(
        {
          ...omitKeys(note, DUPLICATE_NOTE_OWNED_KEYS),
          id: ctx.newId(NOTE_ID_PREFIX),
          fields: note.fields,
          tags: note.tags,
          // The Anki note id names ONE Anki note: the copy is not that note.
          source: omitKeys(note.source, ['ankiNoteId']),
        },
        ctx.now,
      ),
    );
  }
  const cards: Card[] = [];
  for (const card of deckCards) {
    const note = copyOf.get(card.noteId);
    // A card whose note is missing (broken data) is not copied: a copy must be valid.
    if (!note) continue;
    cards.push(
      makeCard(note, card.ord, deck.id, state.settings.srs, ctx.now, {
        ...omitKeys(card, DUPLICATE_CARD_RESET_KEYS),
        id: ctx.newId(CARD_ID_PREFIX),
        newState: deck.options.newArrival,
      }),
    );
  }
  return {
    state: {
      ...state,
      decks: [...state.decks, deck],
      notes: [...state.notes, ...copyOf.values()],
      cards: [...state.cards, ...cards],
    },
    result: deck,
  };
}

/* --------------------------------------------------------- setDirections */

export interface SetDirectionsInput {
  deckId: Id;
  typeId: Id;
  /** The ords to turn ON for this card type in this deck. Ords without a template are ignored. */
  ords: readonly number[];
}

/**
 * Turn directions on or off for one card type in one deck (DirectionsSheet).
 * Saves `deck.options.directions[typeId]`, then:
 *   - ON: every note of this type in this deck gets the missing cards, as
 *     new cards (fresh ids, newState = the deck's newArrival — or Not
 *     started when every never-studied card of the note is Not started, see
 *     siblingArrival — and the feed position of the note's never-studied
 *     cards — or note.order when it has none, see siblingNewPos). Existing cards are kept exactly as they
 *     are. A note whose cards are split over two decks (broken data) belongs
 *     to the deck of its lowest-ord card, and never gets a second card for
 *     an ord it has.
 *   - OFF: cards are KEPT with their progress. The scheduler skips them
 *     (eligibility), and they come back with their history when turned on.
 * Cloze types have no directions (their cards follow the cloze numbers):
 * nothing changes. An unknown deck or card type changes nothing.
 */
export function setDirections<S extends NoteModelState>(
  state: S,
  input: SetDirectionsInput,
  ctx: OpCtx,
): OpStep<S, { created: number; cardIds: Id[] }> {
  const deck = state.decks.find((d) => d.id === input.deckId);
  const type = findNoteType(state, input.typeId, ctx.now);
  if (!deck || !type || type.kind === 'cloze') return { state, result: { created: 0, cardIds: [] } };

  const enabled = templateOrds(type).filter((ord) => input.ords.includes(ord));
  const current = deck.options.directions?.[type.id];
  const sameOrds = current !== undefined && current.length === enabled.length && current.every((o, i) => o === enabled[i]);
  const nextDeck: Deck = sameOrds
    ? deck
    : { ...deck, options: { ...deck.options, directions: { ...deck.options.directions, [type.id]: enabled } } };

  // The notes of this type: the ords they have (in ANY deck) and their home
  // deck. Home = the deck of the lowest-ord card, the same rule checkIntegrity
  // uses to repair a note whose cards are split over two decks (broken data,
  // spec §3.5). So a split note never gets a second card for an ord it has
  // in another deck, and it gets missing cards only in its home deck.
  const typeNotes = new Map(state.notes.filter((n) => n.typeId === type.id).map((n) => [n.id, n]));
  const have = new Map<Id, { ords: Set<number>; home: Id; homeOrd: number; cards: Card[] }>();
  for (const c of state.cards) {
    if (!typeNotes.has(c.noteId)) continue;
    const found = have.get(c.noteId);
    if (!found) {
      have.set(c.noteId, { ords: new Set([c.ord]), home: c.deckId, homeOrd: c.ord, cards: [c] });
      continue;
    }
    found.ords.add(c.ord);
    found.cards.push(c);
    if (c.ord < found.homeOrd) {
      found.home = c.deckId;
      found.homeOrd = c.ord;
    }
  }
  const created: Card[] = [];
  for (const [noteId, { ords, home, cards }] of have) {
    if (home !== deck.id) continue;
    const note = typeNotes.get(noteId) as Note;
    const missing = enabled.filter((ord) => !ords.has(ord));
    if (missing.length === 0) continue;
    // The new cards follow their never-studied siblings: the feed position
    // (learn({ first }) may have moved them) and the Not started state.
    created.push(...newCardsFor(note, missing, nextDeck, siblingsArrival(cards, note, nextDeck), state, ctx));
  }

  if (nextDeck === deck && created.length === 0) return { state, result: { created: 0, cardIds: [] } };
  return {
    state: {
      ...state,
      decks: nextDeck === deck ? state.decks : state.decks.map((d) => (d === deck ? nextDeck : d)),
      cards: created.length > 0 ? [...state.cards, ...created] : state.cards,
    },
    result: { created: created.length, cardIds: created.map((c) => c.id) },
  };
}
