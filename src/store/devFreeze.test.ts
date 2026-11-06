/**
 * Tests for the DEV deep-freeze (devFreeze.ts) and the synchronous store
 * (store.ts), spec §3.9, unit W2-1.
 *
 * What is pinned:
 *   - deepFreeze freezes every object and array inside the value;
 *   - an in-place change of a frozen state THROWS: array methods everywhere,
 *     and a plain assignment in strict AND non-strict code (babel-preset-expo
 *     compiles the app's modules without "use strict", and this test file is
 *     not strict either: see devFreeze.ts);
 *   - reading is unchanged: the same values, keys, key order, JSON and
 *     object identity (the identity diff relies on it);
 *   - an object that is frozen already is not walked again (the cost is only
 *     the changed objects);
 *   - every reducer command still works on frozen states (it never changes
 *     a state in place), and keeps the old objects it did not change;
 *   - the store: getState is current at once, listeners, "same object = no change";
 *   - review round 2: the assignment guards can be turned off
 *     (EXPO_PUBLIC_DEV_FREEZE_GUARDS=0, for timing checks such as E2): the
 *     state is still frozen, but reads are plain property reads again.
 */
import { describe, expect, jest, test } from '@jest/globals';

import { detectOrdinal, fieldFacetSpecs } from '../domain/facets';
import { readCsv } from '../domain/import/csvRead';
import { planImport, positionalFieldDefs } from '../domain/import/plan';
import type { DataStateV3, ImportChoices, ImportPlan } from '../domain/model';
import { FIXED_NOW } from '../test/clock';
import { makeCard, makeDeck, makeReviewLogEntry, makeState } from '../test/factories';
import { makeStateV3, randomStateV3 } from '../test/factoriesV3';
import { createRandom } from '../test/random';
import { DEV_FREEZE, DEV_FREEZE_GUARDS, deepFreeze, devFreezeGuardsOn } from './devFreeze';
import * as R from './reducer';
import { createStore } from './store';

/** A small state with two cards and two review-log entries (the seed has no cards). */
function twoCardState() {
  const a = makeCard({ id: 'card-a' });
  const b = makeCard({ id: 'card-b' });
  return makeState({
    decks: [makeDeck()],
    cards: [a, b],
    reviewLog: [makeReviewLogEntry(a, 'good'), makeReviewLogEntry(b, 'hard')],
  });
}

describe('deepFreeze', () => {
  test('freezes every object and array inside, and returns the same value', () => {
    const state = twoCardState();
    const out = deepFreeze(state);
    expect(out).toBe(state);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.person)).toBe(true);
    expect(Object.isFrozen(state.person.dayDone)).toBe(true);
    expect(Object.isFrozen(state.settings.srs)).toBe(true);
    expect(Object.isFrozen(state.settings.srs.learningStepsMin)).toBe(true);
    expect(Object.isFrozen(state.cards)).toBe(true);
    expect(state.cards).toHaveLength(2);
    expect(state.cards.every((c) => Object.isFrozen(c))).toBe(true);
    expect(state.reviewLog.every((e) => Object.isFrozen(e) && Object.isFrozen(e.prev))).toBe(true);
  });

  test('an in-place change throws: array methods always, a plain assignment in strict code', () => {
    const state = deepFreeze(twoCardState());
    const card = state.cards[0];
    // Array methods that change the array throw in EVERY module.
    expect(() => (state.cards as unknown[]).push(card)).toThrow(TypeError);
    expect(() => (state.cards as unknown[]).sort()).toThrow(TypeError);
    expect(() => (state.cards as unknown[]).splice(0, 1)).toThrow(TypeError);
    expect(() => (state.reviewLog as unknown[]).reverse()).toThrow(TypeError);
    // A plain assignment throws in strict-mode code ("use strict" is lexical:
    // it must be inside the function that does the assignment).
    expect(() => {
      'use strict';
      (card as { flagged: boolean }).flagged = true;
    }).toThrow(TypeError);
    expect(() => {
      'use strict';
      (state.person as { xp: number }).xp += 10;
    }).toThrow(TypeError);
    expect(() => {
      'use strict';
      delete (state.settings as { hapticsEnabled?: boolean }).hapticsEnabled;
    }).toThrow(TypeError);
    // Nothing was changed.
    expect(state.cards.map((c) => c.id)).toEqual(['card-a', 'card-b']);
    expect(card.flagged).toBe(false);
    expect(state.person.xp).toBe(makeState().person.xp);
    expect(state.settings.hapticsEnabled).toBe(true);
  });

  test('without "use strict" (how babel-preset-expo compiles app modules) an assignment throws too', () => {
    const state = deepFreeze(twoCardState());
    const card = state.cards[0];
    // This test file is not strict, like the app's modules: the spec's own example.
    expect(() => {
      (card as { flagged: boolean }).flagged = true;
    }).toThrow(TypeError);
    expect(() => {
      (state.person as { xp: number }).xp += 10;
    }).toThrow(TypeError);
    expect(() => {
      (state.settings.srs as { dailyNewLimit: number }).dailyNewLimit = 0;
    }).toThrow(/change data with an action/);
    expect(card.flagged).toBe(false);
    expect(state.person.xp).toBe(makeState().person.xp);
  });

  test('the gaps in non-strict code are ignored, never applied (memory and disk still agree)', () => {
    const state = deepFreeze(twoCardState());
    const card = state.cards[0];
    // Not thrown without "use strict" (see devFreeze.ts), but nothing changes either.
    delete (card as { flagged?: boolean }).flagged;
    (card as unknown as { brandNew: number }).brandNew = 1;
    (state.cards as unknown[])[0] = { id: 'other' };
    expect(card.flagged).toBe(false);
    expect('brandNew' in card).toBe(false);
    expect(state.cards[0]).toBe(card);
  });

  test('reading is unchanged: same values, keys, key order, JSON, spread and identity', () => {
    const plain = twoCardState();
    const json = JSON.stringify(plain);
    const keys = Object.keys(plain.cards[0]);
    const person = plain.person;
    const state = deepFreeze(plain);
    expect(JSON.stringify(state)).toBe(json);
    expect(Object.keys(state.cards[0])).toEqual(keys);
    expect(state.person).toBe(person); // the same object: the identity diff still works
    expect({ ...state.cards[0], flagged: true }).toEqual({ ...JSON.parse(json).cards[0], flagged: true });
    expect(state).toEqual(JSON.parse(json));
    expect(Object.getOwnPropertySymbols(state.cards[0])).toEqual([]); // no hidden keys
  });

  test('odd keys are safe: "__proto__" from JSON, and a property that cannot be redefined', () => {
    const fromJson = JSON.parse('{"__proto__": {"x": 1}, "a": 2}') as Record<string, unknown>;
    deepFreeze(fromJson);
    expect(fromJson.a).toBe(2);
    expect(Object.keys(fromJson)).toEqual(['__proto__', 'a']);
    const fixed = { b: 1 };
    Object.defineProperty(fixed, 'locked', { value: 3, enumerable: true, configurable: false, writable: true });
    deepFreeze(fixed);
    expect((fixed as { locked?: number }).locked).toBe(3); // left as it was, then frozen
    expect(Object.isFrozen(fixed)).toBe(true);
  });

  test('plain values come back as they are', () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze('text')).toBe('text');
    expect(deepFreeze(undefined)).toBeUndefined();
  });

  test('an object that is frozen already is not walked again (only changed objects cost time)', () => {
    const child = { notFrozen: true };
    const frozenParent = Object.freeze({ child });
    deepFreeze({ frozenParent, fresh: { inner: [1] } });
    // The walk stopped at the frozen parent, so its child was not visited.
    expect(Object.isFrozen(child)).toBe(false);
  });

  test('jest runs as a development build, so the engine freezes by default', () => {
    expect(DEV_FREEZE).toBe(true);
  });
});

/* ------------------------------ the guards can be turned off (review round 2) */

describe('deepFreeze with { guards: false } (EXPO_PUBLIC_DEV_FREEZE_GUARDS=0)', () => {
  /** Every own property of every object inside `value` is a plain data property (no getter). */
  function onlyDataProperties(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return true;
    return Object.keys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor && onlyDataProperties(descriptor.value);
    });
  }

  test('still frozen all the way down, but reads stay plain property reads (no getters: the fast path)', () => {
    const state = deepFreeze(twoCardState(), { guards: false });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.settings.srs.learningStepsMin)).toBe(true);
    expect(state.cards.every((c) => Object.isFrozen(c))).toBe(true);
    expect(onlyDataProperties(state)).toBe(true);
    // With the guards (the default) the same state reads through getters.
    expect(onlyDataProperties(deepFreeze(twoCardState()))).toBe(false);
  });

  test('array methods and strict-mode assignments still throw; a non-strict assignment is ignored, never applied', () => {
    const state = deepFreeze(twoCardState(), { guards: false });
    const card = state.cards[0];
    expect(() => (state.cards as unknown[]).push(card)).toThrow(TypeError);
    expect(() => (state.cards as unknown[]).sort()).toThrow(TypeError);
    expect(() => {
      'use strict';
      (card as { flagged: boolean }).flagged = true;
    }).toThrow(TypeError);
    // This file is not strict (like the app's modules): no throw, and no change.
    expect(() => {
      (card as { flagged: boolean }).flagged = true;
    }).not.toThrow();
    expect(card.flagged).toBe(false);
  });

  test('reading is unchanged: the same JSON, keys and identity as before the freeze', () => {
    const plain = twoCardState();
    const json = JSON.stringify(plain);
    const person = plain.person;
    const state = deepFreeze(plain, { guards: false });
    expect(JSON.stringify(state)).toBe(json);
    expect(state.person).toBe(person);
  });

  test('the first freeze decides: an object frozen without guards gets none later', () => {
    const card = deepFreeze(makeCard({ id: 'card-a' }), { guards: false });
    const state = deepFreeze(makeState({ cards: [card] })); // with guards
    expect(onlyDataProperties(state.cards[0])).toBe(true); // already frozen: not walked again
    expect(Object.getOwnPropertyDescriptor(state, 'cards')?.get).toBeDefined(); // the new object is guarded
  });
});

describe('devFreezeGuardsOn / DEV_FREEZE_GUARDS', () => {
  test('only "0" turns the guards off, and they are never on without the freeze (production)', () => {
    expect(devFreezeGuardsOn(true, undefined)).toBe(true); // a dev build, jest
    expect(devFreezeGuardsOn(true, '1')).toBe(true);
    expect(devFreezeGuardsOn(true, '')).toBe(true);
    expect(devFreezeGuardsOn(true, '0')).toBe(false); // timing checks (E2)
    expect(devFreezeGuardsOn(true, ' 0 ')).toBe(false);
    expect(devFreezeGuardsOn(false, undefined)).toBe(false);
    expect(devFreezeGuardsOn(false, '1')).toBe(false);
  });

  test('jest keeps the guards on, so the tests prove that a plain assignment throws', () => {
    expect(DEV_FREEZE_GUARDS).toBe(true);
  });
});

describe('every reducer command works on frozen states (no in-place change)', () => {
  const ctx = (): R.ReducerCtx => ({ now: FIXED_NOW, newId: R.createNewId(() => FIXED_NOW) });

  /** A real import plan (a two-row CSV into a new deck), made from `state` as the import screen does. */
  function importPlan(state: DataStateV3, step: number): ImportPlan {
    const collection = readCsv(`Baum ${step},tree\nHund ${step},dog`, `import-${step}.csv`);
    const types: ImportChoices['types'] = {};
    for (const mid of Object.keys(collection.models)) {
      types[mid] = { fields: positionalFieldDefs(collection.models[mid].flds.map((f) => f.name)), ords: [0] };
    }
    let n = 0;
    return planImport(
      collection,
      state,
      {
        sections: new Set(Object.keys(collection.decks)),
        target: { kind: 'new', name: `Import ${step}`, icon: '📥' },
        types,
        progress: 'keep',
        arrival: 'queued',
        elsewhere: 'update',
        images: true,
      },
      { now: FIXED_NOW, newId: () => `p${step}-${(n += 1)}`, srs: state.settings.srs, fieldFacetSpecs, detectOrdinal },
    );
  }

  test('rate, undo, complete, flags, bury, edit, decks, import, settings, restore, reset', () => {
    const rnd = createRandom('devFreeze-commands');
    for (let i = 0; i < 20; i++) {
      // W3-2: the reducer works on the v3 note model.
      let state = deepFreeze(randomStateV3(rnd, { now: FIXED_NOW }));
      const apply = <I, Res>(command: R.Command<I, Res>, input: I): Res => {
        // 1. On an UNFROZEN copy: the command must leave its input exactly as
        //    it was. This also catches what the freeze cannot report in this
        //    non-strict file: `delete`, a new key, an array index assignment.
        const copy = JSON.parse(JSON.stringify(state)) as DataStateV3;
        const before = JSON.stringify(copy);
        command(copy, input, ctx());
        expect(JSON.stringify(copy)).toBe(before);
        // 2. On the frozen state, as the engine runs it (an assignment or an
        //    array method that changes the state would throw).
        const step = command(state, input, ctx());
        state = deepFreeze(step.state);
        return step.result;
      };
      const card = state.cards[0];
      const deck = state.decks[0];
      if (card) {
        apply(R.rateCard, { cardId: card.id, rating: 'good' });
        apply(R.rateCard, { cardId: card.id, rating: 'again', kind: 'practice' });
        apply(R.undoLastReview, undefined);
        apply(R.setFlags, { cardIds: [card.id], patch: { fav: true, flagged: true } });
        apply(R.bury, { cardIds: [card.id] });
        apply(R.reschedule, { cardIds: [card.id], dueMs: FIXED_NOW + 60_000 });
        apply(R.resetProgress, { cardIds: [card.id] });
        const known = apply(R.markKnown, { cardIds: [card.id] });
        apply(R.undoManualEdit, { editId: known.edit.id });
      }
      apply(R.trackSession, {
        snapshot: {
          kind: 'scheduled',
          label: 'Today',
          counts: { again: 0, hard: 0, good: 1, easy: 0 },
          total: 1,
          bestRun: 1,
          durationSec: 5,
          fastAnswers: 0,
        },
      });
      apply(R.reconcileOnBoot, undefined);
      apply(R.completeSession, {
        kind: 'scheduled',
        label: 'Today',
        counts: { again: 1, hard: 0, good: 2, easy: 0 },
        total: 3,
        bestRun: 2,
        durationSec: 30,
        fastAnswers: 1,
      });
      const added = apply(R.addDeck, { input: { name: 'New deck', desc: 'kept' } });
      const note = apply(R.addNote, { deckId: added.id, typeId: 'nt-basic-reverse', fields: ['a', 'b'], tags: ['x'] });
      apply(R.editNote, { noteId: note.noteId, patch: { fields: ['a2', 'b2'], tags: ['y'] } });
      apply(R.applyImport, { plan: importPlan(state, i) });
      apply(R.duplicateDeck, { deckId: deck.id });
      apply(R.updateDeck, { deckId: deck.id, patch: { active: false } });
      apply(R.deleteDeck, { deckId: added.id, strategy: { kind: 'keep' } });
      apply(R.setGoals, { goalReviews: 5, goalNew: 5 });
      apply(R.setLimits, { patch: { dailyNewLimit: 3 } });
      apply(R.updateSrsSettings, { patch: { startingEase: 2.3 } });
      apply(R.updateAppSettings, { patch: { hapticsEnabled: false } });
      apply(R.markOnboarded, undefined);
      const removed = apply(R.deleteNotes, { noteIds: card ? [card.noteId] : [] });
      apply(R.undoDelete, { deleted: removed });
      apply(R.restoreState, { next: makeStateV3() });
      apply(R.factoryReset, undefined);
    }
  });

  test('a command keeps the objects it did not change (the identity diff relies on it)', () => {
    const state = deepFreeze(randomStateV3(createRandom('devFreeze-identity'), { now: FIXED_NOW, maxNotes: 10 }));
    const card = state.cards.find((c) => c.reps === 0) ?? state.cards[0];
    if (!card) throw new Error('the random state has no card');
    const step = R.setFlags(state, { cardIds: [card.id], patch: { fav: !card.fav } }, ctx());
    expect(step.state.decks).toBe(state.decks);
    expect(step.state.settings).toBe(state.settings);
    for (const c of step.state.cards) {
      if (c.id === card.id) expect(c).not.toBe(card);
      else expect(c).toBe(state.cards.find((o) => o.id === c.id));
    }
  });
});

describe('createStore', () => {
  test('getState is the new value as soon as update returns; listeners run after it is stored', () => {
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getState().n));
    store.update((s) => ({ n: s.n + 1 }));
    expect(store.getState().n).toBe(1);
    store.update((s) => ({ n: s.n + 1 }));
    expect(seen).toEqual([1, 2]);
  });

  test('the same object back means "no change": no listener runs', () => {
    const store = createStore({ n: 0 });
    const listener = jest.fn();
    store.subscribe(listener);
    store.update((s) => s);
    expect(listener).not.toHaveBeenCalled();
  });

  test('unsubscribe stops a listener; a listener may update again', () => {
    const store = createStore({ n: 0 });
    const stop = store.subscribe(() => {
      if (store.getState().n === 1) store.update(() => ({ n: 2 }));
    });
    store.update(() => ({ n: 1 }));
    expect(store.getState().n).toBe(2);
    stop();
    store.update(() => ({ n: 1 }));
    expect(store.getState().n).toBe(1);
  });

  test('with freeze: the initial and every new value are frozen; without: nothing is', () => {
    const frozen = createStore({ list: [1] }, { freeze: deepFreeze });
    expect(Object.isFrozen(frozen.getState().list)).toBe(true);
    frozen.update(() => ({ list: [2] }));
    expect(Object.isFrozen(frozen.getState().list)).toBe(true);

    const plain = createStore({ list: [1] }); // production: no freeze
    expect(Object.isFrozen(plain.getState().list)).toBe(false);
  });
});
