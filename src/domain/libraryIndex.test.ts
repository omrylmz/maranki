/**
 * The library index (spec §4.4) and the "which fields are filter groups"
 * rule (spec §4.3 rules 1–2, `fieldFacetSpecs`).
 *
 * Notes and card types are built with the shared v3 constructors (makeV3,
 * builtinTypes), so they look exactly like objects the app makes.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW as NOW } from '../test/clock';
import { builtinType } from './builtinTypes';
import { htmlToPlain } from './htmlLines';
import { foldText } from './text';
import {
  buildCardLookup,
  buildLibraryIndex,
  cardLookupMemo,
  FACET_MAX_LENGTH,
  FACET_MAX_VALUES,
  fieldFacetSpecs,
  fieldKey,
  fieldValues,
  foldPath,
  foldTag,
  LABEL_NOTES_PER_STOP,
  libraryIndexMemo,
  normalizeTag,
  pathPrefixes,
  plainText,
} from './libraryIndex';
import { makeCard, makeNote } from './makeV3';
import type { FieldDef, Note, NoteType } from './model';
import { DEFAULT_SRS } from './types';

/** A standard card type with these fields (all 'auto' unless a FieldDef is given). */
function cardType(id: string, fields: (string | Partial<FieldDef> & { name: string })[]): NoteType {
  return {
    id,
    name: id,
    kind: 'standard',
    fields: fields.map((f) => (typeof f === 'string' ? { name: f, role: 'detail', facet: 'auto' } : { role: 'detail', facet: 'auto', ...f })),
    templates: [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1] }],
    sortField: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let noteSeq = 0;
/** A note of `typeId` with these field values. */
function note(typeId: string, fields: string[], extra: Partial<Note> = {}): Note {
  noteSeq += 1;
  return makeNote({ id: `n${noteSeq}`, typeId, fields, ...extra }, NOW);
}

/** `count` notes whose field 1 cycles through `values` (field 0 is a unique word). */
function notesWithValues(typeId: string, values: string[], count: number): Note[] {
  return Array.from({ length: count }, (_, i) => note(typeId, [`word ${i}`, values[i % values.length]]));
}

describe('plainText', () => {
  it('removes tags; block tags separate words, inline tags do not', () => {
    expect(plainText('<div>Wir haben kein <b>Bad</b>.</div>')).toBe('Wir haben kein Bad.');
    expect(plainText('die <b>St</b>unde')).toBe('die Stunde');
    expect(plainText('eins<br>zwei<br/>drei')).toBe('eins zwei drei');
  });

  it('decodes entities and collapses white space', () => {
    expect(plainText('A&nbsp;&amp;&nbsp;B &lt;x&gt; &#252; &#xFC;')).toBe('A & B <x> ü ü');
    expect(plainText('  a \n\t b  ')).toBe('a b');
  });

  it('decodes every entity the card decodes, with the renderer’s own decoder (search finds what the card shows)', () => {
    // The real Algo_Patterns deck: &times; &sum; &rarr; &ge; &sup2;. German text pasted as HTML: &auml; &Uuml; &szlig;.
    for (const raw of [
      '<code>f[n] = &sum; f[i] &times; f[n-2-i]</code>',
      'O(n&sup2;) a &rarr; b, x &ge; y',
      '&auml;rger &Uuml;bung Stra&szlig;e &euro; 5 &rsquo;',
    ]) {
      expect({ raw, search: plainText(raw) }).toEqual({ raw, search: htmlToPlain(raw) });
    }
    expect(plainText('&auml;rger &Uuml;bung')).toBe('ärger Übung');
    expect(plainText('2 &times; 3')).toBe('2 × 3');
    // Folded for search: "arger" finds "&auml;rger"; "auml" does not.
    expect(foldText(plainText('&auml;rger'))).toBe('arger');
    // An unknown name stays as written, on the card and in search.
    expect(plainText('a &zzz; b')).toBe('a &zzz; b');
  });

  it('keeps cloze answers and drops sound tokens', () => {
    expect(plainText('{{c1::Berlin::capital}} is in {{c2::Germany}}')).toBe('Berlin is in Germany');
    expect(plainText('Hallo [sound:hallo.mp3]')).toBe('Hallo');
  });

  it('reads nested and multi-number clozes with the shared cloze parser (cloze.ts)', () => {
    // The old private reader stopped at the first '}}' and kept '{{c1,2::' as text.
    expect(plainText('{{c1::a {{c2::b}} c}}')).toBe('a b c');
    expect(plainText('{{c1,2::Berlin}} ist die Hauptstadt')).toBe('Berlin ist die Hauptstadt');
  });

  it('a "<" without a closing ">" is text', () => {
    expect(plainText('a < b')).toBe('a < b');
  });

  it('a "<" that starts no tag is text, like in an HTML parser (space, digit, "=")', () => {
    expect(plainText('a < b and c > d')).toBe('a < b and c > d');
    // A note typed in the app (raw text, spec §3.4): every word stays searchable.
    expect(plainText('topic alpha: while i < j and arr[i] > t')).toBe('topic alpha: while i < j and arr[i] > t');
    expect(plainText('<3 and x <= 2 > 1')).toBe('<3 and x <= 2 > 1');
    // Real tags still go, also right after such a '<'.
    expect(plainText('a < b <b>bold</b> c')).toBe('a < b bold c');
    expect(plainText('x<!-- note -->y</i>z')).toBe('xyz');
  });

  it('runs in linear time: 200,000 "<" characters in well under a second', () => {
    const evil = '<'.repeat(200_000);
    const start = Date.now();
    plainText(evil);
    plainText('< '.repeat(100_000));
    plainText('<a'.repeat(100_000));
    plainText(`{{c1::${'::'.repeat(100_000)}`);
    plainText(`[sound:${'x'.repeat(200_000)}`);
    expect(Date.now() - start).toBeLessThan(500);
    expect(plainText(evil)).toBe(evil);
  });
});

describe('names, paths and values', () => {
  it('fieldKey folds and collapses: "Example  Translation" → "example translation"', () => {
    expect(fieldKey('Example  Translation')).toBe('example translation');
    expect(fieldKey('Präteritum')).toBe('prateritum');
  });

  it('foldPath trims each part; pathPrefixes lists every parent', () => {
    expect(foldPath(' Verbs :: B1 ')).toBe('verbs::b1');
    expect(pathPrefixes('a::b::c')).toEqual(['a', 'a::b', 'a::b::c']);
    expect(pathPrefixes('')).toEqual([]);
  });

  it('normalizeTag / foldTag clean a tag like a path and collapse white space', () => {
    expect(normalizeTag('Algo::')).toBe('Algo');
    expect(normalizeTag(' Algo :: Topic  Alpha ')).toBe('Algo::Topic Alpha');
    expect(normalizeTag('::')).toBe('');
    expect(foldTag('Über :: Straße_Zwei')).toBe('uber::strasse_zwei');
    expect(foldTag(foldTag('A :: B'))).toBe(foldTag('A :: B'));
  });

  it('fieldValues splits a multi-value field and drops duplicates', () => {
    expect(fieldValues('regular, Separable, regular', ',')).toEqual({
      display: ['regular', 'Separable'],
      folded: ['regular', 'separable'],
    });
    expect(fieldValues('<b>B1</b>')).toEqual({ display: ['B1'], folded: ['b1'] });
    expect(fieldValues('   ')).toEqual({ display: [], folded: [] });
  });
});

describe('fieldFacetSpecs — the data rule', () => {
  it('a field with few repeated short values is a group; a unique word field is not', () => {
    const type = cardType('t', ['Word', 'Level']);
    const notes = notesWithValues('t', ['A1', 'A2', 'B1'], 30);
    const specs = fieldFacetSpecs([type], notes);
    expect([...specs.keys()]).toEqual(['level']);
    expect(specs.get('level')).toMatchObject({ key: 'level', label: 'Level', forced: false });
    expect(specs.get('level')?.fieldIndexByType.get('t')).toBe(1);
  });

  it(`≤ ${FACET_MAX_VALUES} distinct values: 24 passes, 25 fails`, () => {
    const type = cardType('t', ['Word', 'Code']);
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    expect(fieldFacetSpecs([type], notesWithValues('t', values(24), 96)).has('code')).toBe(true);
    expect(fieldFacetSpecs([type], notesWithValues('t', values(25), 100)).has('code')).toBe(false);
  });

  it('≥ 50% filled: exactly half passes, less fails', () => {
    const type = cardType('t', ['Word', 'Level']);
    const half = [...notesWithValues('t', ['A1', 'B1'], 10), ...notesWithValues('t', [''], 10)];
    expect(fieldFacetSpecs([type], half).has('level')).toBe(true);
    const less = [...notesWithValues('t', ['A1', 'B1'], 9), ...notesWithValues('t', [''], 11)];
    expect(fieldFacetSpecs([type], less).has('level')).toBe(false);
  });

  it(`no value longer than ${FACET_MAX_LENGTH} characters (HTML does not count)`, () => {
    const type = cardType('t', ['Word', 'Note']);
    const ok = 'x'.repeat(FACET_MAX_LENGTH);
    expect(fieldFacetSpecs([type], notesWithValues('t', [`<b>${ok}</b>`, 'short'], 10)).has('note')).toBe(true);
    expect(fieldFacetSpecs([type], notesWithValues('t', [`${ok}y`, 'short'], 10)).has('note')).toBe(false);
  });

  it('values must repeat: 10 notes with 10 different values is not a group', () => {
    const type = cardType('t', ['Word', 'Level']);
    const unique = Array.from({ length: 10 }, (_, i) => `L${i}`);
    expect(fieldFacetSpecs([type], notesWithValues('t', unique, 10)).has('level')).toBe(false);
    expect(fieldFacetSpecs([type], notesWithValues('t', unique.slice(0, 5), 10)).has('level')).toBe(true);
    // An id column (1 … 20, every value once) is not a group either.
    const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
    expect(fieldFacetSpecs([cardType('t', ['Word', 'Nr'])], notesWithValues('t', ids, 20)).has('nr')).toBe(false);
  });

  it('a small category column is a group, as spec rule 1 says (8 notes, 5 values)', () => {
    // Arrays, Graphs, Trees twice; DP, Strings once: 2 one-off values of 8 notes.
    const type = cardType('t', ['Front', 'Category']);
    const categories = ['Arrays', 'Graphs', 'Trees', 'DP', 'Strings'];
    expect(fieldFacetSpecs([type], notesWithValues('t', categories, 8)).has('category')).toBe(true);
    // Most values one-offs → not a group: 10 notes, 8 values, 2 of them used twice
    // (like German Verbs `CaseInfo` in the 20-note sample: 6 one-offs of 10).
    const mostlyOneOffs = ['+ Akk', '+ Dat', 'a', 'b', 'c', 'd', 'e', 'f', '+ Akk', '+ Dat'];
    expect(fieldFacetSpecs([type], notesWithValues('t', mostlyOneOffs, 10)).has('category')).toBe(false);
    // Exactly half of the notes with a one-off value still passes: 3, 1, 1, 1 over 6 notes.
    expect(fieldFacetSpecs([type], notesWithValues('t', ['x', 'y', 'x', 'z', 'x', 'w'], 6)).has('category')).toBe(true);
  });

  it('a real level column on a small deck stays a group: 11 notes, 6 CEFR levels', () => {
    // A1 … C1 twice and C2 once: 6 values over 11 notes (1 one-off).
    const type = cardType('t', ['Word', 'Level']);
    const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'A1', 'A2', 'B1', 'B2', 'C1'];
    expect(fieldFacetSpecs([type], notesWithValues('t', levels, 11)).has('level')).toBe(true);
    // A normal (not ordinal) field with the same shape is a group too (spec rule 1).
    const words = ['red', 'green', 'blue', 'pink', 'gray', 'teal', 'red', 'green', 'blue', 'pink', 'gray'];
    expect(fieldFacetSpecs([cardType('c', ['Word', 'Color'])], notesWithValues('c', words, 11)).has('color')).toBe(true);
  });

  it('an ordinal column needs only one value that repeats: 7 notes, 6 CEFR levels', () => {
    // A1 twice, A2 … C2 once: 5 one-offs of 7 notes, too many for a normal column.
    const type = cardType('t', ['Word', 'Level']);
    const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'A1'];
    expect(fieldFacetSpecs([type], notesWithValues('t', levels, 7)).has('level')).toBe(true);
    // Other ordinal kinds too ("Unit 2"-like), but only when some value repeats.
    const units = ['Unit 1', 'Unit 2', 'Unit 3', 'Unit 4', 'Unit 1'];
    expect(fieldFacetSpecs([cardType('u', ['Word', 'Unit'])], notesWithValues('u', units, 5)).has('unit')).toBe(true);
    expect(fieldFacetSpecs([cardType('u', ['Word', 'Unit'])], notesWithValues('u', units.slice(0, 4), 4)).has('unit')).toBe(false);
    // A normal (not ordinal) field with the same shape is not a group.
    const words = ['red', 'green', 'blue', 'pink', 'gray', 'teal', 'red'];
    expect(fieldFacetSpecs([cardType('c', ['Word', 'Color'])], notesWithValues('c', words, 7)).has('color')).toBe(false);
  });

  it('multi-value: 84 raw values that split into 20 tokens (German Verbs `Tags`)', () => {
    const tokens = Array.from({ length: 20 }, (_, i) => `t${i}`);
    // 84 distinct raw values, each a pair "ti, tj" (i < j), using all 20 tokens.
    const raw: string[] = [];
    for (let i = 0; i < 20 && raw.length < 84; i++) {
      for (let j = i + 1; j < 20 && raw.length < 84; j++) raw.push(`${tokens[i]}, ${tokens[j]}`);
    }
    expect(new Set(raw).size).toBe(84);
    expect(new Set(raw.flatMap((r) => r.split(', '))).size).toBe(20);
    const type = cardType('verbs', ['Verb', 'Tags']);
    const specs = fieldFacetSpecs([type], notesWithValues('verbs', raw, 168));
    expect(specs.get('tags')).toMatchObject({ key: 'tags', multiSep: ',', forced: false });
  });

  it('multi-value needs > 1.2 tokens per value on average', () => {
    const type = cardType('t', ['Word', 'Kind']);
    const tokens = Array.from({ length: 22 }, (_, i) => `k${i}`);
    // 22 single values + `pairs` two-token values: > 24 raw values, so the
    // single-value rule fails; 22 tokens, so only the average decides.
    const raw = (pairs: number) => [...tokens, ...tokens.slice(0, pairs).map((t, i) => `${t}, ${tokens[i + 1]}`)];
    // 3 pairs: (44 + 12) tokens / 50 values = 1.12 → not a group.
    expect(fieldFacetSpecs([type], notesWithValues('t', raw(3), 50)).has('kind')).toBe(false);
    // 10 pairs: (44 + 40) tokens / 64 values = 1.31 → a multi-value group.
    expect(fieldFacetSpecs([type], notesWithValues('t', raw(10), 64)).get('kind')?.multiSep).toBe(',');
  });

  it('list values are split on a small deck too (few raw values), a few commas are not', () => {
    // 6 raw values (≤ 24), but they are lists: 10 tokens / 6 values = 1.67 → split.
    const type = cardType('t', ['Word', 'Topics']);
    const lists = ['food, home', 'home', 'food, work', 'work, home', 'food', 'home, work'];
    expect(fieldFacetSpecs([type], notesWithValues('t', lists, 6)).get('topics')?.multiSep).toBe(',');
    // One comma in 10 values: 11 tokens / 10 values = 1.1 → one value per note.
    const few = ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'A, B'];
    const spec = fieldFacetSpecs([type], notesWithValues('t', few, 10)).get('topics');
    expect(spec).toBeDefined();
    expect(spec?.multiSep).toBeUndefined();
  });

  it('a token counts once per note ("x, x" is one use of x)', () => {
    // 4 notes, every token on one note only (doubled inside it): not a group.
    const type = cardType('t', ['Word', 'Topics']);
    const doubled = ['a, a', 'b, b', 'c, c', 'd, d'];
    expect(fieldFacetSpecs([type], notesWithValues('t', doubled, 4)).has('topics')).toBe(false);
  });

  it('the same folded name in several card types is ONE group', () => {
    const vocab = cardType('vocab', ['Word', 'Level']);
    const verbs = cardType('verbs', ['Verb', 'Meaning', { name: 'LEVEL ' }]);
    const verbNotes = Array.from({ length: 10 }, (_, i) => note('verbs', [`verb ${i}`, `meaning ${i}`, i % 2 ? 'B1' : 'A1']));
    const notes = [...notesWithValues('vocab', ['A1', 'A2'], 10), ...verbNotes];
    const specs = fieldFacetSpecs([vocab, verbs], notes);
    expect([...specs.keys()]).toEqual(['level']);
    expect([...specs.get('level')!.fieldIndexByType]).toEqual([
      ['vocab', 1],
      ['verbs', 2],
    ]);
  });

  it('the rule runs per card type: a type that fails never removes the group of the others', () => {
    const vocab = cardType('vocab', ['Word', 'Level', 'Type']);
    const vocabNotes = Array.from({ length: 60 }, (_, i) => note('vocab', [`w${i}`, ['A1', 'A2', 'B1', 'B2', 'C1'][i % 5], i % 2 ? 'noun' : 'verb']));
    // A word list: Level is a lesson used once each; Type is free text (40 values).
    const list = cardType('list', ['Term', 'Type', 'Level']);
    const listNotes = Array.from({ length: 40 }, (_, i) => note('list', [`t${i}`, `kind ${i}`, `Lesson ${i % 30}`]));
    const specs = fieldFacetSpecs([vocab, list], [...vocabNotes, ...listNotes]);
    expect([...specs.keys()].sort()).toEqual(['level', 'type']);
    // Only the passing type is a member: the list's values never become filter values.
    expect([...specs.get('level')!.fieldIndexByType]).toEqual([['vocab', 1]]);
    expect([...specs.get('type')!.fieldIndexByType]).toEqual([['vocab', 2]]);
    // An EMPTY column in a bigger card type does not remove it either (the union would be filled < 50%).
    const empty = cardType('empty', ['Front', 'Level']);
    const emptyNotes = Array.from({ length: 200 }, (_, i) => note('empty', [`f${i}`, '']));
    expect([...fieldFacetSpecs([vocab, empty], [...vocabNotes, ...emptyNotes]).get('level')!.fieldIndexByType]).toEqual([['vocab', 1]]);
  });

  it('several valid level columns stay ONE group, even with more than 24 values together (CEFR + JLPT + HSK + TOPIK)', () => {
    const scales: [string, string[]][] = [
      ['cefr', ['A1', 'A2', 'B1', 'B2', 'C1']],
      ['jlpt', ['N5', 'N4', 'N3', 'N2', 'N1']],
      ['hsk', ['HSK1', 'HSK2', 'HSK3', 'HSK4', 'HSK5', 'HSK6', 'HSK7', 'HSK8', 'HSK9']],
      ['topik', ['TOPIK 1', 'TOPIK 2', 'TOPIK 3', 'TOPIK 4', 'TOPIK 5', 'TOPIK 6']],
    ];
    const types = scales.map(([id]) => cardType(id, ['Word', 'Level']));
    const notes = scales.flatMap(([id, values]) => notesWithValues(id, values, values.length * 4));
    const spec = fieldFacetSpecs(types, notes).get('level');
    expect([...(spec?.fieldIndexByType.keys() ?? [])]).toEqual(['cefr', 'jlpt', 'hsk', 'topik']);
  });

  it('a small type that fails ALONE joins the group when the union with the passing types still passes', () => {
    const vocab = cardType('vocab', ['Word', 'Level']);
    const tiny = cardType('tiny', ['Wort', 'Level']);
    const notes = [...notesWithValues('vocab', ['A1', 'A2', 'B1'], 30), ...notesWithValues('tiny', ['A1', 'B1', 'C1'], 3)];
    expect(fieldFacetSpecs([tiny], notes).has('level')).toBe(false);
    expect([...fieldFacetSpecs([vocab, tiny], notes).get('level')!.fieldIndexByType.keys()]).toEqual(['vocab', 'tiny']);
  });

  it("facet 'on' makes ONE type a member; the other types still need the data rule", () => {
    const forced = cardType('forced', ['Word', { name: 'Level', facet: 'on', label: 'Stufe' }]);
    const junk = cardType('junk', ['Word', 'Level']);
    const notes = [...notesWithValues('forced', ['x'], 2), ...notesWithValues('junk', Array.from({ length: 30 }, (_, i) => `v${i}`), 30)];
    const spec = fieldFacetSpecs([junk, forced], notes).get('level');
    expect(spec).toMatchObject({ forced: true, label: 'Stufe' });
    expect([...spec!.fieldIndexByType.keys()]).toEqual(['forced']);
  });

  it("facet 'on' forces the group; 'off' is never a group", () => {
    const type = cardType('t', [{ name: 'Word', facet: 'on' }, { name: 'Level', facet: 'off' }]);
    const specs = fieldFacetSpecs([type], notesWithValues('t', ['A1', 'A2'], 10));
    expect(specs.get('word')).toMatchObject({ forced: true });
    expect(specs.has('level')).toBe(false);
  });

  it('a FieldDef multiSep is kept and skips the single-value test', () => {
    const type = cardType('t', ['Word', { name: 'Topics', multiSep: ';' }]);
    const specs = fieldFacetSpecs([type], notesWithValues('t', ['food; home', 'home'], 10));
    expect(specs.get('topics')).toMatchObject({ multiSep: ';' });
  });

  it('built-in Basic fields are all off: a Basic deck has no field groups', () => {
    const basic = builtinType('basic', NOW);
    const notes = Array.from({ length: 30 }, (_, i) => note(basic.id, [`w${i}`, 'same', 'same', 'same']));
    expect(fieldFacetSpecs([basic], notes).size).toBe(0);
  });

  it('the legacy Level and Type fields are forced on (v2.0.2 users keep their filters)', () => {
    const legacy = builtinType('legacyVocabDe', NOW);
    const specs = fieldFacetSpecs([legacy], []);
    expect([...specs.keys()].sort()).toEqual(['level', 'type']);
    expect(specs.get('level')?.forced).toBe(true);
  });

  it('field names that are Object members are groups like any other (constructor, __proto__, toString, hasOwnProperty)', () => {
    const type = cardType('t-proto', [
      'Word',
      { name: 'Constructor', facet: 'on' },
      { name: '__proto__', facet: 'on' },
      { name: 'toString', facet: 'on' },
      { name: 'hasOwnProperty', facet: 'on' },
    ]);
    const notes = [note('t-proto', ['a', 'Copy', 'yes', 'x', 'p']), note('t-proto', ['b', 'Move', 'no', 'y', 'q'])];
    const index = buildLibraryIndex(notes, [type]);
    expect([...index.fieldSpecs.keys()]).toEqual(['constructor', '__proto__', 'tostring', 'hasownproperty']);
    expect(index.fieldSpecs.get('__proto__')?.label).toBe('__proto__');
    expect(index.facetValues(notes[0])).toEqual(
      new Map([
        ['constructor', ['copy']],
        ['__proto__', ['yes']],
        ['tostring', ['x']],
        ['hasownproperty', ['p']],
      ]),
    );
    expect(index.valueLabel('constructor', 'move')).toBe('Move');
    expect(index.valueLabel('constructor', 'constructor')).toBe('constructor');
    // Entity names are looked up in a Map: an unknown name stays text.
    expect(plainText('a &constructor; &tostring; &valueof; b')).toBe('a &constructor; &tostring; &valueof; b');
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('a type with no notes is not a group (no data)', () => {
    expect(fieldFacetSpecs([cardType('t', ['Word', 'Level'])], []).size).toBe(0);
  });
});

describe('buildLibraryIndex', () => {
  // Tags is forced on, so these tests do not depend on the data rule.
  const type = cardType('vocab', ['Word', 'Level', { name: 'Tags', multiSep: ',', facet: 'on' }]);
  const a = note('vocab', ['<b>Über</b> Straße', 'B1', 'regular, separable'], {
    tags: ['Algo::Core_Patterns::Topic_Alpha', 'leech'],
    section: 'Verbs :: B1',
  });
  const b = note('vocab', ['Haus', 'b1', 'regular'], { tags: ['LEECH'] });
  const c = note('vocab', ['Küche', 'A2', 'Irregular']);
  const d = note('vocab', ['Tisch', 'A2', 'regular']);
  const index = buildLibraryIndex([a, b, c, d], [type]);

  it('maps ids to notes and types', () => {
    expect(index.noteById.get(a.id)).toBe(a);
    expect(index.typeById.get('vocab')).toBe(type);
  });

  it('searchText: folded fields without HTML, tags and section, one per line', () => {
    const text = index.searchText(a);
    expect(text.split('\n')).toEqual(
      expect.arrayContaining(['uber strasse', 'b1', 'regular, separable', 'algo::core_patterns::topic_alpha', 'leech', 'verbs::b1']),
    );
    // Tags and the section also as words: "topic alpha" finds Topic_Alpha.
    expect(text).toContain('algo core patterns topic alpha');
    expect(text).toContain('verbs b1');
    expect(index.searchText(a)).toBe(text); // cached
  });

  it('facetValues: folded values per facet field, multi-value split', () => {
    expect([...index.facetValues(a)]).toEqual([
      ['level', ['b1']],
      ['tags', ['regular', 'separable']],
    ]);
    expect(index.facetValues(b).get('level')).toEqual(['b1']);
    expect(index.facetValues(a)).toBe(index.facetValues(a)); // cached per note object
  });

  it('labels: the first display text seen for a folded value', () => {
    expect(index.valueLabel('level', 'b1')).toBe('B1');
    expect(index.valueLabel('tags', 'irregular')).toBe('Irregular');
    expect(index.valueLabel('level', 'zz')).toBe('zz');
    expect(index.sectionLabel('verbs::b1')).toBe('Verbs::B1');
    expect(index.sectionLabel('verbs')).toBe('Verbs');
    expect(index.tagLabel('algo::core_patterns')).toBe('Algo::Core_Patterns');
  });

  it('sectionPath and noteTags are folded; tags without duplicates', () => {
    expect(index.sectionPath(a)).toBe('verbs::b1');
    expect(index.sectionPath(c)).toBe('');
    expect(index.noteTags(b)).toEqual(['leech']);
    expect(index.noteTags(note('vocab', ['x', '', ''], { tags: ['A', 'a', ' '] }))).toEqual(['a']);
  });

  it('tags are cleaned like section paths: no empty part, no space around "::"', () => {
    const odd = note('vocab', ['x', '', ''], { tags: ['Algo::', ' Core :: Topic  Alpha ', '::', 'algo'] });
    expect(index.noteTags(odd)).toEqual(['algo', 'core::topic alpha']);
    const lib = buildLibraryIndex([odd], [type]);
    // Every folded tag (and parent) has a label: no empty row in the FacetSheet.
    expect(lib.tagLabel('algo')).toBe('Algo');
    expect(lib.tagLabel('core')).toBe('Core');
    expect(lib.tagLabel('core::topic alpha')).toBe('Core::Topic Alpha');
  });

  it('an edited note is a new object and gets fresh values', () => {
    const edited: Note = { ...a, fields: ['Neu', 'C1', ''] };
    expect(index.searchText(edited).split('\n')[0]).toBe('neu');
    expect(index.facetValues(edited).get('level')).toEqual(['c1']);
  });
});

describe('unit P1 — a new index keeps the values of the notes that did not change', () => {
  const type = cardType('vocab', ['Word', 'Level', { name: 'Tags', multiSep: ',', facet: 'on' }]);
  const make = () => [
    note('vocab', ['Hund', 'A1', 'regular'], { section: 'Nouns :: A1', tags: ['Animal::Dog'] }),
    note('vocab', ['Katze', 'a1', 'irregular'], { section: 'nouns::a1', tags: ['animal::cat'] }),
    note('vocab', ['Haus', 'B2', 'regular, separable'], { section: 'Nouns::B2' }),
    note('vocab', ['Baum', 'B2', 'regular']),
  ];

  it('the same filter fields → the same facetValues function and the same value objects (one edit reads one note)', () => {
    const notes = make();
    const first = buildLibraryIndex(notes, [type]);
    const level = first.facetValues(notes[2]);
    // An edit: a new notes array with one new note object.
    const edited = { ...notes[0], fields: ['Hund', 'A2', 'regular'] };
    const second = buildLibraryIndex([edited, ...notes.slice(1)], [type]);
    expect(second.facetValues).toBe(first.facetValues);
    expect(second.facetValues(notes[2])).toBe(level); // not read again
    expect(second.facetValues(edited).get('level')).toEqual(['a2']); // the edited note: its new value
    expect(first.facetValues(notes[0]).get('level')).toEqual(['a1']); // the old note keeps its own
  });

  it('other filter fields → another function: the values follow the new field groups', () => {
    const notes = make();
    const first = buildLibraryIndex(notes, [type]);
    const off = { ...type, fields: type.fields.map((f) => (f.name === 'Tags' ? { ...f, facet: 'off' as const } : f)) };
    const second = buildLibraryIndex(notes, [off]);
    expect(second.facetValues).not.toBe(first.facetValues);
    expect([...first.facetValues(notes[2]).keys()]).toEqual(['level', 'tags']);
    expect([...second.facetValues(notes[2]).keys()]).toEqual(['level']);
  });

  it('labels are made again per index (the first note in THIS order wins), from the kept per-note values', () => {
    const notes = make();
    const first = buildLibraryIndex(notes, [type]);
    expect(first.valueLabel('level', 'a1')).toBe('A1');
    expect(first.sectionLabel('nouns::a1')).toBe('Nouns::A1');
    expect(first.tagLabel('animal')).toBe('Animal');
    // The same notes in another order: Katze ("a1", "nouns::a1", "animal::cat") comes first now.
    const second = buildLibraryIndex([notes[1], notes[0], notes[2], notes[3]], [type]);
    expect(second.valueLabel('level', 'a1')).toBe('a1');
    expect(second.sectionLabel('nouns::a1')).toBe('nouns::a1');
    expect(second.sectionLabel('nouns')).toBe('nouns');
    expect(second.tagLabel('animal')).toBe('animal');
    expect(second.tagLabel('animal::dog')).toBe('Animal::Dog');
    // An edited section is read from the new note.
    const moved = { ...notes[3], section: 'Trees :: Big' };
    expect(buildLibraryIndex([moved], [type]).sectionLabel('trees::big')).toBe('Trees::Big');
  });
});

describe('unit P1 review — warmLabels: the label lookups a part at a time, the same labels as in one go', () => {
  const type = cardType('vocab', ['Word', 'Level', { name: 'Tags', multiSep: ',', facet: 'on' }]);
  /**
   * 200 notes whose display texts CHANGE after the first slices, so only the
   * first note in order may give a label: Level 'A1'/'B1' (notes 0–99), then
   * 'a1'/'b1', and 'C2' only at note 130; the section 'Verbs :: B1' from note
   * 70 on, 'VERBS::b1' from note 120; the tag 'Topic::Travel' at notes
   * 180–189, then 'topic::TRAVEL'; the Tags field 'Regular' only at note 99.
   */
  const make = (): Note[] =>
    Array.from({ length: 200 }, (_, i) =>
      note(
        'vocab',
        [`w ${i}`, i === 130 ? 'C2' : i < 100 ? (i % 2 === 0 ? 'A1' : 'B1') : i % 2 === 0 ? 'a1' : 'b1', i === 99 ? 'Regular, mixed' : 'regular, mixed'],
        {
          ...(i >= 70 ? { section: i < 120 ? 'Verbs :: B1' : 'VERBS::b1' } : {}),
          ...(i >= 180 ? { tags: [i < 190 ? 'Topic::Travel' : 'topic::TRAVEL'] } : {}),
        },
      ),
    );
  /** Every label the FacetSheet can ask for, as [kind, key, folded] → label. */
  const labelsOf = (index: ReturnType<typeof buildLibraryIndex>, notes: readonly Note[]): string[] => {
    const out: string[] = [];
    for (const n of notes) {
      for (const [key, values] of index.facetValues(n)) for (const v of values) out.push(`value ${key} ${v} → ${index.valueLabel(key, v)}`);
      for (const p of pathPrefixes(index.sectionPath(n))) out.push(`section ${p} → ${index.sectionLabel(p)}`);
      for (const t of index.noteTags(n)) for (const p of pathPrefixes(t)) out.push(`tag ${p} → ${index.tagLabel(p)}`);
    }
    return out;
  };
  /** The notes as an array that counts every note read from it by position (the label passes read it). */
  const countingArray = (notes: readonly Note[]): { notes: Note[]; reads: () => number } => {
    let reads = 0;
    const proxy = new Proxy(notes.slice(), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { notes: proxy, reads: () => reads };
  };

  it('stopped at every chance: at most 64 notes per call over the three passes; then the labels of one go', () => {
    const notes = make();
    const counting = countingArray(notes);
    const sliced = buildLibraryIndex(counting.notes, [type]);
    let calls = 0;
    let asked = 0;
    for (let done = false; !done; ) {
      const before = counting.reads();
      done = sliced.warmLabels(() => {
        asked += 1;
        return true;
      });
      calls += 1;
      expect(counting.reads() - before).toBeLessThanOrEqual(LABEL_NOTES_PER_STOP);
      expect(calls).toBeLessThan(100); // never stuck
    }
    // 3 passes × 200 notes = 600 visits: 10 calls; `stop` is asked only when there is more to do.
    expect(calls).toBe(Math.ceil((3 * notes.length) / LABEL_NOTES_PER_STOP));
    expect(asked).toBe(calls - 1);
    // Done: a further call has nothing to do and asks nothing.
    const before = counting.reads();
    expect(sliced.warmLabels(() => true)).toBe(true);
    expect(counting.reads()).toBe(before);
    // The readers only look up now: no note is read again.
    const whole = buildLibraryIndex(notes, [type]);
    const labels = labelsOf(sliced, notes);
    expect(counting.reads()).toBe(before);
    expect(labels).toEqual(labelsOf(whole, notes));
    // The first note in order wins, also after the first slices.
    expect(sliced.valueLabel('level', 'a1')).toBe('A1');
    expect(sliced.valueLabel('level', 'c2')).toBe('C2');
    expect(sliced.valueLabel('tags', 'regular')).toBe('regular');
    expect(sliced.sectionLabel('verbs::b1')).toBe('Verbs::B1');
    expect(sliced.tagLabel('topic::travel')).toBe('Topic::Travel');
  });

  it('a reader in the middle of the warm-up finishes its own pass (the same labels); the warm-up then goes on to the end', () => {
    const notes = make();
    const whole = labelsOf(buildLibraryIndex(notes, [type]), notes);
    // Stopped after the first slice (the value pass is at note 64), and after the second.
    for (const slices of [1, 2, 4, 7]) {
      const index = buildLibraryIndex(notes, [type]);
      let left = slices;
      expect(index.warmLabels(() => --left <= 0)).toBe(false);
      // The FacetSheet opens now: each reader makes the rest of ITS lookup in one go.
      expect(index.valueLabel('level', 'c2')).toBe('C2');
      expect(index.sectionLabel('verbs::b1')).toBe('Verbs::B1');
      expect(index.tagLabel('topic::travel')).toBe('Topic::Travel');
      expect(index.warmLabels(() => false)).toBe(true);
      expect(labelsOf(index, notes)).toEqual(whole);
    }
  });

  it('no notes, or a few: done in one call, `stop` never asked', () => {
    const never = () => {
      throw new Error('stop asked');
    };
    expect(buildLibraryIndex([], [type]).warmLabels(never)).toBe(true);
    const few = make().slice(0, 20);
    const index = buildLibraryIndex(few, [type]);
    expect(index.warmLabels(never)).toBe(true);
    expect(labelsOf(index, few)).toEqual(labelsOf(buildLibraryIndex(few, [type]), few));
  });
});

describe('CardLookup and memos', () => {
  const basic = builtinType('basicReverse', NOW);
  const n1 = note(basic.id, ['a', 'b', '', '']);
  const n2 = note(basic.id, ['c', 'd', '', '']);
  const cards = [
    makeCard(n1, 0, 'd1', DEFAULT_SRS, NOW, { id: 'c1' }),
    makeCard(n1, 1, 'd1', DEFAULT_SRS, NOW, { id: 'c2' }),
    makeCard(n2, 0, 'd1', DEFAULT_SRS, NOW, { id: 'c3' }),
  ];

  it('buildCardLookup: card by id, card IDS by note', () => {
    const lookup = buildCardLookup(cards);
    expect(lookup.cardById.get('c2')).toBe(cards[1]);
    expect(lookup.cardIdsByNote.get(n1.id)).toEqual(['c1', 'c2']);
    expect(lookup.cardIdsByNote.get(n2.id)).toEqual(['c3']);
  });

  it('the index is rebuilt only when notes or types change (a rating changes only cards)', () => {
    const indexOf = libraryIndexMemo();
    const notes = [n1, n2];
    const types = [basic];
    const first = indexOf(notes, types);
    expect(indexOf(notes, types)).toBe(first);
    expect(indexOf([...notes], types)).not.toBe(first);
  });

  it('the card lookup is rebuilt only when the cards array changes', () => {
    const lookupOf = cardLookupMemo();
    const first = lookupOf(cards);
    expect(lookupOf(cards)).toBe(first);
    const rated = cards.map((c) => (c.id === 'c1' ? { ...c, reps: 1 } : c));
    expect(lookupOf(rated)).not.toBe(first);
    expect(lookupOf(rated).cardById.get('c1')?.reps).toBe(1);
  });
});
