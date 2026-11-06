/**
 * The two "no field whitelist" helpers of make.ts (W1-3). The load-bearing
 * properties:
 *   - `omitKeys` removes ONLY the listed keys: every other key survives —
 *     also a key this code does not know (the "field-whitelist trap": a
 *     fixed key list silently dropped new fields, report 6);
 *   - `definedOnly` drops only `undefined`, so an explicit `undefined` never
 *     replaces a default (no NaN due dates), and null / 0 / false / '' stay.
 *
 * (W5-3 removed the old v2 card and deck constructors of make.ts with their
 * tests: nothing builds v2 objects any more. The note-model constructors are
 * pinned by makeV3.test.ts.)
 */
import { describe, expect, it } from '@jest/globals';

import { definedOnly, omitKeys } from './make';

describe('omitKeys', () => {
  it('removes only the listed keys and copies every other key', () => {
    const input = Object.assign({ id: 'c1', front: 'a', reps: 3 }, { unknown: true });
    expect(omitKeys(input, ['id', 'reps'])).toEqual({ front: 'a', unknown: true });
  });

  it('never changes its input', () => {
    const input = Object.freeze({ id: 'c1', front: 'a' });
    expect(omitKeys(input, ['id'])).toEqual({ front: 'a' });
    expect(input).toEqual({ id: 'c1', front: 'a' });
  });
});

describe('definedOnly', () => {
  it('drops undefined values and keeps null, 0, false and empty text', () => {
    expect(definedOnly({ a: undefined, b: null, c: 0, d: false, e: '' })).toEqual({ b: null, c: 0, d: false, e: '' });
    expect('a' in definedOnly({ a: undefined })).toBe(false);
  });

  it('spread over defaults, it keeps every default the caller did not really set', () => {
    const defaults = { ease: 2.5, due: 100, reps: 0 };
    expect({ ...defaults, ...definedOnly({ due: undefined, reps: 3 }) }).toEqual({ ease: 2.5, due: 100, reps: 3 });
  });
});
