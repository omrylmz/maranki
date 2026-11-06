/**
 * Lists — saved filters (spec §4.7).
 *
 * A list is a saved `Query` with a name and an emoji ("B1 verbs"). It is
 * always up to date (it stores the filter, not the cards) and it is not a
 * folder: one card can match many lists.
 *
 * BUILT-IN lists are CODE constants (this file). Only their display
 * preferences (`listPrefs`: pinned, hidden, order) are stored. So a fix to a
 * built-in query reaches every user at once. (Today's seed collections are
 * frozen in storage, seed.ts:39-43 — that is what this replaces.)
 *
 *   id                  name           query
 *   builtin:favorites   Favorites      { flags: ['fav'] }
 *   builtin:flagged     Flagged        { flags: ['flagged'] }
 *   builtin:hard        Hard cards     { hard: true }
 *   builtin:recent      Recent cards   { young: true }        (was "Daily practice")
 *   builtin:suspended   Suspended      { flags: ['suspended'] } (so suspended cards can always be found)
 *   builtin:leeches     Leeches        { leech: true }
 *
 * USER lists live in `state.lists`. A list's query never contains `list`
 * (resolution is one level deep, §4.1): `cleanListInput` strips it, and
 * query.ts ignores it anyway.
 *
 * Pure: no React, no I/O.
 */
import type { Id, ListDef, Query, SortSpec } from './model';
import { sameQuery, sanitizeQuery } from './query';

/** Every built-in list id starts with this. */
export const BUILTIN_LIST_PREFIX = 'builtin:';

/** Longest list name (spec §4.7). */
export const LIST_NAME_MAX = 40;

/** Icon of a user list saved without one. */
export const DEFAULT_LIST_ICON = '🔖';

/**
 * Build one frozen built-in list (its query and the query's arrays too, so no
 * caller can change a constant by accident). createdAt/updatedAt are 0: they
 * are code, not data.
 */
function builtin(id: string, name: string, icon: string, query: Query): ListDef {
  for (const value of Object.values(query)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  return Object.freeze({
    id: `${BUILTIN_LIST_PREFIX}${id}`,
    name,
    icon,
    query: Object.freeze(query),
    createdAt: 0,
    updatedAt: 0,
  });
}

/** The built-in lists, in the order the UI lists them (spec §4.7 table). */
export const BUILTIN_LISTS: readonly ListDef[] = Object.freeze([
  builtin('favorites', 'Favorites', '❤️', { flags: ['fav'] }),
  builtin('flagged', 'Flagged', '🚩', { flags: ['flagged'] }),
  builtin('hard', 'Hard cards', '🔥', { hard: true }),
  builtin('recent', 'Recent cards', '🌱', { young: true }),
  builtin('suspended', 'Suspended', '⏸️', { flags: ['suspended'] }),
  builtin('leeches', 'Leeches', '🐌', { leech: true }),
]);

const BUILTIN_BY_ID: ReadonlyMap<string, ListDef> = new Map(BUILTIN_LISTS.map((l) => [l.id, l]));

/** True for an id like 'builtin:hard' (a built-in list id, known or not). */
export function isBuiltinListId(id: string): boolean {
  return id.startsWith(BUILTIN_LIST_PREFIX);
}

/** The built-in list with this id, or undefined. */
export function builtinList(id: string): ListDef | undefined {
  return BUILTIN_BY_ID.get(id);
}

/**
 * Every list by id: the built-in lists + the user's lists. This is
 * `MatchCtx.lists` (§4.1). A user list can never replace a built-in one
 * (built-in ids are reserved).
 */
export function listsById(userLists: readonly ListDef[]): Map<string, ListDef> {
  const out = new Map<string, ListDef>(BUILTIN_BY_ID);
  for (const list of userLists) {
    if (!isBuiltinListId(list.id)) out.set(list.id, list);
  }
  return out;
}

/** A list by id, built-in or user. */
export function findList(id: string, userLists: readonly ListDef[]): ListDef | undefined {
  return builtinList(id) ?? userLists.find((l) => l.id === id && !isBuiltinListId(l.id));
}

/** The query without its `list` key, cleaned. A list's query is one level deep. */
export function stripListKey(q: Query): Query {
  return sanitizeQuery({ ...q, list: undefined });
}

/** What "Save as list" / "Rename" sends. */
export interface ListInput {
  name: string;
  icon: string;
  query: Query;
  sort?: SortSpec;
}

/**
 * Clean a list before it is saved: name trimmed and cut to 40 characters
 * (whole characters, so an emoji is never cut in half), icon defaulted, the
 * query cleaned and its `list` key removed. Returns null when the name is
 * empty (the Save button stays disabled).
 */
export function cleanListInput(input: ListInput): ListInput | null {
  const name = Array.from((input.name ?? '').replace(/\s+/g, ' ').trim()).slice(0, LIST_NAME_MAX).join('').trim();
  if (name === '') return null;
  const icon = (input.icon ?? '').trim() || DEFAULT_LIST_ICON;
  return {
    name,
    icon,
    query: stripListKey(input.query ?? {}),
    ...(input.sort ? { sort: { ...input.sort } } : {}),
  };
}

/**
 * The ListDef that `saveList` stores (the reducer command of §3.6 calls this).
 * A new list gets `ctx.newId()`; saving over `existing` keeps its id and
 * createdAt. Returns null for an empty name or a built-in id (built-in lists
 * are code: only their prefs can change).
 */
export function makeListDef(
  input: ListInput,
  ctx: { now: number; newId: () => Id },
  existing?: ListDef,
): ListDef | null {
  if (existing && isBuiltinListId(existing.id)) return null;
  const clean = cleanListInput(input);
  if (!clean) return null;
  return {
    id: existing?.id ?? ctx.newId(),
    name: clean.name,
    icon: clean.icon,
    query: clean.query,
    ...(clean.sort ? { sort: clean.sort } : {}),
    createdAt: existing?.createdAt ?? ctx.now,
    updatedAt: ctx.now,
  };
}

/** The line Library shows when a list is open (spec §4.7): From list 'B1 verbs' */
export function fromListLine(list: Pick<ListDef, 'name'>): string {
  return `From list '${list.name}'`;
}

/**
 * True when the chips differ from the list's saved query — then Library
 * offers "Update list" · "Save as new list" (spec §4.7). Order and case do
 * not count as a change.
 */
export function listQueryChanged(list: Pick<ListDef, 'query'>, chips: Query): boolean {
  return !sameQuery(stripListKey(list.query), stripListKey(chips));
}
