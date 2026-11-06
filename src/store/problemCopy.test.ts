/**
 * Pins the words of the crash screen and the data-problem screen (spec W1-4,
 * §3.10), and the "Save a copy" logic of rescueExport.ts with a fake disk.
 *
 * Why the copy is pinned: these screens are seen when something already went
 * wrong. A changed word ("Nothing was changed.") changes what the user believes
 * about their data, so a text change must be a deliberate test change.
 */
import { describe, expect, jest, test } from '@jest/globals';

import type { PersistError } from './actions';
import {
  CRASH_COPY,
  DATA_PROBLEM_COPY,
  dataProblemOf,
  PROBLEM_BUTTON,
  rescueMessage,
} from './problemCopy';
import { RescueIO, rescueExportWith, rescueFileName } from './rescueExport';

// rescueExport.ts imports AsyncStorage for the real device read. Jest has no
// native AsyncStorage, so use the library's own in-memory mock. The tests below
// never touch it: they pass a fake RescueIO.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('DataProblemScreen copy (spec §3.10)', () => {
  test('read', () => {
    expect(DATA_PROBLEM_COPY.read.title).toBe("We couldn't open your saved data.");
    expect(DATA_PROBLEM_COPY.read.body).toBe(
      'Your cards are still on this phone. Nothing was changed.',
    );
  });

  test('too-new', () => {
    expect(DATA_PROBLEM_COPY['too-new'].title).toBe(
      'This data was saved by a newer version of Maranki.',
    );
    expect(DATA_PROBLEM_COPY['too-new'].body).toBe('Please update the app. Nothing was changed.');
  });

  test('migrate', () => {
    expect(DATA_PROBLEM_COPY.migrate.title).toBe("We couldn't update your data to this version.");
    expect(DATA_PROBLEM_COPY.migrate.body).toBe('Nothing was changed. Please send us a copy.');
  });

  test('button labels', () => {
    expect(PROBLEM_BUTTON).toEqual({
      retry: 'Try again',
      rescue: 'Save a copy of the raw data',
      help: 'Help',
    });
  });

  test('read and migrate offer Try again, the raw copy and Help; too-new cannot be retried', () => {
    expect(DATA_PROBLEM_COPY.read.actions).toEqual(['retry', 'rescue', 'help']);
    expect(DATA_PROBLEM_COPY.migrate.actions).toEqual(['retry', 'rescue', 'help']);
    expect(DATA_PROBLEM_COPY['too-new'].actions).toEqual(['rescue', 'help']);
  });

  test('every problem has help text that warns against uninstalling', () => {
    for (const copy of Object.values(DATA_PROBLEM_COPY)) {
      expect(copy.help.length).toBeGreaterThan(0);
      expect(copy.help[copy.help.length - 1]).toMatch(/Do not uninstall Maranki/);
    }
  });
});

describe('ErrorScreen copy (spec W1-4)', () => {
  test('title, body and buttons', () => {
    expect(CRASH_COPY).toEqual({
      title: 'Something went wrong',
      body: 'Your cards and progress are saved. You can try again, or save a copy of your data first.',
      retry: 'Try again',
      rescue: 'Save a copy of my data',
    });
  });
});

describe('dataProblemOf', () => {
  test('read / too-new / migrate block the app; write and null do not', () => {
    const cases: [PersistError, string | null][] = [
      ['read', 'read'],
      ['too-new', 'too-new'],
      ['migrate', 'migrate'],
      ['write', null],
      [null, null],
    ];
    for (const [error, problem] of cases) expect(dataProblemOf(error)).toBe(problem);
  });
});

describe('rescueMessage', () => {
  test('one line per outcome; the share sheet itself needs no line', () => {
    expect(rescueMessage({ kind: 'shared', fileName: 'a.json' })).toBeNull();
    expect(rescueMessage({ kind: 'saved', fileName: 'a.json' })).toBe(
      'Sharing is not available, so the copy was saved inside Maranki as a.json.',
    );
    expect(rescueMessage({ kind: 'nothing' })).toBe('There is no saved data on this phone to copy.');
    expect(rescueMessage({ kind: 'read-failed' })).toBe(
      "We couldn't read the saved data, so no copy was made. Your cards are still on this phone.",
    );
    expect(rescueMessage({ kind: 'write-failed' })).toBe(
      "We couldn't write the copy. Your phone may be out of storage.",
    );
  });
});

/* ------------------------------------------------- rescueExportWith */

// 2026-10-23 21:04:07 on the phone's clock (local time: the learner sees the name, wave 5b L8)
const NOW = new Date(2026, 9, 23, 21, 4, 7).getTime();
const FILE_NAME = 'maranki-raw-data-2026-10-23-21-04-07.json';

interface FakeIO extends RescueIO {
  writes: { place: 'cache' | 'backups'; name: string; text: string }[];
  shared: string[];
}

/** A fake disk + share sheet that records every call. */
function fakeIO(opts: {
  raw?: string | null;
  readFails?: boolean;
  canShare?: boolean;
  shareFails?: boolean;
  failWritesTo?: ('cache' | 'backups')[];
}): FakeIO {
  const io: FakeIO = {
    writes: [],
    shared: [],
    readRaw: () =>
      opts.readFails
        ? Promise.reject(new Error('Row too big to fit into CursorWindow'))
        : Promise.resolve(opts.raw ?? null),
    writeFile(place, name, text) {
      if (opts.failWritesTo?.includes(place)) throw new Error('disk full');
      io.writes.push({ place, name, text });
      return `file:///${place}/${name}`;
    },
    shareAvailable: () => Promise.resolve(opts.canShare ?? true),
    share(uri) {
      if (opts.shareFails) return Promise.reject(new Error('share busy'));
      io.shared.push(uri);
      return Promise.resolve();
    },
  };
  return io;
}

describe('rescueExportWith', () => {
  test('file name carries a sortable stamp in local time', () => {
    expect(rescueFileName(NOW)).toBe(FILE_NAME);
  });

  test('stored text → written to the cache unchanged and shared', async () => {
    const raw = '{"cards":[{"front":"die Stunde"}],"decks":[]}';
    const io = fakeIO({ raw });
    await expect(rescueExportWith(io, NOW)).resolves.toEqual({
      kind: 'shared',
      fileName: FILE_NAME,
    });
    expect(io.writes).toEqual([{ place: 'cache', name: FILE_NAME, text: raw }]);
    expect(io.shared).toEqual([`file:///cache/${FILE_NAME}`]);
  });

  test('broken text is copied byte for byte (never parsed or repaired)', async () => {
    const raw = '{"cards":[1,2,3'; // a write cut short by an OS kill
    const io = fakeIO({ raw });
    await rescueExportWith(io, NOW);
    expect(io.writes[0].text).toBe(raw);
  });

  test('nothing stored → nothing, and no file is written', async () => {
    for (const raw of [null, '']) {
      const io = fakeIO({ raw });
      await expect(rescueExportWith(io, NOW)).resolves.toEqual({ kind: 'nothing' });
      expect(io.writes).toEqual([]);
      expect(io.shared).toEqual([]);
    }
  });

  test('the read fails → read-failed, and no file is written', async () => {
    const io = fakeIO({ readFails: true });
    await expect(rescueExportWith(io, NOW)).resolves.toEqual({ kind: 'read-failed' });
    expect(io.writes).toEqual([]);
  });

  test('sharing not available → the copy is kept in backups/', async () => {
    const io = fakeIO({ raw: '{}', canShare: false });
    await expect(rescueExportWith(io, NOW)).resolves.toEqual({
      kind: 'saved',
      fileName: FILE_NAME,
    });
    expect(io.writes).toEqual([{ place: 'backups', name: FILE_NAME, text: '{}' }]);
    expect(io.shared).toEqual([]);
  });

  test('the share sheet fails → the copy is still kept in backups/', async () => {
    const io = fakeIO({ raw: '{}', shareFails: true });
    await expect(rescueExportWith(io, NOW)).resolves.toEqual({
      kind: 'saved',
      fileName: FILE_NAME,
    });
    expect(io.writes.map((w) => w.place)).toEqual(['cache', 'backups']);
  });

  test('the cache write fails → backups/ is tried', async () => {
    const io = fakeIO({ raw: '{}', failWritesTo: ['cache'] });
    await expect(rescueExportWith(io, NOW)).resolves.toEqual({
      kind: 'saved',
      fileName: FILE_NAME,
    });
    expect(io.shared).toEqual([]);
  });

  test('every write fails → write-failed (never a rejection)', async () => {
    const io = fakeIO({ raw: '{}', failWritesTo: ['cache', 'backups'] });
    await expect(rescueExportWith(io, NOW)).resolves.toEqual({ kind: 'write-failed' });
  });

  test('shareAvailable rejecting counts as "no share sheet"', async () => {
    const io = fakeIO({ raw: '{}' });
    io.shareAvailable = () => Promise.reject(new Error('no activity'));
    await expect(rescueExportWith(io, NOW)).resolves.toEqual({
      kind: 'saved',
      fileName: FILE_NAME,
    });
  });
});
