/**
 * Tests for the study history (src/store/history.ts, spec §3.8, §8.4, §8.8,
 * unit W3-3): the review CSV and the sessions CSV of "Export study
 * history", the zip that carries both, and the CardSheet "History" line —
 * read from a real row port (memory RowDb), so the rows are the ones a save
 * really writes. The zip is also built in simulated time zones from UTC-12
 * to UTC+14 (`inTimeZone`): its date must be valid on every phone, not only
 * in the zone of the test machine (review round 1). Its NAME says the
 * phone's local time in every zone too (wave 5d, L8).
 */
import { describe, expect, jest, test } from '@jest/globals';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { BUILTIN_TYPE_IDS, builtinType } from '../domain/builtinTypes';
import type { DataStateV3, RevlogRow } from '../domain/model';
import { localTime } from '../test/clock';
import { makeDeckV3, noteWithCards, stateOfV3 } from '../test/factoriesV3';
import { historyZipFileName, SESSIONS_CSV_HEADER } from './backup';
import * as historyModule from './history';
import {
  cardHistory,
  cardHistoryLine,
  daysAgo,
  directionName,
  historyCsv,
  historyFiles,
  historyFilesOf,
  historyZip,
  historyZipEpoch,
  localDateTime,
  REVIEWS_CSV_HEADER,
  reviewsCsv,
  sessionsCsvOf,
  summarizeCardHistory,
} from './history';
import { markKnown, rateCard } from './reducer';
import { createMemoryStore } from './storage/memoryPort';
import { diffState } from './storage/rowDiff';
import { createMemoryRowDb, createRowPort } from './storage/rowStore';

// history.ts imports the storage index (for appRevlogStore), which imports
// the AsyncStorage port: jest needs the library's in-memory mock.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const NOW = localTime('2026-10-21', '18:04');

/** A German deck: one Basic + reverse note (2 directions) and one Basic note. */
function library(): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1', name: 'German' });
  const reise = noteWithCards({
    deckId: 'd1',
    typeId: BUILTIN_TYPE_IDS.basicReverse,
    fields: ['die Reise', 'the trip', '', ''],
    note: { id: 'n1' },
    card: (ord) => ({ id: `c1-${ord}`, lapses: ord === 0 ? 1 : 0 }),
  });
  const formula = noteWithCards({ deckId: 'd1', fields: ['=HYPERLINK("x")', 'y', '', ''], note: { id: 'n2' }, card: { id: 'c2' } });
  return stateOfV3({
    decks: [deck],
    groups: [reise, formula],
    types: [builtinType('basic', NOW), builtinType('basicReverse', NOW)],
    overrides: {
      sessions: [
        { id: 's2', dayKey: '2026-10-21', atMs: NOW, kind: 'practice', counts: { again: 0, hard: 0, good: 2, easy: 0 }, total: 2, bestRun: 2, xp: 0, mode: 'mc' },
        { id: 's1', dayKey: '2026-10-20', atMs: NOW - 86_400_000, kind: 'scheduled', counts: { again: 1, hard: 0, good: 2, easy: 1 }, total: 4, bestRun: 2, xp: 40 },
      ],
    },
  });
}

function row(seq: number, cardId: string, over: Partial<RevlogRow> = {}): RevlogRow {
  return {
    seq,
    cardId,
    deckId: 'd1',
    atMs: NOW - (10 - seq) * 86_400_000,
    rating: 'good',
    bucket: 'review',
    ivlBefore: 2,
    ivlAfter: 5.25,
    easeAfter: 2.456,
    durationMs: 3450,
    ...over,
  };
}

/** The text of a CSV without its BOM, as lines. */
const lines = (csv: string) => csv.replace(/^﻿/, '').trimEnd().split('\r\n');

/**
 * Run `fn` as if the phone were in a time zone `offsetMin` minutes EAST of
 * UTC (New York in winter = -300). jest cannot change the time zone of its
 * own process, so the global Date is replaced for a moment by one whose
 * LOCAL parts (`new Date(y, m, d, h …)`, getFullYear … getSeconds) use that
 * offset. fflate builds the zip date from exactly these parts, so this
 * shows what a phone in that zone would get — on any test machine.
 */
function inTimeZone<T>(offsetMin: number, fn: () => T): T {
  const RealDate = Date;
  const shift = offsetMin * 60_000;
  const local = (ms: number) => new RealDate(ms + shift);
  class ZonedDate extends RealDate {
    constructor(...args: number[]) {
      super(
        args.length === 0
          ? RealDate.now()
          : args.length === 1
            ? args[0]
            : RealDate.UTC(args[0], args[1], args[2] ?? 1, args[3] ?? 0, args[4] ?? 0, args[5] ?? 0, args[6] ?? 0) - shift,
      );
    }
    getFullYear() {
      return local(this.getTime()).getUTCFullYear();
    }
    getMonth() {
      return local(this.getTime()).getUTCMonth();
    }
    getDate() {
      return local(this.getTime()).getUTCDate();
    }
    getHours() {
      return local(this.getTime()).getUTCHours();
    }
    getMinutes() {
      return local(this.getTime()).getUTCMinutes();
    }
    getSeconds() {
      return local(this.getTime()).getUTCSeconds();
    }
  }
  globalThis.Date = ZonedDate as unknown as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** The file date of the FIRST zip entry (its local header, bytes 10-13), as 'YYYY-MM-DD HH:mm:ss'. */
function zipEntryDate(zip: Uint8Array): string {
  const time = zip[10] | (zip[11] << 8);
  const date = zip[12] | (zip[13] << 8);
  const two = (n: number) => `${n}`.padStart(2, '0');
  const day = `${1980 + (date >> 9)}-${two((date >> 5) & 15)}-${two(date & 31)}`;
  return `${day} ${two(time >> 11)}:${two((time >> 5) & 63)}:${two((time & 31) * 2)}`;
}

/** Time zones from UTC-12 to UTC+14 (in minutes east of UTC), with the half and quarter hours. */
const ZONES = [-720, -600, -480, -300, -210, -180, 0, 60, 180, 330, 345, 540, 630, 780, 840];

describe('reviewsCsv — one row per rating', () => {
  test('the exact header of spec §8.8', () => {
    expect(REVIEWS_CSV_HEADER).toEqual(['date', 'deck', 'front', 'direction', 'rating', 'interval_before', 'interval_after', 'ease_after', 'seconds']);
  });

  test('date, deck, front (rendered from the note), direction, rating, intervals, ease and seconds; oldest first', () => {
    const csv = reviewsCsv([row(3, 'c1-1', { rating: 'again', durationMs: null }), row(2, 'c1-0')], library());
    const [header, first, second] = lines(csv);
    expect(header).toBe(REVIEWS_CSV_HEADER.join(','));
    expect(first).toBe(`${localDateTime(row(2, 'c1-0').atMs)},German,die Reise,Front → Back,good,2,5.25,2.46,3.5`);
    expect(second).toBe(`${localDateTime(row(3, 'c1-1').atMs)},German,the trip,Back → Front,again,2,5.25,2.46,`);
  });

  test('a card that was deleted keeps its history row, with empty deck-independent cells', () => {
    const csv = reviewsCsv([row(1, 'gone', { deckId: 'deleted-deck' })], library());
    expect(lines(csv)[1]).toBe(`${localDateTime(row(1, 'gone').atMs)},,,,good,2,5.25,2.46,3.5`);
  });

  test('a front that looks like a formula is guarded (CSV injection)', () => {
    const csv = reviewsCsv([row(1, 'c2')], library());
    expect(lines(csv)[1]).toContain(`,"'=HYPERLINK(""x"")",`);
  });

  test('a custom frontOf is used for the front cell', () => {
    const csv = reviewsCsv([row(1, 'c2')], library(), (card) => `#${card.id}`);
    expect(lines(csv)[1].split(',')[2]).toBe('#c2');
  });

  test('the front of a card is rendered ONCE per card, not once per rating (73k rows a year)', () => {
    const frontOf = jest.fn((card: { id: string }) => `#${card.id}`);
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, ['c1-0', 'c1-1', 'c2'][i % 3]));
    const csv = reviewsCsv(rows, library(), frontOf);
    expect(frontOf).toHaveBeenCalledTimes(3);
    const body = lines(csv).slice(1);
    expect(body).toHaveLength(30);
    expect(body.map((l) => l.split(',')[2])).toEqual(rows.map((r) => `#${r.cardId}`));
    expect(body.map((l) => l.split(',')[3])).toEqual(rows.map((r) => (r.cardId === 'c1-1' ? 'Back → Front' : 'Front → Back')));
  });

  test('directionName: the template name, "Cloze n" for cloze cards, "" when unknown', () => {
    expect(directionName(builtinType('basicReverse', NOW), 1)).toBe('Back → Front');
    expect(directionName(builtinType('cloze', NOW), 2)).toBe('Cloze 3');
    expect(directionName(undefined, 0)).toBe('');
    expect(directionName(builtinType('basic', NOW), 5)).toBe('');
  });

  test('localDateTime is the phone\'s local date and time', () => {
    expect(localDateTime(localTime('2026-03-04', '07:09'))).toBe('2026-03-04 07:09');
  });
});

describe('the history export files', () => {
  test('historyFilesOf: sessions.csv (the wave-2 builder) and reviews.csv', () => {
    const state = library();
    const files = historyFilesOf(state, [row(1, 'c2')]);
    expect(files.map((f) => f.name)).toEqual(['sessions.csv', 'reviews.csv']);
    expect(files[0].text).toBe(sessionsCsvOf(state.sessions));
    // Oldest first, with the v3 mode column.
    expect(lines(files[0].text).slice(1)).toEqual(['2026-10-20,scheduled,,4,1,0,2,1,,40', '2026-10-21,practice,mc,2,0,0,2,0,,0']);
    expect(lines(files[0].text)[0]).toBe(SESSIONS_CSV_HEADER.join(','));
    expect(lines(files[1].text)).toHaveLength(2);
  });

  test('historyZip holds both files, byte for byte (BOM included), and the same files give the same bytes', () => {
    const files = historyFilesOf(library(), [row(1, 'c2'), row(2, 'c1-0')]);
    const zip = historyZip(files);
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(['reviews.csv', 'sessions.csv']);
    // The bytes keep the UTF-8 BOM (EF BB BF) that makes Excel read "über" right.
    expect([...out['reviews.csv'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(out['reviews.csv']).toEqual(strToU8(files[1].text));
    expect(out['sessions.csv']).toEqual(strToU8(files[0].text));
    expect(strFromU8(out['reviews.csv']).replace(/^\uFEFF/, '')).toBe(files[1].text.replace(/^\uFEFF/, ''));
    expect(historyZip(files)).toEqual(zip);
  });

  test('the zip date is 1980-01-02 12:00 in LOCAL time (the zip format stores local dates, 1980-2099 only)', () => {
    const zip = historyZip(historyFilesOf(library(), [row(1, 'c2')]));
    expect(zipEntryDate(zip)).toBe('1980-01-02 12:00:00');
    const d = new Date(historyZipEpoch());
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([1980, 0, 2, 12]);
  });

  test('historyZip works in EVERY time zone (also west of UTC), with the same bytes everywhere', () => {
    const files = historyFilesOf(library(), [row(1, 'c2'), row(2, 'c1-0')]);
    const here = historyZip(files);
    for (const zone of ZONES) {
      const zip = inTimeZone(zone, () => historyZip(files));
      expect([zone, zipEntryDate(zip)]).toEqual([zone, '1980-01-02 12:00:00']);
      expect([zone, zip]).toEqual([zone, here]);
      expect(Object.keys(unzipSync(zip)).sort()).toEqual(['reviews.csv', 'sessions.csv']);
    }
    // The bug this guards against: a UTC date is 31 Dec 1979 in New York, and fflate throws.
    expect(() => inTimeZone(-300, () => zipSync({ 'a.csv': strToU8('a') }, { mtime: Date.UTC(1980, 0, 1) }))).toThrow(
      'date not in range 1980-2099',
    );
  });

  // Wave 5d (L8): history.ts had its own zip name in UTC (`historyZipName`), which no screen used,
  // and a UTC name looks like the wrong time to the learner. The ONE name of the history zip is
  // backup.ts `historyZipFileName` (both history exports use it), in the phone's LOCAL time.
  test('the history zip is named in the phone’s LOCAL time (backup.ts historyZipFileName), in every time zone', () => {
    const T = Date.UTC(2026, 9, 21, 18, 4, 7);
    const two = (n: number) => String(n).padStart(2, '0');
    for (const zone of ZONES) {
      // The phone's wall clock in that zone, read with the UTC getters.
      const wall = new Date(T + zone * 60_000);
      const stamp = `${wall.getUTCFullYear()}-${two(wall.getUTCMonth() + 1)}-${two(wall.getUTCDate())}-${two(wall.getUTCHours())}-${two(wall.getUTCMinutes())}-${two(wall.getUTCSeconds())}`;
      expect([zone, inTimeZone(zone, () => historyZipFileName(T))]).toEqual([zone, `maranki-history-${stamp}.zip`]);
    }
    // Berlin (UTC+2 on 21 October): 20:04:07 on the phone, so the name says 20-04-07, not the UTC 18-04-07.
    expect(inTimeZone(120, () => historyZipFileName(T))).toBe('maranki-history-2026-10-21-20-04-07.zip');
    expect(inTimeZone(-300, () => historyZipFileName(T))).toBe('maranki-history-2026-10-21-13-04-07.zip');
    // history.ts makes no file name of its own any more: no second (UTC) name can come back from it.
    expect(Object.keys(historyModule)).not.toContain('historyZipName');
  });

  test('historyCsv / historyFiles read the rows that real saves wrote (a row port on a memory RowDb)', async () => {
    const state = library();
    const db = createMemoryRowDb();
    const port = createRowPort<DataStateV3>({
      open: async () => db,
      kv: createMemoryStore(),
      now: () => NOW,
      legacy: { readKv: async () => null, readAsyncStorage: async () => null },
    });
    await port.load();
    await port.save(state, null);
    // One rating of c2, saved as a diff.
    const c2 = state.cards.find((c) => c.id === 'c2')!;
    const rated: DataStateV3 = {
      ...state,
      cards: state.cards.map((c) => (c.id === 'c2' ? { ...c, intervalDays: 1, reps: 1 } : c)),
      reviewLog: [
        {
          id: 'r1',
          seq: 1,
          cardId: 'c2',
          deckId: 'd1',
          rating: 'easy',
          atMs: NOW,
          bucket: 'new',
          prev: { ease: c2.ease, intervalDays: 0, stepIndex: null, reps: 0, lapses: 0, due: c2.due, lastReviewedAt: null, knownAt: null, knownCheckedAt: null },
          durationMs: 2000,
        },
      ],
    };
    expect(diffState(state, rated).revlogPut).toHaveLength(1);
    await port.save(rated, state);
    const { sessions, reviews } = await historyCsv(rated, port.revlog);
    expect(sessions).toBe(sessionsCsvOf(rated.sessions));
    expect(lines(reviews)[1]).toBe(`${localDateTime(NOW)},German,"'=HYPERLINK(""x"")",Front → Back,easy,0,1,${Math.round(c2.ease * 100) / 100},2`);
    expect((await historyFiles(rated, port.revlog)).map((f) => f.name)).toEqual(['sessions.csv', 'reviews.csv']);
  });

  test('a history that cannot be read rejects (the screen says so; it never exports half a file)', async () => {
    const store = { forCard: async () => [], all: () => Promise.reject(new Error('disk I/O error')), write: async () => 0 };
    await expect(historyCsv(library(), store)).rejects.toThrow('disk I/O error');
  });
});

describe('the CardSheet "History" line', () => {
  test('summary: number of ratings, the lapses among them, and the newest rating', () => {
    // The Again halves the interval, as a lapse does (lapseMultiplier 0.5): 2 → 1 day.
    const rows = [row(2, 'c1-0', { rating: 'again', ivlAfter: 1 }), row(5, 'c1-0', { rating: 'good' }), row(3, 'c1-0')];
    expect(summarizeCardHistory(rows)).toEqual({
      reviews: 3,
      lapses: 1, // the Again of a card that had an interval
      last: { atMs: row(5, 'c1-0').atMs, rating: 'good' },
    });
    expect(summarizeCardHistory([])).toEqual({ reviews: 0, lapses: 0, last: null });
  });

  test('the reviews and the lapses come from the SAME rows: card.lapses (Anki\'s past too) is never read', async () => {
    // Imported from Anki with 9 lapses, then rated twice in Maranki.
    const imported = { id: 'c1-0', lapses: 9 };
    const store = { forCard: async () => [row(1, 'c1-0'), row(2, 'c1-0', { rating: 'hard' })], all: async () => [], write: async () => 0 };
    const history = await cardHistory(imported, store);
    expect(history).toMatchObject({ reviews: 2, lapses: 0 });
    expect(cardHistoryLine(history, NOW)).not.toContain('9 lapses');
    expect(history.lapses).toBeLessThanOrEqual(history.reviews);
  });

  test('what is a lapse: the scheduler\'s rule, read from the rows', () => {
    const lapses = (rows: RevlogRow[]) => summarizeCardHistory(rows).lapses;
    // A fresh card in its first learning steps has no interval yet: Again is not a lapse.
    expect(lapses([row(1, 'c', { bucket: 'new', rating: 'again', ivlBefore: 0, ivlAfter: 0 }), row(2, 'c', { rating: 'again', ivlBefore: 0, ivlAfter: 0 })])).toBe(0);
    // A learned card forgotten: the ease drops by 0.2 → a lapse. Again DURING relearning lowers nothing → not a new lapse.
    const learned = row(1, 'c', { rating: 'good', ivlBefore: 4, ivlAfter: 10, easeAfter: 2.5 });
    const lapse = row(2, 'c', { rating: 'again', ivlBefore: 10, ivlAfter: 5, easeAfter: 2.3 });
    const relearnAgain = row(3, 'c', { rating: 'again', ivlBefore: 5, ivlAfter: 5, easeAfter: 2.3 });
    const relearned = row(4, 'c', { rating: 'good', ivlBefore: 5, ivlAfter: 5, easeAfter: 2.3 });
    const second = row(5, 'c', { rating: 'again', ivlBefore: 5, ivlAfter: 3, easeAfter: 2.1 });
    expect(lapses([learned, lapse, relearnAgain, relearned, second])).toBe(2);
    // At the 1.3 ease floor a lapse still lowers the interval.
    expect(lapses([row(1, 'c', { easeAfter: 1.3 }), row(2, 'c', { rating: 'again', ivlBefore: 8, ivlAfter: 4, easeAfter: 1.3 })])).toBe(1);
    // A missed Check of a learned card is a lapse; a passed one is not.
    expect(lapses([row(1, 'c', { bucket: 'check', rating: 'hard', ivlBefore: 30 }), row(2, 'c', { bucket: 'check', rating: 'good', ivlBefore: 30 })])).toBe(1);
    // The order of the rows given does not matter (the history is read by seq).
    expect(lapses([second, relearned, relearnAgain, lapse, learned])).toBe(2);
  });

  test('the FIRST Maranki rating is an Again: a lapse only when it lowered the interval (a relearning card from Anki keeps it)', () => {
    const lapses = (rows: RevlogRow[]) => summarizeCardHistory(rows).lapses;
    // Imported in RELEARNING (Anki type 3, spec §5.5): the Again keeps the interval → no lapse.
    expect(lapses([row(1, 'c', { bucket: 'review', rating: 'again', ivlBefore: 5, ivlAfter: 5 })])).toBe(0);
    // A graduated card forgotten: the interval is halved → a lapse.
    expect(lapses([row(1, 'c', { bucket: 'review', rating: 'again', ivlBefore: 10, ivlAfter: 5 })])).toBe(1);
  });

  test('the History lapses and the reducer agree for an Anki card in relearning and for a graduated one', () => {
    const group = noteWithCards({
      deckId: 'd1',
      note: { id: 'n9' },
      // c9a: imported in relearning (step 0, interval 5); c9b: a graduated review card (interval 10).
      card: (ord) => (ord === 0 ? { id: 'c9a', stepIndex: 0, intervalDays: 5, reps: 6, lapses: 2 } : { id: 'c9b', stepIndex: null, intervalDays: 10, reps: 6, lapses: 2 }),
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      fields: ['Haus', 'house', '', ''],
    });
    let s = stateOfV3({ decks: [makeDeckV3({ id: 'd1' })], groups: [group], types: [builtinType('basicReverse', NOW)] });
    const ctx = { now: NOW, newId: (prefix: string) => `${prefix}-1` };
    s = rateCard(s, { cardId: 'c9a', rating: 'again' }, ctx).state;
    s = rateCard(s, { cardId: 'c9b', rating: 'again' }, ctx).state;
    const lapsesAdded = (id: string) => s.cards.find((c) => c.id === id)!.lapses - 2;
    expect([lapsesAdded('c9a'), lapsesAdded('c9b')]).toEqual([0, 1]); // the scheduler (srs.ts)
    // The revlog rows exactly as a save writes them.
    const rows = diffState(null, s).revlogAdd;
    const historyLapses = (id: string) => summarizeCardHistory(rows.filter((r) => r.cardId === id)).lapses;
    expect([historyLapses('c9a'), historyLapses('c9b')]).toEqual([0, 1]);
  });

  test('a missed Check counts as a lapse when an EARLIER Maranki rating studied the card, also with interval 0 (the reducer: reps > 0)', () => {
    const lapses = (rows: RevlogRow[]) => summarizeCardHistory(rows).lapses;
    // Studied once (still Learning, interval 0), then marked Known (CardSheet), then the Check is missed.
    const studied = row(1, 'c', { bucket: 'new', rating: 'good', ivlBefore: 0, ivlAfter: 0 });
    expect(lapses([studied, row(2, 'c', { bucket: 'check', rating: 'again', ivlBefore: 0, ivlAfter: 0 })])).toBe(1);
    expect(lapses([studied, row(2, 'c', { bucket: 'check', rating: 'hard', ivlBefore: 0, ivlAfter: 0 })])).toBe(1);
    // Marked Known before it was ever studied (reps 0): a missed Check is no lapse …
    expect(lapses([row(1, 'c', { bucket: 'check', rating: 'again', ivlBefore: 0 })])).toBe(0);
    // … also after a PASSED Check: a passed Check does not raise the reps.
    expect(lapses([row(1, 'c', { bucket: 'check', rating: 'good', ivlBefore: 0 }), row(2, 'c', { bucket: 'check', rating: 'again', ivlBefore: 0 })])).toBe(0);
    // A missed Check DOES raise the reps (the card starts Learning): marked Known again, the next miss is a lapse.
    expect(lapses([row(1, 'c', { bucket: 'check', rating: 'again', ivlBefore: 0 }), row(2, 'c', { bucket: 'check', rating: 'hard', ivlBefore: 0 })])).toBe(1);
  });

  test('the History lapses and the reducer agree for the real flow: rate once → mark Known → miss the Check', () => {
    let s = library();
    let t = NOW - 3 * 86_400_000;
    const ctx = () => {
      t += 60_000;
      return { now: t, newId: (prefix: string) => `${prefix}-${t}` };
    };
    s = rateCard(s, { cardId: 'c2', rating: 'good' }, ctx()).state; // reps 1, still Learning (interval 0)
    s = markKnown(s, { cardIds: ['c2'] }, ctx()).state;
    expect(s.cards.find((c) => c.id === 'c2')?.knownAt).not.toBeNull();
    s = rateCard(s, { cardId: 'c2', rating: 'again' }, ctx()).state; // the Check is missed
    const card = s.cards.find((c) => c.id === 'c2')!;
    expect(card.lapses).toBe(1);
    // The revlog rows exactly as a save writes them.
    const rows = diffState(null, s).revlogAdd.filter((r) => r.cardId === 'c2');
    expect(rows.map((r) => [r.bucket, r.rating, r.ivlBefore])).toEqual([
      ['new', 'good', 0],
      ['check', 'again', 0],
    ]);
    expect(summarizeCardHistory(rows).lapses).toBe(card.lapses);
  });

  test('the exact line of spec §8.4', () => {
    const atMs = localTime('2026-10-18', '21:30');
    const history = { reviews: 7, lapses: 1, last: { atMs, rating: 'good' as const } };
    expect(cardHistoryLine(history, NOW)).toBe('History: 7 reviews · 1 lapse · last: 3 days ago (Good)');
    expect(cardHistoryLine({ ...history, reviews: 1, lapses: 2 }, NOW)).toBe('History: 1 review · 2 lapses · last: 3 days ago (Good)');
    expect(cardHistoryLine({ ...history, lapses: 0 }, NOW)).toBe('History: 7 reviews · 0 lapses · last: 3 days ago (Good)');
    expect(cardHistoryLine({ reviews: 0, lapses: 0, last: null }, NOW)).toBeNull();
  });

  test('daysAgo counts local calendar days', () => {
    expect(daysAgo(localTime('2026-10-21', '00:01'), NOW)).toBe('today');
    expect(daysAgo(localTime('2026-10-20', '23:59'), NOW)).toBe('yesterday');
    expect(daysAgo(localTime('2026-10-11', '12:00'), NOW)).toBe('10 days ago');
  });

  test('cardHistory reads one card\'s rows from the store', async () => {
    const store = {
      forCard: async (id: string) => (id === 'c1-0' ? [row(1, 'c1-0'), row(4, 'c1-0', { rating: 'hard' })] : []),
      all: async () => [],
      write: async () => 0,
    };
    await expect(cardHistory({ id: 'c1-0' }, store)).resolves.toEqual({
      reviews: 2,
      lapses: 0,
      last: { atMs: row(4, 'c1-0').atMs, rating: 'hard' },
    });
  });

  test('cardHistory(cardId) — the form of spec §3.8: the same rows, the same numbers', async () => {
    const store = {
      forCard: async (id: string) => (id === 'c1-0' ? [row(1, 'c1-0'), row(4, 'c1-0', { rating: 'hard' })] : []),
      all: async () => [],
      write: async () => 0,
    };
    const history = await cardHistory('c1-0', store);
    expect(history).toEqual({ reviews: 2, lapses: 0, last: { atMs: row(4, 'c1-0').atMs, rating: 'hard' } });
    expect(cardHistoryLine(history, NOW)).toBe(`History: 2 reviews · 0 lapses · last: ${daysAgo(row(4, 'c1-0').atMs, NOW)} (Hard)`);
    await expect(cardHistory('nope', store)).resolves.toEqual({ reviews: 0, lapses: 0, last: null });
  });
});
