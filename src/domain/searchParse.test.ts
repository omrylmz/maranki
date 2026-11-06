/**
 * Search syntax (spec §4.2): every row of the table, repeated tokens,
 * negation, `hashtag:x` stays text, an unknown field gives a hint, the round
 * trip text ↔ chips, and the chip labels.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW as NOW } from '../test/clock';
import { createRandom } from '../test/random';
import { builtinType } from './builtinTypes';
import { deriveFacets } from './facets';
import { buildLibraryIndex } from './libraryIndex';
import { listsById } from './lists';
import { makeCard, makeDeck, makeNote } from './makeV3';
import type { Card, Note, NoteType, Query } from './model';
import { compileQuery, type MatchCtx, normalizeQuery, sameQuery } from './query';
import {
  buildSearchCtx,
  chipOnlyPart,
  chipsOf,
  formatSearch,
  mergeQueries,
  parseSearch,
  removeChip,
  type SearchCtx,
} from './searchParse';
import { DEFAULT_SRS } from './types';

/* ------------------------------------------------------------- library */

const VOCAB: NoteType = {
  id: 'nt-vocab',
  name: 'Vocabulary',
  kind: 'standard',
  fields: [
    { name: 'Word', role: 'term', facet: 'auto' },
    { name: 'Meaning', role: 'meaning', facet: 'auto' },
    { name: 'Level', role: 'badge', facet: 'on' },
    { name: 'Example translation', role: 'exampleMeaning', facet: 'on' },
  ],
  templates: [
    { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
    { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
  ],
  sortField: 0,
  createdAt: NOW,
  updatedAt: NOW,
};
const CODING: NoteType = {
  ...VOCAB,
  id: 'nt-coding',
  name: 'Coding',
  fields: [
    { name: 'Front', role: 'term', facet: 'off' },
    { name: 'Category', role: 'badge', facet: 'on' },
  ],
  templates: [{ ord: 0, name: 'Card', prompt: [0], answer: [1] }],
};

const decks = [
  makeDeck({ id: 'd-de', name: 'German', order: 0 }, NOW),
  makeDeck({ id: 'd-dev', name: 'German Verbs', order: 1 }, NOW),
  makeDeck({ id: 'd-es', name: 'Español', order: 2 }, NOW),
  makeDeck({ id: 'd-code', name: 'Algo Deck', order: 3 }, NOW),
];
const DECKS = new Map(decks.map((d) => [d.id, d]));

const notes: Note[] = [];
const cards: Card[] = [];
function add(id: string, typeId: string, fields: string[], deckId: string, section = '', tags: string[] = []): void {
  const note = makeNote({ id, typeId, fields, section, tags }, NOW);
  notes.push(note);
  cards.push(makeCard(note, 0, deckId, DEFAULT_SRS, NOW, { id: `${id}-c0` }));
}
add('n1', 'nt-vocab', ['die Stunde', 'the hour', 'A1', 'one hour'], 'd-de', 'Vocabulary::A1');
add('n2', 'nt-vocab', ['über', 'over', 'B1', ''], 'd-de', 'Verbs::B1');
add('n3', 'nt-vocab', ['gehen', 'to go', 'B1', ''], 'd-dev', 'B1');
add('n4', 'nt-vocab', ['la hora', 'the hour', 'A1', ''], 'd-es', 'Verbs::B1');
add('n5', 'nt-coding', ['Topic alpha', 'Core Patterns'], 'd-code', 'Core Patterns', ['Algo::Core_Patterns::Topic_Alpha']);

const index = buildLibraryIndex(notes, [VOCAB, CODING]);
const ctx: MatchCtx = { now: NOW, index, decks: DECKS, lists: listsById([]) };
const sctx: SearchCtx = buildSearchCtx(cards, ctx);

const parse = (text: string, c: SearchCtx = sctx) => parseSearch(text, c);

/* --------------------------------------------------------------- tests */

describe('buildSearchCtx', () => {
  it('lists the facet fields and the sections (with parents) of the scope', () => {
    // Meaning is a group by the data rule (spec §4.3 rule 1): 3 short values on 4 notes, 'the hour' twice.
    expect([...sctx.fieldSpecs.keys()].sort()).toEqual(['category', 'example translation', 'level', 'meaning']);
    expect([...sctx.sectionsByDeck.get('d-de')!].sort()).toEqual(['verbs', 'verbs::b1', 'vocabulary', 'vocabulary::a1']);
    expect(sctx.decks).toHaveLength(4);
  });

  it('a scope without the coding cards has no Category field', () => {
    const narrow = buildSearchCtx(cards.filter((c) => c.deckId === 'd-de'), ctx);
    expect(narrow.fieldSpecs.has('category')).toBe(false);
    expect(narrow.fieldSpecs.has('level')).toBe(true);
  });

  it('collects the tags (with their parents) and where each direction comes from', () => {
    expect([...sctx.tags!].sort()).toEqual(['algo', 'algo::core_patterns', 'algo::core_patterns::topic_alpha']);
    expect(sctx.directionSources).toEqual(
      new Map([
        [
          0,
          new Map([
            ['nt-vocab', new Set(['d-de', 'd-dev', 'd-es'])],
            ['nt-coding', new Set(['d-code'])],
          ]),
        ],
      ]),
    );
    expect(buildSearchCtx(cards.filter((c) => c.deckId === 'd-de'), ctx).tags!.size).toBe(0);
  });
});

describe('parseSearch — the table of §4.2', () => {
  it('free words → text (folded); both must match', () => {
    expect(parse('haus küche')).toEqual({ query: { text: 'haus kuche' }, rest: 'haus küche', hints: [] });
  });

  it('a "quoted phrase" stays one phrase', () => {
    expect(parse('"Die Stunde" x').query).toEqual({ text: '"die stunde" x' });
    expect(parse('"unclosed phrase').query).toEqual({ text: '"unclosed phrase"' });
  });

  it('deck: folded name PREFIX; several matches → all; quoted names', () => {
    expect(parse('deck:german').query).toEqual({ decks: ['d-de', 'd-dev'] });
    expect(parse('deck:"German Verbs"').query).toEqual({ decks: ['d-dev'] });
    expect(parse('deck:espanol').query).toEqual({ decks: ['d-es'] });
  });

  it('deck: no match → stays text + a hint', () => {
    expect(parse('deck:french')).toEqual({
      query: { text: 'deck:french' },
      rest: 'deck:french',
      hints: ["No deck called 'french'."],
    });
  });

  it('section: the only Deck chip if there is one, else every deck that has the section', () => {
    expect(parse('section:verbs::b1').query).toEqual({
      sections: [
        { deckId: 'd-de', path: 'verbs::b1' },
        { deckId: 'd-es', path: 'verbs::b1' },
      ],
    });
    // One Deck chip typed in the same search…
    expect(parse('deck:espanol section:Verbs::B1').query).toEqual({
      decks: ['d-es'],
      sections: [{ deckId: 'd-es', path: 'verbs::b1' }],
    });
    // …or already applied as a chip.
    expect(parse('section:verbs', { ...sctx, base: { decks: ['d-de'] } }).query).toEqual({
      sections: [{ deckId: 'd-de', path: 'verbs' }],
    });
    expect(parse('section:"core patterns"').query).toEqual({ sections: [{ deckId: 'd-code', path: 'core patterns' }] });
  });

  it('section: unknown → text + hint', () => {
    const r = parse('section:nouns');
    expect(r.query).toEqual({ text: 'section:nouns' });
    expect(r.hints).toEqual(["No section called 'nouns' here."]);
  });

  it('tag: and -tag: (folded)', () => {
    expect(parse('tag:Algo -tag:leech').query).toEqual({ tags: ['algo'], notTags: ['leech'] });
    expect(parse('tag:Über').query).toEqual({ tags: ['uber'] });
  });

  it('tag: a space stands for "_" (the tag tree shows Core_Patterns as "Core Patterns")', () => {
    const r = parse('tag:"Algo :: Core Patterns"');
    expect(r).toEqual({ query: { tags: ['algo::core_patterns'] }, rest: '', hints: [] });
    expect(cards.filter(compileQuery(r.query, ctx)).map((c) => c.id)).toEqual(['n5-c0']);
    expect(parse('tag:"algo::core patterns::topic  alpha"').query).toEqual({ tags: ['algo::core_patterns::topic_alpha'] });
    // A nested tag is found by its last part(s), as the tag tree shows it ("Core Patterns" under "Algo").
    expect(parse('-tag:"core patterns"').query).toEqual({ notTags: ['algo::core_patterns'] });
  });

  it('tag: the name the tag tree shows finds the nested tag (its last part, or last parts)', () => {
    const full = 'algo::core_patterns::topic_alpha';
    for (const typed of ['tag:"topic alpha"', 'tag:topic_alpha', 'tag:Topic_Alpha', 'tag:"core patterns::topic alpha"']) {
      const r = parse(typed);
      expect({ typed, r }).toEqual({ typed, r: { query: { tags: [full] }, rest: '', hints: [] } });
      expect(cards.filter(compileQuery(r.query, ctx)).map((c) => c.id)).toEqual(['n5-c0']);
    }
    // The chip says the full path, and the text round trip writes it back exactly.
    expect(formatSearch(parse('tag:"topic alpha"').query, ctx, sctx)).toBe(`tag:${full}`);
    // A part in the MIDDLE of a path is not a tag name: still the hint.
    expect(parse('tag:pointers').hints).toEqual(["No tag called 'pointers' here."]);
  });

  it('tag: the same last part under two parents finds both (an OR group); a child of a found tag is not listed again', () => {
    const extra = [
      makeNote({ id: 't1', typeId: 'nt-coding', fields: ['a', 'X'], tags: ['Algo::DP::Topic_Alpha'] }, NOW),
      makeNote({ id: 't2', typeId: 'nt-coding', fields: ['b', 'X'], tags: ['Other::Topic_Alpha::Topic_Alpha'] }, NOW),
    ];
    const local: MatchCtx = { ...ctx, index: buildLibraryIndex([...notes, ...extra], [VOCAB, CODING]) };
    const scope = buildSearchCtx([...cards, ...extra.map((n) => makeCard(n, 0, 'd-code', DEFAULT_SRS, NOW, { id: `${n.id}-c0` }))], local);
    expect(parse('tag:"topic alpha"', scope).query).toEqual({
      tags: ['algo::core_patterns::topic_alpha', 'algo::dp::topic_alpha', 'other::topic_alpha'],
    });
  });

  it("tag: a tag no note in the scope has is still a chip, with the hint \"No tag called 'x' here.\"", () => {
    expect(parse('tag:nope')).toEqual({ query: { tags: ['nope'] }, rest: '', hints: ["No tag called 'nope' here."] });
    expect(parse('tag:Algo tag:"no such thing"').hints).toEqual(["No tag called 'no such thing' here."]);
    // A parent of a real tag is a tag of the scope.
    expect(parse('tag:algo::core_patterns').hints).toEqual([]);
    // Excluding a tag that does not exist excludes nothing: no hint needed.
    expect(parse('-tag:nope').hints).toEqual([]);
    // A scope that does not know its tags gives no hint.
    expect(parse('tag:nope', { ...sctx, tags: undefined }).hints).toEqual([]);
  });

  it('tag: a tag made in the app WITH a space is found as it is', () => {
    const n = makeNote({ id: 'sp', typeId: 'nt-vocab', fields: ['Haus', 'house', 'A1', ''], tags: ['My  tag'] }, NOW);
    const c = makeCard(n, 0, 'd-de', DEFAULT_SRS, NOW, { id: 'sp-c0' });
    const local: MatchCtx = { ...ctx, index: buildLibraryIndex([...notes, n], [VOCAB, CODING]) };
    const scope = buildSearchCtx([...cards, c], local);
    const r = parse('tag:"my tag"', scope);
    expect(r).toEqual({ query: { tags: ['my tag'] }, rest: '', hints: [] });
    expect(compileQuery(r.query, local)(c)).toBe(true);
    // The text round trip writes it back exactly.
    expect(formatSearch(r.query, local, scope)).toBe('tag:"my tag"');
    // In a scope without that tag the text would mean 'my_tag': the chip stays a chip.
    expect(formatSearch({ tags: ['my tag'] }, ctx, sctx)).toBe('');
    expect(chipOnlyPart({ tags: ['my tag', 'algo'] }, sctx)).toEqual({ tags: ['my tag'] });
  });

  it('fields: only when the facet field exists in scope', () => {
    expect(parse('level:b1 level:B2').query).toEqual({ fields: { level: ['b1', 'b2'] } });
    expect(parse('category:"Core Patterns"').query).toEqual({ fields: { category: ['core patterns'] } });
    // A field name with a space is typed with '_'.
    expect(parse('example_translation:"one hour"').query).toEqual({ fields: { 'example translation': ['one hour'] } });
  });

  it("fields: a value the scope does not have is still a chip, with the hint \"No Level 'b3' here.\"", () => {
    expect(parse('level:b3')).toEqual({ query: { fields: { level: ['b3'] } }, rest: '', hints: ["No Level 'b3' here."] });
    expect(parse('category:x').hints).toEqual(["No Category 'x' here."]);
    // A value that exists: no hint.
    expect(parse('level:b1 category:"core patterns"').hints).toEqual([]);
    // A scope that does not know its values gives no hint.
    expect(parse('level:b3', { ...sctx, fieldValues: undefined }).hints).toEqual([]);
  });

  it("fields: '_' may stand for a space in a value (category:core_patterns), like in a section", () => {
    const r = parse('category:core_patterns');
    expect(r).toEqual({ query: { fields: { category: ['core patterns'] } }, rest: '', hints: [] });
    expect(cards.filter(compileQuery(r.query, ctx)).map((c) => c.id)).toEqual(['n5-c0']);
    // A value that is not there with spaces either keeps its '_' (and the hint).
    expect(parse('category:core_x').query).toEqual({ fields: { category: ['core_x'] } });
    expect(parse('category:core_x').hints).toEqual(["No Category 'core_x' here."]);
    // The text round trip stays exact: a chip with a real '_' value is not turned into the spaced one.
    expect(chipOnlyPart({ fields: { category: ['core_patterns'] } }, sctx)).toEqual({ fields: { category: ['core_patterns'] } });
    expect(formatSearch({ fields: { category: ['core patterns'] } }, ctx, sctx)).toBe('category:"core patterns"');
  });

  it("unknown field → the token stays text and hints says so", () => {
    const narrow = buildSearchCtx(cards.filter((c) => c.deckId === 'd-de'), ctx);
    const r = parse('category:x haus', narrow);
    expect(r.query).toEqual({ text: 'category:x haus' });
    expect(r.rest).toBe('category:x haus');
    expect(r.hints).toEqual(["No field called 'category' here."]);
    expect(parse('Color:red').hints).toEqual(["No field called 'Color' here."]);
  });

  it('is: → life, due, flags, booleans; -is: → notFlags', () => {
    expect(parse('is:new is:notstarted is:learning is:review is:mastered is:known').query).toEqual({
      life: ['new', 'notStarted', 'learning', 'review', 'mastered', 'known'],
    });
    expect(parse('is:due').query).toEqual({ due: 'now' });
    expect(parse('is:duetoday').query).toEqual({ due: 'today' });
    expect(parse('is:fav is:flagged is:suspended is:buried is:paused').query).toEqual({
      flags: ['fav', 'flagged', 'suspended', 'buried', 'paused'],
    });
    expect(parse('-is:suspended -is:paused').query).toEqual({ notFlags: ['suspended', 'paused'] });
    expect(parse('is:hard is:young is:leech').query).toEqual({ hard: true, young: true, leech: true });
    expect(parse('IS:Not-Started is:recent is:favorite').query).toEqual({ life: ['notStarted'], young: true, flags: ['fav'] });
  });

  it('dir:N → directions [N − 1]', () => {
    expect(parse('dir:1 dir:2').query).toEqual({ directions: [0, 1] });
  });

  it('things the flat query cannot say stay text with a hint', () => {
    expect(parse('is:bogus')).toMatchObject({ query: { text: 'is:bogus' }, hints: ["Unknown filter 'is:bogus'."] });
    expect(parse('-is:new').hints).toEqual(["Unknown filter '-is:new'."]);
    expect(parse('dir:0').hints).toEqual(["Unknown filter 'dir:0'."]);
    expect(parse('-deck:german').hints).toEqual(["Unknown filter '-deck:german'."]);
    expect(parse('-level:b1').hints).toEqual(["Unknown filter '-level:b1'."]);
  });
});

describe('parseSearch — rules', () => {
  it('tokens repeat: tag:b1 tag:verb keeps both (an OR group)', () => {
    expect(parse('tag:b1 tag:verb tag:b1').query).toEqual({ tags: ['b1', 'verb'] });
  });

  it('a token needs a word start: hashtag:x is text (not tag:x)', () => {
    const r = parse('hashtag:x');
    expect(r.query).toEqual({ text: 'hashtag:x' });
    expect(r.query.tags).toBeUndefined();
  });

  it('a field name in another script is a key too (уровень:a1)', () => {
    const ru: NoteType = {
      ...VOCAB,
      id: 'nt-ru',
      fields: [
        { name: 'Слово', role: 'term', facet: 'off' },
        { name: 'Уровень', role: 'badge', facet: 'on' },
      ],
    };
    const n = makeNote({ id: 'ru1', typeId: ru.id, fields: ['дом', 'A1'] }, NOW);
    const ruCtx: MatchCtx = {
      now: NOW,
      index: buildLibraryIndex([n], [ru]),
      decks: new Map([['d-ru', makeDeck({ id: 'd-ru', name: 'Русский' }, NOW)]]),
      lists: listsById([]),
    };
    const ruScope = buildSearchCtx([makeCard(n, 0, 'd-ru', DEFAULT_SRS, NOW, { id: 'ru1-c0' })], ruCtx);
    expect(parse('Уровень:A1', ruScope)).toEqual({ query: { fields: { уровень: ['a1'] } }, rest: '', hints: [] });
    expect(parse('deck:русский', ruScope).query).toEqual({ decks: ['d-ru'] });
  });

  it('plain colons are text: times, links, a trailing colon', () => {
    expect(parse('12:30 http://x.org Hinweis:').query).toEqual({ text: '12:30 http://x.org hinweis:' });
    expect(parse('12:30 http://x.org Hinweis:').hints).toEqual([]);
  });

  it('rest = the text exactly as typed, tokens removed', () => {
    const r = parse('  Haus   tag:b1  "Die Stunde"  is:new ');
    expect(r.rest).toBe('Haus "Die Stunde"');
    expect(r.query).toEqual({ tags: ['b1'], life: ['new'], text: 'haus "die stunde"' });
  });

  it('the parsed query finds what the words say (uber finds über)', () => {
    const match = compileQuery(parse('uber level:b1').query, ctx);
    expect(cards.filter(match).map((c) => c.id)).toEqual(['n2-c0']);
  });

  it('empty input → empty query', () => {
    expect(parse('   ')).toEqual({ query: {}, rest: '', hints: [] });
  });
});

describe('round trip text ↔ chips', () => {
  const texts = [
    'deck:espanol level:a1 is:new haus',
    'section:core_patterns tag:algo -tag:leech is:due -is:suspended',
    'category:"core patterns" dir:2 is:hard is:young is:leech is:fav "die stunde"',
    'deck:"Algo Deck" section:"core patterns" is:duetoday is:notstarted',
    'example_translation:"one hour" is:known is:flagged',
  ];
  for (const text of texts) {
    it(`parse → format → parse is stable: ${text}`, () => {
      const first = parse(text);
      expect(first.hints).toEqual([]);
      const again = parse(formatSearch(first.query, ctx));
      expect(again.query).toEqual(first.query);
      expect(again.hints).toEqual([]);
    });
  }

  it('format(q) parses back to q (every group that has a syntax)', () => {
    const q: Query = normalizeQuery({
      decks: ['d-code'],
      sections: [{ deckId: 'd-code', path: 'core patterns' }],
      fields: { category: ['core patterns'], level: ['a1', 'b1'] },
      directions: [0],
      tags: ['algo::core_patterns'],
      notTags: ['leech'],
      life: ['new', 'notStarted'],
      due: 'today',
      flags: ['fav'],
      notFlags: ['paused'],
      hard: true,
      young: true,
      leech: true,
      text: 'two "core patterns"',
    });
    expect(parse(formatSearch(q, ctx)).query).toEqual(q);
  });

  it('list and card types have no syntax: format leaves them out', () => {
    expect(formatSearch({ list: 'builtin:hard', noteTypes: ['nt-vocab'], tags: ['x'] }, ctx)).toBe('tag:x');
  });
});

describe('round trip chips → text → chips (with the scope)', () => {
  /** What a screen does: show q as text, keep what text cannot say as chips, parse the text back. */
  const roundTrip = (q: Query) => mergeQueries(chipOnlyPart(q, sctx), parse(formatSearch(q, ctx, sctx)).query);

  it('a one-deck section chip in a multi-deck scope stays a chip (text would widen it)', () => {
    // German and Español both have Verbs › B1; the chip names German only.
    const q: Query = { sections: [{ deckId: 'd-de', path: 'verbs::b1' }] };
    expect(formatSearch(q, ctx, sctx)).toBe('');
    expect(chipOnlyPart(q, sctx)).toEqual(q);
    expect(sameQuery(roundTrip(q), q)).toBe(true);
    // Without the scope the text is 'section:verbs::b1', which means BOTH decks.
    expect(formatSearch(q, ctx)).toBe('section:verbs::b1');
    expect(parse(formatSearch(q, ctx)).query.sections).toHaveLength(2);
  });

  it('every kind of section chip comes back exactly', () => {
    const queries: Query[] = [
      // Every deck that has the path → text.
      { sections: [{ deckId: 'd-de', path: 'verbs::b1' }, { deckId: 'd-es', path: 'verbs::b1' }] },
      // The only Deck chip → text.
      { decks: ['d-es'], sections: [{ deckId: 'd-es', path: 'verbs::b1' }] },
      // A section of another deck than the Deck chip → chip.
      { decks: ['d-es'], sections: [{ deckId: 'd-de', path: 'verbs::b1' }] },
      // One path too narrow for text (chip), one only in its own deck (text).
      { sections: [{ deckId: 'd-de', path: 'verbs::b1' }, { deckId: 'd-code', path: 'core patterns' }], tags: ['x'] },
      // Chip-only groups with text groups.
      { list: 'builtin:hard', noteTypes: ['nt-vocab'], fields: { level: ['a1'] }, text: 'haus' },
    ];
    for (const q of queries) expect([q, sameQuery(roundTrip(q), q)]).toEqual([q, true]);
    expect(formatSearch(queries[0], ctx, sctx)).toBe('section:verbs::b1');
    expect(chipOnlyPart(queries[0], sctx)).toEqual({});
    expect(chipOnlyPart(queries[3], sctx)).toEqual({ sections: [{ deckId: 'd-de', path: 'verbs::b1' }] });
  });

  it('a Deck chip whose name starts another deck name stays a chip (deck: matches by prefix)', () => {
    // "German" is the start of "German Verbs": 'deck:German' would give back both decks.
    const q: Query = { decks: ['d-de'] };
    expect(formatSearch(q, ctx, sctx)).toBe('');
    expect(chipOnlyPart(q, sctx)).toEqual(q);
    expect(sameQuery(roundTrip(q), q)).toBe(true);
    // Without the scope the text widens it (the limit formatSearch documents).
    expect(parse(formatSearch(q, ctx)).query.decks).toEqual(['d-de', 'd-dev']);
  });

  it('every kind of Deck chip comes back exactly', () => {
    const queries: Query[] = [
      // The start of another deck name → chip.
      { decks: ['d-de'] },
      // No other deck starts with "German Verbs" → text.
      { decks: ['d-dev'] },
      // Both chips: 'deck:German' gives back only chips of the query → text.
      { decks: ['d-de', 'd-dev'] },
      // One chip, one text.
      { decks: ['d-de', 'd-es'] },
      // The Deck chip stays a chip, so the parser sees no Deck token: 'section:verbs::b1'
      // would go to German AND Español → the section stays a chip too.
      { decks: ['d-de'], sections: [{ deckId: 'd-de', path: 'verbs::b1' }] },
      // A deleted deck: the parser does not know it → chip.
      { decks: ['d-gone'], text: 'haus' },
    ];
    for (const q of queries) expect([q, sameQuery(roundTrip(q), q)]).toEqual([q, true]);
    expect(formatSearch(queries[1], ctx, sctx)).toBe('deck:"German Verbs"');
    expect(formatSearch(queries[2], ctx, sctx)).toBe('deck:German deck:"German Verbs"');
    expect(chipOnlyPart(queries[2], sctx)).toEqual({});
    expect(chipOnlyPart(queries[3], sctx)).toEqual({ decks: ['d-de'] });
    expect(formatSearch(queries[3], ctx, sctx)).toBe('deck:Español');
    expect(chipOnlyPart(queries[4], sctx)).toEqual(queries[4]);
    expect(chipOnlyPart(queries[5], sctx)).toEqual({ decks: ['d-gone'] });
  });

  it('the scope base counts like in parseSearch: its one Deck chip takes the section', () => {
    const withBase: SearchCtx = { ...sctx, base: { decks: ['d-de'] } };
    const q: Query = { sections: [{ deckId: 'd-de', path: 'verbs::b1' }] };
    expect(formatSearch(q, ctx, withBase)).toBe('section:verbs::b1');
    expect(chipOnlyPart(q, withBase)).toEqual({});
    const back = mergeQueries(chipOnlyPart(q, withBase), parse(formatSearch(q, ctx, withBase), withBase).query);
    expect(sameQuery(back, q)).toBe(true);
  });

  it('field, tag and text tokens that would parse into another group stay chips', () => {
    const queries: Query[] = [
      // No Color field in this scope: 'color:red' would be text.
      { fields: { color: ['red'] } },
      // A field name with ':' would be read as 'level:…'.
      { fields: { level: ['a1'], 'level: cefr': ['b1'] } },
      // The text drops a quote mark: 'tag:"ab"' is another tag.
      { tags: ['a"b'], notTags: ['x"y'] },
      // Text that reads as a Status chip, or as Deck chips.
      { text: 'is:new' },
      { text: 'deck:german haus' },
    ];
    for (const q of queries) expect([q, sameQuery(roundTrip(q), q)]).toEqual([q, true]);
    expect(formatSearch(queries[1], ctx, sctx)).toBe('level:a1');
    expect(chipOnlyPart(queries[1], sctx)).toEqual({ fields: { 'level: cefr': ['b1'] } });
    expect(formatSearch(queries[3], ctx, sctx)).toBe('');
    // Without the scope everything is written (and may come back as another group).
    expect(formatSearch(queries[3], ctx)).toBe('is:new');
  });

  it('300 seeded random queries come back exactly (with and without an applied Deck chip)', () => {
    const rnd = createRandom('searchParse round trip');
    const deckIds = [...decks.map((d) => d.id), 'd-gone'];
    const sectionPool = [...sctx.sectionsByDeck].flatMap(([deckId, paths]) => [...paths].map((path) => ({ deckId, path })));
    sectionPool.push({ deckId: 'd-gone', path: 'x' });
    const fieldPool: [string, string][] = [
      ['level', 'a1'],
      ['level', 'b1'],
      ['category', 'core patterns'],
      ['color', 'red'],
      ['level: cefr', 'b1'],
    ];
    const tagPool = ['algo', 'algo::core_patterns', 'a"b', 'leech'];
    const textPool = ['haus', '"die stunde"', 'is:new', 'deck:german', 'section:verbs', 'x'];
    const scopes: SearchCtx[] = [sctx, { ...sctx, base: { decks: ['d-de'] } }, { ...sctx, base: { decks: ['d-es'] } }];
    for (let i = 0; i < 300; i++) {
      const q: Query = {};
      if (rnd.bool()) q.decks = rnd.sample(deckIds, rnd.int(1, 3));
      if (rnd.bool()) q.sections = rnd.sample(sectionPool, rnd.int(1, 3));
      if (rnd.bool()) {
        const fields: Record<string, string[]> = {};
        for (const [k, v] of rnd.sample(fieldPool, rnd.int(1, 3))) (fields[k] ??= []).push(v);
        q.fields = fields;
      }
      if (rnd.bool(0.3)) q.tags = rnd.sample(tagPool, rnd.int(1, 2));
      if (rnd.bool(0.3)) q.notTags = rnd.sample(tagPool, 1);
      if (rnd.bool(0.3)) q.text = rnd.sample(textPool, rnd.int(1, 2)).join(' ');
      if (rnd.bool(0.2)) q.life = ['new'];
      if (rnd.bool(0.2)) q.list = 'builtin:hard';
      const scope = rnd.pick(scopes);
      const back = mergeQueries(chipOnlyPart(q, scope), parseSearch(formatSearch(q, ctx, scope), scope).query);
      expect([q, sameQuery(back, q)]).toEqual([q, true]);
    }
  });
});

describe('chipsOf / removeChip / mergeQueries', () => {
  it('one chip per group, with the spec labels', () => {
    const chips = chipsOf(
      {
        fields: { level: ['b1', 'a1'] },
        decks: ['d-de'],
        life: ['notStarted'],
        due: 'now',
        text: 'haus',
      },
      ctx,
    );
    expect(chips.map((c) => [c.id, c.label, c.facet])).toEqual([
      ['decks', 'Deck: German', 'deck'],
      ['field:level', 'Level: B1, A1', 'field:level'],
      ['life', 'Not started', 'life'],
      ['due', 'Due now', 'due'],
      ['text', 'Text: haus', null],
    ]);
  });

  it('labels of the other groups', () => {
    const chips = chipsOf(
      {
        list: 'builtin:hard',
        sections: [{ deckId: 'd-de', path: 'verbs::b1' }],
        noteTypes: ['nt-coding'],
        directions: [1],
        tags: ['algo::core_patterns'],
        notTags: ['leech'],
        flags: ['fav', 'paused'],
        notFlags: ['suspended', 'buried'],
        hard: true,
        young: true,
        leech: true,
      },
      ctx,
    );
    expect(chips.map((c) => c.label)).toEqual([
      'List: Hard cards',
      'Section: Verbs › B1',
      'Card type: Coding',
      'Direction: EN-DE',
      'Tag: Algo › Core Patterns',
      'Not tagged: leech',
      'Favorite, In a paused deck',
      'Not suspended, buried',
      'Hard',
      'Recent',
      'Leech',
    ]);
  });

  it('the Direction chip names only the card types in scope, like the FacetSheet value', () => {
    // A Basic (and reversed card) deck next to a deck whose card type has one template "Card".
    const reverse = builtinType('basicReverse', NOW);
    const libNotes: Note[] = [];
    const libCards: Card[] = [];
    for (let i = 0; i < 3; i++) {
      const n = makeNote({ id: `b${i}`, typeId: reverse.id, fields: [`front ${i}`, `back ${i}`, '', ''] }, NOW);
      libNotes.push(n);
      for (const ord of [0, 1]) libCards.push(makeCard(n, ord, 'd-b', DEFAULT_SRS, NOW, { id: `b${i}-${ord}` }));
    }
    const code = makeNote({ id: 'k0', typeId: CODING.id, fields: ['Topic alpha', 'Core'] }, NOW);
    libNotes.push(code);
    libCards.push(makeCard(code, 0, 'd-k', DEFAULT_SRS, NOW, { id: 'k0-0' }));
    const libCtx: MatchCtx = {
      now: NOW,
      index: buildLibraryIndex(libNotes, [reverse, CODING]),
      decks: new Map([
        ['d-b', makeDeck({ id: 'd-b', name: 'Basic' }, NOW)],
        ['d-k', makeDeck({ id: 'd-k', name: 'Code' }, NOW)],
      ]),
      lists: listsById([]),
    };
    const scope: Query = { decks: ['d-b'] };
    const inScope = compileQuery(scope, libCtx);
    const scopeCtx = buildSearchCtx(libCards.filter(inScope), libCtx);
    const selection: Query = { directions: [0] };

    const facetValue = deriveFacets(libCards, scope, selection, libCtx)
      .find((f) => f.key === 'direction')!
      .values.find((v) => v.value === '0')!;
    expect(facetValue.label).toBe('Front → Back');
    expect(chipsOf(selection, libCtx, scopeCtx)[0].label).toBe(`Direction: ${facetValue.label}`);
    // Without the scope, every card type of the library is named.
    expect(chipsOf(selection, libCtx)[0].label).toBe('Direction: Front → Back / Card');
  });

  it('a field called "Tags" names its card type on its chip, EXACTLY like its FacetSheet group', () => {
    const verbs: NoteType = {
      ...VOCAB,
      id: 'nt-verbs',
      fields: [
        { name: 'Verb', role: 'term', facet: 'off' },
        { name: 'Tags', role: 'detail', facet: 'on', multiSep: ',' },
      ],
    };
    const n = makeNote({ id: 'v1', typeId: verbs.id, fields: ['gehen', 'irregular, sein'], tags: ['Verbs'] }, NOW);
    const local: MatchCtx = { ...ctx, index: buildLibraryIndex([n], [verbs]) };
    // Wave 5c: chipsOf names the field group with its card types (like
    // deriveFacets), not " (field)" — so the triage title and the Library say the same.
    expect(chipsOf({ fields: { tags: ['irregular'] }, tags: ['verbs'] }, local).map((c) => c.label)).toEqual([
      `Tags (${VOCAB.name}): irregular`,
      'Tag: Verbs',
    ]);
    const card = makeCard(n, 0, 'd1', DEFAULT_SRS, NOW, { id: 'v1-0' });
    const group = deriveFacets([card], {}, { fields: { tags: ['irregular'] } }, local).find((f) => f.key === 'field:tags');
    expect(chipsOf({ fields: { tags: ['irregular'] } }, local)[0].label).toBe(`${group!.label}: irregular`);
  });

  it('the Direction chip uses the deck languages, like the FacetSheet value (Basic + reverse deck in German)', () => {
    const reverse = builtinType('basicReverse', NOW);
    const deck = makeDeck({ id: 'd-w', name: 'Wörter', language: 'de-DE', meaningLanguage: 'en-US' }, NOW);
    const wNotes = [0, 1].map((i) => makeNote({ id: `w${i}`, typeId: reverse.id, fields: [`Wort ${i}`, `word ${i}`, '', ''] }, NOW));
    const wCards = wNotes.flatMap((n) => [0, 1].map((ord) => makeCard(n, ord, deck.id, DEFAULT_SRS, NOW, { id: `${n.id}-${ord}` })));
    const wCtx: MatchCtx = { now: NOW, index: buildLibraryIndex(wNotes, [reverse]), decks: new Map([[deck.id, deck]]), lists: listsById([]) };
    const scope = buildSearchCtx(wCards, wCtx);
    const facetLabels = deriveFacets(wCards, {}, {}, wCtx)
      .find((f) => f.key === 'direction')!
      .values.map((v) => v.label);
    expect(facetLabels).toEqual(['German → English', 'English → German']);
    expect(chipsOf({ directions: [0, 1] }, wCtx, scope)[0].label).toBe(`Direction: ${facetLabels.join(', ')}`);
    // Without the scope only the card types' own languages are known.
    expect(chipsOf({ directions: [0] }, wCtx)[0].label).toBe('Direction: Front → Back');
  });

  it('sections of several decks carry the deck name', () => {
    const [chip] = chipsOf(parse('section:verbs::b1').query, ctx);
    expect(chip.label).toBe('Section: German › Verbs › B1, Español › Verbs › B1');
  });

  it('removeChip removes exactly that group', () => {
    const q: Query = { fields: { level: ['b1'], category: ['x'] }, tags: ['a'], hard: true };
    expect(removeChip(q, 'field:level')).toEqual({ fields: { category: ['x'] }, tags: ['a'], hard: true });
    expect(removeChip(q, 'tags')).toEqual({ fields: { level: ['b1'], category: ['x'] }, hard: true });
    expect(removeChip(q, 'hard')).toEqual({ fields: { level: ['b1'], category: ['x'] }, tags: ['a'] });
    // Every chip of a query removed → empty query.
    let rest = q;
    for (const chip of chipsOf(q, ctx)) rest = removeChip(rest, chip.id);
    expect(rest).toEqual({});
  });

  it('mergeQueries adds typed tokens to the chips already there', () => {
    expect(
      mergeQueries({ tags: ['a'], fields: { level: ['a1'] }, due: 'now', text: 'haus' }, parse('tag:b level:b1 is:duetoday maus').query),
    ).toEqual({ tags: ['a', 'b'], fields: { level: ['a1', 'b1'] }, due: 'today', text: 'haus maus' });
  });
});

/* ------------------------------------- field names that are user data */

/** Object.prototype is still exactly as JavaScript made it. */
function expectNoPollution(): void {
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(({} as { constructor: unknown }).constructor).toBe(Object);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
}

describe('field names that are also Object members (constructor, __proto__, toString, hasOwnProperty)', () => {
  // A programming deck: a "Constructor" field (copy / default / move) and other unlucky names.
  const PROG: NoteType = {
    ...VOCAB,
    id: 'nt-prog',
    name: 'C++',
    fields: [
      { name: 'Front', role: 'term', facet: 'off' },
      { name: 'Level', role: 'badge', facet: 'on' },
      { name: 'Constructor', role: 'badge', facet: 'on' },
      { name: '__proto__', role: 'badge', facet: 'on' },
      { name: 'toString', role: 'badge', facet: 'on' },
      { name: 'hasOwnProperty', role: 'badge', facet: 'on' },
    ],
    templates: [{ ord: 0, name: 'Card', prompt: [0], answer: [1] }],
  };
  const progNotes = [
    makeNote({ id: 'p1', typeId: PROG.id, fields: ['Rule of three', 'B1', 'Copy', 'yes', 'a', 'x'] }, NOW),
    makeNote({ id: 'p2', typeId: PROG.id, fields: ['Rule of zero', 'B2', 'Default', 'no', 'b', 'y'] }, NOW),
  ];
  const progCards = progNotes.map((n) => makeCard(n, 0, 'd-code', DEFAULT_SRS, NOW, { id: `${n.id}-c0` }));
  const progCtx: MatchCtx = { now: NOW, index: buildLibraryIndex(progNotes, [PROG]), decks: DECKS, lists: listsById([]) };
  const progScope = buildSearchCtx(progCards, progCtx);

  it('`constructor:copy` is a field chip (it used to crash in sanitizeQuery)', () => {
    expect(parse('constructor:copy', progScope)).toEqual({ query: { fields: { constructor: ['copy'] } }, rest: '', hints: [] });
    expect(parse('level:b1 Constructor:copy constructor:default tostring:a hasownproperty:x', progScope).query).toEqual({
      fields: { level: ['b1'], constructor: ['copy', 'default'], tostring: ['a'], hasownproperty: ['x'] },
    });
    const match = compileQuery(parse('constructor:copy', progScope).query, progCtx);
    expect(progCards.filter(match).map((c) => c.id)).toEqual(['p1-c0']);
    expectNoPollution();
  });

  it('`__proto__:yes` cannot be typed (a key starts with a letter): it stays text, nothing breaks', () => {
    expect(parse('__proto__:yes', progScope)).toEqual({ query: { text: '__proto__:yes' }, rest: '__proto__:yes', hints: [] });
  });

  it('is:constructor and friends are unknown filters (is:constructor used to vanish without a chip or a hint)', () => {
    const cases: [string, string][] = [
      ['is:constructor', 'is:constructor'],
      ['is:toString', 'is:tostring'],
      ['is:hasOwnProperty', 'is:hasownproperty'],
      ['is:__proto__', 'is:__proto__'],
      ['-is:constructor', '-is:constructor'],
    ];
    for (const [typed, text] of cases) {
      expect(parse(typed)).toEqual({ query: { text }, rest: typed, hints: [`Unknown filter '${typed}'.`] });
    }
  });

  it('chips, remove, merge and the text round trip keep every one of these fields', () => {
    const q = normalizeQuery({
      fields: Object.fromEntries([
        ['level', ['b1']],
        ['constructor', ['copy']],
        ['__proto__', ['yes']],
        ['tostring', ['a']],
      ]),
    });
    expect(chipsOf(q, progCtx).map((c) => [c.id, c.label])).toEqual([
      ['field:level', 'Level: B1'],
      ['field:constructor', 'Constructor: Copy'],
      // Wave 5c: a field name is made readable like everywhere else (render.ts humanizeFieldName).
      ['field:__proto__', 'Proto: yes'],
      ['field:tostring', 'To String: a'],
    ]);
    expect(removeChip(q, 'field:__proto__')).toEqual({ fields: { level: ['b1'], constructor: ['copy'], tostring: ['a'] } });
    expect(Object.keys(removeChip(q, 'field:constructor').fields!)).toEqual(['level', '__proto__', 'tostring']);
    expect(Object.keys(mergeQueries(q, parse('constructor:default', progScope).query).fields!)).toEqual([
      'level',
      'constructor',
      '__proto__',
      'tostring',
    ]);
    expect(mergeQueries(q, parse('constructor:default', progScope).query).fields!.tostring).toEqual(['a']);
    // '__proto__' cannot be typed, so it stays a chip; the rest is text.
    const text = formatSearch(q, progCtx, progScope);
    expect(text).toBe('level:b1 constructor:copy tostring:a');
    expect(chipOnlyPart(q, progScope)).toEqual({ fields: Object.fromEntries([['__proto__', ['yes']]]) });
    expect(sameQuery(mergeQueries(chipOnlyPart(q, progScope), parse(text, progScope).query), q)).toBe(true);
    // Removing the '__proto__' chip is a real change.
    expect(sameQuery(removeChip(q, 'field:__proto__'), q)).toBe(false);
    expectNoPollution();
  });
});

describe('wave 5c — chipsOf is the ONE place that names a chip (triage and Progress read the same names)', () => {
  /** Two card types with different template names that share their two directions, and a CamelCase field. */
  function twoTypes() {
    const verbs: NoteType = {
      ...VOCAB,
      id: 'nt-verbs',
      name: 'German Verbs (bidirectional)',
      fields: [
        { name: 'Verb', role: 'term', facet: 'off' },
        { name: 'Meaning', role: 'meaning', facet: 'off' },
        { name: 'WordType', role: 'badge', facet: 'on' },
      ],
      templates: [
        { ord: 0, name: 'Forward', prompt: [0], answer: [1] },
        { ord: 1, name: 'Reverse', prompt: [1], answer: [0] },
      ],
    };
    const words: NoteType = { ...verbs, id: 'nt-words', name: 'German Vocabulary', fields: verbs.fields.slice(0, 2), templates: VOCAB.templates };
    const libNotes = [
      makeNote({ id: 'v1', typeId: verbs.id, fields: ['gehen', 'to go', 'strong'] }, NOW),
      makeNote({ id: 'v2', typeId: verbs.id, fields: ['machen', 'to make', 'weak'] }, NOW),
      makeNote({ id: 'w1', typeId: words.id, fields: ['das Haus', 'the house'] }, NOW),
    ];
    const libCards = libNotes.flatMap((n) => [0, 1].map((ord) => makeCard(n, ord, 'd-de', DEFAULT_SRS, NOW, { id: `${n.id}-${ord}` })));
    const libCtx: MatchCtx = { now: NOW, index: buildLibraryIndex(libNotes, [verbs, words]), decks: DECKS, lists: listsById([]) };
    return { libCards, libCtx };
  }

  it('a CamelCase field: the chip says "Word Type", like its FacetSheet group; the query, the chip id and the typed token use the KEY', () => {
    const { libCards, libCtx } = twoTypes();
    const scope = buildSearchCtx(libCards, libCtx);
    // Typed by the key (the folded field name): the same query a tap in the sheet makes.
    const typed = parseSearch('wordtype:strong', scope).query;
    expect(typed).toEqual({ fields: { wordtype: ['strong'] } });
    const group = deriveFacets(libCards, {}, typed, libCtx).find((f) => f.key === 'field:wordtype')!;
    expect(group.label).toBe('Word Type');
    const [chip] = chipsOf(typed, libCtx);
    expect(chip).toEqual({ id: 'field:wordtype', label: 'Word Type: strong', facet: 'field:wordtype' });
    expect(chip.label.startsWith(`${group.label}: `)).toBe(true);
    // The × removes it by its key, and the text round trip writes the key.
    expect(removeChip(typed, chip.id)).toEqual({});
    expect(formatSearch(typed, libCtx, scope)).toBe('wordtype:strong');
  });

  it('the Direction chip uses the GROUP names ("Back → Front") whenever the scope knows the directions', () => {
    const { libCards, libCtx } = twoTypes();
    const scope = buildSearchCtx(libCards, libCtx);
    const facetValues = deriveFacets(libCards, {}, {}, libCtx)
      .find((f) => f.key === 'direction')!
      .values.map((v) => v.label);
    expect(facetValues).toEqual(['Front → Back', 'Back → Front']);
    expect(chipsOf({ directions: [1] }, libCtx, scope)[0].label).toBe('Direction: Back → Front');
    expect(chipsOf({ directions: [0, 1] }, libCtx, scope)[0].label).toBe('Direction: Front → Back, Back → Front');
    // Without the scope: the per-direction names of every card type (the old rule).
    expect(chipsOf({ directions: [1] }, libCtx)[0].label).toBe('Direction: Reverse / EN-DE');
  });
});

describe('wave 5c, review round 1 — a field can be typed by the name its chip shows', () => {
  /** Imported card types whose field names are not words: "WordType", "CEFRLevel", "MarankiExample". */
  const WORDS: NoteType = {
    ...VOCAB,
    id: 'nt-words',
    name: 'German Vocabulary',
    fields: [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
      { name: 'WordType', role: 'badge', facet: 'on' },
      { name: 'CEFRLevel', role: 'badge', facet: 'on' },
      { name: 'MarankiExample', role: 'badge', facet: 'on' },
    ],
  };
  /** A field whose label a card type CHOSE: "Tags", shown as "Verb type" (the German pack preset). */
  const VERBS: NoteType = {
    ...VOCAB,
    id: 'nt-verbs',
    name: 'German Verbs',
    fields: [
      { name: 'Verb', role: 'term', facet: 'off' },
      { name: 'Tags', label: 'Verb type', role: 'badge', facet: 'on' },
    ],
    templates: [{ ord: 0, name: 'Card', prompt: [0], answer: [1] }],
  };
  const wNotes = [
    makeNote({ id: 'w1', typeId: WORDS.id, fields: ['das Haus', 'the house', 'noun', 'A1', 'Das Haus ist groß.'] }, NOW),
    makeNote({ id: 'w2', typeId: WORDS.id, fields: ['gehen', 'to go', 'verb', 'A2', 'Ich gehe.'] }, NOW),
    makeNote({ id: 'v1', typeId: VERBS.id, fields: ['sein', 'irregular'] }, NOW),
  ];
  const wCards = wNotes.map((n) => makeCard(n, 0, 'd-de', DEFAULT_SRS, NOW, { id: `${n.id}-c0` }));
  const wCtx: MatchCtx = { now: NOW, index: buildLibraryIndex(wNotes, [WORDS, VERBS]), decks: DECKS, lists: listsById([]) };
  const scope = buildSearchCtx(wCards, wCtx);

  it('`word_type:noun` and `cefr_level:a1` make the same query as the keys `wordtype:noun` / `cefrlevel:a1`', () => {
    const byKey = parseSearch('wordtype:noun cefrlevel:a1', scope);
    expect(byKey).toEqual({ query: { fields: { wordtype: ['noun'], cefrlevel: ['a1'] } }, rest: '', hints: [] });
    for (const typed of ['word_type:noun cefr_level:a1', 'Word-Type:noun CEFR_Level:A1', 'wordType:noun cefr-level:a1']) {
      expect([typed, parseSearch(typed, scope)]).toEqual([typed, byKey]);
    }
    // The chips show those names: what the learner reads is what the learner may type.
    expect(chipsOf(byKey.query, wCtx).map((c) => c.label)).toEqual(['Word Type: noun', 'CEFR Level: A1']);
    // And it finds the cards.
    const match = compileQuery(parseSearch('word_type:noun', scope).query, wCtx);
    expect(wCards.filter(match).map((c) => c.id)).toEqual(['w1-c0']);
  });

  it('the readable name drops the app prefix ("Example") and uses a label a card type chose ("Verb type")', () => {
    expect(chipsOf({ fields: { marankiexample: ['ich gehe.'] } }, wCtx)[0].label.startsWith('Example: ')).toBe(true);
    expect(parseSearch('example:"ich gehe."', scope).query).toEqual({ fields: { marankiexample: ['ich gehe.'] } });
    expect(chipsOf({ fields: { tags: ['irregular'] } }, wCtx)[0].label).toBe('Verb type: irregular');
    expect(parseSearch('verb_type:irregular', scope).query).toEqual({ fields: { tags: ['irregular'] } });
    // The key still works, and a name the scope does not have is still text with the hint.
    expect(parseSearch('tags:irregular', scope).query).toEqual({ fields: { tags: ['irregular'] } });
    expect(parseSearch('word_kind:noun', scope)).toEqual({
      query: { text: 'word_kind:noun' },
      rest: 'word_kind:noun',
      hints: ["No field called 'word_kind' here."],
    });
  });

  it('a real field name always wins over a readable name; a name two fields share is not guessed', () => {
    const OWN: NoteType = {
      ...VOCAB,
      id: 'nt-own',
      name: 'Own',
      fields: [
        { name: 'Front', role: 'term', facet: 'off' },
        // Its key is 'example': the same word as the readable name of "MarankiExample".
        { name: 'Example', role: 'badge', facet: 'on' },
        // "Word type" (key 'word type') and "WordType" (key 'wordtype') read the same.
        { name: 'Word type', role: 'badge', facet: 'on' },
      ],
      templates: [{ ord: 0, name: 'Card', prompt: [0], answer: [1] }],
    };
    const own = makeNote({ id: 'o1', typeId: OWN.id, fields: ['x', 'own example', 'adj'] }, NOW);
    const both = [...wNotes, own];
    const bothCtx: MatchCtx = { now: NOW, index: buildLibraryIndex(both, [WORDS, VERBS, OWN]), decks: DECKS, lists: listsById([]) };
    const bothScope = buildSearchCtx(
      both.map((n) => makeCard(n, 0, 'd-de', DEFAULT_SRS, NOW, { id: `${n.id}-c0` })),
      bothCtx,
    );
    expect(parseSearch('example:x', bothScope).query).toEqual({ fields: { example: ['x'] } });
    // 'word_type' is the field "Word type" ('_' for a space); 'wordtype' the field "WordType" (its key).
    expect(parseSearch('word_type:adj', bothScope).query).toEqual({ fields: { 'word type': ['adj'] } });
    expect(parseSearch('wordtype:noun', bothScope).query).toEqual({ fields: { wordtype: ['noun'] } });
    // 'word-type' could be either field: it is not guessed.
    expect(parseSearch('word-type:noun', bothScope).hints).toEqual(["No field called 'word-type' here."]);
  });

  it('the text round trip still writes the key, and parses back to the same chip', () => {
    const q: Query = { fields: { wordtype: ['noun'], tags: ['irregular'] } };
    const text = formatSearch(q, wCtx, scope);
    expect(text).toBe('wordtype:noun tags:irregular');
    expect(sameQuery(parseSearch(text, scope).query, q)).toBe(true);
    expect(chipOnlyPart(q, scope)).toEqual({});
  });
});
