/**
 * The selection registry (spec §2.2 `sel` tokens, §6.7, unit W3-2): card ids
 * stay in memory, the session route carries only a token.
 *
 * What is pinned: put → get gives the ids back (unique, in their first
 * order, as a copy); an unknown, empty or expired token gives null (the
 * session shows "This selection is no longer available."); only the newest
 * SELECTION_MAX selections are kept; a token of an earlier app run is never
 * found; drop and clear; the app's helpers share one registry.
 */
import { describe, expect, test } from '@jest/globals';

import { createClock, FIXED_NOW } from '../test/clock';
import {
  createSelectionRegistry,
  getSelection,
  putSelection,
  SELECTION_MAX,
  SELECTION_TOKEN_PREFIX,
  SELECTION_TTL_MS,
  selectionRegistry,
} from './selectionRegistry';

describe('put and get', () => {
  test('the ids come back, unique and in their first order (the miss order)', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    const token = reg.put(['c3', 'c1', 'c3', 'c2', 'c1']);
    expect(token.startsWith(SELECTION_TOKEN_PREFIX)).toBe(true);
    expect(reg.get(token)).toEqual(['c3', 'c1', 'c2']);
  });

  test('get gives a copy: changing it changes nothing in the registry', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    const token = reg.put(['a', 'b']);
    const first = reg.get(token);
    first?.push('x');
    expect(reg.get(token)).toEqual(['a', 'b']);
  });

  test('the ids given to put are copied too', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    const ids = ['a', 'b'];
    const token = reg.put(ids);
    ids.push('c');
    expect(reg.get(token)).toEqual(['a', 'b']);
  });

  test('every token is different, also in the same millisecond', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    const tokens = Array.from({ length: 10 }, () => reg.put(['a']));
    expect(new Set(tokens).size).toBe(10);
  });

  test('an empty selection is kept (the session then shows its empty state)', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    expect(reg.get(reg.put([]))).toEqual([]);
  });

  test('blank ids are dropped', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    expect(reg.get(reg.put(['', 'a', '']))).toEqual(['a']);
  });
});

describe('unknown tokens', () => {
  test('an unknown, empty, null or undefined token gives null', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    reg.put(['a']);
    expect(reg.get('sel-nope')).toBeNull();
    expect(reg.get('')).toBeNull();
    expect(reg.get(null)).toBeNull();
    expect(reg.get(undefined)).toBeNull();
  });

  test('an app restart forgets every token (a new registry, a later clock)', () => {
    const before = createSelectionRegistry({ now: () => FIXED_NOW });
    const old = before.put(['a', 'b']);
    // The next run: the same counter values, but a later time.
    const after = createSelectionRegistry({ now: () => FIXED_NOW + 60_000 });
    const fresh = after.put(['c']);
    expect(fresh).not.toBe(old);
    expect(after.get(old)).toBeNull();
  });
});

describe('expire', () => {
  test(`a selection older than ${SELECTION_TTL_MS / 3_600_000} hours is gone`, () => {
    const clock = createClock(FIXED_NOW);
    const reg = createSelectionRegistry({ now: clock.now });
    const token = reg.put(['a']);
    clock.advance(SELECTION_TTL_MS);
    expect(reg.get(token)).toEqual(['a']); // exactly at the limit: still there
    clock.advance(1);
    expect(reg.get(token)).toBeNull();
    expect(reg.size).toBe(0); // reading an expired token removes it
  });

  test('a custom ttl', () => {
    const clock = createClock(FIXED_NOW);
    const reg = createSelectionRegistry({ now: clock.now, ttlMs: 1_000 });
    const token = reg.put(['a']);
    clock.advance(1_001);
    expect(reg.get(token)).toBeNull();
  });

  test(`only the newest ${SELECTION_MAX} selections are kept; the oldest goes first`, () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    const tokens = Array.from({ length: SELECTION_MAX + 2 }, (_, i) => reg.put([`c${i}`]));
    expect(reg.size).toBe(SELECTION_MAX);
    expect(reg.get(tokens[0])).toBeNull();
    expect(reg.get(tokens[1])).toBeNull();
    expect(reg.get(tokens[2])).toEqual(['c2']);
    expect(reg.get(tokens[tokens.length - 1])).toEqual([`c${SELECTION_MAX + 1}`]);
  });

  test('a custom maximum', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW, max: 2 });
    const a = reg.put(['a']);
    reg.put(['b']);
    reg.put(['c']);
    expect(reg.get(a)).toBeNull();
    expect(reg.size).toBe(2);
  });
});

describe('drop and clear', () => {
  test('drop forgets one selection, clear forgets all', () => {
    const reg = createSelectionRegistry({ now: () => FIXED_NOW });
    const a = reg.put(['a']);
    const b = reg.put(['b']);
    reg.drop(a);
    expect(reg.get(a)).toBeNull();
    expect(reg.get(b)).toEqual(['b']);
    reg.clear();
    expect(reg.get(b)).toBeNull();
    expect(reg.size).toBe(0);
  });
});

describe('the app helpers', () => {
  test('putSelection and getSelection use the one app registry', () => {
    const token = putSelection(['x', 'y']);
    expect(getSelection(token)).toEqual(['x', 'y']);
    expect(selectionRegistry.get(token)).toEqual(['x', 'y']);
    selectionRegistry.drop(token);
    expect(getSelection(token)).toBeNull();
  });
});
