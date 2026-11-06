/**
 * Integration tests of the engine (spec §3.9, §3.12, units W2-1 → W3-2): the
 * store, the v3 reducer, the PersistController and a storage port working
 * together, with jest's fake timers (the 400 ms debounce) and a test clock.
 *
 * The "disk" is a memory store (storage/memoryPort.ts). It runs the same JSON
 * code as the kv port, and it survives the engine: to "kill and restart the
 * app", the test throws the engine away and boots a new one on the same disk.
 *
 *   kill(engine) = engine.dispose() WITHOUT flush(): the change that waits in
 *   the debounce is lost, exactly like an OS kill (no cleanup code runs).
 *
 * Every wave-2 scenario runs on the v3 note model (W3-2 acceptance "all
 * wave-2 integration tests pass on v3"):
 *   (1) boot → import (a real CSV plan through applyImport) → rate 3 → kill
 *       without flush → reboot banks once, silently;
 *   (2) a third boot still banks it once;
 *   (3) a kill between the debounced saves of rating 2 and 3 → the reboot banks
 *       exactly what was saved;
 *   (4) a read failure → ratings stay in memory only, nothing is saved (C1);
 *   (5) too-new → nothing is saved.
 * Plus: M5 atomic payout, practice writes nothing (H3), M15, M16, restore and
 * factory reset, the load rules (pre-migration copy v0/v1/v2 → v3, corrupt
 * copy, blocked boots), dispose → resume, boot errors, devFreeze, flush()
 * results and the restore flow, the storage-port wiring (Android rescue), the
 * raw-data rescue.
 *
 * W3-2 adds: applyImport = one write; deleteNotes undo tokens (in memory
 * only); the deck image folders (a copy at once — also the images of kept or
 * moved cards — and a removal only AFTER the save commits, retried after a
 * failed save); a review-log seq is never given twice; manual edits return
 * their id for Undo; an old backup restores through readBackup (migrate)
 * as schema 3; the dev timings (perfMarks.ts).
 *
 * W4-7 adds: "Move to deck…" (moveNotes) copies the images the moved cards
 * show into the new deck's folder AFTER the move commits (retried after a
 * failed save, before any waiting removal); a rating with a broken undo
 * snapshot keeps its history row on the first copy and on a Restore.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { detectOrdinal, fieldFacetSpecs } from '../domain/facets';
import { readCsv } from '../domain/import/csvRead';
import { planImport, positionalFieldDefs } from '../domain/import/plan';
import type { DataStateV3, Id, ImportChoices, ImportPlan, InProgressSession } from '../domain/model';
import { buildSeedState } from '../domain/seed';
import type { DataState } from '../domain/types';
import { createClock, localTime, type TestClock } from '../test/clock';
import { makeCard, makeDeck, makeState, stateFixture, stateFixtureRaw, type StateFixtureName } from '../test/factories';
import { lifeValues, makeDeckV3, makeStateV3, noteWithCards, stateOfV3, stateProblemsV3 } from '../test/factoriesV3';
import {
  type BackupIO,
  keptHistoryCount,
  performRestore,
  RESTORE_COPY,
  readBackup,
  restoreResultMessage,
  type RestoreSteps,
  restoreSummary,
} from './backup';
import { UNFILED_DECK_ID } from './deckOps';
import {
  type ActionsMatchSpec,
  createEngine,
  type DeckMedia,
  DELETE_TOKENS_KEPT,
  type Engine,
  type EngineOptions,
  imagesToCopy,
  readDocument,
  sameJson,
} from './engine';
import { createPerfMarks, formatPerfLine, PERF_MARKS_ON, perfMarks } from './perfMarks';
import { SAVE_DEBOUNCE_MS } from './persistController';
import { rescueMessage } from './problemCopy';
import { RESCUE_NOTHING_FOUND_LINE, rescueReportMessage, rescueReportWith, type RescueIO } from './rescueExport';
import { cachedPerState } from './selectors';
import {
  buildStoragePort,
  createMemoryPort,
  createMemoryRowDb,
  createMemoryStore,
  createRowPort,
  decodedState,
  KV_COPIED_FROM_KEY,
  KV_CORRUPT_PREFIX,
  KV_STATE_KEY,
  type KeyValueStore,
  type MemoryRowDb,
  type MemoryStore,
  type StoragePortDeps,
} from './storage';
import type { StoragePort } from './storagePort';

// storage/index.ts imports the AsyncStorage port, so jest needs the
// library's in-memory mock. These tests never use the real AsyncStorage:
// every native piece is injected.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

/* ---------------------------------------------------------------- helpers */

const T0 = localTime('2026-07-08', '09:00');
const DAY = '2026-07-08';

let clock: TestClock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  clock = createClock(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

/** The engine options of every test: the test clock, frozen states, no real files. */
function engineOptions(extra: EngineOptions = {}): EngineOptions {
  return { now: clock.now, freeze: true, preservePremigrate: () => undefined, ...extra };
}

/** Start the app on `disk`: a new engine on a new port, booted. */
async function startApp(disk: MemoryStore, extra: EngineOptions = {}): Promise<Engine> {
  const engine = createEngine(createMemoryPort({ store: disk, now: clock.now }), engineOptions(extra));
  await engine.boot();
  return engine;
}

/** An OS kill: no flush, no cleanup. The change waiting in the debounce is lost. */
const kill = (engine: Engine) => engine.dispose();

/** Let `ms` pass: fires the debounced save and waits for the write. */
async function pass(ms: number) {
  clock.advance(ms);
  await jest.advanceTimersByTimeAsync(ms);
}

/** The engine's state. (`DataState` and `DataStateV3` are two names of one type: no cast.) */
const v3 = (engine: Engine): DataStateV3 => engine.store.getState();

/** A v3 state as backup.ts and the ports name it (`DataState`, the same type). */
const live = (s: DataStateV3): DataState => s;

/** The document on the disk, parsed. */
function onDisk(disk: MemoryStore): DataStateV3 {
  const text = disk.snapshot()[KV_STATE_KEY];
  if (text === undefined) throw new Error('nothing saved');
  return JSON.parse(text) as DataStateV3;
}

/** A v3 tally of the test day. */
const dayDone = (o: Partial<DataStateV3['person']['dayDone']> = {}) => ({
  dayKey: DAY,
  reviews: 0,
  neww: 0,
  checks: 0,
  newByDeck: {},
  ...o,
});

/** A saved v3 library: one deck with two notes (one of them Basic + reverse). */
function savedLibrary(): DataStateV3 {
  return stateOfV3({
    decks: [makeDeckV3({ id: 'd1', name: 'Capitals' })],
    groups: [
      noteWithCards({ deckId: 'd1', typeId: 'nt-basic-reverse', note: { id: 'n1' }, card: (ord) => ({ id: `c1-${ord}` }) }),
      noteWithCards({ deckId: 'd1', note: { id: 'n2' }, card: { id: 'c2', ...lifeValues('review', T0) } }),
    ],
    overrides: { onboarded: true },
  });
}

/** An in-flight marker. */
function marker(o: Partial<InProgressSession> = {}): InProgressSession {
  return {
    kind: 'scheduled',
    label: 'Today',
    counts: { again: 0, hard: 0, good: 2, easy: 0 },
    total: 2,
    bestRun: 2,
    durationSec: 20,
    fastAnswers: 0,
    studyDay: DAY,
    ...o,
  };
}

const CAPITALS = 'France,Paris\nJapan,Tokyo\nCanada,Ottawa\nKenya,Nairobi\nPeru,Lima';

/** A real import plan (csvRead + planImport) of a CSV (default: Capitals), for the engine's current state. */
function capitalsPlan(engine: Engine, text = CAPITALS): ImportPlan {
  const collection = readCsv(text, 'capitals.csv');
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
      target: { kind: 'new', name: 'Capitals', icon: '🌍' },
      types,
      progress: 'keep',
      arrival: 'queued',
      elsewhere: 'update',
      images: true,
    },
    { now: clock.now(), newId: () => `imp-${clock.now()}-${(n += 1)}`, srs: state.settings.srs, fieldFacetSpecs, detectOrdinal },
  );
}

/** Import the Capitals deck through applyImport; returns its card ids in file order. */
function importCapitals(engine: Engine): string[] {
  const result = engine.actions.applyImport(capitalsPlan(engine));
  return v3(engine)
    .cards.filter((c) => c.deckId === result.deckId)
    .map((c) => c.id);
}

/**
 * One rating in a session, as session.tsx does it: rate the card, then save
 * the in-flight marker (M5) with the counts so far.
 */
function rateInSession(engine: Engine, cardId: string, n: number) {
  const rated = engine.actions.rateCard(cardId, 'good', { kind: 'scheduled' });
  engine.actions.trackSession(marker({ counts: { again: 0, hard: 0, good: n, easy: 0 }, total: n, bestRun: n, durationSec: 8 * n }));
  return rated;
}

// This alias compiles only when useData().actions offers every §3.6 action
// with an assignable type (engine.ts).
const actionsMatchSpec: ActionsMatchSpec = true;

/* ------------------------------------------------------------------- boot */

describe('boot', () => {
  test('first boot: the v3 seed, ready, no problem; the seed is saved after the debounce', async () => {
    expect(actionsMatchSpec).toBe(true);
    const disk = createMemoryStore();
    const app = await startApp(disk);
    expect(app.meta.getState()).toEqual({ ready: true, persistError: null, lastCompletion: null });
    expect(app.status).toBe('ready');
    expect(v3(app)).toEqual(buildSeedState(T0));
    expect(disk.writes).toBe(0);
    await pass(SAVE_DEBOUNCE_MS);
    expect(onDisk(disk)).toEqual(app.store.getState());
    expect(onDisk(disk).schemaVersion).toBe(3);
  });

  test('a saved v3 document loads; an unchanged load writes nothing by itself', async () => {
    const saved = savedLibrary();
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(saved) });
    const app = await startApp(disk);
    expect(v3(app)).toEqual(saved);
    await pass(10 * SAVE_DEBOUNCE_MS);
    await app.flush();
    expect(disk.writes).toBe(0); // the disk already holds exactly this state
  });

  test('an older schema: the raw text is kept once (pre-migration copy), then the v3 state is saved', async () => {
    const raw = stateFixtureRaw('v1-main-1333d48');
    const disk = createMemoryStore({ [KV_STATE_KEY]: raw });
    const copies: [string, number, number][] = [];
    const app = await startApp(disk, { preservePremigrate: (text, from, to) => void copies.push([text, from, to]) });
    expect(copies).toEqual([[raw, 1, 3]]);
    expect(v3(app).schemaVersion).toBe(3);
    expect(stateProblemsV3(v3(app))).toEqual([]);
    await pass(SAVE_DEBOUNCE_MS);
    expect(onDisk(disk).schemaVersion).toBe(3); // written in the v3 form
    expect(onDisk(disk).notes.length).toBe(onDisk(disk).cards.length); // one note per migrated card
  });

  test('a v2.0.2 document with a killed session: migrated to v3, and the session banked once, silently', async () => {
    const disk = createMemoryStore({ [KV_STATE_KEY]: stateFixtureRaw('v0-v2.0.2') });
    const sessionsBefore = (stateFixture('v0-v2.0.2').sessions as unknown[]).length;
    const app = await startApp(disk);
    const state = v3(app);
    expect(state.sessions).toHaveLength(sessionsBefore + 1);
    expect(state.inProgressSession).toBeNull();
    expect(app.meta.getState().lastCompletion).toBeNull();
    // The v2.0.2 cards got their Level and Type back as note fields.
    expect(state.noteTypes.some((t) => t.fields.some((f) => f.name === 'Level'))).toBe(true);
  });

  test('a failed pre-migration copy does not stop the (lossless) load', async () => {
    const disk = createMemoryStore({ [KV_STATE_KEY]: stateFixtureRaw('v0-german-fork') });
    const app = await startApp(disk, {
      preservePremigrate: () => {
        throw new Error('disk full');
      },
    });
    expect(app.meta.getState().persistError).toBeNull();
    expect(v3(app).schemaVersion).toBe(3);
  });

  test('migrate() throws → blocked "migrate": nothing is written, the text stays as it was', async () => {
    const raw = stateFixtureRaw('v1-main-1333d48');
    const disk = createMemoryStore({ [KV_STATE_KEY]: raw });
    const app = await startApp(disk, {
      migrateFn: () => {
        throw new Error('bug in a migration step');
      },
    });
    expect(app.meta.getState()).toMatchObject({ ready: true, persistError: 'migrate' });
    expect(app.status).toBe('read-blocked');
    app.actions.markOnboarded();
    await pass(10 * SAVE_DEBOUNCE_MS);
    await app.flush();
    expect(disk.writes).toBe(0);
    expect(disk.snapshot()[KV_STATE_KEY]).toBe(raw);
  });

  test('boot() twice gets the same result; actions before ready are not saved and the loaded state wins', async () => {
    const saved = savedLibrary();
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(saved) });
    const app = createEngine(createMemoryPort({ store: disk, now: clock.now }), engineOptions());
    app.actions.setGoals(1, 1); // before ready: on the seed, never saved
    const first = app.boot();
    expect(app.boot()).toBe(first);
    await first;
    expect(v3(app).person.goalReviews).toBe(saved.person.goalReviews);
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(0);
  });
});

/* ------------------------------- the load rules, on the live boot path */

describe('the load rules, through the engine', () => {
  /** Every safety copy a boot makes: pre-migration copies and corrupt copies. */
  interface Copies {
    premigrate: [string, number, number][];
    corrupt: string[];
  }

  /**
   * Boot a new engine on a disk that holds `raw` (null = nothing stored).
   * `port` may replace methods of the memory port (a failing read or copy).
   */
  async function bootOn(
    raw: string | null,
    extra: EngineOptions = {},
    port: (memory: StoragePort<DataState>) => Partial<StoragePort<DataState>> = () => ({}),
  ) {
    const disk = createMemoryStore(raw === null ? {} : { [KV_STATE_KEY]: raw });
    const copies: Copies = { premigrate: [], corrupt: [] };
    const memory = createMemoryPort({ store: disk, now: clock.now });
    const recording: StoragePort<DataState> = {
      ...memory,
      preserveCorrupt: (text) => {
        copies.corrupt.push(text);
        return memory.preserveCorrupt(text);
      },
    };
    const app = createEngine(
      { ...recording, ...port(recording) },
      engineOptions({ preservePremigrate: (text, from, to) => void copies.premigrate.push([text, from, to]), ...extra }),
    );
    const boot = await app.boot();
    return { app, boot, disk, copies };
  }

  const NO_COPIES: Copies = { premigrate: [], corrupt: [] };
  const corruptKeys = (disk: MemoryStore) => Object.keys(disk.snapshot()).filter((key) => key.startsWith(KV_CORRUPT_PREFIX));

  test('a read failure → blocked "read", and no copy of anything (C1)', async () => {
    const { boot, disk, copies } = await bootOn(JSON.stringify(savedLibrary()), {}, () => ({
      load: () => Promise.reject(new Error('CursorWindow')),
    }));
    expect(boot).toMatchObject({ kind: 'blocked', reason: 'read' });
    expect(copies).toEqual(NO_COPIES);
    expect(disk.writes).toBe(0);
  });

  test('nothing stored → the seed, no copies', async () => {
    const { app, boot, copies } = await bootOn(null);
    expect(boot.kind).toBe('first-boot');
    expect(v3(app).cards).toEqual([]);
    expect(copies).toEqual(NO_COPIES);
  });

  test('a corrupt text is copied once, THEN the seed is used (and saved over it)', async () => {
    const raw = '{"cards":[1,';
    const { app, boot, disk, copies } = await bootOn(raw);
    expect(boot.kind).toBe('corrupt');
    expect(copies).toEqual({ premigrate: [], corrupt: [raw] });
    expect(corruptKeys(disk).map((key) => disk.snapshot()[key])).toEqual([raw]);
    expect(app.meta.getState().persistError).toBeNull();
    await pass(SAVE_DEBOUNCE_MS);
    expect(onDisk(disk)).toEqual(app.store.getState()); // the next boot finds the seed, not the text
  });

  test('a corrupt text that could not be copied anywhere blocks writes instead of being replaced', async () => {
    const raw = '{"cards":';
    const { app, boot, disk } = await bootOn(raw, {}, () => ({
      preserveCorrupt: () => Promise.reject(new Error('disk full')),
    }));
    expect(boot).toMatchObject({ kind: 'blocked', reason: 'read' });
    app.actions.markOnboarded();
    await pass(10 * SAVE_DEBOUNCE_MS);
    await app.flush();
    expect(disk.writes).toBe(0);
    expect(disk.snapshot()[KV_STATE_KEY]).toBe(raw);
  });

  const jumps: [StateFixtureName, number][] = [
    ['v0-v2.0.2', 0],
    ['v0-german-fork', 0],
    ['v1-main-1333d48', 1],
  ];
  test.each(jumps)('%s → loaded, and its raw text is kept once as the v%i → v3 copy', async (name, from) => {
    const raw = stateFixtureRaw(name);
    const { boot, copies } = await bootOn(raw);
    expect(boot.kind).toBe('loaded');
    expect(copies).toEqual({ premigrate: [[raw, from, 3]], corrupt: [] });
  });

  test('a schema-2 document is a version jump now: one v2 → v3 copy', async () => {
    const raw = JSON.stringify(makeState({ onboarded: true }, T0));
    const { boot, copies } = await bootOn(raw);
    expect(boot.kind).toBe('loaded');
    expect(copies).toEqual({ premigrate: [[raw, 2, 3]], corrupt: [] });
  });

  test('a schema-3 document needs no version jump, so no copy', async () => {
    const { boot, copies } = await bootOn(JSON.stringify(savedLibrary()));
    expect(boot.kind).toBe('loaded');
    expect(copies).toEqual(NO_COPIES);
  });

  test('too-new and a throwing migrate block writes and keep no copy of anything', async () => {
    const tooNew = await bootOn(JSON.stringify({ schemaVersion: 9, minReaderVersion: 9 }));
    expect(tooNew.boot).toMatchObject({ kind: 'blocked', reason: 'too-new' });
    expect(tooNew.copies).toEqual(NO_COPIES);

    const bug = await bootOn(stateFixtureRaw('v0-v2.0.2'), {
      migrateFn: () => {
        throw new Error('bug');
      },
    });
    expect(bug.boot).toMatchObject({ kind: 'blocked', reason: 'migrate' });
    expect(bug.copies).toEqual(NO_COPIES);
    expect(tooNew.disk.writes + bug.disk.writes).toBe(0);
  });

  test('readDocument: a damaged v3 document is repaired by checkIntegrity, and the repair is listed', () => {
    const doc = JSON.parse(JSON.stringify(savedLibrary())) as DataStateV3;
    doc.cards[0].deckId = 'gone';
    const out = readDocument(doc, T0);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.repaired.length).toBeGreaterThan(0);
    expect(stateProblemsV3(out.state)).toEqual([]);
  });
});

/* ------------------- what the load fills in is a change (review round 2) */

describe('a default that the load fills in counts as a change (prev of the first save)', () => {
  /** An engine on `disk` whose port records `prev` of every save. */
  function recordingApp(disk: MemoryStore) {
    const memory = createMemoryPort({ store: disk, now: clock.now });
    const prevs: (DataState | null)[] = [];
    const port: StoragePort<DataState> = {
      ...memory,
      save: (next, prev) => {
        prevs.push(prev);
        return memory.save(next, prev);
      },
    };
    return { app: createEngine(port, engineOptions()), prevs };
  }

  /** The parts of a stored document the cases below edit. */
  interface Doc {
    settings: Record<string, unknown> & { srs: Record<string, unknown> };
    person: Record<string, unknown>;
    [key: string]: unknown;
  }

  /** A schema-2 document with one change made by `edit` (its load is a v2 → v3 jump). */
  function docWith(edit: (doc: Doc) => void): string {
    const doc = JSON.parse(JSON.stringify(makeState({ onboarded: true }, T0))) as Doc;
    edit(doc);
    return JSON.stringify(doc);
  }

  const cases: [string, (doc: Doc) => void, (state: DataStateV3) => void, string[]][] = [
    [
      'a settings key is missing',
      (doc) => void delete doc.settings.hapticsEnabled,
      (state) => expect(state.settings.hapticsEnabled).toBe(true),
      [],
    ],
    [
      'a number is null (how a NaN was saved)',
      (doc) => void (doc.settings.srs.dailyNewLimit = null),
      (state) => expect(state.settings.srs.dailyNewLimit).toBe(10),
      ['settings.srs: dailyNewLimit null → 10'],
    ],
    [
      'a person number is missing',
      (doc) => void delete doc.person.freezes,
      (state) => expect(state.person.freezes).toBe(makeState().person.freezes),
      [],
    ],
    [
      '"onboarded" is missing (it is derived from the cards)',
      (doc) => void delete doc.onboarded,
      (state) => expect(state.onboarded).toBe(false),
      [],
    ],
  ];

  test.each(cases)('%s → the first save has prev null, and the filled value reaches the disk', async (_name, edit, check, repaired) => {
    const disk = createMemoryStore({ [KV_STATE_KEY]: docWith(edit) });
    const first = recordingApp(disk);
    expect(await first.app.boot()).toMatchObject({ kind: 'loaded', repaired }); // exactly these repair lines
    check(v3(first.app));
    await pass(SAVE_DEBOUNCE_MS);
    expect(first.prevs).toEqual([null]); // the disk did not hold this state: write everything
    expect(onDisk(disk)).toEqual(first.app.store.getState());
    check(onDisk(disk));
    first.app.dispose();

    // The next boot finds the v3 form: no write by itself, and prev is the loaded state.
    const writes = disk.writes;
    const second = recordingApp(disk);
    await second.app.boot();
    const loaded = second.app.store.getState();
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(writes);
    second.app.actions.setGoals(3, 3);
    await pass(SAVE_DEBOUNCE_MS);
    expect(second.prevs).toHaveLength(1);
    expect(second.prevs[0]).toBe(loaded); // a row port writes only what changed
  });

  test('sameJson: the same JSON data in any key order; undefined = missing; null is not a number', () => {
    expect(sameJson({ a: 1, b: [2, { c: 'x' }] }, { b: [2, { c: 'x' }], a: 1 })).toBe(true);
    expect(sameJson({ x: undefined, a: 1 }, { a: 1 })).toBe(true);
    expect(sameJson({ limit: 20 }, { limit: null })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson([1], { 0: 1 })).toBe(false);
    expect(sameJson({ list: [] }, { list: null })).toBe(false);
    expect(sameJson('2', 2)).toBe(false);
  });

  test('the same data in another key order is NOT a change: nothing is written, prev is the loaded state', async () => {
    /** The same JSON data with every object's keys in reverse order. */
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed);
      if (typeof value !== 'object' || value === null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, inner]) => [key, reversed(inner)]),
      );
    };
    const saved = savedLibrary();
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(reversed(saved)) });
    const { app, prevs } = recordingApp(disk);
    await app.boot();
    const loaded = app.store.getState();
    expect(loaded).toEqual(saved);
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(0);
    app.actions.markOnboarded();
    app.actions.setGoals(4, 4);
    await pass(SAVE_DEBOUNCE_MS);
    expect(prevs).toHaveLength(1);
    expect(prevs[0]).toBe(loaded);
  });
});

/* ------------------------------------------------- M5: kill and reboot */

describe('kill and reboot banks the session once, silently (M5)', () => {
  test('(1) boot → import → rate 3 → kill without flush → the reboot banks it once', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    const ids = importCapitals(app);
    expect(ids).toHaveLength(5);
    for (let i = 0; i < 3; i++) {
      await pass(5_000);
      rateInSession(app, ids[i], i + 1);
    }
    await pass(SAVE_DEBOUNCE_MS); // the 3rd rating and its marker reach the disk
    kill(app); // no completeSession, no flush

    const before = onDisk(disk);
    expect(before.sessions).toHaveLength(0);
    expect(before.inProgressSession).toMatchObject({ total: 3, studyDay: DAY });

    await pass(60_000);
    const reboot = await startApp(disk);
    const state = v3(reboot);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ dayKey: DAY, total: 3, kind: 'scheduled', scopeLabel: 'Today' });
    expect(state.inProgressSession).toBeNull();
    expect(state.person.xp).toBe(state.sessions[0].xp);
    expect(state.person.xp).toBeGreaterThan(0);
    expect(state.person.streak).toBe(1);
    expect(state.person.lastStudyDay).toBe(DAY);
    // The three ratings were saved one by one: 3 new cards used the new budget of their deck (M3).
    const deckId = state.cards.find((c) => c.id === ids[0])?.deckId as Id;
    expect(state.person.dayDone).toEqual(dayDone({ neww: 3, newByDeck: { [deckId]: 3 } }));
    // Silent: no Complete screen for a session the user did not just finish.
    expect(reboot.meta.getState().lastCompletion).toBeNull();
  });

  test('(2) the third boot banks nothing more — saved or not saved after the reconcile', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    const ids = importCapitals(app);
    for (let i = 0; i < 3; i++) rateInSession(app, ids[i], i + 1);
    await pass(SAVE_DEBOUNCE_MS);
    kill(app);

    // Second run: killed BEFORE its reconcile was saved. The disk still holds the marker.
    const second = await startApp(disk);
    expect(v3(second).sessions).toHaveLength(1);
    kill(second);
    expect(onDisk(disk).inProgressSession).not.toBeNull();

    // Third run: banks it (still once in total), and this time the save lands.
    const third = await startApp(disk);
    const banked = v3(third);
    expect(banked.sessions).toHaveLength(1);
    await pass(SAVE_DEBOUNCE_MS);
    kill(third);
    expect(onDisk(disk).sessions).toHaveLength(1);
    expect(onDisk(disk).inProgressSession).toBeNull();

    // Fourth run: nothing to bank; XP and streak are unchanged.
    const fourth = await startApp(disk);
    const state = v3(fourth);
    expect(state.sessions).toHaveLength(1);
    expect(state.person.xp).toBe(banked.person.xp);
    expect(state.person.streak).toBe(banked.person.streak);
    expect(fourth.meta.getState().lastCompletion).toBeNull();
  });

  test('(3) kill between the debounced saves of rating 2 and 3 → banks exactly what was saved', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    const ids = importCapitals(app);
    rateInSession(app, ids[0], 1);
    await pass(300);
    rateInSession(app, ids[1], 2);
    await pass(SAVE_DEBOUNCE_MS); // ratings 1 and 2 (and the marker "2") are saved
    rateInSession(app, ids[2], 3);
    await pass(300); // rating 3 still waits in the debounce …
    kill(app); // … and is lost

    const reboot = await startApp(disk);
    const state = v3(reboot);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].total).toBe(2);
    const deckId = state.cards.find((c) => c.id === ids[0])?.deckId as Id;
    expect(state.person.dayDone).toEqual(dayDone({ neww: 2, newByDeck: { [deckId]: 2 } }));
    const reps = ids.slice(0, 3).map((id) => state.cards.find((c) => c.id === id)?.reps);
    expect(reps).toEqual([1, 1, 0]); // the card of the lost rating is still new
    expect(state.reviewLog.map((e) => e.seq)).toEqual([1, 2]);
  });
});

/* ------------------------------------------- blocked boots write nothing */

describe('a blocked boot never writes (C1)', () => {
  test('(4) read failure → ratings in memory only, nothing saved', async () => {
    const saved = savedLibrary();
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(saved) });
    const port: StoragePort<DataState> = {
      ...createMemoryPort({ store: disk, now: clock.now }),
      load: () => Promise.reject(new Error('Row too big to fit into CursorWindow')),
    };
    const app = createEngine(port, engineOptions());
    const boot = await app.boot();
    expect(boot).toMatchObject({ kind: 'blocked', reason: 'read' });
    expect(app.meta.getState()).toMatchObject({ ready: true, persistError: 'read' });

    // The app still works in memory …
    const ids = importCapitals(app);
    for (let i = 0; i < 3; i++) rateInSession(app, ids[i], i + 1);
    expect(v3(app).cards.filter((c) => c.reps > 0)).toHaveLength(3);
    // … but nothing reaches the disk: not the debounce, not a flush, not a kill.
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(await app.flush()).toEqual({ ok: false, reason: 'blocked' });
    app.dispose();
    expect(disk.writes).toBe(0);
    expect(disk.snapshot()).toEqual({ [KV_STATE_KEY]: JSON.stringify(saved) });
  });

  test('(5) too-new → nothing saved, the newer document stays as it was', async () => {
    const raw = JSON.stringify({ schemaVersion: 9, minReaderVersion: 9, notes: [{ id: 'n1' }] });
    const disk = createMemoryStore({ [KV_STATE_KEY]: raw });
    const app = await startApp(disk);
    expect(app.meta.getState().persistError).toBe('too-new');
    importCapitals(app);
    app.actions.updateAppSettings({ hapticsEnabled: false });
    await pass(10 * SAVE_DEBOUNCE_MS);
    await app.flush();
    expect(disk.writes).toBe(0);
    expect(disk.snapshot()[KV_STATE_KEY]).toBe(raw);
  });

  test('"Try again" on the same engine: a second boot after a failed read loads and reconciles', async () => {
    const saved = { ...savedLibrary(), inProgressSession: marker() };
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(saved) });
    const memory = createMemoryPort({ store: disk, now: clock.now });
    let fail = true;
    const port: StoragePort<DataState> = {
      ...memory,
      load: () => (fail ? Promise.reject(new Error('busy')) : memory.load()),
    };
    const app = createEngine(port, engineOptions());
    expect((await app.boot()).kind).toBe('blocked');
    fail = false;
    expect((await app.boot()).kind).toBe('loaded');
    expect(app.meta.getState().persistError).toBeNull();
    expect(v3(app).cards).toEqual(saved.cards);
    expect(v3(app).sessions).toHaveLength(1); // the marker was banked
    expect(v3(app).inProgressSession).toBeNull();
  });
});

/* ---------------------------------------------------------------- actions */

describe('actions on the newest state', () => {
  test('getState() is current at once: rateCard returns the rated card and the store already has it', async () => {
    const app = await startApp(createMemoryStore());
    const [id] = importCapitals(app);
    const rated = app.actions.rateCard(id, 'good');
    expect(rated).not.toBeNull();
    expect(v3(app).cards.find((c) => c.id === id)).toBe(rated);
    expect(app.actions.rateCard('no-such-card', 'good')).toBeNull();
  });

  test('applyImport is ONE reducer step: one store update, one write', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    await app.flush();
    const writes = disk.writes;
    let updates = 0;
    const stop = app.store.subscribe(() => {
      updates += 1;
    });
    const result = app.actions.applyImport(capitalsPlan(app));
    stop();
    expect(updates).toBe(1);
    expect(result).toMatchObject({ deckCreated: true, notesAdded: 5, cardsAdded: 5 });
    await pass(SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(writes + 1);
    expect(onDisk(disk).cards).toHaveLength(5);
  });

  test('completeSession: payout and marker clear reach the disk in ONE write (M5); the payout is shown', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    const ids = importCapitals(app);
    rateInSession(app, ids[0], 1);
    const final = app.actions.rateCard(ids[1], 'good') ?? undefined;
    await app.flush();
    const writes = disk.writes;

    const payout = app.actions.completeSession({
      kind: 'scheduled',
      label: 'Today',
      counts: { again: 0, hard: 0, good: 2, easy: 0 },
      total: 2,
      bestRun: 2,
      durationSec: 20,
      fastAnswers: 0,
      studyDay: DAY,
      finalCard: final,
      mode: 'flash',
    });
    expect(app.meta.getState().lastCompletion).toBe(payout);
    await app.flush();
    expect(disk.writes).toBe(writes + 1);
    const saved = onDisk(disk);
    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0]).toMatchObject({ mode: 'flash', scopeLabel: 'Today' });
    expect(saved.inProgressSession).toBeNull();
    expect(saved.person.xp).toBe(payout.xpTotal);

    app.actions.clearLastCompletion();
    expect(app.meta.getState().lastCompletion).toBeNull();
  });

  test.each([
    ["kind 'practice'", { kind: 'practice' as const }],
    ["the legacy kind 'cram'", { kind: 'cram' as const }],
  ])('practice (%s) changes nothing, so nothing is saved (H3)', async (_name, opts) => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    const [id] = importCapitals(app);
    await app.flush();
    const writes = disk.writes;
    const before = app.store.getState();
    app.actions.rateCard(id, 'again', opts);
    expect(app.store.getState()).toBe(before);
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(writes);
  });

  test('rate → save → undo → rate: the new rating gets a NEW seq (the revlog row key), also after a restart', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    const [a, b, c] = importCapitals(app);
    app.actions.rateCard(a, 'good');
    await app.flush();
    const seqA = onDisk(disk).reviewLog[0].seq;
    // Undo and rate again inside the debounce: no save comes between them.
    app.actions.undoLastReview();
    app.actions.rateCard(b, 'good');
    await app.flush();
    const saved = onDisk(disk).reviewLog;
    expect(saved.map((e) => e.cardId)).toEqual([b]);
    expect(saved[0].seq).toBeGreaterThan(seqA); // a save can tell B from A by its seq
    // A new engine on the same disk counts on from the saved log.
    kill(app);
    const again = await startApp(disk);
    again.actions.undoLastReview();
    again.actions.rateCard(c, 'good');
    expect(v3(again).reviewLog.map((e) => [e.cardId, e.seq])).toEqual([[c, saved[0].seq + 1]]);
  });

  test('a manual edit returns its id; undoManualEdit takes it back; the session undo still pops the rating', async () => {
    const app = await startApp(createMemoryStore());
    const [a, b] = importCapitals(app);
    app.actions.rateCard(a, 'good');
    const editId = app.actions.setFlags([b], { suspended: true });
    expect(v3(app).manualLog.map((e) => e.id)).toEqual([editId]);
    expect(app.actions.undoLastReview()).toBe(true);
    expect(v3(app).cards.find((c) => c.id === a)?.reps).toBe(0);
    expect(v3(app).cards.find((c) => c.id === b)?.suspended).toBe(true); // the session undo leaves the edit
    expect(app.actions.undoManualEdit(editId)).toEqual({ reverted: 1, skipped: 0 });
    expect(v3(app).cards.find((c) => c.id === b)?.suspended).toBe(false);
  });

  test('deleteNotes gives an in-memory undo token: undoDelete puts the notes back once; the token is never saved', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    const ids = importCapitals(app);
    const noteId = v3(app).cards.find((c) => c.id === ids[0])?.noteId as Id;
    const token = app.actions.deleteNotes([noteId]);
    expect(v3(app).cards.some((c) => c.id === ids[0])).toBe(false);
    await app.flush();
    expect(disk.snapshot()[KV_STATE_KEY]).not.toContain(token);
    expect(app.actions.undoDelete(token)).toBe(true);
    expect(v3(app).cards.some((c) => c.id === ids[0])).toBe(true);
    expect(app.actions.undoDelete(token)).toBe(false);
    expect(app.actions.undoDelete('no-such-token')).toBe(false);
  });

  test(`only the newest ${DELETE_TOKENS_KEPT} delete tokens are kept; a restore forgets them all`, async () => {
    const app = await startApp(createMemoryStore());
    // (Not "word,meaning": the reader would take that first row for a header.)
    const rows = Array.from({ length: DELETE_TOKENS_KEPT + 2 }, (_, i) => `Haus ${i},house ${i}`).join('\n');
    const deckId = app.actions.applyImport(capitalsPlan(app, rows)).deckId as Id;
    const notes = [...new Set(v3(app).cards.filter((c) => c.deckId === deckId).map((c) => c.noteId))];
    expect(notes).toHaveLength(DELETE_TOKENS_KEPT + 2);
    const tokens = notes.slice(0, DELETE_TOKENS_KEPT + 1).map((noteId) => app.actions.deleteNotes([noteId]));
    expect(new Set(tokens).size).toBe(DELETE_TOKENS_KEPT + 1);
    // The oldest of DELETE_TOKENS_KEPT + 1 tokens was pushed out; the second oldest still works.
    expect(app.actions.undoDelete(tokens[0])).toBe(false);
    expect(app.actions.undoDelete(tokens[1])).toBe(true);
    // A delete that removed nothing keeps no token.
    expect(app.actions.undoDelete(app.actions.deleteNotes(['no-such-note']))).toBe(false);
    // A restore forgets every token: the restored library is another library.
    const last = tokens[tokens.length - 1];
    app.actions.restore(v3(app));
    expect(app.actions.undoDelete(last)).toBe(false);
  });

  test('flush() saves the waiting change now, without the debounce (M16)', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    app.actions.setGoals(12, 4);
    await app.actions.flush();
    expect(onDisk(disk).person).toMatchObject({ goalReviews: 12, goalNew: 4 });
  });

  test('a failed save shows "write"; the next good save clears it (M15)', async () => {
    const disk = createMemoryStore();
    const memory = createMemoryPort({ store: disk, now: clock.now });
    let failSaves = true;
    const port: StoragePort<DataState> = {
      ...memory,
      save: (next, prev) => (failSaves ? Promise.reject(new Error('disk full')) : memory.save(next, prev)),
    };
    const app = createEngine(port, engineOptions());
    await app.boot();
    app.actions.markOnboarded();
    await app.flush();
    expect(app.meta.getState().persistError).toBe('write');
    failSaves = false;
    await app.flush(); // the failed state is tried again, even without a new change
    expect(app.meta.getState().persistError).toBeNull();
    expect(onDisk(disk).onboarded).toBe(true);
  });

  test('restore after a read failure: unblocks, replaces everything and saves at once', async () => {
    const disk = createMemoryStore({ [KV_STATE_KEY]: '{"kept":"until the user restores"}' });
    const memory = createMemoryPort({ store: disk, now: clock.now });
    const port: StoragePort<DataState> = { ...memory, load: () => Promise.reject(new Error('read failed')) };
    const app = createEngine(port, engineOptions());
    await app.boot();
    expect(app.meta.getState().persistError).toBe('read');

    const backup = savedLibrary();
    app.actions.restore(backup);
    expect(app.meta.getState().persistError).toBeNull();
    expect(v3(app)).toEqual(backup);
    await jest.advanceTimersByTimeAsync(0); // no debounce: only the write's promise
    expect(onDisk(disk)).toEqual(backup);
    expect(disk.writes).toBe(1);
  });

  test('an old (schema-2) backup restores as schema 3: readBackup runs migrate() before restore', async () => {
    const app = await startApp(createMemoryStore());
    const old = makeState({ onboarded: true, decks: [makeDeck({ id: 'd1' })], cards: [makeCard({ id: 'c1', deckId: 'd1' })] }, T0);
    const read = readBackup(JSON.stringify(old), clock.now());
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    app.actions.restore(read.state);
    const state = v3(app);
    expect(state.schemaVersion).toBe(3);
    expect(state.cards.map((c) => c.id)).toEqual(['c1']);
    expect(stateProblemsV3(state)).toEqual([]);
  });

  test('factory reset: the seed replaces everything in one write, and the payout is cleared', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    importCapitals(app);
    app.actions.completeSession({
      kind: 'scheduled',
      label: 'Today',
      counts: { again: 0, hard: 0, good: 1, easy: 0 },
      total: 1,
      bestRun: 1,
      durationSec: 5,
      fastAnswers: 0,
    });
    await app.flush();
    const writes = disk.writes;
    app.actions.factoryReset();
    expect(app.meta.getState().lastCompletion).toBeNull();
    expect(v3(app).cards).toEqual([]);
    expect(v3(app).notes).toEqual([]);
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(writes + 1);
    expect(onDisk(disk)).toEqual(app.store.getState());
  });

  test('after dispose() nothing is written; flush() then dispose() keeps the last change', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    app.actions.setGoals(7, 7);
    const lastSave = app.flush(); // what DataProvider's cleanup does …
    app.dispose(); // … without waiting
    await lastSave;
    expect(onDisk(disk).person.goalReviews).toBe(7);
    const writes = disk.writes;
    app.actions.setGoals(9, 9);
    await pass(10 * SAVE_DEBOUNCE_MS);
    await app.flush();
    expect(disk.writes).toBe(writes);
    await expect(app.boot()).rejects.toThrow('disposed');
  });

  test('states are frozen: changing the stored state in place fails (devFreeze)', async () => {
    const app = await startApp(createMemoryStore());
    const [id] = importCapitals(app);
    const state = v3(app);
    const card = state.cards.find((c) => c.id === id)!;
    // Array methods that change the array throw in every module.
    expect(() => (state.cards as unknown[]).sort()).toThrow(TypeError);
    expect(() => (state.cards as unknown[]).push(card)).toThrow(TypeError);
    expect(() => (state.notes[0].tags as string[]).push('x')).toThrow(TypeError);
    // A plain assignment throws in strict-mode code …
    expect(() => {
      'use strict';
      (card as { flagged: boolean }).flagged = true;
    }).toThrow(TypeError);
    // … AND in code without "use strict", like the app's own modules.
    expect(() => {
      (card as { flagged: boolean }).flagged = true;
    }).toThrow(TypeError);
    expect(() => {
      (state.person as { xp: number }).xp += 10;
    }).toThrow(TypeError);
    expect(v3(app).cards.find((c) => c.id === id)?.flagged).toBe(false);
    // The right way works: an action builds a new card.
    app.actions.setFlags([id], { flagged: true });
    expect(v3(app).cards.find((c) => c.id === id)?.flagged).toBe(true);
  });

  test('freezeGuards false (EXPO_PUBLIC_DEV_FREEZE_GUARDS=0): still frozen and saved the same, with plain reads', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk, { freezeGuards: false });
    const [id] = importCapitals(app);
    const state = v3(app);
    const card = state.cards.find((c) => c.id === id)!;
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(card, 'due')).toMatchObject({ value: card.due, writable: false });
    expect(() => (state.cards as unknown[]).sort()).toThrow(TypeError);
    expect(() => {
      'use strict';
      (card as { flagged: boolean }).flagged = true;
    }).toThrow(TypeError);
    // Without "use strict": ignored, never applied.
    (card as { flagged: boolean }).flagged = true;
    expect(v3(app).cards.find((c) => c.id === id)?.flagged).toBe(false);
    app.actions.setFlags([id], { flagged: true });
    await app.flush();
    expect(onDisk(disk)).toEqual(app.store.getState());
    expect(onDisk(disk).cards.find((c) => c.id === id)?.flagged).toBe(true);
  });

  test('the default (jest: guards on) reads through getters, so a plain assignment throws', async () => {
    const app = await startApp(createMemoryStore());
    const [id] = importCapitals(app);
    const card = v3(app).cards.find((c) => c.id === id)!;
    expect(Object.getOwnPropertyDescriptor(card, 'due')?.get).toBeDefined();
  });

  test('setFlags writes flag keys only, never the schedule — even a patch forced past the type', async () => {
    const app = await startApp(createMemoryStore());
    const [id] = importCapitals(app);
    const before = v3(app).cards.find((c) => c.id === id)!;
    app.actions.setFlags([id], { fav: true, ease: 9 } as never);
    const after = v3(app).cards.find((c) => c.id === id)!;
    expect(after.fav).toBe(true);
    expect(after.ease).toBe(before.ease);
  });

  test('setFlags: a key that is not a flag does not compile, and changes nothing', async () => {
    const app = await startApp(createMemoryStore());
    const [id] = importCapitals(app);
    const before = v3(app).cards.find((c) => c.id === id)!;
    // @ts-expect-error: `back` is not a card key at all (the text lives in the note).
    app.actions.setFlags([id], { back: 'changed' });
    // @ts-expect-error: `due` is a schedule key; only rateCard and undo write it.
    app.actions.setFlags([id], { flagged: true, due: 0 });
    const card: Partial<typeof before> = { suspended: true };
    // @ts-expect-error: a "patch anything" value (a Partial<Card>) is rejected too.
    app.actions.setFlags([id], card);
    const after = v3(app).cards.find((c) => c.id === id)!;
    expect(after).toEqual({ ...before, flagged: true, suspended: true });
  });
});

/* ------------------------------------------- deck image folders (W3-2) */

describe('deck image folders: a copy at once, a removal only AFTER the save commits', () => {
  /**
   * A fake src/platform/media.ts that records its calls. With `disk`, a
   * removal also records whether the deck was still in the saved document
   * (it must never be). `failCopy` makes every copy throw.
   */
  function fakeMedia(opts: { disk?: MemoryStore; failCopy?: boolean } = {}) {
    const calls: string[] = [];
    const media: DeckMedia = {
      removeDeckFolder: (deckId) => {
        const stillSaved = opts.disk ? onDisk(opts.disk).decks.some((d) => d.id === deckId) : false;
        calls.push(`remove ${deckId}${stillSaved ? ' (the deck is still saved!)' : ''}`);
      },
      // `names` only for a move (moveNotes): the images the moved cards show.
      copyDeckFolder: async (from, to, names) => {
        calls.push(`copy ${from} → ${to}${names ? `: ${names.join(', ')}` : ''}`);
        if (opts.failCopy) throw new Error('disk full');
      },
    };
    return { media, calls };
  }

  /** An engine on `disk` whose saves fail while `fail.saves` is true (M15). */
  async function appWithFailingSaves(disk: MemoryStore, media: DeckMedia) {
    const memory = createMemoryPort({ store: disk, now: clock.now });
    const fail = { saves: false };
    const app = createEngine(
      { ...memory, save: (next, prev) => (fail.saves ? Promise.reject(new Error('disk full')) : memory.save(next, prev)) },
      engineOptions({ media }),
    );
    await app.boot();
    return { app, fail };
  }

  /** The imported Capitals deck (5 cards), saved. */
  async function savedCapitals(app: Engine): Promise<Id> {
    const deckId = app.actions.applyImport(capitalsPlan(app)).deckId as Id;
    await app.flush();
    return deckId;
  }

  test('delete: the folder goes after the delete is on the disk', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia({ disk });
    const app = await startApp(disk, { media });
    const deckId = await savedCapitals(app);
    app.actions.deleteDeck(deckId, { kind: 'delete' });
    expect(calls).toEqual([]); // not yet: the save has not committed
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`remove ${deckId}`]);
    expect(onDisk(disk).decks.some((d) => d.id === deckId)).toBe(false);
  });

  test('keep: the images go to Unfiled first, and the old folder only after the commit', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia({ disk });
    const app = await startApp(disk, { media });
    const deckId = await savedCapitals(app);
    app.actions.deleteDeck(deckId, { kind: 'keep' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${deckId} → ${UNFILED_DECK_ID}`, `remove ${deckId}`]);
    const saved = onDisk(disk);
    expect(saved.cards.filter((c) => c.deckId === UNFILED_DECK_ID)).toHaveLength(5); // the cards that need the images
  });

  test('move: the images go to the target deck first, then the old folder goes', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia({ disk });
    const app = await startApp(disk, { media });
    const deckId = await savedCapitals(app);
    const target = app.actions.addDeck({ name: 'Geography' });
    app.actions.deleteDeck(deckId, { kind: 'move', targetDeckId: target.id });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${deckId} → ${target.id}`, `remove ${deckId}`]);
    expect(onDisk(disk).cards.filter((c) => c.deckId === target.id)).toHaveLength(5);
  });

  test('keep or move of a deck with no cards: nothing to copy, the folder just goes', async () => {
    const { media, calls } = fakeMedia();
    const app = await startApp(createMemoryStore(), { media });
    const empty = app.actions.addDeck({ name: 'Empty' });
    app.actions.deleteDeck(empty.id, { kind: 'keep' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`remove ${empty.id}`]);
  });

  test('a copy that fails keeps the old folder: it is the only copy of those images', async () => {
    const { media, calls } = fakeMedia({ failCopy: true });
    const app = await startApp(createMemoryStore(), { media });
    const deckId = await savedCapitals(app);
    app.actions.deleteDeck(deckId, { kind: 'keep' });
    await jest.advanceTimersByTimeAsync(0);
    await app.flush();
    expect(calls).toEqual([`copy ${deckId} → ${UNFILED_DECK_ID}`]); // no removal
  });

  test('keep with a failing save: the copy is made anyway, the removal waits', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia({ disk });
    const { app, fail } = await appWithFailingSaves(disk, media);
    const deckId = await savedCapitals(app);
    fail.saves = true;
    app.actions.deleteDeck(deckId, { kind: 'keep' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${deckId} → ${UNFILED_DECK_ID}`]);
    expect(onDisk(disk).decks.some((d) => d.id === deckId)).toBe(true); // still saved, so its folder stays
  });

  test('duplicateDeck: the folder is copied at once, before the copy is on the disk', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia();
    const app = await startApp(disk, { media });
    const deckId = await savedCapitals(app);
    const copy = app.actions.duplicateDeck(deckId);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([`copy ${deckId} → ${copy?.id}`]);
    expect(onDisk(disk).decks.some((d) => d.id === copy?.id)).toBe(false); // the save has not run yet
    expect(app.actions.duplicateDeck('no-such-deck')).toBeNull();
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  test('duplicateDeck: the first save fails, a later save works → the copy deck has its images (made once)', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia();
    const { app, fail } = await appWithFailingSaves(disk, media);
    const deckId = await savedCapitals(app);
    fail.saves = true;
    const copy = app.actions.duplicateDeck(deckId);
    expect(await app.flush()).toMatchObject({ ok: false, reason: 'write' });
    fail.saves = false;
    expect(await app.flush()).toEqual({ ok: true });
    expect(onDisk(disk).decks.some((d) => d.id === copy?.id)).toBe(true);
    expect(calls).toEqual([`copy ${deckId} → ${copy?.id}`]);
  });

  test('a delete whose save failed removes the folder once a later save works (M15)', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia({ disk });
    const { app, fail } = await appWithFailingSaves(disk, media);
    const deckId = await savedCapitals(app);
    fail.saves = true;
    app.actions.deleteDeck(deckId, { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]); // the deck is still on the disk
    fail.saves = false;
    await app.flush(); // the retry commits the delete
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`remove ${deckId}`]);
  });

  test('a restore that brings the deck back keeps its folder (waiting or not)', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia();
    const { app, fail } = await appWithFailingSaves(disk, media);
    const deckId = await savedCapitals(app);
    const backup = v3(app);
    // A removal that waits for a save that works …
    fail.saves = true;
    app.actions.deleteDeck(deckId, { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    fail.saves = false;
    app.actions.restore(backup);
    await app.flush();
    // … and one whose save commits while the restore is already in the state.
    const other = app.actions.addDeck({ name: 'Other' });
    await app.flush();
    const backup2 = v3(app);
    app.actions.deleteDeck(other.id, { kind: 'delete' });
    app.actions.restore(backup2);
    await jest.advanceTimersByTimeAsync(0);
    await app.flush();
    expect(calls).toEqual([]);
    expect(v3(app).decks.map((d) => d.id)).toEqual(expect.arrayContaining([deckId, other.id]));
  });

  test('folder changes run one after another: duplicate, then delete the original at once → copy first, then remove', async () => {
    const calls: string[] = [];
    let finishCopy: () => void = () => undefined;
    const media: DeckMedia = {
      removeDeckFolder: (deckId) => {
        calls.push(`remove ${deckId}`);
      },
      copyDeckFolder: (from, to) => {
        calls.push(`copy ${from} → ${to}: start`);
        return new Promise<void>((resolve) => {
          finishCopy = () => {
            calls.push(`copy ${from} → ${to}: done`);
            resolve();
          };
        });
      },
    };
    const app = await startApp(createMemoryStore(), { media });
    const deckId = await savedCapitals(app);
    const copy = app.actions.duplicateDeck(deckId);
    app.actions.deleteDeck(deckId, { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    await app.flush();
    expect(calls).toEqual([`copy ${deckId} → ${copy?.id}: start`]); // the removal waits for the copy
    finishCopy();
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${deckId} → ${copy?.id}: start`, `copy ${deckId} → ${copy?.id}: done`, `remove ${deckId}`]);
  });

  test('a blocked boot touches no folder; an unknown deck neither', async () => {
    const disk = createMemoryStore();
    const memory = createMemoryPort({ store: disk, now: clock.now });
    const { media, calls } = fakeMedia();
    const app = await startApp(disk, { media });
    await savedCapitals(app);
    app.actions.deleteDeck('no-such-deck', { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);

    const blocked = createEngine({ ...memory, load: () => Promise.reject(new Error('read')) }, engineOptions({ media }));
    await blocked.boot();
    const one = blocked.actions.applyImport(capitalsPlan(blocked)).deckId as Id;
    blocked.actions.duplicateDeck(one);
    blocked.actions.deleteDeck(one, { kind: 'keep' });
    const two = blocked.actions.applyImport(capitalsPlan(blocked)).deckId as Id;
    blocked.actions.deleteDeck(two, { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
  });

  /* "Move to deck…" (moveNotes): the moved cards' images follow them, after the commit (W4-7). */

  /** Deck "Maps" with two notes that show images and one that shows none, and an empty deck "Other". Saved. */
  async function savedMaps(app: Engine) {
    const maps = app.actions.addDeck({ name: 'Maps' }).id;
    const other = app.actions.addDeck({ name: 'Other' }).id;
    const add = (fields: string[]) => app.actions.addNote({ deckId: maps, typeId: 'nt-basic-reverse', fields, tags: [] }).noteId;
    const france = add(['<img src="france.png"> France', 'Paris <img src="paris.jpg">']);
    const japan = add(['Japan <img src="japan.png">', 'Tokyo <img src="france.png">']);
    const peru = add(['Peru', 'Lima']);
    expect(await app.flush()).toEqual({ ok: true });
    return { maps, other, france, japan, peru };
  }

  /** A fake media.ts that records, for each copy, whether the move was ALREADY on the disk (it must be). */
  function mediaThatChecksTheDisk(disk: MemoryStore, movedNoteId: () => Id) {
    const calls: string[] = [];
    const media: DeckMedia = {
      removeDeckFolder: (deckId) => {
        calls.push(`remove ${deckId}`);
      },
      copyDeckFolder: (from, to, names) => {
        const saved = onDisk(disk).cards.filter((c) => c.noteId === movedNoteId());
        const moved = saved.length > 0 && saved.every((c) => c.deckId === to);
        calls.push(`copy ${from} → ${to}: ${(names ?? []).join(', ')}${moved ? '' : ' (the move is NOT saved yet!)'}`);
      },
    };
    return { media, calls };
  }

  test('moveNotes: the images the moved cards show go to the new deck, AFTER the move is on the disk', async () => {
    const disk = createMemoryStore();
    let note: Id = '';
    const { media, calls } = mediaThatChecksTheDisk(disk, () => note);
    const app = await startApp(disk, { media });
    const lib = await savedMaps(app);
    note = lib.france;
    app.actions.moveNotes([lib.france], lib.other);
    expect(calls).toEqual([]); // not yet: the move is not saved
    await jest.advanceTimersByTimeAsync(0);
    // The engine asks for the images of the moved note only (both directions: the note's fields),
    // never the folder's others. This pins what the ENGINE passes; media.test.ts pins that the
    // phone's DeckMedia (DataContext.tsx → media.ts mergeDeckMedia) copies only those names.
    expect(calls).toEqual([`copy ${lib.maps} → ${lib.other}: france.png, paris.jpg`]);
    // The old folder stays: the deck's other cards (and an Undo) still need it.
    expect(calls.some((c) => c.startsWith('remove'))).toBe(false);
  });

  test('moveNotes of several notes: one copy per old deck → new deck, each image once', async () => {
    const { media, calls } = fakeMedia();
    const app = await startApp(createMemoryStore(), { media });
    const lib = await savedMaps(app);
    app.actions.moveNotes([lib.france, lib.japan, lib.peru], lib.other);
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${lib.maps} → ${lib.other}: france.png, paris.jpg, japan.png`]);
  });

  test('moveNotes with no image, to the deck the notes are in already, or on a read-blocked engine: no copy', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia();
    const app = await startApp(disk, { media });
    const lib = await savedMaps(app);
    app.actions.moveNotes([lib.peru], lib.other); // no <img> in its fields
    app.actions.moveNotes([lib.france], lib.maps); // already there: nothing moves
    app.actions.moveNotes([lib.japan], 'no-such-deck'); // no target: nothing moves
    await jest.advanceTimersByTimeAsync(0);
    await app.flush();
    expect(calls).toEqual([]);

    const memory = createMemoryPort({ store: disk, now: clock.now });
    const blocked = createEngine({ ...memory, load: () => Promise.reject(new Error('read')) }, engineOptions({ media }));
    await blocked.boot();
    const from = blocked.actions.addDeck({ name: 'Maps' }).id;
    const to = blocked.actions.addDeck({ name: 'Other' }).id;
    const { noteId } = blocked.actions.addNote({ deckId: from, typeId: 'nt-basic', fields: ['<img src="a.png">', 'A'], tags: [] });
    blocked.actions.moveNotes([noteId], to);
    expect(v3(blocked).cards.filter((c) => c.noteId === noteId).every((c) => c.deckId === to)).toBe(true); // moved in memory
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]); // C1: no folder is touched
  });

  test('moveNotes whose save fails: the copy waits, and runs once a later save works (M15)', async () => {
    const disk = createMemoryStore();
    let note: Id = '';
    const { media, calls } = mediaThatChecksTheDisk(disk, () => note);
    const { app, fail } = await appWithFailingSaves(disk, media);
    const lib = await savedMaps(app);
    note = lib.japan;
    fail.saves = true;
    app.actions.moveNotes([lib.japan], lib.other);
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]); // the move is not on the disk: no copy
    fail.saves = false;
    expect(await app.flush()).toEqual({ ok: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${lib.maps} → ${lib.other}: japan.png, france.png`]); // once
    await app.flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  test('move, then delete the OLD deck at once: the images are copied first, then the old folder goes', async () => {
    const { media, calls } = fakeMedia();
    const app = await startApp(createMemoryStore(), { media });
    const lib = await savedMaps(app);
    app.actions.moveNotes([lib.france], lib.other);
    app.actions.deleteDeck(lib.maps, { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${lib.maps} → ${lib.other}: france.png, paris.jpg`, `remove ${lib.maps}`]);
  });

  test('the same, when both saves failed first: the waiting copy runs before the waiting removal', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia();
    const { app, fail } = await appWithFailingSaves(disk, media);
    const lib = await savedMaps(app);
    fail.saves = true;
    app.actions.moveNotes([lib.france], lib.other);
    await jest.advanceTimersByTimeAsync(0);
    app.actions.deleteDeck(lib.maps, { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    fail.saves = false;
    await app.flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${lib.maps} → ${lib.other}: france.png, paris.jpg`, `remove ${lib.maps}`]);
  });

  test('a move to a deck that is deleted before the copy runs makes no folder for it', async () => {
    const { media, calls } = fakeMedia();
    const app = await startApp(createMemoryStore(), { media });
    const lib = await savedMaps(app);
    app.actions.moveNotes([lib.france], lib.other);
    app.actions.deleteDeck(lib.other, { kind: 'delete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`remove ${lib.other}`]);
  });

  test('a restore forgets the image copies of the moves before it (waiting for a save, or still saving)', async () => {
    const disk = createMemoryStore();
    const { media, calls } = fakeMedia();
    const { app, fail } = await appWithFailingSaves(disk, media);
    const lib = await savedMaps(app);
    const backup = v3(app);
    fail.saves = true;
    app.actions.moveNotes([lib.france], lib.other);
    await jest.advanceTimersByTimeAsync(0);
    fail.saves = false;
    app.actions.restore(backup); // the notes are back in "Maps"
    await app.flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    // The same when the restore comes while the move's save is still running.
    app.actions.moveNotes([lib.france], lib.other);
    app.actions.restore(backup);
    await jest.advanceTimersByTimeAsync(0);
    await app.flush();
    expect(calls).toEqual([]);
    // A move AFTER the restore copies again.
    app.actions.moveNotes([lib.japan], lib.other);
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([`copy ${lib.maps} → ${lib.other}: japan.png, france.png`]);
  });

  /**
   * A fake media.ts where deck `takenIn` holds ANOTHER france.png: imageNames
   * gives it a name of its own there (DeckMedia.imageNames); every call is recorded.
   */
  function mediaWithTakenName(takenIn: () => Id) {
    const calls: string[] = [];
    const media: DeckMedia = {
      removeDeckFolder: (deckId) => {
        calls.push(`remove ${deckId}`);
      },
      copyDeckFolder: (from, to, names, renamed) => {
        const as = renamed ? [...renamed].map(([a, b]) => `${a}→${b}`).join(', ') : '';
        calls.push(`copy ${from} → ${to}${names ? `: ${names.join(', ')}` : ''}${as ? ` (as ${as})` : ''}`);
      },
      imageNames: (_from, to, names) => {
        calls.push(`names → ${to}`);
        return to === takenIn() && (!names || names.includes('france.png'))
          ? new Map([['france.png', 'france-1a2b3c4d.png']])
          : new Map();
      },
    };
    return { media, calls };
  }

  test('moveNotes into a deck that has ANOTHER france.png: the note points at its own name, in the same change', async () => {
    let target: Id = '';
    const { media, calls } = mediaWithTakenName(() => target);
    const app = await startApp(createMemoryStore(), { media });
    const lib = await savedMaps(app);
    target = lib.other;
    const states: number[] = [];
    const unsubscribe = app.store.subscribe(() => states.push(1));
    const editId = app.actions.moveNotes([lib.france, lib.peru], lib.other);
    unsubscribe();
    expect(states).toHaveLength(1); // the move and the new name: ONE state change (one save)
    const france = v3(app).notes.find((n) => n.id === lib.france)!;
    expect(france.fields.slice(0, 2)).toEqual(['<img src="france-1a2b3c4d.png"> France', 'Paris <img src="paris.jpg">']);
    // Japan (not moved) still shows the Maps folder's france.png.
    expect(v3(app).notes.find((n) => n.id === lib.japan)!.fields[1]).toBe('Tokyo <img src="france.png">');
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      `names → ${lib.other}`,
      `copy ${lib.maps} → ${lib.other}: france.png, paris.jpg (as france.png→france-1a2b3c4d.png)`,
    ]);
    // Undo puts the cards back; the note keeps the new name (the copy wrote it into Maps too).
    app.actions.undoManualEdit(editId);
    expect(v3(app).cards.filter((c) => c.noteId === lib.france).every((c) => c.deckId === lib.maps)).toBe(true);
    expect(v3(app).notes.find((n) => n.id === lib.france)!.fields[0]).toBe('<img src="france-1a2b3c4d.png"> France');
  });

  test('deleteDeck moving the cards into a deck with ANOTHER france.png: the notes point at their own name, then the folder goes', async () => {
    let target: Id = '';
    const { media, calls } = mediaWithTakenName(() => target);
    const app = await startApp(createMemoryStore(), { media });
    const lib = await savedMaps(app);
    target = lib.other;
    app.actions.deleteDeck(lib.maps, { kind: 'move', targetDeckId: lib.other });
    const notes = v3(app).notes;
    expect(notes.find((n) => n.id === lib.france)!.fields[0]).toBe('<img src="france-1a2b3c4d.png"> France');
    expect(notes.find((n) => n.id === lib.japan)!.fields[1]).toBe('Tokyo <img src="france-1a2b3c4d.png">');
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      `names → ${lib.other}`,
      `copy ${lib.maps} → ${lib.other} (as france.png→france-1a2b3c4d.png)`,
      `remove ${lib.maps}`,
    ]);
  });

  test('imagesToCopy: per (old deck → new deck), safe image names only, each once', () => {
    const d1 = makeDeckV3({ id: 'd1' });
    const d2 = makeDeckV3({ id: 'd2' });
    const d3 = makeDeckV3({ id: 'd3' });
    const before = stateOfV3({
      decks: [d1, d2, d3],
      groups: [
        noteWithCards({ deckId: 'd1', note: { id: 'n1' }, fields: ['<img src="a.png"><img src="../x.png">', '<img src="https://x.org/y.png"> <img src="b.svg"> <img src="a.png">'] }),
        noteWithCards({ deckId: 'd2', note: { id: 'n2' }, fields: ['<img src="c.webp">', '[sound:s.mp3] <img src="notes.txt">'] }),
        noteWithCards({ deckId: 'd2', note: { id: 'n3' }, fields: ['no image', ''] }),
      ],
    });
    const after = { ...before, cards: before.cards.map((c) => ({ ...c, deckId: 'd3' })) };
    expect(imagesToCopy(before, after, ['n1', 'n2', 'n3'])).toEqual([
      { fromDeckId: 'd1', toDeckId: 'd3', names: ['a.png', 'b.svg'] }, // no "../x.png", no web address, a.png once
      { fromDeckId: 'd2', toDeckId: 'd3', names: ['c.webp'] }, // no sound, no non-image file
    ]);
    // Only the asked notes; nothing moved → nothing to copy.
    expect(imagesToCopy(before, after, ['n2']).map((c) => c.fromDeckId)).toEqual(['d2']);
    expect(imagesToCopy(before, before, ['n1'])).toEqual([]);
    expect(imagesToCopy(before, after, [])).toEqual([]);
  });
});

/* ------------------------------- React effects: dispose → resume, boot errors */

describe('dispose() then resume() on the same engine (an effect that runs twice)', () => {
  test('before boot (StrictMode on the first mount): the boot still works and changes are saved', async () => {
    const disk = createMemoryStore();
    const app = createEngine(createMemoryPort({ store: disk, now: clock.now }), engineOptions());
    // setup → cleanup → setup, as React runs it:
    void app.flush();
    app.dispose();
    app.resume();
    await app.boot();
    expect(app.meta.getState().ready).toBe(true);
    app.actions.setGoals(13, 3);
    await pass(SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(1);
    expect(onDisk(disk).person.goalReviews).toBe(13);
  });

  test('after boot (Fast Refresh): the flushed change is written once, and later changes are saved again', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    app.actions.setGoals(7, 7);
    const lastSave = app.flush(); // the cleanup …
    app.dispose();
    app.resume(); // … and the setup again
    await lastSave;
    expect(onDisk(disk).person.goalReviews).toBe(7);
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(1); // resume() writes nothing the disk already holds
    app.actions.setGoals(8, 8);
    await pass(SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(2);
    expect(onDisk(disk).person.goalReviews).toBe(8);
    expect(await app.boot()).toMatchObject({ kind: 'first-boot' }); // the same boot, not a new one
  });

  test('a change made while disposed is saved after resume()', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    app.dispose();
    app.actions.setGoals(9, 9);
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(0);
    app.resume();
    await pass(SAVE_DEBOUNCE_MS);
    expect(onDisk(disk).person.goalReviews).toBe(9);
  });

  test('a boot that ends while disposed: resume() keeps the LOADED data, never the seed', async () => {
    const saved = savedLibrary();
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(saved) });
    const memory = createMemoryPort({ store: disk, now: clock.now });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: StoragePort<DataState> = { ...memory, load: () => gate.then(() => memory.load()) };
    const app = createEngine(port, engineOptions());
    const boot = app.boot();
    app.dispose();
    release();
    await boot;
    app.resume();
    expect(v3(app)).toEqual(saved);
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(0); // the seed was never written over the data
  });
});

describe('a boot error is never swallowed', () => {
  test('a reconcile that throws: ready is still true, boot() rejects with the error, nothing is written', async () => {
    // Odd old data that a sanitize step missed: a marker without counts.
    const odd = { kind: 'scheduled', label: 'Today', counts: null, total: 3, bestRun: 3, durationSec: 9, fastAnswers: 0 };
    const doc = { ...savedLibrary(), inProgressSession: odd };
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(doc) });
    const app = createEngine(
      createMemoryPort({ store: disk, now: clock.now }),
      // A pass-through migrate, so the odd marker reaches the reconcile.
      engineOptions({ migrateFn: (value) => ({ kind: 'ok', state: value as DataState, from: 3, repaired: [] }) }),
    );
    await expect(app.boot()).rejects.toThrow(TypeError);
    // The splash can hide (DataProvider then shows the crash screen) …
    expect(app.meta.getState()).toMatchObject({ ready: true, persistError: null, lastCompletion: null });
    // … the loaded data is in memory, not the seed …
    expect(v3(app).person).toEqual(doc.person);
    // … and the disk keeps exactly what it had.
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(disk.writes).toBe(0);
  });
});

/* ------------------------------- flush() results and the restore (W2 hardening) */

/**
 * A tiny backups folder for performRestore: name → text. Only the calls a
 * restore makes are real; the share-sheet calls must never happen here.
 */
function fakeBackupsFolder() {
  const docs = new Map<string, string>();
  const io: BackupIO = {
    writeDocument: (name, content) => {
      docs.set(name, content);
      return { name, uri: `file:///files/backups/${name}` };
    },
    list: (prefix = '') =>
      [...docs.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, uri: `file:///files/backups/${name}`, size: docs.get(name)!.length, modifiedAt: null })),
    remove: (name) => {
      docs.delete(name);
    },
    writeCache: () => {
      throw new Error('a restore never writes to the cache');
    },
    clearCache: () => undefined,
    share: async () => {
      throw new Error('a restore never opens the share sheet');
    },
  };
  return { io, docs };
}

describe('flush() tells the caller whether the save committed (W2 hardening)', () => {
  test('a good save → { ok: true }; a failed one → { ok: false, reason: "write" }; read-blocked → "blocked"', async () => {
    const disk = createMemoryStore();
    const memory = createMemoryPort({ store: disk, now: clock.now });
    let failSaves = false;
    const cause = new Error('disk full');
    const port: StoragePort<DataState> = {
      ...memory,
      save: (next, prev) => (failSaves ? Promise.reject(cause) : memory.save(next, prev)),
    };
    const app = createEngine(port, engineOptions());
    await app.boot();
    app.actions.markOnboarded();
    await expect(app.actions.flush()).resolves.toEqual({ ok: true });

    failSaves = true;
    app.actions.setGoals(12, 4);
    await expect(app.actions.flush()).resolves.toEqual({ ok: false, reason: 'write', cause });
    expect(app.meta.getState().persistError).toBe('write'); // M15: the banner too
    await expect(app.flush()).resolves.toEqual({ ok: false, reason: 'write', cause });

    const blocked = createEngine({ ...memory, load: () => Promise.reject(new Error('read failed')) }, engineOptions());
    await blocked.boot();
    blocked.actions.markOnboarded();
    await expect(blocked.actions.flush()).resolves.toEqual({ ok: false, reason: 'blocked' });
  });

  test('a failed replace-all after a restore is reported as a FAILURE, never "Restored — …"', async () => {
    // The disk holds the user's library. Its replace-all (the restore's one
    // transaction) fails, for example because the disk is full.
    const library = savedLibrary();
    const disk = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(library) });
    const memory = createMemoryPort({ store: disk, now: clock.now });
    let failWrites = true;
    const cause = new Error('SQLITE_FULL: database or disk is full');
    const port: StoragePort<DataState> = {
      ...memory,
      replaceAll: (state) => (failWrites ? Promise.reject(cause) : memory.replaceAll(state)),
      save: (next, prev) => (failWrites ? Promise.reject(cause) : memory.save(next, prev)),
    };
    const app = createEngine(port, engineOptions());
    await app.boot();
    const current = app.store.getState();
    expect(v3(app).decks.map((d) => d.name)).toEqual(['Capitals']);

    const backup = makeStateV3({ onboarded: true }, T0);
    const folder = fakeBackupsFolder();
    const result = await performRestore({
      current,
      next: live(backup),
      now: clock.now(),
      restore: (state) => app.actions.restore(state),
      flush: () => app.actions.flush(),
      io: folder.io,
    });

    expect(result).toBe('write-failed');
    const message = restoreResultMessage(result, restoreSummary(live(backup), T0));
    // W4-5: it says that the RESTORE was not saved (not only "your latest changes").
    expect(message).toBe(RESTORE_COPY.notSaved);
    expect(message).not.toContain('Restored');
    expect(app.meta.getState().persistError).toBe('write');
    // The way back is on the phone: the before-restore copy holds the library.
    const copies = [...folder.docs.keys()].filter((name) => name.startsWith('before-restore-'));
    expect(copies).toHaveLength(1);
    const kept = JSON.parse(folder.docs.get(copies[0])!) as { data: DataStateV3 };
    expect(kept.data.decks.map((d) => d.name)).toEqual(['Capitals']);
    // The disk still holds the OLD data (the transaction changed nothing).
    expect(onDisk(disk).decks.map((d) => d.name)).toEqual(['Capitals']);

    // The disk works again: the next flush (the app going to the background)
    // saves the restored state, and says so.
    failWrites = false;
    await expect(app.actions.flush()).resolves.toEqual({ ok: true });
    expect(onDisk(disk)).toEqual(app.store.getState());
    expect(onDisk(disk).decks).toEqual([]);
    expect(app.meta.getState().persistError).toBeNull();
  });

  test('a restore whose replace-all commits → "Restored — …"', async () => {
    const disk = createMemoryStore();
    const app = await startApp(disk);
    importCapitals(app);
    await app.flush();
    const backup = makeStateV3({ onboarded: true }, T0);
    const folder = fakeBackupsFolder();
    const result = await performRestore({
      current: app.store.getState(),
      next: live(backup),
      now: clock.now(),
      restore: (state) => app.actions.restore(state),
      flush: () => app.actions.flush(),
      io: folder.io,
    });
    expect(result).toBe('restored');
    expect(restoreResultMessage(result, restoreSummary(live(backup), T0))).toBe('Restored — 0 decks, 0 cards.');
    expect(onDisk(disk)).toEqual(backup);
    expect(app.meta.getState().persistError).toBeNull();
  });
});

/* ------------- the study history keeps every rating (W4-7: repair, never drop) */

describe('a rating with a broken undo snapshot keeps its history row: first copy and Restore (spec §3.1 rule 4, §3.8)', () => {
  /** The v1 fixture (6 ratings) with rating #2's `prev.ease = null`: how a NaN ease is saved in JSON. */
  function brokenV1(): string {
    const doc = stateFixture('v1-main-1333d48');
    const log = doc.reviewLog as { prev: Record<string, unknown> }[];
    expect(log).toHaveLength(6);
    log[2].prev.ease = null;
    return JSON.stringify(doc);
  }

  /** The phone's row port (rowStore.ts) on memory pieces: the rows, the kv file, no AsyncStorage. */
  function rowPhone(kvText: string | null) {
    const rows = createMemoryRowDb();
    const kv = createMemoryStore(kvText === null ? {} : { [KV_STATE_KEY]: kvText });
    const port = createRowPort<DataState>({
      open: async () => rows,
      kv,
      now: clock.now,
      decode: (doc) => decodedState(doc, clock.now()),
      corruptFile: () => undefined,
      legacy: { readKv: () => kv.getItem(KV_STATE_KEY), readAsyncStorage: async () => null, rescue: async () => null },
    });
    return { rows, port };
  }

  test('the first boot of the build copies the kv document into the rows with ALL 6 history rows', async () => {
    const { rows, port } = rowPhone(brokenV1());
    const app = createEngine(port, engineOptions());
    const boot = await app.boot();
    expect(boot.kind).toBe('loaded');
    // The broken value is repaired, not the rating removed.
    expect(boot.kind === 'loaded' && boot.repaired).toContain('reviewLog #2: prev.ease null → 2.5');
    expect(app.store.getState().reviewLog).toHaveLength(6);
    // The copy ran at boot (spec §3.10 step 3): every rating has its history row.
    const history = rows.snapshot().revlog;
    expect(history).toHaveLength(6);
    expect(history.map((row) => row.seq)).toEqual(app.store.getState().reviewLog.map((e) => e.seq));
    expect(new Set(history.map((row) => row.cardId))).toEqual(new Set(app.store.getState().reviewLog.map((e) => e.cardId)));
    // Undo of the repaired rating works and leaves a usable ease on the card.
    while (app.store.getState().reviewLog.length > 2) app.actions.undoLastReview();
    expect(app.actions.undoLastReview()).toBe(true);
    for (const card of app.store.getState().cards) expect(Number.isFinite(card.ease)).toBe(true);
    app.dispose();
  });

  test('a Restore of that v1 backup writes ALL 6 history rows (replace-all)', async () => {
    const { rows, port } = rowPhone(null);
    const app = createEngine(port, engineOptions());
    await app.boot(); // nothing anywhere: the seed
    const read = readBackup(brokenV1(), clock.now());
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.repaired).toContain('reviewLog #2: prev.ease null → 2.5');
    const folder = fakeBackupsFolder();
    const result = await performRestore({
      current: app.store.getState(),
      next: read.state,
      now: clock.now(),
      restore: (state) => app.actions.restore(state),
      flush: () => app.actions.flush(),
      io: folder.io,
    });
    expect(result).toBe('restored');
    expect(app.store.getState().reviewLog).toHaveLength(6);
    expect(rows.snapshot().revlog).toHaveLength(6);
    app.dispose();
  });
});

/* ------------- the review history and the row store: final review (restore, undo) */

describe('the review history on the row store: a restore writes it in ONE transaction, an undo deletes its row (final review)', () => {
  /** The phone's row port (rowStore.ts) over `rows` (memory pieces: no kv document, no AsyncStorage). */
  function rowPortOn(rows: MemoryRowDb) {
    const kv = createMemoryStore();
    return createRowPort<DataState>({
      open: async () => rows,
      kv,
      now: clock.now,
      decode: (doc) => decodedState(doc, clock.now()),
      corruptFile: () => undefined,
      legacy: { readKv: () => kv.getItem(KV_STATE_KEY), readAsyncStorage: async () => null, rescue: async () => null },
    });
  }

  /** A phone with the Capitals deck and 5 ratings (5 history rows), all saved. */
  async function phoneWithHistory() {
    const rows = createMemoryRowDb();
    const port = rowPortOn(rows);
    const app = createEngine(port, engineOptions());
    await app.boot();
    const ids = importCapitals(app);
    for (const id of ids) app.actions.rateCard(id, 'good');
    await expect(app.actions.flush()).resolves.toEqual({ ok: true });
    expect(rows.snapshot().revlog.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    // The Restore flow's disk: a backups folder plus this phone's history table.
    const io: BackupIO = { ...fakeBackupsFolder().io, readRevlog: () => port.revlog.all() };
    return { rows, port, app, ids, io };
  }

  /** A backup WITHOUT review history (a weekly backup written before wave 5): one deck, an empty log. */
  const NO_HISTORY = { revlog: [], media: [] };
  const oldBackup = () => live(savedLibrary());

  /** The Restore flow's call, as RestoreFlow.tsx makes it. */
  function restoreOn(app: Engine, io: BackupIO, next: DataState, extras: RestoreSteps['extras'] = NO_HISTORY) {
    return performRestore({
      current: app.store.getState(),
      next,
      now: clock.now(),
      restore: (state, history) => app.actions.restore(state, history),
      flush: () => app.actions.flush(),
      extras,
      io,
    });
  }

  test('the kept history is in the replace-all\'s OWN commit: a kill right after the restore loses nothing', async () => {
    const { rows, app, io } = await phoneWithHistory();
    expect(await keptHistoryCount(oldBackup(), NO_HISTORY, io)).toBe(5); // the sheet says "your current review history is kept"
    const commits = rows.writes;
    await expect(restoreOn(app, io, oldBackup())).resolves.toBe('restored');
    // ONE transaction: there is no moment in which the table is empty on the disk.
    expect(rows.writes - commits).toBe(1);
    expect(rows.snapshot().revlog.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    // The app is killed now; the next boot reads the restored library WITH the kept history.
    kill(app);
    const again = createEngine(rowPortOn(rows), engineOptions());
    await again.boot();
    expect(v3(again).decks.map((d) => d.name)).toEqual(['Capitals']);
    expect(v3(again).decks.map((d) => d.id)).toEqual(['d1']); // the backup's deck, not the imported one
    expect(rows.snapshot().revlog).toHaveLength(5);
    again.dispose();
  });

  test('the replace-all fails (disk full) → "not saved"; the retry that finishes it writes the kept history too', async () => {
    const { rows, app, io } = await phoneWithHistory();
    rows.failWrites = 1;
    const result = await restoreOn(app, io, oldBackup());
    expect(result).toBe('write-failed');
    expect(restoreResultMessage(result, restoreSummary(oldBackup(), T0))).toBe(RESTORE_COPY.notSaved);
    // The disk still holds the old library with its history.
    expect(rows.snapshot().revlog).toHaveLength(5);
    // Space is free again: the next save (the M16 background flush) finishes the restore …
    await expect(app.actions.flush()).resolves.toEqual({ ok: true });
    expect(rows.snapshot().tables.decks.map(([id]) => id)).toEqual(['d1']);
    // … WITH the history the confirm sheet promised to keep (it was lost before the fix).
    expect(rows.snapshot().revlog.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    // Restoring again, as the message asks, still keeps it.
    expect(await keptHistoryCount(oldBackup(), NO_HISTORY, io)).toBe(5);
    await expect(restoreOn(app, io, oldBackup())).resolves.toBe('restored');
    expect(rows.snapshot().revlog.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a backup WITH history whose replace-all failed: a rating before the retry never takes a seq of the backup history', async () => {
    const { rows, app, io } = await phoneWithHistory();
    // The backup's history: seq 6 and 7 (above this phone's 1–5), for the backup's cards.
    const backupRow = (seq: number, cardId: string) => ({
      seq,
      cardId,
      deckId: 'd1',
      atMs: T0 - seq * 1000,
      rating: 'good' as const,
      bucket: 'review' as const,
      ivlBefore: 1,
      ivlAfter: 3,
      easeAfter: 2.5,
      durationMs: 900,
    });
    const extras = { revlog: [backupRow(6, 'c2'), backupRow(7, 'c1-0')], media: [] };
    rows.failWrites = 1;
    await expect(restoreOn(app, io, oldBackup(), extras)).resolves.toBe('write-failed');
    // The learner studies the restored library before the retry.
    const rated = app.actions.rateCard('c2', 'good');
    expect(rated).not.toBeNull();
    const seq = v3(app).reviewLog[v3(app).reviewLog.length - 1].seq;
    expect(seq).toBeGreaterThan(7);
    await expect(app.actions.flush()).resolves.toEqual({ ok: true });
    // Every row is there: the backup's two AND the new rating (none written over another).
    expect(rows.snapshot().revlog.map((r) => [r.seq, r.cardId])).toEqual([
      [6, 'c2'],
      [7, 'c1-0'],
      [seq, 'c2'],
    ]);
  });

  test('a factory reset after a failed restore: its replace deletes the history (the restore\'s rows are not written)', async () => {
    const { rows, app, io } = await phoneWithHistory();
    rows.failWrites = 1;
    await expect(restoreOn(app, io, oldBackup())).resolves.toBe('write-failed');
    app.actions.factoryReset();
    await expect(app.actions.flush()).resolves.toEqual({ ok: true });
    expect(rows.snapshot().revlog).toEqual([]);
    expect(rows.snapshot().tables.decks).toEqual([]);
  });

  test('rate → save → Undo → rate again within one save: the undone rating leaves NO history row', async () => {
    // A new learner mis-taps the first rating, taps Undo and rates again in under 400 ms.
    const rows = createMemoryRowDb();
    const port = rowPortOn(rows);
    const app = createEngine(port, engineOptions());
    await app.boot();
    const [a, b] = importCapitals(app);
    await pass(2 * SAVE_DEBOUNCE_MS);
    app.actions.rateCard(a, 'good');
    await pass(SAVE_DEBOUNCE_MS + 100); // saved
    expect(rows.snapshot().revlog.map((r) => r.cardId)).toEqual([a]);
    app.actions.undoLastReview();
    await pass(SAVE_DEBOUNCE_MS - 100); // no save yet
    app.actions.rateCard(b, 'good');
    await pass(SAVE_DEBOUNCE_MS + 100); // ONE save: the undo and the new rating
    expect(v3(app).reviewLog.map((e) => e.cardId)).toEqual([b]);
    expect(v3(app).cards.find((c) => c.id === a)?.reps).toBe(0);
    expect(rows.snapshot().revlog.map((r) => r.cardId)).toEqual([b]);
    // The CardSheet "History" line of the card that was never studied: no review.
    await expect(port.revlog.forCard(a)).resolves.toEqual([]);
    app.dispose();
  });
});

/* ------------------------------------------ createStoragePort() wiring */

describe('createStoragePort() wiring (buildStoragePort with injected pieces)', () => {
  const V1_RAW = stateFixtureRaw('v1-main-1333d48');

  function deps(over: Partial<StoragePortDeps> & { kvStore?: MemoryStore } = {}) {
    const kvStore = over.kvStore ?? createMemoryStore();
    const kv = jest.fn(() => kvStore);
    const readAsyncStorage = jest.fn(async (): Promise<string | null> => {
      throw new Error('Row too big to fit into CursorWindow');
    });
    const rescue = jest.fn(async (): Promise<string | null> => V1_RAW);
    const d: StoragePortDeps = {
      os: 'android',
      now: clock.now,
      kv,
      readAsyncStorage,
      rescue,
      corruptFile: () => undefined,
      ...over,
    };
    return { d, kvStore, kv, readAsyncStorage, rescue };
  }

  test('Android: AsyncStorage cannot read the big value → the RKStorage rescue reads it and it is copied to kv', async () => {
    const { d, kvStore, rescue } = deps();
    const port = buildStoragePort(d);
    const loaded = await port.load();
    expect(rescue).toHaveBeenCalledTimes(1);
    expect(loaded).toMatchObject({ kind: 'doc', raw: V1_RAW });
    expect(kvStore.snapshot()[KV_STATE_KEY]).toBe(V1_RAW);
    expect(JSON.parse(kvStore.snapshot()[KV_COPIED_FROM_KEY])).toMatchObject({
      source: 'rkRescue',
      key: 'maranki.state.v1',
      at: T0,
      length: V1_RAW.length,
    });
  });

  test('Android: the engine boots on the rescued data (E2b in a test) and saves it as v3', async () => {
    const { d, kvStore } = deps();
    const app = createEngine(buildStoragePort(d), engineOptions());
    const boot = await app.boot();
    expect(boot.kind).toBe('loaded');
    expect(app.meta.getState().persistError).toBeNull();
    expect(v3(app).cards).toHaveLength((stateFixture('v1-main-1333d48').cards as unknown[]).length);
    await pass(SAVE_DEBOUNCE_MS);
    expect(JSON.parse(kvStore.snapshot()[KV_STATE_KEY]).schemaVersion).toBe(3);
  });

  test('Android: the rescue finds nothing → read-blocked, nothing is written anywhere', async () => {
    const { d, kvStore } = deps({ rescue: async () => null });
    const app = createEngine(buildStoragePort(d), engineOptions());
    expect(await app.boot()).toMatchObject({ kind: 'blocked', reason: 'read' });
    app.actions.markOnboarded();
    await pass(10 * SAVE_DEBOUNCE_MS);
    await app.flush();
    expect(kvStore.writes).toBe(0);
  });

  test('iOS: there is no RKStorage, so the rescue is never called; the failed read blocks', async () => {
    const { d, rescue } = deps({ os: 'ios' });
    await expect(buildStoragePort(d).load()).rejects.toThrow();
    expect(rescue).not.toHaveBeenCalled();
  });

  test('the kv-store already has the data → AsyncStorage and the rescue are never read', async () => {
    const kvStore = createMemoryStore({ [KV_STATE_KEY]: V1_RAW });
    const { d, readAsyncStorage, rescue } = deps({ kvStore });
    expect(await buildStoragePort(d).load()).toMatchObject({ kind: 'doc', raw: V1_RAW });
    expect(readAsyncStorage).not.toHaveBeenCalled();
    expect(rescue).not.toHaveBeenCalled();
  });

  test('web: a memory port; the kv file is never opened', async () => {
    const { d, kv, readAsyncStorage } = deps({ os: 'web' });
    const port = buildStoragePort(d);
    expect(await port.load()).toEqual({ kind: 'empty' });
    await port.save(live(makeStateV3()), null);
    expect(await port.load()).toMatchObject({ kind: 'doc' });
    expect(kv).not.toHaveBeenCalled();
    expect(readAsyncStorage).not.toHaveBeenCalled();
  });
});

/* -------------------------------- "Save a copy of the raw data" (W2-1) */

describe('raw-data rescue through the live port', () => {
  // 21:04:07 on the phone's clock: the learner sees the name, so it is in local time (wave 5b L8).
  const NOW = new Date(2026, 9, 23, 21, 4, 7).getTime();
  const FILE = 'maranki-raw-data-2026-10-23-21-04-07.json';

  function io(port: StoragePort<DataState>, share: RescueIO['share']) {
    const writes: string[] = [];
    const rescueIO: RescueIO = {
      readRaw: () => port.readRaw(),
      writeFile: (place, name) => {
        writes.push(`${place}/${name}`);
        return `file:///${place}/${name}`;
      },
      share,
    };
    return { rescueIO, writes };
  }

  test('reads the RAW text of the live kv document, even one this build cannot open', async () => {
    const raw = JSON.stringify({ schemaVersion: 9, minReaderVersion: 9 });
    const port = createMemoryPort({ store: createMemoryStore({ [KV_STATE_KEY]: raw }) });
    const texts: string[] = [];
    const report = await rescueReportWith(
      {
        readRaw: () => port.readRaw(),
        writeFile: (_place, name, text) => {
          texts.push(text);
          return `file:///cache/${name}`;
        },
        share: async () => undefined,
      },
      NOW,
    );
    expect(report).toEqual({ outcome: { kind: 'shared', fileName: FILE } });
    expect(texts).toEqual([raw]);
  });

  test('no share sheet on this device → kept in the app, and the line says sharing is not available', async () => {
    const port = createMemoryPort({ store: createMemoryStore({ [KV_STATE_KEY]: '{}' }) });
    const { rescueIO, writes } = io(port, async () => false);
    const report = await rescueReportWith(rescueIO, NOW);
    expect(report).toEqual({ outcome: { kind: 'saved', fileName: FILE }, savedBecause: 'no-share-sheet' });
    expect(writes).toEqual([`cache/${FILE}`, `backups/${FILE}`]);
    expect(rescueReportMessage(report)).toBe(rescueMessage({ kind: 'saved', fileName: FILE }));
  });

  test('sharing available but the share sheet fails → kept in the app, and the line says THAT (carry-over 4)', async () => {
    const port = createMemoryPort({ store: createMemoryStore({ [KV_STATE_KEY]: '{}' }) });
    const { rescueIO } = io(port, () => Promise.reject(new Error('share busy')));
    const report = await rescueReportWith(rescueIO, NOW);
    expect(report).toEqual({ outcome: { kind: 'saved', fileName: FILE }, savedBecause: 'share-failed' });
    const line = rescueReportMessage(report);
    expect(line).toBe(`The share sheet did not open, so the copy was saved inside Maranki as ${FILE}.`);
    expect(line).not.toMatch(/not available/);
  });

  test('a read-blocked port gives no text: on the "read" problem screen that is a read failure, not "no data"', async () => {
    const memory = createMemoryPort({ store: createMemoryStore() });
    const port: StoragePort<DataState> = { ...memory, readRaw: async () => null };
    const { rescueIO } = io(port, async () => undefined);
    const report = await rescueReportWith(rescueIO, NOW);
    expect(report.outcome).toEqual({ kind: 'nothing' });
    expect(rescueReportMessage(report, 'read')).toBe(rescueMessage({ kind: 'read-failed' }));
  });

  test('crash screen: a kv read that fails gives "nothing", and the line never says there is no data', async () => {
    const failingKv: KeyValueStore = {
      getItem: () => Promise.reject(new Error('SQLITE_IOERR')),
      setItem: async () => undefined,
      multiSet: async () => undefined,
    };
    const port = buildStoragePort<DataState>({
      os: 'android',
      now: clock.now,
      kv: () => failingKv,
      readAsyncStorage: async () => null,
      rescue: async () => null,
    });
    const { rescueIO, writes } = io(port, async () => undefined);
    const report = await rescueReportWith(rescueIO, NOW);
    expect(report).toEqual({ outcome: { kind: 'nothing' } });
    expect(writes).toEqual([]); // no empty file was written or shared
    const line = rescueReportMessage(report); // how ErrorScreen calls it
    expect(line).toBe(RESCUE_NOTHING_FOUND_LINE);
    expect(line).toBe("We couldn't find saved data to copy. Your cards were not changed.");
    expect(line).not.toBe(rescueMessage({ kind: 'nothing' })); // "There is no saved data on this phone to copy."
    expect(rescueReportMessage(report, 'too-new')).toBe(RESCUE_NOTHING_FOUND_LINE);
    expect(rescueReportMessage(report, 'migrate')).toBe(RESCUE_NOTHING_FOUND_LINE);
  });

  test('crash screen with nothing stored at all: the same careful line (null cannot tell the two apart)', async () => {
    const port = createMemoryPort({ store: createMemoryStore() });
    const report = await rescueReportWith(io(port, async () => undefined).rescueIO, NOW);
    expect(report).toEqual({ outcome: { kind: 'nothing' } });
    expect(rescueReportMessage(report)).toBe(RESCUE_NOTHING_FOUND_LINE);
  });
});

/* ------------------------------------------------------------- selectors */

describe('cachedPerState (useStoreSelector)', () => {
  test('the selector runs once per state object, so a new array is not a new value every render', () => {
    let state = { n: 1 };
    const selector = jest.fn((s: { n: number }) => [s.n]);
    const read = cachedPerState(() => state, selector);
    const a = read();
    expect(read()).toBe(a);
    expect(selector).toHaveBeenCalledTimes(1);
    state = { n: 2 };
    expect(read()).toEqual([2]);
    expect(selector).toHaveBeenCalledTimes(2);
  });
});

/* --------------------------------------------------- dev timings (W3-2) */

describe('perfMarks: dev-only timings for boot, save, filter and facets', () => {
  /** A perf clock that moves only when the test says so. */
  function fakePerf() {
    let t = 0;
    const lines: string[] = [];
    const perf = createPerfMarks({
      enabled: true,
      clock: () => t,
      log: (line) => {
        lines.push(line);
      },
      keep: 3,
    });
    return {
      perf,
      lines,
      tick: (ms: number) => {
        t += ms;
      },
    };
  }

  test('time / timeAsync / mark record an entry and one log line each', async () => {
    const { perf, lines, tick } = fakePerf();
    const value = perf.time('filter', () => {
      tick(12.34);
      return 'done';
    });
    expect(value).toBe('done');
    await perf.timeAsync('facets', async () => tick(40), '16k cards');
    perf.mark('boot', 812, 'loaded');
    expect(perf.entries().map((e) => [e.name, e.ms, e.detail])).toEqual([
      ['filter', 12.34, undefined],
      ['facets', 40, '16k cards'],
      ['boot', 812, 'loaded'],
    ]);
    expect(lines).toEqual(['[perf] filter 12.3 ms', '[perf] facets 40.0 ms (16k cards)', '[perf] boot 812.0 ms (loaded)']);
  });

  test('a throwing function is still timed; only the newest entries are kept', () => {
    const { perf } = fakePerf();
    expect(() =>
      perf.time('save', () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(perf.entries().map((e) => e.name)).toEqual(['save']);
    for (let i = 1; i <= 4; i++) perf.mark('save', i);
    expect(perf.entries().map((e) => e.ms)).toEqual([2, 3, 4]);
    perf.clear();
    expect(perf.entries()).toEqual([]);
  });

  test('disabled (a release build): the function runs, nothing is kept or printed', async () => {
    const lines: string[] = [];
    const perf = createPerfMarks({
      enabled: false,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(perf.time('filter', () => 7)).toBe(7);
    await expect(perf.timeAsync('save', async () => 8)).resolves.toBe(8);
    perf.mark('boot', 1);
    expect(perf.entries()).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('the engine times its boot, its loads and its saves', async () => {
    const { perf, tick } = fakePerf();
    const app = createEngine(createMemoryPort({ store: createMemoryStore(), now: clock.now }), engineOptions({ perf }));
    await app.boot();
    tick(1);
    app.actions.setGoals(5, 5);
    await app.flush();
    expect(perf.entries().map((e) => e.name)).toEqual(['load', 'boot', 'save']);
    expect(perf.entries()[1].detail).toBe('first-boot');
  });

  test('the app instance follows __DEV__ (on under jest), and the log line format is stable', () => {
    expect(PERF_MARKS_ON).toBe(true);
    expect(perfMarks.enabled).toBe(true);
    expect(formatPerfLine({ name: 'save', ms: 3 })).toBe('[perf] save 3.0 ms');
  });
});
