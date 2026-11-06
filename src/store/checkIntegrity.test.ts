/**
 * Tests for the v3 integrity check (spec §3.5, unit W2-8): each repair case
 * of the spec, the exact repair list, and the rules every repair keeps —
 * nothing is changed in an intact library (same objects), a damaged one is
 * repaired in one pass (a second pass finds nothing), and no text is lost.
 *
 * The states are built with the shared v3 constructors (makeV3.ts) and the
 * built-in card types, so they look exactly like states the app will make.
 */
import { describe, expect, it } from '@jest/globals';

import { builtinType } from '../domain/builtinTypes';
import { deriveFacets } from '../domain/facets';
import { buildLibraryIndex } from '../domain/libraryIndex';
import { listsById } from '../domain/lists';
import { DEFAULT_DECK_OPTIONS, makeCard, makeDeck, makeNote } from '../domain/makeV3';
import type { Card, DataStateV3, Deck, FieldDef, Note, NoteType } from '../domain/model';
import type { MatchCtx } from '../domain/query';
import { renderFace } from '../domain/render';
import { DEFAULT_SRS } from '../domain/types';
import { FIXED_NOW } from '../test/clock';
import { makeState } from '../test/factories';
import { randomStateV3, stateProblemsV3 } from '../test/factoriesV3';
import { createRandom } from '../test/random';
import {
  checkIntegrity,
  DEFAULT_TYPE_NAME,
  RECOVERED_FIELD_NAME,
  RECOVERED_TYPE_ID,
  RECOVERED_TYPE_NAME,
} from './checkIntegrity';
import { UNFILED_DECK_ID } from './deckOps';
import { v2toV3 } from './migrateV3';

const NOW = FIXED_NOW;
const LATER = NOW + 60_000;

const BASIC = builtinType('basic', NOW);
const REVERSE = builtinType('basicReverse', NOW);

/** A Basic note (4 fields) unless other fields or a type are given. */
function note(id: string, fields: string[] = [`front ${id}`, `back ${id}`, '', ''], typeId = 'nt-basic'): Note {
  return makeNote({ id, typeId, fields }, NOW);
}

/** Card `id` = direction `ord` of note `noteId`, in deck `deckId`. */
function card(id: string, noteId: string, ord: number, deckId: string, extra: Partial<Card> = {}): Card {
  return makeCard({ id: noteId, order: NOW }, ord, deckId, DEFAULT_SRS, NOW, { id, ...extra });
}

function deck(id: string, order = 0): Deck {
  return makeDeck({ id, name: `Deck ${id}`, order }, NOW);
}

/** A complete v3 state (person, settings … from the migrated seed) with these parts. */
function v3State(parts: Partial<Pick<DataStateV3, 'noteTypes' | 'notes' | 'cards' | 'decks'>>): DataStateV3 {
  return { ...v2toV3(makeState(), NOW), noteTypes: [BASIC, REVERSE], notes: [], cards: [], decks: [], ...parts };
}

/** An intact library: two decks, a Basic note, a reverse note with both directions, a note with no cards. */
function intact(): DataStateV3 {
  return v3State({
    decks: [deck('d1', 0), deck('d2', 1)],
    notes: [note('n1'), note('n2', ['Hund', 'dog', '', ''], 'nt-basic-reverse'), note('n3')],
    cards: [card('c1', 'n1', 0, 'd1'), card('c2a', 'n2', 0, 'd2'), card('c2b', 'n2', 1, 'd2')],
  });
}

/** checkIntegrity, and a second run on its result must find nothing (one pass is enough). */
function check(state: DataStateV3) {
  const out = checkIntegrity(state, LATER);
  const again = checkIntegrity(out.state, LATER + 1);
  expect(again.repaired).toEqual([]);
  expect(again.state).toBe(out.state);
  return out;
}

/* ------------------------------------------------------------- intact */

describe('checkIntegrity — an intact library', () => {
  it('comes back as the SAME object, with nothing listed', () => {
    const state = intact();
    const out = checkIntegrity(state, LATER);
    expect(out.repaired).toEqual([]);
    expect(out.state).toBe(state);
  });

  it('a note with no cards is kept as it is (rule 2: Directions can give it cards again)', () => {
    const state = intact();
    expect(checkIntegrity(state, LATER).state.notes.find((n) => n.id === 'n3')).toBe(state.notes[2]);
  });
});

/* --------------------------------------------------------- the rules */

describe('checkIntegrity — rule 1: a card whose note is missing', () => {
  it('is set aside (left out of state.cards); everything else keeps its identity', () => {
    const state = intact();
    const lost = card('c9', 'n-gone', 0, 'd1');
    const { state: out, repaired } = check({ ...state, cards: [...state.cards, lost] });
    expect(out.cards.map((c) => c.id)).toEqual(['c1', 'c2a', 'c2b']);
    out.cards.forEach((c, i) => expect(c).toBe(state.cards[i]));
    expect(out.notes).toBe(state.notes);
    expect(out.decks).toBe(state.decks);
    expect(out.noteTypes).toBe(state.noteTypes);
    expect(repaired).toEqual(['card "c9": its note "n-gone" is missing, set aside']);
  });
});

describe('checkIntegrity — rule 3: cards of one note in different decks', () => {
  it('all take the deck of the lowest-ord card, wherever it is in the list', () => {
    const state = v3State({
      decks: [deck('d1'), deck('d2', 1)],
      notes: [note('n1', ['Hund', 'dog', '', ''], 'nt-basic-reverse')],
      cards: [card('c1b', 'n1', 1, 'd2'), card('c1a', 'n1', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.cards.map((c) => [c.id, c.deckId])).toEqual([
      ['c1b', 'd1'],
      ['c1a', 'd1'],
    ]);
    expect(out.cards[1]).toBe(state.cards[1]);
    expect(repaired).toEqual(['card "c1b": deckId "d2" → "d1" (all cards of one item stay in one deck)']);
  });

  it('when the lowest-ord card’s deck is gone, the cards stay together in the deck that exists', () => {
    const state = v3State({
      decks: [deck('d2')],
      notes: [note('n1', ['Hund', 'dog', '', ''], 'nt-basic-reverse')],
      cards: [card('c1a', 'n1', 0, 'd-deleted'), card('c1b', 'n1', 1, 'd2')],
    });
    const { state: out, repaired } = check(state);
    expect(out.cards.map((c) => c.deckId)).toEqual(['d2', 'd2']);
    expect(out.decks).toBe(state.decks); // no Unfiled deck needed
    expect(repaired).toEqual([
      'card "c1a": deckId "d-deleted" → "d2" (its deck is missing; it joins the other cards of its item)',
    ]);
  });
});

describe('checkIntegrity — rule 4: a card whose deck is missing', () => {
  it('moves to "Unfiled cards"; the deck is made in the v3 shape, at the end of the list', () => {
    const state = v3State({
      decks: [deck('d1', 0), deck('d2', 4)],
      notes: [note('n1'), note('n2')],
      cards: [card('c1', 'n1', 0, 'd1'), card('c2', 'n2', 0, 'd-deleted')],
    });
    const { state: out, repaired } = check(state);
    expect(out.cards[1].deckId).toBe(UNFILED_DECK_ID);
    expect(out.decks).toHaveLength(3);
    expect(out.decks[2]).toStrictEqual({
      id: UNFILED_DECK_ID,
      name: 'Unfiled cards',
      icon: '🗃️',
      active: true,
      order: 5,
      source: 'manual',
      defaultTypeId: 'nt-basic',
      createdAt: LATER,
      options: { ...DEFAULT_DECK_OPTIONS },
    });
    expect(repaired).toEqual([
      'card "c2": deckId "d-deleted" → "unfiled" (its deck is missing)',
      'deck "unfiled": created for cards whose deck was missing',
    ]);
  });

  it('uses the "Unfiled cards" deck that already exists', () => {
    const state = v3State({
      decks: [deck('d1'), deck(UNFILED_DECK_ID, 1)],
      notes: [note('n1')],
      cards: [card('c1', 'n1', 0, 'gone')],
    });
    const { state: out, repaired } = check(state);
    expect(out.decks).toBe(state.decks);
    expect(out.cards[0].deckId).toBe(UNFILED_DECK_ID);
    expect(repaired).toEqual(['card "c1": deckId "gone" → "unfiled" (its deck is missing)']);
  });

  it('a card already pointing at a missing "unfiled" deck gets the deck made', () => {
    const state = v3State({ notes: [note('n1')], cards: [card('c1', 'n1', 0, UNFILED_DECK_ID)] });
    const { state: out, repaired } = check(state);
    expect(out.decks.map((d) => [d.id, d.order])).toEqual([[UNFILED_DECK_ID, 0]]);
    expect(repaired).toEqual(['deck "unfiled": created for cards whose deck was missing']);
  });
});

describe('checkIntegrity — rule 5: a note whose card type is missing', () => {
  it('gets a "Recovered" type: Field 1…N (first = term), one template per direction its cards use', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1', ['a', 'b', 'c'], 'nt-anki-123'), note('n2', ['x', 'y', 'z', 'w', 'v'], 'nt-anki-123')],
      cards: [card('c1', 'n1', 0, 'd1'), card('c1b', 'n1', 2, 'd1'), card('c2', 'n2', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    const recovered = out.noteTypes.find((t) => t.id === 'nt-anki-123')!;
    expect(recovered).toStrictEqual({
      id: 'nt-anki-123',
      name: RECOVERED_TYPE_NAME,
      kind: 'standard',
      fields: [
        { name: 'Field 1', role: 'term', facet: 'auto' },
        { name: 'Field 2', role: 'detail', facet: 'auto' },
        { name: 'Field 3', role: 'detail', facet: 'auto' },
        { name: 'Field 4', role: 'detail', facet: 'auto' },
        { name: 'Field 5', role: 'detail', facet: 'auto' },
      ],
      templates: [
        { ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2, 3, 4] },
        { ord: 2, name: 'Card 3', prompt: [0], answer: [1, 2, 3, 4] },
      ],
      sortField: 0,
      createdAt: LATER,
      updatedAt: LATER,
    } satisfies NoteType);
    // The shorter note is padded to the type (rule 7); every card is kept.
    expect(out.notes[0].fields).toEqual(['a', 'b', 'c', '', '']);
    expect(out.notes[1]).toBe(state.notes[1]);
    expect(out.cards).toBe(state.cards);
    expect(repaired).toEqual([
      'card type "nt-anki-123": missing, a "Recovered" card type with 5 fields was made for 2 items',
      'note "n1": 3 values for 5 fields, padded with empty values',
    ]);
  });

  it('a missing BUILT-IN type is added again as itself (not as "Recovered")', () => {
    const state = { ...intact(), noteTypes: [REVERSE] };
    const { state: out, repaired } = check(state);
    expect(out.noteTypes).toStrictEqual([REVERSE, builtinType('basic', LATER)]);
    expect(out.notes).toBe(state.notes);
    expect(repaired).toEqual(['card type "nt-basic": missing, the built-in "Basic" was added again']);
  });

  it('a note with no usable typeId points at the Recovered type', () => {
    const broken = { ...note('n1'), typeId: 7 } as unknown as Note;
    const state = v3State({ decks: [deck('d1')], notes: [broken], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    expect(out.notes[0].typeId).toBe(RECOVERED_TYPE_ID);
    expect(out.notes[0].fields).toEqual(broken.fields);
    expect(out.noteTypes.map((t) => t.id)).toEqual(['nt-basic', 'nt-basic-reverse', RECOVERED_TYPE_ID]);
    expect(repaired).toEqual([
      `note "n1": typeId 7 → "${RECOVERED_TYPE_ID}"`,
      `card type "${RECOVERED_TYPE_ID}": missing, a "Recovered" card type with 4 fields was made for 1 item`,
    ]);
  });

});

/* ------------------------------------------------- a damaged card type */

describe('checkIntegrity — a damaged card type is repaired, not removed (spec §3.1 rule 4)', () => {
  /** An imported card type, like the German Anki decks have: Front, Back and a Level filter group. */
  const ANKI: NoteType = {
    id: 'nt-anki-1',
    name: 'German vocabulary',
    kind: 'standard',
    fields: [
      { name: 'Front', role: 'term', facet: 'off', lang: 'de-DE' },
      { name: 'Back', role: 'meaning', facet: 'off', lang: 'en-US' },
      { name: 'Level', role: 'badge', facet: 'on' },
    ],
    templates: [{ ord: 0, name: 'DE-EN', prompt: [0], answer: [1, 2] }],
    sortField: 0,
    source: { ankiMid: '1' },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const LEVELS = ['A1', 'B1', 'A2'];

  /**
   * One deck d1 with three notes of `type` (Level A1, B1, A2; `extra` values
   * after the three ANKI values) and three Basic notes, one card each. The
   * two card types have the same count, so the "card type" filter group
   * compares their NAMES.
   */
  function library(type: unknown, extra: string[] = []): DataStateV3 {
    const typeId = String((type as NoteType).id);
    const anki = LEVELS.map((level, i) => note(`a${i}`, [`Wort ${i}`, `word ${i}`, level, ...extra], typeId));
    const basic = [0, 1, 2].map((i) => note(`b${i}`));
    return v3State({
      noteTypes: [type as NoteType, BASIC],
      decks: [deck('d1')],
      notes: [...anki, ...basic],
      cards: [...anki, ...basic].map((n) => card(`c-${n.id}`, n.id, 0, 'd1')),
    });
  }

  /** The filter groups the Library shows for the whole library (buildLibraryIndex + deriveFacets). */
  function filterGroups(state: DataStateV3): string[] {
    const ctx: MatchCtx = {
      now: NOW,
      index: buildLibraryIndex(state.notes, state.noteTypes),
      decks: new Map(state.decks.map((d) => [d.id, d])),
      lists: listsById([]),
    };
    return deriveFacets(state.cards, {}, {}, ctx).map((f) => f.key);
  }

  /** The values of the Level filter group, A–Z. */
  function levelValues(state: DataStateV3): string[] {
    const ctx: MatchCtx = {
      now: NOW,
      index: buildLibraryIndex(state.notes, state.noteTypes),
      decks: new Map(state.decks.map((d) => [d.id, d])),
      lists: listsById([]),
    };
    const level = deriveFacets(state.cards, {}, {}, ctx).find((f) => f.key === 'field:level');
    return (level?.values ?? []).map((v) => v.label).sort();
  }

  /** The type with this id in a result. */
  const typeOf = (state: DataStateV3, id = 'nt-anki-1') => state.noteTypes.find((t) => t.id === id)!;

  it('the intact library has a Level filter group (the group every repair below must keep)', () => {
    const state = library(ANKI);
    expect(checkIntegrity(state, LATER).state).toBe(state);
    expect(filterGroups(state)).toEqual(expect.arrayContaining(['field:level', 'noteType']));
    expect(levelValues(state)).toEqual(['A1', 'A2', 'B1']);
  });

  it('the damaged values really break the library index and the filter groups (why this repair exists)', () => {
    const [front, back, level] = ANKI.fields;
    const withLabel = library({ ...ANKI, fields: [front, back, { ...level, label: 5 }] });
    expect(() => buildLibraryIndex(withLabel.notes, withLabel.noteTypes)).toThrow(TypeError);
    const withLang = library({ ...ANKI, fields: [{ ...front, lang: 5 }, back, level] });
    expect(() => filterGroups(withLang)).toThrow(TypeError);
    const withName = library({ ...ANKI, name: 5 });
    expect(() => filterGroups(withName)).toThrow(TypeError);
  });

  it('templates that is not a list → [] and then "Card <n>" templates; every field, role and filter group survives', () => {
    const state = library({ ...ANKI, templates: null });
    const { state: out, repaired } = check(state);
    expect(repaired).toEqual([
      'card type "nt-anki-1": templates null → []',
      'card type "nt-anki-1": no usable template, 1 template made for the directions its cards use',
    ]);
    const type = typeOf(out);
    expect(type.fields).toBe(ANKI.fields);
    expect(type).toStrictEqual({ ...ANKI, templates: [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2] }] });
    expect(out.notes).toBe(state.notes);
    expect(out.cards).toBe(state.cards);
    expect(levelValues(out)).toEqual(['A1', 'A2', 'B1']);
    const first = out.notes[0];
    expect(renderFace(first, type, 0).promptPlain).toBe('Wort 0');
  });

  it('a field that is not an object, or has no text name, gets a NEW unique name; the other fields keep their identity', () => {
    const [front, , level] = ANKI.fields;
    const nameless = { label: 'Notes', role: 'detail', facet: 'off' };
    const taken: FieldDef = { name: 'field 2', role: 'hidden', facet: 'off' };
    const state = library({ ...ANKI, fields: [front, null, level, nameless, taken] }, ['a note', 'hidden']);
    const { state: out, repaired } = check(state);
    const fields = typeOf(out).fields;
    expect(fields).toStrictEqual([
      front,
      // 'Field 2' is taken by 'field 2' (the filter groups fold names), so it gets '(2)'.
      { name: 'Field 2 (2)', role: 'detail', facet: 'auto' },
      level,
      { name: 'Field 4', label: 'Notes', role: 'detail', facet: 'off' },
      taken,
    ]);
    expect(fields[0]).toBe(front);
    expect(fields[2]).toBe(level);
    expect(fields[4]).toBe(taken);
    expect(repaired).toEqual([
      'card type "nt-anki-1", field #1: null is not a field → {"name":"Field 2 (2)","role":"detail","facet":"auto"}',
      'card type "nt-anki-1", field #3: name missing → "Field 4"',
    ]);
    expect(out.notes).toBe(state.notes);
    expect(levelValues(out)).toEqual(['A1', 'A2', 'B1']);
  });

  it('field values of the wrong kind: label, lang and multiSep are removed; role → "detail"; facet → "auto"', () => {
    const [front, back, level] = ANKI.fields;
    const state = library({
      ...ANKI,
      fields: [{ ...front, lang: 5 }, { ...back, role: 'big', facet: 'yes' }, { ...level, label: 5, multiSep: '/' }],
    });
    const { state: out, repaired } = check(state);
    expect(typeOf(out).fields).toStrictEqual([
      { name: 'Front', role: 'term', facet: 'off' },
      { name: 'Back', role: 'detail', facet: 'auto', lang: 'en-US' },
      { name: 'Level', role: 'badge', facet: 'on' },
    ]);
    expect(typeOf(out).templates).toBe(ANKI.templates);
    expect(repaired).toEqual([
      'card type "nt-anki-1", field "Front": lang 5 removed',
      'card type "nt-anki-1", field "Back": role "big" → "detail"',
      'card type "nt-anki-1", field "Back": facet "yes" → "auto"',
      'card type "nt-anki-1", field "Level": label 5 removed',
      'card type "nt-anki-1", field "Level": multiSep "/" removed',
    ]);
    expect(levelValues(out)).toEqual(['A1', 'A2', 'B1']);
    // The same keys with the right kind of value are kept (every role, facet and separator).
    const fine = library({
      ...ANKI,
      fields: [
        { ...front, label: 'Wort' },
        { ...back, facet: 'auto' },
        { ...level, role: 'hidden', multiSep: ',' },
      ],
    });
    expect(checkIntegrity(fine, LATER).state).toBe(fine);
  });

  it('the type values: name, kind, sortField, createdAt and updatedAt of the wrong kind get a default', () => {
    const state = library({ ...ANKI, name: 5, kind: 'basic', sortField: 7, createdAt: null, updatedAt: 'x' });
    const { state: out, repaired } = check(state);
    expect(typeOf(out)).toStrictEqual({ ...ANKI, name: '5', kind: 'standard', sortField: 0, createdAt: LATER, updatedAt: LATER });
    expect(typeOf(out).fields).toBe(ANKI.fields);
    expect(repaired).toEqual([
      'card type "nt-anki-1": name 5 → "5"',
      'card type "nt-anki-1": kind "basic" → "standard"',
      'card type "nt-anki-1": sortField 7 → 0',
      `card type "nt-anki-1": createdAt null → ${LATER}`,
      `card type "nt-anki-1": updatedAt "x" → ${LATER}`,
    ]);
    expect(filterGroups(out)).toEqual(expect.arrayContaining(['field:level', 'noteType']));
    // A name that is not a text, a number or true/false has no text to keep.
    const noName = check(library({ ...ANKI, name: { de: 'Wörter' } })).state;
    expect(typeOf(noName).name).toBe(DEFAULT_TYPE_NAME);
  });

  it('`fields` that is not a list → "Field 1" … "Field N" (N = the most values a note has); the rest of the type is kept', () => {
    const damaged = { ...BASIC, id: 'nt-anki-9', name: 'My words', fields: 'Front,Back' } as unknown as NoteType;
    const state = v3State({
      noteTypes: [damaged, REVERSE],
      decks: [deck('d1')],
      notes: [note('n1', ['a', 'b'], 'nt-anki-9'), note('n2', ['c'], 'nt-anki-9')],
      cards: [card('c1', 'n1', 0, 'd1'), card('c2', 'n2', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.noteTypes.map((t) => [t.id, t.name, t.fields.map((f) => f.name)])).toEqual([
      ['nt-anki-9', 'My words', ['Field 1', 'Field 2']],
      ['nt-basic-reverse', 'Basic + reverse', ['Front', 'Back', 'Example', 'Notes']],
    ]);
    expect(out.noteTypes[0].templates).toStrictEqual([{ ord: 0, name: 'Front → Back', prompt: [0], answer: [1] }]);
    expect(out.notes[0]).toBe(state.notes[0]);
    expect(out.notes[1].fields).toEqual(['c', '']);
    expect(repaired).toEqual([
      'card type "nt-anki-9": fields "Front,Back" is not a list of fields → 2 fields "Field 1" … "Field 2"',
      'card type "nt-anki-9", direction 0: answer [1,2,3] → [1]',
      'note "n2": 1 values for 2 fields, padded with empty values',
    ]);
  });

  it('a damaged BUILT-IN card type gets its built-in parts back: templates, fields, one field, name', () => {
    // templates: the built-in templates (Basic + reverse asks the Back field in direction 2).
    const noTemplates = { ...intact(), noteTypes: [{ ...BASIC, templates: null }, { ...REVERSE, templates: [null] }] };
    const out = check(noTemplates as unknown as DataStateV3);
    expect(out.state.noteTypes).toStrictEqual([BASIC, REVERSE]);
    expect(out.repaired).toEqual([
      'card type "nt-basic": templates null → []',
      'card type "nt-basic-reverse": template #0 null is not a template, removed',
      'card type "nt-basic": no usable template, the built-in templates were added again',
      'card type "nt-basic-reverse": no usable template, the built-in templates were added again',
    ]);
    const n2 = out.state.notes[1];
    expect([0, 1].map((ord) => renderFace(n2, out.state.noteTypes[1], ord).promptPlain)).toEqual(['Hund', 'dog']);

    // fields: the built-in fields; one damaged field: the built-in field at that place; a name: the built-in name.
    const [front, , example, notes] = REVERSE.fields;
    const damaged = { ...intact(), noteTypes: [{ ...BASIC, fields: 7, name: null }, { ...REVERSE, fields: [front, null, example, notes] }] };
    const fixed = check(damaged as unknown as DataStateV3);
    expect(fixed.state.noteTypes).toStrictEqual([BASIC, REVERSE]);
    expect(fixed.repaired).toEqual([
      'card type "nt-basic": name null → "Basic"',
      'card type "nt-basic": fields 7 is not a list of fields → the built-in fields',
      'card type "nt-basic-reverse", field #1: null is not a field → {"name":"Back","role":"meaning","facet":"off"}',
    ]);
  });

  it('300 seeded random damages to the card types: no type with an id is lost, every screen path works, one pass is enough', () => {
    type Obj = Record<string, unknown>;
    const BAD: unknown[] = [null, undefined, 5, -1, 1.5, 'x', '', true, [], [null], {}, { a: 1 }];
    const TYPE_KEYS = ['name', 'kind', 'fields', 'templates', 'sortField', 'createdAt', 'updatedAt'];
    const FIELD_KEYS = ['name', 'label', 'lang', 'role', 'facet', 'multiSep'];
    const rnd = createRandom('check-integrity-damaged-types');
    for (let i = 0; i < 300; i++) {
      const r = rnd.fork(`case-${i}`);
      const state = randomStateV3(r.fork('state'));
      // A copy of every card type (and of its field list), damaged in 1–3 places.
      const types = state.noteTypes.map((t) => ({ ...t, fields: [...t.fields] }) as unknown as Obj);
      for (let k = r.int(1, 3); k > 0; k--) {
        const t = r.pick(types);
        const bad = r.pick(BAD);
        const fields = t.fields;
        if (r.bool() || !Array.isArray(fields) || fields.length === 0) {
          t[r.pick(TYPE_KEYS)] = bad;
        } else {
          const at = r.int(0, fields.length - 1);
          fields[at] = r.bool(0.3) || typeof fields[at] !== 'object' ? bad : { ...fields[at], [r.pick(FIELD_KEYS)]: bad };
        }
      }
      const { state: out } = check({ ...state, noteTypes: types } as unknown as DataStateV3);
      expect(out.noteTypes.map((t) => t.id)).toEqual(state.noteTypes.map((t) => t.id));
      expect(stateProblemsV3(out)).toEqual([]);
      // Every card keeps its note and its progress.
      expect(out.cards).toBe(state.cards);
      // The library index, the filter groups and every card face work on the result.
      const ctx: MatchCtx = {
        now: NOW,
        index: buildLibraryIndex(out.notes, out.noteTypes),
        decks: new Map(out.decks.map((d) => [d.id, d])),
        lists: listsById([]),
      };
      expect(() => deriveFacets(out.cards, {}, {}, ctx)).not.toThrow();
      for (const c of out.cards) {
        const n = ctx.index.noteById.get(c.noteId)!;
        expect(() => renderFace(n, ctx.index.typeById.get(n.typeId)!, c.ord)).not.toThrow();
      }
    }
  });

  it('only an entry that is not an object, or has no usable id, is removed (no note can point at it)', () => {
    const state = { ...intact(), noteTypes: [7, { ...BASIC, id: '' }, REVERSE] } as unknown as DataStateV3;
    const { state: out, repaired } = check(state);
    expect(out.noteTypes).toStrictEqual([REVERSE, builtinType('basic', LATER)]);
    expect(repaired).toEqual([
      'card type #0: 7 is not a card type, removed',
      'card type #1: no usable id (""), removed (its items get a card type again below)',
      'card type "nt-basic": missing, the built-in "Basic" was added again',
    ]);
  });
});

/* ------------------------------------------------- card type templates */

describe('checkIntegrity — the templates of a card type (what renderFace reads)', () => {
  /** A state with ONE card type `type`, one note n1 of it (4 values) and its cards for `ords`, in deck d1. */
  function withType(type: NoteType, ords: number[] = [0], fields = ['Hund', 'dog', 'Der Hund bellt.', 'n.']): DataStateV3 {
    return v3State({
      noteTypes: [type],
      decks: [deck('d1')],
      notes: [note('n1', fields, type.id)],
      cards: ords.map((ord) => card(`c${ord}`, 'n1', ord, 'd1')),
    });
  }

  /** renderFace on every card of the result: it must not throw. Returns the question line of each card. */
  function questions(state: DataStateV3): string[] {
    return state.cards.map((c) => {
      const n = state.notes.find((x) => x.id === c.noteId)!;
      return renderFace(n, state.noteTypes.find((t) => t.id === n.typeId)!, c.ord).promptPlain;
    });
  }

  it('the damaged state really breaks renderFace (why this repair exists)', () => {
    const broken = { ...BASIC, id: 'nt-x', templates: [null] } as unknown as NoteType;
    expect(() => questions(withType(broken))).toThrow(TypeError);
  });

  it('a template that is not an object, or has no usable direction, is removed; the others keep their identity', () => {
    const [forward, backward] = REVERSE.templates;
    const type = { ...REVERSE, templates: [forward, null, { ...backward, ord: 'x' }, 7, { ...backward, ord: 1.5 }] };
    const { state: out, repaired } = check(withType(type as unknown as NoteType, [0, 1]));
    expect(out.noteTypes[0].templates).toStrictEqual([forward]);
    expect(out.noteTypes[0].templates[0]).toBe(forward);
    expect(out.noteTypes[0]).toMatchObject({ id: 'nt-basic-reverse', name: 'Basic + reverse', fields: REVERSE.fields });
    expect(repaired).toEqual([
      'card type "nt-basic-reverse": template #1 null is not a template, removed',
      'card type "nt-basic-reverse": template #2 has no usable direction (ord "x"), removed',
      'card type "nt-basic-reverse": template #3 7 is not a template, removed',
      'card type "nt-basic-reverse": template #4 has no usable direction (ord 1.5), removed',
    ]);
    // Direction 1 has no template now: renderFace shows it with the first template.
    expect(questions(out)).toEqual(['Hund', 'Hund']);
  });

  it('a side that is not a list of field numbers keeps its field numbers; with none left, the sort field asks and every other field answers', () => {
    const type = {
      ...BASIC,
      id: 'nt-x',
      sortField: 1,
      templates: [
        { ord: 0, name: 'A', prompt: 'x', answer: 5 },
        { ord: 1, name: 'B', prompt: [0, 'a', 9, -1, 1.5], answer: [null] },
        { ord: 2, name: 'C', prompt: [2], answer: { 0: 1 } },
      ],
    } as unknown as NoteType;
    const { state: out, repaired } = check(withType(type, [0, 1, 2]));
    expect(out.noteTypes[0].templates).toStrictEqual([
      { ord: 0, name: 'A', prompt: [1], answer: [0, 2, 3] },
      { ord: 1, name: 'B', prompt: [0], answer: [1, 2, 3] },
      { ord: 2, name: 'C', prompt: [2], answer: [0, 1, 3] },
    ]);
    expect(repaired).toEqual([
      'card type "nt-x", direction 0: prompt "x" → [1]',
      'card type "nt-x", direction 0: answer 5 → [0,2,3]',
      'card type "nt-x", direction 1: prompt [0,"a",9,-1,1.5] → [0]',
      'card type "nt-x", direction 1: answer [null] → [1,2,3]',
      'card type "nt-x", direction 2: answer {"0":1} → [0,1,3]',
    ]);
    expect(questions(out)).toEqual(['dog', 'Hund', 'Der Hund bellt.']);
    // An EMPTY side is a real list (nothing on that side), not damage: it is kept.
    const empty = { ...BASIC, id: 'nt-y', templates: [{ ord: 0, name: 'A', prompt: [0], answer: [] }] };
    const kept = withType(empty);
    expect(checkIntegrity(kept, LATER).state).toBe(kept);
  });

  it('a name that is not a text → "Card <n>"; a typeField, qfmt or afmt of the wrong kind is removed', () => {
    const type = {
      ...BASIC,
      id: 'nt-x',
      templates: [{ ord: 1, name: 7, prompt: [0], answer: [1], typeField: 9, qfmt: 3, afmt: null, extra: 'kept' }],
    } as unknown as NoteType;
    const { state: out, repaired } = check(withType(type, [1]));
    expect(out.noteTypes[0].templates).toStrictEqual([{ ord: 1, name: 'Card 2', prompt: [0], answer: [1], extra: 'kept' }]);
    expect(repaired).toEqual([
      'card type "nt-x", direction 1: name 7 → "Card 2"',
      'card type "nt-x", direction 1: typeField 9 removed',
      'card type "nt-x", direction 1: qfmt 3 removed',
      'card type "nt-x", direction 1: afmt null removed',
    ]);
    // The same keys with the right kind of value are kept.
    const fine = { ...BASIC, id: 'nt-y', templates: [{ ord: 0, name: 'A', prompt: [0], answer: [1], typeField: 1, qfmt: '{{Front}}', afmt: '' }] };
    const state = withType(fine);
    expect(checkIntegrity(state, LATER).state).toBe(state);
  });

  it('a card type with no template left gets one "Card <n>" template per direction its cards use (the sort field asks)', () => {
    const broken = { ...BASIC, id: 'nt-x', templates: [null] } as unknown as NoteType;
    const unused = { ...BASIC, id: 'nt-unused', templates: [] };
    const state = { ...withType(broken, [0, 2]), noteTypes: [broken, unused] };
    const { state: out, repaired } = check(state);
    expect(out.noteTypes.map((t) => [t.id, t.templates])).toStrictEqual([
      [
        'nt-x',
        [
          { ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2, 3] },
          { ord: 2, name: 'Card 3', prompt: [0], answer: [1, 2, 3] },
        ],
      ],
      ['nt-unused', [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2, 3] }]],
    ]);
    // Everything else of the type is kept: its fields, names and roles.
    expect(out.noteTypes[0]).toMatchObject({ name: 'Basic', fields: BASIC.fields, sortField: 0 });
    expect(out.notes).toBe(state.notes);
    expect(out.cards).toBe(state.cards);
    expect(repaired).toEqual([
      'card type "nt-x": template #0 null is not a template, removed',
      'card type "nt-x": no usable template, 2 templates made for the directions its cards use',
      'card type "nt-unused": no usable template, 1 template made for the directions its cards use',
    ]);
    expect(questions(out)).toEqual(['Hund', 'Hund']);
  });

  it('a cloze card type with no template gets ONE template (one template serves every cloze card)', () => {
    const cloze = { ...builtinType('cloze', NOW), id: 'nt-c', templates: [] };
    const { state: out, repaired } = check(withType(cloze, [0, 1], ['{{c1::Paris}} is in {{c2::France}}.', 'Europe']));
    expect(out.noteTypes[0].templates).toStrictEqual([{ ord: 0, name: 'Card 1', prompt: [0], answer: [1] }]);
    expect(repaired).toEqual(['card type "nt-c": no usable template, 1 template made for the directions its cards use']);
    expect(questions(out)).toEqual(['[…] is in France.', 'Paris is in […].']);
  });
});

describe('checkIntegrity — rule 6: two cards for the same note and direction', () => {
  it('keeps the first', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1')],
      cards: [card('c1', 'n1', 0, 'd1', { reps: 3 }), card('c1-copy', 'n1', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.cards).toEqual([state.cards[0]]);
    expect(repaired).toEqual(['card "c1-copy": a second card for direction 0 of note "n1", removed']);
  });
});

describe('checkIntegrity — rule 7: a note whose value count does not fit its type', () => {
  it('too few values → padded with ""', () => {
    const state = v3State({ decks: [deck('d1')], notes: [note('n1', ['Hund', 'dog'])], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    expect(out.notes[0].fields).toEqual(['Hund', 'dog', '', '']);
    expect(out.noteTypes).toBe(state.noteTypes);
    expect(repaired).toEqual(['note "n1": 2 values for 4 fields, padded with empty values']);
  });

  it('too many values → a "Recovered" field is added to the type and keeps them (one per line)', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1', ['Hund', 'dog', '', '', 'extra 1', '', 'extra 2']), note('n2')],
      cards: [card('c1', 'n1', 0, 'd1'), card('c2', 'n2', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    const basic = out.noteTypes.find((t) => t.id === 'nt-basic')!;
    expect(basic.fields.map((f) => f.name)).toEqual(['Front', 'Back', 'Example', 'Notes', RECOVERED_FIELD_NAME]);
    expect(basic.fields[4]).toStrictEqual({ name: RECOVERED_FIELD_NAME, role: 'detail', facet: 'off' });
    expect(basic.updatedAt).toBe(LATER);
    expect(out.noteTypes[1]).toBe(REVERSE);
    expect(out.notes[0].fields).toEqual(['Hund', 'dog', '', '', 'extra 1<br>extra 2']);
    // The other note of the type gets the empty new field (no line of its own).
    expect(out.notes[1].fields).toEqual([...state.notes[1].fields, '']);
    expect(repaired).toEqual([
      'card type "nt-basic": a "Recovered" field was added for values that had no field',
      'note "n1": 7 values for 4 fields, the extra values moved to the "Recovered" field',
    ]);
  });

  it('a type that already has a "Recovered" field keeps the extra values there', () => {
    const type: NoteType = {
      ...BASIC,
      id: 'nt-custom',
      fields: [...BASIC.fields, { name: RECOVERED_FIELD_NAME, role: 'detail', facet: 'off' }],
    };
    const state = v3State({
      noteTypes: [type],
      decks: [deck('d1')],
      notes: [note('n1', ['a', 'b', '', '', 'old', 'new'], 'nt-custom')],
      cards: [card('c1', 'n1', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.noteTypes[0]).toBe(type);
    expect(out.notes[0].fields).toEqual(['a', 'b', '', '', 'old<br>new']);
    expect(repaired).toEqual(['note "n1": 6 values for 5 fields, the extra values moved to the "Recovered" field']);
  });

  it('exactly ONE extra value → a "Recovered" field is added, and the note gets its own line too', () => {
    // The new type has 5 fields and the note has 5 values, so the old check "length === 5"
    // skipped the note: its value was in the right place, but the repair list did not say so.
    const n1 = note('n1', ['a', 'b', '', '', 'EXTRA']);
    const state = v3State({ decks: [deck('d1')], notes: [n1], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    expect(out.noteTypes.find((t) => t.id === 'nt-basic')!.fields.map((f) => f.name)).toEqual([
      'Front', 'Back', 'Example', 'Notes', RECOVERED_FIELD_NAME,
    ]);
    expect(out.notes[0].fields).toEqual(['a', 'b', '', '', 'EXTRA']);
    expect(out.notes[0]).toBe(n1); // the values were already in the right places
    expect(repaired).toEqual([
      'card type "nt-basic": a "Recovered" field was added for values that had no field',
      'note "n1": 5 values for 4 fields, the extra values moved to the "Recovered" field',
    ]);
  });

  it('one EMPTY extra value, while another note adds the "Recovered" field → no line for it (nothing moved)', () => {
    const empty = note('n2', ['c', 'd', '', '', '']);
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1', ['a', 'b', '', '', 'EXTRA']), empty],
      cards: [card('c1', 'n1', 0, 'd1'), card('c2', 'n2', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.notes[1]).toBe(empty); // 5 values for the new 5 fields: it already fits
    expect(repaired).toEqual([
      'card type "nt-basic": a "Recovered" field was added for values that had no field',
      'note "n1": 5 values for 4 fields, the extra values moved to the "Recovered" field',
    ]);
  });

  it('extra values that are all empty are just removed (the type does not change)', () => {
    const state = v3State({ decks: [deck('d1')], notes: [note('n1', ['a', 'b', '', '', '', ''])], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    expect(out.notes[0].fields).toEqual(['a', 'b', '', '']);
    expect(out.noteTypes).toBe(state.noteTypes);
    expect(repaired).toEqual(['note "n1": 6 values for 4 fields, the empty extra values removed']);
  });
});

/* ------------------------------------------------- ids and shapes */

describe('checkIntegrity — ids and shapes', () => {
  it('two notes with one id: the second gets a new id and is kept (no text is lost)', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1', ['first', '', '', '']), note('n1', ['second', '', '', ''])],
      cards: [card('c1', 'n1', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.notes.map((n) => [n.id, n.fields[0]])).toEqual([
      ['n1', 'first'],
      ['n1~2', 'second'],
    ]);
    expect(out.cards).toBe(state.cards); // the card belongs to the first note
    expect(repaired).toEqual(['note "n1~2": id "n1" → "n1~2"']);
  });

  it('two notes with one id and a card each: the second card joins the second note, with its progress', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1', ['first', '', '', '']), note('n1', ['second', '', '', ''])],
      cards: [card('c1', 'n1', 0, 'd1'), card('c2', 'n1', 0, 'd1', { reps: 9, intervalDays: 30 })],
    });
    const { state: out, repaired } = check(state);
    expect(out.notes.map((n) => n.id)).toEqual(['n1', 'n1~2']);
    expect(out.cards[0]).toBe(state.cards[0]);
    expect(out.cards[1]).toStrictEqual({ ...state.cards[1], noteId: 'n1~2' });
    expect(out.cards[1]).toMatchObject({ id: 'c2', reps: 9, intervalDays: 30 });
    expect(repaired).toEqual([
      'note "n1~2": id "n1" → "n1~2"',
      'card "c2": noteId "n1" → "n1~2" (note "n1" already has a card for direction 0; "n1~2" is the next note that had the id "n1")',
    ]);
  });

  it('three notes with one id: the cards fill the copies in order; a fourth card for the direction is removed', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1'), note('n1'), note('n1')],
      cards: [card('c1', 'n1', 0, 'd1'), card('c2', 'n1', 0, 'd1'), card('c3', 'n1', 0, 'd1'), card('c4', 'n1', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.cards.map((c) => [c.id, c.noteId])).toEqual([
      ['c1', 'n1'],
      ['c2', 'n1~2'],
      ['c3', 'n1~3'],
    ]);
    expect(repaired.at(-1)).toBe('card "c4": a second card for direction 0 of note "n1", removed');
  });

  it('a new id never takes the id of a later entry (its links stay right)', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1', ['first', '', '', '']), note('n1', ['second', '', '', '']), note('n1~2', ['third', '', '', ''])],
      cards: [card('c1', 'n1', 0, 'd1'), card('c2', 'n1', 0, 'd1'), card('c3', 'n1~2', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.notes.map((n) => [n.id, n.fields[0]])).toEqual([
      ['n1', 'first'],
      ['n1~3', 'second'],
      ['n1~2', 'third'],
    ]);
    // c3 still points at "n1~2", the note it was made for.
    expect(out.cards.map((c) => [c.id, c.noteId])).toEqual([
      ['c1', 'n1'],
      ['c2', 'n1~3'],
      ['c3', 'n1~2'],
    ]);
    expect(out.cards[2]).toBe(state.cards[2]);
    expect(repaired).toEqual([
      'note "n1~3": id "n1" → "n1~3"',
      'card "c2": noteId "n1" → "n1~3" (note "n1" already has a card for direction 0; "n1~3" is the next note that had the id "n1")',
    ]);
  });

  it('two cards with one id (different directions): the second gets a new id', () => {
    const state = v3State({
      decks: [deck('d1')],
      notes: [note('n1', ['a', 'b', '', ''], 'nt-basic-reverse'), note('n2')],
      cards: [card('c1', 'n1', 0, 'd1'), card('c1', 'n2', 0, 'd1')],
    });
    const { state: out, repaired } = check(state);
    expect(out.cards.map((c) => [c.id, c.noteId])).toEqual([
      ['c1', 'n1'],
      ['c1~2', 'n2'],
    ]);
    expect(repaired).toEqual(['card "c1": id "c1" → "c1~2"']);
  });

  it('entries that are not objects are removed; a list that is not a list is read as empty', () => {
    const state = {
      ...intact(),
      notes: [...intact().notes, null],
      cards: [...intact().cards, 7],
      noteTypes: 'oops',
    } as unknown as DataStateV3;
    const { state: out, repaired } = check(state);
    expect(out.notes).toHaveLength(3);
    expect(out.cards).toHaveLength(3);
    expect(out.noteTypes.map((t) => t.id)).toEqual(['nt-basic', 'nt-basic-reverse']);
    expect(repaired).toEqual([
      'noteTypes: "oops" is not a list, read as empty',
      'note #3: null is not a note, removed',
      'card #3: 7 is not a card, removed',
      'card type "nt-basic": missing, the built-in "Basic" was added again',
      'card type "nt-basic-reverse": missing, the built-in "Basic + reverse" was added again',
    ]);
  });

  it('a deck that is not an object is removed and listed', () => {
    const state = { ...intact(), decks: [deck('d1', 0), null, deck('d2', 1)] } as unknown as DataStateV3;
    const { state: out, repaired } = check(state);
    expect(out.decks.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(out.decks[0]).toBe(state.decks[0]);
    expect(out.cards).toBe(state.cards);
    expect(repaired).toEqual(['deck #1: null is not a deck, removed']);
  });

  it('two decks with one id: the cards stay in the first; the second is kept, empty, under a new id', () => {
    const first = deck('d1', 0);
    const second = { ...deck('d1', 1), name: 'Second deck' };
    const state = v3State({ decks: [first, second], notes: [note('n1')], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    expect(out.decks[0]).toBe(first);
    expect(out.decks[1]).toStrictEqual({ ...second, id: 'd1~2' });
    expect(out.cards).toBe(state.cards);
    expect(repaired).toEqual(['deck "d1": a second deck with this id, its id → "d1~2" (the cards stay in the first deck)']);
  });

  it('a deck with no usable id gets "deck-repaired-<index>"', () => {
    const broken = { ...deck('x', 1), id: '' };
    const state = { ...intact(), decks: [deck('d1', 0), broken, deck('d2', 2)] };
    const { state: out, repaired } = check(state);
    expect(out.decks.map((d) => d.id)).toEqual(['d1', 'deck-repaired-1', 'd2']);
    expect(repaired).toEqual(['deck #1: id "" → "deck-repaired-1"']);
  });

  it('the note shape the checks read: texts, tags, section and guid', () => {
    const broken = {
      ...note('n1'),
      fields: ['Hund', null, 42, 'x'],
      tags: ['ok', 3],
      section: null,
      guid: '',
    } as unknown as Note;
    const state = v3State({ decks: [deck('d1')], notes: [broken], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    // W3-1: a tag that is not a text KEEPS what it holds (3 → '3'); it used to be dropped.
    expect(out.notes[0]).toMatchObject({ fields: ['Hund', '', '42', 'x'], tags: ['ok', '3'], section: '', guid: 'm-n1' });
    expect(repaired).toEqual([
      'note "n1": field values that were not texts became texts',
      'note "n1": tags ["ok",3] → ["ok","3"]',
      'note "n1": section null → ""',
      'note "n1": guid "" → "m-n1"',
    ]);
  });

  it('tags that are not a list of texts keep every word: one Anki text is split, lists and objects give their items', () => {
    const notes = [
      { ...note('n1'), tags: 'verb  A1 ' }, // Anki stores the tags of a note as one text
      { ...note('n2'), tags: ['a', ['b', 7], null, { x: 'c' }, true, ''] },
      { ...note('n3'), tags: 12 },
      { ...note('n4'), tags: { first: 'German::Verbs', second: ['B1'] } },
      { ...note('n5'), tags: null },
      { ...note('n6'), tags: undefined },
    ] as unknown as Note[];
    const state = v3State({ decks: [deck('d1')], notes, cards: notes.map((n, i) => card(`c${i + 1}`, n.id, 0, 'd1')) });
    const { state: out, repaired } = check(state);
    expect(out.notes.map((n) => n.tags)).toEqual([
      ['verb', 'A1'],
      ['a', 'b', '7', 'c', 'true'],
      ['12'],
      ['German::Verbs', 'B1'],
      [],
      [],
    ]);
    expect(repaired).toEqual([
      'note "n1": tags "verb  A1 " → ["verb","A1"]',
      'note "n2": tags ["a",["b",7],null,{"x":"c"},true,""] → ["a","b","7","c","true"]',
      'note "n3": tags 12 → ["12"]',
      'note "n4": tags {"first":"German::Verbs","second":["B1"]} → ["German::Verbs","B1"]',
      'note "n5": tags null → []',
      'note "n6": tags missing → []',
    ]);
    // A list of texts is not damage: an empty text in it is kept as it is.
    const intactTags = v3State({ decks: [deck('d1')], notes: [{ ...note('n1'), tags: ['a', ''] }], cards: [card('c1', 'n1', 0, 'd1')] });
    expect(checkIntegrity(intactTags, LATER).repaired).toEqual([]);
  });

  it('a section that is not a text keeps what it holds: path levels are joined with "::"', () => {
    const notes = [
      { ...note('n1'), section: ['Verbs', 'B1'] },
      { ...note('n2'), section: 12 },
      { ...note('n3'), section: { a: 'Nouns', b: ['A1', ''] } },
      { ...note('n4'), section: undefined },
      { ...note('n5'), section: false },
    ] as unknown as Note[];
    const state = v3State({ decks: [deck('d1')], notes, cards: notes.map((n, i) => card(`c${i + 1}`, n.id, 0, 'd1')) });
    const { state: out, repaired } = check(state);
    expect(out.notes.map((n) => n.section)).toEqual(['Verbs::B1', '12', 'Nouns::A1', '', 'false']);
    expect(repaired).toEqual([
      'note "n1": section ["Verbs","B1"] → "Verbs::B1"',
      'note "n2": section 12 → "12"',
      'note "n3": section {"a":"Nouns","b":["A1",""]} → "Nouns::A1"',
      'note "n4": section missing → ""',
      'note "n5": section false → "false"',
    ]);
  });

  it('a card whose direction is not a whole number gets the lowest direction its note does not use (it keeps its progress)', () => {
    const progress = { reps: 4, intervalDays: 6, stepIndex: null, due: NOW + 3 * 86_400_000 };
    const cards = [
      { ...card('c-bad', 'n2', 0, 'd1', progress), ord: null },
      card('c2a', 'n2', 0, 'd1'),
      { ...card('c-frac', 'n2', 0, 'd1'), ord: 1.5 },
      { ...card('c-text', 'n1', 0, 'd1'), ord: 'x' },
    ] as unknown as Card[];
    const notes = [note('n1'), note('n2', ['Hund', 'dog', '', ''], 'nt-basic-reverse')];
    const state = v3State({ decks: [deck('d1')], notes, cards });
    const { state: out, repaired } = check(state);
    // c2a keeps direction 0: a repaired card never takes the direction of a valid sibling.
    expect(out.cards.map((c) => [c.id, c.ord])).toEqual([
      ['c-bad', 1],
      ['c2a', 0],
      ['c-frac', 2],
      ['c-text', 0],
    ]);
    expect(out.cards[0]).toMatchObject(progress);
    expect(out.cards[1]).toBe(cards[1]);
    expect(repaired).toEqual([
      'card "c-bad": ord null → 1 (the lowest direction its item does not use)',
      'card "c-frac": ord 1.5 → 2 (the lowest direction its item does not use)',
      'card "c-text": ord "x" → 0 (the lowest direction its item does not use)',
    ]);
  });

  it('`fields` that is a text, not a list, keeps its text: "Hund" stays in field 0', () => {
    const broken = { ...note('n1'), fields: 'Hund' } as unknown as Note;
    const state = v3State({ decks: [deck('d1')], notes: [broken], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    expect(out.notes[0].fields).toEqual(['Hund', '', '', '']);
    expect(repaired).toEqual([
      'note "n1": fields "Hund" → ["Hund"]',
      'note "n1": 1 values for 4 fields, padded with empty values',
    ]);
  });

  it('`fields` that is not a list: an Anki field text is split, an object gives its values, a number its text', () => {
    const notes = [
      { ...note('n1'), fields: 'Hund\x1fdog\x1fDer Hund bellt.' }, // the Anki separator
      { ...note('n2'), fields: { Front: 'Katze', Back: 'cat', Extra: 3 } },
      { ...note('n3'), fields: 7 },
      { ...note('n4'), fields: null },
    ] as unknown as Note[];
    const state = v3State({
      decks: [deck('d1')],
      notes,
      cards: notes.map((n, i) => card(`c${i + 1}`, n.id, 0, 'd1')),
    });
    const { state: out, repaired } = check(state);
    expect(out.notes.map((n) => n.fields)).toEqual([
      ['Hund', 'dog', 'Der Hund bellt.', ''],
      ['Katze', 'cat', '3', ''],
      ['7', '', '', ''],
      ['', '', '', ''],
    ]);
    expect(repaired.filter((line) => line.includes(': fields '))).toEqual([
      'note "n1": fields "Hund\\u001fdog\\u001fDer Hund bellt." → ["Hund","dog","Der Hund bellt."]',
      'note "n2": fields {"Front":"Katze","Back":"cat","Extra":3} → ["Katze","cat","3"]',
      'note "n3": fields 7 → ["7"]',
      'note "n4": fields null → []',
    ]);
  });

  it('a field value that is an object keeps its words (as JSON), not "[object Object]"', () => {
    const broken = { ...note('n1'), fields: ['Hund', { text: 'dog' }, '', ''] } as unknown as Note;
    const state = v3State({ decks: [deck('d1')], notes: [broken], cards: [card('c1', 'n1', 0, 'd1')] });
    const { state: out, repaired } = check(state);
    expect(out.notes[0].fields).toEqual(['Hund', '{"text":"dog"}', '', '']);
    expect(repaired).toEqual(['note "n1": field values that were not texts became texts']);
  });
});

/* ------------------------------------------------- deck options */

describe('checkIntegrity — deck options the scheduler reads', () => {
  /** The intact library with deck d1's options replaced by `options` (forced: damaged data). */
  function withOptions(options: unknown): DataStateV3 {
    const state = intact();
    return { ...state, decks: [{ ...state.decks[0], options: options as Deck['options'] }, state.decks[1]] };
  }

  it('a directions entry that is not a list is removed: every direction of that card type is on again', () => {
    for (const damaged of [1, null, 'x', { 0: 1 }]) {
      const state = withOptions({ ...DEFAULT_DECK_OPTIONS, directions: { 'nt-basic-reverse': damaged, 'nt-basic': [0] } });
      const { state: out, repaired } = check(state);
      expect(out.decks[0].options).toStrictEqual({ ...DEFAULT_DECK_OPTIONS, directions: { 'nt-basic': [0] } });
      expect(out.decks[1]).toBe(state.decks[1]);
      expect(repaired).toEqual([
        `deck "d1": directions of "nt-basic-reverse" ${JSON.stringify(damaged)} removed (every direction of this card type is on)`,
      ]);
    }
  });

  it('a list with values that are not directions keeps only the directions; with none left, it is removed', () => {
    const state = withOptions({
      ...DEFAULT_DECK_OPTIONS,
      directions: { 'nt-basic-reverse': [0, 'x', -1, 1.5, 1], 'nt-basic': [null] },
    });
    const { state: out, repaired } = check(state);
    expect(out.decks[0].options.directions).toStrictEqual({ 'nt-basic-reverse': [0, 1] });
    expect(repaired).toEqual([
      'deck "d1": directions of "nt-basic-reverse" [0,"x",-1,1.5,1] → [0,1]',
      'deck "d1": directions of "nt-basic" [null] removed (every direction of this card type is on)',
    ]);
  });

  it('an empty list is kept: it means "every direction is off", which is not damage', () => {
    const state = withOptions({ ...DEFAULT_DECK_OPTIONS, directions: { 'nt-basic-reverse': [] } });
    const out = checkIntegrity(state, LATER);
    expect(out.repaired).toEqual([]);
    expect(out.state).toBe(state);
  });

  it('a directions map that is not an object is removed; options that are not an object get the defaults', () => {
    const noMap = check(withOptions({ ...DEFAULT_DECK_OPTIONS, directions: [0, 1] }));
    expect(noMap.state.decks[0].options).toStrictEqual({ ...DEFAULT_DECK_OPTIONS });
    expect(noMap.repaired).toEqual(['deck "d1": options.directions [0,1] removed (every direction is on)']);

    for (const damaged of [undefined, null, 'x']) {
      const { state: out, repaired } = check(withOptions(damaged));
      expect(out.decks[0].options).toStrictEqual({ ...DEFAULT_DECK_OPTIONS });
      expect(out.decks[0]).toMatchObject({ id: 'd1', name: 'Deck d1' }); // the rest of the deck is kept
      expect(repaired).toEqual([`deck "d1": options ${damaged === undefined ? 'missing' : JSON.stringify(damaged)} → the default options`]);
    }
  });
});

/* ------------------------------------------------- many problems at once */

describe('checkIntegrity — many problems at once', () => {
  it('one pass repairs everything, keeps every text, and never changes its input', () => {
    const input: DataStateV3 = v3State({
      noteTypes: [REVERSE],
      decks: [deck('d1'), deck('d2', 1)],
      notes: [
        note('n1', ['Hund', 'dog']), // nt-basic is missing, and 2 values for 4 fields
        note('n2', ['Katze', 'cat', '', ''], 'nt-basic-reverse'),
        note('n3', ['lonely', '', '', '']),
      ],
      cards: [
        card('c1', 'n1', 0, 'gone'),
        card('c2b', 'n2', 1, 'd2'),
        card('c2a', 'n2', 0, 'd1'),
        card('c2a-dup', 'n2', 0, 'd1'),
        card('c4', 'n4', 0, 'd1'),
      ],
    });
    const before = JSON.stringify(input);
    const { state: out, repaired } = check(input);
    expect(JSON.stringify(input)).toBe(before);

    expect(out.cards.map((c) => [c.id, c.deckId])).toEqual([
      ['c1', UNFILED_DECK_ID],
      ['c2b', 'd1'],
      ['c2a', 'd1'],
    ]);
    // Every note text is still there.
    expect(out.notes.map((n) => n.fields[0])).toEqual(['Hund', 'Katze', 'lonely']);
    expect(out.notes[0].fields).toEqual(['Hund', 'dog', '', '']);
    expect(repaired).toEqual([
      'card "c2a-dup": a second card for direction 0 of note "n2", removed',
      'card "c4": its note "n4" is missing, set aside',
      'card type "nt-basic": missing, the built-in "Basic" was added again',
      'note "n1": 2 values for 4 fields, padded with empty values',
      'card "c1": deckId "gone" → "unfiled" (its deck is missing)',
      'card "c2b": deckId "d2" → "d1" (all cards of one item stay in one deck)',
      'deck "unfiled": created for cards whose deck was missing',
    ]);
  });
});
