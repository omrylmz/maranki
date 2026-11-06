/**
 * The app-side stable hash and seeded shuffle (spec W2-6).
 *
 * These pin two promises:
 *   1. fnv1a is the REAL FNV-1a: the standard test vectors hold, and it gives
 *      the same numbers as the test helper (src/test/random.ts). The scheduler
 *      samples Known cards with it, so a change here would silently change
 *      which cards get a Check.
 *   2. seededShuffle is deterministic: the same seed always gives the same
 *      order, and it never loses, adds or changes an item.
 */
import { describe, expect, it } from '@jest/globals';

import { createRandom, fnv1a as testFnv1a } from '../test/random';
import { fnv1a, seededRandom, seededShuffle } from './hash';

describe('fnv1a', () => {
  it('matches the standard FNV-1a 32-bit test vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('b')).toBe(0xe70c2de5);
    expect(fnv1a('c')).toBe(0xe60c2c52);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('gives the same numbers as the test helper (same vectors everywhere)', () => {
    const rnd = createRandom('hash-vs-helper');
    for (let i = 0; i < 200; i++) {
      const text = rnd.id('c') + (rnd.bool() ? 'ü€' : '') + i;
      expect(fnv1a(text)).toBe(testFnv1a(text));
    }
  });

  it('is always an unsigned 32-bit integer', () => {
    const rnd = createRandom(7);
    for (let i = 0; i < 500; i++) {
      const h = fnv1a(rnd.id('card') + String.fromCharCode(rnd.int(0, 0xffff)));
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('is stable: the same text gives the same number on every call', () => {
    expect(fnv1a('c-123')).toBe(695271539);
    expect(fnv1a('c-123')).toBe(fnv1a('c-123'));
    expect(fnv1a('c-123')).not.toBe(fnv1a('c-124'));
  });

  it('spreads ids evenly over `% 10` (the Check sample is about 10%)', () => {
    // 10,000 ids like real card ids → each of the 10 remainders gets ~1,000.
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i++) buckets[fnv1a(`c-${i}`) % 10] += 1;
    for (const n of buckets) {
      expect(n).toBeGreaterThan(850);
      expect(n).toBeLessThan(1150);
    }
  });
});

describe('seededRandom', () => {
  it('is deterministic and stays in [0, 1)', () => {
    const a = seededRandom('seed');
    const b = seededRandom('seed');
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('gives the value the hash.ts comment documents (0.649… for "c-123|2026-10-24")', () => {
    // The example in the seededRandom comment must stay true: a reader may check it by hand.
    expect(seededRandom('c-123|2026-10-24')()).toBeCloseTo(0.6492794405, 9);
  });

  it('equals the test helper generator for the same seed', () => {
    const app = seededRandom('same-stream');
    const helper = createRandom('same-stream');
    for (let i = 0; i < 50; i++) expect(app()).toBe(helper.next());
    const appN = seededRandom(42);
    const helperN = createRandom(42);
    for (let i = 0; i < 50; i++) expect(appN()).toBe(helperN.next());
  });

  it('different seeds give different streams', () => {
    const a = seededRandom('one');
    const b = seededRandom('two');
    const as = Array.from({ length: 5 }, () => a());
    const bs = Array.from({ length: 5 }, () => b());
    expect(as).not.toEqual(bs);
  });
});

describe('seededShuffle', () => {
  const ITEMS = ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine'];

  it('is deterministic: the same seed gives the same order', () => {
    expect(seededShuffle(ITEMS, 'c-1|2026-10-24')).toEqual(seededShuffle(ITEMS, 'c-1|2026-10-24'));
    expect(seededShuffle(ITEMS, 99)).toEqual(seededShuffle(ITEMS, 99));
  });

  it('keeps every item exactly once and never changes the input', () => {
    const input = [...ITEMS];
    const out = seededShuffle(input, 'keep');
    expect(input).toEqual(ITEMS);
    expect(out).not.toBe(input);
    expect([...out].sort()).toEqual([...ITEMS].sort());
  });

  it('gives the same order as the test helper shuffle', () => {
    for (const seed of ['a', 'b', 'quiz', 'c-77|2026-06-10']) {
      expect(seededShuffle(ITEMS, seed)).toEqual(createRandom(seed).shuffle(ITEMS));
    }
  });

  it('different seeds give different orders (most of the time)', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 20; i++) orders.add(seededShuffle(ITEMS, `seed-${i}`).join(','));
    // 8 items have 40,320 orders; 20 seeds should give (almost) 20 different ones.
    expect(orders.size).toBeGreaterThan(15);
  });

  it('handles an empty list and a single item', () => {
    expect(seededShuffle([], 'x')).toEqual([]);
    expect(seededShuffle(['only'], 'x')).toEqual(['only']);
  });
});
