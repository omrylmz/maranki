/**
 * The .apkg reader (spec §5.2, unit W2-5).
 *
 *   - `collectionFromRows` (pure) on the five real deck fixtures: guid, every
 *     card SRS column, crt, the templates (qfmt/afmt), sortf and the media
 *     manifest are read; nothing is dropped.
 *   - `pickCollectionFile`: the file precedence is unchanged (the modern-Anki
 *     dummy-collection fix).
 *   - `readApkg` (the thin I/O) on real ZIP archives built with fflate. The
 *     native SQLite has no implementation under jest, so `expo-sqlite` is
 *     replaced by a tiny fake: the "database bytes" are JSON rows, and the
 *     fake answers the reader's three queries from them (only the columns
 *     each SELECT names).
 *   - a card in a filtered deck gets its home-deck due (`odue`), as in
 *     Anki's own importer.
 *   - H2: a studied card keeps its original new-card position (`cards.data`
 *     "pos"; a cards table without `data` is still read), and keys from the
 *     file ("__proto__", "constructor") are ordinary keys.
 */
// '@jest/globals' first: the jest.mock factory below uses its `jest`.
import { describe, expect, jest, test } from '@jest/globals';
import { deserializeDatabaseAsync } from 'expo-sqlite';
import { strToU8, zipSync } from 'fflate';

import { FIXED_NOW } from '../../test/clock';
import { ANKI_FIXTURES, ankiFixture, type AnkiFixture } from '../../test/factories';
import { ApkgError } from '../importApkg';
import { DEFAULT_SRS } from '../types';
import { ankiDayToMs, mapAnkiCard } from './ankiSrs';
import { collectionFromRows, homeDue, originalPosition, pickCollectionFile, readApkg, type ApkgRows } from './apkgRead';

/* ------------------------------------------------------------- fake sqlite */

jest.mock('expo-sqlite', () => {
  const { strFromU8 } = jest.requireActual<typeof import('fflate')>('fflate');
  return {
    deserializeDatabaseAsync: jest.fn(async (bytes: Uint8Array) => {
      // Our test "database" is JSON: { col, notes, cards, v18? }.
      const db = JSON.parse(strFromU8(bytes)) as {
        col: Record<string, unknown>;
        notes: Record<string, unknown>[];
        cards: Record<string, unknown>[];
        v18?: boolean;
        /** A cards table without the `data` column (a file from another tool). */
        noDataColumn?: boolean;
      };
      const asText = (v: unknown) => (v === null || v === undefined ? v : String(v));
      // Answer only the columns the SELECT names ("cast(id as text) AS id, guid" → id, guid),
      // so a column the reader forgets to select is missing here too.
      const columnsOf = (sql: string) =>
        sql
          .slice(sql.indexOf('SELECT') + 'SELECT'.length, sql.indexOf(' FROM '))
          .split(',')
          .map((part) => part.trim().split(/\s+/).pop() as string);
      const pick = (row: Record<string, unknown>, sql: string) =>
        Object.fromEntries(columnsOf(sql).map((col) => [col, row[col]]));
      return {
        getFirstAsync: async (sql: string) => {
          if (sql.includes('FROM col')) {
            if (db.v18) throw new Error('no such column: models');
            return { crt: db.col.crt, models: db.col.models, decks: db.col.decks };
          }
          throw new Error(`unexpected query ${sql}`);
        },
        getAllAsync: async (sql: string) => {
          if (sql.includes('FROM notes')) {
            return db.notes.map((n) => pick({ ...n, id: asText(n.id), mid: asText(n.mid) }, sql));
          }
          if (sql.includes('FROM cards')) {
            if (db.noDataColumn && columnsOf(sql).includes('data')) throw new Error('no such column: data');
            return db.cards.map((c) =>
              pick({ ...c, id: asText(c.id), nid: asText(c.nid), did: asText(c.did), odid: asText(c.odid) }, sql),
            );
          }
          throw new Error(`unexpected query ${sql}`);
        },
        closeAsync: jest.fn(async () => undefined),
      };
    }),
  };
});

/** A fixture as the raw rows the reader's queries return. */
function rowsOf(fx: AnkiFixture): ApkgRows {
  return { fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media };
}

/** A fake collection database (JSON rows, see the mock above). */
function dbBytes(fx: Pick<AnkiFixture, 'col' | 'notes' | 'cards'>, extra: Record<string, unknown> = {}): Uint8Array {
  return strToU8(JSON.stringify({ col: fx.col, notes: fx.notes, cards: fx.cards, ...extra }));
}

/* ------------------------------------------------------- collectionFromRows */

describe('collectionFromRows — the deck fixtures', () => {
  test.each(ANKI_FIXTURES)('%s: every note, card, model and deck is read', (name) => {
    const fx = ankiFixture(name);
    const c = collectionFromRows(rowsOf(fx));
    expect(c.fileName).toBe(fx.fileName);
    expect(c.crt).toBe(fx.col.crt);
    expect(c.notes).toHaveLength(fx.notes.length);
    expect(c.cards).toHaveLength(fx.cards.length);
    expect(c.media).toEqual(fx.media);

    const rawModels = JSON.parse(fx.col.models) as Record<
      string,
      { name: string; sortf: number; flds: { name: string }[]; tmpls: { name: string; qfmt: string; afmt: string }[] }
    >;
    expect(Object.keys(c.models)).toEqual(Object.keys(rawModels));
    for (const mid of Object.keys(rawModels)) {
      const m = c.models[mid];
      expect(m.name).toBe(rawModels[mid].name);
      expect(m.sortf).toBe(rawModels[mid].sortf);
      expect(m.flds.map((f) => f.name)).toEqual(rawModels[mid].flds.map((f) => f.name));
      expect(m.tmpls.map((t) => [t.name, t.qfmt, t.afmt])).toEqual(
        rawModels[mid].tmpls.map((t) => [t.name, t.qfmt, t.afmt]),
      );
    }

    fx.notes.forEach((raw, i) => {
      const n = c.notes[i];
      expect(n.id).toBe(String(raw.id));
      expect(n.guid).toBe(raw.guid);
      expect(n.guid).not.toBe('');
      expect(n.mid).toBe(String(raw.mid));
      expect(n.flds).toEqual(raw.flds.split('\x1f'));
      expect(n.flds).toHaveLength(c.models[n.mid].flds.length);
      expect(n.tags).toEqual(raw.tags.split(/\s+/).filter(Boolean));
    });
    fx.cards.forEach((raw, i) => {
      expect(c.cards[i]).toEqual({
        id: String(raw.id),
        nid: String(raw.nid),
        did: String(raw.did),
        odid: String(raw.odid),
        ord: raw.ord,
        type: raw.type,
        queue: raw.queue,
        due: raw.due,
        odue: raw.odue,
        ivl: raw.ivl,
        factor: raw.factor,
        reps: raw.reps,
        lapses: raw.lapses,
        flags: raw.flags,
      });
    });
  });

  test('German Verbs: both directions and the subdecks are kept', () => {
    const c = collectionFromRows(rowsOf(ankiFixture('german_verbs')));
    const model = c.models['2710131000'];
    expect(model.tmpls.map((t) => [t.ord, t.name])).toEqual([
      [0, 'DE-EN'],
      [1, 'EN-DE'],
    ]);
    expect(model.flds.map((f) => f.name)).toEqual([
      'Verb',
      'Meaning',
      'CaseInfo',
      'Conjugation',
      'Perfekt',
      'Prateritum',
      'Example',
      'Level',
      'Tags',
    ]);
    expect(model.tmpls[1].qfmt).toContain('Hint: {{CaseInfo}}'); // {{{CaseInfo}}} up to verbs version 3
    expect(c.decks['2710130003']).toBe('German::Verbs::B1');
    expect(new Set(c.cards.map((x) => x.ord))).toEqual(new Set([0, 1]));
  });

  test('Algo Deck: hierarchical tags and the media manifest', () => {
    const c = collectionFromRows(rowsOf(ankiFixture('algo_patterns')));
    expect(c.notes[0].tags).toEqual(['Algo::Core_Patterns::Topic_01']);
    expect(c.media['0']).toBe('picture-7.webp');
    expect(Object.keys(c.media)).toHaveLength(57);
  });

  test('a card in a filtered deck gets the due of its home deck (odue), like Anki\'s importer', () => {
    const fx = ankiFixture('german_grammar');
    const home = fx.cards[0].did;
    const inFiltered = { odid: home, did: 1 }; // deck 1 plays the filtered deck ("Custom Study Session")
    const learnAt = 1_790_000_000; // epoch seconds
    fx.cards[0] = { ...fx.cards[0], ...inFiltered, type: 2, queue: 2, due: -99997, odue: 20_000, ivl: 30, factor: 2500, reps: 5 };
    fx.cards[1] = { ...fx.cards[1], ...inFiltered, type: 1, queue: 1, due: -99996, odue: learnAt, reps: 1 };
    fx.cards[2] = { ...fx.cards[2], ...inFiltered, type: 0, queue: 0, due: -99995, odue: 7 };
    // odue 0: the card was answered inside the filtered deck, so `due` is already real.
    fx.cards[3] = { ...fx.cards[3], ...inFiltered, type: 2, queue: 2, due: 812, odue: 0, ivl: 3, reps: 2 };
    // Not in a filtered deck: `due` is used as it is, whatever odue says.
    fx.cards[4] = { ...fx.cards[4], type: 2, queue: 2, due: 900, odue: 5, ivl: 3, reps: 2 };

    const c = collectionFromRows(rowsOf(fx));
    expect(c.cards.slice(0, 5).map((x) => [x.due, x.odue])).toEqual([
      [20_000, 20_000],
      [learnAt, learnAt],
      [7, 7],
      [812, 0],
      [900, 5],
    ]);
    expect(c.cards[0].odid).toBe(String(home)); // the home deck stays known (sections use it)

    // Through the progress mapping: the review is due on day crt + 20000, not around the year 1750.
    const opts = { crt: c.crt, progress: 'keep' as const, arrival: 'queued' as const, newPos: 0, marked: false, now: FIXED_NOW,
      srs: { startingEase: DEFAULT_SRS.startingEase, maxIntervalDays: DEFAULT_SRS.maxIntervalDays } };
    const review = mapAnkiCard(c.cards[0], opts);
    expect(review.due).toBe(ankiDayToMs(c.crt, 20_000));
    expect(new Date(review.due).getFullYear()).toBeGreaterThan(2000);
    expect(mapAnkiCard(c.cards[1], opts).due).toBe(learnAt * 1000);
  });

  test('homeDue: odue only for a card in a filtered deck with a non-zero odue', () => {
    expect(homeDue('0', -99997, 20_000)).toBe(-99997);
    expect(homeDue('1700000003', -99997, 20_000)).toBe(20_000);
    expect(homeDue('1700000003', 812, 0)).toBe(812);
    expect(homeDue('1700000003', 812, NaN)).toBe(812);
  });

  test('bad JSON and missing numbers are tolerated (empty maps, NaN for progress)', () => {
    const c = collectionFromRows({
      fileName: 'x.apkg',
      col: { crt: null, models: '{not json', decks: 'null' },
      notes: [{ id: 5, guid: null, mid: 9, flds: null, tags: '  a   b ' }],
      cards: [
        { id: 6, nid: 5, did: 1, odid: null, ord: null, type: null, queue: '0', due: '', ivl: 1, factor: 0, reps: 0, lapses: 0, flags: 0 },
      ],
      media: '{"0": "a.png", "1": 7}',
    });
    expect(c.crt).toBe(0);
    expect(c.models).toEqual({});
    expect(c.decks).toEqual({});
    expect(c.notes[0]).toEqual({ id: '5', guid: '', mid: '9', flds: [''], tags: ['a', 'b'] });
    expect(c.cards[0].odid).toBe('0');
    expect(c.cards[0].ord).toBe(0);
    expect(c.cards[0].queue).toBe(0);
    expect(c.cards[0].type).toBeNaN();
    expect(c.cards[0].due).toBeNaN();
    expect(c.media).toEqual({ '0': 'a.png' });
  });
});

/* ------------------------------------------------------- file precedence */

describe('pickCollectionFile — precedence unchanged', () => {
  test('anki21 wins over the dummy anki2 that modern Anki always adds', () => {
    expect(pickCollectionFile(['collection.anki2', 'collection.anki21', 'media'])).toBe('collection.anki21');
  });

  test('anki21b (newer format) is an honest error, even next to a dummy anki2', () => {
    expect(() => pickCollectionFile(['collection.anki2', 'collection.anki21b'])).toThrow(ApkgError);
    try {
      pickCollectionFile(['collection.anki21b']);
    } catch (e) {
      expect((e as ApkgError).code).toBe('newer-format');
    }
  });

  test('anki2 alone (genanki / AnkiWeb) is read; no collection → no-collection', () => {
    expect(pickCollectionFile(['collection.anki2'])).toBe('collection.anki2');
    expect(() => pickCollectionFile(['media'])).toThrow(expect.objectContaining({ code: 'no-collection' }));
  });
});

/* ---------------------------------------------------------------- readApkg */

describe('readApkg — unzip + query + lazy media', () => {
  const coding = ankiFixture('algo_patterns');
  const dummy = {
    col: { ...coding.col, decks: '{"1": {"name": "Default"}}' },
    notes: [{ ...coding.notes[0], id: 1, guid: 'dummy', flds: 'Please update to the latest Anki version' }],
    cards: [],
  };
  const image = new Uint8Array(4000).map((_, i) => i % 251);

  test('reads the real collection (anki21), not the dummy anki2', async () => {
    const zip = zipSync({
      'collection.anki2': dbBytes(dummy),
      'collection.anki21': dbBytes(coding),
      media: strToU8(JSON.stringify(coding.media)),
    });
    const c = await readApkg(zip, 'Algo_Patterns.apkg');
    expect(c.fileName).toBe('Algo_Patterns.apkg');
    expect(c.notes).toHaveLength(coding.notes.length);
    expect(c.notes.some((n) => n.guid === 'dummy')).toBe(false);
    expect(c.cards).toHaveLength(coding.cards.length);
    expect(c.crt).toBe(coding.col.crt);
    expect(c.media).toEqual(coding.media);
  });

  test('the cards query reads odue, so a filtered-deck card keeps its home-deck due', async () => {
    const cards = coding.cards.map((x, i) => (i === 0 ? { ...x, odid: x.did, did: 1, type: 0, due: -99999, odue: 3 } : x));
    const c = await readApkg(zipSync({ 'collection.anki2': dbBytes({ ...coding, cards }) }), 'c.apkg');
    expect(c.cards[0]).toMatchObject({ due: 3, odue: 3, odid: String(coding.cards[0].did) });
  });

  test('images are unpacked lazily, by file name; sizes come from the zip directory', async () => {
    const zip = zipSync({
      'collection.anki2': dbBytes(coding),
      media: strToU8(JSON.stringify({ '0': 'picture-7.webp', '1': 'clip.mp3', '2': 'listed-not-zipped.png' })),
      '0': image,
      '1': new Uint8Array([1, 2, 3]),
    });
    const c = await readApkg(zip, 'c.apkg');
    expect(c.mediaSize?.('picture-7.webp')).toBe(image.length);
    expect(Array.from(c.mediaBytes?.('picture-7.webp') ?? [])).toEqual(Array.from(image));
    expect(c.mediaBytes?.('clip.mp3')).toBeNull(); // audio is never unpacked
    expect(c.mediaSize?.('listed-not-zipped.png')).toBeNull();
    expect(c.mediaBytes?.('listed-not-zipped.png')).toBeNull();
    expect(c.mediaSize?.('unknown.png')).toBeNull();
  });

  test('closes the database after reading', async () => {
    const zip = zipSync({ 'collection.anki2': dbBytes(coding) });
    await readApkg(zip, 'c.apkg');
    const db = await jest.mocked(deserializeDatabaseAsync).mock.results.at(-1)?.value;
    expect((db as unknown as { closeAsync: jest.Mock }).closeAsync).toHaveBeenCalledTimes(1);
  });

  test('errors: newer format, no collection, not a zip, schema 18, no notes', async () => {
    await expect(readApkg(zipSync({ 'collection.anki21b': strToU8('zstd') }), 'n.apkg')).rejects.toMatchObject({
      code: 'newer-format',
    });
    await expect(readApkg(zipSync({ media: strToU8('{}') }), 'm.apkg')).rejects.toMatchObject({
      code: 'no-collection',
    });
    await expect(readApkg(strToU8('this is not a zip file at all'), 'x.apkg')).rejects.toMatchObject({
      code: 'corrupt',
    });
    await expect(readApkg(zipSync({ 'collection.anki2': dbBytes(coding, { v18: true }) }), 'v.apkg')).rejects.toMatchObject({
      code: 'newer-format',
    });
    await expect(
      readApkg(zipSync({ 'collection.anki2': dbBytes({ ...coding, notes: [], cards: [] }) }), 'e.apkg'),
    ).rejects.toMatchObject({ code: 'empty' });
  });
});

/* ------------------------------------------------------------------- H2 */

describe('H2: original positions and keys from the file', () => {
  const coding = ankiFixture('algo_patterns');

  test('originalPosition: the "pos" of cards.data; anything else → undefined', () => {
    expect(originalPosition('{"pos":12,"s":3.1,"d":5.2}')).toBe(12);
    expect(originalPosition('{"pos":0}')).toBe(0);
    for (const bad of ['', null, undefined, '{}', '{"pos":"7"}', '{"pos":-1}', '{"pos":1.5}', '{pos', '[1]', '{"cd":"pos"}']) {
      expect(originalPosition(bad)).toBeUndefined();
    }
  });

  test('a studied card keeps its original new-card position (Anki 2.1.55+ cards.data)', () => {
    const fx = ankiFixture('german_grammar');
    fx.cards[0] = { ...fx.cards[0], type: 2, queue: 2, due: 20_000, ivl: 10, reps: 3, data: '{"pos":4,"s":2.5}' };
    const c = collectionFromRows(rowsOf(fx));
    expect(c.cards[0].originalPos).toBe(4);
    expect('originalPos' in c.cards[1]).toBe(false); // genanki's '' → no key at all
  });

  test('"__proto__" and "constructor" in models, decks and the manifest are ordinary keys', () => {
    const model = (name: string) => JSON.stringify({ name, type: 0, sortf: 0, flds: [{ name: 'F', ord: 0 }], tmpls: [] });
    const c = collectionFromRows({
      fileName: 'x.apkg',
      col: {
        crt: 0,
        models: `{"__proto__": ${model('P')}, "constructor": ${model('C')}}`,
        decks: '{"__proto__": {"name": "Deck P"}, "constructor": {"name": "Deck C"}}',
      },
      notes: [],
      cards: [],
      media: '{"__proto__": "p.png", "constructor": "c.png", "0": "zero.png"}',
    });
    expect(Object.keys(c.models)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(c.models)).toBeNull();
    expect(c.models['__proto__'].name).toBe('P');
    expect(c.models['constructor'].name).toBe('C');
    expect(c.models['toString']).toBeUndefined(); // no Object.prototype behind the keys
    expect(Object.getPrototypeOf(c.decks)).toBeNull();
    expect(Object.entries(c.decks)).toEqual([
      ['__proto__', 'Deck P'],
      ['constructor', 'Deck C'],
    ]);
    expect(Object.getPrototypeOf(c.media)).toBeNull();
    expect(Object.entries(c.media).sort()).toEqual([
      ['0', 'zero.png'],
      ['__proto__', 'p.png'],
      ['constructor', 'c.png'],
    ]);
    // Nothing leaked into a shared prototype.
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });

  test('the cards query reads data (original positions); a cards table without data is still read', async () => {
    const cards = coding.cards.map((x, i) => (i === 0 ? { ...x, type: 2, queue: 2, due: 20_000, reps: 2, data: '{"pos":3}' } : x));
    const withData = await readApkg(zipSync({ 'collection.anki2': dbBytes({ ...coding, cards }) }), 'c.apkg');
    expect(withData.cards[0].originalPos).toBe(3);

    const without = await readApkg(
      zipSync({ 'collection.anki2': dbBytes({ ...coding, cards }, { noDataColumn: true }) }),
      'c.apkg',
    );
    expect(without.cards).toHaveLength(coding.cards.length);
    expect(without.cards[0].originalPos).toBeUndefined();
    expect(without.cards[0]).toMatchObject({ type: 2, due: 20_000 });
  });

  test('media entries named "__proto__" or "constructor" are found by file name', async () => {
    const p = new Uint8Array([1, 2, 3, 4]);
    const k = new Uint8Array([9, 8, 7]);
    // fflate cannot write an entry called "__proto__" (its input is a plain object), so the entry is
    // zipped as "zzproto__" (same length) and renamed in the bytes; the CRC covers the data only.
    const zip = renameZipEntry(
      zipSync({
        'collection.anki2': dbBytes(coding),
        media: strToU8('{"__proto__": "p.png", "constructor": "k.png"}'),
        zzproto__: p,
        constructor: k,
      }),
      'zzproto__',
      '__proto__',
    );
    const c = await readApkg(zip, 'c.apkg');
    expect(c.mediaSize?.('p.png')).toBe(4);
    expect(Array.from(c.mediaBytes?.('p.png') ?? [])).toEqual([1, 2, 3, 4]);
    expect(c.mediaSize?.('k.png')).toBe(3);
    expect(Array.from(c.mediaBytes?.('k.png') ?? [])).toEqual([9, 8, 7]);
  });
});

/** Rename a zip entry in place: every copy of the name `from` (local header + directory) becomes `to` (same length). */
function renameZipEntry(zip: Uint8Array, from: string, to: string): Uint8Array {
  const a = strToU8(from);
  const b = strToU8(to);
  expect(b.length).toBe(a.length);
  const out = zip.slice();
  let renamed = 0;
  for (let i = 0; i + a.length <= out.length; i++) {
    if (a.every((byte, j) => out[i + j] === byte)) {
      out.set(b, i);
      renamed += 1;
    }
  }
  expect(renamed).toBe(2);
  return out;
}
