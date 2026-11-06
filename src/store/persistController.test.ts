/**
 * Tests for the persistence controller (spec §3.9 and §3.12, unit W1-2).
 *
 * Each data-safety rule that lived in DataContext effects is pinned here with
 * jest's fake timers and a fake port that records every write:
 *   C1 (a read failure never writes), the flushSave gate, the debounce gate,
 *   the 400 ms debounce, M16 (flush now), M15 (a failed save is reported and
 *   retried), the corrupt path (the seed is saved, so the next boot does not
 *   copy the text again), the read-blocked reasons, onError(null) when a
 *   problem ends, and `flush(); dispose();` keeping the last change.
 * W2-1 review round 1: resume() after dispose() (a React effect that runs
 * setup → cleanup → setup), and judgeDocument (the one place of the
 * "what does this document mean" rule; persistence.ts decideLoad uses it too).
 * W2 hardening: flush() RESOLVES whether the newest write committed
 * (FlushResult: ok / 'write' / 'blocked'), so a failed restore is never
 * reported as a success. It still never rejects.
 * Unit P4: persistWrites says while a save or a restore is written (busy,
 * onIdle), so idle work can wait; the saves themselves are unchanged.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createClock, FIXED_NOW } from '../test/clock';
import { makePerson, makeState, stateFixture, stateFixtureRaw, type StateV2 } from '../test/factories';
import type { PersistError } from './actions';
import {
  createPersistController,
  judgeDocument,
  SAVE_DEBOUNCE_MS,
  type DecodeResult,
  type PersistControllerOptions,
  persistWrites,
} from './persistController';
import type { LoadResult, StoragePort } from './storagePort';

type S = StateV2;

/* ---------------------------------------------------------------- helpers */

/** A promise that the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every waiting promise callback run (fake timers do not touch promises). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Three different states, so a test can see WHICH one was saved. */
const s1 = makeState({ person: makePerson({ xp: 1 }) });
const s2 = makeState({ person: makePerson({ xp: 2 }) });
const s3 = makeState({ person: makePerson({ xp: 3 }) });

const seed = (now: number): S => makeState({}, now);
const okDecode = (value: unknown): DecodeResult<S> => ({ kind: 'ok', state: value as S });

/**
 * A fake port. Every write is recorded in `writes` (in order), so "nothing
 * was written" is one check. Each write's behaviour can be replaced in `impl`.
 */
function fakePort(load: () => Promise<LoadResult>) {
  const writes: string[] = [];
  const saves: { next: S; prev: S | null }[] = [];
  const replaced: S[] = [];
  const preserved: string[] = [];
  const impl = {
    save: async (_next: S, _prev: S | null): Promise<void> => undefined,
    replaceAll: async (_state: S): Promise<void> => undefined,
    preserveCorrupt: async (_raw: string): Promise<void> => undefined,
  };
  const port: StoragePort<S> = {
    load,
    save: (next, prev) => {
      writes.push('save');
      saves.push({ next, prev });
      return impl.save(next, prev);
    },
    replaceAll: (state) => {
      writes.push('replaceAll');
      replaced.push(state);
      return impl.replaceAll(state);
    },
    preserveCorrupt: (raw) => {
      writes.push('preserveCorrupt');
      preserved.push(raw);
      return impl.preserveCorrupt(raw);
    },
    readRaw: async () => null,
  };
  return { port, writes, saves, replaced, preserved, impl };
}

const loads = {
  empty: () => async (): Promise<LoadResult> => ({ kind: 'empty' }),
  doc: (value: unknown, raw?: string) => async (): Promise<LoadResult> => ({ kind: 'doc', value, raw }),
  corrupt: (raw: string) => async (): Promise<LoadResult> => ({ kind: 'corrupt', raw }),
  fails: () => async (): Promise<LoadResult> => {
    throw new Error('getItem failed: Row too big to fit into CursorWindow');
  },
};

function setup(load: () => Promise<LoadResult>, overrides: Partial<PersistControllerOptions<S>> = {}) {
  const clock = createClock();
  const fake = fakePort(load);
  const errors: PersistError[] = [];
  const controller = createPersistController<S>(fake.port, {
    now: clock.now,
    decode: okDecode,
    seed,
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { ...fake, clock, errors, controller };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/* ------------------------------------------------------------------- load */

describe('load', () => {
  test('nothing stored → first boot with the seed, then ready', async () => {
    const { controller } = setup(loads.empty());
    expect(controller.status).toBe('loading');
    expect(controller.canSave).toBe(false);

    const boot = await controller.load();
    expect(boot).toEqual({ kind: 'first-boot', state: seed(FIXED_NOW) });
    expect(controller.status).toBe('ready');
    expect(controller.canSave).toBe(true);
    expect(controller.error).toBeNull();
  });

  test('a stored document → decode gets the value, the raw text and the load time', async () => {
    const raw = stateFixtureRaw('v1-main-1333d48');
    const value = stateFixture('v1-main-1333d48');
    const decode = jest.fn(
      (_value: unknown, _ctx: { raw?: string; now: number }): DecodeResult<S> => ({
        kind: 'ok',
        state: s2,
        from: 1,
        repaired: ['card c-1: ease'],
      }),
    );
    const { controller, writes } = setup(loads.doc(value, raw), { decode });

    const boot = await controller.load();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(value, { raw, now: FIXED_NOW });
    expect(boot).toEqual({ kind: 'loaded', state: s2, from: 1, repaired: ['card c-1: ease'] });
    expect(controller.status).toBe('ready');
    // Loading never writes by itself.
    expect(writes).toEqual([]);
  });

  test('corrupt → preserveCorrupt once, then seed', async () => {
    const raw = '{"cards":[{"id":"c1"'; // a write cut off by an OS kill
    const { controller, preserved, saves, clock } = setup(loads.corrupt(raw));

    const boot = await controller.load();
    expect(preserved).toEqual([raw]);
    expect(boot).toEqual({ kind: 'corrupt', state: seed(clock.now()) });
    expect(controller.status).toBe('ready');

    // The seed is now the user's data: it may be saved (over the corrupt text, which was copied away).
    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([{ next: s1, prev: null }]);
    expect(preserved).toHaveLength(1); // still once
  });

  test('corrupt → the seed itself is saved after the debounce; the next boot is "loaded", not corrupt again', async () => {
    // A tiny disk with one value: load() reads it, save() writes it.
    const raw = '{"cards":[{"id":"c1"';
    let stored: LoadResult = { kind: 'corrupt', raw };
    const first = setup(async () => stored);
    first.impl.save = async (next) => {
      stored = { kind: 'doc', value: next };
    };

    const boot = await first.controller.load();
    expect(boot.kind).toBe('corrupt');
    if (boot.kind !== 'corrupt') return;
    // No scheduleSave() from the caller: the controller saves the seed by itself.
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(first.saves).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(first.saves).toEqual([{ next: boot.state, prev: null }]);
    expect(first.saves[0].next).toBe(boot.state); // the same object the caller put in the store
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    expect(first.saves).toHaveLength(1); // once

    // The app restarts on the same disk: the seed is there, the corrupt text is not.
    const second = setup(async () => stored);
    const reboot = await second.controller.load();
    expect(reboot).toEqual({ kind: 'loaded', state: boot.state, from: undefined, repaired: [] });
    expect(first.preserved).toEqual([raw]);
    expect(second.preserved).toEqual([]); // the text is NOT copied a second time
  });

  test('"not a Maranki document" → its seed is saved too; a flush right after boot saves it now', async () => {
    const { controller, saves, writes } = setup(loads.doc({ hello: 'world' }, '{"hello":"world"}'), {
      decode: () => ({ kind: 'invalid' }),
    });
    const boot = await controller.load();
    expect(boot.kind).toBe('corrupt');
    if (boot.kind !== 'corrupt') return;
    await controller.flush(); // the app goes to the background before 400 ms (M16)
    expect(writes).toEqual(['preserveCorrupt', 'save']);
    expect(saves).toEqual([{ next: boot.state, prev: null }]);
  });

  test('decode says "not a Maranki document" → handled like a corrupt document', async () => {
    const value = { hello: 'world' };
    const { controller, preserved } = setup(loads.doc(value, '{"hello":"world"}'), {
      decode: () => ({ kind: 'invalid' }),
    });
    const boot = await controller.load();
    expect(boot.kind).toBe('corrupt');
    expect(preserved).toEqual(['{"hello":"world"}']);
  });

  test('"not a Maranki document" without raw text → the parsed value is kept as JSON', async () => {
    const { controller, preserved } = setup(loads.doc({ a: 1 }), { decode: () => ({ kind: 'invalid' }) });
    await controller.load();
    expect(preserved).toEqual(['{"a":1}']);
  });

  test('decode returns too-new → read-blocked with reason "too-new", nothing written', async () => {
    const raw = '{"schemaVersion":9,"minReaderVersion":9}';
    const { controller, writes, errors } = setup(loads.doc(JSON.parse(raw), raw), {
      decode: () => ({ kind: 'too-new', version: 9 }),
    });
    const boot = await controller.load();
    expect(boot).toEqual({ kind: 'blocked', reason: 'too-new', raw, cause: undefined });
    expect(controller.status).toBe('read-blocked');
    expect(controller.error).toBe('too-new');
    expect(errors).toEqual(['too-new']);

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    await controller.flush();
    expect(writes).toEqual([]);
  });

  test('decode throws → read-blocked with reason "migrate" (never "corrupt"), nothing written', async () => {
    const bug = new Error('migrate bug');
    const { controller, writes, errors } = setup(loads.doc({ cards: [] }, '{"cards":[]}'), {
      decode: () => {
        throw bug;
      },
    });
    const boot = await controller.load();
    expect(boot).toEqual({ kind: 'blocked', reason: 'migrate', raw: '{"cards":[]}', cause: bug });
    expect(controller.status).toBe('read-blocked');
    expect(errors).toEqual(['migrate']);

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    await controller.flush();
    expect(writes).toEqual([]); // no preserveCorrupt, no save
  });

  test('corrupt but no copy could be kept → read-blocked; the corrupt text is never written over', async () => {
    const { controller, impl, saves, errors } = setup(loads.corrupt('{"broken'));
    impl.preserveCorrupt = async () => {
      throw new Error('disk full');
    };
    const boot = await controller.load();
    expect(boot.kind).toBe('blocked');
    expect(boot.kind === 'blocked' && boot.reason).toBe('read');
    expect(errors).toEqual(['read']);

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    await controller.flush();
    expect(saves).toEqual([]);
  });

  test('a throwing seed() leaves the controller blocked, not writable', async () => {
    const { controller, writes } = setup(loads.empty(), {
      seed: () => {
        throw new Error('seed bug');
      },
    });
    const boot = await controller.load();
    expect(boot.kind).toBe('blocked');
    expect(controller.canSave).toBe(false);
    controller.scheduleSave(s1);
    await controller.flush();
    expect(writes).toEqual([]);
  });

  test('a second load() while loading gets the same result; after ready it rejects', async () => {
    const gate = deferred<LoadResult>();
    const load = jest.fn(() => gate.promise);
    const { controller } = setup(load);

    const a = controller.load();
    const b = controller.load();
    gate.resolve({ kind: 'empty' });
    expect(await a).toEqual(await b);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(controller.load()).rejects.toThrow('already loaded');
  });

  test('"Try again": load() runs again after a read-blocked load', async () => {
    let attempt = 0;
    const { controller } = setup(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return { kind: 'doc', value: s3 };
    });
    expect((await controller.load()).kind).toBe('blocked');
    const again = await controller.load();
    expect(again).toEqual({ kind: 'loaded', state: s3, from: undefined, repaired: [] });
    expect(controller.status).toBe('ready');
    expect(controller.error).toBeNull();
  });

  test('"Try again" that works sends onError(null): the problem screen can close', async () => {
    let attempt = 0;
    const { controller, errors } = setup(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return { kind: 'doc', value: s3 };
    });
    await controller.load();
    expect(errors).toEqual(['read']);
    await controller.load();
    expect(errors).toEqual(['read', null]);
  });

  test('while "Try again" loads, the old reason stays; a second failure reports it again, never null', async () => {
    let gate = deferred<LoadResult>();
    const { controller, errors, writes } = setup(() => gate.promise);
    const first = controller.load();
    gate.reject(new Error('transient'));
    await first;
    expect(errors).toEqual(['read']);

    gate = deferred<LoadResult>();
    const retry = controller.load();
    // Still loading: no null in between (the problem screen does not flicker), still no writes.
    expect(controller.status).toBe('loading');
    expect(controller.error).toBe('read');
    expect(controller.canSave).toBe(false);
    gate.reject(new Error('still broken'));
    expect((await retry).kind).toBe('blocked');
    expect(errors).toEqual(['read', 'read']);
    expect(controller.status).toBe('read-blocked');
    expect(writes).toEqual([]);
  });

  test('a load that works the first time sends nothing to onError', async () => {
    const { controller, errors } = setup(loads.doc(s1));
    await controller.load();
    expect(errors).toEqual([]);
  });
});

/* -------------------------------------------------------------- the gates */

describe('save gates', () => {
  test('read failure never writes', async () => {
    const { controller, writes, errors } = setup(loads.fails());
    const boot = await controller.load();

    expect(boot.kind).toBe('blocked');
    expect(boot.kind === 'blocked' && boot.reason).toBe('read');
    expect(controller.status).toBe('read-blocked');
    expect(controller.error).toBe('read');
    expect(controller.canSave).toBe(false);
    expect(errors).toEqual(['read']);

    // The app keeps running in memory: changes, flushes and a restore attempt.
    controller.scheduleSave(s1);
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(60_000);
    await controller.flush();
    await expect(controller.replaceAll(s3)).rejects.toThrow('writes are blocked');
    expect(writes).toEqual([]);
  });

  test('flush before ready writes nothing', async () => {
    const gate = deferred<LoadResult>();
    const { controller, writes } = setup(() => gate.promise);
    const loading = controller.load();

    // The in-memory state is still the blank seed here, not the user's data.
    await controller.flush();
    controller.scheduleSave(s3);
    await controller.flush();
    expect(writes).toEqual([]);

    gate.resolve({ kind: 'doc', value: s1 });
    await loading;
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    expect(writes).toEqual([]);
  });

  test('changes before ready are not saved', async () => {
    const gate = deferred<LoadResult>();
    const { controller, saves } = setup(() => gate.promise);
    const loading = controller.load();

    controller.scheduleSave(s1); // before ready: dropped, not remembered
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    gate.resolve({ kind: 'doc', value: s2 });
    await loading;
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    await controller.flush();
    expect(saves).toEqual([]);

    // After ready, a change is saved as usual. Its prev is the loaded state
    // (W2-1): the disk already holds s2, so a row port writes only the difference.
    controller.scheduleSave(s3);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([{ next: s3, prev: s2 }]);
  });

  test('3 changes in 400 ms → one save with the last state', async () => {
    const { controller, saves } = setup(loads.empty());
    await controller.load();

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(200);
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(200);
    controller.scheduleSave(s3);

    // Each change restarts the 400 ms wait.
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(saves).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([{ next: s3, prev: null }]);

    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(1);
  });

  test('flush cancels the debounce and saves now (M16)', async () => {
    const { controller, saves } = setup(loads.empty());
    await controller.load();

    controller.scheduleSave(s1);
    await controller.flush(); // no timer advanced: the save happens now
    expect(saves).toEqual([{ next: s1, prev: null }]);

    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(1); // the cancelled timer does not save again

    // Nothing new → flush has nothing to write.
    await controller.flush();
    expect(saves).toHaveLength(1);
  });

  test('flush resolves only after the save in flight is on the disk', async () => {
    const { controller, impl } = setup(loads.empty());
    await controller.load();
    const disk = deferred<void>();
    impl.save = () => disk.promise;

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // the save starts
    let flushed = false;
    void controller.flush().then(() => {
      flushed = true;
    });
    await settle();
    expect(flushed).toBe(false);
    disk.resolve();
    await settle();
    expect(flushed).toBe(true);
  });

  test('save rejects → onError, next save retries', async () => {
    const { controller, impl, saves, errors } = setup(loads.empty());
    await controller.load();
    impl.save = async () => {
      throw new Error('SQLITE_FULL');
    };

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(errors).toEqual(['write']);
    expect(controller.error).toBe('write');
    expect(controller.status).toBe('ready'); // a write error never blocks saving

    // The disk works again. The next save still has prev = null: the failed
    // save did not count, so the port writes the full difference.
    impl.save = async () => undefined;
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([
      { next: s1, prev: null },
      { next: s2, prev: null },
    ]);
    expect(errors).toEqual(['write', null]); // null = the problem is gone
    expect(controller.error).toBeNull();

    // Now prev moves forward.
    controller.scheduleSave(s3);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves[2]).toEqual({ next: s3, prev: s2 });
  });

  test('a failed save is tried again by the next flush, even without a new change', async () => {
    const { controller, impl, saves, errors } = setup(loads.empty());
    await controller.load();
    let fail = true;
    impl.save = async () => {
      if (fail) throw new Error('busy');
    };

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(errors).toEqual(['write']);

    // No automatic retry loop (a full disk would spin)…
    await jest.advanceTimersByTimeAsync(60_000);
    expect(saves).toHaveLength(1);

    // …but the app going to the background flushes, and that retries.
    fail = false;
    await controller.flush();
    expect(saves).toEqual([
      { next: s1, prev: null },
      { next: s1, prev: null },
    ]);
    expect(controller.error).toBeNull();
  });

  test('saves never overlap; each one gets the last SUCCESSFUL state as prev', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    const first = deferred<void>();
    impl.save = () => first.promise;

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(1);

    impl.save = async () => undefined;
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(1); // waits for the first save

    first.resolve();
    await settle();
    expect(saves).toEqual([
      { next: s1, prev: null },
      { next: s2, prev: s1 },
    ]);
  });

  test('an OLDER failed save never comes back after a newer save', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    const first = deferred<void>();
    impl.save = () => first.promise;

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // s1 is being saved
    impl.save = async () => undefined;
    controller.scheduleSave(s2);
    const flushing = controller.flush(); // s2 is queued behind s1

    first.reject(new Error('busy')); // s1 fails AFTER s2 was queued
    await flushing;
    expect(saves.map((s) => s.next)).toEqual([s1, s2]);

    // s1 must not be retried: that would write an old state over s2.
    await controller.flush();
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    expect(saves.map((s) => s.next)).toEqual([s1, s2]);
    expect(controller.error).toBeNull();
  });

  test('a save that fails after a replaceAll call never comes back over the replacement', async () => {
    const { controller, impl, saves, replaced } = setup(loads.empty());
    await controller.load();
    const first = deferred<void>();
    impl.save = () => first.promise;

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // s1 is being saved
    const restore = controller.replaceAll(s3);
    first.reject(new Error('busy'));
    await restore;
    expect(replaced).toEqual([s3]);

    impl.save = async () => undefined;
    await controller.flush();
    expect(saves.map((s) => s.next)).toEqual([s1]); // s1 is not written over the restore
  });

  test('a throwing onError callback never breaks saving', async () => {
    const { controller, impl, saves } = setup(loads.empty(), {
      onError: () => {
        throw new Error('UI bug');
      },
    });
    await controller.load();
    impl.save = async () => {
      throw new Error('disk');
    };
    controller.scheduleSave(s1);
    await controller.flush();
    impl.save = async () => undefined;
    controller.scheduleSave(s2);
    await controller.flush();
    expect(saves.map((s) => s.next)).toEqual([s1, s2]);
  });
});

/* ------------------------------------------------- replace, reset, dispose */

describe('replaceAll, unblockAfterReset and dispose', () => {
  test('replaceAll waits for the save in flight, drops the waiting change, and becomes prev', async () => {
    const { controller, impl, writes, saves, replaced } = setup(loads.empty());
    await controller.load();
    const inFlight = deferred<void>();
    impl.save = () => inFlight.promise;

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // s1 is being saved
    impl.save = async () => undefined;
    controller.scheduleSave(s2); // waiting in the debounce

    const restore = controller.replaceAll(s3);
    await settle();
    expect(replaced).toEqual([]); // not before the save in flight ends

    inFlight.resolve();
    await restore;
    expect(replaced).toEqual([s3]);
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    expect(writes).toEqual(['save', 'replaceAll']); // s2 was dropped

    controller.scheduleSave(s1);
    await controller.flush();
    expect(saves[saves.length - 1]).toEqual({ next: s1, prev: s3 });
  });

  test('a failed replaceAll rejects for the caller and the chain keeps working', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    impl.replaceAll = async () => {
      throw new Error('transaction rolled back');
    };
    await expect(controller.replaceAll(s1)).rejects.toThrow('rolled back');

    controller.scheduleSave(s2);
    await controller.flush();
    expect(saves).toEqual([{ next: s2, prev: null }]); // prev is still "nothing saved"
  });

  test('unblockAfterReset re-enables saving', async () => {
    const { controller, saves, replaced } = setup(loads.fails());
    await controller.load();
    expect(controller.status).toBe('read-blocked');

    // Factory reset: the user chose to start again.
    controller.unblockAfterReset();
    expect(controller.status).toBe('ready');
    expect(controller.canSave).toBe(true);
    expect(controller.error).toBeNull();

    await controller.replaceAll(s1);
    expect(replaced).toEqual([s1]);
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([{ next: s2, prev: s1 }]);
  });

  test('unblockAfterReset sends onError(null): the block is over', async () => {
    const { controller, errors } = setup(loads.fails());
    await controller.load();
    expect(errors).toEqual(['read']);
    controller.unblockAfterReset();
    expect(errors).toEqual(['read', null]);
    controller.unblockAfterReset(); // not blocked any more → does nothing, sends nothing
    expect(errors).toEqual(['read', null]);
  });

  test('unblockAfterReset does nothing while loading or ready', async () => {
    const gate = deferred<LoadResult>();
    const { controller } = setup(() => gate.promise);
    const loading = controller.load();
    controller.unblockAfterReset();
    expect(controller.status).toBe('loading');
    expect(controller.canSave).toBe(false);

    gate.resolve({ kind: 'empty' });
    await loading;
    controller.unblockAfterReset();
    expect(controller.status).toBe('ready');
  });

  test('dispose: the waiting change is dropped and nothing is written after it', async () => {
    const { controller, writes } = setup(loads.empty());
    await controller.load();
    controller.scheduleSave(s1);
    controller.dispose();
    expect(controller.canSave).toBe(false);

    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    controller.scheduleSave(s2);
    await controller.flush();
    await expect(controller.replaceAll(s3)).rejects.toThrow('writes are blocked');
    expect(writes).toEqual([]);
  });

  test('flush() then dispose() in the same tick (a React cleanup, no await) still saves the last change', async () => {
    const { controller, saves } = setup(loads.empty());
    await controller.load();
    controller.scheduleSave(s1);

    // A cleanup function cannot await: flush() only QUEUES the save, then dispose() runs at once.
    void controller.flush();
    controller.dispose();
    await settle();
    expect(saves).toEqual([{ next: s1, prev: null }]);

    // dispose() still blocks every NEW write.
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    await controller.flush();
    expect(saves).toHaveLength(1);
  });

  test('dispose: a save already queued behind a running save still finishes', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    const first = deferred<void>();
    impl.save = () => first.promise;

    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // s1 is being saved
    impl.save = async () => undefined;
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // s2 is queued behind s1
    expect(saves).toHaveLength(1);

    controller.dispose();
    first.resolve();
    await settle();
    expect(saves).toEqual([
      { next: s1, prev: null },
      { next: s2, prev: s1 },
    ]);
  });
});

/* ------------------------------------------- resume (W2-1 review round 1) */

describe('resume after dispose (a React effect that runs setup → cleanup → setup)', () => {
  test('flush → dispose → resume: the last change is saved once, and new changes are saved again', async () => {
    const { controller, saves } = setup(loads.empty());
    await controller.load();
    controller.scheduleSave(s1);
    void controller.flush(); // the cleanup …
    controller.dispose();
    controller.resume(); // … and the setup again
    expect(controller.canSave).toBe(true);
    await settle();
    expect(saves).toEqual([{ next: s1, prev: null }]);

    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([
      { next: s1, prev: null },
      { next: s2, prev: s1 },
    ]);
  });

  test('resume keeps every gate: before ready and while read-blocked nothing is written', async () => {
    const early = setup(loads.empty());
    early.controller.dispose();
    early.controller.resume();
    early.controller.scheduleSave(s1); // before ready (debounce gate)
    await early.controller.flush(); // before ready (flushSave gate)
    expect(early.writes).toEqual([]);
    await early.controller.load(); // a load after resume works
    expect(early.controller.status).toBe('ready');

    const blocked = setup(loads.fails());
    await blocked.controller.load();
    blocked.controller.dispose();
    blocked.controller.resume();
    expect(blocked.controller.status).toBe('read-blocked');
    blocked.controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    await blocked.controller.flush();
    expect(blocked.writes).toEqual([]); // C1 still holds
  });

  test('a load that ends while disposed still makes the controller ready for resume', async () => {
    const gate = deferred<LoadResult>();
    const { controller, saves } = setup(() => gate.promise);
    const loading = controller.load();
    controller.dispose();
    gate.resolve({ kind: 'doc', value: s1 });
    await loading;
    expect(controller.canSave).toBe(false); // disposed
    controller.resume();
    controller.scheduleSave(s1); // the loaded state itself: the disk holds it already
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([]);
    controller.scheduleSave(s2);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([{ next: s2, prev: s1 }]);
  });
});

describe('judgeDocument (one rule for load() and persistence.ts decideLoad)', () => {
  const ctx = { raw: '{}', now: FIXED_NOW };

  test('ok → use it; too-new → blocked "too-new"; invalid → corrupt', () => {
    expect(judgeDocument(okDecode, s1, ctx)).toEqual({ kind: 'ok', decoded: { kind: 'ok', state: s1 } });
    expect(judgeDocument(() => ({ kind: 'too-new', version: 9 }), {}, ctx)).toEqual({
      kind: 'blocked',
      reason: 'too-new',
    });
    expect(judgeDocument(() => ({ kind: 'invalid' }), {}, ctx)).toEqual({ kind: 'corrupt' });
  });

  test('a decode that throws → blocked "migrate" with the cause, never corrupt; it never throws itself', () => {
    const bug = new Error('bug in a migration step');
    const verdict = judgeDocument(
      () => {
        throw bug;
      },
      {},
      ctx,
    );
    expect(verdict).toEqual({ kind: 'blocked', reason: 'migrate', cause: bug });
  });

  test('decode gets the value, the raw text and the time', () => {
    const decode = jest.fn(okDecode);
    judgeDocument(decode, s2, ctx);
    expect(decode).toHaveBeenCalledWith(s2, ctx);
  });
});

/* --------------------------------------- prev after boot (W2-1 carry-over) */

describe('prev after a loaded boot (W2-1)', () => {
  test('the loaded state is prev of the first save: a row port writes only what changed', async () => {
    const { controller, saves } = setup(loads.doc(s1, '{"raw":1}'));
    const boot = await controller.load();
    expect(boot.kind).toBe('loaded');
    controller.scheduleSave(s2);
    await controller.flush();
    expect(saves).toEqual([{ next: s2, prev: s1 }]);
  });

  test('saving the very state that was loaded writes nothing (the disk holds it already)', async () => {
    const { controller, writes, errors } = setup(loads.doc(s1, '{"raw":1}'));
    await controller.load();
    controller.scheduleSave(s1); // what the engine does when it puts the loaded state in its store
    await jest.advanceTimersByTimeAsync(10 * SAVE_DEBOUNCE_MS);
    await controller.flush();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('decode CHANGED the document (older schema, repairs) → prev is null: the first save writes everything', async () => {
    const { controller, saves } = setup(loads.doc({ old: true }, '{"old":true}'), {
      decode: () => ({ kind: 'ok', state: s1, from: 1, repaired: [], changed: true }),
    });
    await controller.load();
    controller.scheduleSave(s1); // the migrated state itself IS saved: the disk holds the old schema
    await controller.flush();
    expect(saves).toEqual([{ next: s1, prev: null }]);
  });

  test('first boot and corrupt boots keep prev null (nothing usable is on the disk)', async () => {
    const empty = setup(loads.empty());
    const first = await empty.controller.load();
    if (first.kind !== 'first-boot') throw new Error('expected first-boot');
    empty.controller.scheduleSave(first.state);
    await empty.controller.flush();
    expect(empty.saves).toEqual([{ next: first.state, prev: null }]);

    const corrupt = setup(loads.corrupt('{"cards":['));
    const boot = await corrupt.controller.load();
    if (boot.kind !== 'corrupt') throw new Error('expected corrupt');
    await corrupt.controller.flush();
    expect(corrupt.saves).toEqual([{ next: boot.state, prev: null }]);
  });

  test('"Try again" that loads: prev is the newly loaded state', async () => {
    let fail = true;
    const { controller, saves } = setup(async (): Promise<LoadResult> => {
      if (fail) throw new Error('CursorWindow');
      return { kind: 'doc', value: s2 };
    });
    expect((await controller.load()).kind).toBe('blocked');
    fail = false;
    expect((await controller.load()).kind).toBe('loaded');
    controller.scheduleSave(s3);
    await controller.flush();
    expect(saves).toEqual([{ next: s3, prev: s2 }]);
  });
});

describe('a failed replaceAll is a write error (M15, W2-1)', () => {
  test('onError("write"), and the next flush saves the replacement again', async () => {
    const { controller, impl, saves, errors } = setup(loads.empty());
    await controller.load();
    impl.replaceAll = async () => {
      throw new Error('disk full');
    };
    await expect(controller.replaceAll(s1)).rejects.toThrow('disk full');
    expect(controller.error).toBe('write');
    expect(errors).toEqual(['write']);

    // No new change, but the replacement is not on the disk: flush tries again.
    await controller.flush();
    expect(saves).toEqual([{ next: s1, prev: null }]);
    expect(controller.error).toBeNull();
    expect(errors).toEqual(['write', null]);
  });

  test('a newer change after the failed replaceAll wins: the old replacement is not written over it', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    impl.replaceAll = async () => {
      throw new Error('disk full');
    };
    const restore = controller.replaceAll(s1);
    controller.scheduleSave(s2); // queued while the replacement is still running
    await expect(restore).rejects.toThrow('disk full');
    await controller.flush();
    expect(saves.map((s) => s.next)).toEqual([s2]);
  });
});

describe('flush() says whether the newest write committed (W2 hardening)', () => {
  // flush() never rejects (a React cleanup and the AppState listener call it
  // without a catch), so it RESOLVES the result. The Restore flow uses it:
  // "Restored — …" only when the replace-all really reached the disk.

  test('a good save → { ok: true }; nothing new to write → { ok: true }', async () => {
    const { controller, saves } = setup(loads.empty());
    await controller.load();
    controller.scheduleSave(s1);
    await expect(controller.flush()).resolves.toEqual({ ok: true });
    expect(saves).toHaveLength(1);
    await expect(controller.flush()).resolves.toEqual({ ok: true });
    expect(saves).toHaveLength(1);
  });

  test('a save that fails → { ok: false, reason: "write" } with the cause; the retry → { ok: true } (M15)', async () => {
    const { controller, impl, errors } = setup(loads.empty());
    await controller.load();
    const cause = new Error('SQLITE_FULL');
    let fail = true;
    impl.save = async () => {
      if (fail) throw cause;
    };
    controller.scheduleSave(s1);
    await expect(controller.flush()).resolves.toEqual({ ok: false, reason: 'write', cause });
    expect(errors).toEqual(['write']); // the UI is told too
    // The same unsaved state is tried again, and the result says so.
    await expect(controller.flush()).resolves.toEqual({ ok: false, reason: 'write', cause });
    fail = false;
    await expect(controller.flush()).resolves.toEqual({ ok: true });
    expect(errors).toEqual(['write', 'write', null]);
  });

  test('a failed replaceAll → the flush after it resolves the failure, then the retry saves it', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    const cause = new Error('disk full');
    impl.replaceAll = async () => {
      throw cause;
    };
    const restore = controller.replaceAll(s1);
    const flushed = controller.flush(); // what the Restore flow does right after restore()
    await expect(restore).rejects.toBe(cause);
    await expect(flushed).resolves.toEqual({ ok: false, reason: 'write', cause });
    expect(controller.error).toBe('write');
    // The next flush writes the replacement as a normal save (prev null: the
    // failed transaction changed nothing on the disk).
    await expect(controller.flush()).resolves.toEqual({ ok: true });
    expect(saves).toEqual([{ next: s1, prev: null }]);
  });

  test('a good replaceAll → { ok: true } only after it is on the disk', async () => {
    const { controller, impl } = setup(loads.empty());
    await controller.load();
    const disk = deferred<void>();
    impl.replaceAll = () => disk.promise;
    void controller.replaceAll(s1);
    let result: unknown = 'not yet';
    void controller.flush().then((r) => {
      result = r;
    });
    await settle();
    expect(result).toBe('not yet');
    disk.resolve();
    await settle();
    expect(result).toEqual({ ok: true });
  });

  test('the result is the NEWEST write: an older failed save followed by a good one → { ok: true }', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    impl.save = async (next) => {
      if (next === s1) throw new Error('busy');
    };
    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); // s1 fails
    controller.scheduleSave(s2);
    await expect(controller.flush()).resolves.toEqual({ ok: true });
    expect(saves.map((s) => s.next)).toEqual([s1, s2]);
  });

  test('blocked → { ok: false, reason: "blocked" } and nothing is written: before ready, read-blocked, after dispose', async () => {
    const gate = deferred<LoadResult>();
    const loading = setup(() => gate.promise);
    void loading.controller.load();
    loading.controller.scheduleSave(s1);
    await expect(loading.controller.flush()).resolves.toEqual({ ok: false, reason: 'blocked' });

    const blocked = setup(loads.fails());
    await blocked.controller.load();
    blocked.controller.scheduleSave(s1);
    await expect(blocked.controller.flush()).resolves.toEqual({ ok: false, reason: 'blocked' });

    const disposed = setup(loads.empty());
    await disposed.controller.load();
    disposed.controller.dispose();
    await expect(disposed.controller.flush()).resolves.toEqual({ ok: false, reason: 'blocked' });

    expect([...loading.writes, ...blocked.writes, ...disposed.writes]).toEqual([]);
  });

  test('flush(); dispose(); in one tick (a React cleanup) still resolves the queued write', async () => {
    const { controller, saves } = setup(loads.empty());
    await controller.load();
    controller.scheduleSave(s1);
    const last = controller.flush();
    controller.dispose();
    await expect(last).resolves.toEqual({ ok: true });
    expect(saves).toEqual([{ next: s1, prev: null }]);
  });
});

/* ------------------------------------------------------- writes in flight (unit P4) */

describe('unit P4 — persistWrites: idle work can wait until a save is written (WHAT and WHEN are unchanged)', () => {
  test('busy() while a save is written; onIdle once, right after it; the same state, the same moment, the same result', async () => {
    const { controller, impl, saves } = setup(loads.empty());
    await controller.load();
    const gate = deferred<void>();
    impl.save = () => gate.promise;
    const idle = jest.fn();
    expect(persistWrites.busy()).toBe(false);
    controller.scheduleSave(s1);
    // The debounce is unchanged: nothing is written before 400 ms.
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(saves).toEqual([]);
    expect(persistWrites.busy()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([{ next: s1, prev: null }]);
    expect(persistWrites.busy()).toBe(true);
    persistWrites.onIdle(idle);
    await settle();
    expect(idle).not.toHaveBeenCalled();
    gate.resolve();
    await settle();
    expect(persistWrites.busy()).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    // The next flush writes nothing new (s1 is on the disk): the save went through as before.
    await expect(controller.flush()).resolves.toEqual({ ok: true });
    expect(saves).toHaveLength(1);
  });

  test('a save that fails ends the write too (M15 is unchanged); a removed listener is not called; a throwing one breaks nothing', async () => {
    const { controller, impl, errors, saves } = setup(loads.empty());
    await controller.load();
    impl.save = async () => {
      throw new Error('disk full');
    };
    const removed = jest.fn();
    const after = jest.fn();
    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await settle();
    expect(errors).toEqual(['write']);
    expect(persistWrites.busy()).toBe(false);
    // While the retry is written: one listener throws, one is removed, one waits.
    const gate = deferred<void>();
    impl.save = () => gate.promise;
    const flushed = controller.flush();
    await settle();
    expect(persistWrites.busy()).toBe(true);
    persistWrites.onIdle(() => {
      throw new Error('a broken listener');
    });
    const off = persistWrites.onIdle(removed);
    persistWrites.onIdle(after);
    off();
    gate.resolve();
    await expect(flushed).resolves.toEqual({ ok: true });
    expect(saves.map((s) => s.next)).toEqual([s1, s1]);
    expect(errors).toEqual(['write', null]);
    expect(removed).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });

  test('a replaceAll (restore) is a write too; a failed one still ends it', async () => {
    const { controller, impl } = setup(loads.empty());
    await controller.load();
    const gate = deferred<void>();
    impl.replaceAll = () => gate.promise;
    const done = controller.replaceAll(s2);
    await settle();
    expect(persistWrites.busy()).toBe(true);
    gate.reject(new Error('no space'));
    await expect(done).rejects.toThrow('no space');
    expect(persistWrites.busy()).toBe(false);
  });

  test('nothing to write (the state on the disk) is no write: busy() stays false', async () => {
    const { controller, saves } = setup(loads.doc(s1));
    await controller.load();
    controller.scheduleSave(s1);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(persistWrites.busy()).toBe(false);
    expect(saves).toEqual([]);
  });
});
