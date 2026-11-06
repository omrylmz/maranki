/**
 * Two small object helpers for the "no field whitelist" rule (spec unit W1-3,
 * report 6 "field-whitelist trap").
 *
 * The trap: a constructor that builds an object from a FIXED LIST of keys
 * compiles fine when a new field is added, but silently drops that field on
 * the way into the library. The rule that avoids it has two parts:
 *   1. A constructor COPIES every key the caller gives; defaults only fill
 *      the keys the caller left out (`definedOnly` keeps a default when the
 *      caller passes `undefined`).
 *   2. When an action must reset some keys itself (for example "a copied
 *      card has no progress"), it REMOVES those keys from the input first,
 *      with `omitKeys`. So the code lists the keys it resets, never the keys
 *      it keeps — and a new key is kept by default.
 *
 * The constructors of the note model live in makeV3.ts (makeNote, makeCard,
 * makeDeck) and follow the same rule; noteOps.ts uses `omitKeys` for
 * "Duplicate deck". (W5-3 removed the old v2 card and deck constructors that
 * used to live here: nothing built v2 objects any more.)
 *
 * Pure: no clock, no ids.
 *
 * Example:
 *   { ...defaults, ...definedOnly({ due: undefined, reps: 3 }) }   // keeps the default due, sets reps
 *   omitKeys({ id: 'c-1', front: 'a', reps: 3 }, ['id', 'reps'])    // → { front: 'a' }
 */

/**
 * A copy of `o` without the keys whose value is `undefined`.
 * Spreading the result over defaults keeps every default the caller did not
 * really set: `{ ...defaults, ...definedOnly({ due: undefined }) }` keeps `due`.
 */
export function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (o[key] !== undefined) out[key] = o[key];
  }
  return out;
}

/**
 * A shallow copy of `o` without the listed keys. Every other key — also a key
 * this code does not know — is copied. The input is never changed.
 *
 * Example: omitKeys({ id: 'c-1', front: 'a', reps: 3 }, ['id', 'reps']) → { front: 'a' }
 */
export function omitKeys<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Omit<T, K> {
  const drop = new Set<PropertyKey>(keys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out as Omit<T, K>;
}
