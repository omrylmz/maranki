/**
 * The facet engine (spec §4.3).
 *
 *   1. The Anki fixtures (src/domain/__fixtures__/anki: made-up text in the shape of the real decks, 20 notes per
 *      deck), turned into v3 notes by a small helper below — the way the
 *      import planner (W2-5) will do it: one deck per import, the longest
 *      common '::' prefix of the subdecks is the deck, the rest is
 *      `note.section` (spec §5.4), every field 'auto'.
 *        German  → Level + Section (+ card type collapsed) + Verb tags (multi)
 *        Spanish → Level + Type (section collapsed)
 *        Coding  → Category + tag tree (section collapsed)
 *        Basic   → built-ins only
 *   2. The rules: ≥ 2 values, one value → info line, a selected 0 stays,
 *      hidden zeros, value order, structure groups.
 *   3. DISJUNCTIVE COUNTS EQUAL A BRUTE-FORCE COUNT on 100 seeded random
 *      libraries: every count is checked against compileQuery on the query
 *      the value would produce, and no value with cards is missing.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW as NOW } from '../test/clock';
import { type AnkiFixtureName, ankiFixture } from '../test/factories';
import { threeWayType } from '../test/factoriesV3';
import { createRandom, type Random } from '../test/random';
import { builtinType } from './builtinTypes';
import {
  deriveFacets,
  DIRECTION_ROLE_LABELS,
  directionGroupNames,
  directionInfo,
  directionLabels,
  type Facet,
  type FacetKey,
  type FacetValue,
  fieldGroupLabel,
  fieldShownName,
  isFacetValueSelected,
  parseSectionValue,
  sectionValue,
  toggleFacetValue,
} from './facets';
import { buildLibraryIndex, pathPrefixes } from './libraryIndex';
import { LIFE_KEYS } from './life';
import { listsById } from './lists';
import { makeCard, type MakeCardOpts, makeDeck, makeNote } from './makeV3';
import type { Card, Deck, Note, NoteType, Query } from './model';
import { compileQuery, fieldRecord, FLAG_KEYS, type MatchCtx, normalizeQuery } from './query';
import { DAY, DEFAULT_SRS, HOUR, MIN } from './types';

/* ------------------------------------------------- fixtures → v3 notes */

interface Library {
  types: NoteType[];
  notes: Note[];
  cards: Card[];
  decks: Deck[];
}

/** Anki model JSON (only the keys used here). */
interface AnkiModel {
  name: string;
  type: 0 | 1;
  sortf: number;
  flds: { name: string; ord: number }[];
  tmpls: { name: string; ord: number }[];
}

/**
 * Import Anki fixtures into ONE deck, like "Choose sections → everything":
 * the longest common '::' prefix of the chosen subdecks is the deck, the rest
 * is the note's section; a note's subdeck is its lowest-ord card's home deck
 * (`odid` when not 0, else `did`). Fields are kept as they are, all 'auto';
 * one card per Anki card row, every card New. Fields of the new card are
 * picked explicitly (makeCard keeps any extra key it is given).
 */
function importAnki(names: AnkiFixtureName[], deckId: string, deckName?: string): Library {
  const types: NoteType[] = [];
  const raw: { note: Omit<Parameters<typeof makeNote>[0], 'section'>; path: string[]; cards: { id: string; ord: number }[] }[] = [];
  for (const name of names) {
    const fx = ankiFixture(name);
    const models = JSON.parse(fx.col.models) as Record<string, AnkiModel>;
    const ankiDecks = JSON.parse(fx.col.decks) as Record<string, { name: string }>;
    for (const [mid, m] of Object.entries(models)) {
      const fields = [...m.flds].sort((a, b) => a.ord - b.ord);
      types.push({
        id: `nt-anki-${mid}`,
        name: m.name,
        kind: m.type === 1 ? 'cloze' : 'standard',
        fields: fields.map((f, i) => ({ name: f.name, role: i === m.sortf ? 'term' : 'detail', facet: 'auto' })),
        templates: [...m.tmpls]
          .sort((a, b) => a.ord - b.ord)
          .map((t) => ({ ord: t.ord, name: t.name, prompt: [m.sortf], answer: [] })),
        sortField: m.sortf,
        source: { ankiMid: mid },
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    for (const n of fx.notes) {
      const rows = fx.cards.filter((c) => c.nid === n.id).sort((a, b) => a.ord - b.ord);
      const home = rows[0].odid !== 0 ? rows[0].odid : rows[0].did;
      raw.push({
        note: {
          id: `n-${n.id}`,
          typeId: `nt-anki-${n.mid}`,
          fields: n.flds.split('\x1f'),
          tags: n.tags.trim().split(/\s+/).filter(Boolean),
          guid: n.guid,
          order: n.id,
          source: { kind: 'apkg', ankiNoteId: String(n.id) },
        },
        path: ankiDecks[String(home)].name.split('::'),
        cards: rows.map((c) => ({ id: `c-${c.id}`, ord: c.ord })),
      });
    }
  }
  // Longest common '::' prefix of every note's subdeck path.
  let common = raw[0].path;
  for (const r of raw) {
    let k = 0;
    while (k < common.length && k < r.path.length && common[k] === r.path[k]) k += 1;
    common = common.slice(0, k);
  }
  const single = raw.every((r) => r.path.join('::') === raw[0].path.join('::'));
  const deck = makeDeck({ id: deckId, name: deckName ?? (single ? raw[0].path.join(' ') : common.join(' ')) }, NOW);
  const notes: Note[] = [];
  const cards: Card[] = [];
  for (const r of raw) {
    const section = single ? '' : r.path.slice(common.length).join('::');
    const note = makeNote({ ...r.note, section }, NOW);
    notes.push(note);
    for (const c of r.cards) cards.push(makeCard(note, c.ord, deckId, DEFAULT_SRS, NOW, { id: c.id }));
  }
  return { types, notes, cards, decks: [deck] };
}

/** A small deck of the built-in Basic type (no facet fields, one direction). */
function basicDeck(deckId: string, count: number): Library {
  const type = builtinType('basic', NOW);
  const notes = Array.from({ length: count }, (_, i) =>
    makeNote({ id: `b-${deckId}-${i}`, typeId: type.id, fields: [`front ${i}`, `back ${i}`, '', ''] }, NOW),
  );
  const cards = notes.map((n, i) =>
    makeCard(n, 0, deckId, DEFAULT_SRS, NOW, { id: `bc-${deckId}-${i}`, ...(i % 3 === 0 ? { fav: true } : {}) }),
  );
  return { types: [type], notes, cards, decks: [makeDeck({ id: deckId, name: 'My Basic deck' }, NOW)] };
}

/** Several libraries in one (one store). Card types are de-duplicated by id. */
function merge(...libs: Library[]): Library {
  const types = new Map<string, NoteType>();
  for (const l of libs) for (const t of l.types) if (!types.has(t.id)) types.set(t.id, t);
  return {
    types: [...types.values()],
    notes: libs.flatMap((l) => l.notes),
    cards: libs.flatMap((l) => l.cards),
    decks: libs.flatMap((l) => l.decks),
  };
}

function ctxOf(lib: Library, now = NOW): MatchCtx {
  return {
    now,
    index: buildLibraryIndex(lib.notes, lib.types),
    decks: new Map(lib.decks.map((d) => [d.id, d])),
    lists: listsById([]),
  };
}

const facetsOf = (lib: Library, scope: Query = {}, selection: Query = {}, ctx = ctxOf(lib)) =>
  deriveFacets(lib.cards, scope, selection, ctx);
const keysOf = (facets: Facet[]) => facets.filter((f) => f.info === undefined).map((f) => f.key);
const facet = (facets: Facet[], key: FacetKey) => facets.find((f) => f.key === key);
const labels = (values: FacetValue[] | undefined) => (values ?? []).map((v) => v.label);
const BUILT_INS: FacetKey[] = ['life', 'due', 'flags', 'hard', 'young', 'leech'];

const GERMAN = importAnki(['german_vocabulary', 'german_verbs', 'german_grammar'], 'd-german');
const SPANISH = importAnki(['spanish_vocabulary'], 'd-spanish');
const CODING = importAnki(['algo_patterns'], 'd-coding');

/* ------------------------------------------------------- 1. fixtures */

describe('fixtures → v3 (the test helper)', () => {
  it('follows spec §5.4: common prefix = deck, the rest = section', () => {
    expect(GERMAN.decks[0].name).toBe('German');
    expect(new Set(GERMAN.notes.map((n) => n.section))).toContain('Vocabulary::A1');
    expect(SPANISH.decks[0].name).toBe('Spanish Vocabulary');
    expect(new Set(SPANISH.notes.map((n) => n.section))).toEqual(new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']));
    expect(CODING.decks[0].name).toBe('Algo Deck');
    expect(GERMAN.cards).toHaveLength(100);
  });
});

describe('facets on the deck fixtures', () => {
  it('the data rule finds exactly Level, Verb Tags (multi), Type and Category', () => {
    const all = buildLibraryIndex([...GERMAN.notes, ...SPANISH.notes, ...CODING.notes], [...GERMAN.types, ...SPANISH.types, ...CODING.types]);
    expect([...all.fieldSpecs.keys()].sort()).toEqual(['category', 'level', 'tags', 'type']);
    expect(all.fieldSpecs.get('tags')?.multiSep).toBe(',');
    expect(all.fieldSpecs.get('level')?.multiSep).toBeUndefined();
  });

  it('German → Level + Section + Verb tags (multi) + Type + Tags; card type collapsed into the section', () => {
    const facets = facetsOf(GERMAN);
    expect(keysOf(facets)).toEqual([...BUILT_INS, 'section', 'field:level', 'field:tags', 'field:type', 'tag', 'direction']);
    expect(facets.some((f) => f.key === 'noteType')).toBe(false);

    // Version 2 of German Vocabulary has a Type field (part of speech): a filter
    // group by its data, only on the vocabulary cards (20 notes × 2 directions).
    const type = facet(facets, 'field:type')!;
    expect(type.label).toBe('Type');
    expect(labels(type.values).sort()).toEqual(['adjective', 'adverb', 'determiner', 'noun', 'prefix', 'verb']);
    expect(type.values[0]).toMatchObject({ label: 'noun', count: 16 });
    expect(type.values.reduce((s, v) => s + v.count, 0)).toBe(40);
    // Its notes are also tagged with the part of speech and the deck version.
    expect(labels(facet(facets, 'tag')!.values)).toEqual(expect.arrayContaining(['noun', 'verb', 'v2026-10']));

    const level = facet(facets, 'field:level')!;
    expect(level.ordinal).toBe('cefr');
    expect(labels(level.values)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
    expect(level.values.map((v) => v.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(level.values.reduce((s, v) => s + v.count, 0)).toBe(100);

    // Verb Tags are split: single words, only on verb cards.
    const tags = facet(facets, 'field:tags')!;
    expect(labels(tags.values)).toEqual(expect.arrayContaining(['regular', 'irregular', 'separable']));
    expect(tags.values.every((v) => !v.label.includes(','))).toBe(true);
    expect(tags.values.find((v) => v.value === 'regular')!.count).toBeLessThanOrEqual(40);

    // Section tree: Vocabulary / Verbs / Grammar, each level in CEFR order.
    const section = facet(facets, 'section')!;
    expect(section.kind).toBe('tree');
    expect(labels(section.values).sort()).toEqual(['Grammar', 'Verbs', 'Vocabulary']);
    const verbs = section.values.find((v) => v.label === 'Verbs')!;
    expect(verbs.count).toBe(40);
    expect(labels(verbs.children)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
    expect(verbs.children![0].value).toBe(sectionValue('d-german', 'verbs::a1'));
  });

  it('German directions: DE-EN (with the grammar card) and EN-DE', () => {
    const direction = facet(facetsOf(GERMAN), 'direction')!;
    expect(direction.values.map((v) => [v.value, v.label, v.count])).toEqual([
      ['0', 'DE-EN / Grammar Card', 60],
      ['1', 'EN-DE', 40],
    ]);
  });

  it('Spanish → Level + Type; the section equals Level and is collapsed', () => {
    const facets = facetsOf(SPANISH);
    expect(keysOf(facets)).toEqual([...BUILT_INS, 'field:level', 'field:type', 'direction']);
    expect(labels(facet(facets, 'field:type')!.values).sort()).toEqual(['adjective', 'noun', 'phrase', 'verb']);
  });

  it('Coding → Category + tag tree; the section equals Category and is collapsed', () => {
    const facets = facetsOf(CODING);
    expect(keysOf(facets)).toEqual([...BUILT_INS, 'field:category', 'tag']);
    const tag = facet(facets, 'tag')!;
    expect(tag.kind).toBe('tree');
    expect(labels(tag.values)).toEqual(['Algo']);
    // Underscores show as spaces; a parent counts all its children.
    expect(labels(tag.values[0].children).sort()).toEqual(['Advanced Patterns', 'Core Patterns', 'Dynamic Programming']);
    expect(tag.values[0].count).toBe(20);
    expect(tag.values[0].children!.reduce((s, v) => s + v.count, 0)).toBe(20);
    expect(tag.values[0].children![0].children?.[0].label).toMatch(/^[A-Z][^_]*$/);
  });

  it('a Basic deck → built-ins only', () => {
    expect(keysOf(facetsOf(basicDeck('d-basic', 12)))).toEqual(BUILT_INS);
  });

  it('the whole library: a deck scope gives that deck\'s groups; "All" adds Deck', () => {
    const lib = merge(GERMAN, SPANISH, CODING, basicDeck('d-basic', 12));
    const ctx = ctxOf(lib);
    expect(keysOf(deriveFacets(lib.cards, { decks: ['d-german'] }, {}, ctx))).toEqual(keysOf(facetsOf(GERMAN)));
    expect(keysOf(deriveFacets(lib.cards, { decks: ['d-spanish'] }, {}, ctx))).toEqual(keysOf(facetsOf(SPANISH)));
    expect(keysOf(deriveFacets(lib.cards, { decks: ['d-coding'] }, {}, ctx))).toEqual(keysOf(facetsOf(CODING)));
    const all = deriveFacets(lib.cards, {}, {}, ctx);
    expect(keysOf(all)).toContain('deck');
    expect(labels(facet(all, 'deck')!.values)).toHaveLength(4);
    // Level spans German and Spanish: one group.
    expect(facet(all, 'field:level')!.values.reduce((s, v) => s + v.count, 0)).toBe(140);
  });
});

/* ---------------------------------------------------------- 2. rules */

describe('facet rules', () => {
  it('one value → an info line: "All cards here are B1."', () => {
    const facets = facetsOf(GERMAN, { sections: [{ deckId: 'd-german', path: 'verbs::b1' }] });
    const level = facets.find((f) => f.key === 'field:level')!;
    expect(level.info).toBe('All cards here are B1.');
    expect(keysOf(facets)).not.toContain('field:level');
  });

  it('a selected value with 0 cards stays visible, so it can be removed', () => {
    const grammar = { sections: [{ deckId: 'd-german', path: 'grammar' }] };
    const facets = facetsOf(GERMAN, grammar, { fields: { level: ['c2'] } });
    const level = facet(facets, 'field:level')!;
    expect(level.values.find((v) => v.value === 'c2')).toEqual({ value: 'c2', label: 'C2', count: 0, selected: true, rank: 6 });
    // The other values keep their (disjunctive) counts.
    expect(labels(level.values)).toEqual(['A1', 'A2', 'B1', 'B2', 'C2']);
  });

  it('counts are disjunctive: picking A1 keeps the real count of A2', () => {
    const before = facet(facetsOf(GERMAN), 'field:level')!.values;
    const after = facet(facetsOf(GERMAN, {}, { fields: { level: ['a1'] } }), 'field:level')!.values;
    expect(after.map((v) => [v.value, v.count])).toEqual(before.map((v) => [v.value, v.count]));
    expect(after.find((v) => v.value === 'a1')!.selected).toBe(true);
    // Other groups count only A1 cards.
    const section = facet(facetsOf(GERMAN, {}, { fields: { level: ['a1'] } }), 'section')!;
    expect(section.values.reduce((s, v) => s + v.count, 0)).toBe(before[0].count);
  });

  it('values with count 0 are hidden; built-in groups are always there', () => {
    const facets = facetsOf(GERMAN);
    const status = facet(facets, 'life')!;
    expect(status.values.map((v) => [v.value, v.count])).toEqual([['new', 100]]);
    expect(facet(facets, 'hard')!.values).toEqual([]);
  });

  it('a group with a selected value is always shown (even a collapsed one)', () => {
    const facets = facetsOf(GERMAN, {}, { noteTypes: ['nt-anki-2710131000'] });
    expect(keysOf(facets)).toContain('noteType');
    expect(facet(facets, 'noteType')!.values.find((v) => v.selected)?.label).toBe('German Verbs (bidirectional)');
  });

  it('card types that do NOT split like a field or a section are shown', () => {
    // German Vocabulary (sections A1…C1) and Basic cards (deck root) in one deck.
    const lib = merge(importAnki(['german_vocabulary'], 'd1', 'Mixed'), basicDeck('d1', 10));
    lib.decks = [lib.decks[0]];
    const keys = keysOf(facetsOf(lib));
    expect(keys).toContain('noteType');
    // Level splits the cards exactly like the sections do (Basic cards: no
    // level, deck root), so the section is collapsed into Level.
    expect(keys).not.toContain('section');
    expect(keys).toContain('field:level');
  });

  it('cloze directions share one template name: no Direction group', () => {
    const cloze = builtinType('cloze', NOW);
    const notes = [0, 1, 2].map((i) => makeNote({ id: `z${i}`, typeId: cloze.id, fields: [`{{c1::a}} {{c2::b}} ${i}`, ''] }, NOW));
    const cards = notes.flatMap((n) => [0, 1].map((ord) => makeCard(n, ord, 'd', DEFAULT_SRS, NOW, { id: `${n.id}-${ord}` })));
    const lib: Library = { types: [cloze], notes, cards, decks: [makeDeck({ id: 'd', name: 'Cloze' }, NOW)] };
    expect(keysOf(facetsOf(lib))).toEqual(BUILT_INS);
  });

  it('one tag on every card says nothing; a tag on some cards is a group', () => {
    const lib = basicDeck('d', 6);
    lib.notes = lib.notes.map((n) => ({ ...n, tags: ['imported'] }));
    expect(keysOf(facetsOf(lib))).toEqual(BUILT_INS);
    lib.notes = lib.notes.map((n, i) => ({ ...n, tags: i < 2 ? ['leech'] : [] }));
    expect(keysOf(facetsOf(lib))).toEqual([...BUILT_INS, 'tag']);
  });

  it("a tag ending in '::' is no empty row; the tree value finds the cards", () => {
    const lib = basicDeck('d', 4);
    lib.notes = lib.notes.map((n, i) => ({ ...n, tags: i < 2 ? ['Algo::'] : ['Core :: Topic_Alpha'] }));
    const tag = facet(facetsOf(lib), 'tag')!;
    expect(tag.values.map((v) => [v.value, v.label, v.count, v.children?.length ?? 0])).toEqual([
      ['algo', 'Algo', 2, 0],
      ['core', 'Core', 2, 1],
    ]);
    expect(tag.values.find((v) => v.value === 'core')!.children!.map((v) => [v.value, v.label])).toEqual([['core::topic_alpha', 'Topic Alpha']]);
    // Each tree value, as a query, finds exactly its count.
    const ctx = ctxOf(lib);
    for (const v of [...tag.values, ...tag.values.find((t) => t.value === 'core')!.children!]) {
      expect(lib.cards.filter(compileQuery(toggleFacetValue({}, 'tag', v.value), ctx))).toHaveLength(v.count);
    }
  });

  it('the tag group gets a search box above 30 tags', () => {
    const lib = basicDeck('d', 40);
    lib.notes = lib.notes.map((n, i) => ({ ...n, tags: [`t${i}`] }));
    expect(facet(facetsOf(lib), 'tag')!.searchable).toBe(true);
    lib.notes = lib.notes.map((n, i) => ({ ...n, tags: [`t${i % 30}`] }));
    expect(facet(facetsOf(lib), 'tag')!.searchable).toBe(false);
  });

  it('decks keep the deck order; Markers count flags', () => {
    const a = basicDeck('d-a', 3);
    const b = basicDeck('d-b', 5);
    a.decks[0] = { ...a.decks[0], name: 'Zebra', order: 0 };
    b.decks[0] = { ...b.decks[0], name: 'Apple', order: 1, active: false };
    const facets = facetsOf(merge(a, b));
    expect(labels(facet(facets, 'deck')!.values)).toEqual(['Zebra', 'Apple']);
    expect(facet(facets, 'flags')!.values.map((v) => [v.label, v.count])).toEqual([
      ['Favorite', 3],
      ['In a paused deck', 5],
    ]);
  });

  it('groups come in the FacetSheet order of spec §8.3', () => {
    // Status, Due, Markers (+ toggles), Deck, Section, fields (ordinal first,
    // then by label), Tags, Card type, Direction.
    const lib = merge(GERMAN, SPANISH, CODING, basicDeck('d-basic', 12));
    expect(keysOf(facetsOf(lib))).toEqual([
      ...BUILT_INS,
      'deck',
      'section',
      'field:level',
      'field:category',
      'field:tags',
      'field:type',
      'tag',
      'noteType',
      'direction',
    ]);
  });

  it('toggleFacetValue adds and removes values of every kind', () => {
    let q: Query = {};
    q = toggleFacetValue(q, 'field:level', 'b1');
    q = toggleFacetValue(q, 'section', sectionValue('d1', 'verbs'));
    q = toggleFacetValue(q, 'flags', 'fav');
    q = toggleFacetValue(q, 'due', 'now');
    q = toggleFacetValue(q, 'hard', 'hard');
    q = toggleFacetValue(q, 'direction', '1');
    expect(q).toEqual({
      fields: { level: ['b1'] },
      sections: [{ deckId: 'd1', path: 'verbs' }],
      flags: ['fav'],
      due: 'now',
      hard: true,
      directions: [1],
    });
    q = toggleFacetValue(q, 'field:level', 'b1');
    q = toggleFacetValue(q, 'section', sectionValue('d1', 'verbs'));
    q = toggleFacetValue(q, 'flags', 'fav');
    q = toggleFacetValue(q, 'due', 'now');
    q = toggleFacetValue(q, 'hard', 'hard');
    q = toggleFacetValue(q, 'direction', '1');
    expect(q).toEqual({});
    expect(parseSectionValue(sectionValue('d1', 'a::b'))).toEqual({ deckId: 'd1', path: 'a::b' });
  });
});

/* ------------------------------- equivalence collapse keeps every choice */

/** A card type with a free 'Front' field and these facet fields (forced on), one direction. */
function facetType(id: string, facetFields: string[]): NoteType {
  return {
    id,
    name: id,
    kind: 'standard',
    fields: [
      { name: 'Front', role: 'term', facet: 'off' },
      ...facetFields.map((name) => ({ name, role: 'badge' as const, facet: 'on' as const })),
    ],
    templates: [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1] }],
    sortField: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * One deck 'd' made of rows. Each row gives `perRow` notes of one card type,
 * in one section, with these values after the Front field. One card (ord 0)
 * per note.
 */
function layoutDeck(types: NoteType[], rows: { section: string; typeId: string; values: string[] }[], perRow = 5): Library {
  const notes: Note[] = [];
  const cards: Card[] = [];
  rows.forEach((row, r) => {
    for (let k = 0; k < perRow; k++) {
      const note = makeNote({ id: `n${r}-${k}`, typeId: row.typeId, fields: [`front ${r} ${k}`, ...row.values], section: row.section }, NOW);
      notes.push(note);
      cards.push(makeCard(note, 0, 'd', DEFAULT_SRS, NOW, { id: `c${r}-${k}` }));
    }
  });
  return { types, notes, cards, decks: [makeDeck({ id: 'd', name: 'Patterns' }, NOW)] };
}

/** The Algo layout: Category = the first section level, a finer level below it. */
const SUBSECTIONS = [
  { section: 'Core::Topic Alpha', category: 'Core' },
  { section: 'Core::BFS', category: 'Core' },
  { section: 'DP::Packing', category: 'DP' },
  { section: 'DP::LIS', category: 'DP' },
];

describe('equivalence collapse never hides a choice', () => {
  it('a field that equals only the FIRST section level keeps the finer section tree', () => {
    const lib = layoutDeck(
      [facetType('t', ['Category'])],
      SUBSECTIONS.map((s) => ({ section: s.section, typeId: 't', values: [s.category] })),
    );
    const facets = facetsOf(lib);
    expect(keysOf(facets)).toEqual([...BUILT_INS, 'section', 'field:category']);
    const core = facet(facets, 'section')!.values.find((v) => v.label === 'Core')!;
    expect(labels(core.children)).toEqual(['BFS', 'Topic Alpha']);
  });

  it('one card type per subsection: the type hides behind the SHOWN section tree', () => {
    const types = ['tA', 'tB', 'tC', 'tD'].map((id) => facetType(id, ['Category']));
    const lib = layoutDeck(
      types,
      SUBSECTIONS.map((s, i) => ({ section: s.section, typeId: types[i].id, values: [s.category] })),
    );
    const facets = facetsOf(lib);
    // Card type == section level 2, and the tree is shown: "Topic Alpha" can be picked there.
    expect(keysOf(facets)).toEqual([...BUILT_INS, 'section', 'field:category']);
    const core = facet(facets, 'section')!.values.find((v) => v.label === 'Core')!;
    expect(core.children!.map((v) => v.value)).toContain(sectionValue('d', 'core::topic alpha'));
  });

  it('a section hidden behind a field cannot stand in for the card type', () => {
    // Category = the subsection (equals the full paths → the section is hidden);
    // the card type = the first level. It splits like no SHOWN group, so it stays.
    const types = ['tCore', 'tDP'].map((id) => facetType(id, ['Category']));
    const lib = layoutDeck(
      types,
      SUBSECTIONS.map((s) => ({
        section: s.section,
        typeId: s.category === 'Core' ? 'tCore' : 'tDP',
        values: [s.section.split('::')[1]],
      })),
    );
    expect(keysOf(facetsOf(lib))).toEqual([...BUILT_INS, 'field:category', 'noteType']);
  });

  it('cards with no field value are not a choice: Level "" ↔ section "Misc" keeps the section', () => {
    const types = [facetType('t', ['Level'])];
    const misc = layoutDeck(types, [
      { section: 'A1', typeId: 't', values: ['A1'] },
      { section: 'A2', typeId: 't', values: ['A2'] },
      { section: 'Misc', typeId: 't', values: [''] },
    ]);
    expect(keysOf(facetsOf(misc))).toEqual([...BUILT_INS, 'section', 'field:level']);
    expect(labels(facet(facetsOf(misc), 'section')!.values)).toContain('Misc');
    // The same notes at the deck root (no section): nothing is lost, the section collapses.
    const root = layoutDeck(types, [
      { section: 'A1', typeId: 't', values: ['A1'] },
      { section: 'A2', typeId: 't', values: ['A2'] },
      { section: '', typeId: 't', values: [''] },
    ]);
    expect(keysOf(facetsOf(root))).toEqual([...BUILT_INS, 'field:level']);
  });

  it('the deck root is no tree node: a card type that splits "root vs Words" stays', () => {
    const basic = builtinType('basic', NOW);
    const reverse = builtinType('basicReverse', NOW);
    // Two sections ('Words', 'Words › More'), so the tree is shown (§4.3 "≥ 2
    // sections"); at tree level 1 the card type splits exactly "root vs Words".
    const lib = layoutDeck(
      [basic, reverse],
      [
        { section: '', typeId: basic.id, values: ['back', '', ''] },
        { section: 'Words', typeId: reverse.id, values: ['back', '', ''] },
        { section: 'Words::More', typeId: reverse.id, values: ['back', '', ''] },
      ],
    );
    expect(keysOf(facetsOf(lib))).toEqual([...BUILT_INS, 'section', 'noteType']);
  });

  it('one section + cards at the deck root is ONE section: no Section group (spec §4.3 "≥ 2 sections")', () => {
    const types = [facetType('t', [])];
    const lib = layoutDeck(types, [
      { section: 'Verbs', typeId: 't', values: [] },
      { section: '', typeId: 't', values: [] },
    ], 2);
    expect(keysOf(facetsOf(lib))).toEqual(BUILT_INS);
    // Two real sections (a parent and its child count as two) → the group.
    const two = layoutDeck(types, [
      { section: 'Verbs', typeId: 't', values: [] },
      { section: 'Verbs::B1', typeId: 't', values: [] },
      { section: '', typeId: 't', values: [] },
    ], 2);
    expect(keysOf(facetsOf(two))).toEqual([...BUILT_INS, 'section']);
    // A selected section keeps the group, so its chip can be removed.
    const selected = facetsOf(lib, {}, { sections: [{ deckId: 'd', path: 'verbs' }] });
    expect(facet(selected, 'section')!.values.map((v) => [v.label, v.count, v.selected])).toEqual([['Verbs', 2, true]]);
  });

  it('notes right at a parent section are no tree node: "Verbs" vs "Verbs › B1"', () => {
    const basic = builtinType('basic', NOW);
    const reverse = builtinType('basicReverse', NOW);
    const lib = layoutDeck(
      [basic, reverse],
      [
        { section: 'Verbs', typeId: basic.id, values: ['back', '', ''] },
        { section: 'Verbs::B1', typeId: reverse.id, values: ['back', '', ''] },
      ],
    );
    // Picking the node "Verbs" also picks "Verbs › B1", so the tree cannot pick
    // the Basic cards alone: the card type stays.
    expect(keysOf(facetsOf(lib))).toEqual([...BUILT_INS, 'section', 'noteType']);
  });
});

/* ------------------------------------- field names that are user data */

/**
 * Field names come from imported decks. 'constructor' and '__proto__' are
 * names that a normal object already "has" (inherited from Object.prototype):
 * `{}['constructor']` is the Object function, not undefined. Code that reads
 * `obj[name] ?? []` then crashes ("merged.includes is not a function").
 * 'toString' and 'hasOwnProperty' fold to lower case, but are tested too.
 */
const PROTO_FIELDS = ['Constructor', '__proto__', 'toString', 'hasOwnProperty'];
const PROTO_KEYS = ['constructor', '__proto__', 'tostring', 'hasownproperty'];

/** 9 notes of one card type: a Level field and the four fields above, all facets. */
function protoLibrary(): Library {
  const type = facetType('t-proto', ['Level', ...PROTO_FIELDS]);
  return layoutDeck(
    [type],
    [
      { section: '', typeId: type.id, values: ['A1', 'default', 'yes', 'a', 'x'] },
      { section: '', typeId: type.id, values: ['B1', 'copy', 'no', 'b', 'y'] },
      { section: '', typeId: type.id, values: ['B1', 'move', 'yes', 'b', 'x'] },
    ],
    3,
  );
}

/** Object.prototype is still exactly as JavaScript made it. */
function expectNoPollution(): void {
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(({} as { constructor: unknown }).constructor).toBe(Object);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
}

describe('field names that are also Object members (constructor, __proto__, toString, hasOwnProperty)', () => {
  const lib = protoLibrary();
  const ctx = ctxOf(lib);

  it('they are filter groups like any other field', () => {
    const facets = facetsOf(lib, {}, {}, ctx);
    // Sorted by label; wave 5c: the labels are the readable names ("Has Own Property", "Proto", "To String").
    expect(keysOf(facets)).toEqual([...BUILT_INS, 'field:level', ...['constructor', 'hasownproperty', '__proto__', 'tostring'].map((k) => `field:${k}`)]);
    expect(facet(facets, 'field:constructor')!.label).toBe('Constructor');
    expect(facet(facets, 'field:__proto__')!.label).toBe('Proto');
    expect(facet(facets, 'field:constructor')!.values.map((v) => [v.value, v.count])).toEqual([
      ['copy', 3],
      ['default', 3],
      ['move', 3],
    ]);
    expect(facet(facets, 'field:__proto__')!.values.map((v) => [v.value, v.count])).toEqual([
      ['yes', 6],
      ['no', 3],
    ]);
  });

  it('a value can be switched on and off (it used to throw "merged.includes is not a function")', () => {
    let q: Query = { fields: { level: ['b1'] } };
    for (const key of PROTO_KEYS) q = toggleFacetValue(q, `field:${key}`, 'v');
    expect(Object.keys(q.fields!).sort()).toEqual(['__proto__', 'constructor', 'hasownproperty', 'level', 'tostring']);
    expect(q.fields).toEqual(
      fieldsOf([['level', ['b1']], ['constructor', ['v']], ['__proto__', ['v']], ['tostring', ['v']], ['hasownproperty', ['v']]]),
    );
    for (const key of PROTO_KEYS) q = toggleFacetValue(q, `field:${key}`, 'v');
    expect(q).toEqual({ fields: { level: ['b1'] } });
    // Alone, too (the first tap in the group).
    expect(toggleFacetValue({}, 'field:constructor', 'copy')).toEqual({ fields: { constructor: ['copy'] } });
    expectNoPollution();
  });

  it('counts with a selected field equal a brute-force count (it used to throw "function is not iterable")', () => {
    const selections: Query[] = [
      { fields: { level: ['b1'] } },
      { fields: { constructor: ['copy', 'move'] } },
      { fields: fieldsOf([['__proto__', ['yes']], ['level', ['b1']]]) },
      { fields: { tostring: ['b'], hasownproperty: ['x'] } },
    ];
    for (const selection of selections) {
      const facets = deriveFacets(lib.cards, {}, selection, ctx);
      for (const key of ['level', ...PROTO_KEYS]) {
        const f = facet(facets, `field:${key}`)!;
        for (const v of f.values) {
          const expected = lib.cards.filter(compileQuery(withValue(selection, f.key, v.value), ctx)).length;
          expect([JSON.stringify(selection), key, v.value, v.count]).toEqual([JSON.stringify(selection), key, v.value, expected]);
          expect(v.selected).toBe(isSelected(normalizeQuery(selection), f.key, v.value));
        }
      }
    }
    expectNoPollution();
  });
});

/** A `Query.fields` value from pairs (an object literal cannot hold an own '__proto__' key). */
function fieldsOf(pairs: [string, string[]][]): Record<string, string[]> {
  return Object.fromEntries(pairs);
}

/* ------------------------------------------------------------- labels */

describe('labels', () => {
  // Walkthrough M8 changed the name: "Tags (field)" said nothing; the card
  // type that has the field does ("Tags (German Verbs)").
  it('a field group never has the label of another group: "Tags (German Verbs)" next to the note tags', () => {
    const facets = facetsOf(merge(GERMAN, CODING));
    expect(facet(facets, 'field:tags')!.label).toBe('Tags (German Verbs)');
    expect(facet(facets, 'tag')!.label).toBe('Tags');
    // No two groups share a label.
    const groupLabels = facets.filter((f) => f.info === undefined).map((f) => f.label);
    expect(new Set(groupLabels).size).toBe(groupLabels.length);
    // The same label in every scope (German alone has no note-tag group).
    expect(facet(facetsOf(GERMAN), 'field:tags')!.label).toBe('Tags (German Verbs)');
  });

  it('fieldGroupLabel adds " (field)" only to the labels of other groups and chips', () => {
    expect(fieldGroupLabel('Level')).toBe('Level');
    expect(fieldGroupLabel('Type')).toBe('Type');
    expect(fieldGroupLabel('Tags')).toBe('Tags (field)');
    expect(fieldGroupLabel('tag')).toBe('tag (field)');
    expect(fieldGroupLabel('Deck')).toBe('Deck (field)');
    expect(fieldGroupLabel('Card  type')).toBe('Card  type (field)');
    expect(fieldGroupLabel('Status')).toBe('Status (field)');
    expect(fieldGroupLabel('Text')).toBe('Text (field)');
  });
});

/** A deck of Basic + reverse notes (one card per direction) with these deck languages. */
function reverseDeck(deckId: string, langs: Pick<Deck, 'language' | 'meaningLanguage'>, count = 3): Library {
  const type = builtinType('basicReverse', NOW);
  const notes = Array.from({ length: count }, (_, i) =>
    makeNote({ id: `${deckId}-n${i}`, typeId: type.id, fields: [`front ${i}`, `back ${i}`, '', ''] }, NOW),
  );
  const cards = notes.flatMap((n) => [0, 1].map((ord) => makeCard(n, ord, deckId, DEFAULT_SRS, NOW, { id: `${n.id}-${ord}` })));
  return { types: [type], notes, cards, decks: [makeDeck({ id: deckId, name: deckId, ...langs }, NOW)] };
}

const directionsOf = (facets: Facet[]) => facet(facets, 'direction')?.values.map((v) => [v.value, v.label]);
const GERMAN_ENGLISH = { language: 'de-DE', meaningLanguage: 'en-US' };
const TEMPLATE_NAMES = [
  ['0', 'Front → Back'],
  ['1', 'Back → Front'],
];

describe('direction labels use the deck languages for card types made in the app (spec §3.4, §4.3)', () => {
  it('a Basic + reverse deck with German / English: "German → English" and "English → German"', () => {
    expect(directionsOf(facetsOf(reverseDeck('d-de', GERMAN_ENGLISH)))).toEqual([
      ['0', 'German → English'],
      ['1', 'English → German'],
    ]);
  });

  it('without deck languages: the template names', () => {
    expect(directionsOf(facetsOf(reverseDeck('d-x', {})))).toEqual(TEMPLATE_NAMES);
    // Only one language known: no language pair.
    expect(directionsOf(facetsOf(reverseDeck('d-x', { language: 'de-DE' })))).toEqual(TEMPLATE_NAMES);
  });

  it('decks that disagree give the template names; a scope of one deck gives its languages', () => {
    const lib = merge(reverseDeck('d-de', GERMAN_ENGLISH), reverseDeck('d-es', { language: 'es-ES', meaningLanguage: 'en-US' }));
    expect(directionsOf(facetsOf(lib))).toEqual(TEMPLATE_NAMES);
    expect(directionsOf(facetsOf(lib, { decks: ['d-es'] }))).toEqual([
      ['0', 'Spanish → English'],
      ['1', 'English → Spanish'],
    ]);
    // The labels come from the SCOPE, not from the selection: they do not change while the user picks.
    expect(directionsOf(facetsOf(lib, {}, { decks: ['d-es'] }))).toEqual(TEMPLATE_NAMES);
  });

  it("a field's own lang wins over the deck; an Anki card type never takes the deck languages", () => {
    const lib = reverseDeck('d-de', GERMAN_ENGLISH);
    const backInFrench: Library = {
      ...lib,
      types: lib.types.map((t) => ({ ...t, fields: t.fields.map((f, i) => (i === 1 ? { ...f, lang: 'fr-FR' } : f)) })),
    };
    expect(directionsOf(facetsOf(backInFrench))).toEqual([
      ['0', 'German → French'],
      ['1', 'French → German'],
    ]);
    const fromAnki: Library = { ...lib, types: lib.types.map((t) => ({ ...t, source: { ankiMid: '1700000000' } })) };
    expect(directionsOf(facetsOf(fromAnki))).toEqual(TEMPLATE_NAMES);
  });

  it('a selected direction with no card in scope is named from the card types of the scope', () => {
    const lib = reverseDeck('d-x', {});
    lib.cards = lib.cards.filter((c) => c.ord === 0);
    const direction = facet(facetsOf(lib, {}, { directions: [1] }), 'direction')!;
    // (It used to say "Direction 2", unlike its chip.)
    expect(direction.values.map((v) => [v.value, v.label, v.count])).toEqual([
      ['0', 'Front → Back', 3],
      ['1', 'Back → Front', 0],
    ]);
  });
});

/* ------------------------------------ walkthrough M8: clear group names */

/**
 * A German library like the real starter decks: three card types whose
 * templates have DIFFERENT names for the same direction ("DE-EN" /
 * "Forward" / "Grammar Card" for ord 0, "EN-DE" / "Reverse" for ord 1), and
 * a Verbs field "Tags" (verb kinds, split on ','). `verbTagsLabel` is the
 * label a pack preset gives that field ("Verb type"), or none.
 */
function germanPack(verbTagsLabel?: string): Library {
  const vocab: NoteType = {
    id: 'nt-vocab',
    name: 'German Vocabulary (bidirectional)',
    kind: 'standard',
    fields: [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Translation', role: 'meaning', facet: 'off' },
    ],
    templates: [
      { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
      { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
    ],
    sortField: 0,
    source: { ankiMid: '1' },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const verbs: NoteType = {
    id: 'nt-verbs',
    name: 'German Verbs (bidirectional)',
    kind: 'standard',
    fields: [
      { name: 'Verb', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
      { name: 'Tags', role: 'badge', facet: 'on', multiSep: ',', ...(verbTagsLabel ? { label: verbTagsLabel } : {}) },
    ],
    templates: [
      { ord: 0, name: 'Forward', prompt: [0], answer: [1] },
      { ord: 1, name: 'Reverse', prompt: [1], answer: [0] },
    ],
    sortField: 0,
    source: { ankiMid: '2' },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const grammar: NoteType = {
    id: 'nt-grammar',
    name: 'German Grammar',
    kind: 'standard',
    fields: [
      { name: 'Question', role: 'term', facet: 'off' },
      { name: 'Answer', role: 'meaning', facet: 'off' },
    ],
    templates: [{ ord: 0, name: 'Grammar Card', prompt: [0], answer: [1] }],
    sortField: 0,
    source: { ankiMid: '3' },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const notes: Note[] = [];
  const cards: Card[] = [];
  const add = (type: NoteType, id: string, fields: string[], tags: string[] = []) => {
    const note = makeNote({ id, typeId: type.id, fields, tags }, NOW);
    notes.push(note);
    for (const t of type.templates) cards.push(makeCard(note, t.ord, 'd-de', DEFAULT_SRS, NOW, { id: `${id}-${t.ord}` }));
  };
  for (let i = 0; i < 4; i++) add(vocab, `w${i}`, [`Wort ${i}`, `word ${i}`]);
  for (let i = 0; i < 3; i++) add(verbs, `v${i}`, [`gehen ${i}`, `to go ${i}`, i === 0 ? 'irregular, sein' : 'regular']);
  for (let i = 0; i < 2; i++) add(grammar, `g${i}`, [`Frage ${i}`, `answer ${i}`], ['grammar']);
  return { types: [vocab, verbs, grammar], notes, cards, decks: [makeDeck({ id: 'd-de', name: 'German' }, NOW)] };
}

describe('walkthrough M8 — the Direction group and field group names', () => {
  it('card types with different template names: every direction is named by its role', () => {
    const lib = germanPack();
    // Before: "DE-EN / Forward / Grammar Card (9)" next to "EN-DE / Reverse (7)".
    expect(facet(facetsOf(lib), 'direction')!.values.map((v) => [v.value, v.label, v.count])).toEqual([
      ['0', 'Front → Back', 9],
      ['1', 'Back → Front', 7],
    ]);
    // directionLabels decides for the whole group, from where each ord's cards come from.
    const sources = new Map([
      [0, new Map([['nt-vocab', new Set(['d-de'])], ['nt-verbs', new Set(['d-de'])], ['nt-grammar', new Set(['d-de'])]])],
      [1, new Map([['nt-vocab', new Set(['d-de'])], ['nt-verbs', new Set(['d-de'])]])],
    ]);
    const typeById = new Map(lib.types.map((t) => [t.id, t]));
    expect([...directionLabels(sources, typeById)]).toEqual([
      [0, DIRECTION_ROLE_LABELS.front],
      [1, DIRECTION_ROLE_LABELS.back],
    ]);
  });

  it('review round 2: directionGroupNames says whether the group chose the role labels (the Library rows follow it)', () => {
    const lib = germanPack();
    const typeById = new Map(lib.types.map((t) => [t.id, t]));
    const mixed = new Map([
      [0, new Map([['nt-vocab', new Set(['d-de'])], ['nt-verbs', new Set(['d-de'])]])],
      [1, new Map([['nt-vocab', new Set(['d-de'])], ['nt-verbs', new Set(['d-de'])]])],
    ]);
    const names = directionGroupNames(mixed, typeById);
    expect(names.byRole).toBe(true);
    expect(names.labels).toEqual(directionLabels(mixed, typeById));
    // One card type: its own template names, not by role.
    const vocab = new Map([
      [0, new Map([['nt-vocab', new Set(['d-de'])]])],
      [1, new Map([['nt-vocab', new Set(['d-de'])]])],
    ]);
    expect(directionGroupNames(vocab, typeById)).toEqual({ labels: new Map([[0, 'DE-EN'], [1, 'EN-DE']]), byRole: false });
    // directionInfo tells a template name from languages.
    expect(directionInfo(1, ['nt-verbs'], typeById)).toEqual({ label: 'Reverse', kind: 'name' });
    expect(directionInfo(0, ['nt-vocab', 'nt-verbs'], typeById).kind).toBe('names');
  });

  it('one card type keeps its own template names; the languages win when every card type agrees', () => {
    const lib = germanPack();
    const vocabOnly = { ...lib, cards: lib.cards.filter((c) => c.id.startsWith('w')) };
    expect(directionsOf(facetsOf(vocabOnly))).toEqual([
      ['0', 'DE-EN'],
      ['1', 'EN-DE'],
    ]);
    const withLangs: Library = {
      ...lib,
      types: lib.types.map((t) => ({
        ...t,
        fields: t.fields.map((f) => (f.role === 'term' ? { ...f, lang: 'de-DE' } : f.role === 'meaning' ? { ...f, lang: 'en-US' } : f)),
      })),
    };
    expect(directionsOf(facetsOf(withLangs))).toEqual([
      ['0', 'German → English'],
      ['1', 'English → German'],
    ]);
  });

  it('when the roles cannot tell the directions apart, the template names stay (nothing is hidden)', () => {
    // The fixtures ask the same field on both sides: both would be "Front → Back".
    expect(directionsOf(facetsOf(GERMAN))).toEqual([
      ['0', 'DE-EN / Grammar Card'],
      ['1', 'EN-DE'],
    ]);
  });

  it('the Direction group is hidden when it adds nothing: the directions split the cards like the card types', () => {
    // Type A has only a first direction, type B only a second one (its first was deleted).
    const a = facetType('A', []);
    const b: NoteType = { ...facetType('B', []), templates: [{ ord: 1, name: 'Back only', prompt: [0], answer: [] }] };
    const notes = [0, 1, 2, 3].map((i) => makeNote({ id: `n${i}`, typeId: i < 2 ? 'A' : 'B', fields: [`front ${i}`] }, NOW));
    const cards = notes.map((n, i) => makeCard(n, i < 2 ? 0 : 1, 'd', DEFAULT_SRS, NOW, { id: `c${i}` }));
    const lib: Library = { types: [a, b], notes, cards, decks: [makeDeck({ id: 'd', name: 'D' }, NOW)] };
    const keys = keysOf(facetsOf(lib));
    expect(keys).toContain('noteType');
    expect(keys).not.toContain('direction');
    // A picked direction always keeps its group, so its chip value can be removed.
    expect(keysOf(facetsOf(lib, {}, { directions: [1] }))).toContain('direction');
    // The same directions inside ONE card type do add something: the group shows.
    expect(keysOf(facetsOf(germanPack()))).toContain('direction');
  });

  it('a field group that clashes with another group is named by its card type: "Tags (German Verbs)"', () => {
    const facets = facetsOf(germanPack());
    expect(facet(facets, 'field:tags')!.label).toBe('Tags (German Verbs)');
    expect(facet(facets, 'tag')!.label).toBe('Tags');
  });

  it('a label a card type chose wins: the German pack preset "Verb type"', () => {
    expect(facet(facetsOf(germanPack('Verb type')), 'field:tags')!.label).toBe('Verb type');
    // Also when another card type has a "Tags" field with no label of its own (and comes first).
    const lib = germanPack('Verb type');
    const other: NoteType = { ...facetType('nt-first', ['Tags']), name: 'Other' };
    const n = makeNote({ id: 'o1', typeId: other.id, fields: ['x', 'regular'] }, NOW);
    const merged: Library = {
      types: [other, ...lib.types],
      notes: [n, ...lib.notes],
      cards: [makeCard(n, 0, 'd-de', DEFAULT_SRS, NOW, { id: 'o1-0' }), ...lib.cards],
      decks: lib.decks,
    };
    expect(facet(facetsOf(merged), 'field:tags')!.label).toBe('Verb type');
  });

  it('fieldGroupLabel with its card types: names them (at most two), drops a "(…)" note, else " (field)"', () => {
    const typeById = new Map<string, NoteType>([
      ['a', { ...facetType('a', ['Tags']), name: 'German Verbs (bidirectional)' }],
      ['b', { ...facetType('b', ['Tags']), name: 'Spanish Verbs' }],
      ['c', { ...facetType('c', ['Tags']), name: 'French Verbs' }],
    ]);
    const owner = (ids: string[]) => ({ spec: { fieldIndexByType: new Map(ids.map((id) => [id, 1])) }, typeById });
    expect(fieldGroupLabel('Tags', owner(['a']))).toBe('Tags (German Verbs)');
    expect(fieldGroupLabel('Tags', owner(['a', 'b']))).toBe('Tags (German Verbs, Spanish Verbs)');
    expect(fieldGroupLabel('Tags', owner(['a', 'b', 'c']))).toBe('Tags (field)');
    expect(fieldGroupLabel('Level', owner(['a']))).toBe('Level');
    // Without its card types: the old rule.
    expect(fieldGroupLabel('Tags')).toBe('Tags (field)');
  });

  it('isFacetValueSelected answers the opposite question of toggleFacetValue, for every kind', () => {
    const cases: [FacetKey, string][] = [
      ['deck', 'd1'],
      ['section', sectionValue('d1', 'verbs::b1')],
      ['noteType', 'nt-1'],
      ['direction', '1'],
      ['tag', 'algo'],
      ['life', 'notStarted'],
      ['due', 'today'],
      ['flags', 'flagged'],
      ['hard', 'hard'],
      ['young', 'young'],
      ['leech', 'leech'],
      ['field:level', 'b1'],
      ['field:constructor', 'x'],
    ];
    for (const [key, value] of cases) {
      expect(isFacetValueSelected({}, key, value)).toBe(false);
      const on = toggleFacetValue({}, key, value);
      expect(isFacetValueSelected(on, key, value)).toBe(true);
      expect(isFacetValueSelected(toggleFacetValue(on, key, value), key, value)).toBe(false);
    }
    // Another value of the same group is not selected.
    expect(isFacetValueSelected({ fields: { level: ['b1'] } }, 'field:level', 'b2')).toBe(false);
    expect(isFacetValueSelected({ due: 'now' }, 'due', 'today')).toBe(false);
  });
});

/* ------------------------------------- 3. brute-force property test */

const SECTIONS = ['', 'Alpha', 'Alpha::One', 'Alpha::Two', 'Beta', 'Beta::One::Deep'];
const TAG_POOL = ['t1', 'T1::a', 't1::b', 't2', 'leech', 'Algo::Core_Patterns'];
const LEVELS = ['A1', 'A2', 'B1', 'B2'];
const KINDS = ['noun', 'verb', 'noun, verb', 'adjective', 'verb, irregular'];
const WORDS = ['haus', 'über', 'straße', 'gehen', 'katze', 'hund'];

const RANDOM_TYPE: NoteType = {
  id: 'nt-rand',
  name: 'Random words',
  kind: 'standard',
  fields: [
    { name: 'Word', role: 'term', facet: 'off' },
    { name: 'Level', role: 'badge', facet: 'on' },
    { name: 'Kind', role: 'badge', facet: 'on', multiSep: ',' },
  ],
  templates: [
    { ord: 0, name: 'Forward', prompt: [0], answer: [1] },
    { ord: 1, name: 'Backward', prompt: [1], answer: [0] },
  ],
  sortField: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

/** A random card state that fits together (like real cards). */
function randomSrs(rnd: Random): Omit<MakeCardOpts, 'id'> {
  const due = rnd.pick([NOW - DAY, NOW - MIN, NOW + 2 * HOUR, NOW + 3 * DAY]);
  const kind = rnd.pick(['new', 'notStarted', 'learning', 'review', 'mastered', 'known'] as const);
  const base: Omit<MakeCardOpts, 'id'> = {
    fav: rnd.bool(0.2),
    flagged: rnd.bool(0.15),
    suspended: rnd.bool(0.1),
    buriedUntil: rnd.bool(0.1) ? NOW + HOUR : null,
    lapses: rnd.bool(0.15) ? 9 : rnd.int(0, 2),
  };
  switch (kind) {
    case 'new':
      return { ...base, lapses: 0 };
    case 'notStarted':
      return { ...base, lapses: 0, newState: 'notStarted' };
    case 'learning':
      return { ...base, reps: rnd.int(1, 3), stepIndex: 0, intervalDays: 0, due, ease: rnd.pick([2.0, 2.5]) };
    case 'review':
      return { ...base, reps: rnd.int(2, 8), stepIndex: null, intervalDays: rnd.int(1, 20), due, ease: rnd.pick([1.8, 2.2, 2.6]) };
    case 'mastered':
      return { ...base, reps: rnd.int(5, 20), stepIndex: null, intervalDays: rnd.int(21, 90), due, ease: rnd.pick([2.1, 2.7]) };
    case 'known':
      return { ...base, reps: rnd.int(0, 4), intervalDays: rnd.int(0, 10), knownAt: NOW - DAY, ease: rnd.pick([1.5, 2.5]) };
  }
}

function randomLibrary(rnd: Random): Library {
  const basicRev = builtinType('basicReverse', NOW);
  const types = [RANDOM_TYPE, basicRev];
  const deckCount = rnd.int(1, 3);
  const decks = Array.from({ length: deckCount }, (_, i) =>
    makeDeck({ id: `d${i}`, name: `Deck ${i}`, order: i, active: rnd.bool(0.75) }, NOW),
  );
  const notes: Note[] = [];
  const cards: Card[] = [];
  const noteCount = rnd.int(5, 40);
  for (let i = 0; i < noteCount; i++) {
    const type = rnd.bool(0.7) ? RANDOM_TYPE : basicRev;
    const word = `${rnd.pick(WORDS)} ${i}`;
    const fields =
      type === RANDOM_TYPE
        ? [word, rnd.bool(0.85) ? rnd.pick(LEVELS) : '', rnd.bool(0.8) ? rnd.pick(KINDS) : '']
        : [word, `meaning ${i}`, '', ''];
    const note = makeNote(
      {
        id: `n${i}`,
        typeId: type.id,
        fields,
        section: rnd.pick(SECTIONS),
        tags: rnd.sample(TAG_POOL, rnd.int(0, 2)),
      },
      NOW,
    );
    notes.push(note);
    const deckId = rnd.pick(decks).id;
    const ords = rnd.bool(0.6) ? [0, 1] : [rnd.int(0, 1)];
    for (const ord of ords) cards.push(makeCard(note, ord, deckId, DEFAULT_SRS, NOW, { id: `c${i}-${ord}`, ...randomSrs(rnd) }));
  }
  return { types, notes, cards, decks };
}

/** A random query of a few groups, drawn from the values the library really has (and some it has not). */
function randomQuery(rnd: Random, lib: Library, groups: number): Query {
  const q: Query = {};
  const kinds = rnd.sample(
    ['decks', 'sections', 'level', 'kind', 'noteTypes', 'directions', 'tags', 'notTags', 'life', 'due', 'flags', 'notFlags', 'hard', 'young', 'leech', 'text', 'list'],
    groups,
  );
  for (const kind of kinds) {
    switch (kind) {
      case 'decks':
        q.decks = rnd.sample(lib.decks, rnd.int(1, lib.decks.length)).map((d) => d.id);
        break;
      case 'sections':
        q.sections = [{ deckId: rnd.pick(lib.decks).id, path: rnd.pick(SECTIONS.filter(Boolean)) }];
        break;
      case 'level':
        q.fields = { ...q.fields, level: rnd.sample([...LEVELS, 'C2'], rnd.int(1, 2)) };
        break;
      case 'kind':
        q.fields = { ...q.fields, kind: rnd.sample(['noun', 'verb', 'irregular', 'adjective'], rnd.int(1, 2)) };
        break;
      case 'noteTypes':
        q.noteTypes = [rnd.pick(lib.types).id];
        break;
      case 'directions':
        q.directions = [rnd.int(0, 1)];
        break;
      case 'tags':
        q.tags = rnd.sample(['t1', 't1::a', 't2', 'algo', 'nope'], rnd.int(1, 2));
        break;
      case 'notTags':
        q.notTags = [rnd.pick(['leech', 't1'])];
        break;
      case 'life':
        q.life = rnd.sample([...LIFE_KEYS], rnd.int(1, 3));
        break;
      case 'due':
        q.due = rnd.pick(['now', 'today'] as const);
        break;
      case 'flags':
        q.flags = rnd.sample([...FLAG_KEYS], rnd.int(1, 2));
        break;
      case 'notFlags':
        q.notFlags = [rnd.pick([...FLAG_KEYS])];
        break;
      case 'hard':
      case 'young':
      case 'leech':
        q[kind] = true;
        break;
      case 'text':
        q.text = rnd.pick(['uber', 'haus', 'meaning', '"strasse 1"', 'alpha']);
        break;
      case 'list':
        q.list = rnd.pick(['builtin:favorites', 'builtin:recent', 'builtin:hard']);
        break;
    }
  }
  return q;
}

/** The query that value `v` of facet `key` stands for: the selection with v's group replaced by v. */
function withValue(selection: Query, key: FacetKey, v: string): Query {
  switch (key) {
    case 'deck':
      return { ...selection, decks: [v] };
    case 'section':
      return { ...selection, sections: [parseSectionValue(v)] };
    case 'noteType':
      return { ...selection, noteTypes: [v] };
    case 'direction':
      return { ...selection, directions: [Number(v)] };
    case 'tag':
      return { ...selection, tags: [v] };
    case 'life':
      return { ...selection, life: [v as Card['newState'] & string] as Query['life'] };
    case 'due':
      return { ...selection, due: v as 'now' | 'today' };
    case 'flags':
      // flags is an AND: every flag is its own group, so v is ADDED.
      return { ...selection, flags: [...(selection.flags ?? []), v as (typeof FLAG_KEYS)[number]] };
    case 'hard':
    case 'young':
    case 'leech':
      return { ...selection, [key]: true };
    default: {
      // Not `{ ...selection.fields, [field]: [v] }`: babel makes a spread an
      // Object.assign, which turns a '__proto__' key into the prototype.
      const fields = new Map(Object.entries(selection.fields ?? {}));
      fields.set(key.slice('field:'.length), [v]);
      return { ...selection, fields: fieldRecord(fields) };
    }
  }
}

/** Every value a facet COULD have in this library (so a missing value is caught). */
function candidates(key: FacetKey, lib: Library, ctx: MatchCtx): string[] {
  switch (key) {
    case 'deck':
      return lib.decks.map((d) => d.id);
    case 'section': {
      const out = new Set<string>();
      for (const c of lib.cards) {
        const note = ctx.index.noteById.get(c.noteId)!;
        for (const p of pathPrefixes(ctx.index.sectionPath(note))) out.add(sectionValue(c.deckId, p));
      }
      return [...out];
    }
    case 'noteType':
      return lib.types.map((t) => t.id);
    case 'direction':
      return ['0', '1'];
    case 'tag':
      return [...new Set(lib.notes.flatMap((n) => ctx.index.noteTags(n).flatMap(pathPrefixes)))];
    case 'life':
      return [...LIFE_KEYS];
    case 'due':
      return ['now', 'today'];
    case 'flags':
      return [...FLAG_KEYS];
    case 'hard':
    case 'young':
    case 'leech':
      return [key];
    default: {
      const field = key.slice('field:'.length);
      return [...new Set(lib.notes.flatMap((n) => ctx.index.facetValues(n).get(field) ?? []))];
    }
  }
}

/** Flatten a tree facet's values. */
function flatten(values: FacetValue[]): FacetValue[] {
  return values.flatMap((v) => [v, ...flatten(v.children ?? [])]);
}

/** Is value `v` of facet `key` one of the selection's chips? (Selection already normalized.) */
function isSelected(sel: Query, key: FacetKey, v: string): boolean {
  switch (key) {
    case 'deck':
      return sel.decks?.includes(v) ?? false;
    case 'section':
      return sel.sections?.some((s) => sectionValue(s.deckId, s.path) === v) ?? false;
    case 'noteType':
      return sel.noteTypes?.includes(v) ?? false;
    case 'direction':
      return sel.directions?.includes(Number(v)) ?? false;
    case 'tag':
      return sel.tags?.includes(v) ?? false;
    case 'life':
      return (sel.life as string[] | undefined)?.includes(v) ?? false;
    case 'due':
      return sel.due === v;
    case 'flags':
      return (sel.flags as string[] | undefined)?.includes(v) ?? false;
    case 'hard':
    case 'young':
    case 'leech':
      return sel[key] === true;
    default:
      return sel.fields?.[key.slice('field:'.length)]?.includes(v) ?? false;
  }
}

describe('disjunctive counts equal a brute-force count (100 seeded random libraries)', () => {
  it('every shown count, and no value with cards is missing', () => {
    let checkedValues = 0;
    let selectedSeen = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const rnd = createRandom(`facets-${seed}`);
      const lib = randomLibrary(rnd);
      const ctx = ctxOf(lib);
      const scope = rnd.bool(0.5) ? {} : randomQuery(rnd, lib, 1);
      const selection = randomQuery(rnd, lib, rnd.int(0, 4));
      const inScope = compileQuery(scope, ctx);
      const facets = deriveFacets(lib.cards, scope, selection, ctx);
      const brute = (key: FacetKey, v: string) => {
        const match = compileQuery(withValue(selection, key, v), ctx);
        let n = 0;
        for (const c of lib.cards) if (inScope(c) && match(c)) n += 1;
        return n;
      };

      for (const f of facets) {
        const where = `seed ${seed} · ${f.key} · scope ${JSON.stringify(scope)} · selection ${JSON.stringify(selection)}`;
        const shownValues = flatten(f.values);
        // 1. Every shown count is the brute-force count.
        for (const v of shownValues) {
          expect([where, v.value, v.count]).toEqual([where, v.value, brute(f.key, v.value)]);
          checkedValues += 1;
        }
        // 2. Nothing with cards is missing (info lines show their one value).
        const expected = candidates(f.key, lib, ctx).filter((v) => brute(f.key, v) > 0).sort();
        const got = shownValues.filter((v) => v.count > 0).map((v) => v.value).sort();
        expect([where, got]).toEqual([where, expected]);
        // 3. `selected` is exactly "this value is a chip", and every chip value is shown.
        const normalized = normalizeQuery(selection);
        for (const v of shownValues) {
          expect([where, v.value, v.selected]).toEqual([where, v.value, isSelected(normalized, f.key, v.value)]);
          if (v.selected) selectedSeen += 1;
        }
        for (const v of candidates(f.key, lib, ctx)) {
          if (isSelected(normalized, f.key, v)) expect([where, v, shownValues.some((x) => x.value === v)]).toEqual([where, v, true]);
        }
      }
    }
    expect(checkedValues).toBeGreaterThan(1000);
    expect(selectedSeen).toBeGreaterThan(50);
  });
});

describe('wave 5c — a field group shows the READABLE field name, and is still found by its key', () => {
  it('fieldGroupLabel: a name nobody labelled is made readable; a label a card type chose stays as it is', () => {
    expect(fieldGroupLabel('WordType')).toBe('Word Type');
    expect(fieldGroupLabel('CEFRLevel')).toBe('CEFR Level');
    expect(fieldGroupLabel('MarankiExample')).toBe('Example');
    expect(fieldGroupLabel('part_of_speech')).toBe('Part of speech');
    // Made readable FIRST, then checked against the other groups' labels.
    expect(fieldGroupLabel('MarankiTags')).toBe('Tags (field)');
    // Plain names keep their own spelling.
    expect(fieldGroupLabel('Level')).toBe('Level');
    expect(fieldGroupLabel('Card  type')).toBe('Card  type (field)');
    // With its card types: no label of its own → the readable name.
    const words: NoteType = { ...facetType('t-words', ['VerbForms']), name: 'Words' };
    const owner = (type: NoteType) => ({ spec: { fieldIndexByType: new Map([[type.id, 1]]) }, typeById: new Map([[type.id, type]]) });
    expect(fieldGroupLabel('VerbForms', owner(words))).toBe('Verb Forms');
    // A label the card type CHOSE is used as written, even when it looks like CamelCase.
    const chosen: NoteType = { ...words, fields: words.fields.map((f, i) => (i === 1 ? { ...f, label: 'macOS Forms' } : f)) };
    expect(fieldGroupLabel('VerbForms', owner(chosen))).toBe('macOS Forms');
  });

  it('review round 1: fieldShownName is the label without the card type note (the name a learner may type)', () => {
    expect(fieldShownName('WordType')).toBe('Word Type');
    expect(fieldShownName('MarankiExample')).toBe('Example');
    // fieldGroupLabel adds " (field)" to a clashing label; the name before it is the field's own.
    expect(fieldGroupLabel('MarankiTags')).toBe('Tags (field)');
    expect(fieldShownName('MarankiTags')).toBe('Tags');
    const verbs: NoteType = { ...facetType('t-verbs', ['Tags']), name: 'German Verbs (bidirectional)' };
    const owner = (type: NoteType) => ({ spec: { fieldIndexByType: new Map([[type.id, 1]]) }, typeById: new Map([[type.id, type]]) });
    expect(fieldGroupLabel('Tags', owner(verbs))).toBe('Tags (German Verbs)');
    expect(fieldShownName('Tags', owner(verbs))).toBe('Tags');
    // A label the card type chose is the shown name too.
    const chosen: NoteType = { ...verbs, fields: verbs.fields.map((f, i) => (i === 1 ? { ...f, label: 'Verb type' } : f)) };
    expect(fieldShownName('Tags', owner(chosen))).toBe('Verb type');
    expect(fieldGroupLabel('Tags', owner(chosen))).toBe('Verb type');
  });

  it('deriveFacets: the group of "WordType" is "Word Type"; its key and values are the folded name and values', () => {
    const lib = layoutDeck(
      [facetType('t', ['WordType'])],
      [
        { section: '', typeId: 't', values: ['noun'] },
        { section: '', typeId: 't', values: ['verb'] },
      ],
      2,
    );
    const ctx = ctxOf(lib);
    const group = facet(facetsOf(lib, {}, {}, ctx), 'field:wordtype')!;
    expect(group.label).toBe('Word Type');
    expect(group.values.map((v) => [v.value, v.count])).toEqual([
      ['noun', 2],
      ['verb', 2],
    ]);
    // A tap in the sheet writes the KEY, never the label.
    const picked = toggleFacetValue({}, 'field:wordtype', 'noun');
    expect(picked).toEqual({ fields: { wordtype: ['noun'] } });
    expect(isFacetValueSelected(picked, 'field:wordtype', 'noun')).toBe(true);
    expect(lib.cards.filter(compileQuery(picked, ctx))).toHaveLength(2);
    // After the pick, the group keeps its readable name and the value is selected.
    const after = facet(facetsOf(lib, {}, picked, ctx), 'field:wordtype')!;
    expect(after.label).toBe('Word Type');
    expect(after.values.find((v) => v.value === 'noun')!.selected).toBe(true);
  });
});

/* ---------------------- 4. unit P1: exactly the results of the engine before it */

/** Object keys in a fixed order, so the text depends only on the content (and arrays keep their order). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** A short signature of a facet list: every group, label, info line, value, count, rank and order. */
function signature(facets: readonly Facet[]): string {
  let hash = 0x811c9dc5;
  const text = JSON.stringify(canonical(facets));
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const RICH_SECTIONS = ['', 'Alpha', 'alpha::One', 'Alpha :: Two', 'Beta::One::Deep', 'Gamma'];
const RICH_TAGS = ['t1', 'T1::a', 'Two_Pointers', 'Two Pointers', 'Algo::Core_Patterns', 'x::', 'leech'];
/** A level that follows the section (so "Level == section" can collapse), when the library wants it. */
const LEVEL_OF_SECTION: Record<string, string> = {
  '': '',
  Alpha: 'A1',
  'alpha::One': 'A2',
  'Alpha :: Two': 'B1',
  'Beta::One::Deep': 'B2',
  Gamma: 'C1',
};

/**
 * A random library with every case the faster engine (per-note data, the
 * collapse over distinct parts, the written-out flags) must keep exactly:
 * notes with cards in TWO decks, cards whose note is gone, paused decks,
 * decks with the same name and order, three directions, tags with "_" and
 * with spaces, sections at many depths and at the deck root, single- and
 * multi-value fields, and — half of the time — a Level and a card type that
 * follow the section, so the equivalence collapse really hides groups.
 */
function richLibrary(rnd: Random): Library {
  const basicRev = builtinType('basicReverse', NOW);
  const three = threeWayType(NOW);
  const levels = facetType('t-levels', ['Level']);
  const types = [RANDOM_TYPE, basicRev, three, levels];
  const decks = Array.from({ length: rnd.int(1, 4) }, (_, i) =>
    makeDeck({ id: `d${i}`, name: rnd.pick(['A', 'B', 'A']), order: rnd.pick([0, 1, 1, 2]), active: rnd.bool(0.75) }, NOW),
  );
  const follow = rnd.bool(0.5);
  const notes: Note[] = [];
  const cards: Card[] = [];
  const noteCount = rnd.int(3, 45);
  for (let i = 0; i < noteCount; i++) {
    const section = rnd.pick(RICH_SECTIONS);
    const type = follow
      ? section.startsWith('Beta')
        ? three
        : section === ''
          ? basicRev
          : rnd.pick([RANDOM_TYPE, levels])
      : rnd.pick(types);
    const level = follow ? LEVEL_OF_SECTION[section] : rnd.bool(0.85) ? rnd.pick(LEVELS) : '';
    const word = `${rnd.pick(WORDS)} ${i}`;
    const fields =
      type === RANDOM_TYPE
        ? [word, level, rnd.bool(0.8) ? rnd.pick(KINDS) : '']
        : type === levels
          ? [word, level]
          : type.fields.map((_, f) => (f === 0 ? word : f === 1 ? `meaning ${i}` : ''));
    const note = makeNote({ id: `n${i}`, typeId: type.id, fields, section, tags: rnd.sample(RICH_TAGS, rnd.int(0, 3)) }, NOW);
    notes.push(note);
    const home = rnd.pick(decks).id;
    const ords = rnd.sample(
      type.templates.map((t) => t.ord),
      rnd.int(1, type.templates.length),
    );
    for (const ord of ords) {
      const deckId = rnd.bool(0.2) ? rnd.pick(decks).id : home;
      cards.push(makeCard(note, ord, deckId, DEFAULT_SRS, NOW, { id: `c${i}-${ord}`, ...randomSrs(rnd) }));
    }
  }
  // Sometimes a card whose note is gone (damaged data).
  if (rnd.bool(0.3)) {
    cards.push(makeCard({ id: 'gone', order: 0 }, rnd.int(0, 1), rnd.pick(decks).id, DEFAULT_SRS, NOW, { id: 'c-gone', ...randomSrs(rnd) }));
  }
  return { types, notes, cards, decks };
}

/** The deck fixtures with a Basic deck, in one library. */
const ALL_DECKS = merge(GERMAN, SPANISH, CODING, basicDeck('d-basic', 5));

/** [library, scope, selection] of the deck fixtures, with chips of every kind. */
const FIXTURE_CASES: [Library, Query, Query][] = [
  [GERMAN, {}, {}],
  [GERMAN, {}, { fields: { level: ['b1'] } }],
  [GERMAN, {}, { fields: { level: ['a1', 'b2'] }, directions: [1] }],
  [GERMAN, {}, { text: 'der' }],
  [SPANISH, {}, {}],
  [SPANISH, {}, { life: ['new'] }],
  [CODING, {}, {}],
  [CODING, {}, { tags: ['algo'] }],
  [ALL_DECKS, {}, {}],
  [ALL_DECKS, {}, { decks: ['d-german', 'd-coding'] }],
  [ALL_DECKS, { decks: ['d-german'] }, { flags: ['fav'] }],
  [ALL_DECKS, {}, { noteTypes: [GERMAN.types[0].id], hard: true }],
];

/**
 * Recorded with the engine BEFORE unit P1, on these made-up fixtures: that
 * engine was run on them, and it gave exactly these values. If a later change
 * of the facet rules changes a value on purpose, record the new values with
 * that change and say why.
 */
const GOLDEN_FIXTURES: readonly string[] = [
  '3951ed61', 'd514ee63', 'ed7f3b55', '711e5ef8', '431307a8', '4c802fc9', 'fd1c72f2', 'f57c8f85',
  '3fd624aa', '3c334a9b', 'df133a1a', '46d4acae',
];
const GOLDEN_RICH: readonly string[] = [
  '58ae74b6', '75a500e9', '55888720', 'bee8f03d', '55df0ecc', '24bf794b', 'd9f66fb8', '97ca324f',
  '15f339da', '11c2dfaf', '70db88cb', '961a012d', '693ebfee', '9a0edb2e', 'dce2fe51', '5316d941',
  'ea764e19', 'bf4835ef', '2a0a89dc', '75a257e1', '6ae1ae2c', '099c8ee5', '8d750f3d', 'd62d1893',
  '1fe5cc4e', 'c7b8e254', '2ef09180', '6f0bb228', '8935b10f', 'b5b60f17', '9a0edb2e', 'a89d1fe0',
  '122a466f', '86af3b6b', 'e0f767c8', '4ca97ed4', 'a98cff3c', 'd42d6516', 'ada909cd', 'f3da8fb3',
  'e5d1ac39', '07052900', '5796847b', '7b1ad1f9', '5b319127', '534042e3', 'fffb7b5d', '00bb09a4',
  '22f5a01f', '36e114a8', '7105d995', '1c01b567', 'd73d9c5b', '5e6487d0', 'd3b3c0cd', 'a09ed6cb',
  '50c8ea89', 'c6f007f6', '1c0faed2', 'a97171a6', '537be32a', 'ba1b3fa2', '30976a38', '7e1d436a',
  'beec09d6', '30bea0a7', '260c7c63', '88058c8d', '3f1a9132', '09d06a9f', '8796d6e7', '9b129ddf',
  'e8f8ec5c', '2fe8d216', '86f34d2d', '4a950cc8', '0c816ab6', '248aac7d', 'd27f104c', '0250810b',
  '9a0edb2e', 'bc9b83ab', 'c451ad5f', '49d05263', '2959322e', '3749df50', '49f27bec', '84e786c1',
  'e7862eb4', 'deb2f8bc', 'd7148b69', '9fc58bea', 'c377101f', '150be36b', '000c5a11', '4337920e',
  '478df6a3', 'a34197dc', '4b54399d', '5bc7fcb9', '6aa0a138', 'f3e6d9e5', '63f08f4b', '21b08a3f',
  'ac19af66', '606c5b6d', 'b33f8815', 'f4906b1c', '4c57c8dc', 'bdaa1bc5', '129d593a', '91ae93c5',
  'acdf988e', 'bddfbf6b', 'dd04a132', 'dd04a892', '38ef6ade', '6f158972', 'c2a4362c', '5202ec39',
  '62e8628e', 'c2e7b337', 'd6d8ffd0', '2a7036c2', 'd9068048', 'ce2fa990', '305b9a11', 'c2e094e3',
  'ab5ce778', '26286fe0', '297c2272', 'dcbf7f92', '42e41975', 'bcaf85a1', 'c6eb5bd6', '40fd153a',
  '07d54e9c', '96403041', 'b8e9f232', '212a9938', 'a3d5c32e', '76713849', '7d2aaa44', 'd03913f7',
  '883698e8', '81dc0747', '08eff8ea', '11067dc6', 'b928d48a', 'e16a4613', 'c4d22f8c', '3a7fbe9c',
  '3684c46e', '62b5891b', 'd4c4571b', '1d160bb2', '8015a209', 'd729358f', '29f6e359', '6a978c21',
  '9058cbbc', 'cbc03e0b', 'a2818a47', '0073290a', '1dcc33e4', '3d5a22bb', '1530f0a7', 'b0f48340',
  'a243f02d', '0a81635a', 'bc3e80e1', '655b8346', '9a8146d4', 'c65ba475', 'db610861', '48586af1',
  '75fa25da', '97479e91', 'b82d4d6b', '1e418d17', 'd423b951', 'e1731f7d', '760f9e6a', 'd603ff7d',
  '18c7ec01', 'ad2cfa1c', '2cdc297c', '050b4dcd', '0c9c654f', 'be824214', 'a9c8db5d', 'd436fef3',
  'a7a45878', '784bb398', 'df964a12', 'fdf175b4', '097b9316', '702689dd', '182b0030', '752dc2fe',
  'de92da7a', 'c2ea81b1', '63b1c0e8', 'c4bcc279', '20d1fb82', '35cf0884', '397d5b11', '2413ca62',
  'a721d179', '9cd0aecd', '4dbb34d2', 'c341f726', 'd06ef167', 'd003b3a7', 'f35b95a7', '30d795e3',
  '9a0edb2e', '7b208fc7', '739ca9e4', '3cedfba6', '34bcd2a7', 'c65ec97b', '54b9bd43', 'f75a0f5c',
  'eed0cdef', '040c58ed', '5d672cb4', '602d03ef', '33929bab', 'd19343e9', 'a26e7291', '8e46681d',
  '3f8b95aa', 'cf115c18', '247b6bfa', '538190f3', '0149d70f', 'ce688350', 'c7afe670', '6f0094cd',
];

describe('unit P1 — the faster facet engine gives exactly the results of the engine before it', () => {
  it('the deck fixtures: every group, value, count and order', () => {
    const got = FIXTURE_CASES.map(([lib, scope, selection]) => signature(facetsOf(lib, scope, selection)));
    expect(got).toEqual(GOLDEN_FIXTURES);
  });

  it('120 rich random libraries × 2 scopes and selections', () => {
    const got: string[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = createRandom(`facets-p1-${seed}`);
      const lib = richLibrary(rnd);
      const ctx = ctxOf(lib);
      for (let k = 0; k < 2; k++) {
        const scope = rnd.bool(0.6) ? {} : randomQuery(rnd, lib, 1);
        got.push(signature(deriveFacets(lib.cards, scope, randomQuery(rnd, lib, rnd.int(0, 4)), ctx)));
      }
    }
    expect(got).toEqual(GOLDEN_RICH);
  });

  it('the per-note data is kept across a new index: after an edit, the counts of a fresh engine', () => {
    const rnd = createRandom('facets-p1-edit');
    const lib = richLibrary(rnd);
    const first = facetsOf(lib);
    // An edit: one note gets another section, tag and level (a new object); the others stay the same objects.
    const target = lib.notes[0];
    const editedNote = { ...target, section: 'Zeta::New', tags: ['fresh'], fields: target.fields.map((f, i) => (i === 1 ? 'C2' : f)) };
    const edited: Library = { ...lib, notes: lib.notes.map((n) => (n === target ? editedNote : n)) };
    // A fresh engine: copies of every note (nothing is cached for them).
    const copies: Library = { ...edited, notes: edited.notes.map((n) => ({ ...n })) };
    expect(facetsOf(edited)).toEqual(facetsOf(copies));
    // And back (an undo): the first counts again.
    expect(facetsOf(lib)).toEqual(first);
  });

  /*
   * Unit P1 review 2: the "≥ 2 sections" rule counts the FULL section paths.
   * Folding can make the FIRST segment empty: a lone combining accent
   * '\u0301::Verbs' folds to '::verbs', whose prefixes are ['', 'verbs'] —
   * so its full path is NOT its last prefix. The faster engine took the last
   * prefix and saw one section ('verbs') where the engine before saw two.
   */
  it("a section path that folds to '::verbs' (a lone accent as its first part) counts as its own section", () => {
    const type = builtinType('basic', NOW);
    const deck = makeDeck({ id: 'deck-1', name: 'D' }, NOW);
    const notes = Array.from({ length: 21 }, (_, i) =>
      makeNote({ id: `n${i}`, typeId: type.id, fields: [`w ${i}`, 'b', '', ''], section: i < 8 ? '\u0301::Verbs' : 'Verbs' }, NOW),
    );
    const lib: Library = {
      types: [type],
      notes,
      cards: notes.map((n, i) => makeCard(n, 0, 'deck-1', DEFAULT_SRS, NOW, { id: `c${i}` })),
      decks: [deck],
    };
    expect(pathPrefixes('::verbs')).toEqual(['', 'verbs']);
    // The engine before unit P1: a Section group with both prefixes of the two paths.
    const section = facet(facetsOf(lib), 'section');
    expect(section?.values.map((v) => [v.value, v.count])).toEqual([
      [sectionValue('deck-1', 'verbs'), 21],
      [sectionValue('deck-1', ''), 8],
    ]);
    // A copy of every note (nothing cached): the same group again.
    expect(facetsOf({ ...lib, notes: notes.map((n) => ({ ...n })) })).toEqual(facetsOf(lib));
  });

  it('sections with empty folded parts in two decks: every group, value, count and order of the engine before', () => {
    const type = builtinType('basic', NOW);
    const SECTIONS = ['\u0301::Verbs', 'Verbs', '\u0301::\u0301::Verbs::B1', 'Verbs::\u0301', '\u0301', '', '\u0301::Nouns'];
    const notes = Array.from({ length: 28 }, (_, i) =>
      makeNote({ id: `n${i}`, typeId: type.id, fields: [`w ${i}`, 'b', '', ''], section: SECTIONS[i % SECTIONS.length] }, NOW),
    );
    const lib: Library = {
      types: [type],
      notes,
      cards: notes.map((n, i) => makeCard(n, 0, i % 4 === 3 ? 'deck-2' : 'deck-1', DEFAULT_SRS, NOW, { id: `c${i}` })),
      decks: [makeDeck({ id: 'deck-1', name: 'D' }, NOW), makeDeck({ id: 'deck-2', name: 'E' }, NOW)],
    };
    const cases: [Query, Query][] = [
      [{}, {}],
      [{}, { sections: [{ deckId: 'deck-1', path: '::verbs' }] }],
      [{ decks: ['deck-1'] }, {}],
      [{}, { decks: ['deck-2'] }],
    ];
    // Recorded with the engine BEFORE unit P1.
    expect(cases.map(([scope, selection]) => signature(facetsOf(lib, scope, selection)))).toEqual([
      '7d992f5c', 'cc946caf', 'bdf867b8', '570f6fea',
    ]);
  });
});
