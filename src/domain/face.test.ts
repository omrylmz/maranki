/**
 * The read seam (spec §6.2, units W1-5 and W3-4):
 *   - `legacyFace` turns a card that carries its own text (the schema-2
 *     shape) into a CardFace;
 *   - `faceOfCard` / `facesFor` (and the store's useFaces, via faceFnOf)
 *     render a v3 card from its NOTE with renderFace, cached per note;
 *   - a GUARD keeps screens from reading card text directly, so the wave-3
 *     model swap only had to change the seam.
 *
 * Adapted in W3-4: the legacy cases build plain objects with the old text
 * keys (oldCard) instead of the schema-2 test factory, because from wave 3
 * the store's Card is the v3 card (it has no text keys).
 *
 * W3-4 review round 1: the two shared readers of a face, `speechOf` (what
 * the 🔊 button speaks, §6.8) and `faceSortKey` (the one A–Z key, §9.2).
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { faceFnOf } from '../store/faces';
import { ANKI_FIXTURES, ankiFixture } from '../test/factories';
import { cardInLifeV3, lifeValues, makeDeckV3, noteWithCards, stateOfV3 } from '../test/factoriesV3';
import { createRandom, type Random } from '../test/random';
import { BUILTIN_TYPE_IDS, builtinType } from './builtinTypes';
import {
  blockHasContent,
  blocksAfterHeadline,
  blockText,
  faceHeadline,
  faceOfCard,
  facesFor,
  faceSortKey,
  faceSortKeyOf,
  legacyFace,
  type LegacyTextCard,
  speechOf,
  textLines,
} from './face';
import { collectionFromRows } from './import/apkgRead';
import { collectionSections, type PlanLibrary, planImport } from './import/plan';
import { fieldFacetSpecs } from './libraryIndex';
import { makeNote } from './makeV3';
import type { Card, CardFace, FieldBlock, FieldDef, ImportChoices, NoteType } from './model';
import { detectOrdinal } from './ordinal';
import { renderFace, SPEAKER_PROMPT } from './render';
import { suggestMapping } from './roles';
import { decksById, libraryIndexOf } from './scope';
import { foldText, oneLine } from './text';

/** role:label:plain of each block — a compact view for assertions. */
const summary = (blocks: FieldBlock[]) => blocks.map((b) => `${b.role}:${b.label}:${b.plain}`);

/** A card in the schema-2 shape: its own text keys (and an id and a deck, like the real one). */
function oldCard(text: LegacyTextCard): LegacyTextCard & { id: string; deckId: string } {
  return { id: 'old', deckId: 'd', ...text };
}

describe('legacyFace — a full v2 card', () => {
  const card = oldCard({
    front: 'die Stunde',
    back: 'the hour',
    example: 'Eine Stunde hat 60 Minuten.',
    notes: '/ˈʃtʊndə/\nAn hour has 60 minutes.',
  });
  const face = legacyFace(card);

  it('prompt = [Front as term]', () => {
    expect(summary(face.prompt)).toEqual(['term:Front:die Stunde']);
    expect(face.prompt[0].field).toBe(0);
  });

  it('answer = [Back as meaning, Example, Notes]', () => {
    expect(summary(face.answer)).toEqual([
      'meaning:Back:the hour',
      'example:Example:Eine Stunde hat 60 Minuten.',
      'detail:Notes:/ˈʃtʊndə/ An hour has 60 minutes.',
    ]);
    expect(face.answer.map((b) => b.field)).toEqual([1, 2, 3]);
  });

  it('has no badges and one-line plain strings', () => {
    expect(face.badges).toEqual([]);
    expect(face.promptPlain).toBe('die Stunde');
    expect(face.answerPlain).toBe('the hour');
  });

  it('keeps line breaks in the lines, and joins them in plain', () => {
    const notes = face.answer[2];
    expect(notes.lines).toEqual([
      [{ t: 'text', text: '/ˈʃtʊndə/' }],
      [{ t: 'text', text: 'An hour has 60 minutes.' }],
    ]);
    expect(blockText(notes)).toBe('/ˈʃtʊndə/\nAn hour has 60 minutes.');
  });

  it('uses the roles, labels and template of the built-in Basic type (same look after wave 3)', () => {
    const basic = builtinType('basic', 0);
    const template = basic.templates[0];
    expect(face.prompt.map((b) => b.field)).toEqual(template.prompt);
    expect(face.answer.map((b) => b.field)).toEqual(template.answer);
    for (const block of [...face.prompt, ...face.answer]) {
      expect(block.role).toBe(basic.fields[block.field].role);
      expect(block.label).toBe(basic.fields[block.field].name);
    }
  });
});

describe('legacyFace — missing text', () => {
  it("missing example and notes → '' blocks that have no content", () => {
    const face = legacyFace(oldCard({ front: 'Haus', back: 'house' }));
    expect(face.answer).toHaveLength(3);
    expect(face.answer[1]).toMatchObject({ role: 'example', plain: '', lines: [] });
    expect(face.answer[2]).toMatchObject({ role: 'detail', plain: '', lines: [] });
    expect(face.answer.map(blockHasContent)).toEqual([true, false, false]);
    // So the screens draw only the headline on the back.
    expect(blocksAfterHeadline(face.answer)).toEqual([]);
  });

  it('blocksAfterHeadline keeps the filled blocks after the headline, in order', () => {
    const notesOnly = legacyFace(oldCard({ front: 'a', back: 'b', notes: 'n' }));
    expect(summary(blocksAfterHeadline(notesOnly.answer))).toEqual(['detail:Notes:n']);
    const both = legacyFace(oldCard({ front: 'a', back: 'b', example: 'e', notes: 'n' }));
    expect(summary(blocksAfterHeadline(both.answer))).toEqual(['example:Example:e', 'detail:Notes:n']);
    expect(blocksAfterHeadline(both.prompt)).toEqual([]);
  });

  it("blocksAfterHeadline never shows a 'hidden' block", () => {
    const hidden: FieldBlock = {
      field: 7,
      label: 'Article',
      role: 'hidden',
      lines: textLines('die'),
      plain: 'die',
    };
    const head = legacyFace(oldCard({ front: 'a', back: 'b' })).answer[0];
    expect(blocksAfterHeadline([head, hidden])).toEqual([]);
  });

  it("a card without front/back (a v0 card loaded before migration) → '' and no crash", () => {
    const v0Shaped = { id: 'old', word: 'die Stunde', tr: 'the hour' };
    const face = legacyFace(v0Shaped);
    expect(face.promptPlain).toBe('');
    expect(face.answerPlain).toBe('');
    expect(face.prompt[0].lines).toEqual([]);
    expect(blockText(face.prompt[0])).toBe('');
  });

  it('a damaged non-string value becomes text, never undefined', () => {
    const damaged = { front: 42, back: null };
    const face = legacyFace(damaged);
    expect(face.promptPlain).toBe('42');
    expect(face.answerPlain).toBe('');
  });
});

describe('legacyFace — cache', () => {
  it('the same card object returns the same face object', () => {
    const card = oldCard({ front: 'a', back: 'b' });
    expect(legacyFace(card)).toBe(legacyFace(card));
  });

  it('an edited card (a new object, as the store makes it) gets a new face', () => {
    const card = oldCard({ front: 'a', back: 'b' });
    const before = legacyFace(card);
    const edited = { ...card, back: 'B' };
    expect(legacyFace(edited)).not.toBe(before);
    expect(legacyFace(edited).answerPlain).toBe('B');
    expect(legacyFace(card).answerPlain).toBe('b');
  });
});

describe('textLines / blockText / blockHasContent', () => {
  it('splits on every kind of line break and keeps empty lines', () => {
    expect(textLines('a\r\nb\rc\n\nd')).toEqual([
      [{ t: 'text', text: 'a' }],
      [{ t: 'text', text: 'b' }],
      [{ t: 'text', text: 'c' }],
      [],
      [{ t: 'text', text: 'd' }],
    ]);
    expect(textLines('')).toEqual([]);
  });

  it('blockText of no block is empty', () => {
    expect(blockText(undefined)).toBe('');
  });

  it('white space only is not content; an image is', () => {
    const block = (lines: FieldBlock['lines']): FieldBlock => ({
      field: 0,
      label: 'X',
      role: 'detail',
      lines,
      plain: '',
    });
    expect(blockHasContent(block([[{ t: 'text', text: '   ' }]]))).toBe(false);
    expect(blockHasContent(block([[{ t: 'img', src: 'a.png' }]]))).toBe(true);
    expect(blockText(block([[{ t: 'text', text: 'x' }, { t: 'img', src: 'a.png' }]]))).toBe('x');
  });
});

/* ------------------------------------------------------- faces from notes (W3-4) */

describe('faces from notes: faceOfCard, facesFor and the store seam (W3-4)', () => {
  const deck = makeDeckV3({ id: 'de', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' });
  const both = noteWithCards({
    deckId: 'de',
    typeId: BUILTIN_TYPE_IDS.basicReverse,
    fields: ['die Stunde', 'the hour', 'Eine Stunde hat 60 Minuten.', ''],
    note: { id: 'n-stunde' },
    card: (ord) => ({ id: `stunde-${ord}`, ...lifeValues('new') }),
  });
  const state = stateOfV3({ decks: [deck], groups: [both] });
  const index = libraryIndexOf(state);
  const decks = decksById(state.decks);
  const [forward, reverse] = both.cards;

  it('renders a card from its note, direction and deck: the same face as renderFace', () => {
    const type = index.typeById.get(BUILTIN_TYPE_IDS.basicReverse)!;
    const face = faceOfCard(forward, index, decks);
    expect(face).toBe(renderFace(both.note, type, 0, deck)); // the cached face of the note
    expect(face.promptPlain).toBe('die Stunde');
    expect(face.prompt[0].lang).toBe('de-DE'); // the deck's language (a type made in the app)
    expect(summary(face.answer)).toEqual(['meaning:Back:the hour', 'example:Example:Eine Stunde hat 60 Minuten.']);
    const back = faceOfCard(reverse, index, decks);
    expect(back.promptPlain).toBe('the hour');
    expect(back.prompt[0].lang).toBe('en-US');
  });

  it('siblings share one cached note: the same FieldBlock objects, so they can never disagree', () => {
    const f = faceOfCard(forward, index, decks);
    const r = faceOfCard(reverse, index, decks);
    expect(r.answer[0]).toBe(f.prompt[0]); // "die Stunde" is one block for both directions
    expect(faceOfCard(forward, index, decks)).toBe(f); // asking again is free (WeakMap per note)
  });

  it('an edited note (a new object) gets a new face; a rating (a new card) keeps the note face', () => {
    const before = faceOfCard(forward, index, decks);
    const rated = { ...forward, reps: 1, stepIndex: 0 };
    expect(faceOfCard(rated, index, decks)).toBe(before);
    const edited = { ...both.note, fields: ['die Stunden', 'the hours', '', ''] };
    const after = libraryIndexOf({ notes: [edited], noteTypes: state.noteTypes });
    expect(faceOfCard(forward, after, decks)).not.toBe(before);
    expect(faceOfCard(forward, after, decks).promptPlain).toBe('die Stunden');
  });

  it('a card without a note in the library falls back to its own text (empty for a v3 card), never a crash', () => {
    const orphan = { ...forward, noteId: 'gone' };
    expect(faceOfCard(orphan, index, decks).promptPlain).toBe('');
    expect(faceOfCard(oldCard({ front: 'alt', back: 'old' }), index, decks).promptPlain).toBe('alt');
    expect(faceOfCard(forward, null).promptPlain).toBe('');
    // A note whose card type is missing → the fallback too.
    const noTypes = libraryIndexOf({ notes: state.notes, noteTypes: [] });
    expect(faceOfCard(forward, noTypes, decks).promptPlain).toBe('');
  });

  it('facesFor: one function per (library, decks), so it is safe in React dependency lists', () => {
    const fn = facesFor(index, decks);
    expect(facesFor(index, decks)).toBe(fn);
    expect(facesFor(index)).not.toBe(fn);
    expect(fn(forward)).toBe(faceOfCard(forward, index, decks));
  });

  it("the store seam (useFaces' selector) renders from the state's notes, and is stable per notes/types/decks", () => {
    const fn = faceFnOf(state);
    expect(fn(forward).promptPlain).toBe('die Stunde');
    expect(fn(reverse).promptPlain).toBe('the hour');
    // A rating changes only `cards`: the same function (and the same faces) come back.
    const rated = { ...state, cards: state.cards.map((c) => ({ ...c, reps: c.reps + 1 })) };
    expect(faceFnOf(rated)).toBe(fn);
    // New notes → a new function.
    expect(faceFnOf({ ...state, notes: [...state.notes] })).not.toBe(fn);
  });

  it('a state without notes (damaged data) still draws: every card falls back to its own text', () => {
    const damaged = { notes: undefined, noteTypes: undefined, decks: [] } as unknown as Parameters<typeof faceFnOf>[0];
    expect(faceFnOf(damaged)(oldCard({ front: 'x', back: 'y' })).promptPlain).toBe('x');
  });
});

/* ------------------------------------------- speechOf and faceSortKey (W3-4) */

/** "Listen, then type the word" (Anki qfmt '{{tts de_DE:Word}}{{type:Word}}'): the question asks no field. */
const DICTATION: NoteType = {
  id: 'nt-dictation',
  name: 'Dictation',
  kind: 'standard',
  fields: [
    { name: 'Word', role: 'term', lang: 'de-DE', facet: 'off' },
    { name: 'Meaning', role: 'meaning', facet: 'off' },
  ],
  templates: [{ ord: 0, name: 'Dictation', prompt: [], answer: [0, 1], typeField: 0 }],
  sortField: 0,
  source: { ankiMid: '42' },
  createdAt: 0,
  updatedAt: 0,
};
const dictationFace = renderFace(
  makeNote({ id: 'n-dict', typeId: DICTATION.id, fields: ['die Stunde', 'the hour'] }, 0),
  DICTATION,
  0,
);

describe('speechOf — what the 🔊 button speaks (spec §6.8: the headline of the visible side)', () => {
  it('a dictation question speaks the hidden word in its language, never the speaker sign it shows', () => {
    expect(blockText(dictationFace.prompt[0])).toBe(SPEAKER_PROMPT); // the card SHOWS only the speaker
    expect(dictationFace.promptPlain).toBe(SPEAKER_PROMPT);
    expect(speechOf(dictationFace, 'prompt')).toEqual({ text: 'die Stunde', lang: 'de-DE' });
    // Revealed: the headline of the answer side is the Word field, with the same voice.
    expect(speechOf(dictationFace, 'answer')).toEqual({ text: 'die Stunde', lang: 'de-DE' });
  });

  it('a note card speaks the headline of each side with its language (the deck languages for an app type)', () => {
    const deck = makeDeckV3({ id: 'de', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' });
    const pair = noteWithCards({
      deckId: 'de',
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      fields: ['die Stunde', 'the hour', 'Eine Stunde hat 60 Minuten.', ''],
      note: { id: 'n-speak' },
      card: (ord) => ({ id: `speak-${ord}`, ...lifeValues('new') }),
    });
    const state = stateOfV3({ decks: [deck], groups: [pair] });
    const faceOf = facesFor(libraryIndexOf(state), decksById(state.decks));
    const [forward, reverse] = pair.cards.map(faceOf);
    expect(speechOf(forward, 'prompt')).toEqual({ text: 'die Stunde', lang: 'de-DE' });
    expect(speechOf(forward, 'answer')).toEqual({ text: 'the hour', lang: 'en-US' }); // the headline only, not the example
    expect(speechOf(reverse, 'prompt')).toEqual({ text: 'the hour', lang: 'en-US' });
    expect(speechOf(reverse, 'answer')).toEqual({ text: 'die Stunde', lang: 'de-DE' });
  });

  it('a legacy card speaks its front and its back, with no language (the device voice)', () => {
    const face = legacyFace(oldCard({ front: 'die Stunde', back: 'the hour', example: 'Eine Stunde.' }));
    expect(speechOf(face, 'prompt')).toEqual({ text: 'die Stunde' });
    expect(speechOf(face, 'answer')).toEqual({ text: 'the hour' });
  });

  it('a cloze card speaks the headline: the text with the gap, then the whole revealed text', () => {
    const cloze = builtinType('cloze', 0);
    const note = makeNote({ id: 'n-cloze-speak', typeId: cloze.id, fields: ['{{c1::Paris}} is the capital.', ''] }, 0);
    const face = renderFace(note, cloze, 0);
    expect(speechOf(face, 'prompt').text).toBe('[…] is the capital.');
    expect(speechOf(face, 'answer').text).toBe('Paris is the capital.');
  });

  it('a side with no block speaks its one-line text (here: nothing)', () => {
    const empty: CardFace = { promptPlain: '', answerPlain: '', badges: [], prompt: [], answer: [] };
    expect(speechOf(empty, 'prompt')).toEqual({ text: '' });
    expect(speechOf(empty, 'answer')).toEqual({ text: '' });
  });
});

describe('faceSortKey — the one A–Z key (spec §9.2)', () => {
  it('a dictation card sorts by the word it reads aloud, German by the word (not "🔊", not the article)', () => {
    expect(faceSortKey(dictationFace)).toBe('stunde');
  });

  it('a German term sorts by the word; other text (and a term without a language) is only folded', () => {
    const basic = builtinType('basicReverse', 0);
    const note = makeNote({ id: 'n-sort', typeId: basic.id, fields: ['die Abfahrt', 'The Départure', '', ''] }, 0);
    const deck = { language: 'de-DE', meaningLanguage: 'en-US' };
    expect(faceSortKey(renderFace(note, basic, 0, deck))).toBe('abfahrt'); // term, German
    expect(faceSortKey(renderFace(note, basic, 1, deck))).toBe('the departure'); // meaning: folded only
    expect(faceSortKey(renderFace(note, basic, 0))).toBe('die abfahrt'); // no language: folded only
    expect(faceSortKey(legacyFace(oldCard({ front: 'Über' })))).toBe('uber');
  });
});

/* ------------------------------------------------ faceHeadline (unit P1) */

/** Every Anki fixture, imported with the real pipeline (roles.ts guesses, plan.ts), one deck each. */
function importedFixtures(): { index: ReturnType<typeof libraryIndexOf>; decks: ReturnType<typeof decksById>; cards: Card[] } {
  let lib: PlanLibrary = { noteTypes: [], notes: [], cards: [], decks: [] };
  let n = 0;
  for (const name of ANKI_FIXTURES) {
    const fx = ankiFixture(name);
    const collection = collectionFromRows({ fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media });
    // No prototype: model ids come from the file.
    const types = Object.create(null) as ImportChoices['types'];
    for (const t of suggestMapping(collection).types) types[t.mid] = { fields: t.fields, ords: t.ords, templates: t.templates };
    const plan = planImport(
      collection,
      lib,
      {
        sections: new Set(collectionSections(collection).map((s) => s.did)),
        target: { kind: 'new', name, icon: '' },
        types,
        progress: 'keep',
        arrival: 'queued',
        elsewhere: 'update',
        images: true,
      },
      {
        now: 0,
        newId: () => `${name}-${++n}`,
        srs: { startingEase: 2.5, maxIntervalDays: 36500 },
        fieldFacetSpecs,
        detectOrdinal,
      },
    );
    lib = {
      noteTypes: [...lib.noteTypes, ...plan.noteTypes.add],
      notes: [...lib.notes, ...plan.notes.add],
      cards: [...lib.cards, ...plan.cards.add],
      decks: plan.deck ? [...lib.decks, plan.deck] : lib.decks,
    };
  }
  return { index: libraryIndexOf({ notes: [...lib.notes], noteTypes: [...lib.noteTypes] }), decks: decksById(lib.decks), cards: [...lib.cards] };
}

/** faceHeadline(card) has exactly the values the whole face gives. */
function expectSameHeadline(card: Card, index: Parameters<typeof faceOfCard>[1], decks: ReturnType<typeof decksById>): void {
  const face = faceOfCard(card, index, decks);
  const head = faceHeadline(card, index, decks);
  const plain = face.prompt[0]?.plain ?? face.promptPlain;
  expect([card.id, head]).toEqual([card.id, { plain, plainFolded: foldText(oneLine(plain)), sortKey: faceSortKey(face) }]);
  expect(faceSortKeyOf(card, index, decks)).toBe(head.sortKey);
}

/** Field texts that test every rule of the question side: empty, dashes, HTML, images, sounds, entities, cloze. */
const HEAD_TEXTS = [
  '',
  '   ',
  '-',
  ' – ',
  '—',
  '-n',
  'die Abfahrt',
  'der/die Angestellte',
  'das Internet (Sg.)',
  'die Leute (Pl.)',
  '<b>die</b> Stunde',
  '<div>Ein Satz.</div><div>Noch einer.</div>',
  '<img src="cat.png">',
  '<img src="cat.png"> -',
  '[sound:word.mp3]',
  '[sound:word.mp3]Haus',
  '&nbsp;',
  '&amp; mehr',
  'Über',
  '{{c1::Paris}} is the capital of {{c2::France::country}}.',
  '{{c1::ich}} {{c1::bin}}',
  'no cloze here',
  '<br>',
  'line one<br>line two',
];

/** A random card type with every shape the question side can have (also damaged ones). */
function randomHeadType(rnd: Random, i: number): NoteType {
  const roles: FieldDef['role'][] = ['term', 'meaning', 'example', 'exampleMeaning', 'pronunciation', 'detail', 'badge', 'hidden'];
  const count = rnd.int(1, 5);
  const fields: FieldDef[] = Array.from({ length: count }, (_, f) => ({
    name: `F${f}`,
    role: rnd.pick(roles),
    facet: 'off',
    ...(rnd.bool(0.4) ? { lang: rnd.pick(['de-DE', 'de_DE', 'en-US', 'German', 'fr']) } : {}),
  }));
  const kind = rnd.bool(0.2) ? 'cloze' : 'standard';
  // Question lists with repeats, fields that do not exist, and sometimes none (a dictation card).
  const index = () => rnd.int(-1, count);
  const templates =
    rnd.bool(0.05)
      ? []
      : Array.from({ length: rnd.int(1, 3) }, (_, ord) => ({
          ord,
          name: `T${ord}`,
          prompt: rnd.bool(0.15) ? [] : Array.from({ length: rnd.int(1, 3) }, index),
          answer: Array.from({ length: rnd.int(0, 2) }, index),
          ...(rnd.bool(0.3) ? { typeField: index() } : {}),
        }));
  return {
    id: `nt-head-${i}`,
    name: `Head ${i}`,
    kind,
    fields,
    templates,
    sortField: rnd.int(-1, count),
    ...(rnd.bool(0.5) ? { source: { ankiMid: `m${i}` } } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('unit P1 — faceHeadline: the headline without the whole face, the SAME values', () => {
  it('every card of every Anki fixture (imported with the real pipeline)', () => {
    const { index, decks, cards } = importedFixtures();
    expect(cards.length).toBeGreaterThan(150);
    for (const card of cards) expectSameHeadline(card, index, decks);
  });

  it('600 random notes: every field text, role, language, template shape, cloze and deck language', () => {
    const rnd = createRandom('face-headline');
    const decks = [
      makeDeckV3({ id: 'd-none', name: 'No languages' }),
      makeDeckV3({ id: 'd-de', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' }),
      makeDeckV3({ id: 'd-en', name: 'English', language: 'en-US', meaningLanguage: 'de-DE' }),
    ];
    const types = Array.from({ length: 40 }, (_, i) => randomHeadType(rnd, i));
    const notes = [];
    const cards: Card[] = [];
    for (let i = 0; i < 600; i++) {
      const type = rnd.pick(types);
      const note = makeNote(
        { id: `n${i}`, typeId: type.id, fields: type.fields.map(() => rnd.pick(HEAD_TEXTS)) },
        0,
      );
      notes.push(note);
      for (const ord of rnd.sample([0, 1, 2, 3], rnd.int(1, 3))) {
        cards.push({ ...cardInLifeV3('new'), id: `c${i}-${ord}`, noteId: note.id, ord, deckId: rnd.pick(decks).id });
      }
    }
    const state = stateOfV3({ decks, groups: [] });
    const index = libraryIndexOf({ notes, noteTypes: types });
    const byId = decksById(state.decks);
    for (const card of cards) expectSameHeadline(card, index, byId);
    // Damaged numbers in a note's fields become text, like renderFace does.
    const damaged = makeNote({ id: 'n-num', typeId: types[0].id, fields: types[0].fields.map(() => '') }, 0);
    (damaged.fields as unknown[])[0] = 42;
    const index2 = libraryIndexOf({ notes: [damaged], noteTypes: types });
    expectSameHeadline({ ...cardInLifeV3('new'), id: 'c-num', noteId: 'n-num', ord: 0, deckId: 'd-de' }, index2, byId);
  });

  it('a dictation card: the word it reads aloud, never the speaker; German sorts by the word', () => {
    const note = makeNote({ id: 'n-dict', typeId: DICTATION.id, fields: ['die Stunde', 'the hour'] }, 0);
    const index = libraryIndexOf({ notes: [note], noteTypes: [DICTATION] });
    const card = { ...cardInLifeV3('new'), id: 'c-dict', noteId: 'n-dict', ord: 0, deckId: 'd' };
    expect(faceHeadline(card, index, null)).toEqual({ plain: 'die Stunde', plainFolded: 'die stunde', sortKey: 'stunde' });
    expectSameHeadline(card, index, decksById([]));
  });

  it('cached per note: the same object again; an edited note, another card type or other deck languages give new values', () => {
    const basic = builtinType('basicReverse', 0);
    const note = makeNote({ id: 'n-c', typeId: basic.id, fields: ['die Abfahrt', 'the departure', '', ''] }, 0);
    const de = makeDeckV3({ id: 'd', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' });
    const index = libraryIndexOf({ notes: [note], noteTypes: [basic] });
    const card = { ...cardInLifeV3('new'), id: 'c', noteId: 'n-c', ord: 0, deckId: 'd' };
    const first = faceHeadline(card, index, decksById([de]));
    expect(first.sortKey).toBe('abfahrt');
    const rated: Card = { ...card, reps: 3 };
    expect(faceHeadline(rated, index, decksById([de]))).toBe(first); // a rating: a new card, the same note
    // An edited note is a new object.
    const edited = { ...note, fields: ['die Zeit', 'the time', '', ''] };
    expect(faceHeadline(card, libraryIndexOf({ notes: [edited], noteTypes: [basic] }), decksById([de])).sortKey).toBe('zeit');
    // Other deck languages (a card type made in the app reads them): English now, so only folded.
    const en = { ...de, language: 'en-US' };
    expect(faceHeadline(card, index, decksById([en])).sortKey).toBe('die abfahrt');
    // Another card type object with the same id (an edited card type).
    const renamed = { ...basic, fields: basic.fields.map((f, i) => (i === 0 ? { ...f, role: 'detail' as const } : f)) };
    expect(faceHeadline(card, libraryIndexOf({ notes: [note], noteTypes: [renamed] }), decksById([de])).sortKey).toBe('die abfahrt');
    // Back to the first: the values are right again.
    expect(faceHeadline(card, index, decksById([de])).sortKey).toBe('abfahrt');
  });

  it('a card without a note in the library: its own text (legacyFace), exactly like faceOfCard', () => {
    const index = libraryIndexOf({ notes: [], noteTypes: [] });
    const legacy = { ...oldCard({ front: 'Über', back: 'over' }), noteId: 'gone', ord: 0 };
    expect(faceHeadline(legacy, index, null)).toEqual({ plain: 'Über', plainFolded: 'uber', sortKey: 'uber' });
    expect(faceHeadline(legacy, index, null)).toBe(faceHeadline(legacy, index, null));
    expect(faceHeadline(oldCard({}), null).sortKey).toBe('');
    expectSameHeadline({ ...cardInLifeV3('new'), id: 'c-gone', noteId: 'gone', ord: 0, deckId: 'd' }, index, decksById([]));
  });
});

/* --------------------------------------------------------------------- guard */

/**
 * A direct read of card text: `.front`, `.back`, `.example` or `.notes` as a
 * property. A method CALL is not a read of card text, so `router.back()` is
 * allowed (the `(?!\s*\()` part).
 */
const DIRECT_READ = /\.(front|back|example|notes)\b(?!\s*\()/;

/** Folders whose files must go through useFaces() (spec W1-5). */
const GUARDED_DIRS = ['src/app', 'src/components'];

/** Rewritten in wave 3 (they write card text, not only read it). */
const ALLOWED = new Set(['src/app/card-editor.tsx', 'src/app/deck-editor.tsx', 'src/app/import.tsx']);

const REPO = path.resolve(__dirname, '..', '..');

/** Every .ts/.tsx file under `dir` (repo-relative paths with '/'). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('guard: screens read card text only through useFaces()', () => {
  it('the pattern catches property reads and allows method calls', () => {
    for (const read of ['card.front', 'item.back}', 'card?.example ?', 'x.notes)', 'c.back.length']) {
      expect(DIRECT_READ.test(read)).toBe(true);
    }
    for (const ok of ['router.back()', 'navigation.back ()', 'card.frontier', 'face.promptPlain']) {
      expect(DIRECT_READ.test(ok)).toBe(false);
    }
  });

  it('no file in src/app or src/components reads .front/.back/.example/.notes (except the wave-3 editors)', () => {
    const files = GUARDED_DIRS.flatMap(sourceFiles).filter((f) => !ALLOWED.has(f));
    expect(files.length).toBeGreaterThan(10); // the scan really found the screens
    const hits: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (DIRECT_READ.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  // W3-4 review round 1: a dictation question SHOWS only '🔊' (promptPlain is
  // '🔊'), so a screen that speaks promptPlain makes the phone read the emoji's
  // name. Spec §6.8: 🔊 speaks the headline block of the visible side = speechOf.
  it('a screen that reads aloud speaks speechOf(face, side), never promptPlain / answerPlain', () => {
    const files = GUARDED_DIRS.flatMap(sourceFiles);
    const speaking: string[] = [];
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      if (!/\bspeak\s*\(/.test(text)) continue;
      speaking.push(file);
      if (!text.includes('speechOf(')) hits.push(`${file}: speaks without speechOf`);
      text.split('\n').forEach((line, i) => {
        if (/\bspeak\s*\([^;]*\b(promptPlain|answerPlain)\b/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(speaking).toContain('src/app/session.tsx'); // the scan really found the session's speaker
    expect(hits).toEqual([]);
  });
});
