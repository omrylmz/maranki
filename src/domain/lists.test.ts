/**
 * Lists — saved filters (spec §4.7): the built-in lists are code (ids,
 * names, queries from the spec table), user lists cannot replace them, and a
 * saved list's query is one level deep.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW as NOW } from '../test/clock';
import { buildLibraryIndex } from './libraryIndex';
import {
  BUILTIN_LISTS,
  builtinList,
  cleanListInput,
  DEFAULT_LIST_ICON,
  findList,
  fromListLine,
  isBuiltinListId,
  LIST_NAME_MAX,
  listQueryChanged,
  listsById,
  makeListDef,
  stripListKey,
} from './lists';
import { makeCard, makeDeck, makeNote } from './makeV3';
import type { Card, ListDef } from './model';
import { compileQuery, type MatchCtx } from './query';
import { DAY, DEFAULT_SRS } from './types';

const USER: ListDef = {
  id: 'l1',
  name: 'B1 verbs',
  icon: '📗',
  query: { fields: { level: ['b1'] } },
  createdAt: NOW - DAY,
  updatedAt: NOW - DAY,
};

describe('built-in lists (spec §4.7 table)', () => {
  it('ids, names and queries are exactly the spec table', () => {
    expect(BUILTIN_LISTS.map((l) => [l.id, l.name, l.query])).toEqual([
      ['builtin:favorites', 'Favorites', { flags: ['fav'] }],
      ['builtin:flagged', 'Flagged', { flags: ['flagged'] }],
      ['builtin:hard', 'Hard cards', { hard: true }],
      ['builtin:recent', 'Recent cards', { young: true }],
      ['builtin:suspended', 'Suspended', { flags: ['suspended'] }],
      ['builtin:leeches', 'Leeches', { leech: true }],
    ]);
    for (const l of BUILTIN_LISTS) expect(l.icon).not.toBe('');
  });

  it('the constants cannot be changed by accident', () => {
    const fav = builtinList('builtin:favorites')!;
    expect(Object.isFrozen(fav)).toBe(true);
    expect(Object.isFrozen(fav.query)).toBe(true);
    expect(Object.isFrozen(fav.query.flags)).toBe(true);
  });

  it('each built-in query selects the right cards', () => {
    const note = makeNote({ id: 'n', typeId: 'nt-basic', fields: ['a', 'b', '', ''] }, NOW);
    const card = (id: string, o: Partial<Card>) => makeCard(note, 0, 'd', DEFAULT_SRS, NOW, { id, ...o });
    const studied = { reps: 3, stepIndex: null, intervalDays: 30, ease: 2.5, due: NOW + DAY };
    const cards = [
      card('fav', { fav: true }),
      card('flagged', { flagged: true }),
      card('hard', { ...studied, ease: 1.9 }),
      card('recent', { ...studied, intervalDays: 3 }),
      card('suspended', { suspended: true }),
      card('leech', { ...studied, lapses: 9 }),
    ];
    const ctx: MatchCtx = {
      now: NOW,
      index: buildLibraryIndex([note], []),
      decks: new Map([['d', makeDeck({ id: 'd', name: 'D' }, NOW)]]),
      lists: listsById([]),
    };
    const expected: Record<string, string[]> = {
      'builtin:favorites': ['fav'],
      'builtin:flagged': ['flagged'],
      'builtin:hard': ['hard'],
      'builtin:recent': ['recent'],
      'builtin:suspended': ['suspended'],
      'builtin:leeches': ['leech'],
    };
    for (const list of BUILTIN_LISTS) {
      const match = compileQuery({ list: list.id }, ctx);
      expect([list.id, cards.filter(match).map((c) => c.id)]).toEqual([list.id, expected[list.id]]);
    }
  });
});

describe('finding lists', () => {
  it('isBuiltinListId / builtinList', () => {
    expect(isBuiltinListId('builtin:hard')).toBe(true);
    expect(isBuiltinListId('builtin:unknown')).toBe(true);
    expect(isBuiltinListId('l1')).toBe(false);
    expect(builtinList('builtin:hard')?.name).toBe('Hard cards');
    expect(builtinList('builtin:unknown')).toBeUndefined();
  });

  it('listsById = built-in + user lists; a user list cannot take a built-in id', () => {
    const fake: ListDef = { ...USER, id: 'builtin:hard', name: 'Hijack' };
    const map = listsById([USER, fake]);
    expect(map.size).toBe(BUILTIN_LISTS.length + 1);
    expect(map.get('l1')).toBe(USER);
    expect(map.get('builtin:hard')?.name).toBe('Hard cards');
  });

  it('findList', () => {
    expect(findList('l1', [USER])).toBe(USER);
    expect(findList('builtin:leeches', [USER])?.name).toBe('Leeches');
    expect(findList('nope', [USER])).toBeUndefined();
  });
});

describe('saving a list', () => {
  it("a list's query never keeps `list` (one level deep)", () => {
    expect(stripListKey({ list: 'l1', tags: ['B1'] })).toEqual({ tags: ['b1'] });
  });

  it('cleanListInput: trims, cuts to 40 whole characters, defaults the icon, cleans the query', () => {
    const long = `${'é'.repeat(39)}😀😀`;
    const clean = cleanListInput({ name: `  ${long} `, icon: ' ', query: { list: 'x', tags: ['A'], decks: [] } });
    expect(clean).not.toBeNull();
    expect(Array.from(clean!.name)).toHaveLength(LIST_NAME_MAX);
    expect(clean!.name.endsWith('😀')).toBe(true); // the emoji is whole, never cut in half
    expect(clean!.icon).toBe(DEFAULT_LIST_ICON);
    expect(clean!.query).toEqual({ tags: ['a'] });
  });

  it('cleanListInput: an empty name → null (Save stays disabled)', () => {
    expect(cleanListInput({ name: '   ', icon: '📗', query: {} })).toBeNull();
  });

  it('makeListDef: a new list gets a new id; saving over a list keeps id and createdAt', () => {
    const ctx = { now: NOW, newId: () => 'new-id' };
    const made = makeListDef({ name: 'Mine', icon: '📗', query: { hard: true }, sort: { by: 'due' } }, ctx);
    expect(made).toEqual({
      id: 'new-id',
      name: 'Mine',
      icon: '📗',
      query: { hard: true },
      sort: { by: 'due' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const updated = makeListDef({ name: 'Renamed', icon: '📘', query: USER.query }, ctx, USER);
    expect(updated).toMatchObject({ id: 'l1', name: 'Renamed', createdAt: USER.createdAt, updatedAt: NOW });
    expect(updated && 'sort' in updated).toBe(false);
  });

  it('makeListDef: built-in lists are code and cannot be saved over', () => {
    expect(makeListDef({ name: 'X', icon: '📗', query: {} }, { now: NOW, newId: () => 'x' }, BUILTIN_LISTS[0])).toBeNull();
  });

  it('a list keeps a field called "Constructor" or "__proto__" (field names are user data)', () => {
    // Object.fromEntries: an object literal cannot hold an own '__proto__' key.
    const query = { fields: Object.fromEntries([['Constructor', ['Copy']], ['__proto__', ['x']], ['toString', ['y']]]) };
    const def = makeListDef({ name: 'Copy rules', icon: '📘', query }, { now: NOW, newId: () => 'l9' })!;
    const saved = Object.fromEntries([['constructor', ['copy']], ['__proto__', ['x']], ['tostring', ['y']]]);
    expect(def.query).toEqual({ fields: saved });
    // It survives storage (JSON) and compares equal to itself.
    const stored = JSON.parse(JSON.stringify(def)) as ListDef;
    expect(stored.query).toEqual({ fields: saved });
    expect(listQueryChanged(stored, def.query)).toBe(false);
    expect(listQueryChanged(stored, { fields: { constructor: ['copy'], tostring: ['y'] } })).toBe(true);
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
});

describe('Library copy and change detection', () => {
  it("fromListLine: From list '{name}'", () => {
    expect(fromListLine(USER)).toBe("From list 'B1 verbs'");
  });

  it('listQueryChanged: order and case are not a change; a new chip is', () => {
    expect(listQueryChanged(USER, { fields: { Level: ['B1'] } })).toBe(false);
    expect(listQueryChanged(USER, { fields: { level: ['b1'] }, list: 'l1' })).toBe(false);
    expect(listQueryChanged(USER, { fields: { level: ['b1'] }, life: ['new'] })).toBe(true);
  });
});
