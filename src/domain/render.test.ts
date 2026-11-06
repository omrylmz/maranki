/**
 * Card faces from notes (spec §6.2, unit W2-3): renderFace on the fixture notes
 * of all five Anki fixtures, the sibling cache, cloze, and the read-aloud
 * language rule of §6.8. Wave 5b (walkthrough): the display label of a field
 * (L3 / R6: never the raw "MarankiExample") and placeholder dashes (L4: a
 * field that is only "–" is empty on both sides).
 */
import { describe, expect, it } from '@jest/globals';

import { ANKI_FIXTURES, type AnkiFixtureName, ankiFixture } from '../test/factories';
import { builtinType } from './builtinTypes';
import { blockText, faceSortKey, legacyFace, speechOf } from './face';
import { makeNote } from './makeV3';
import type { AnkiCollection, CardFace, FieldBlock, Note, NoteType } from './model';
import {
  APP_FIELD_PREFIXES,
  clozeAnswers,
  clozeNumbers,
  clozeSide,
  fieldDisplayLabel,
  fieldShownOnCard,
  hasCloze,
  humanizeFieldName,
  isDashOnly,
  isSpeakerBlock,
  renderFace,
  resolveFieldLang,
  SPEAKER_PROMPT,
} from './render';
import { suggestMapping } from './roles';

/* ------------------------------------------------------------- helpers */

/** The CPU time this process has used, in ms (the wall clock where `process.cpuUsage` is missing). */
function cpuMs(): number {
  if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
  }
  return Date.now();
}

/** One run: the CPU time of one call of `fn` in ms, the call repeated for at least 10 ms. */
function runMs(fn: () => void): number {
  let calls = 0;
  let elapsed = 0;
  const start = cpuMs();
  do {
    fn();
    calls += 1;
    elapsed = cpuMs() - start;
  } while (elapsed < 10);
  return elapsed / calls;
}

/**
 * How `fn` scales from `small` to `big` (4 × the size), robust on a busy
 * machine (W4-7): CPU time, not the wall clock; the two sizes measured in
 * turns (big, small, big, small …), the fastest of 5 runs per size; up to 3
 * tries. Returns the time on `big` in ms and how many times longer it is.
 */
function scaling(fn: (input: string) => unknown, small: string, big: string): { growth: number; bigMs: number } {
  fn(small); // warm up
  fn(big);
  let best = { growth: Number.POSITIVE_INFINITY, bigMs: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < 3 && best.growth >= 10; attempt++) {
    let bigMs = Number.POSITIVE_INFINITY;
    let smallMs = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn < 5; turn++) {
      bigMs = Math.min(bigMs, runMs(() => fn(big)));
      smallMs = Math.min(smallMs, runMs(() => fn(small)));
    }
    if (bigMs / smallMs < best.growth) best = { growth: bigMs / smallMs, bigMs };
  }
  return best;
}

type RawModels = Record<
  string,
  {
    name: string;
    type: number;
    sortf: number;
    flds: { name: string; ord: number }[];
    tmpls: { name: string; ord: number; qfmt: string; afmt: string }[];
  }
>;

/** A fixture as an AnkiCollection (only what suggestMapping reads). */
function fixtureCollection(name: AnkiFixtureName): AnkiCollection {
  const fx = ankiFixture(name);
  const raw = JSON.parse(fx.col.models) as RawModels;
  const models: AnkiCollection['models'] = {};
  for (const [mid, m] of Object.entries(raw)) {
    models[mid] = { name: m.name, type: m.type === 1 ? 1 : 0, sortf: m.sortf, flds: m.flds, tmpls: m.tmpls };
  }
  return {
    fileName: fx.fileName,
    crt: fx.col.crt,
    models,
    decks: {},
    notes: fx.notes.map((n) => ({
      id: String(n.id),
      guid: n.guid,
      mid: String(n.mid),
      flds: n.flds.split('\x1f'),
      tags: n.tags.split(/\s+/).filter((t) => t !== ''),
    })),
    cards: [],
    media: fx.media,
  };
}

/** The fixture's card type (roles from suggestMapping) and its notes, in the v3 shapes. */
function fixtureDeck(name: AnkiFixtureName): { type: NoteType; notes: Note[] } {
  return deckFrom(fixtureCollection(name), name);
}

/** The first card type of a collection (roles from suggestMapping) and its notes, in the v3 shapes. */
function deckFrom(collection: AnkiCollection, name: string): { type: NoteType; notes: Note[] } {
  const draft = suggestMapping(collection).types[0];
  const type: NoteType = {
    id: `nt-${name}`,
    name: draft.name,
    kind: draft.kind,
    fields: draft.fields,
    templates: draft.templates,
    sortField: draft.sortField,
    source: { ankiMid: draft.mid },
    createdAt: 0,
    updatedAt: 0,
  };
  const notes = collection.notes.map((n) =>
    makeNote({ id: `n-${n.id}`, typeId: type.id, fields: n.flds, guid: n.guid, tags: n.tags }, 0),
  );
  return { type, notes };
}

/** The field names of some blocks. */
const names = (type: NoteType, blocks: FieldBlock[]) => blocks.map((b) => type.fields[b.field].name);

/** The note whose first field is `first`. */
function noteWith(notes: Note[], first: string): Note {
  const note = notes.find((n) => n.fields[0] === first);
  if (!note) throw new Error(`no note "${first}"`);
  return note;
}

/** Field names of a face's three lists. */
function shape(type: NoteType, face: CardFace) {
  return { badges: names(type, face.badges), prompt: names(type, face.prompt), answer: names(type, face.answer) };
}

/* ---------------------------------------------------- the five deck fixtures */

describe('renderFace on the deck fixtures', () => {
  it('German Verbs EN-DE: prompt = Meaning + CaseInfo', () => {
    const { type, notes } = fixtureDeck('german_verbs');
    const sagen = noteWith(notes, 'sagen');
    expect(shape(type, renderFace(sagen, type, 1))).toEqual({
      badges: ['Level', 'Tags'],
      prompt: ['Meaning', 'CaseInfo'],
      answer: ['Verb', 'Conjugation', 'Perfekt', 'Prateritum', 'Example'],
    });
    const face = renderFace(sagen, type, 1);
    expect(face.promptPlain).toBe('Mimani fotuse buba paso, Sese rogonozi fuki fumi minu nuño kami müta sebone gidemite');
    expect(face.answerPlain).toBe('sagen');
    expect(face.badges.map((b) => b.plain)).toEqual(['A1', 'regular']);
  });

  it('German Verbs DE-EN: prompt = Verb (de-DE)', () => {
    const { type, notes } = fixtureDeck('german_verbs');
    const face = renderFace(noteWith(notes, 'sagen'), type, 0);
    expect(shape(type, face)).toEqual({
      badges: ['Level', 'Tags'],
      prompt: ['Verb'],
      answer: ['Meaning', 'CaseInfo', 'Conjugation', 'Perfekt', 'Prateritum', 'Example'],
    });
    expect(face.prompt[0]).toMatchObject({ role: 'term', label: 'Verb', plain: 'sagen', lang: 'de-DE' });
    expect(face.answer[0]).toMatchObject({ role: 'meaning', plain: 'Mimani fotuse buba paso, Sese rogonozi fuki fumi minu nuño kami müta sebone gidemite' });
    expect(face.answer[0].lang).toBeUndefined(); // an Anki type: no deck fallback
  });

  it('German Vocabulary: empty fields are skipped; the ONE example field shows every sentence as a line', () => {
    const { type, notes } = fixtureDeck('german_vocabulary');
    const braten = noteWith(notes, 'braten'); // Grammar and Plural are empty
    expect(shape(type, renderFace(braten, type, 0))).toEqual({
      badges: ['Level', 'Type'],
      prompt: ['Word'],
      answer: ['Translation', 'VerbForms', 'Examples'],
    });
    expect(shape(type, renderFace(braten, type, 1))).toEqual({
      badges: ['Level', 'Type'],
      prompt: ['Translation'],
      answer: ['Word', 'VerbForms', 'Examples'],
    });
    // This note has a Plural and a Grammar value: the deck shows both on the question.
    const mensch = noteWith(notes, 'der Mensch');
    expect(shape(type, renderFace(mensch, type, 0)).prompt).toEqual(['Word', 'Plural', 'Grammar']);
    // Each <div> example in the field is its own line.
    for (const n of notes) {
      const examples = renderFace(n, type, 0).answer.find((b) => b.role === 'example');
      expect(examples?.lines.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('German Grammar: prompt = Question; answer = Answer, Example', () => {
    const { type, notes } = fixtureDeck('german_grammar');
    const face = renderFace(notes[0], type, 0);
    expect(shape(type, face)).toEqual({ badges: ['Level'], prompt: ['Question'], answer: ['Answer', 'Example'] });
    expect(face.promptPlain).toBe('Toputita kinuti rugogoté sopu tuse?');
  });

  it('Spanish: prompt = Word + Pronunciation; badges Type and Level', () => {
    const { type, notes } = fixtureDeck('spanish_vocabulary');
    const note = noteWith(notes, 'el número de teléfono');
    expect(shape(type, renderFace(note, type, 0))).toEqual({
      badges: ['Type', 'Level'],
      prompt: ['Word', 'Pronunciation'],
      answer: ['Translation', 'Example'],
    });
    expect(shape(type, renderFace(note, type, 1))).toEqual({
      badges: ['Type', 'Level'],
      prompt: ['Translation'],
      answer: ['Word', 'Pronunciation', 'Example'],
    });
    expect(renderFace(note, type, 0).prompt[1]).toMatchObject({ role: 'pronunciation', plain: '/vufipaßa zafeze zakabagu/' });
  });

  it('Algo Deck: Category badge; the Back keeps its image, bold text and lines', () => {
    const { type, notes } = fixtureDeck('algo_patterns');
    const note = noteWith(notes, 'Favi zetétu lovida zova gibi fume?');
    const face = renderFace(note, type, 0);
    expect(shape(type, face)).toEqual({ badges: ['Category'], prompt: ['Front'], answer: ['Back'] });
    expect(face.badges[0].plain).toBe('Core Patterns');
    const back = face.answer[0];
    expect(back.lines[0][0]).toEqual({ t: 'img', src: 'picture-1.svg' });
    expect(back.lines[0][1]).toEqual({ t: 'text', text: 'Valenube mebifizi vezelula tuliki losuluku mitetipo paso kika', b: true });
    expect(back.lines.length).toBeGreaterThan(4);
    expect(face.answerPlain.startsWith('Valenube mebifizi vezelula tuliki losuluku mitetipo paso kika Tipiramu mitetipo sebone')).toBe(true);
  });

  it('every note × every direction of all five decks: sides follow the template, minus empty fields', () => {
    for (const name of ANKI_FIXTURES) {
      const { type, notes } = fixtureDeck(name);
      for (const note of notes) {
        for (const t of type.templates) {
          const face = renderFace(note, type, t.ord);
          // Empty = no text after tags and spaces, or only a placeholder dash (L4).
          const filled = (i: number) => {
            const text = note.fields[i].replace(/<[^<>]*>|\s|&nbsp;/g, '');
            return text !== '' && !/^[-\u2010-\u2015\u2212]+$/.test(text);
          };
          expect(face.prompt.map((b) => b.field)).toEqual(t.prompt.filter(filled));
          expect(face.answer.map((b) => b.field)).toEqual(t.answer.filter(filled));
          expect(face.promptPlain).not.toBe('');
          for (const b of [...face.badges, ...face.prompt, ...face.answer]) {
            expect(b.lines.length).toBeGreaterThan(0);
            // The display label (L3 / R6): the label, else the readable name — never "MarankiExample".
            expect(b.label).toBe(fieldDisplayLabel(type.fields[b.field]));
            expect(b.label).not.toMatch(/^maranki/i);
          }
        }
      }
    }
  });
});

/* ------------------------------------------ Anki stock note types */

describe('Anki stock note types: the answer is never a pill', () => {
  const NOUNS = ['Haus', 'Baum', 'Katze', 'Hund', 'Tisch', 'Auto', 'Buch', 'Lampe', 'Tür', 'Stuhl'];
  const GENDERS = ['das', 'der', 'die', 'der', 'der', 'das', 'das', 'die', 'die', 'der'];
  const CARD_1 = { name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' };

  /** A one-type .apkg collection with Anki's real stock templates. */
  function stock(
    name: string,
    fields: string[],
    tmpls: AnkiCollection['models'][string]['tmpls'],
    rows: string[][],
  ): AnkiCollection {
    return {
      fileName: 'stock.apkg',
      crt: 0,
      models: { '1': { name, type: 0, sortf: 0, flds: fields.map((f, ord) => ({ name: f, ord })), tmpls } },
      decks: {},
      notes: rows.map((flds, i) => ({ id: `${i}`, guid: `g${i}`, mid: '1', flds, tags: [] })),
      cards: [],
      media: {},
    };
  }

  it('Basic, Back = der/die/das: the article is the revealed answer, not a pill before the reveal', () => {
    const { type, notes } = deckFrom(stock('Basic', ['Front', 'Back'], [CARD_1], NOUNS.map((w, i) => [w, GENDERS[i]])), 'basic');
    const face = renderFace(notes[0], type, 0);
    expect(shape(type, face)).toEqual({ badges: [], prompt: ['Front'], answer: ['Back'] });
    expect([face.promptPlain, face.answerPlain]).toEqual(['Haus', 'das']);
  });

  it('Basic (and reversed card): the reverse card asks the article (no blank question)', () => {
    const card2 = { name: 'Card 2', ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}' };
    const collection = stock('Basic (and reversed card)', ['Front', 'Back'], [CARD_1, card2], NOUNS.map((w, i) => [w, GENDERS[i]]));
    const { type, notes } = deckFrom(collection, 'reversed');
    for (const note of notes) {
      for (const ord of [0, 1]) {
        const face = renderFace(note, type, ord);
        expect(face.badges).toEqual([]);
        expect(face.promptPlain).not.toBe('');
        expect(face.answerPlain).not.toBe('');
      }
    }
    expect(shape(type, renderFace(notes[0], type, 1))).toEqual({ badges: [], prompt: ['Back'], answer: ['Front'] });
    expect(renderFace(notes[0], type, 1).promptPlain).toBe('das');
  });

  it('Basic (optional reversed card): no "y" pill from the "Add Reverse" marker', () => {
    const card2 = {
      name: 'Card 2',
      ord: 1,
      qfmt: '{{#Add Reverse}}{{Back}}{{/Add Reverse}}',
      afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}',
    };
    const rows = NOUNS.map((w, i) => [w, `meaning ${i}`, i < 7 ? 'y' : '']);
    const { type, notes } = deckFrom(
      stock('Basic (optional reversed card)', ['Front', 'Back', 'Add Reverse'], [CARD_1, card2], rows),
      'optional',
    );
    for (const note of notes) {
      for (const ord of [0, 1]) {
        const face = renderFace(note, type, ord);
        expect(face.badges).toEqual([]);
        expect([...face.prompt, ...face.answer].map((b) => b.label)).not.toContain('Add Reverse');
      }
    }
  });
});

/* ------------------------------------------------------------- the cache */

describe('the cache: siblings share one note', () => {
  it('the same note, type and ord give the same face object', () => {
    const { type, notes } = fixtureDeck('german_verbs');
    expect(renderFace(notes[0], type, 0)).toBe(renderFace(notes[0], type, 0));
    expect(renderFace(notes[0], type, 1)).toBe(renderFace(notes[0], type, 1));
  });

  it('both directions share the same FieldBlock objects, so they can never disagree', () => {
    const { type, notes } = fixtureDeck('german_verbs');
    const note = noteWith(notes, 'sagen');
    const deEn = renderFace(note, type, 0);
    const enDe = renderFace(note, type, 1);
    const verbIn = (face: CardFace) => [...face.prompt, ...face.answer].find((b) => b.label === 'Verb');
    expect(verbIn(deEn)).toBe(verbIn(enDe));
    expect(deEn.badges[0]).toBe(enDe.badges[0]);
  });

  it('a changed note (a new object) or a changed card type gets a new face', () => {
    const { type, notes } = fixtureDeck('german_grammar');
    const before = renderFace(notes[0], type, 0);
    const edited: Note = { ...notes[0], fields: ['New question?', ...notes[0].fields.slice(1)] };
    expect(renderFace(edited, type, 0).promptPlain).toBe('New question?');
    expect(renderFace(notes[0], type, 0)).toBe(before);

    const relabeled: NoteType = { ...type, fields: type.fields.map((f) => ({ ...f, label: `${f.name}!` })) };
    expect(renderFace(notes[0], relabeled, 0).prompt[0].label).toBe('Question!');
  });
});

/* ------------------------------------------------------------------ cloze */

describe('cloze', () => {
  const cloze = builtinType('cloze', 0);
  const note = makeNote(
    {
      id: 'n-cloze',
      typeId: cloze.id,
      fields: ['{{c1::Paris}} is the capital of {{c2::France::country}}.', 'In <i>Europe</i>'],
    },
    0,
  );

  it('card 1 hides deletion 1 as "[…]" and shows the others', () => {
    const face = renderFace(note, cloze, 0);
    expect(face.promptPlain).toBe('[…] is the capital of France.');
    expect(face.prompt[0].lines).toEqual([
      [
        { t: 'text', text: '[…]', b: true },
        { t: 'text', text: ' is the capital of France.' },
      ],
    ]);
  });

  it('card 2 shows the hint; the answer has the deletion in bold and Extra as a detail row', () => {
    const face = renderFace(note, cloze, 1);
    expect(face.promptPlain).toBe('Paris is the capital of [country].');
    expect(face.answer.map((b) => [b.label, b.role, b.plain])).toEqual([
      ['Text', 'term', 'Paris is the capital of France.'],
      ['Extra', 'detail', 'In Europe'],
    ]);
    expect(face.answer[0].lines[0]).toContainEqual({ t: 'text', text: 'France', b: true });
    expect(face.answerPlain).toBe('France');
  });

  it('plain-text cloze keeps its line breaks', () => {
    const multi = makeNote({ id: 'n-multi', typeId: cloze.id, fields: ['ich {{c1::bin}}\ndu {{c2::bist}}', ''] }, 0);
    expect(renderFace(multi, cloze, 1).prompt[0].lines).toEqual([
      [{ t: 'text', text: 'ich bin' }],
      [{ t: 'text', text: 'du ' }, { t: 'text', text: '[…]', b: true }],
    ]);
    // A "<" that starts no real tag ("i<n") does not make the text HTML: the line break stays.
    const code = makeNote({ id: 'n-code', typeId: cloze.id, fields: ['if i<n:\n{{c1::return}} i', ''] }, 0);
    expect(renderFace(code, cloze, 0).prompt[0].lines).toEqual([
      [{ t: 'text', text: 'if i<n:' }],
      [{ t: 'text', text: '[…]', b: true }, { t: 'text', text: ' i' }],
    ]);
  });

  it('cloze helpers', () => {
    const text = '{{c2::b}} {{c1::a::hint}} {{c2::c}} {{cx::no}} {{c3::open';
    expect(hasCloze(text)).toBe(true);
    expect(hasCloze('no cloze')).toBe(false);
    expect(clozeNumbers(text)).toEqual([1, 2]);
    expect(clozeAnswers(text, 2)).toEqual(['b', 'c']);
    expect(clozeSide(text, 1, 'prompt')).toBe('b <b>[hint]</b> c {{cx::no}} {{c3::open');
    expect(clozeSide(text, 2, 'answer')).toBe('<b>b</b> a <b>c</b> {{cx::no}} {{c3::open');
  });

  // W4-7: a fixed "< 100 ms" failed once on a busy machine (117 ms). Now:
  // linear growth (4 × the input < 10 × the time; quadratic would be 16 ×),
  // measured robustly (see `scaling`), and 1 s only as a generous upper bound.
  it('cloze scanning is linear (no "}}" anywhere)', () => {
    const { growth, bigMs } = scaling((input) => clozeNumbers(input), '{{c1::'.repeat(12_500), '{{c1::'.repeat(50_000));
    expect(growth).toBeLessThan(10);
    expect(bigMs).toBeLessThan(1000);
  });

  it('{{c0::…}} belongs to no card: it shows as plain text, never as markup', () => {
    const zero = makeNote({ id: 'n-zero', typeId: cloze.id, fields: ['{{c0::Berlin}} and {{c1::Paris}}', ''] }, 0);
    expect(clozeNumbers(zero.fields[0])).toEqual([1]);
    const face = renderFace(zero, cloze, 0);
    expect(face.promptPlain).toBe('Berlin and […]');
    expect(face.answerPlain).toBe('Paris');
    // A text with ONLY {{c0::…}} has no card number (the note keeps its one card, ord 0): plain text.
    const only = makeNote({ id: 'n-only-zero', typeId: cloze.id, fields: ['{{c0::x}} y', ''] }, 0);
    expect(renderFace(only, cloze, 0).promptPlain).toBe('x y');
  });

  it('{{c1,2::…}} is hidden on card 1 AND card 2 (the same parser makes the cards)', () => {
    const multi = makeNote({ id: 'n-multi-num', typeId: cloze.id, fields: ['{{c1,2::Paris}} and {{c2::Rome}}', ''] }, 0);
    expect(renderFace(multi, cloze, 0).promptPlain).toBe('[…] and Rome');
    const second = renderFace(multi, cloze, 1);
    expect(second.promptPlain).toBe('[…] and […]');
    expect(second.answerPlain).toBe('Paris, Rome');
  });

  it('nested deletions: the outer card hides all of it, the inner card only its part', () => {
    const nested = makeNote({ id: 'n-nested', typeId: cloze.id, fields: ['{{c1::Paris {{c2::France}}}} is nice', ''] }, 0);
    expect(renderFace(nested, cloze, 0).promptPlain).toBe('[…] is nice');
    expect(renderFace(nested, cloze, 0).answerPlain).toBe('Paris France');
    expect(renderFace(nested, cloze, 1).promptPlain).toBe('Paris […] is nice');
    expect(renderFace(nested, cloze, 1).answerPlain).toBe('France');
  });
});

/* --------------------------------------------- a side that only reads aloud */

describe('a listening card ({{tts}} is the only thing on the question side)', () => {
  const listening: AnkiCollection = {
    fileName: 'listening.apkg',
    crt: 0,
    models: {
      '7': {
        name: 'Listening',
        type: 0,
        sortf: 0,
        flds: [
          { name: 'Word', ord: 0 },
          { name: 'Meaning', ord: 1 },
        ],
        tmpls: [{ name: 'Listen', ord: 0, qfmt: '{{tts de_DE:Word}}', afmt: '{{Word}}<br>{{Meaning}}' }],
      },
    },
    decks: {},
    notes: [
      { id: '1', guid: 'g1', mid: '7', flds: ['die Stunde', 'the hour'], tags: [] },
      { id: '2', guid: 'g2', mid: '7', flds: ['der Tag', 'the day'], tags: [] },
    ],
    cards: [],
    media: {},
  };

  it('the question shows the spoken field (never blank), with its language for the speaker button', () => {
    const { type, notes } = deckFrom(listening, 'listening');
    const face = renderFace(notes[0], type, 0);
    expect(shape(type, face)).toEqual({ badges: [], prompt: ['Word'], answer: ['Meaning'] });
    expect(face.promptPlain).toBe('die Stunde');
    expect(face.prompt[0].lang).toBe('de-DE');
    expect(face.answerPlain).toBe('the hour');
  });

  /** Word, Meaning, Level; the level is shown above the word, as on the real German decks. */
  const LEVEL = '<div class="level">{{Level}}</div>';
  const ANSWER = '{{FrontSide}}<hr>{{Word}}<br>{{Meaning}}';
  const withLevel = (tmpls: { name: string; qfmt: string; afmt: string }[]): AnkiCollection => ({
    ...listening,
    models: {
      '7': {
        name: 'Listening',
        type: 0,
        sortf: 0,
        flds: ['Word', 'Meaning', 'Level'].map((name, ord) => ({ name, ord })),
        tmpls: tmpls.map((t, ord) => ({ ...t, ord })),
      },
    },
    notes: [
      ['die Stunde', 'the hour', 'A1'],
      ['der Tag', 'the day', 'A1'],
      ['das Haus', 'the house', 'A2'],
      ['der Baum', 'the tree', 'A2'],
    ].map((flds, i) => ({ id: `${i + 1}`, guid: `g${i + 1}`, mid: '7', flds, tags: [] })),
  });

  it('with a Level pill on the question: the question asks the spoken word (never "A1")', () => {
    const { type, notes } = deckFrom(withLevel([{ name: 'Listen', qfmt: `${LEVEL}{{tts de_DE:Word}}`, afmt: ANSWER }]), 'listen-level');
    const face = renderFace(notes[0], type, 0);
    expect(shape(type, face)).toEqual({ badges: ['Level'], prompt: ['Word'], answer: ['Meaning'] });
    expect(face.promptPlain).toBe('die Stunde');
    expect(face.prompt[0].lang).toBe('de-DE');
    expect(face.badges[0].plain).toBe('A1');
  });

  const dictation: AnkiCollection = {
    ...listening,
    models: {
      '7': {
        ...listening.models['7'],
        tmpls: [{ name: 'Dictation', ord: 0, qfmt: '{{tts de_DE:Word}}{{type:Word}}', afmt: '{{Word}}<br>{{Meaning}}' }],
      },
    },
  };

  // Adapted in W3-4 (lead carry-over): the question was blank (prompt []) and
  // the speaker had nothing to read. It now has ONE speaker block: it shows
  // only '🔊', and its `plain` (+ lang) is the word, for read-aloud only.
  it('a dictation card ("listen, then type the word") never shows the word it types on the question', () => {
    const { type, notes } = deckFrom(dictation, 'dictation');
    expect(type.templates[0].typeField).toBe(0);
    expect(type.templates[0].prompt).toEqual([]); // the stored template still asks no field
    const face = renderFace(notes[0], type, 0);
    // The question SHOWS only the speaker; nothing visible holds the word.
    expect(face.prompt).toHaveLength(1);
    expect(face.prompt[0].lines).toEqual([[{ t: 'text', text: SPEAKER_PROMPT }]]);
    expect(face.promptPlain).toBe(SPEAKER_PROMPT);
    expect(JSON.stringify(face.prompt[0].lines)).not.toContain('Stunde');
    expect(face.badges).toEqual([]);
    // The revealed side shows the word and its meaning; the word is the typing target.
    expect(names(type, face.answer)).toEqual(['Word', 'Meaning']);
    expect(face.answerPlain).toBe('die Stunde');
  });

  it('a dictation question is usable: its speaker block reads the typed word aloud, with its language', () => {
    const { type, notes } = deckFrom(dictation, 'dictation');
    const face = renderFace(notes[1], type, 0);
    const speaker = face.prompt[0];
    expect(isSpeakerBlock(speaker)).toBe(true);
    expect(speaker.field).toBe(0); // the Word field (the typing field)
    expect(speaker.label).toBe('Word');
    expect(speaker.role).toBe(type.fields[0].role);
    expect(speaker.plain).toBe('der Tag'); // what read-aloud speaks
    expect(speaker.lang).toBe('de-DE'); // from {{tts de_DE:Word}}
    // An ordinary block is not a speaker block, even one whose text is a speaker emoji.
    expect(isSpeakerBlock(face.answer[0])).toBe(false);
    const literal = makeNote({ id: 'n-emoji', typeId: type.id, fields: [SPEAKER_PROMPT, 'speaker'] }, 0);
    expect(isSpeakerBlock(renderFace(literal, type, 0).answer[0])).toBe(false);
  });

  // W3-4 review round 1: the speaker block alone was not enough — the screen
  // spoke `promptPlain` ('🔊'), so the phone read the emoji's name aloud. The
  // screen now speaks speechOf(face, side): the headline's plain + lang.
  it('the 🔊 button of a dictation question speaks the word (speechOf), and A–Z sorts it by the word', () => {
    const { type, notes } = deckFrom(dictation, 'dictation');
    const face = renderFace(notes[0], type, 0);
    expect(face.promptPlain).toBe(SPEAKER_PROMPT); // what rows and the card show
    expect(speechOf(face, 'prompt')).toEqual({ text: 'die Stunde', lang: 'de-DE' }); // what the speaker says
    expect(speechOf(face, 'answer')).toEqual({ text: 'die Stunde', lang: 'de-DE' }); // revealed: the Word headline
    expect(faceSortKey(face)).toBe('stunde'); // German: by the word, not the article, not '🔊'
    expect(faceSortKey(renderFace(notes[1], type, 0))).toBe('tag');
  });

  it('a dictation note with an empty typing field has nothing to read: no speaker block', () => {
    const { type } = deckFrom(dictation, 'dictation');
    const empty = makeNote({ id: 'n-empty-word', typeId: type.id, fields: ['', 'the hour'] }, 0);
    const face = renderFace(empty, type, 0);
    expect(face.prompt).toEqual([]);
    expect(face.promptPlain).toBe('');
  });

  it('a speaker block is only for a blank question: a question with a field never gets one', () => {
    const basic = builtinType('basicReverse', 0);
    const typed: NoteType = { ...basic, templates: basic.templates.map((t) => ({ ...t, typeField: 1 })) };
    const note = makeNote({ id: 'n-typed', typeId: typed.id, fields: ['die Stunde', 'the hour', '', ''] }, 0);
    for (const ord of [0, 1]) {
      const face = renderFace(note, typed, ord);
      expect(face.prompt.some(isSpeakerBlock)).toBe(false);
    }
    expect(renderFace(note, typed, 0).promptPlain).toBe('die Stunde');
    // A question field that is only EMPTY in this note stays blank: the speaker
    // would read out the typed answer of a card that is not a dictation card.
    const emptyFront = makeNote({ id: 'n-typed-empty', typeId: typed.id, fields: ['', 'the hour', '', ''] }, 0);
    expect(renderFace(emptyFront, typed, 0).prompt).toEqual([]);
  });

  it('no direction of any note shows its typing field on the question', () => {
    const { type, notes } = deckFrom(
      withLevel([
        { name: 'DE-EN', qfmt: `{{Word}}${LEVEL}{{tts de_DE:Word}}`, afmt: ANSWER },
        { name: 'Listen', qfmt: `${LEVEL}{{tts de_DE:Word}}`, afmt: ANSWER },
        { name: 'Dictation', qfmt: `${LEVEL}{{tts de_DE:Word}}{{type:Word}}`, afmt: ANSWER },
        { name: 'Type the meaning', qfmt: `{{Word}}{{tts de_DE:Meaning}}{{type:Meaning}}`, afmt: ANSWER },
      ]),
      'mixed-listening',
    );
    // Adapted in W3-4: the dictation question now has a speaker block FOR its
    // typing field. The rule stays "never SHOW the typing field on the
    // question": a block of the typing field may only be the speaker block,
    // whose lines hold no text of the field.
    for (const note of notes) {
      for (const t of type.templates) {
        const face = renderFace(note, type, t.ord);
        expect(face.badges.map((b) => b.field)).toEqual([2]); // Level is always a pill, never the question
        if (t.typeField !== undefined) {
          for (const b of face.prompt.filter((p) => p.field === t.typeField)) {
            expect(isSpeakerBlock(b)).toBe(true);
            expect(blockText(b)).toBe(SPEAKER_PROMPT);
          }
        }
        if (t.name !== 'Dictation') expect(face.promptPlain).toBe(note.fields[0]); // the word is asked
        else expect(face.prompt.map((b) => b.plain)).toEqual([note.fields[0]]); // the word is read aloud, not shown
      }
    }
  });
});

/* -------------------------------------------------------------- languages */

describe('read-aloud language (spec §6.8)', () => {
  const basic = builtinType('basicReverse', 0);
  const deck = { language: 'de-DE', meaningLanguage: 'en-US' };
  const note = makeNote({ id: 'n-lang', typeId: basic.id, fields: ['die Stunde', 'the hour', 'Eine Stunde.', 'n.'] }, 0);

  it('a non-Anki type uses the deck languages: term/example → language, meaning → meaningLanguage', () => {
    const face = renderFace(note, basic, 0, deck);
    expect(face.prompt[0].lang).toBe('de-DE');
    expect(face.answer.map((b) => [b.label, b.lang])).toEqual([
      ['Back', 'en-US'],
      ['Example', 'de-DE'],
      ['Notes', undefined],
    ]);
    expect(renderFace(note, basic, 1, deck).prompt[0].lang).toBe('en-US');
  });

  it('without a deck, or with other deck languages, the blocks follow', () => {
    expect(renderFace(note, basic, 0).prompt[0].lang).toBeUndefined();
    expect(renderFace(note, basic, 0, { language: 'nl-NL' }).prompt[0].lang).toBe('nl-NL');
    expect(renderFace(note, basic, 0, deck).prompt[0].lang).toBe('de-DE');
  });

  it('FieldDef.lang wins; an Anki type never uses the deck fallback', () => {
    const anki: NoteType = { ...basic, source: { ankiMid: '123' } };
    expect(resolveFieldLang({ name: 'Q', role: 'term', facet: 'off', lang: 'en-US' }, basic, deck)).toBe('en-US');
    expect(resolveFieldLang({ name: 'Q', role: 'term', facet: 'off' }, anki, deck)).toBeUndefined();
    expect(resolveFieldLang({ name: 'Q', role: 'exampleMeaning', facet: 'off' }, basic, deck)).toBe('en-US');
    expect(resolveFieldLang({ name: 'Q', role: 'detail', facet: 'off' }, basic, deck)).toBeUndefined();
  });
});

/* ------------------------------------------------------- shapes and safety */

describe('built-in types and damaged data', () => {
  it('a Basic note looks like the v2 legacy face of the same text', () => {
    const basic = builtinType('basic', 0);
    const texts = { front: 'die Stunde', back: 'the hour', example: 'Eine Stunde hat 60 Minuten.', notes: '/ˈʃtʊndə/\nAn hour.' };
    const note = makeNote({ id: 'n-basic', typeId: basic.id, fields: [texts.front, texts.back, texts.example, texts.notes] }, 0);
    const face = renderFace(note, basic, 0);
    const legacy = legacyFace(texts);
    expect(face).toEqual(legacy);
  });

  it('hidden fields are never shown; badges are pills only', () => {
    const legacy = builtinType('legacyVocabDe', 0);
    const fields = ['die Stunde', 'the hour', '', '', '/ˈʃtʊndə/', 'A1', 'noun', 'die', 'Stunde', ''];
    const face = renderFace(makeNote({ id: 'n-legacy', typeId: legacy.id, fields }, 0), legacy, 0);
    expect(shape(legacy, face)).toEqual({
      badges: ['Level', 'Type'],
      prompt: ['Word', 'Pronunciation'],
      answer: ['Translation'],
    });
  });

  it('a missing direction, missing fields or a non-text value never throw', () => {
    const { type, notes } = fixtureDeck('german_grammar');
    expect(renderFace(notes[1], type, 5).promptPlain).toBe(renderFace(notes[1], type, 0).promptPlain);
    const short = makeNote({ id: 'n-short', typeId: type.id, fields: ['Only a question'] }, 0);
    expect(shape(type, renderFace(short, type, 0))).toEqual({ badges: [], prompt: ['Question'], answer: [] });
    const odd = { ...short, id: 'n-odd', fields: [42 as unknown as string] };
    expect(renderFace(odd, type, 0).promptPlain).toBe('42');
    const noTemplates: NoteType = { ...type, templates: [] };
    expect(shape(noTemplates, renderFace(notes[2], noTemplates, 0))).toEqual({
      badges: ['Level'],
      prompt: ['Question'],
      answer: ['Answer', 'Example'],
    });
  });
});

describe('fieldShownOnCard: the card editor says when a field is on no side', () => {
  it('a field a direction names, and a badge, are shown; a hidden field is not', () => {
    const legacy = builtinType('legacyVocabDe', 0);
    const index = (name: string) => legacy.fields.findIndex((f) => f.name === name);
    expect(fieldShownOnCard(legacy, index('Word'))).toBe(true);
    expect(fieldShownOnCard(legacy, index('Translation'))).toBe(true);
    expect(fieldShownOnCard(legacy, index('Level'))).toBe(true); // a pill
    const hidden = legacy.fields.findIndex((f) => f.role === 'hidden');
    expect(hidden).toBeGreaterThanOrEqual(0);
    expect(fieldShownOnCard(legacy, hidden)).toBe(false);
    expect(fieldShownOnCard(legacy, -1)).toBe(false);
    expect(fieldShownOnCard(legacy, legacy.fields.length)).toBe(false);
  });

  it('a kept field that no direction names (a newer deck file dropped it) is not shown', () => {
    const { type } = fixtureDeck('german_grammar');
    const kept: NoteType = {
      ...type,
      fields: [...type.fields, { ...type.fields[type.fields.length - 1], name: 'MarankiExample', role: 'example' }],
    };
    expect(fieldShownOnCard(kept, kept.fields.length - 1)).toBe(false);
    // Every field the real deck's directions name is shown.
    for (const t of type.templates) for (const i of [...t.prompt, ...t.answer]) expect(fieldShownOnCard(type, i)).toBe(true);
  });

  it('a type with no template: the sort field asks, every other field answers (as renderFace)', () => {
    const { type } = fixtureDeck('german_grammar');
    const noTemplates: NoteType = { ...type, templates: [] };
    noTemplates.fields.forEach((f, i) => {
      if (f.role !== 'hidden') expect(fieldShownOnCard(noTemplates, i)).toBe(true);
    });
  });
});

/* ------------------------------------------ wave 5b: labels and dashes */

describe('field labels: never an internal name (walkthrough L3 / R6)', () => {
  it('humanizeFieldName: drops the app prefix and turns CamelCase / snake_case into words (each keeps its capitals)', () => {
    expect(APP_FIELD_PREFIXES).toContain('Maranki');
    const cases: [string, string][] = [
      ['MarankiExample', 'Example'],
      ['MarankiExampleTranslation', 'Example Translation'],
      ['maranki_notes', 'Notes'],
      ['Maranki Example', 'Example'],
      ['VerbForms', 'Verb Forms'],
      ['CaseInfo', 'Case Info'],
      ['verbForms', 'Verb Forms'],
      ['example_translation', 'Example translation'],
      ['IPAText', 'IPA Text'],
      ['ExampleEN', 'Example EN'],
      ['BeispielSätze', 'Beispiel Sätze'],
      ['ÜbungText', 'Übung Text'],
    ];
    for (const [name, label] of cases) expect([name, humanizeFieldName(name)]).toEqual([name, label]);
  });

  it('humanizeFieldName: a name that is already readable comes back unchanged', () => {
    for (const name of ['Front', 'Back Extra', 'Example sentence', 'IPA', 'word', 'Präteritum', 'A1Level', 'iPhone', 'Level 2']) {
      expect(humanizeFieldName(name)).toBe(name);
    }
    // Only the prefix, or the prefix inside a longer word: not a prefix.
    expect(humanizeFieldName('Maranki')).toBe('Maranki');
    expect(humanizeFieldName('Marankis')).toBe('Marankis');
    expect(humanizeFieldName('')).toBe('');
  });

  it('fieldDisplayLabel: FieldDef.label wins (trimmed); a blank label falls back to the readable name', () => {
    expect(fieldDisplayLabel({ name: 'Prateritum', label: 'Präteritum' })).toBe('Präteritum');
    expect(fieldDisplayLabel({ name: 'MarankiExample', label: '  Example  ' })).toBe('Example');
    expect(fieldDisplayLabel({ name: 'MarankiExample' })).toBe('Example');
    expect(fieldDisplayLabel({ name: 'MarankiExample', label: '   ' })).toBe('Example');
    expect(fieldDisplayLabel({ name: 'Front' })).toBe('Front');
  });

  it('German Vocabulary version 2 (generic build, no pack preset): the rows read "Verb Forms" and "Example", never the raw names', () => {
    // Version 2 still has the "MarankiExample" field; a learner may import such a file.
    const { type, notes } = fixtureDeck('german_vocabulary_v2');
    const braten = noteWith(notes, 'braten');
    const answer = renderFace(braten, type, 0).answer;
    expect(answer.map((b) => b.label)).toEqual(['Translation', 'Verb Forms', 'Examples', 'Example']);
    // A screen reader hears the same label (FieldRows reads block.label).
    expect(answer.map((b) => b.label)).not.toContain('MarankiExample');
    expect(answer.map((b) => b.label)).not.toContain('VerbForms');
  });

  it('German Verbs: CaseInfo reads "Case Info"; a field with its own label keeps it', () => {
    const { type, notes } = fixtureDeck('german_verbs');
    const prompt = renderFace(noteWith(notes, 'sagen'), type, 1).prompt;
    expect(prompt.map((b) => b.label)).toEqual(['Meaning', 'Case Info']);
    const labelled: NoteType = {
      ...type,
      fields: type.fields.map((f) => (f.name === 'CaseInfo' ? { ...f, label: 'Case / preposition' } : f)),
    };
    expect(renderFace(noteWith(notes, 'sagen'), labelled, 1).prompt[1].label).toBe('Case / preposition');
  });
});

describe('placeholder dashes are empty fields (walkthrough L4)', () => {
  it('isDashOnly: one or more dashes (any kind), with or without spaces; nothing else', () => {
    for (const text of ['-', '–', '—', '--', ' – ', '- -', '\u2212', '\u2010', '―']) expect([text, isDashOnly(text)]).toEqual([text, true]);
    for (const text of ['', ' ', '-n', 'n-', 'A–Z', '–en', '…', '_', '0']) expect([text, isDashOnly(text)]).toEqual([text, false]);
  });

  /** A German-vocabulary-like type: Word (term) + Grammar (detail) ask, Translation answers; Level is a pill. */
  const type: NoteType = {
    id: 'nt-dash',
    name: 'Vocab',
    kind: 'standard',
    fields: [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Grammar', role: 'detail', facet: 'auto' },
      { name: 'Translation', role: 'meaning', facet: 'off' },
      { name: 'Notes', role: 'detail', facet: 'auto' },
      { name: 'Level', role: 'badge', facet: 'auto' },
    ],
    templates: [
      { ord: 0, name: 'DE-EN', prompt: [0, 1], answer: [2, 3] },
      { ord: 1, name: 'EN-DE', prompt: [2], answer: [0, 1, 3] },
    ],
    sortField: 0,
    createdAt: 0,
    updatedAt: 0,
  };

  it('"GRAMMAR –" is gone from BOTH sides (question and answer), and the other fields stay', () => {
    for (const dash of ['–', '-', '—', '<div>–</div>', ' — ']) {
      const note = makeNote({ id: `n-dash-${dash}`, typeId: type.id, fields: ['der Schinken', dash, 'ham', dash, 'A1'] }, 0);
      const forward = renderFace(note, type, 0);
      expect(shape(type, forward)).toEqual({ badges: ['Level'], prompt: ['Word'], answer: ['Translation'] });
      const reverse = renderFace(note, type, 1);
      expect(shape(type, reverse)).toEqual({ badges: ['Level'], prompt: ['Translation'], answer: ['Word'] });
    }
  });

  it('a dash-only badge is not a pill; a real value with a dash ("-e") is kept', () => {
    const note = makeNote({ id: 'n-dash-badge', typeId: type.id, fields: ['der Tisch', '-e', 'table', '', '–'] }, 0);
    const face = renderFace(note, type, 0);
    expect(face.badges).toEqual([]);
    expect(shape(type, face).prompt).toEqual(['Word', 'Grammar']);
    expect(face.prompt[1].plain).toBe('-e');
  });

  it('a dash next to an image is a value (the image shows)', () => {
    const note = makeNote({ id: 'n-dash-img', typeId: type.id, fields: ['das Bild', '<img src="b.png"> –', 'picture', '', ''] }, 0);
    expect(shape(type, renderFace(note, type, 0)).prompt).toEqual(['Word', 'Grammar']);
  });
});
