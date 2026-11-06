/**
 * One query, one evaluator (spec §4.1): every group of the table, the tag
 * hierarchy, accent folding, Review vs Due, list resolution one level deep,
 * and the helpers that keep route params and stored lists safe.
 *
 * The library is built with the shared v3 constructors (makeV3,
 * builtinTypes), so notes and cards look exactly like the app's.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW as NOW, localTime } from '../test/clock';
import { builtinType } from './builtinTypes';
import { buildLibraryIndex } from './libraryIndex';
import { listsById } from './lists';
import { makeCard, type MakeCardOpts, makeDeck, makeNote } from './makeV3';
import type { Card, ListDef, Note, NoteType, Query } from './model';
import {
  compileQuery,
  endOfLocalDay,
  explicitDecks,
  fieldRecord,
  isEmptyQuery,
  type MatchCtx,
  normalizeQuery,
  ownValue,
  parseQueryParam,
  sameQuery,
  sanitizeQuery,
  serializeQuery,
  textWords,
} from './query';
import { DAY, DEFAULT_SRS, HOUR, MIN } from './types';

/* ------------------------------------------------------------- library */

const VOCAB: NoteType = {
  id: 'nt-vocab',
  name: 'German Vocabulary',
  kind: 'standard',
  fields: [
    { name: 'Word', role: 'term', facet: 'auto' },
    { name: 'Translation', role: 'meaning', facet: 'auto' },
    { name: 'Level', role: 'badge', facet: 'on' },
    { name: 'Tags', role: 'detail', facet: 'on', multiSep: ',' },
  ],
  templates: [
    { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
    { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
  ],
  sortField: 0,
  createdAt: NOW,
  updatedAt: NOW,
};
const BASIC = builtinType('basic', NOW);
const TYPES = [VOCAB, BASIC];

const german = makeDeck({ id: 'd-de', name: 'German', order: 0 }, NOW);
const spanish = makeDeck({ id: 'd-es', name: 'Spanish', order: 1, active: false }, NOW);
const DECKS = new Map([german, spanish].map((d) => [d.id, d]));

const notes: Note[] = [];
const cards: Card[] = [];

/** Add a note and one card per ord in `ords`. Returns the cards. */
function add(
  id: string,
  typeId: string,
  fields: string[],
  deckId: string,
  opts: { tags?: string[]; section?: string; ords?: number[]; card?: Omit<MakeCardOpts, 'id'> } = {},
): Card[] {
  const note = makeNote({ id, typeId, fields, tags: opts.tags ?? [], section: opts.section ?? '' }, NOW);
  notes.push(note);
  const made = (opts.ords ?? [0]).map((ord) => makeCard(note, ord, deckId, DEFAULT_SRS, NOW, { id: `${id}-c${ord}`, ...opts.card }));
  cards.push(...made);
  return made;
}

const LEARNING_DUE = { reps: 1, stepIndex: 0, intervalDays: 0, due: NOW - MIN, lastReviewedAt: NOW - 10 * MIN };
const REVIEW_LATER = { reps: 4, stepIndex: null, intervalDays: 6, due: NOW + 3 * DAY, lastReviewedAt: NOW - 3 * DAY };
const REVIEW_DUE = { ...REVIEW_LATER, due: NOW - DAY };
const MASTERED_TODAY = { reps: 9, stepIndex: null, intervalDays: 30, due: NOW + 2 * HOUR, lastReviewedAt: NOW - 30 * DAY };

const [stunde, stundeRev] = add('stunde', 'nt-vocab', ['die Stunde', 'the hour', 'A1', 'noun'], 'd-de', {
  section: 'Vocabulary::A1',
  ords: [0, 1],
});
const [strasse] = add('strasse', 'nt-vocab', ['die Straße', 'the street', 'A2', 'noun, feminine'], 'd-de', {
  section: 'Vocabulary::A2',
  card: { ...REVIEW_DUE, fav: true },
});
const [gehen] = add('gehen', 'nt-vocab', ['gehen', 'to go', 'B1', 'verb, irregular'], 'd-de', {
  section: 'Verbs::B1',
  tags: ['Algo::Core_Patterns::Topic_Alpha', 'leech'],
  card: { ...LEARNING_DUE, flagged: true },
});
const [kaufen] = add('kaufen', 'nt-vocab', ['kaufen', 'to buy', 'B1', 'verb'], 'd-de', {
  section: 'Verbs::B1::Extra',
  tags: ['algo'],
  card: { ...REVIEW_LATER, suspended: true },
});
const [ueber] = add('ueber', 'nt-vocab', ['über', 'over', 'A1', ''], 'd-de', {
  section: 'Verbsy',
  tags: ['Algoly'],
  card: { ...MASTERED_TODAY, buriedUntil: NOW + 5 * HOUR },
});
const [known] = add('known', 'nt-vocab', ['bekannt', 'known', 'C1', ''], 'd-de', { card: { knownAt: NOW - DAY, reps: 3, intervalDays: 5 } });
const [notStarted] = add('ns', 'nt-vocab', ['neu', 'new', 'C1', ''], 'd-de', { card: { newState: 'notStarted' } });
const [hard] = add('hard', 'nt-basic', ['hart', 'hard', '', ''], 'd-es', { card: { ...REVIEW_LATER, ease: 2.2, intervalDays: 8 } });
const [leech] = add('leech', 'nt-basic', ['Blutegel', 'leech', '', ''], 'd-es', { card: { ...REVIEW_LATER, lapses: 8, ease: 2.5, intervalDays: 30 } });
const [youngKnown] = add('yk', 'nt-basic', ['jung', 'young', '', ''], 'd-es', { card: { ...REVIEW_LATER, knownAt: NOW, ease: 1.5 } });

const USER_LISTS: ListDef[] = [
  { id: 'l-b1', name: 'B1 verbs', icon: '📗', query: { fields: { level: ['b1'] } }, createdAt: NOW, updatedAt: NOW },
  // A list that names another list: resolution is one level only, so the inner list is ignored.
  { id: 'l-nested', name: 'Nested', icon: '🪆', query: { list: 'l-b1', decks: ['d-es'] }, createdAt: NOW, updatedAt: NOW },
];

const ctx: MatchCtx = {
  now: NOW,
  index: buildLibraryIndex(notes, TYPES),
  decks: DECKS,
  lists: listsById(USER_LISTS),
};

/** The ids of the cards that match `q`, sorted. */
function ids(q: Query, c: MatchCtx = ctx): string[] {
  const match = compileQuery(q, c);
  return cards.filter(match).map((x) => x.id).sort();
}
const idsOf = (...xs: Card[]) => xs.map((x) => x.id).sort();

/* --------------------------------------------------------------- tests */

describe('compileQuery — every group of §4.1', () => {
  it('an empty query matches every card', () => {
    expect(ids({})).toEqual(idsOf(...cards));
  });

  it('decks: OR over deck membership', () => {
    expect(ids({ decks: ['d-es'] })).toEqual(idsOf(hard, leech, youngKnown));
    expect(ids({ decks: ['d-es', 'd-de'] })).toHaveLength(cards.length);
  });

  it("sections: the path and everything below it, on '::' boundaries only", () => {
    expect(ids({ sections: [{ deckId: 'd-de', path: 'verbs' }] })).toEqual(idsOf(gehen, kaufen));
    expect(ids({ sections: [{ deckId: 'd-de', path: 'Verbs::B1' }] })).toEqual(idsOf(gehen, kaufen));
    expect(ids({ sections: [{ deckId: 'd-de', path: 'verbs::b1::extra' }] })).toEqual(idsOf(kaufen));
    // 'Verbsy' is not below 'Verbs'.
    expect(ids({ sections: [{ deckId: 'd-de', path: 'verbsy' }] })).toEqual(idsOf(ueber));
    // The same path in another deck matches nothing.
    expect(ids({ sections: [{ deckId: 'd-es', path: 'verbs' }] })).toEqual([]);
  });

  it('fields: OR inside a field, AND across fields; values and names fold', () => {
    expect(ids({ fields: { level: ['b1'] } })).toEqual(idsOf(gehen, kaufen));
    expect(ids({ fields: { Level: ['A1', 'b1'] } })).toEqual(idsOf(stunde, stundeRev, gehen, kaufen, ueber));
    // Multi-value field: 'verb' is one of the split values.
    expect(ids({ fields: { tags: ['verb'] } })).toEqual(idsOf(gehen, kaufen));
    expect(ids({ fields: { level: ['b1'], tags: ['irregular'] } })).toEqual(idsOf(gehen));
    // A field the note type does not have matches nothing.
    expect(ids({ fields: { level: ['a1'], color: ['red'] } })).toEqual([]);
  });

  it('noteTypes and directions', () => {
    expect(ids({ noteTypes: ['nt-basic'] })).toEqual(idsOf(hard, leech, youngKnown));
    expect(ids({ directions: [1] })).toEqual(idsOf(stundeRev));
  });

  it("tags: a parent matches its children ('algo' ⊇ 'Algo::Core_Patterns::X'), not 'Algoly'", () => {
    expect(ids({ tags: ['algo'] })).toEqual(idsOf(gehen, kaufen));
    expect(ids({ tags: ['algo::core_patterns'] })).toEqual(idsOf(gehen));
    expect(ids({ tags: ['ALGO::Core_Patterns::Topic_Alpha'] })).toEqual(idsOf(gehen));
    expect(ids({ tags: ['algoly', 'leech'] })).toEqual(idsOf(gehen, ueber));
  });

  it('notTags: no note tag may match (same prefix rule)', () => {
    const all = idsOf(...cards);
    expect(ids({ notTags: ['algo'] })).toEqual(all.filter((id) => !idsOf(gehen, kaufen).includes(id)));
  });

  it("tags are cleaned like the tag tree: 'Algo::' is 'algo', 'A :: B' is 'a::b'", () => {
    const odd = makeNote({ id: 'odd', typeId: 'nt-basic', fields: ['x', 'y', '', ''], tags: ['Algo::', 'Core :: Topic_Alpha'] }, NOW);
    const card = makeCard(odd, 0, 'd-es', DEFAULT_SRS, NOW, { id: 'odd-c0' });
    const c: MatchCtx = { ...ctx, index: buildLibraryIndex([odd], TYPES) };
    const matches = (q: Query) => compileQuery(q, c)(card);
    expect(matches({ tags: ['algo'] })).toBe(true);
    expect(matches({ tags: ['core'] })).toBe(true);
    expect(matches({ tags: ['core::topic_alpha'] })).toBe(true);
    // A query tag is cleaned the same way as the note tag.
    expect(matches({ tags: ['Core :: Topic_Alpha'] })).toBe(true);
    expect(matches({ notTags: ['algo::'] })).toBe(false);
    expect(sanitizeQuery({ tags: ['Algo::', ' A :: B ', 'a::b'], notTags: ['::'] })).toEqual({ tags: ['algo', 'a::b'] });
  });

  it('life: one lifecycle per card (§4.5)', () => {
    expect(ids({ life: ['notStarted'] })).toEqual(idsOf(notStarted));
    expect(ids({ life: ['new'] })).toEqual(idsOf(stunde, stundeRev));
    expect(ids({ life: ['learning'] })).toEqual(idsOf(gehen));
    expect(ids({ life: ['known'] })).toEqual(idsOf(known, youngKnown));
    expect(ids({ life: ['mastered'] })).toEqual(idsOf(ueber, leech));
  });

  it('Review is a STATUS, Due is a separate filter', () => {
    // Review: graduated, interval < 21 days — due or not.
    expect(ids({ life: ['review'] })).toEqual(idsOf(strasse, kaufen, hard));
    // Due now: learning/review/mastered whose time has come, not suspended/buried.
    expect(ids({ due: 'now' })).toEqual(idsOf(strasse, gehen));
    // A due Learning card is "Learning" AND "Due"; a Review card that is not due is not "Due".
    expect(ids({ life: ['review'], due: 'now' })).toEqual(idsOf(strasse));
  });

  it("due 'today' adds cards due later today, but never buried or suspended ones", () => {
    const later = { ...MASTERED_TODAY };
    const n = makeNote({ id: 'today', typeId: 'nt-basic', fields: ['a', 'b', '', ''] }, NOW);
    const c = makeCard(n, 0, 'd-de', DEFAULT_SRS, NOW, { id: 'today-c0', ...later });
    const local: MatchCtx = { ...ctx, index: buildLibraryIndex([...notes, n], TYPES) };
    expect(compileQuery({ due: 'today' }, local)(c)).toBe(true);
    expect(compileQuery({ due: 'now' }, local)(c)).toBe(false);
    // ueber is due later today but buried.
    expect(ids({ due: 'today' })).toEqual(idsOf(strasse, gehen));
    // Tomorrow's card is not due today.
    expect(compileQuery({ due: 'today' }, local)({ ...c, due: endOfLocalDay(NOW) + 1 })).toBe(false);
  });

  it('flags: every flag holds (AND); paused = the deck is paused', () => {
    expect(ids({ flags: ['fav'] })).toEqual(idsOf(strasse));
    expect(ids({ flags: ['flagged'] })).toEqual(idsOf(gehen));
    expect(ids({ flags: ['suspended'] })).toEqual(idsOf(kaufen));
    expect(ids({ flags: ['buried'] })).toEqual(idsOf(ueber));
    expect(ids({ flags: ['paused'] })).toEqual(idsOf(hard, leech, youngKnown));
    expect(ids({ flags: ['fav', 'flagged'] })).toEqual([]);
  });

  it('buried ends when buriedUntil has passed', () => {
    const later: MatchCtx = { ...ctx, now: NOW + 6 * HOUR };
    expect(ids({ flags: ['buried'] }, later)).toEqual([]);
  });

  it('notFlags: no listed flag holds', () => {
    expect(ids({ notFlags: ['paused', 'suspended', 'buried'] })).toEqual(
      idsOf(stunde, stundeRev, strasse, gehen, known, notStarted),
    );
  });

  it('hard / young / leech as defined in §3.4 (Known cards are never hard or young)', () => {
    expect(ids({ hard: true })).toEqual(idsOf(hard));
    expect(ids({ young: true })).toEqual(idsOf(strasse, gehen, kaufen));
    expect(ids({ leech: true })).toEqual(idsOf(leech));
  });

  it('text: every word must match, any field, any order; accents fold ("uber" finds "über")', () => {
    expect(ids({ text: 'uber' })).toEqual(idsOf(ueber));
    expect(ids({ text: 'Strasse' })).toEqual(idsOf(strasse));
    expect(ids({ text: 'hour die' })).toEqual(idsOf(stunde, stundeRev));
    expect(ids({ text: 'hour zebra' })).toEqual([]);
  });

  it('text: a "quoted phrase" is one word', () => {
    expect(ids({ text: '"die stunde"' })).toEqual(idsOf(stunde, stundeRev));
    expect(ids({ text: '"stunde die"' })).toEqual([]);
  });

  it('text also searches tags and sections ("topic alpha" finds Topic_Alpha)', () => {
    expect(ids({ text: '"topic alpha"' })).toEqual(idsOf(gehen));
    expect(ids({ text: 'vocabulary' })).toEqual(idsOf(stunde, stundeRev, strasse));
  });

  it('groups combine with AND', () => {
    expect(ids({ decks: ['d-de'], life: ['learning', 'review'], fields: { level: ['b1'] } })).toEqual(idsOf(gehen, kaufen));
  });

  it('empty groups never narrow', () => {
    expect(ids({ decks: [], tags: [], text: '  ', hard: false, fields: { level: [] } })).toHaveLength(cards.length);
  });
});

describe('compileQuery — lists', () => {
  it('a list matches its saved query; the rest of the query is ANDed', () => {
    expect(ids({ list: 'l-b1' })).toEqual(idsOf(gehen, kaufen));
    expect(ids({ list: 'l-b1', flags: ['flagged'] })).toEqual(idsOf(gehen));
  });

  it('built-in lists resolve from code', () => {
    expect(ids({ list: 'builtin:favorites' })).toEqual(idsOf(strasse));
    expect(ids({ list: 'builtin:suspended' })).toEqual(idsOf(kaufen));
  });

  it("resolution is ONE level deep: a list's own `list` key is ignored", () => {
    // l-nested = { list: 'l-b1', decks: ['d-es'] } → only its decks group counts.
    expect(ids({ list: 'l-nested' })).toEqual(idsOf(hard, leech, youngKnown));
  });

  it('an unknown list matches nothing (never the whole library)', () => {
    expect(ids({ list: 'deleted-list' })).toEqual([]);
  });
});

describe('explicitDecks', () => {
  it('names the decks in decks, sections and the list', () => {
    expect([...explicitDecks({ decks: ['d-de'] }, ctx)]).toEqual(['d-de']);
    expect([...explicitDecks({ sections: [{ deckId: 'd-es', path: 'x' }] }, ctx)]).toEqual(['d-es']);
    expect([...explicitDecks({ list: 'l-nested' }, ctx)]).toEqual(['d-es']);
    expect([...explicitDecks({ fields: { level: ['a1'] } }, ctx)]).toEqual([]);
  });
});

describe('query helpers', () => {
  it('isEmptyQuery', () => {
    expect(isEmptyQuery({})).toBe(true);
    expect(isEmptyQuery({ decks: [], text: ' ', hard: false, fields: { level: [] } })).toBe(true);
    expect(isEmptyQuery({ young: true })).toBe(false);
    expect(isEmptyQuery({ list: 'builtin:hard' })).toBe(false);
  });

  it('sanitizeQuery drops unknown keys and wrong types, folds and de-duplicates', () => {
    expect(
      sanitizeQuery({
        tags: ['B1', 'b1', 3],
        life: ['new', 'bogus'],
        flags: ['fav', 'nope'],
        directions: [1, 1, -1, 1.5, '2'],
        fields: { ' Level ': ['B1', 'b1', ''], x: 'not a list' },
        sections: [{ deckId: 'd', path: ' Verbs :: B1 ' }, { deckId: 'd', path: 'verbs::b1' }, { path: 'x' }],
        due: 'tomorrow',
        hard: 'yes',
        text: '  Über   Straße ',
        extra: 1,
      }),
    ).toEqual({
      tags: ['b1'],
      life: ['new'],
      flags: ['fav'],
      directions: [1],
      fields: { level: ['b1'] },
      sections: [{ deckId: 'd', path: 'verbs::b1' }],
      text: 'uber strasse',
    });
    expect(sanitizeQuery(null)).toEqual({});
    expect(sanitizeQuery([1, 2])).toEqual({});
  });

  it('normalizeQuery is idempotent', () => {
    const q: Query = { tags: ['A', 'a'], fields: { Level: ['B1'] }, text: 'Haus' };
    expect(normalizeQuery(normalizeQuery(q))).toEqual(normalizeQuery(q));
  });

  it('parseQueryParam never throws; serializeQuery round-trips', () => {
    const q: Query = { decks: ['d-de'], fields: { level: ['b1', 'b2'] }, life: ['new'], text: 'haus' };
    expect(parseQueryParam(serializeQuery(q))).toEqual(normalizeQuery(q));
    expect(parseQueryParam([serializeQuery(q), 'x'])).toEqual(normalizeQuery(q));
    expect(parseQueryParam('{not json')).toEqual({});
    expect(parseQueryParam('"a string"')).toEqual({});
    expect(parseQueryParam(undefined)).toEqual({});
    expect(parseQueryParam('')).toEqual({});
    expect(parseQueryParam('{"list":"builtin:hard"}')).toEqual({ list: 'builtin:hard' });
  });

  it('sameQuery ignores order, case and empty groups', () => {
    expect(sameQuery({ tags: ['b', 'a'], decks: [] }, { tags: ['A', 'b'] })).toBe(true);
    expect(sameQuery({ fields: { level: ['b2', 'b1'] } }, { fields: { Level: ['B1', 'B2'] } })).toBe(true);
    expect(sameQuery({ tags: ['a'] }, { tags: ['a', 'b'] })).toBe(false);
    expect(sameQuery({ flags: ['fav'] }, { notFlags: ['fav'] })).toBe(false);
  });

  it('textWords: folded words, quoted phrases, stray and unclosed quotes', () => {
    expect(textWords('Haus "die  Stunde"')).toEqual(['haus', 'die stunde']);
    expect(textWords('a"b')).toEqual(['ab']);
    expect(textWords('"open phrase')).toEqual(['open phrase']);
    expect(textWords('  ')).toEqual([]);
  });

  it('endOfLocalDay is the last millisecond of the local day', () => {
    const t = localTime('2026-06-10', '23:58');
    expect(endOfLocalDay(t)).toBe(localTime('2026-06-11', '00:00') - 1);
  });
});

/* ------------------------------------- field names that are user data */

/** Object.prototype is still exactly as JavaScript made it. */
function expectNoPollution(): void {
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(({} as { constructor: unknown }).constructor).toBe(Object);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
}

describe('field names from imported data are plain keys (constructor, __proto__, toString, hasOwnProperty)', () => {
  const PROG: NoteType = {
    ...VOCAB,
    id: 'nt-prog',
    name: 'C++',
    fields: [
      { name: 'Front', role: 'term', facet: 'off' },
      { name: 'Constructor', role: 'badge', facet: 'on' },
      { name: '__proto__', role: 'badge', facet: 'on' },
      { name: 'toString', role: 'badge', facet: 'on' },
      { name: 'hasOwnProperty', role: 'badge', facet: 'on' },
    ],
    templates: [{ ord: 0, name: 'Card', prompt: [0], answer: [1] }],
  };
  const progNotes = [
    makeNote({ id: 'p1', typeId: PROG.id, fields: ['Rule of three', 'Copy', 'yes', 'a', 'x'] }, NOW),
    makeNote({ id: 'p2', typeId: PROG.id, fields: ['Rule of zero', 'Default', 'no', 'b', 'x'] }, NOW),
  ];
  const progCards = progNotes.map((n) => makeCard(n, 0, 'd-de', DEFAULT_SRS, NOW, { id: `${n.id}-c0` }));
  const progCtx: MatchCtx = { ...ctx, index: buildLibraryIndex(progNotes, [PROG]) };
  const progIds = (q: Query) => progCards.filter(compileQuery(q, progCtx)).map((c) => c.id);
  /** A fields object with these OWN keys (an object literal cannot hold an own '__proto__' key). */
  const fieldsOf = (pairs: [string, string[]][]) => Object.fromEntries(pairs);

  it('sanitizeQuery keeps them and merges names that fold together (it used to throw)', () => {
    const raw: unknown = JSON.parse(
      '{"fields":{"Constructor":["Copy"],"constructor":["move","copy"],"__proto__":["Yes"],"toString":["A"],"hasOwnProperty":["X"]}}',
    );
    const q = sanitizeQuery(raw);
    expect(q).toEqual({
      fields: fieldsOf([
        ['constructor', ['copy', 'move']],
        ['__proto__', ['yes']],
        ['tostring', ['a']],
        ['hasownproperty', ['x']],
      ]),
    });
    // No prototype: even a careless `fields[name]` read finds only real fields.
    expect(Object.getPrototypeOf(q.fields)).toBeNull();
    expect(ownValue(q.fields, 'constructor')).toEqual(['copy', 'move']);
    expect(ownValue(q.fields, 'valueOf')).toBeUndefined();
    expect(ownValue({ level: ['b1'] }, 'constructor')).toBeUndefined();
    expect(ownValue(undefined, 'level')).toBeUndefined();
    expectNoPollution();
  });

  it('compileQuery matches on them', () => {
    expect(progIds({ fields: { constructor: ['copy'] } })).toEqual(['p1-c0']);
    expect(progIds({ fields: fieldsOf([['__proto__', ['no']]]) })).toEqual(['p2-c0']);
    expect(progIds({ fields: { tostring: ['a'], hasownproperty: ['x'] } })).toEqual(['p1-c0']);
    expect(progIds({ fields: { Constructor: ['COPY', 'default'] } })).toEqual(['p1-c0', 'p2-c0']);
  });

  it('the route param, sameQuery and isEmptyQuery keep a "__proto__" field', () => {
    const q = sanitizeQuery({ fields: fieldsOf([['__proto__', ['yes']]]) });
    expect(serializeQuery(q)).toBe('{"fields":{"__proto__":["yes"]}}');
    expect(parseQueryParam(serializeQuery(q))).toEqual(q);
    expect(Object.keys(parseQueryParam(serializeQuery(q)).fields!)).toEqual(['__proto__']);
    expect(isEmptyQuery(q)).toBe(false);
    // The comparison text keeps the key (on `{}` it used to become the prototype, so all values looked equal).
    expect(sameQuery(q, { fields: fieldsOf([['__proto__', ['no']]]) })).toBe(false);
    expect(sameQuery(q, parseQueryParam('{"fields":{"__proto__":["YES"]}}'))).toBe(true);
    expect(sameQuery(q, {})).toBe(false);
    expectNoPollution();
  });

  it('fieldRecord builds an object without a prototype; later pairs win', () => {
    const r = fieldRecord([
      ['__proto__', ['a']],
      ['constructor', ['b']],
      ['constructor', ['c']],
    ]);
    expect(Object.getPrototypeOf(r)).toBeNull();
    expect(Object.keys(r)).toEqual(['__proto__', 'constructor']);
    expect(r).toEqual(fieldsOf([['__proto__', ['a']], ['constructor', ['c']]]));
    expectNoPollution();
  });
});
