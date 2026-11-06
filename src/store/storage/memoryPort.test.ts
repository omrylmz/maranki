/**
 * Tests for the memory port (spec §3.7 "Web", unit W1-2) and the shared
 * "one JSON document in a key-value store" code it uses (`createKeyValuePort`
 * in kvStoragePort.ts — the same code as the kv and AsyncStorage ports).
 *
 * Pinned here: the three LoadResult kinds, a failed read REJECTS (never
 * 'empty', C1), corrupt copies never touch the live key, real fixtures and 50
 * seeded random states round-trip byte-for-byte, and the controller + memory
 * port survive a simulated app restart (also after a corrupt boot: the seed is
 * saved, so the restart does not copy the corrupt text again).
 */
import { describe, expect, jest, test } from '@jest/globals';

import { createClock, FIXED_NOW } from '../../test/clock';
import { makeState, randomState, STATE_FIXTURES, stateFixtureRaw, type StateV2 } from '../../test/factories';
import { createRandom } from '../../test/random';
import { backupStamp } from '../backup';
import { createPersistController, SAVE_DEBOUNCE_MS } from '../persistController';
import { classifyRaw, createKeyValuePort, KV_CORRUPT_PREFIX, KV_STATE_KEY, type KeyValueStore } from './kvStoragePort';
import { createMemoryPort, createMemoryStore } from './memoryPort';

type S = StateV2;

const STAMP = backupStamp(new Date(FIXED_NOW));

/* ------------------------------------------------------------ classifyRaw */

describe('classifyRaw', () => {
  test('null or empty text → empty (a genuine first boot)', () => {
    expect(classifyRaw(null)).toEqual({ kind: 'empty' });
    expect(classifyRaw('')).toEqual({ kind: 'empty' });
  });

  test('text that parses → doc with the parsed value and the raw text', () => {
    expect(classifyRaw('{"a":1}')).toEqual({ kind: 'doc', value: { a: 1 }, raw: '{"a":1}' });
  });

  test('text that does not parse (a write cut off by a kill) → corrupt, raw kept', () => {
    expect(classifyRaw('{"cards":[1,2')).toEqual({ kind: 'corrupt', raw: '{"cards":[1,2' });
    expect(classifyRaw('   ')).toEqual({ kind: 'corrupt', raw: '   ' });
  });
});

/* ------------------------------------------------------------ memory port */

describe('memory port', () => {
  test('an empty store → load() gives empty, readRaw() gives null', async () => {
    const port = createMemoryPort<S>();
    await expect(port.load()).resolves.toEqual({ kind: 'empty' });
    await expect(port.readRaw()).resolves.toBeNull();
  });

  test('save, then a NEW port on the same store (an app restart) loads the same state', async () => {
    const store = createMemoryStore();
    const state = makeState();
    await createMemoryPort<S>({ store }).save(state, null);

    const after = await createMemoryPort<S>({ store }).load();
    expect(after.kind).toBe('doc');
    if (after.kind === 'doc') {
      expect(after.value).toEqual(state);
      expect(after.raw).toBe(JSON.stringify(state));
    }
    // It uses the kv port's key, so the layout is the same as on a phone.
    expect(Object.keys(store.snapshot())).toEqual([KV_STATE_KEY]);
  });

  test('it stores real JSON text: a key that holds undefined is lost, like on a phone', async () => {
    const port = createMemoryPort<{ a: number; b?: string }>();
    await port.save({ a: 1, b: undefined }, null);
    const back = await port.load();
    expect(back.kind === 'doc' && back.value).toEqual({ a: 1 });
    expect(back.kind === 'doc' && Object.keys(back.value as object)).toEqual(['a']);
  });

  test('a value JSON cannot write → save() rejects (it never throws synchronously)', async () => {
    const port = createMemoryPort<Record<string, unknown>>();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const saving = port.save(cycle, null);
    await expect(saving).rejects.toThrow();
    await expect(port.load()).resolves.toEqual({ kind: 'empty' });
  });

  test('replaceAll replaces everything', async () => {
    const port = createMemoryPort<S>();
    await port.save(makeState({ onboarded: false }), null);
    const next = makeState({ onboarded: true });
    await port.replaceAll(next);
    const back = await port.load();
    expect(back.kind === 'doc' && back.value).toEqual(next);
  });

  test('preserveCorrupt keeps the text under maranki.state.corrupt.{stamp} and never touches the live key', async () => {
    const store = createMemoryStore({ [KV_STATE_KEY]: '{"broken' });
    const port = createMemoryPort<S>({ store, now: createClock().now });
    await port.preserveCorrupt('{"broken');
    expect(store.snapshot()).toEqual({
      [KV_STATE_KEY]: '{"broken',
      [`${KV_CORRUPT_PREFIX}${STAMP}`]: '{"broken',
    });
    expect(`${KV_CORRUPT_PREFIX}${STAMP}`).toMatch(/^maranki\.state\.corrupt\.\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  });

  test('every real fixture loads byte-for-byte and round-trips through save', async () => {
    for (const name of STATE_FIXTURES) {
      const raw = stateFixtureRaw(name);
      const store = createMemoryStore({ [KV_STATE_KEY]: raw });
      const port = createMemoryPort<unknown>({ store });

      const loaded = await port.load();
      expect(loaded.kind).toBe('doc');
      if (loaded.kind !== 'doc') continue;
      expect(loaded.raw).toBe(raw); // the exact bytes the old build wrote
      expect(loaded.value).toEqual(JSON.parse(raw));
      await expect(port.readRaw()).resolves.toBe(raw);

      await port.save(loaded.value, null);
      const again = await createMemoryPort<unknown>({ store }).load();
      expect(again.kind === 'doc' && again.value).toEqual(loaded.value);
      // The old documents were written with JSON.stringify too: same text back.
      expect(store.snapshot()[KV_STATE_KEY]).toBe(raw);
    }
  });

  test('50 seeded random states: load(save(state)) deep-equals state', async () => {
    const rnd = createRandom('memoryPort round trip');
    for (let i = 0; i < 50; i++) {
      const state = randomState(rnd.fork(`state ${i}`));
      const port = createMemoryPort<S>();
      await port.save(state, null);
      const back = await port.load();
      expect(back.kind).toBe('doc');
      expect(back.kind === 'doc' && back.value).toEqual(state);
    }
  });

  test('the memory store: multiSet writes every pair in one call; writes are counted', async () => {
    const store = createMemoryStore();
    await store.multiSet([
      ['a', '1'],
      ['b', '2'],
    ]);
    await store.setItem('c', '3');
    expect(store.snapshot()).toEqual({ a: '1', b: '2', c: '3' });
    expect(store.writes).toBe(2);
    await expect(store.getItem('missing')).resolves.toBeNull();
  });
});

/* ---------------------------------------- the shared key-value document code */

/** A store whose calls can fail, to test the error paths of createKeyValuePort. */
function flakyStore(fail: { get?: boolean; set?: boolean }) {
  const inner = createMemoryStore();
  const store: KeyValueStore = {
    getItem: async (key) => {
      if (fail.get) throw new Error('read failed');
      return inner.getItem(key);
    },
    setItem: async (key, value) => {
      if (fail.set) throw new Error('write failed');
      return inner.setItem(key, value);
    },
    multiSet: (pairs) => inner.multiSet(pairs),
  };
  return { store, inner };
}

const kvOptions = {
  stateKey: 'state',
  corruptKey: (stamp: string) => `corrupt.${stamp}`,
  now: () => FIXED_NOW,
};

describe('createKeyValuePort (shared by the memory, kv and AsyncStorage ports)', () => {
  test('a read that fails → load() REJECTS, never "empty" (C1)', async () => {
    const { store } = flakyStore({ get: true });
    const port = createKeyValuePort<S>(store, kvOptions);
    await expect(port.load()).rejects.toThrow('read failed');
  });

  test('readRaw() never rejects: a failed read gives null', async () => {
    const { store } = flakyStore({ get: true });
    const port = createKeyValuePort<S>(store, kvOptions);
    await expect(port.readRaw()).resolves.toBeNull();
  });

  test('a write that fails → save() and replaceAll() reject', async () => {
    const { store } = flakyStore({ set: true });
    const port = createKeyValuePort<S>(store, kvOptions);
    await expect(port.save(makeState(), null)).rejects.toThrow('write failed');
    await expect(port.replaceAll(makeState())).rejects.toThrow('write failed');
  });

  test('preserveCorrupt also writes the optional file copy with the same stamp', async () => {
    const { store, inner } = flakyStore({});
    const files: [string, string][] = [];
    const port = createKeyValuePort<S>(store, { ...kvOptions, corruptFile: (raw, stamp) => void files.push([raw, stamp]) });
    await port.preserveCorrupt('{"x');
    expect(inner.snapshot()).toEqual({ [`corrupt.${STAMP}`]: '{"x' });
    expect(files).toEqual([['{"x', STAMP]]);
  });

  test('preserveCorrupt: one good copy is enough', async () => {
    // The store write fails, the file copy works → resolves.
    const { store } = flakyStore({ set: true });
    const files: string[] = [];
    const port = createKeyValuePort<S>(store, { ...kvOptions, corruptFile: (raw) => void files.push(raw) });
    await expect(port.preserveCorrupt('{"x')).resolves.toBeUndefined();
    expect(files).toEqual(['{"x']);

    // The file copy throws, the store write works → resolves.
    const ok = flakyStore({});
    const port2 = createKeyValuePort<S>(ok.store, {
      ...kvOptions,
      corruptFile: () => {
        throw new Error('no space');
      },
    });
    await expect(port2.preserveCorrupt('{"y')).resolves.toBeUndefined();
    expect(ok.inner.snapshot()).toEqual({ [`corrupt.${STAMP}`]: '{"y' });
  });

  test('preserveCorrupt: every copy failed → rejects (so the controller blocks writes)', async () => {
    const { store } = flakyStore({ set: true });
    const port = createKeyValuePort<S>(store, {
      ...kvOptions,
      corruptFile: () => Promise.reject(new Error('no space')),
    });
    await expect(port.preserveCorrupt('{"x')).rejects.toThrow('write failed');
  });
});

/* ------------------------------------------ controller + memory port together */

describe('controller over the memory port', () => {
  const seed = (now: number): S => makeState({}, now);
  const decode = (value: unknown) => ({ kind: 'ok' as const, state: value as S });

  test('boot → change → flush → restart: the change is there', async () => {
    const store = createMemoryStore({ [KV_STATE_KEY]: JSON.stringify(makeState({ onboarded: false })) });

    const first = createPersistController<S>(createMemoryPort<S>({ store }), { now: () => FIXED_NOW, decode, seed });
    const boot = await first.load();
    expect(boot.kind).toBe('loaded');
    const changed = makeState({ onboarded: true });
    first.scheduleSave(changed);
    await first.flush(); // the app goes to the background
    first.dispose(); // …and is killed

    const second = createPersistController<S>(createMemoryPort<S>({ store }), { now: () => FIXED_NOW, decode, seed });
    const reboot = await second.load();
    expect(reboot.kind === 'loaded' && reboot.state).toEqual(changed);
  });

  test('a corrupt document: copied away once, then the seed is saved over the live key', async () => {
    const store = createMemoryStore({ [KV_STATE_KEY]: '{"cards":[' });
    const controller = createPersistController<S>(createMemoryPort<S>({ store, now: () => FIXED_NOW }), {
      now: () => FIXED_NOW,
      decode,
      seed,
    });
    const boot = await controller.load();
    expect(boot.kind).toBe('corrupt');
    if (boot.kind !== 'corrupt') return;
    controller.scheduleSave(boot.state);
    await controller.flush();
    expect(store.snapshot()).toEqual({
      [KV_STATE_KEY]: JSON.stringify(seed(FIXED_NOW)),
      [`${KV_CORRUPT_PREFIX}${STAMP}`]: '{"cards":[',
    });
  });

  test('a corrupt document and NO change by the user: the seed is still saved, so a restart copies nothing again', async () => {
    jest.useFakeTimers();
    try {
      const store = createMemoryStore({ [KV_STATE_KEY]: '{"cards":[' });
      const options = { now: () => FIXED_NOW, decode, seed };
      const first = createPersistController<S>(createMemoryPort<S>({ store, now: () => FIXED_NOW }), options);
      expect((await first.load()).kind).toBe('corrupt');
      await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // the user does nothing
      first.dispose(); // …and the app is killed

      // A later boot, one minute later (so a second copy would get a new stamp).
      const later = FIXED_NOW + 60_000;
      const second = createPersistController<S>(createMemoryPort<S>({ store, now: () => later }), {
        ...options,
        now: () => later,
      });
      const reboot = await second.load();
      expect(reboot.kind === 'loaded' && reboot.state).toEqual(seed(FIXED_NOW));
      // Exactly ONE corrupt copy, from the first boot.
      expect(store.snapshot()).toEqual({
        [KV_STATE_KEY]: JSON.stringify(seed(FIXED_NOW)),
        [`${KV_CORRUPT_PREFIX}${STAMP}`]: '{"cards":[',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
