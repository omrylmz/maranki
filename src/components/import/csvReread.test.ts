/**
 * Tests for src/components/import/csvReread.ts: a CSV read again ("Tags" on a
 * column, "Not tags", "First row is a header") keeps the learner's column
 * choices (unit A5, W3-5 hardening; review round 1).
 *
 * Every test reads a real CSV text with csvRead.ts `readCsv` and takes the
 * fresh guess from plan.ts `startingTypes` (as import.tsx does), so the field
 * names and the file columns are the real ones. The main case is a file
 * WITHOUT a header: its fields are named by position ("Field 1" …), so a
 * middle tags column renames every later field.
 */
import { describe, expect, test } from '@jest/globals';

import { readCsv } from '../../domain/import/csvRead';
import { startingTypes } from '../../domain/import/plan';
import { csvColumnRole, csvFieldColumns, setCsvColumnRole, setFieldLang } from '../../domain/importFile';
import type { AnkiCollection, FieldDef } from '../../domain/model';
import { suggestMapping } from '../../domain/roles';
import { carryFieldChoices, csvFieldSources } from './csvReread';

/** The fresh starts of a collection, as the import screen makes them. */
const startsOf = (c: AnkiCollection) => startingTypes(c, suggestMapping(c), []);
/** "name=column choice" for every field (the words of the Fields stage). */
const choices = (fields: readonly FieldDef[]) => fields.map((f) => `${f.name}=${csvColumnRole(f)}`);
/** The tags of every row of the file (the tags column was read). */
const tagsOf = ({ notes: rows }: AnkiCollection) => rows.map((row) => row.tags);

/** No header, 5 columns: word, meaning, level, word type, topic. */
const HEADERLESS = 'Haus,house,A1,noun,home\nAuto,car,A2,noun,road\nlaufen,run,A1,verb,sport';

describe('csvFieldSources — the file column and header cell of every field', () => {
  test('no header: the column, and null for the header cell', () => {
    const c = readCsv(HEADERLESS, 'w.csv', { tagsCol: 2 });
    expect(csvFieldSources(c, 4)).toEqual([
      { column: 0, head: null },
      { column: 1, head: null },
      { column: 3, head: null },
      { column: 4, head: null },
    ]);
  });

  test('a header: the header cell of each field column (the tags column is left out)', () => {
    const c = readCsv('Word,Tags,Meaning\nHaus,home,house', 'w.csv');
    expect(csvFieldSources(c, 2)).toEqual([
      { column: 0, head: 'Word' },
      { column: 2, head: 'Meaning' },
    ]);
  });
});

describe('carryFieldChoices — a file WITHOUT a header (fields named by position)', () => {
  test('"Tags" on a middle column: an Ignored column stays Ignore, a new column gets the fresh guess', () => {
    const first = readCsv(HEADERLESS, 'w.csv');
    const [start] = startsOf(first);
    expect(choices(start.fields)).toEqual(['Field 1=front', 'Field 2=back', 'Field 3=example', 'Field 4=showOnBack']);
    // The learner: column 1 is the Front, column 3 ("noun") is ignored, and a reverse card.
    let fields = setCsvColumnRole(start.fields, 1, 'front');
    fields = setCsvColumnRole(fields, 3, 'ignore');
    const edited = [{ ...start, fields, ords: [0, 1] }];

    // "Tags" on Field 3 (column 2, "A1"): the file is read again.
    const column = csvFieldColumns(first, start.fields.length)[2];
    expect(column).toBe(2);
    const again = readCsv(HEADERLESS, 'w.csv', { tagsCol: column });
    const fresh = startsOf(again);
    // The fresh read names column 3 "Field 3" and column 4 "Field 4" (positions moved).
    expect(csvFieldColumns(again, fresh[0].fields.length)).toEqual([0, 1, 3, 4]);

    const [carried] = carryFieldChoices({ collection: first, types: edited }, { collection: again, types: fresh });
    expect(choices(carried.fields)).toEqual([
      'Field 1=back', // column 0
      'Field 2=front', // column 1: still the Front
      'Field 3=ignore', // column 3 ("noun"): still Ignore, NOT the old "Field 3" choice (Example)
      'Field 4=showOnBack', // column 4 ("home"): new to the Fields stage → the fresh guess
    ]);
    expect(carried.fields[3]).toEqual(fresh[0].fields[3]);
    expect(carried.ords).toEqual([0, 1]);
    expect(tagsOf(again)).toEqual([['A1'], ['A2'], ['A1']]);
  });

  test('"Not tags" after a middle Tags column: every column keeps its choice, the old tags column gets the guess', () => {
    const tagged = readCsv(HEADERLESS, 'w.csv', { tagsCol: 2 });
    const [start] = startsOf(tagged);
    // Fields: column 0, 1, 3, 4. The learner: column 1 Front, column 3 Ignore, column 4 Filter.
    let fields = setCsvColumnRole(start.fields, 1, 'front');
    fields = setCsvColumnRole(fields, 2, 'ignore');
    fields = setCsvColumnRole(fields, 3, 'filter');
    const edited = [{ ...start, fields }];

    const again = readCsv(HEADERLESS, 'w.csv', { tagsCol: null });
    const fresh = startsOf(again);
    expect(csvFieldColumns(again, fresh[0].fields.length)).toEqual([0, 1, 2, 3, 4]);

    const [carried] = carryFieldChoices({ collection: tagged, types: edited }, { collection: again, types: fresh });
    expect(choices(carried.fields)).toEqual([
      'Field 1=back', // column 0
      'Field 2=front', // column 1
      'Field 3=example', // column 2 (the old tags column): the fresh guess
      'Field 4=ignore', // column 3: was "Field 3" before, still Ignore
      'Field 5=filter', // column 4: was "Field 4" before, still a Filter
    ]);
    // The name is always the fresh one (the card type's field names).
    expect(carried.fields.map((f) => f.name)).toEqual(fresh[0].fields.map((f) => f.name));
  });

  test('multiSep stays with its column, never with the field that took the old name', () => {
    const tagged = readCsv(HEADERLESS, 'w.csv', { tagsCol: 1 });
    // Fields: column 0, 2, 3, 4 ("Field 1" … "Field 4"). Column 3 is a filter whose cells hold several values.
    const before = [
      {
        mid: startsOf(tagged)[0].mid,
        fields: [
          { name: 'Field 1', role: 'term', facet: 'off' },
          { name: 'Field 2', role: 'meaning', facet: 'off' },
          { name: 'Field 3', role: 'badge', facet: 'on', multiSep: ',' },
          { name: 'Field 4', role: 'detail', facet: 'auto' },
        ] satisfies FieldDef[],
        ords: [0],
      },
    ];
    const again = readCsv(HEADERLESS, 'w.csv', { tagsCol: null });
    const fresh = startsOf(again);
    const [carried] = carryFieldChoices({ collection: tagged, types: before }, { collection: again, types: fresh });
    // Column 2 is "Field 3" now, but it is the old "Field 2": no multiSep.
    expect(carried.fields[2]).toEqual({ name: 'Field 3', role: 'meaning', facet: 'off' });
    // Column 3 ("Field 4" now) is the old filter: its multiSep stays with it.
    expect(carried.fields[3]).toEqual({ name: 'Field 4', role: 'badge', facet: 'on', multiSep: ',' });
    // The new field the guess made the Back (column 1) gives way to the kept Back.
    expect(choices(carried.fields)).toEqual(['Field 1=front', 'Field 2=showOnBack', 'Field 3=back', 'Field 4=filter', 'Field 5=showOnBack']);

    // The fresh read of the same column decides multiSep first (it is a fact about the values).
    const freshSep = [{ ...fresh[0], fields: fresh[0].fields.map((f, i) => (i === 3 ? { ...f, role: 'badge' as const, multiSep: ';' as const } : f)) }];
    const [again2] = carryFieldChoices({ collection: tagged, types: before }, { collection: again, types: freshSep });
    expect(again2.fields[3].multiSep).toBe(';');
    // A carried field that is not a filter never gets a multiSep, even when the fresh guess has one.
    const freshDetailSep = [{ ...fresh[0], fields: fresh[0].fields.map((f, i) => (i === 4 ? { ...f, role: 'badge' as const, multiSep: ',' as const } : f)) }];
    const [again3] = carryFieldChoices({ collection: tagged, types: before }, { collection: again, types: freshDetailSep });
    expect(again3.fields[4]).toEqual({ name: 'Field 5', role: 'detail', facet: 'auto' });
  });
});

describe('carryFieldChoices — a file WITH a header', () => {
  const text = 'Word,Meaning,Level,Topic\nHaus,house,A1,home\nAuto,car,A2,road\nBaum,tree,A1,nature';

  test('a column chosen as Tags: every other choice and the reverse card stay', () => {
    const first = readCsv(text, 'w.csv');
    const [start] = startsOf(first);
    expect(choices(start.fields).slice(0, 2)).toEqual(['Word=front', 'Meaning=back']);
    // The learner: Meaning is the Front, Level is shown on the back with a label, a reverse card, Meaning read in English.
    let fields = setCsvColumnRole(start.fields, 1, 'front');
    fields = setCsvColumnRole(fields, 2, 'showOnBack');
    fields = setFieldLang(fields, 1, 'en-US').map((f) => (f.name === 'Level' ? { ...f, label: 'CEFR' } : f));
    const edited = [{ ...start, fields, ords: [0, 1] }];

    // "Topic" → Tags: the file is read again (a fresh guess), then the choices are carried over.
    const column = csvFieldColumns(first, start.fields.length)[3];
    const again = readCsv(text, 'w.csv', { tagsCol: column });
    const fresh = startsOf(again);
    expect(choices(fresh[0].fields)[0]).toBe('Word=front'); // the fresh guess alone would reset the Front
    const [carried] = carryFieldChoices({ collection: first, types: edited }, { collection: again, types: fresh });
    expect(choices(carried.fields)).toEqual(['Word=back', 'Meaning=front', 'Level=showOnBack']);
    expect(carried.fields[1].lang).toBe('en-US');
    expect(carried.fields[2]).toEqual({ name: 'Level', label: 'CEFR', role: 'detail', facet: 'off' });
    expect(carried.ords).toEqual([0, 1]);
    expect(carried.reused).toBe(fresh[0].reused);
    expect(tagsOf(again)[0]).toEqual(['home']);
  });

  test('the Front column chosen as Tags: Front and Back start again from the fresh guess, the rest stays', () => {
    const h = 'Word,Meaning,Level,Note\nHaus,house,A1,x\nAuto,car,A2,y\nBaum,tree,A1,z';
    const first = readCsv(h, 'w.csv');
    const [start] = startsOf(first);
    let fields = setCsvColumnRole(start.fields, 1, 'front'); // Word = Back, Meaning = Front
    fields = setCsvColumnRole(fields, 2, 'showOnBack').map((f) => (f.name === 'Level' ? { ...f, label: 'CEFR' } : f));
    fields = setCsvColumnRole(fields, 3, 'ignore');
    const edited = [{ ...start, fields, ords: [0, 1] }];

    // "Meaning" (the Front) becomes the tags column.
    const again = readCsv(h, 'w.csv', { tagsCol: 1 });
    const fresh = startsOf(again);
    expect(choices(fresh[0].fields)).toEqual(['Word=front', 'Level=back', 'Note=showOnBack']);
    const [carried] = carryFieldChoices({ collection: first, types: edited }, { collection: again, types: fresh });
    expect(choices(carried.fields)).toEqual(['Word=front', 'Level=back', 'Note=ignore']);
    expect(carried.fields[1].label).toBe('CEFR');
    expect(carried.ords).toEqual([0, 1]);
    // Exactly one Front and one Back.
    expect(carried.fields.filter((f) => f.role === 'term')).toHaveLength(1);
    expect(carried.fields.filter((f) => f.role === 'meaning')).toHaveLength(1);
  });

  test('a kept Front wins over a new field that the fresh guess made the Front', () => {
    const h = 'New,A,B\nx,y,z\nx2,y2,z2';
    const tagged = readCsv(h, 'w.csv', { header: true, tagsCol: 0 });
    const [start] = startsOf(tagged);
    const before = [{ ...start, fields: setCsvColumnRole(start.fields, 1, 'front') }]; // A = Back, B = Front
    expect(choices(before[0].fields)).toEqual(['A=back', 'B=front']);
    const again = readCsv(h, 'w.csv', { header: true, tagsCol: null });
    const fresh = startsOf(again);
    expect(choices(fresh[0].fields)[0]).toBe('New=front');
    const [carried] = carryFieldChoices({ collection: tagged, types: before }, { collection: again, types: fresh });
    expect(choices(carried.fields)).toEqual(['New=showOnBack', 'A=back', 'B=front']);
  });
});

describe('carryFieldChoices — "First row is a header" starts every field again', () => {
  test('header on or off: the fields are the fresh guess; the directions stay', () => {
    const noHeader = readCsv(HEADERLESS, 'w.csv', { header: false });
    const header = readCsv(HEADERLESS, 'w.csv', { header: true });
    const [start] = startsOf(noHeader);
    const edited = [{ ...start, fields: setCsvColumnRole(start.fields, 1, 'front'), ords: [0, 1] }];
    const fresh = startsOf(header);
    const [carried] = carryFieldChoices({ collection: noHeader, types: edited }, { collection: header, types: fresh });
    expect(carried.fields).toEqual(fresh[0].fields);
    // The directions are a choice of the card type, not of a field: they stay.
    expect(carried.ords).toEqual([0, 1]);

    // And back: header off again.
    const [back] = carryFieldChoices(
      { collection: header, types: [{ ...fresh[0], fields: setCsvColumnRole(fresh[0].fields, 1, 'front') }] },
      { collection: noHeader, types: startsOf(noHeader) },
    );
    expect(back.fields).toEqual(start.fields);
  });

  test('a header row that LOOKS like the positional names ("Field 1" …) still starts again', () => {
    const text = 'Field 1,Field 2,Field 3\nHaus,house,A1\nAuto,car,A2';
    const noHeader = readCsv(text, 'w.csv', { header: false });
    const header = readCsv(text, 'w.csv', { header: true });
    const [start] = startsOf(noHeader);
    const edited = [{ ...start, fields: setCsvColumnRole(start.fields, 2, 'ignore') }];
    const fresh = startsOf(header);
    expect(fresh[0].fields.map((f) => f.name)).toEqual(['Field 1', 'Field 2', 'Field 3']); // the same names …
    const [carried] = carryFieldChoices({ collection: noHeader, types: edited }, { collection: header, types: fresh });
    expect(carried.fields).toEqual(fresh[0].fields); // … but a different source (the header cell)
  });

  test('a card type that was not there before is the fresh guess as it is', () => {
    const c = readCsv(HEADERLESS, 'w.csv');
    const fresh = startsOf(c);
    expect(carryFieldChoices({ collection: c, types: [] }, { collection: c, types: fresh })).toEqual(fresh);
  });
});
