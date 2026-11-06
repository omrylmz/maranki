/**
 * Round-trip tests (spec §3.9, §3.12, units W2-1 → W3-2): what is saved comes
 * back exactly, and no command changes a state in place — on the v3 note model.
 *
 *   load(save(state)) deep-equals state
 *
 * for every real fixture (migrated and lifted to schema 3: what the app holds
 * after loading it) and 50 seeded random v3 states, through every port the
 * app can use today:
 *   - memory     — the web preview and tests (storage/memoryPort.ts);
 *   - kv (fake)  — the kv port (storage/kvStoragePort.ts) on a fake SQLite
 *                  kv-store that, like the real one, accepts TEXT only;
 *   - copy-forward (fake) — the port the app really uses on a phone
 *                  (storage/copyForward.ts over the fake kv-store).
 * The row port (W3-3) joins this list when it is merged.
 *
 * Then the engine end to end, with the DEV freeze on: random sequences of
 * real v3 actions (ratings, Checks, manual edits and their undo, notes,
 * imports, decks, lists), a flush, and a reboot on the same disk must give
 * the same state back, with nothing to repair. A command that changed a
 * state in place would throw (frozen arrays) or be lost (frozen objects),
 * and the reboot would not match.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { detectOrdinal, fieldFacetSpecs } from '../domain/facets';
import { readCsv } from '../domain/import/csvRead';
import { planImport, positionalFieldDefs } from '../domain/import/plan';
import type { DataStateV3, ImportChoices, Rating } from '../domain/model';
import type { DataState } from '../domain/types';
import { createClock, FIXED_NOW, type TestClock } from '../test/clock';
import { STATE_FIXTURES, stateFixture } from '../test/factories';
import { notesWithoutCards, randomStateV3, stateProblemsV3 } from '../test/factoriesV3';
import { createRandom, type Random } from '../test/random';
import { createEngine, readDocument, type Engine } from './engine';
import { migrate } from './migrate';
import type { StoragePort } from './storagePort';
import { createCopyForwardPort } from './storage/copyForward';
import { createKvStoragePort, KV_STATE_KEY, type KeyValueStore } from './storage/kvStoragePort';
import { createMemoryPort, createMemoryStore } from './storage/memoryPort';

// No native module is called here: every store is a fake.

/* ---------------------------------------------------------------- helpers */

/** A fake of `SQLiteStorage` (expo-sqlite/kv-store): a TEXT column, so a non-string value is refused. */
function fakeSqliteKv(): KeyValueStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const check = (key: unknown, value: unknown) => {
    if (typeof key !== 'string' || key === '') throw new Error('Invalid key');
    if (typeof value !== 'string') throw new Error('Invalid value: the kv-store keeps text only');
  };
  return {
    rows,
    async getItem(key) {
      return rows.get(key) ?? null;
    },
    async setItem(key, value) {
      check(key, value);
      rows.set(key, value);
    },
    async multiSet(pairs) {
      for (const [key, value] of pairs) check(key, value);
      for (const [key, value] of pairs) rows.set(key, value);
    },
  };
}

const PORTS: [string, () => StoragePort<DataState>][] = [
  ['memory', () => createMemoryPort({ now: () => FIXED_NOW })],
  ['kv (fake)', () => createKvStoragePort({ store: fakeSqliteKv(), now: () => FIXED_NOW, corruptFile: () => undefined })],
  [
    'copy-forward over kv (fake)',
    () =>
      createCopyForwardPort({
        kv: fakeSqliteKv(),
        legacy: { readAsyncStorage: async () => null },
        now: () => FIXED_NOW,
        corruptFile: () => undefined,
      }),
  ],
];

/** A v3 state as the ports name it (`DataState`, the same type: no cast). */
const live = (s: DataStateV3): DataState => s;

/** Every fixture, migrated to schema 3 (what the app holds after loading it). */
function migratedFixtures(): [string, DataStateV3][] {
  return STATE_FIXTURES.map((name) => {
    const out = migrate(stateFixture(name), FIXED_NOW);
    if (out.kind !== 'ok') throw new Error(`fixture ${name} did not migrate`);
    return [name, out.state];
  });
}

/** 50 seeded random valid v3 states. */
function randomStates(): DataStateV3[] {
  const rnd = createRandom('roundtrip-states');
  return Array.from({ length: 50 }, () => randomStateV3(rnd, { now: FIXED_NOW }));
}

/** Load and expect a document; return its value. */
async function loadValue(port: StoragePort<DataState>): Promise<unknown> {
  const loaded = await port.load();
  if (loaded.kind !== 'doc') throw new Error(`expected a document, got ${loaded.kind}`);
  return loaded.value;
}

/* ------------------------------------------------- load(save(state)) */

describe.each(PORTS)('load(save(state)) through the %s port', (_name, makePort) => {
  test('every real fixture, in v3', async () => {
    for (const [name, state] of migratedFixtures()) {
      expect({ name, problems: stateProblemsV3(state) }).toEqual({ name, problems: [] });
      const port = makePort();
      await port.save(live(state), null);
      const value = await loadValue(port);
      expect({ name, value }).toEqual({ name, value: state });
      // What the engine does next (decode): nothing to change, nothing to repair.
      const again = readDocument(value, FIXED_NOW);
      expect({ name, again }).toEqual({ name, again: { kind: 'ok', state, from: 3, repaired: [] } });
    }
  });

  test('50 seeded random v3 states (save, then replaceAll)', async () => {
    for (const state of randomStates()) {
      const port = makePort();
      await port.save(live(state), null);
      const value = (await loadValue(port)) as DataStateV3;
      expect(value).toEqual(state);
      expect(stateProblemsV3(value)).toEqual([]);

      const other = { ...state, onboarded: !state.onboarded };
      await port.replaceAll(live(other));
      expect(await loadValue(port)).toEqual(other);
    }
  });

  test('readRaw gives back exactly the saved text', async () => {
    const [state] = randomStates();
    const port = makePort();
    await port.save(live(state), null);
    expect(await port.readRaw()).toBe(JSON.stringify(state));
  });
});

/* ---------------------------------------- the engine, end to end, frozen */

let clock: TestClock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_NOW);
  clock = createClock(FIXED_NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy'];

/** The engine's state. */
const v3 = (engine: Engine): DataStateV3 => engine.store.getState();

/** A real CSV import plan for the engine's current state. */
function csvPlan(engine: Engine, step: number) {
  const collection = readCsv(`Baum ${step},tree\nHund ${step},dog`, `import-${step}.csv`);
  const types: ImportChoices['types'] = {};
  for (const mid of Object.keys(collection.models)) {
    types[mid] = { fields: positionalFieldDefs(collection.models[mid].flds.map((f) => f.name)), ords: [0] };
  }
  let n = 0;
  const state = v3(engine);
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
    { now: clock.now(), newId: () => `p${step}-${(n += 1)}`, srs: state.settings.srs, fieldFacetSpecs, detectOrdinal },
  );
}

/** One random action, like a user would do it. */
function randomAction(engine: Engine, rnd: Random, step: number, undoTokens: string[], editIds: string[]): void {
  const { actions } = engine;
  const state = v3(engine);
  const card = state.cards.length > 0 ? rnd.pick(state.cards) : null;
  const note = state.notes.length > 0 ? rnd.pick(state.notes) : null;
  const deck = state.decks.length > 0 ? rnd.pick(state.decks) : null;
  switch (rnd.int(0, 22)) {
    case 0:
    case 1:
    case 2:
      if (card) actions.rateCard(card.id, rnd.pick(RATINGS), { kind: rnd.bool(0.9) ? 'scheduled' : 'practice', durationMs: rnd.int(500, 9000) });
      break;
    case 3:
      actions.undoLastReview();
      break;
    case 4:
      if (card) actions.setFlags([card.id], { fav: rnd.bool(), flagged: rnd.bool() });
      break;
    case 5:
      if (card) actions.bury([card.id]);
      break;
    case 6:
      if (deck) actions.addNote({ deckId: deck.id, typeId: rnd.pick(['nt-basic', 'nt-basic-reverse', 'nt-cloze']), fields: [`{{c1::front}} ${step}`, `back ${step}`], tags: ['t'] });
      break;
    case 7:
      if (note) actions.editNote(note.id, { tags: [`edited-${step}`] });
      break;
    case 8:
      if (note && rnd.bool(0.3)) undoTokens.push(actions.deleteNotes([note.id]));
      else if (undoTokens.length > 0) actions.undoDelete(rnd.pick(undoTokens));
      break;
    case 9:
      actions.applyImport(csvPlan(engine, step));
      break;
    case 10:
      if (deck && state.decks.length > 1 && rnd.bool(0.3)) {
        const other = state.decks.find((d) => d.id !== deck.id)!;
        const strategy = rnd.pick([{ kind: 'keep' as const }, { kind: 'delete' as const }, { kind: 'move' as const, targetDeckId: other.id }]);
        actions.deleteDeck(deck.id, strategy);
      } else if (deck) {
        actions.updateDeck(deck.id, { active: rnd.bool(0.8), name: `${deck.name}!` });
      }
      break;
    case 11:
      actions.setGoals(rnd.int(0, 50), rnd.int(0, 20));
      actions.setLimits({ dailyNewLimit: rnd.int(0, 30), dailyReviewLimit: rnd.int(0, 300) });
      break;
    case 12:
      actions.updateAppSettings({ hapticsEnabled: rnd.bool(), sessionLimit: rnd.pick([20, 50, 100]) });
      actions.updateSrsSettings({ startingEase: rnd.pick([2.3, 2.5]) });
      break;
    case 13:
      actions.trackSession({
        kind: 'scheduled',
        label: 'Today',
        counts: { again: 0, hard: 0, good: step % 5, easy: 1 },
        total: (step % 5) + 1,
        bestRun: 1,
        durationSec: step,
        fastAnswers: 0,
        studyDay: clock.dayKey(),
      });
      break;
    case 14:
      actions.completeSession({
        kind: rnd.pick(['scheduled', 'practice'] as const),
        label: 'Today',
        counts: { again: 1, hard: 0, good: 2, easy: 0 },
        total: 3,
        bestRun: 2,
        durationSec: 40,
        fastAnswers: rnd.int(0, 2),
        studyDay: clock.dayKey(),
        finalCard: card ?? undefined,
        mode: rnd.pick(['flash', 'mix'] as const),
      });
      break;
    case 15:
      if (card) editIds.push(actions.markKnown([card.id]));
      break;
    case 16:
      if (card) editIds.push(actions.learn([card.id], { first: rnd.bool() }));
      break;
    case 17:
      if (card) editIds.push(actions.reschedule([card.id], clock.now() + rnd.int(1, 20) * 86_400_000));
      break;
    case 18:
      if (editIds.length > 0) actions.undoManualEdit(rnd.pick(editIds));
      break;
    case 19:
      if (card) editIds.push(actions.setFlags([card.id], { suspended: rnd.bool() }));
      break;
    case 20:
      actions.saveList({ name: `List ${step}`, icon: '🔖', query: { flags: ['fav'] } });
      if (rnd.bool()) actions.setListPref('builtin:hard', { pinned: rnd.bool() });
      break;
    case 21:
      if (deck) actions.setDeckOptions(deck.id, { newPerDay: rnd.bool() ? null : rnd.int(0, 20), newOrder: rnd.pick(['source', 'random'] as const) });
      break;
    default:
      actions.markOnboarded();
  }
}

describe('the engine, frozen: random v3 actions → flush → reboot gives the same state', () => {
  test('20 seeded runs of 40 actions each', async () => {
    const rnd = createRandom('roundtrip-engine');
    for (let run = 0; run < 20; run++) {
      const start = randomStateV3(rnd.fork(`state-${run}`), { now: clock.now() });
      const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify({ ...start, inProgressSession: null }) });
      const app = createEngine(createMemoryPort({ store: disk, now: clock.now }), { now: clock.now, freeze: true });
      await app.boot();
      const undoTokens: string[] = [];
      const editIds: string[] = [];
      for (let step = 0; step < 40; step++) {
        clock.advance(rnd.int(1, 90) * 60_000);
        randomAction(app, rnd, step, undoTokens, editIds);
        if (rnd.bool(0.2)) await jest.advanceTimersByTimeAsync(400); // some debounced saves land on the way
      }
      // A clean end: no session in flight (otherwise the reboot would bank it).
      app.actions.trackSession(null);
      await app.flush();
      const final = app.store.getState();
      expect({ run, problems: stateProblemsV3(v3(app)), empty: notesWithoutCards(v3(app)) }).toEqual({ run, problems: [], empty: [] });
      app.dispose();

      const reboot = createEngine(createMemoryPort({ store: disk, now: clock.now }), { now: clock.now, freeze: true });
      const boot = await reboot.boot();
      expect({ run, kind: boot.kind }).toEqual({ run, kind: 'loaded' });
      if (boot.kind === 'loaded') expect({ run, repaired: boot.repaired }).toEqual({ run, repaired: [] });
      expect(reboot.store.getState()).toEqual(final);
      expect(stateProblemsV3(JSON.parse(disk.snapshot()[KV_STATE_KEY]))).toEqual([]);
      reboot.dispose();
    }
  });
});
