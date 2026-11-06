/**
 * Seeded random numbers for tests (spec W0-1).
 *
 * Property tests ("300 random states", "50 random states round-trip") need
 * random inputs, but a failing test must fail again on the next run with the
 * same input. So tests never call Math.random(): they create a generator from a
 * SEED. The same seed gives the same numbers, in the same order, on every
 * machine. When a property test fails, print the seed — it reproduces the case.
 *
 * The generator is mulberry32 (a small, well-known 32-bit PRNG — "pseudo-random
 * number generator": numbers that look random but come from a formula). A
 * string seed is first turned into a number with the FNV-1a hash.
 *
 * Example:
 *   const rnd = createRandom(42);
 *   rnd.int(1, 6);              // a dice roll, the same every run
 *   rnd.shuffle(['a', 'b', 'c']);
 *   const cards = rnd.fork('cards'); // own stream: more draws elsewhere don't change it
 */

export interface Random {
  /** The 32-bit seed this generator started from. */
  readonly seed: number;
  /** A number in [0, 1). */
  next(): number;
  /** An integer from `min` to `max`, both included. */
  int(min: number, max: number): number;
  /** true with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** One item of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** A NEW array with the items in a random order (the input is not changed). */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` different items, in random order. */
  sample<T>(items: readonly T[], count: number): T[];
  /** A short id like 'x-3k9f2a', built only from this generator. */
  id(prefix?: string): string;
  /** A separate generator for one part of a test, derived from the seed and a label. */
  fork(label: string): Random;
}

/** FNV-1a, 32 bit: a fast, stable string hash (same input → same number). */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toSeed(seed: number | string): number {
  if (typeof seed === 'string') return fnv1a(seed);
  if (!Number.isFinite(seed)) throw new Error('createRandom: seed must be a finite number or a string');
  return Math.trunc(seed) >>> 0;
}

export function createRandom(seed: number | string): Random {
  const start = toSeed(seed);
  let state = start;

  // mulberry32: one 32-bit state word, advanced by a constant, then mixed.
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`Random.int: bad range ${min}..${max}`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    // Fisher–Yates: walk from the end and swap each item with an earlier one.
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  };

  return {
    seed: start,
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('Random.pick: empty list');
      return items[int(0, items.length - 1)];
    },
    shuffle,
    sample: <T>(items: readonly T[], count: number): T[] => {
      if (count > items.length) throw new Error('Random.sample: count is larger than the list');
      return shuffle(items).slice(0, count);
    },
    id: (prefix = 'x') => `${prefix}-${Math.floor(next() * 0x7fffffff).toString(36)}`,
    fork: (label: string) => createRandom(fnv1a(`${start}:${label}`)),
  };
}
