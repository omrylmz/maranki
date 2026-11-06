/**
 * DEV deep-freeze (spec §3.9, unit W2-1): in development builds, every new
 * app state is made read-only, all the way down.
 *
 * WHY: the store never changes a state object. A command builds NEW objects
 * for what changes and keeps the old objects for the rest. The row store
 * (wave 3) finds what to save by comparing objects by identity (`a !== b`).
 * So an in-place change, for example
 *
 *   state.cards.sort(byDue);          // WRONG: sorts the stored array itself
 *   state.cards[0].flagged = true;    // WRONG: the same object, changed inside
 *
 * would never be saved: the object is still the same, so the save does not
 * see a change. With this guard, such a change THROWS a TypeError in
 * development instead of becoming lost data on a phone.
 *
 * HOW (two tools, because one is not enough):
 *   1. `Object.freeze` on every object and array. Every array method that
 *      changes an array (push, sort, splice, reverse, …) then throws, in every
 *      module.
 *   2. A plain assignment (`card.flagged = true`) to a frozen object throws
 *      ONLY in strict-mode code. babel-preset-expo compiles the app's modules
 *      WITHOUT "use strict" (its `strictMode: false`), and there JavaScript
 *      silently ignores the assignment. So, before the freeze, every property
 *      of a plain object is turned into a getter + a setter that throws. A
 *      setter runs in strict AND non-strict code, so the assignment throws
 *      everywhere. The getter returns the same value as before (the values
 *      are kept in a WeakMap), so reading, `{ ...card }`, `JSON.stringify`,
 *      `Object.keys` and `===` work exactly as before.
 *
 * What still does NOT throw in non-strict code (it is silently ignored, so
 * nothing changes — not in memory and not on the disk): an index assignment
 * on an array (`state.cards[0] = x`), `delete obj.key`, and adding a NEW key
 * (`card.newKey = 1`). Arrays keep plain properties: getters on 16,000 array
 * slots would make every list operation slow in development.
 *
 * COST — read this before you time anything in a development build:
 *   - The freeze itself: only objects that are not frozen yet are visited. A
 *     command keeps most old objects (already frozen), so after the first
 *     freeze only the changed objects are walked (spec §3.9).
 *   - The guards (tool 2) cost on EVERY READ, not only once: `card.due` is a
 *     function call plus a WeakMap lookup instead of a plain property read,
 *     for the whole session. With 16,000 cards (node, measured in review):
 *     the first freeze 191 ms instead of 37 ms, a 5-field filter over all
 *     cards about 28x slower, `JSON.stringify` of the cards about 12x slower.
 *     Hermes (no JIT) is slower still. So a dev build with a big deck feels
 *     slow, and its timings are the cost of the guards, not of the app.
 *   - Production builds skip all of it (`__DEV__` is false): a phone with a
 *     release build never pays for the freeze or the guards.
 *
 * TURN THE GUARDS OFF (keep the freeze) for timing work in a dev build:
 *
 *   EXPO_PUBLIC_DEV_FREEZE_GUARDS=0 npx expo start
 *
 * (or put the line `EXPO_PUBLIC_DEV_FREEZE_GUARDS=0` in
 * `.env.development.local`, which git ignores), then reload the app fully.
 * Expo writes the value into the JavaScript bundle, and this file reads it
 * once, when the app starts. (In a test, the engine option `freezeGuards`
 * does the same.) With the guards off, every state is still frozen: array
 * methods and strict-mode assignments still throw, and a non-strict
 * assignment is silently ignored (memory and disk still agree).
 *
 * Emulator check E2 (spec §11: time-to-ready, save after one rating, Library
 * filter) is measured with the guards OFF. Jest keeps them ON (the variable
 * is not set), so the tests still prove that a plain assignment throws.
 */

/** True in development builds (Metro sets `__DEV__`); jest runs as development too. */
export const DEV_FREEZE: boolean = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * Whether the dev freeze also adds the assignment guards (tool 2 above).
 * `setting` is the value of EXPO_PUBLIC_DEV_FREEZE_GUARDS: only "0" turns
 * them off. Never on when the freeze itself is off (production).
 *
 *   devFreezeGuardsOn(true, undefined) === true    // dev build, jest
 *   devFreezeGuardsOn(true, '0') === false         // dev build for timing (E2)
 *   devFreezeGuardsOn(false, undefined) === false  // production
 */
export function devFreezeGuardsOn(devFreeze: boolean, setting: string | undefined): boolean {
  return devFreeze && setting?.trim() !== '0';
}

/** The value of EXPO_PUBLIC_DEV_FREEZE_GUARDS, or undefined (not set, or no `process` at all). */
function guardsSetting(): string | undefined {
  try {
    // Must stay this exact static form: Expo replaces it with the value at build time.
    return process.env.EXPO_PUBLIC_DEV_FREEZE_GUARDS;
  } catch {
    return undefined;
  }
}

/** True when the engine's dev freeze adds the assignment guards (see the file comment). */
export const DEV_FREEZE_GUARDS: boolean = devFreezeGuardsOn(DEV_FREEZE, guardsSetting());

export interface DeepFreezeOptions {
  /**
   * Also turn every property of a plain object into a getter + a throwing
   * setter (tool 2 above), so a plain assignment throws in non-strict code
   * too. Default true. False = `Object.freeze` only: reads stay plain
   * property reads (fast), and a non-strict assignment is silently ignored.
   */
  guards?: boolean;
}

/**
 * Freeze `value` and every object and array inside it, and return it.
 * With the guards (the default), every property of a plain object becomes
 * read-only for assignments in ANY code (see the file comment). An object
 * that is frozen already is not walked again (its children were frozen
 * together with it), so the FIRST freeze of an object decides whether it
 * has guards. Plain values (strings, numbers, null) are returned as they are.
 *
 * Example: `deepFreeze({ cards: [] }).cards.push(card)` throws a TypeError,
 * and so does `deepFreeze(card).flagged = true`.
 * `deepFreeze(card, { guards: false }).flagged = true` throws only in
 * strict-mode code (without "use strict" it is silently ignored).
 */
export function deepFreeze<T>(value: T, options: DeepFreezeOptions = {}): T {
  freezeTree(value, options.guards ?? true);
  return value;
}

/** The walk of deepFreeze. */
function freezeTree(value: unknown, guards: boolean): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  if (guards && !Array.isArray(value)) guardAssignments(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    freezeTree((value as Record<string, unknown>)[key], guards);
  }
}

/** The original values of every guarded object: object → { key: value }. */
const VALUES = new WeakMap<object, Record<string, unknown>>();

/** One getter/setter pair per property NAME, shared by every object (so no new functions per object). */
const ACCESSORS = new Map<string, PropertyDescriptor>();

function accessorsFor(key: string): PropertyDescriptor {
  let accessors = ACCESSORS.get(key);
  if (!accessors) {
    accessors = {
      get(this: object) {
        return VALUES.get(this)?.[key];
      },
      set() {
        throw new TypeError(
          `Cannot assign to read only property '${key}' of the app state. ` +
            'States are never changed in place: change data with an action (a reducer command), ' +
            'which builds new objects (src/store/devFreeze.ts).',
        );
      },
      enumerable: true,
      configurable: false,
    };
    ACCESSORS.set(key, accessors);
  }
  return accessors;
}

/**
 * Turn every own data property of `obj` into a getter (same value) and a
 * setter that throws. A property that cannot be redefined (not configurable)
 * or is already a getter is left as it is.
 */
function guardAssignments(obj: object): void {
  // No prototype: a key such as "__proto__" or "toString" is stored as a plain key.
  const values = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (!descriptor || !descriptor.configurable || !('value' in descriptor)) continue;
    values[key] = descriptor.value;
  }
  VALUES.set(obj, values);
  for (const key of Object.keys(values)) Object.defineProperty(obj, key, accessorsFor(key));
}
