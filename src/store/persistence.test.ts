/**
 * Tests for the load classifier that fixes the C1 data-loss bug: the three
 * stored-value cases must be distinguished so a corrupt blob is preserved and
 * only genuine first-boot/valid documents lead to a (writable) seed/load.
 */
import { describe, expect, test } from '@jest/globals';

import { buildSeedState } from '../domain/seed';
import { classifyStored, isValidState, parseStored, serialize } from './persistence';

describe('classifyStored', () => {
  test('null or empty → first-boot', () => {
    expect(classifyStored(null).kind).toBe('first-boot');
    expect(classifyStored('').kind).toBe('first-boot');
  });

  test('a valid stored document → loaded', () => {
    const out = classifyStored(serialize(buildSeedState(0)));
    expect(out.kind).toBe('loaded');
    if (out.kind === 'loaded') expect(out.state.collections).toHaveLength(3);
  });

  test('a truncated/unparseable blob → corrupt, carrying the raw for backup', () => {
    const out = classifyStored('{"cards":[1,2,3'); // truncated mid-write
    expect(out.kind).toBe('corrupt');
    if (out.kind === 'corrupt') expect(out.raw).toContain('cards');
  });

  test('a structurally invalid document → corrupt, never loaded', () => {
    // Parses as JSON but lacks person/settings — must not be adopted as state.
    const out = classifyStored(JSON.stringify({ cards: [], decks: [] }));
    expect(out.kind).toBe('corrupt');
  });
});

describe('parseStored / serialize', () => {
  test('serialize → parseStored round-trips the document', () => {
    const state = buildSeedState(0);
    expect(parseStored(serialize(state))).toEqual(state);
  });

  test('parseStored returns null for garbage / absent input', () => {
    expect(parseStored('not json')).toBeNull();
    expect(parseStored(null)).toBeNull();
    expect(parseStored('')).toBeNull();
  });
});

describe('isValidState', () => {
  test('accepts a full state, rejects partials and non-objects', () => {
    expect(isValidState(buildSeedState(0))).toBe(true);
    expect(isValidState({ cards: [], decks: [], person: {} })).toBe(false); // no settings
    expect(isValidState(null)).toBe(false);
    expect(isValidState('x')).toBe(false);
  });
});
