/**
 * The CSV reader (spec §5.7, unit W2-5): header → field names; the Anki
 * "Notes in Plain Text" header lines (#separator, #html, #columns,
 * #guid/#deck/#notetype/#tags column); a file WITHOUT a header maps exactly
 * like today's importer (checked through the planner on today's own test
 * inputs); same columns → the same card type (CSV signature).
 */
import { describe, expect, test } from '@jest/globals';

import { FIXED_NOW } from '../../test/clock';
import { parseImportCsv } from '../importFile';
import type { Card, Deck, ImportChoices, ImportPlan, Note, NoteType } from '../model';
import { DEFAULT_SRS } from '../types';
import { renderFace } from '../render';
import {
  clozeColumn,
  CSV_MODEL_ID,
  csvSignature,
  csvTemplates,
  escapeCsvText,
  isCsvHeaderRow,
  readCsv,
  tagsHeaderColumn,
} from './csvRead';
import { findReusableType, planImport, positionalFieldDefs, type PlanCtx, type PlanLibrary } from './plan';

/* ---------------------------------------------------------------- helpers */

interface Lib {
  noteTypes: NoteType[];
  notes: Note[];
  cards: Card[];
  decks: Deck[];
}
const emptyLib = (): Lib => ({ noteTypes: [], notes: [], cards: [], decks: [] });

/** A fresh id sequence. Give each planImport of one test its own prefix, so no two plans share an id. */
function ctx(prefix = 'id'): PlanCtx {
  let n = 0;
  return {
    now: FIXED_NOW,
    newId: () => `${prefix}-${++n}`,
    srs: { startingEase: DEFAULT_SRS.startingEase, maxIntervalDays: DEFAULT_SRS.maxIntervalDays },
    fieldFacetSpecs: () => new Map(),
    detectOrdinal: () => null,
  };
}

/** Today's defaults for every card type of a CSV collection (positional roles, ord 0 only). */
function csvChoices(c: ReturnType<typeof readCsv>, over: Partial<ImportChoices> = {}): ImportChoices {
  const types: ImportChoices['types'] = {};
  for (const mid of Object.keys(c.models)) {
    types[mid] = { fields: positionalFieldDefs(c.models[mid].flds.map((f) => f.name)), ords: [0] };
  }
  return {
    sections: new Set(Object.keys(c.decks)),
    target: { kind: 'new', name: '', icon: '🗂️' },
    types,
    progress: 'keep',
    arrival: 'queued',
    elsewhere: 'update',
    images: true,
    ...over,
  };
}

function apply(lib: Lib, plan: ImportPlan): Lib {
  const upd = new Map(plan.notes.update.map((u) => [u.id, u]));
  return {
    noteTypes: [...lib.noteTypes, ...plan.noteTypes.add],
    notes: [
      ...lib.notes.map((n) => {
        const u = upd.get(n.id);
        return u ? { ...n, fields: u.fields, tags: u.tags } : n;
      }),
      ...plan.notes.add,
    ],
    cards: [...lib.cards, ...plan.cards.add],
    decks: plan.deck ? [...lib.decks, plan.deck] : lib.decks,
  };
}

/** Escaped field HTML → the text today's importer stored. */
function textOf(field: string | undefined): string {
  return (field ?? '')
    .replace(/<br>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ header */

describe('readCsv — header row → field names', () => {
  test('a space before a quoted value keeps the value whole (no phantom "Field 3")', () => {
    const c = readCsv('Word, Translation\nHaus, "house, home"\nAuto, car', 'w.csv');
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Word', 'Translation']);
    expect(c.notes.map((n) => n.flds)).toEqual([
      ['Haus', 'house, home'],
      ['Auto', 'car'],
    ]);
  });

  test('Word,Translation,Level,Type gives four named fields', () => {
    const c = readCsv('Word,Translation,Level,Type\nHaus,house,A1,noun\ngehen,to go,A1,verb', 'German.csv');
    const model = c.models[CSV_MODEL_ID];
    expect(model.name).toBe('German');
    expect(model.flds.map((f) => f.name)).toEqual(['Word', 'Translation', 'Level', 'Type']);
    expect(c.csv).toMatchObject({ header: ['Word', 'Translation', 'Level', 'Type'], delimiter: ',', html: false });
    expect(c.csv?.tagsCol).toBeUndefined();
    expect(c.notes.map((n) => n.flds)).toEqual([
      ['Haus', 'house', 'A1', 'noun'],
      ['gehen', 'to go', 'A1', 'verb'],
    ]);
    expect(c.notes.map((n) => n.guid)).toEqual(['', '']);
    expect(c.decks).toEqual({ '1': 'German' });
  });

  test('two synthesized directions; one new card row per direction, in row order', () => {
    const c = readCsv('Word,Translation\nHaus,house\nBaum,tree', 'g.csv');
    expect(c.models[CSV_MODEL_ID].tmpls.map((t) => [t.ord, t.name, t.qfmt])).toEqual([
      [0, 'Front → Back', '{{Word}}'],
      [1, 'Back → Front', '{{Translation}}'],
    ]);
    expect(c.cards.map((x) => [x.nid, x.ord, x.type, x.due])).toEqual([
      ['1', 0, 0, 1],
      ['1', 1, 0, 1],
      ['2', 0, 0, 2],
      ['2', 1, 0, 2],
    ]);
    expect(csvTemplates(['Only'])).toHaveLength(1);
    expect(csvTemplates([])).toEqual([]);
    // The planner asks the columns chosen as Front and Back; the answer shows the other side first.
    expect(csvTemplates(['Level', 'Word', 'Meaning'], 1, 2).map((t) => [t.qfmt, t.afmt])).toEqual([
      ['{{Word}}', '{{FrontSide}}<hr id=answer>{{Meaning}}<br>{{Level}}'],
      ['{{Meaning}}', '{{FrontSide}}<hr id=answer>{{Word}}<br>{{Level}}'],
    ]);
  });

  test('the "First row is a header" toggle wins over detection', () => {
    const forced = readCsv('Apfel,apple\nBaum,tree', 'x.csv', { header: true });
    expect(forced.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Apfel', 'apple']);
    expect(forced.notes).toHaveLength(1);
    const off = readCsv('Front,Back\napple,fruit', 'x.csv', { header: false });
    expect(off.notes).toHaveLength(2);
    expect(off.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Field 1', 'Field 2']);
  });

  test('header names are made valid and unique; extra columns get "Field n"', () => {
    const c = readCsv('Word,Note: extra,{{x}},Level,level\nHaus,a,b,A1,x,EXTRA', 'x.csv', { header: true });
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual([
      'Word',
      'Note extra',
      'x',
      'Level',
      'level 2',
      'Field 6',
    ]);
    expect(c.notes[0].flds).toEqual(['Haus', 'a', 'b', 'A1', 'x', 'EXTRA']);
  });

  test('isCsvHeaderRow keeps the L20 two-signal rule', () => {
    expect(isCsvHeaderRow(['Front', 'Back'])).toBe(true);
    expect(isCsvHeaderRow(['Front', 'the opening move'])).toBe(false);
    expect(isCsvHeaderRow(['Wort'])).toBe(false);
    expect(isCsvHeaderRow(['Término', 'Traducción'])).toBe(true);
  });

  test('common headers are found: Question,Answer · German,English · Translation,Word · the app export', () => {
    for (const header of [
      ['Question', 'Answer'],
      ['Frage', 'Antwort'],
      ['German', 'English'],
      ['English', 'German'],
      ['Deutsch', 'Englisch'],
      ['Translation', 'Word'],
      ['Word', 'English'],
      ['Kanji', 'Meaning'],
      ['Text', 'Back Extra', 'Tags', 'Section'],
      ['Field 1', 'Field 2', 'Tags', 'Section'],
    ]) {
      expect([header, isCsvHeaderRow(header)]).toEqual([header, true]);
    }
    // Still two signals: a translation pair or a lone label is data.
    for (const row of [['Wort', 'word'], ['German', 'Deutsch'], ['Englisch', 'English'], ['Frage', 'question'], ['Antwort', 'answer'], ['Question'], ['field', 'Feld']]) {
      expect([row, isCsvHeaderRow(row)]).toEqual([row, false]);
    }
  });

  test('Question,Answer as the first row gives two named fields and no header card', () => {
    const c = readCsv('Question,Answer\nWhat is 2+2?,4\nCapital of France?,Paris', 'quiz.csv');
    expect(c.csv?.header).toEqual(['Question', 'Answer']);
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Question', 'Answer']);
    expect(c.notes.map((n) => n.flds[0])).toEqual(['What is 2+2?', 'Capital of France?']);
  });
});

/* -------------------------------------------------------------- no header */

describe('readCsv — no header: today positions (0 Front · 1 Back · 2 Example · 3 Notes · 4+ Tags)', () => {
  test('Field 1 … Field 4, tags from column 5 on (split on | ; ,)', () => {
    const c = readCsv('apple,a round fruit,I ate an apple.,Common in pies,fruit|food,Food', 'Fruits.csv');
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Field 1', 'Field 2', 'Field 3', 'Field 4']);
    expect(c.csv).toMatchObject({ header: null, tagsCol: 4, tagsSpill: true, tagsSyntax: 'list' });
    expect(c.notes[0].flds).toEqual(['apple', 'a round fruit', 'I ate an apple.', 'Common in pies']);
    expect(c.notes[0].tags).toEqual(['fruit', 'food']); // "Food" is the same tag, ignoring case
  });

  test('positional field roles keep today mapping, and "Field 4" is labelled Notes', () => {
    const defs = positionalFieldDefs(['Field 1', 'Field 2', 'Field 3', 'Field 4', 'Field 5']);
    expect(defs.map((d) => d.role)).toEqual(['term', 'meaning', 'example', 'detail', 'detail']);
    expect(defs[3].label).toBe('Notes');
    expect(defs.map((d) => d.facet)).toEqual(['off', 'off', 'off', 'auto', 'auto']);
  });

  // The inputs of today's importFile.test.ts, plus a few edge cases.
  const TODAY_CASES: [string, string][] = [
    ['go\tto go, to walk\nrun\tto run, to jog', 'verbs.tsv'],
    ['Front,Back\napple,the fruit', 'deck.csv'],
    ['Front,the opening move\napple,the fruit', 'deck.csv'],
    ['Front\napple\ncat', 'deck.csv'],
    ['Wort,Übersetzung\nHaus,house', 'de.csv'],
    ['Término;Traducción\ncasa;house', 'es.csv'],
    ['WORT,ÜBERSETZUNG\nHaus,house', 'de.csv'],
    ['apple,a round fruit,I ate an apple.,Common in pies,fruit|food', 'Fruits.csv'],
    ['apple,fruit', 'Fruit Vocabulary.csv'],
    [',back only\nfront only\n"multi\nline",a < b & c', 'edge.csv'],
    ['a,b,c,d,t1;t2,t3\nx,y,,,Tag|tag', 'spill.csv'],
    ['﻿BOM,first\n\n\nlast,row\n', 'bom.csv'],
    // A header with a "Tags" column: today's importer dropped the header and read column 4 as tags.
    ['Front,Back,Example,Notes,Tags\napple,fruit,,,food|Fruit', 'tags.csv'],
  ];

  test.each(TODAY_CASES)('same cards as today: %j', (text, fileName) => {
    const today = parseImportCsv(text, fileName);
    const c = readCsv(text, fileName);
    const plan = planImport(c, emptyLib(), csvChoices(c), ctx());
    const now = plan.notes.add.map((n) => ({
      front: textOf(n.fields[0]),
      back: textOf(n.fields[1]),
      ...(textOf(n.fields[2]) ? { example: textOf(n.fields[2]) } : {}),
      ...(textOf(n.fields[3]) ? { notes: textOf(n.fields[3]) } : {}),
      ...(n.tags.length ? { tags: n.tags } : {}),
    }));
    expect(now).toEqual(today.payload);
    expect(plan.cards.add).toHaveLength(today.payload.length); // one card each (ord 0)
    expect(plan.deck?.name).toBe(today.name);
  });
});

/* ------------------------------------------------------- Anki text exports */

describe('readCsv — Anki "Notes in Plain Text" headers', () => {
  const EXPORT = [
    '#separator:tab',
    '#html:true',
    '#guid column:1',
    '#notetype column:2',
    '#deck column:3',
    '#tags column:6',
    'g1\tBasic\tGerman::Verbs::A1\t<b>sagen</b>\tto say\tverb a1',
    'g2\tBasic\tGerman::Verbs::B1\tdenken\tto think\tverb',
    'g3\tCloze-ish\tGerman::Verbs::B1\tx\ty\t',
  ].join('\n');

  test('header lines are read and never become cards', () => {
    const c = readCsv(EXPORT, 'export.txt');
    expect(c.notes).toHaveLength(3);
    expect(c.notes.every((n) => !n.flds.join('').includes('#'))).toBe(true);
    expect(c.csv).toEqual({
      header: null,
      delimiter: '\t',
      html: true,
      guidCol: 0,
      deckCol: 2,
      notetypeCol: 1,
      tagsCol: 5,
      // ONE column of space-separated tags (no header, but not today's positional rule).
      tagsSpill: false,
      tagsSyntax: 'anki',
    });
  });

  test('#guid column → guid; #deck column → subdecks; #tags column → space-separated tags', () => {
    const c = readCsv(EXPORT, 'export.txt');
    expect(c.notes.map((n) => n.guid)).toEqual(['g1', 'g2', 'g3']);
    expect(Object.values(c.decks)).toEqual(['German::Verbs::A1', 'German::Verbs::B1']);
    expect(c.cards.filter((x) => x.ord === 0).map((x) => c.decks[x.did])).toEqual([
      'German::Verbs::A1',
      'German::Verbs::B1',
      'German::Verbs::B1',
    ]);
    expect(c.notes.map((n) => n.tags)).toEqual([['verb', 'a1'], ['verb'], []]);
  });

  test('#notetype column → one card type per value; special columns are not fields', () => {
    const c = readCsv(EXPORT, 'export.txt');
    expect(Object.entries(c.models).map(([mid, m]) => [mid, m.name])).toEqual([
      ['csv:1', 'Basic'],
      ['csv:2', 'Cloze-ish'],
    ]);
    expect(c.models['csv:1'].flds.map((f) => f.name)).toEqual(['Field 1', 'Field 2']);
    expect(c.notes.map((n) => n.mid)).toEqual(['csv:1', 'csv:1', 'csv:2']);
  });

  test('a Cloze note type is a CLOZE card type: one card per cloze number, the question hides the answer', () => {
    const text = [
      '#separator:tab',
      '#html:true',
      '#guid column:1',
      '#notetype column:2',
      '#deck column:3',
      'g1\tBasic\tGeo\tBerlin\tcapital of Germany',
      'g2\tCloze\tGeo\t{{c1::Berlin}} ist die Hauptstadt von {{c2::Deutschland}}\tExtra info',
    ].join('\n');
    const c = readCsv(text, 'export.txt');
    expect(c.models['csv:1']).toMatchObject({ name: 'Basic', type: 0 });
    expect(c.models['csv:2']).toMatchObject({ name: 'Cloze', type: 1, sortf: 0 });
    expect(c.models['csv:2'].tmpls.map((t) => t.qfmt)).toEqual(['{{cloze:Field 1}}']);
    expect(c.cards.filter((r) => r.nid === '2').map((r) => r.ord)).toEqual([0, 1]); // c1, c2
    expect(c.cards.filter((r) => r.nid === '1').map((r) => r.ord)).toEqual([0, 1]); // Basic: both directions, as before

    const plan = planImport(c, emptyLib(), csvChoices(c), ctx());
    const clozeType = plan.noteTypes.add.find((t) => t.name === 'Cloze') as NoteType;
    expect(clozeType.kind).toBe('cloze');
    const note = plan.notes.add.find((n) => n.typeId === clozeType.id) as Note;
    const cards = plan.cards.add.filter((x) => x.noteId === note.id);
    expect(cards.map((x) => x.ord)).toEqual([0, 1]);
    const c1 = renderFace(note, clozeType, 0);
    expect(c1.promptPlain).not.toContain('Berlin');
    expect(c1.promptPlain).not.toContain('{{c1::');
    expect(c1.promptPlain).toContain('Deutschland');
    expect(c1.answerPlain).toContain('Berlin');
    const c2 = renderFace(note, clozeType, 1);
    expect(c2.promptPlain).toContain('Berlin');
    expect(c2.promptPlain).not.toContain('Deutschland');
  });

  test('a plain CSV whose column holds cloze text in EVERY row is a cloze type; a mixed column stays text', () => {
    const all = readCsv('{{c1::Paris}} is in France\n{{c1::Rome}} is in {{c2::Italy}}', 'cloze.csv');
    expect(all.models[CSV_MODEL_ID].type).toBe(1);
    expect(all.cards.map((r) => [r.nid, r.ord])).toEqual([['1', 0], ['2', 0], ['2', 1]]);
    const mixed = readCsv('{{c1::Paris}},France\nRome,Italy', 'mixed.csv');
    expect(mixed.models[CSV_MODEL_ID].type).toBe(0);
    expect(clozeColumn('Cloze', [['plain', 'x']])).toBeUndefined();
    expect(clozeColumn('Cloze (German)', [['plain', 'x'], ['{{c3::a}}', 'y']])).toBe(0);
  });

  test('#html:true stores raw HTML; plain values are escaped as text', () => {
    expect(readCsv(EXPORT, 'e.txt').notes[0].flds[0]).toBe('<b>sagen</b>');
    const plain = readCsv('#html:false\n<b>a</b>,"x\ny & z"', 'p.csv');
    expect(plain.notes[0].flds).toEqual(['&lt;b&gt;a&lt;/b&gt;', 'x<br>y &amp; z']);
    expect(escapeCsvText('a\r\nb')).toBe('a<br>b');
  });

  test('#columns names the fields; #separator by name or character', () => {
    const c = readCsv('#separator:Pipe\n#columns:Front|Back|Tags\n#tags column:3\nHaus|house|noun a1', 'c.txt');
    expect(c.csv?.delimiter).toBe('|');
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Front', 'Back']);
    expect(c.csv?.header).toEqual(['Front', 'Back', 'Tags']);
    expect(c.notes[0]).toMatchObject({ flds: ['Haus', 'house'], tags: ['noun', 'a1'] });
    expect(c.csv).toMatchObject({ tagsCol: 2, tagsSpill: false, tagsSyntax: 'anki' });
    // An Anki export without "#tags column": a field named Tags stays a field (Anki's own rule).
    const noTagsCol = readCsv('#separator:Pipe\n#columns:Front|Back|Tags\nHaus|house|noun', 'c.txt');
    expect(noTagsCol.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Front', 'Back', 'Tags']);
    expect(noTagsCol.csv?.tagsCol).toBeUndefined();
    expect(readCsv('#separator:;\na;b', 'x.txt').notes[0].flds).toEqual(['a', 'b']);
    expect(readCsv('#separator:Semicolon\na;b', 'x.txt').csv?.delimiter).toBe(';');
  });

  test('#deck, #notetype and #tags give one value for every row', () => {
    const c = readCsv('#deck:Spanish::A1\n#notetype:Words\n#tags:es a1\ncasa,house', 'x.txt');
    expect(c.decks).toEqual({ '1': 'Spanish::A1' });
    expect(c.models[CSV_MODEL_ID].name).toBe('Words');
    expect(c.notes[0].tags).toEqual(['es', 'a1']);
  });

  test('a first data line that starts with # but is not a header stays data', () => {
    const c = readCsv('#hashtag,the symbol\nword,meaning', 'x.csv');
    expect(c.notes.map((n) => n.flds[0])).toEqual(['#hashtag', 'word']);
  });

  test('a header cell named "Tags" is the tags column (split on | ; ,); two such cells → none', () => {
    const c = readCsv('Word,Tags,Meaning\nHaus,home; building,house', 'x.csv');
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Word', 'Meaning']);
    expect(c.notes[0]).toMatchObject({ flds: ['Haus', 'house'], tags: ['home', 'building'] });
    expect(c.csv).toMatchObject({ header: ['Word', 'Tags', 'Meaning'], tagsCol: 1, tagsSpill: false, tagsSyntax: 'list' });
    expect(tagsHeaderColumn(['Front', 'Back', 'TAGS'])).toBe(2);
    expect(tagsHeaderColumn(['Word', 'Tags', 'tag'])).toBeUndefined();
    expect(readCsv('Word,Tags,tag\nHaus,a,b', 'x.csv').models[CSV_MODEL_ID].flds).toHaveLength(3);
    // The Fields screen can turn it back into a field ("Tags" → Show on back).
    const asField = readCsv('Word,Tags,Meaning\nHaus,home,house', 'x.csv', { tagsCol: null });
    expect(asField.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Word', 'Tags', 'Meaning']);
    expect(asField.csv?.tagsCol).toBeUndefined();
  });

  test('the Tags choice of the Fields screen (opts.tagsCol) turns a column into tags', () => {
    const c = readCsv('Word,Meaning,Topics\nHaus,house,home; building', 'x.csv', { tagsCol: 2 });
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Word', 'Meaning']);
    expect(c.notes[0].tags).toEqual(['home', 'building']);
    const none = readCsv('a,b,c,d,e', 'x.csv', { tagsCol: null });
    expect(none.models[CSV_MODEL_ID].flds).toHaveLength(5);
    expect(none.notes[0].tags).toEqual([]);
  });

  test('an empty file still has its deck and card type, and no notes', () => {
    const c = readCsv('', 'Empty.csv');
    expect(c.notes).toEqual([]);
    expect(c.decks).toEqual({ '1': 'Empty' });
    expect(Object.keys(c.models)).toEqual([CSV_MODEL_ID]);
  });
});

/* -------------------------------------------------------------- signature */

describe('CSV signature → one shared card type', () => {
  test('csvSignature folds names (and the card-type name for a notetype column)', () => {
    expect(csvSignature(['Word', 'Übersetzung'])).toBe('word|ubersetzung');
    expect(csvSignature(['Front'], 'Basic')).toBe('type:basic|front');
  });

  test('a second file with the same columns reuses the card type; other columns get a new one', () => {
    const first = readCsv('Word,Translation,Level\nHaus,house,A1', 'a.csv');
    const plan1 = planImport(first, emptyLib(), csvChoices(first), ctx('a'));
    expect(plan1.noteTypes.add).toHaveLength(1);
    expect(plan1.noteTypes.add[0].source).toEqual({ csvSignature: 'word|translation|level' });
    const lib: PlanLibrary = apply(emptyLib(), plan1);

    const same = readCsv('WORD,translation,Level\nBaum,tree,A2', 'b.csv');
    const plan2 = planImport(same, lib, csvChoices(same), ctx('b'));
    expect(plan2.noteTypes.add).toEqual([]);
    expect(plan2.noteTypes.reuse).toEqual({ [CSV_MODEL_ID]: plan1.noteTypes.add[0].id });
    expect(plan2.notes.add[0].typeId).toBe(plan1.noteTypes.add[0].id);

    const other = readCsv('Word,Translation,Type\nBaum,tree,noun', 'c.csv');
    const plan3 = planImport(other, lib, csvChoices(other), ctx('c'));
    expect(plan3.noteTypes.add).toHaveLength(1);
    expect(plan3.noteTypes.reuse).toEqual({});
  });

  test('the same sheet again with ANOTHER Front column finds its rows (already here), not 3 new ones', () => {
    const text = 'Word,Translation,Level\nHaus,house,A1\nBaum,tree,A1\nStunde,hour,A2';
    const c = readCsv(text, 'w.csv');
    const plan1 = planImport(c, emptyLib(), csvChoices(c), ctx('a'));
    const lib = apply(emptyLib(), plan1);
    const deckId = (plan1.deck as Deck).id;
    // Fields stage: Front = Translation, Back = Word (a new card type: another mapping).
    const roles = (c2: ReturnType<typeof readCsv>) => {
      const ch = csvChoices(c2, { target: { kind: 'existing', deckId } });
      ch.types[CSV_MODEL_ID].fields = ch.types[CSV_MODEL_ID].fields.map((f) =>
        f.name === 'Translation' ? { ...f, role: 'term' } : f.name === 'Word' ? { ...f, role: 'meaning' } : f,
      );
      return ch;
    };
    const again = planImport(c, lib, roles(c), ctx('b'));
    expect(again.summary).toMatchObject({ notesAdded: 0, skipped: { alreadyHere: 3, elsewhere: 0, overlap: 0, empty: 0 } });
    // A row that is really new is still added.
    const more = readCsv(`${text}\nTisch,table,A1`, 'w.csv');
    expect(planImport(more, lib, roles(more), ctx('c')).summary).toMatchObject({ notesAdded: 1 });
  });

  test('the same sheet again with one more column finds its rows (a new signature, the same Front)', () => {
    const c = readCsv('Word,Translation\nHaus,house\nBaum,tree\nStunde,hour', 'w.csv');
    const plan1 = planImport(c, emptyLib(), csvChoices(c), ctx('a'));
    const lib = apply(emptyLib(), plan1);
    const deckId = (plan1.deck as Deck).id;
    const wider = readCsv('Word,Translation,Level\nHaus,house,A1\nBaum,tree,A1\nStunde,hour,A2\nTisch,table,A1', 'w.csv');
    const plan2 = planImport(wider, lib, csvChoices(wider, { target: { kind: 'existing', deckId } }), ctx('b'));
    expect(plan2.summary).toMatchObject({ notesAdded: 1, skipped: { alreadyHere: 3, elsewhere: 0, overlap: 0, empty: 0 } });
    expect(plan2.notes.add.map((n) => n.fields[0])).toEqual(['Tisch']);
  });

  test('no header: a file of the same width reuses the card type only with the same mapping', () => {
    const a = readCsv('Haus,house,der Haushalt', 'a.csv');
    const plan1 = planImport(a, emptyLib(), csvChoices(a), ctx('a'));
    const lib = apply(emptyLib(), plan1);
    const typeA = plan1.noteTypes.add[0];

    // Unchanged roles → the same card type.
    const b = readCsv('Baum,tree,A2', 'b.csv');
    expect(planImport(b, lib, csvChoices(b), ctx('b')).noteTypes.reuse).toEqual({ [CSV_MODEL_ID]: typeA.id });

    // Column 3 set to "Filter" on the Fields screen → a NEW card type with that role (the choice is not ignored).
    const filter = csvChoices(b);
    const defs = filter.types[CSV_MODEL_ID].fields;
    defs[2] = { ...defs[2], role: 'badge', facet: 'on' };
    const plan2 = planImport(b, lib, filter, ctx('c'));
    expect(plan2.noteTypes.reuse).toEqual({});
    expect(plan2.noteTypes.add).toHaveLength(1);
    expect(plan2.noteTypes.add[0].fields[2]).toMatchObject({ role: 'badge', facet: 'on' });
    expect(plan2.noteTypes.add[0].source).toEqual(typeA.source); // same columns, same signature
    expect(plan2.notes.add[0].typeId).toBe(plan2.noteTypes.add[0].id);

    // A later file with the same "Filter" mapping finds that second type.
    const lib2 = apply(lib, plan2);
    expect(findReusableType(b, CSV_MODEL_ID, lib2.noteTypes, filter.types[CSV_MODEL_ID])?.id).toBe(plan2.noteTypes.add[0].id);
    // Without a choice (the Fields screen asking where to start): the first type with these columns.
    expect(findReusableType(b, CSV_MODEL_ID, lib2.noteTypes)?.id).toBe(typeA.id);

    // a.csv again into its own deck with the new mapping (in the library of the first import only): no type
    // can be reused, so the plan makes a new one, but the row is still "already here" (same columns).
    const again = planImport(a, lib, { ...filter, target: { kind: 'existing', deckId: lib.decks[0].id } }, ctx('d'));
    expect(again.summary.skipped.alreadyHere).toBe(1);
    expect(again.notes.add).toEqual([]);
    expect(again.noteTypes.add).toEqual([]); // a new type that no note uses is not added
  });
});

/* ------------------------------------------------------------------- H2 */

describe('H2: names from the file like "constructor" or "__proto__"', () => {
  test('#separator:<a built-in method name> is not a separator from Object (the delimiter stays text)', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const c = readCsv(`#separator:${name}\nHaus,house`, 'x.txt');
      expect(typeof c.csv?.delimiter).toBe('string');
      expect(c.csv?.delimiter).toHaveLength(1);
      expect(c.notes).toHaveLength(1);
    }
    expect(readCsv('#separator:Tab\nHaus\thouse', 'x.txt').notes[0].flds).toEqual(['Haus', 'house']);
  });

  test('header cells named "__proto__" / "constructor" are ordinary field names', () => {
    const c = readCsv('Word,__proto__,constructor\nHaus,house,x', 'x.csv', { header: true });
    expect(c.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Word', '__proto__', 'constructor']);
    expect(c.notes[0].flds).toEqual(['Haus', 'house', 'x']);
    expect(c.models[CSV_MODEL_ID].tmpls[0]).toMatchObject({ qfmt: '{{Word}}' });
    expect(csvSignature(c.models[CSV_MODEL_ID].flds.map((f) => f.name))).toBe('word|__proto__|constructor');
  });

  test('models, decks and media have no prototype, like the .apkg reader', () => {
    const c = readCsv('#notetype column:3\n#deck column:4\nHaus,house,__proto__,constructor', 'x.txt');
    for (const record of [c.models, c.decks, c.media]) expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.values(c.models).map((m) => m.name)).toEqual(['__proto__']);
    expect(Object.values(c.decks)).toEqual(['constructor']);
    expect(c.models['toString']).toBeUndefined();
  });
});
