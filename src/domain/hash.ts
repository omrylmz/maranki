/**
 * Stable hashing and seeded shuffles for the app (spec §4.5, §6.1, §6.3).
 *
 * Why this file exists: React Compiler rules forbid `Math.random()` during
 * render, and the scheduler must give the SAME answer for the same state (so
 * "Study 34" opens exactly 34 cards). So every "random-looking" choice in the
 * app comes from a HASH of stable text instead of a random number:
 *
 *   fnv1a('c-123')               → 695271539  (always the same number)
 *   fnv1a('c-123') % 10 === 0    → "is this Known card sampled for a Check?"
 *   seededShuffle(options, 'c-123|2026-10-24')
 *                                → quiz answers in an order that is fixed for
 *                                  this card and this day
 *
 * FNV-1a ("Fowler–Noll–Vo", variant 1a) is a small, fast, well-known 32-bit
 * hash. It is NOT for security; it only spreads values evenly.
 *
 * It hashes UTF-16 code units (`charCodeAt`), like src/test/random.ts. For
 * ASCII text (every card id) this is exactly the standard byte-wise FNV-1a,
 * so the standard test vectors hold: fnv1a('a') === 0xe40c292c.
 *
 * Pure: no React, no clock, no Math.random().
 */

/** FNV-1a offset basis (the start value) for 32 bits. */
const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a prime for 32 bits. */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a, 32 bit: the same text always gives the same unsigned integer in
 * [0, 2^32). The scheduler calls it `hash` in spec §4.5.
 */
export function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // Math.imul multiplies as 32-bit integers, so the result never loses bits
    // the way a normal `*` on big numbers would.
    hash = Math.imul(hash, FNV_PRIME);
  }
  // `>>> 0` turns the signed 32-bit result into an unsigned one (never negative).
  return hash >>> 0;
}

/**
 * A seeded generator of numbers in [0, 1): the same seed gives the same
 * numbers in the same order, on every phone. A string seed is first hashed
 * with fnv1a. The formula is mulberry32 (a small, well-known 32-bit generator),
 * the same one as the test helper src/test/random.ts.
 *
 *   const next = seededRandom('c-123|2026-10-24');
 *   next(); // 0.649… — the same value on every run (hash.test.ts pins it)
 */
export function seededRandom(seed: string | number): () => number {
  let state = typeof seed === 'string' ? fnv1a(seed) : Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A NEW array with the items in an order fixed by `seed` (the input is not
 * changed). Same items + same seed → same order, every time. Use a seed that
 * names what must stay stable, for example `cardId + '|' + sessionDayKey`.
 *
 * Algorithm: Fisher–Yates (walk from the end and swap each item with a random
 * earlier one), with numbers from seededRandom(seed). It gives the same order
 * as `createRandom(seed).shuffle(items)` in the test helper.
 */
export function seededShuffle<T>(items: readonly T[], seed: string | number): T[] {
  const next = seededRandom(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
