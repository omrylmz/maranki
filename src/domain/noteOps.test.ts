/**
 * The note commands (spec §3.6 "notes", "decks and card types", unit W2-7).
 * The load-bearing properties:
 *   - addNote: one card per enabled direction (cloze: per cloze number), with
 *     newPos = note.order and newState = deck.options.newArrival;
 *   - editNote: cloze sync keeps the progress of the surviving numbers,
 *     never leaves a note with zero cards (also a note with only some of its
 *     cards), and returns the cards it removed so restoreCards can undo a mistake;
 *   - moveNotes keeps ALL cards of a note in one deck — also through undo,
 *     where a note's deck and section go back together or not at all;
 *   - tagNotes; deleteNotes returns what it removed and restoreNotes puts it
 *     back exactly (never as orphans);
 *   - duplicateDeck: new ids and guids, no progress;
 *   - setDirections creates the missing cards and keeps the existing ones;
 *     a new card of a Not started item stays Not started (setDirections and
 *     a new cloze number), whatever the deck's newArrival;
 *   - no command changes its input (the input is deep-frozen), and random
 *     sequences of commands keep every v3 invariant (seeded property test).
 */
import { describe, expect, it } from '@jest/globals';

import { BUILTIN_TYPE_IDS } from './builtinTypes';
import { clozeAnswers, clozeNumbers } from './cloze';
import { life } from './life';
import { partialUndoMessage, undoManualEdit } from './manualLog';
import type { Card, CardFace, DataStateV3, Deck, Note } from './model';
import {
  addNote,
  cleanTags,
  clozeOrds,
  deleteNotes,
  duplicateDeck,
  editNote,
  type EditNoteResult,
  enabledOrds,
  findNoteType,
  moveNotes,
  restoreCards,
  restoreNotes,
  setDirections,
  tagNotes,
} from './noteOps';
import { renderFace } from './render';
import { learn, markKnown, reschedule, resetProgress, setFlags, setNotStarted } from './triage';
import { DAY } from './types';
import { FIXED_NOW } from '../test/clock';
import {
  lifeValues,
  deepReadOnly,
  makeDeckV3,
  makeStateV3,
  notesWithoutCards,
  noteWithCards,
  randomStateV3,
  stateOfV3,
  stateProblemsV3,
  testCtx,
  threeWayType,
} from '../test/factoriesV3';
import { createRandom, type Random } from '../test/random';

const BASIC = BUILTIN_TYPE_IDS.basic;
const REVERSE = BUILTIN_TYPE_IDS.basicReverse;
const CLOZE = BUILTIN_TYPE_IDS.cloze;

const cardsOf = (state: Pick<DataStateV3, 'cards'>, noteId: string): Card[] =>
  state.cards.filter((c) => c.noteId === noteId);
const noteOf = (state: Pick<DataStateV3, 'notes'>, id: string): Note => {
  const found = state.notes.find((n) => n.id === id);
  if (!found) throw new Error(`no note ${id}`);
  return found;
};
const deckOf = (state: Pick<DataStateV3, 'decks'>, id: string): Deck => {
  const found = state.decks.find((d) => d.id === id);
  if (!found) throw new Error(`no deck ${id}`);
  return found;
};

/** An empty library with decks d1 (and d2), no card types stored yet. */
function emptyLibrary(d1: Partial<Deck> = {}): DataStateV3 {
  return deepReadOnly(
    makeStateV3({ decks: [makeDeckV3({ id: 'd1', name: 'One', ...d1 }), makeDeckV3({ id: 'd2', name: 'Two', order: 1 })] }),
  );
}

/* ----------------------------------------------------------- helpers */

describe('helpers', () => {
  it('the read-only view really catches in-place changes (so the purity checks below mean something)', () => {
    const view = deepReadOnly({ cards: [{ id: 'x', flagged: false }], tags: ['a'] });
    expect(() => {
      (view.cards[0] as { flagged: boolean }).flagged = true;
    }).toThrow(TypeError);
    expect(() => view.tags.push('b')).toThrow(TypeError);
    expect(() => {
      delete (view as { tags?: string[] }).tags;
    }).toThrow(TypeError);
    // Reads, copies and identity still work.
    expect(view.cards[0]).toBe(view.cards[0]);
    expect({ ...view.cards[0], flagged: true }).toEqual({ id: 'x', flagged: true });
    expect(view.tags.map((t) => t.toUpperCase())).toEqual(['A']);
  });

  it('cleanTags trims, drops empty tags and repeats (without case)', () => {
    expect(cleanTags([' verb', 'Verb', '', '  ', 'A1', 'a1', 'German::Verbs'])).toEqual(['verb', 'A1', 'German::Verbs']);
  });

  it('clozeOrds: one ord per cloze number; {{c1,2::…}}; no number → ord 0', () => {
    const type = findNoteType(makeStateV3(), CLOZE, FIXED_NOW)!;
    expect(clozeOrds(type, ['{{c1::Berlin}} is in {{c3::Germany}} ({{c1::capital}})', ''])).toEqual([0, 2]);
    expect(clozeOrds(type, ['{{c1,2::Paris}}', ''])).toEqual([0, 1]);
    expect(clozeOrds(type, ['no deletion here', '{{c5::Extra is not read}}'])).toEqual([0]);
    expect(clozeOrds(type, ['{{c0::zero is not a number}} {{c2::two}}', ''])).toEqual([1]);
  });

  it('clozeOrds reads the markup like renderFace (cloze.ts, the one parser)', () => {
    const type = findNoteType(makeStateV3(), CLOZE, FIXED_NOW)!;
    expect(clozeOrds(type, ['{{c0::x}} {{c1::y}}', ''])).toEqual([0]);
    expect(clozeOrds(type, ['{{c0::only zero}}', ''])).toEqual([0]); // no card number: the one card ord 0
    expect(clozeOrds(type, ['{{c1::a {{c2::nested}}}}', ''])).toEqual([0, 1]);
    expect(clozeOrds(type, ['{{c3::never closed', ''])).toEqual([0]); // not a deletion
    expect(clozeOrds(type, ['{{c1, 2::spaces}}', ''])).toEqual([0]); // Anki joins numbers with "," only
    // A hidden Text field is not shown, so it makes no card either (renderFace could not hide it).
    const hidden = { ...type, fields: type.fields.map((f, i) => (i === 0 ? { ...f, role: 'hidden' as const } : f)) };
    expect(clozeOrds(hidden, ['{{c1::a}} {{c2::b}}', ''])).toEqual([0]);
  });
});

/* ------------------------------------------- cloze round trip (one parser) */

describe('cloze round trip: every card addNote / editNote makes has its deletion hidden', () => {
  /** The bold "[…]" / "[hint]" inline that marks a hidden deletion on a prompt. */
  const hidesSomething = (face: CardFace): boolean =>
    face.prompt.some((b) => b.lines.some((line) => line.some((p) => p.t === 'text' && p.b === true && /^\[.*\]$/.test(p.text))));

  /**
   * Check every card of a note: a non-empty prompt with a hidden part, made
   * from a real deletion of that card. (An EMPTY deletion, "{{c1::::hint}}",
   * hides nothing visible, so its answer may be empty; the prompt still asks.)
   */
  function expectRoundTrip(state: DataStateV3, noteId: string): void {
    const note = noteOf(state, noteId);
    const type = findNoteType(state, note.typeId, FIXED_NOW)!;
    for (const c of cardsOf(state, noteId)) {
      const face = renderFace(note, type, c.ord);
      if (face.promptPlain === '' || !hidesSomething(face)) {
        throw new Error(`ord ${c.ord} of ${JSON.stringify(note.fields[0])}: prompt "${face.promptPlain}" hides nothing`);
      }
      expect(clozeAnswers(note.fields[0], c.ord + 1).length).toBeGreaterThan(0);
    }
  }

  it('on the cases the two old parsers disagreed about ({{c0::…}}, {{c1,2::…}}, nesting, hints)', () => {
    const text = '{{c1,2::Paris}} is in {{c3::France::country}}, not {{c0::Berlin}}; {{c4::a {{c5::b}} c}}';
    const step = addNote(emptyLibrary(), { deckId: 'd1', typeId: CLOZE, fields: [text, ''], tags: [] }, testCtx());
    const id = step.result!.noteId;
    expect(cardsOf(step.state, id).map((c) => c.ord)).toEqual([0, 1, 2, 3, 4]);
    expectRoundTrip(step.state, id);
    const note = noteOf(step.state, id);
    const type = findNoteType(step.state, CLOZE, FIXED_NOW)!;
    const prompt = (ord: number) => renderFace(note, type, ord).promptPlain;
    expect(prompt(0)).toBe('[…] is in France, not Berlin; a b c');
    expect(prompt(1)).toBe('[…] is in France, not Berlin; a b c');
    expect(prompt(2)).toBe('Paris is in [country], not Berlin; a b c');
    expect(prompt(3)).toBe('Paris is in France, not Berlin; […]');
    expect(prompt(4)).toBe('Paris is in France, not Berlin; a […] c');
    expect([0, 1, 2, 3, 4].map((ord) => renderFace(note, type, ord).answerPlain)).toEqual(['Paris', 'Paris', 'France', 'a b c', 'b']);

    // editNote: the new numbers (6, and 2 of "{{c2,6::…}}" is already there) get cards that hide their part too.
    const edited = editNote(step.state, { noteId: id, patch: { fields: [`${text} {{c2,6::Rome}}`, ''] } }, testCtx());
    expect(edited.result!.addedCardIds).toHaveLength(1);
    expect(cardsOf(edited.state, id).map((c) => c.ord)).toEqual([0, 1, 2, 3, 4, 5]);
    expectRoundTrip(edited.state, id);
  });

  it('seeded random texts: addNote (sometimes with only SOME cards kept), then editNote with another random text (200 notes)', () => {
    const randomText = (rnd: Random): string => {
      const part = (depth: number): string => {
        if (depth >= 2 || rnd.bool(0.4)) return rnd.pick(['word', 'x y', '::', '}}', '{{c', '{{cx::z}}']);
        const nums = rnd.sample([0, 1, 2, 3], rnd.int(1, 2)).join(',');
        const inner = Array.from({ length: rnd.int(1, 2) }, () => part(depth + 1)).join(' ');
        const hint = rnd.bool(0.3) ? '::hint' : '';
        return rnd.bool(0.1) ? `{{c${nums}::${inner}` : `{{c${nums}::${inner}${hint}}}`;
      };
      return Array.from({ length: rnd.int(1, 4) }, () => part(0)).join(' ');
    };
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = createRandom(`cloze-round-trip-${seed}`);
      const first = randomText(rnd);
      const added = addNote(emptyLibrary(), { deckId: 'd1', typeId: CLOZE, fields: [first, ''], tags: [] }, testCtx());
      const id = added.result!.noteId;
      const madeFromNumbers = clozeNumbers(first).length > 0;
      if (madeFromNumbers) expectRoundTrip(added.state, id);
      // A PARTIAL note half of the time: only some of its cards are kept (one
      // subdeck of an Anki deck imported, or an Anki "empty card" left out).
      let start = added.state;
      const madeCards = cardsOf(start, id);
      const cut = rnd.fork('partial');
      if (madeCards.length > 1 && cut.bool()) {
        const keep = new Set(cut.sample(madeCards, cut.int(1, madeCards.length - 1)).map((c) => c.id));
        start = deepReadOnly({ ...start, cards: start.cards.filter((c) => c.noteId !== id || keep.has(c.id)) });
      }
      const second = randomText(rnd);
      const edited = editNote(start, { noteId: id, patch: { fields: [second, ''] } }, testCtx());
      const note = noteOf(edited.state, id);
      const type = findNoteType(edited.state, CLOZE, FIXED_NOW)!;
      // The note still has at least one card (or it would vanish from the Library for good).
      if (notesWithoutCards(edited.state).length > 0) {
        throw new Error(`seed ${seed}: no card left after ${JSON.stringify(first)} → ${JSON.stringify(second)}`);
      }
      if (clozeNumbers(second).length > 0) {
        // Every card editNote ADDED is made from a number of the new text, so it hides its part.
        for (const cardId of edited.result!.addedCardIds) {
          const made = edited.state.cards.find((c) => c.id === cardId)!;
          if (!hidesSomething(renderFace(note, type, made.ord))) throw new Error(`seed ${seed}: added ord ${made.ord} hides nothing`);
        }
      }
      expect(stateProblemsV3(edited.state)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------ addNote */

describe('addNote', () => {
  it('creates one card per direction, with newPos = note.order and newState = the deck arrival', () => {
    const state = emptyLibrary();
    const ctx = testCtx();
    const step = addNote(state, { deckId: 'd1', typeId: REVERSE, fields: ['Haus', 'house', '', ''], tags: [] }, ctx);
    const result = step.result!;
    const note = noteOf(step.state, result.noteId);
    const cards = cardsOf(step.state, note.id);
    expect(cards.map((c) => c.ord)).toEqual([0, 1]);
    expect(result.cardIds).toEqual(cards.map((c) => c.id));
    for (const c of cards) {
      expect(c.newPos).toBe(note.order);
      expect(c.newState).toBe('queued');
      expect(c.deckId).toBe('d1');
      expect(life(c)).toBe('new');
      expect(c.reps).toBe(0);
      expect(c.due).toBe(ctx.now);
    }
    expect(note).toMatchObject({
      typeId: REVERSE,
      fields: ['Haus', 'house', '', ''],
      section: '',
      guid: `m-${note.id}`,
      order: ctx.now,
      source: { kind: 'manual' },
    });
    expect(stateProblemsV3(step.state)).toEqual([]);
  });

  it('a deck whose new cards arrive as Not started makes Not started cards', () => {
    const state = emptyLibrary({ options: { newArrival: 'notStarted' } as Deck['options'] });
    const step = addNote(state, { deckId: 'd1', typeId: BASIC, fields: ['a', 'b', '', ''], tags: [] }, testCtx());
    const [c] = cardsOf(step.state, step.result!.noteId);
    expect(c.newState).toBe('notStarted');
    expect(life(c)).toBe('notStarted');
  });

  it('writes a built-in card type into state on its first use, only once', () => {
    const state = emptyLibrary();
    const ctx = testCtx();
    const one = addNote(state, { deckId: 'd1', typeId: REVERSE, fields: ['a', 'b'], tags: [] }, ctx);
    expect(one.state.noteTypes.map((t) => t.id)).toEqual([REVERSE]);
    const two = addNote(one.state, { deckId: 'd2', typeId: REVERSE, fields: ['c', 'd'], tags: [] }, ctx);
    expect(two.state.noteTypes).toBe(one.state.noteTypes);
  });

  it('follows the deck directions: a listed set, else the ords the deck already has, else every template', () => {
    const ctx = testCtx();
    // Listed: only "Back → Front".
    const listed = emptyLibrary({ options: { directions: { [REVERSE]: [1] } } as unknown as Deck['options'] });
    const a = addNote(listed, { deckId: 'd1', typeId: REVERSE, fields: ['a', 'b'], tags: [] }, ctx);
    expect(cardsOf(a.state, a.result!.noteId).map((c) => c.ord)).toEqual([1]);

    // Not listed, but the deck's cards of this type have only ord 0 (an import with one direction).
    const deck = makeDeckV3({ id: 'd1' });
    const old = noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0] });
    const imported = deepReadOnly(stateOfV3({ decks: [deck], groups: [old] }));
    expect(enabledOrds(imported, deck, findNoteType(imported, REVERSE, FIXED_NOW)!)).toEqual([0]);
    const b = addNote(imported, { deckId: 'd1', typeId: REVERSE, fields: ['a', 'b'], tags: [] }, ctx);
    expect(cardsOf(b.state, b.result!.noteId).map((c) => c.ord)).toEqual([0]);

    // Every direction turned off: the note still gets its first card (never invisible).
    const none = emptyLibrary({ options: { directions: { [REVERSE]: [] } } as unknown as Deck['options'] });
    const c = addNote(none, { deckId: 'd1', typeId: REVERSE, fields: ['a', 'b'], tags: [] }, ctx);
    expect(cardsOf(c.state, c.result!.noteId).map((x) => x.ord)).toEqual([0]);
  });

  it('cloze: one card per cloze number', () => {
    const step = addNote(
      emptyLibrary(),
      { deckId: 'd1', typeId: CLOZE, fields: ['{{c1::Berlin}} is the capital of {{c3::Germany}}', ''], tags: [] },
      testCtx(),
    );
    expect(cardsOf(step.state, step.result!.noteId).map((c) => c.ord)).toEqual([0, 2]);
    expect(stateProblemsV3(step.state)).toEqual([]);
  });

  it('pads short field lists, drops empty extra values, refuses extra text', () => {
    const state = emptyLibrary();
    const ctx = testCtx();
    const short = addNote(state, { deckId: 'd1', typeId: BASIC, fields: ['a', 'b'], tags: [] }, ctx);
    expect(noteOf(short.state, short.result!.noteId).fields).toEqual(['a', 'b', '', '']);
    const emptyExtra = addNote(state, { deckId: 'd1', typeId: BASIC, fields: ['a', 'b', '', '', ''], tags: [] }, ctx);
    expect(noteOf(emptyExtra.state, emptyExtra.result!.noteId).fields).toEqual(['a', 'b', '', '']);
    const extraText = addNote(state, { deckId: 'd1', typeId: BASIC, fields: ['a', 'b', '', '', 'lost?'], tags: [] }, ctx);
    expect(extraText.result).toBeNull();
    expect(extraText.state).toBe(state);
  });

  it('cleans the tags and keeps the section', () => {
    const step = addNote(
      emptyLibrary(),
      { deckId: 'd1', typeId: BASIC, fields: ['a', 'b'], tags: [' verb', 'Verb', 'A1'], section: 'Verbs::B1' },
      testCtx(),
    );
    expect(noteOf(step.state, step.result!.noteId)).toMatchObject({ tags: ['verb', 'A1'], section: 'Verbs::B1' });
  });

  it('a missing deck or an unknown card type changes nothing', () => {
    const state = emptyLibrary();
    const ctx = testCtx();
    expect(addNote(state, { deckId: 'nope', typeId: BASIC, fields: ['a'], tags: [] }, ctx)).toEqual({ state, result: null });
    expect(addNote(state, { deckId: 'd1', typeId: 'nt-nope', fields: ['a'], tags: [] }, ctx)).toEqual({ state, result: null });
  });

  it('keeps every existing object (identity) and adds the new ones at the end', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({ deckId: 'd1' });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const step = addNote(state, { deckId: 'd1', typeId: BASIC, fields: ['a', 'b'], tags: [] }, testCtx());
    expect(step.state.notes[0]).toBe(state.notes[0]);
    expect(step.state.cards[0]).toBe(state.cards[0]);
    expect(step.state.decks).toBe(state.decks);
    expect(step.state.notes).toHaveLength(2);
  });
});

/* ----------------------------------------------------------- editNote */

describe('editNote', () => {
  it('changes fields and tags; the cards of a standard note stay as they are', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1', tags: ['a'] } });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const ctx = testCtx(FIXED_NOW + 10);
    const step = editNote(state, { noteId: 'n1', patch: { fields: ['Haus', 'house'], tags: ['b', ' b '] } }, ctx);
    expect(noteOf(step.state, 'n1')).toMatchObject({ fields: ['Haus', 'house', '', ''], tags: ['b'], updatedAt: ctx.now });
    expect(step.state.cards).toBe(state.cards);
    expect(step.result).toEqual({ addedCardIds: [], removedCardIds: [], removedCards: [] });
  });

  it('cloze sync keeps the progress of surviving numbers, removes gone ones, adds new ones with fresh ids', () => {
    const deck = makeDeckV3({ id: 'd1', options: { newArrival: 'notStarted' } });
    const g = noteWithCards({
      deckId: 'd1',
      typeId: CLOZE,
      fields: ['{{c1::Berlin}} and {{c2::Paris}}', ''],
      note: { id: 'n1', order: 500 },
      card: (ord) => ({ ...lifeValues('review'), id: `c${ord + 1}` }),
    });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const step = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::Berlin}} and {{c3::Rome}}', ''] } }, testCtx());
    const cards = cardsOf(step.state, 'n1');
    expect(cards.map((c) => c.ord)).toEqual([0, 2]);
    // c1 survives untouched: same object, same schedule.
    expect(cards[0]).toBe(cardsOf(state, 'n1')[0]);
    expect(life(cards[0])).toBe('review');
    // c2 is gone; c3 is a NEW card: a fresh id (never 'c2'), New in this deck's arrival state.
    expect(step.result!.removedCardIds).toEqual(['c2']);
    // The removed card comes back WHOLE (with its progress) and its old place, for an in-memory Undo.
    expect(step.result!.removedCards).toEqual([{ index: 1, card: cardsOf(state, 'n1')[1] }]);
    expect(step.result!.removedCards[0].card).toBe(cardsOf(state, 'n1')[1]);
    const added = cards[1];
    expect(step.result!.addedCardIds).toEqual([added.id]);
    expect(added.id).not.toBe('c2');
    expect(added).toMatchObject({ deckId: 'd1', reps: 0, newPos: 500, newState: 'notStarted' });
    expect(stateProblemsV3(step.state)).toEqual([]);
  });

  it('cloze: removing every deletion keeps one card (ord 0)', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({ deckId: 'd1', typeId: CLOZE, fields: ['{{c1::a}} {{c2::b}}', ''], note: { id: 'n1' } });
    const step = editNote(deepReadOnly(stateOfV3({ decks: [deck], groups: [g] })), { noteId: 'n1', patch: { fields: ['plain text', ''] } }, testCtx());
    expect(cardsOf(step.state, 'n1')).toEqual([g.cards[0]]);
  });

  it('cloze: a save that does not change the text never touches the cards (an Anki "empty card" keeps its progress)', () => {
    // Anki keeps the card of a removed number until "Empty Cards": the text has only c1, the note has cards 1 AND 2.
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({
      deckId: 'd1',
      typeId: CLOZE,
      fields: ['{{c1::a}} b', ''],
      ords: [0, 1],
      note: { id: 'n1' },
      card: (ord) => ({ ...lifeValues('mastered'), id: `card-${ord + 1}` }),
    });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const ctx = testCtx(FIXED_NOW + 10);
    for (const patch of [{ tags: ['x'] }, { fields: [...g.note.fields], tags: ['x'] }, { fields: [...g.note.fields] }]) {
      const step = editNote(state, { noteId: 'n1', patch }, ctx);
      expect(step.result).toEqual({ addedCardIds: [], removedCardIds: [], removedCards: [] });
      expect(step.state.cards).toBe(state.cards);
    }
    // A typo fix in the text keeps it too: the edit did not remove number 2 (it was not in the text).
    const typo = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} bb', ''] } }, ctx);
    expect(typo.result!.removedCardIds).toEqual([]);
    expect(cardsOf(typo.state, 'n1')).toEqual(g.cards);
  });

  it('cloze: only the numbers the edit ADDS get cards (a note imported with some of its cards stays so)', () => {
    // An import of one subdeck brought only card 1 of a "{{c1::…}} {{c2::…}}" note.
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({ deckId: 'd1', typeId: CLOZE, fields: ['{{c1::a}} {{c2::b}}', ''], ords: [0], note: { id: 'n1' } });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const typo = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} {{c2::bb}}', ''] } }, testCtx());
    expect(typo.result!.addedCardIds).toEqual([]);
    expect(cardsOf(typo.state, 'n1').map((c) => c.ord)).toEqual([0]);
    // A new number 3 gets its card; number 2 still does not.
    const added = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} {{c2::b}} {{c3::c}}', ''] } }, testCtx());
    expect(cardsOf(added.state, 'n1').map((c) => c.ord)).toEqual([0, 2]);
  });

  it('cloze: a note with only SOME of its cards never ends with zero cards (it would vanish from the Library)', () => {
    // An import of one subdeck brought only card 2 of a "{{c1::a}} {{c2::b}}" note.
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({
      deckId: 'd1',
      typeId: CLOZE,
      fields: ['{{c1::a}} {{c2::b}}', ''],
      ords: [1],
      note: { id: 'n1', order: 70 },
      card: { ...lifeValues('mastered'), id: 'card-1' },
    });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const ctx = testCtx();
    // Number 2 removed (number 1 stays), or every number removed ("a b": the one card ord 0).
    for (const text of ['{{c1::a}} b', 'a b']) {
      const step = editNote(state, { noteId: 'n1', patch: { fields: [text, ''] } }, ctx);
      const cards = cardsOf(step.state, 'n1');
      // Exactly one card: a NEW card for ord 0, although number 1 was in the old text too.
      expect(notesWithoutCards(step.state)).toEqual([]);
      expect(cards.map((c) => c.ord)).toEqual([0]);
      expect(step.result!.addedCardIds).toEqual([cards[0].id]);
      expect(cards[0]).toMatchObject({ deckId: 'd1', reps: 0, newState: 'queued', newPos: 70 });
      expect(cards[0].id).not.toBe('card-1');
      // The removed card comes back WHOLE in removedCards (for the editor's Undo).
      expect(step.result!.removedCardIds).toEqual(['card-1']);
      expect(step.result!.removedCards).toEqual([{ index: 0, card: g.cards[0] }]);
      expect(stateProblemsV3(step.state)).toEqual([]);
    }

    // The Undo still brings the removed card back with its progress. The new card
    // for number 1 stays: number 1 is in the old text, so the old text keeps it.
    const edited = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} b', ''] } }, ctx);
    const back = restoreCards(edited.state, { cards: edited.result!.removedCards });
    const undone = editNote(back.state, { noteId: 'n1', patch: { fields: [...g.note.fields] } }, ctx);
    expect(cardsOf(undone.state, 'n1').map((c) => c.ord).sort()).toEqual([0, 1]);
    // The same card object again: same id, same schedule.
    expect(cardsOf(undone.state, 'n1').find((c) => c.ord === 1)).toBe(cardsOf(state, 'n1')[0]);
    expect(stateProblemsV3(undone.state)).toEqual([]);

    // The card made is for the SMALLEST ord of the new text. Here the note has only
    // card 1, and the edit removes number 1: the note gets card 2 (ord 1).
    const onlyFirst = noteWithCards({ deckId: 'd1', typeId: CLOZE, fields: ['{{c1::a}} {{c2::b}}', ''], ords: [0], note: { id: 'n2' } });
    const s2 = deepReadOnly(stateOfV3({ decks: [deck], groups: [onlyFirst] }));
    const step2 = editNote(s2, { noteId: 'n2', patch: { fields: ['a {{c2::b}}', ''] } }, ctx);
    expect(cardsOf(step2.state, 'n2').map((c) => c.ord)).toEqual([1]);
    expect(step2.result!.removedCardIds).toEqual([onlyFirst.cards[0].id]);
  });

  it('cloze: when no card can be made (the cards point at a deleted deck), the old cards are kept', () => {
    // Broken data: the deck of the note's only card is gone, so a new card has no deck to go to.
    const g = noteWithCards({ deckId: 'gone', typeId: CLOZE, fields: ['{{c1::a}} {{c2::b}}', ''], ords: [1], note: { id: 'n1' } });
    const state = deepReadOnly(stateOfV3({ decks: [makeDeckV3({ id: 'd1' })], groups: [g] }));
    const step = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} b', ''] } }, testCtx());
    expect(step.result).toEqual({ addedCardIds: [], removedCardIds: [], removedCards: [] });
    expect(step.state.cards).toBe(state.cards);
    // The text itself is saved.
    expect(noteOf(step.state, 'n1').fields).toEqual(['{{c1::a}} b', '']);
  });

  it('cloze: a new number follows its never-studied siblings to the front of the feed (after learn first)', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const early = noteWithCards({ deckId: 'd1', note: { id: 'n0', order: 10 } });
    const g = noteWithCards({ deckId: 'd1', typeId: CLOZE, fields: ['{{c1::a}}', ''], note: { id: 'n1', order: 40 } });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [early, g] }));
    const ctx = testCtx();
    const first = learn(state, { cardIds: [g.cards[0].id], first: true }, ctx);
    expect(cardsOf(first.state, 'n1')[0].newPos).toBe(9);
    const edited = editNote(first.state, { noteId: 'n1', patch: { fields: ['{{c1::a}} {{c2::b}}', ''] } }, ctx);
    expect(cardsOf(edited.state, 'n1').map((c) => [c.ord, c.newPos])).toEqual([
      [0, 9],
      [1, 9],
    ]);
    // A note whose cards are all studied: the new card starts at note.order (a studied card's place means nothing).
    const studied = noteWithCards({
      deckId: 'd1', typeId: CLOZE, fields: ['{{c1::a}}', ''], note: { id: 'n2', order: 50 }, card: { ...lifeValues('review'), newPos: 3 },
    });
    const withStudied = deepReadOnly(stateOfV3({ decks: [deck], groups: [studied] }));
    const more = editNote(withStudied, { noteId: 'n2', patch: { fields: ['{{c1::a}} {{c2::b}}', ''] } }, ctx);
    expect(cardsOf(more.state, 'n2')[1].newPos).toBe(50);
  });

  it('cloze: a new number of a Not started note stays Not started, even in a deck where new cards arrive queued', () => {
    const deck = makeDeckV3({ id: 'd1', options: { newArrival: 'queued' } });
    const g = noteWithCards({ deckId: 'd1', typeId: CLOZE, fields: ['{{c1::a}}', ''], note: { id: 'n1' }, card: { newState: 'notStarted' } });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const edited = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} {{c2::b}}', ''] } }, testCtx());
    expect(cardsOf(edited.state, 'n1').map((c) => [c.ord, life(c)])).toEqual([
      [0, 'notStarted'],
      [1, 'notStarted'],
    ]);
    // A note that is in the queue: the new number arrives as the deck says.
    const queued = noteWithCards({ deckId: 'd1', typeId: CLOZE, fields: ['{{c1::a}}', ''], note: { id: 'n2' }, card: { newState: 'queued' } });
    const withQueued = deepReadOnly(stateOfV3({ decks: [deck], groups: [queued] }));
    const more = editNote(withQueued, { noteId: 'n2', patch: { fields: ['{{c1::a}} {{c2::b}}', ''] } }, testCtx());
    expect(cardsOf(more.state, 'n2').map((c) => [c.ord, life(c)])).toEqual([
      [0, 'new'],
      [1, 'new'],
    ]);
  });

  it('a cloze edit by mistake can be undone with the progress kept: restoreCards, then the old text', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({
      deckId: 'd1',
      typeId: CLOZE,
      fields: ['{{c1::a}} {{c2::b}}', ''],
      note: { id: 'n1' },
      card: (ord) => ({ ...lifeValues('mastered'), id: `c${ord + 1}` }),
    });
    const other = noteWithCards({ deckId: 'd1', note: { id: 'n0' } });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g, other] }));
    const ctx = testCtx();
    // "{{c2::" deleted by accident, and a new number 3 typed.
    const edited = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} b {{c3::c}}', ''] } }, ctx);
    expect(edited.result!.removedCards.map((r) => [r.index, r.card.id])).toEqual([[1, 'c2']]);
    // No ManualEdit: the Undo is in memory, like the Undo of deleteNotes.
    expect(edited.state.manualLog).toBe(state.manualLog);

    const back = restoreCards(deepReadOnly(edited.state), { cards: edited.result!.removedCards });
    expect(back.result).toEqual({ restoredCards: 1 });
    const undone = editNote(back.state, { noteId: 'n1', patch: { fields: [...g.note.fields] } }, ctx);
    // The old text keeps the restored card and removes the card made for number 3.
    expect(undone.result!.removedCardIds).toEqual(edited.result!.addedCardIds);
    expect(undone.result!.addedCardIds).toEqual([]);
    expect(noteOf(undone.state, 'n1').fields).toEqual(g.note.fields);
    expect(undone.state.cards).toEqual(state.cards);
    // c2 is the same card again: same id, same schedule.
    expect(cardsOf(undone.state, 'n1')[1]).toBe(cardsOf(state, 'n1')[1]);
    expect(life(cardsOf(undone.state, 'n1')[1])).toBe('mastered');
    // A second restore does nothing.
    expect(restoreCards(back.state, { cards: edited.result!.removedCards }).state).toBe(back.state);
  });

  it('restoreCards never makes a second card for a direction, an orphan, or a split note', () => {
    const decks = [makeDeckV3({ id: 'd1' }), makeDeckV3({ id: 'd2' })];
    const g = noteWithCards({
      deckId: 'd1',
      typeId: CLOZE,
      fields: ['{{c1::a}} {{c2::b}}', ''],
      note: { id: 'n1' },
      card: lifeValues('review'),
    });
    const state = deepReadOnly(stateOfV3({ decks, groups: [g] }));
    const ctx = testCtx();
    const edited = editNote(state, { noteId: 'n1', patch: { fields: ['{{c1::a}} b', ''] } }, ctx);
    const removed = edited.result!.removedCards;
    expect(removed).toHaveLength(1);

    // The number was typed again: a NEW card has ord 1 now, so the old one is not added twice.
    const retyped = editNote(edited.state, { noteId: 'n1', patch: { fields: ['{{c1::a}} {{c2::b}}', ''] } }, ctx);
    expect(restoreCards(retyped.state, { cards: removed }).result).toEqual({ restoredCards: 0 });

    // The note was moved since: the card comes back into the note's NEW deck.
    const moved = moveNotes(edited.state, { noteIds: ['n1'], deckId: 'd2' }, ctx);
    const intoD2 = restoreCards(moved.state, { cards: removed });
    expect(cardsOf(intoD2.state, 'n1').map((c) => c.deckId)).toEqual(['d2', 'd2']);
    expect(stateProblemsV3(intoD2.state)).toEqual([]);

    // The note was deleted since: nothing comes back.
    const gone = deleteNotes(edited.state, { noteIds: ['n1'] });
    expect(restoreCards(gone.state, { cards: removed }).state).toBe(gone.state);

    // The note has no card left and the card's deck is gone: no orphan.
    const noDeck = { ...edited.state, cards: [], decks: edited.state.decks.filter((d) => d.id !== 'd1') };
    expect(restoreCards(noDeck, { cards: removed }).state).toBe(noDeck);
  });

  it('an unknown note, or extra text in the fields, changes nothing; an equal edit returns the same state', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({ deckId: 'd1', note: { id: 'n1' } });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g] }));
    const ctx = testCtx();
    expect(editNote(state, { noteId: 'nope', patch: { tags: ['x'] } }, ctx)).toEqual({ state, result: null });
    expect(editNote(state, { noteId: 'n1', patch: { fields: ['a', 'b', 'c', 'd', 'e'] } }, ctx).state).toBe(state);
    expect(editNote(state, { noteId: 'n1', patch: { fields: [...g.note.fields], tags: [] } }, ctx).state).toBe(state);
  });
});

/* ----------------------------------------------------------- moveNotes */

/** Decks d1 'Home' and d2 'Target'; note n1 (2 directions) and n2 (1 card) in d1. */
function twoDecks(): DataStateV3 {
  const decks = [makeDeckV3({ id: 'd1', name: 'Home' }), makeDeckV3({ id: 'd2', name: 'Target', order: 1 })];
  const n1 = noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1', section: 'Verbs' } });
  const n2 = noteWithCards({ deckId: 'd1', note: { id: 'n2' } });
  return deepReadOnly(stateOfV3({ decks, groups: [n1, n2] }));
}

describe('moveNotes', () => {
  it('moves EVERY card of each note, and records a move edit', () => {
    const state = twoDecks();
    const step = moveNotes(state, { noteIds: ['n1'], deckId: 'd2' }, testCtx());
    expect(cardsOf(step.state, 'n1').map((c) => c.deckId)).toEqual(['d2', 'd2']);
    expect(cardsOf(step.state, 'n2')[0]).toBe(cardsOf(state, 'n2')[0]);
    expect(step.result.edit).toMatchObject({ kind: 'move', label: '2 cards moved to Target' });
    expect(step.result.edit.cards.map((e) => [e.before.deckId, e.after.deckId])).toEqual([
      ['d1', 'd2'],
      ['d1', 'd2'],
    ]);
    expect(step.result.edit.notes).toBeUndefined();
    expect(noteOf(step.state, 'n1')).toBe(noteOf(state, 'n1'));
    expect(stateProblemsV3(step.state)).toEqual([]);
  });

  it('with a section, sets it on the notes (also inside the same deck)', () => {
    const state = twoDecks();
    const step = moveNotes(state, { noteIds: ['n1'], deckId: 'd1', section: 'Verbs::B1' }, testCtx());
    expect(noteOf(step.state, 'n1').section).toBe('Verbs::B1');
    expect(step.state.cards).toBe(state.cards);
    expect(step.result.edit.notes).toEqual([
      { id: 'n1', before: { tags: [], section: 'Verbs' }, after: { tags: [], section: 'Verbs::B1' } },
    ]);
    const undo = undoManualEdit(step.state, { editId: step.result.edit.id }, testCtx());
    expect(noteOf(undo.state, 'n1').section).toBe('Verbs');
    // A notes-only edit is counted in cards: the note's 2 cards are back in "Verbs".
    expect(undo.result).toEqual({ found: true, reverted: 2, skipped: 0 });
  });

  it('a missing target deck, or notes already there, change nothing', () => {
    const state = twoDecks();
    for (const input of [{ noteIds: ['n1'], deckId: 'nope' }, { noteIds: ['n1'], deckId: 'd1' }]) {
      const step = moveNotes(state, input, testCtx());
      expect(step.state).toBe(state);
      expect(step.result.undoable).toBe(false);
    }
  });

  it('gathers a note whose cards were split (broken data) into the one target deck', () => {
    const decks = [makeDeckV3({ id: 'd1' }), makeDeckV3({ id: 'd2' })];
    const g = noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1' } });
    const split = { ...g, cards: [g.cards[0], { ...g.cards[1], deckId: 'd2' }] };
    const step = moveNotes(deepReadOnly(stateOfV3({ decks, groups: [split] })), { noteIds: ['n1'], deckId: 'd2' }, testCtx());
    expect(cardsOf(step.state, 'n1').map((c) => c.deckId)).toEqual(['d2', 'd2']);
  });

  it('undo moves the note back, and a card made after the move goes back with its siblings', () => {
    const ctx = testCtx();
    const moved = moveNotes(twoDecks(), { noteIds: ['n1'], deckId: 'd2' }, ctx);
    // A new sibling is made in d2 after the move (three directions → new card).
    const withSibling = {
      ...moved.state,
      cards: [...moved.state.cards, { ...cardsOf(moved.state, 'n1')[0], id: 'late', ord: 5 }],
    };
    const undo = undoManualEdit(deepReadOnly(withSibling), { editId: moved.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 2, skipped: 0 });
    expect(cardsOf(undo.state, 'n1').map((c) => c.deckId)).toEqual(['d1', 'd1', 'd1']);
    expect(stateProblemsV3(undo.state)).toEqual([]);
  });

  it('undo is per note, all or nothing: a note moved again since stays where it is', () => {
    const ctx = testCtx();
    const decks = [makeDeckV3({ id: 'd1' }), makeDeckV3({ id: 'd2' }), makeDeckV3({ id: 'd3' })];
    const state = deepReadOnly(
      stateOfV3({
        decks,
        groups: [
          noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1' } }),
          noteWithCards({ deckId: 'd1', note: { id: 'n2' } }),
        ],
      }),
    );
    const first = moveNotes(state, { noteIds: ['n1', 'n2'], deckId: 'd2' }, ctx);
    const again = moveNotes(first.state, { noteIds: ['n1'], deckId: 'd3' }, ctx);
    const undo = undoManualEdit(again.state, { editId: first.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 1, skipped: 2 });
    expect(cardsOf(undo.state, 'n1').map((c) => c.deckId)).toEqual(['d3', 'd3']);
    expect(cardsOf(undo.state, 'n2').map((c) => c.deckId)).toEqual(['d1']);
  });

  it('undo never moves cards back into a deck that was deleted since (no orphans)', () => {
    const ctx = testCtx();
    const moved = moveNotes(twoDecks(), { noteIds: ['n1', 'n2'], deckId: 'd2' }, ctx);
    const deckGone = deepReadOnly({ ...moved.state, decks: moved.state.decks.filter((d) => d.id !== 'd1') });
    const undo = undoManualEdit(deckGone, { editId: moved.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 0, skipped: 3 });
    expect(undo.state.cards).toBe(deckGone.cards);
    expect(stateProblemsV3(undo.state)).toEqual([]);
  });

  it('undo of a move with a section is per note: deck and section go back together (partial counts)', () => {
    const ctx = testCtx();
    const decks = [makeDeckV3({ id: 'd1', name: 'One' }), makeDeckV3({ id: 'd2', name: 'Two' })];
    const state = deepReadOnly(
      stateOfV3({
        decks,
        groups: [
          noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1', section: 'Old1' } }),
          // n2 is in the target deck already: only its section changes.
          noteWithCards({ deckId: 'd2', typeId: REVERSE, note: { id: 'n2', section: 'Old2' } }),
          noteWithCards({ deckId: 'd1', note: { id: 'n3', section: 'Old3' } }),
        ],
      }),
    );
    const moved = moveNotes(state, { noteIds: ['n1', 'n2', 'n3'], deckId: 'd2', section: 'S' }, ctx);
    expect(moved.result.edit.label).toBe('5 cards moved to Two');

    // Nothing changed since: everything goes back, each note counted once (2 + 2 + 1).
    const full = undoManualEdit(moved.state, { editId: moved.result.edit.id }, ctx);
    expect(full.result).toEqual({ found: true, reverted: 5, skipped: 0 });
    expect(partialUndoMessage(full.result)).toBeNull();
    expect(full.state.notes.map((n) => n.section)).toEqual(['Old1', 'Old2', 'Old3']);
    expect(full.state.cards.map((c) => c.deckId)).toEqual(state.cards.map((c) => c.deckId));

    // Since the move, n1 (moved) and n2 (section only) got section 'T'.
    const later = moveNotes(moved.state, { noteIds: ['n1', 'n2'], deckId: 'd2', section: 'T' }, ctx);
    const undo = undoManualEdit(later.state, { editId: moved.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 1, skipped: 4 });
    expect(partialUndoMessage(undo.result)).toBe('Undone for 1 card. 4 were studied since and were not changed back.');
    // n1 keeps its new deck AND its new section: never its old deck with a section of the new deck.
    expect(noteOf(undo.state, 'n1').section).toBe('T');
    expect(cardsOf(undo.state, 'n1').map((c) => c.deckId)).toEqual(['d2', 'd2']);
    expect(noteOf(undo.state, 'n2').section).toBe('T');
    // n3 was not changed since: it goes back to its deck and its section.
    expect(noteOf(undo.state, 'n3').section).toBe('Old3');
    expect(cardsOf(undo.state, 'n3').map((c) => c.deckId)).toEqual(['d1']);
    expect(stateProblemsV3(undo.state)).toEqual([]);
  });

  it('a note whose move cannot be undone keeps its new section too (old deck deleted, or moved again)', () => {
    const ctx = testCtx();
    const decks = [makeDeckV3({ id: 'd1' }), makeDeckV3({ id: 'd2' }), makeDeckV3({ id: 'd3' })];
    const state = deepReadOnly(
      stateOfV3({ decks, groups: [noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1', section: 'Old' } })] }),
    );
    const moved = moveNotes(state, { noteIds: ['n1'], deckId: 'd2', section: 'New' }, ctx);

    // The old deck was deleted: the cards stay (no orphans), so the section 'New' stays too.
    const d1Gone = deepReadOnly({ ...moved.state, decks: moved.state.decks.filter((d) => d.id !== 'd1') });
    const undo = undoManualEdit(d1Gone, { editId: moved.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 0, skipped: 2 });
    expect(noteOf(undo.state, 'n1').section).toBe('New');
    expect(undo.state.cards).toBe(d1Gone.cards);
    expect(undo.state.notes).toBe(d1Gone.notes);
    expect(undo.state.manualLog).toEqual([]);
    expect(stateProblemsV3(undo.state)).toEqual([]);

    // The note was moved on to d3 (section unchanged): it stays there, with the section 'New'.
    const again = moveNotes(moved.state, { noteIds: ['n1'], deckId: 'd3' }, ctx);
    const undoAgain = undoManualEdit(again.state, { editId: moved.result.edit.id }, ctx);
    expect(undoAgain.result).toEqual({ found: true, reverted: 0, skipped: 2 });
    expect(noteOf(undoAgain.state, 'n1').section).toBe('New');
    expect(cardsOf(undoAgain.state, 'n1').map((c) => c.deckId)).toEqual(['d3', 'd3']);
  });
});

/* ------------------------------------------------------------ tagNotes */

describe('tagNotes', () => {
  function tagged(): DataStateV3 {
    const deck = makeDeckV3({ id: 'd1' });
    return deepReadOnly(
      stateOfV3({
        decks: [deck],
        groups: [
          noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1', tags: ['Verb', 'A1'] } }),
          noteWithCards({ deckId: 'd1', note: { id: 'n2', tags: ['core'] } }),
        ],
      }),
    );
  }

  it('adds and removes tags without case; added tags go to the end, never twice', () => {
    const state = tagged();
    const step = tagNotes(state, { noteIds: ['n1', 'n2'], add: ['verb', 'B1'], remove: ['a1'] }, testCtx());
    expect(noteOf(step.state, 'n1').tags).toEqual(['Verb', 'B1']);
    expect(noteOf(step.state, 'n2').tags).toEqual(['core', 'verb', 'B1']);
    expect(step.result.edit).toMatchObject({
      kind: 'tags',
      label: '3 cards retagged',
      cards: [],
      notes: [
        { id: 'n1', before: { tags: ['Verb', 'A1'] }, after: { tags: ['Verb', 'B1'] } },
        { id: 'n2', before: { tags: ['core'] }, after: { tags: ['core', 'verb', 'B1'] } },
      ],
    });
    expect(step.state.cards).toBe(state.cards);
  });

  it('labels: tagged / untagged; no change → not undoable', () => {
    const state = tagged();
    const ctx = testCtx();
    expect(tagNotes(state, { noteIds: ['n2'], add: ['x'], remove: [] }, ctx).result.edit.label).toBe('1 card tagged');
    expect(tagNotes(state, { noteIds: ['n1'], add: [], remove: ['verb'] }, ctx).result.edit.label).toBe('2 cards untagged');
    const none = tagNotes(state, { noteIds: ['n2'], add: ['CORE'], remove: [] }, ctx);
    expect(none.state).toBe(state);
    expect(none.result.undoable).toBe(false);
  });

  it('undo restores the tags, unless the tags were changed again since', () => {
    const ctx = testCtx();
    const step = tagNotes(tagged(), { noteIds: ['n1', 'n2'], add: ['x'], remove: [] }, ctx);
    const undo = undoManualEdit(step.state, { editId: step.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 3, skipped: 0 });
    expect(undo.state.notes.map((n) => n.tags)).toEqual([['Verb', 'A1'], ['core']]);

    const later = tagNotes(step.state, { noteIds: ['n2'], add: ['y'], remove: [] }, ctx);
    const partial = undoManualEdit(later.state, { editId: step.result.edit.id }, ctx);
    expect(partial.result).toEqual({ found: true, reverted: 2, skipped: 1 });
    expect(noteOf(partial.state, 'n2').tags).toEqual(['core', 'x', 'y']);
  });
});

/* ----------------------------------------------------- delete and restore */

describe('deleteNotes and restoreNotes', () => {
  function library(): DataStateV3 {
    const decks = [makeDeckV3({ id: 'd1' }), makeDeckV3({ id: 'd2' })];
    return deepReadOnly(
      stateOfV3({
        decks,
        groups: [
          noteWithCards({ deckId: 'd1', note: { id: 'n1' } }),
          noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n2' } }),
          noteWithCards({ deckId: 'd2', note: { id: 'n3' } }),
          noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n4' } }),
        ],
      }),
    );
  }

  it('removes the notes and ALL their cards, and returns them with their places', () => {
    const state = library();
    const step = deleteNotes(state, { noteIds: ['n2', 'n4', 'nope'] });
    expect(step.state.notes.map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(step.state.cards.every((c) => c.noteId === 'n1' || c.noteId === 'n3')).toBe(true);
    expect(step.result.notes.map((x) => [x.index, x.note.id])).toEqual([
      [1, 'n2'],
      [3, 'n4'],
    ]);
    expect(step.result.cards.map((x) => x.card.noteId)).toEqual(['n2', 'n2', 'n4', 'n4']);
    expect(step.result.label).toBe('4 cards deleted');
    expect(step.state.noteTypes).toBe(state.noteTypes);
    expect(stateProblemsV3(step.state)).toEqual([]);
  });

  it('restore puts everything back exactly (same objects, same places); a second restore does nothing', () => {
    const state = library();
    const deleted = deleteNotes(state, { noteIds: ['n2', 'n4'] });
    const restored = restoreNotes(deepReadOnly(deleted.state), { deleted: deleted.result });
    expect(restored.result).toEqual({ restoredNotes: 2, restoredCards: 4 });
    expect(restored.state.notes).toEqual(state.notes);
    expect(restored.state.cards).toEqual(state.cards);
    restored.state.cards.forEach((c, i) => expect(c).toBe(state.cards[i]));
    const again = restoreNotes(restored.state, { deleted: deleted.result });
    expect(again.result).toEqual({ restoredNotes: 0, restoredCards: 0 });
    expect(again.state).toBe(restored.state);
  });

  it('restore never brings back cards whose deck was deleted since (no orphans)', () => {
    const state = library();
    const deleted = deleteNotes(state, { noteIds: ['n1', 'n3'] });
    const d2Gone = { ...deleted.state, decks: deleted.state.decks.filter((d) => d.id !== 'd2') };
    const restored = restoreNotes(d2Gone, { deleted: deleted.result });
    expect(restored.result).toEqual({ restoredNotes: 1, restoredCards: 1 });
    expect(restored.state.notes.map((n) => n.id)).toContain('n1');
    expect(restored.state.notes.map((n) => n.id)).not.toContain('n3');
    expect(stateProblemsV3(restored.state)).toEqual([]);
  });

  it('deleting nothing returns the same state', () => {
    const state = library();
    expect(deleteNotes(state, { noteIds: ['nope'] }).state).toBe(state);
  });
});

/* --------------------------------------------------------- duplicateDeck */

describe('duplicateDeck', () => {
  function source(): DataStateV3 {
    const deck = makeDeckV3({
      id: 'd1',
      name: 'German',
      icon: '🇩🇪',
      desc: 'All my words',
      order: 4,
      source: 'apkg',
      sourceKey: 'file:German.apkg',
      language: 'de-DE',
      meaningLanguage: 'en-US',
      genderColors: true,
      options: { newPerDay: 15, newArrival: 'notStarted', directions: { [REVERSE]: [0, 1] } },
    });
    const other = makeDeckV3({ id: 'd2', order: 1 });
    const studied = noteWithCards({
      deckId: 'd1',
      typeId: REVERSE,
      note: { id: 'n1', tags: ['verb'], section: 'Verbs::B1', order: 7, guid: 'anki-guid-1', source: { kind: 'apkg', ref: 'German.apkg', ankiNoteId: '1500000' } },
      card: (ord) => ({
        ...lifeValues(ord === 0 ? 'mastered' : 'known'),
        id: `c1-${ord}`,
        noteId: 'n1',
        deckId: 'd1',
        ord,
        newPos: 7,
        fav: true,
        flagged: true,
        flagColor: 3,
        suspended: ord === 1,
        buriedUntil: FIXED_NOW + DAY,
      }),
    });
    const elsewhere = noteWithCards({ deckId: 'd2', note: { id: 'n2' } });
    return deepReadOnly(stateOfV3({ decks: [deck, other], groups: [studied, elsewhere] }));
  }

  it('makes "{name} (copy)" at the end of the deck list, with every setting but the re-import key', () => {
    const state = source();
    const ctx = testCtx(FIXED_NOW + 50);
    const copy = duplicateDeck(state, { deckId: 'd1' }, ctx).result!;
    expect(copy.id).not.toBe('d1');
    expect(copy).toMatchObject({
      name: 'German (copy)',
      icon: '🇩🇪',
      desc: 'All my words',
      order: 5,
      active: true,
      source: 'apkg',
      language: 'de-DE',
      meaningLanguage: 'en-US',
      genderColors: true,
      createdAt: ctx.now,
      options: { newPerDay: 15, newOrder: 'source', newArrival: 'notStarted', knownChecks: true, directions: { [REVERSE]: [0, 1] } },
    });
    expect(copy.sourceKey).toBeUndefined();
    // The options are a copy, never shared with the original.
    expect(copy.options).not.toBe(deckOf(state, 'd1').options);
    expect(copy.options.directions![REVERSE]).not.toBe(deckOf(state, 'd1').options.directions![REVERSE]);
  });

  it('copies notes with new ids and guids, and cards with NO progress', () => {
    const state = source();
    const step = duplicateDeck(state, { deckId: 'd1' }, testCtx());
    const copy = step.result!;
    const notes = step.state.notes.slice(state.notes.length);
    expect(notes).toHaveLength(1);
    const [note] = notes;
    expect(note.id).not.toBe('n1');
    expect(note.guid).toBe(`m-${note.id}`);
    expect(note).toMatchObject({ typeId: REVERSE, fields: noteOf(state, 'n1').fields, tags: ['verb'], section: 'Verbs::B1', order: 7 });
    expect(note.source).toEqual({ kind: 'apkg', ref: 'German.apkg' });
    const cards = cardsOf(step.state, note.id);
    expect(cards.map((c) => c.ord)).toEqual([0, 1]);
    for (const c of cards) {
      expect(c.id.startsWith('c1-')).toBe(false);
      expect(c).toMatchObject({
        deckId: copy.id, newPos: 7, newState: 'notStarted', reps: 0, lapses: 0, intervalDays: 0, stepIndex: null,
        lastReviewedAt: null, ease: state.settings.srs.startingEase, fav: false, flagged: false, suspended: false, buriedUntil: null,
      });
      expect(c.knownAt).toBeUndefined();
      expect(c.flagColor).toBeUndefined();
      expect(life(c)).toBe('notStarted');
    }
    // The original is untouched.
    state.cards.forEach((c, i) => expect(step.state.cards[i]).toBe(c));
    state.notes.forEach((n, i) => expect(step.state.notes[i]).toBe(n));
    expect(stateProblemsV3(step.state)).toEqual([]);
  });

  it('a missing deck changes nothing', () => {
    const state = source();
    expect(duplicateDeck(state, { deckId: 'nope' }, testCtx())).toEqual({ state, result: null });
  });
});

/* --------------------------------------------------------- setDirections */

describe('setDirections', () => {
  /** d1 has two Basic + reverse notes with only "Front → Back" (ord 0), one studied; d2 has one. */
  function oneWay(arrival: 'queued' | 'notStarted' = 'queued'): DataStateV3 {
    const decks = [makeDeckV3({ id: 'd1', options: { newArrival: arrival } }), makeDeckV3({ id: 'd2' })];
    return deepReadOnly(
      stateOfV3({
        decks,
        groups: [
          noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: 'n1', order: 3 }, card: lifeValues('review') }),
          noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: 'n2', order: 4 } }),
          noteWithCards({ deckId: 'd2', typeId: REVERSE, ords: [0], note: { id: 'n3' } }),
        ],
      }),
    );
  }

  it('turning a direction ON creates the missing cards and keeps the existing ones', () => {
    const state = oneWay('notStarted');
    const step = setDirections(state, { deckId: 'd1', typeId: REVERSE, ords: [0, 1] }, testCtx());
    expect(step.result.created).toBe(2);
    expect(deckOf(step.state, 'd1').options.directions).toEqual({ [REVERSE]: [0, 1] });
    for (const noteId of ['n1', 'n2']) {
      const [kept, made] = cardsOf(step.state, noteId);
      expect(kept).toBe(cardsOf(state, noteId)[0]);
      expect(made).toMatchObject({ ord: 1, deckId: 'd1', reps: 0, newState: 'notStarted', newPos: noteOf(state, noteId).order });
    }
    expect(step.result.cardIds).toEqual([cardsOf(step.state, 'n1')[1].id, cardsOf(step.state, 'n2')[1].id]);
    // Another deck with the same card type is not touched.
    expect(cardsOf(step.state, 'n3')).toEqual(cardsOf(state, 'n3'));
    expect(stateProblemsV3(step.state)).toEqual([]);
  });

  it('turning a direction OFF keeps every card and its progress', () => {
    const on = setDirections(oneWay(), { deckId: 'd1', typeId: REVERSE, ords: [0, 1] }, testCtx());
    const onView = deepReadOnly(on.state);
    const off = setDirections(onView, { deckId: 'd1', typeId: REVERSE, ords: [0] }, testCtx());
    expect(off.result.created).toBe(0);
    expect(off.state.cards).toBe(onView.cards);
    expect(deckOf(off.state, 'd1').options.directions).toEqual({ [REVERSE]: [0] });
    // A new note then gets only the enabled direction.
    const added = addNote(off.state, { deckId: 'd1', typeId: REVERSE, fields: ['a', 'b'], tags: [] }, testCtx());
    expect(cardsOf(added.state, added.result!.noteId).map((c) => c.ord)).toEqual([0]);
  });

  it('ignores ords without a template; cloze types, unknown decks and unknown types change nothing', () => {
    const state = oneWay();
    const step = setDirections(state, { deckId: 'd1', typeId: REVERSE, ords: [1, 7] }, testCtx());
    expect(deckOf(step.state, 'd1').options.directions).toEqual({ [REVERSE]: [1] });
    for (const input of [
      { deckId: 'd1', typeId: CLOZE, ords: [0, 1] },
      { deckId: 'nope', typeId: REVERSE, ords: [0, 1] },
      { deckId: 'd1', typeId: 'nt-nope', ords: [0, 1] },
    ]) {
      expect(setDirections(state, input, testCtx()).state).toBe(state);
    }
  });

  it('a note split over two decks (broken data) gets no second card for an ord, and new cards only in its home deck', () => {
    const decks = [makeDeckV3({ id: 'd1' }), makeDeckV3({ id: 'd2' })];
    // n1: ord 0 in d1, ord 1 in d2.
    const g = noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n1' } });
    const split = { ...g, cards: [g.cards[0], { ...g.cards[1], deckId: 'd2' }] };
    // n2 (three directions): ord 1 in d2, ord 2 in d1. Its home is d2 (the deck of its lowest ord).
    const type = threeWayType();
    const t = noteWithCards({ deckId: 'd2', typeId: type.id, ords: [1, 2], note: { id: 'n2' } }, [type]);
    const tSplit = { ...t, cards: [t.cards[0], { ...t.cards[1], deckId: 'd1' }] };
    const state = deepReadOnly(stateOfV3({ decks, groups: [split, tSplit], types: [type] }));
    const twoCardsForOneOrd = (s: DataStateV3) => stateProblemsV3(s).filter((p) => p.includes('two cards for ord'));

    for (const deckId of ['d1', 'd2']) {
      const step = setDirections(state, { deckId, typeId: REVERSE, ords: [0, 1] }, testCtx());
      expect(step.result.created).toBe(0);
      expect(step.state.cards).toBe(state.cards);
    }
    expect(setDirections(state, { deckId: 'd1', typeId: type.id, ords: [0, 1, 2] }, testCtx()).result.created).toBe(0);
    const home = setDirections(state, { deckId: 'd2', typeId: type.id, ords: [0, 1, 2] }, testCtx());
    expect(home.result.created).toBe(1);
    expect(cardsOf(home.state, 'n2').map((c) => [c.ord, c.deckId])).toEqual([
      [1, 'd2'],
      [2, 'd1'],
      [0, 'd2'],
    ]);
    expect(twoCardsForOneOrd(home.state)).toEqual([]);
  });

  it('a new direction gets the feed position of its never-studied siblings (after learn first)', () => {
    // A Basic + reverse note (order 40) with only "Front → Back"; learn({ first }) moves it to the front.
    const decks = [makeDeckV3({ id: 'd1' })];
    const early = noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: 'n0', order: 10 } });
    const g = noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: 'n1', order: 40 }, card: { newState: 'notStarted' } });
    const state = deepReadOnly(stateOfV3({ decks, groups: [early, g] }));
    const ctx = testCtx();
    const first = learn(state, { cardIds: [g.cards[0].id], first: true }, ctx);
    expect(cardsOf(first.state, 'n1')[0].newPos).toBe(9);
    const on = setDirections(first.state, { deckId: 'd1', typeId: REVERSE, ords: [0, 1] }, ctx);
    // Every never-studied card of the note has ONE position (spec §3.4 "Siblings share it").
    expect(cardsOf(on.state, 'n1').map((c) => [c.ord, c.newPos])).toEqual([
      [0, 9],
      [1, 9],
    ]);
    // n0 was not moved: its new card takes its sibling's (unchanged) position.
    expect(cardsOf(on.state, 'n0').map((c) => c.newPos)).toEqual([10, 10]);
  });

  it('a new direction of a Not started item stays Not started, even in a deck where new cards arrive queued', () => {
    // Deck d1: new cards arrive "In my queue". The items were left Not started
    // (import "Leave them not started", or "Move back to Not started").
    const type = threeWayType();
    const decks = [makeDeckV3({ id: 'd1', options: { newArrival: 'queued', directions: { [REVERSE]: [0], [type.id]: [0] } } })];
    const notStarted = noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: 'n1', order: 1 }, card: { newState: 'notStarted' } });
    // n2: one Not started card and one card already in the queue → the item is (partly) chosen: the deck's arrival.
    const mixed = noteWithCards(
      { deckId: 'd1', typeId: type.id, ords: [0, 1], note: { id: 'n2', order: 2 }, card: (ord) => (ord === 0 ? { newState: 'notStarted' } : { newState: 'queued' }) },
      [type],
    );
    // n3: only a studied card → no never-studied sibling: the deck's arrival.
    const studied = noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: 'n3', order: 3 }, card: lifeValues('review') });
    // n4: a Known card is not a never-studied sibling either: the deck's arrival.
    const known = noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: 'n4', order: 4 }, card: { knownAt: FIXED_NOW, newState: 'notStarted' } });
    const state = deepReadOnly(stateOfV3({ decks, groups: [notStarted, mixed, studied, known], types: [type] }));

    const on = setDirections(state, { deckId: 'd1', typeId: REVERSE, ords: [0, 1] }, testCtx());
    expect(on.result.created).toBe(3);
    expect(cardsOf(on.state, 'n1').map((c) => [c.ord, life(c)])).toEqual([
      [0, 'notStarted'],
      [1, 'notStarted'],
    ]);
    expect(cardsOf(on.state, 'n3')[1]).toMatchObject({ ord: 1, newState: 'queued' });
    expect(cardsOf(on.state, 'n4')[1]).toMatchObject({ ord: 1, newState: 'queued' });
    const three = setDirections(state, { deckId: 'd1', typeId: type.id, ords: [0, 1, 2] }, testCtx());
    expect(cardsOf(three.state, 'n2').map((c) => [c.ord, c.newState])).toEqual([
      [0, 'notStarted'],
      [1, 'queued'],
      [2, 'queued'],
    ]);
    expect(stateProblemsV3(on.state)).toEqual([]);
  });

  it('works for a custom type with three directions', () => {
    const type = threeWayType();
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({ deckId: 'd1', typeId: type.id, ords: [1], note: { id: 'n1' } }, [type]);
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [g], types: [type] }));
    const step = setDirections(state, { deckId: 'd1', typeId: type.id, ords: [0, 2] }, testCtx());
    expect(cardsOf(step.state, 'n1').map((c) => c.ord)).toEqual([1, 0, 2]);
    expect(step.result.created).toBe(2);
  });
});

/* ------------------------------------------------ random sequences (property) */

/** What the in-memory Undos of the random run keep: the last delete and the last cards a cloze edit removed. */
interface UndoMemory {
  value: ReturnType<typeof deleteNotes>['result'] | null;
  removedCards: EditNoteResult['removedCards'];
}

/** One random command on `state`. Returns the next state. */
function randomCommand(state: DataStateV3, rnd: Random, deleted: UndoMemory): DataStateV3 {
  const ctx = testCtx(FIXED_NOW + rnd.int(0, 5) * DAY);
  const cardIds = () => rnd.sample(state.cards, rnd.int(0, Math.min(6, state.cards.length))).map((c) => c.id);
  const noteIds = () => rnd.sample(state.notes, rnd.int(0, Math.min(4, state.notes.length))).map((n) => n.id);
  const deckId = () => rnd.pick(state.decks).id;
  const typeId = () => rnd.pick([BASIC, REVERSE, CLOZE, 'nt-three-way']);
  switch (rnd.int(0, 13)) {
    case 0: {
      const t = typeId();
      const fields = t === CLOZE ? [`{{c${rnd.int(1, 3)}::x}} {{c${rnd.int(1, 3)}::y}}`, ''] : ['a', 'b'];
      return addNote(state, { deckId: deckId(), typeId: t, fields, tags: ['t'] }, ctx).state;
    }
    case 1: {
      if (state.notes.length === 0) return state;
      const note = rnd.pick(state.notes);
      const fields = note.typeId === CLOZE ? [`{{c${rnd.int(1, 4)}::z}}`, 'extra'] : note.fields.map((f) => `${f}!`);
      const step = editNote(state, { noteId: note.id, patch: { fields, tags: ['edited'] } }, ctx);
      if (step.result && step.result.removedCards.length > 0) deleted.removedCards = step.result.removedCards;
      return step.state;
    }
    case 2:
      return moveNotes(state, { noteIds: noteIds(), deckId: deckId(), ...(rnd.bool() ? { section: 'S' } : {}) }, ctx).state;
    case 3:
      return tagNotes(state, { noteIds: noteIds(), add: ['new'], remove: ['verb', 'A1'] }, ctx).state;
    case 4: {
      const step = deleteNotes(state, { noteIds: noteIds() });
      deleted.value = step.result;
      return step.state;
    }
    case 5:
      // Either Undo, possibly long after: restore the last deleted notes, or the last cards a cloze edit removed.
      if (rnd.bool()) return restoreCards(state, { cards: deleted.removedCards }).state;
      return deleted.value ? restoreNotes(state, { deleted: deleted.value }).state : state;
    case 6:
      return duplicateDeck(state, { deckId: deckId() }, ctx).state;
    case 7:
      return setDirections(state, { deckId: deckId(), typeId: typeId(), ords: rnd.sample([0, 1, 2], rnd.int(0, 3)) }, ctx).state;
    case 8:
      return learn(state, { cardIds: cardIds(), first: rnd.bool() }, ctx).state;
    case 9:
      return markKnown(state, { cardIds: cardIds() }, ctx).state;
    case 10:
      return setNotStarted(state, { cardIds: cardIds() }, ctx).state;
    case 11:
      return rnd.bool()
        ? resetProgress(state, { cardIds: cardIds() }, ctx).state
        : reschedule(state, { cardIds: cardIds(), dueMs: ctx.now + DAY }, ctx).state;
    case 12:
      return setFlags(state, { cardIds: cardIds(), patch: { suspended: rnd.bool() } }, ctx).state;
    default: {
      if (state.manualLog.length === 0) return state;
      return undoManualEdit(state, { editId: rnd.pick(state.manualLog).id }, ctx).state;
    }
  }
}

describe('random command sequences (seeded property test)', () => {
  it('never change their input and keep every v3 invariant (100 libraries × 12 commands)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rnd = createRandom(`noteOps-${seed}`);
      let state = deepReadOnly(randomStateV3(rnd.fork('state'), { maxNotes: 15 }));
      expect(stateProblemsV3(state)).toEqual([]);
      expect(notesWithoutCards(state)).toEqual([]);
      const deleted: UndoMemory = { value: null, removedCards: [] };
      const ops = rnd.fork('ops');
      for (let step = 0; step < 12; step++) {
        // A command that wrote into its (frozen) input would throw here.
        const next = randomCommand(state, ops, deleted);
        // No command makes a note with no card (the start state has none).
        const problems = [...stateProblemsV3(next), ...notesWithoutCards(next).map((id) => `note ${id}: has no card`)];
        if (problems.length > 0) throw new Error(`seed ${seed}, step ${step}: ${problems.join('; ')}`);
        state = deepReadOnly(next);
      }
    }
  });

  it('deleteNotes → restoreNotes gives back the same library (30 libraries)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = createRandom(`delete-restore-${seed}`);
      const state = deepReadOnly(randomStateV3(rnd, { maxNotes: 12 }));
      const ids = rnd.sample(state.notes, rnd.int(0, state.notes.length)).map((n) => n.id);
      const deleted = deleteNotes(state, { noteIds: ids });
      const restored = restoreNotes(deepReadOnly(deleted.state), { deleted: deleted.result });
      expect(restored.state.notes).toEqual(state.notes);
      expect(restored.state.cards).toEqual(state.cards);
    }
  });
});
