/**
 * Starter decks (spec §5.10, §9.4, unit W3-8).
 *
 * Pinned here, on SYNTHETIC Anki rows (a small "Starter Words" deck: 2
 * directions, sections A1 and B1, a Level field) and on the real German
 * Vocabulary fixture:
 *   - the deck key 'pack:<pack>:<key>' finds the deck, even after a rename;
 *     a file-import deck with the same name is never the target;
 *   - the first plan makes ONE new deck (source 'pack', the starter title,
 *     the pack's deck defaults), every note and every direction, with the
 *     pack presets on the new card type;
 *   - IDEMPOTENT: the second run is all updates by guid ("Already up to
 *     date."): no new deck, no new note, card or card type;
 *   - a newer bundled file: changed notes are updated and new notes added to
 *     the SAME deck; studied cards keep their ids and progress;
 *   - a newer file that ADDS a field upgrades the card type (plan.ts
 *     upgradeNoteType): 'update', every note gets the field, the learner's
 *     own field settings stay, the deck keeps ONE card type;
 *   - notes that a newer file DROPPED are retired once (cards suspended,
 *     RETIRED_TAG, progress kept): only in the starter deck, only notes with
 *     the file's own guid (never the learner's cards or 'm-' copies);
 *   - a deleted starter deck can be added again: deleted with its cards →
 *     'add'; deleted with 'keep' (Unfiled cards) or 'move' → 'elsewhere',
 *     which names the decks that hold the notes, and `elsewhere: 'copy'`
 *     ("Add as a new deck") makes the starter deck again;
 *   - `starterIds`: two id makers of the same millisecond (and the same
 *     random salt) never give the same id, so starter decks added at the
 *     same time never share a deck, note or card id;
 *   - arrival, placement ("Where do you start?", given by VALUE, so a deck
 *     without A1 is placed right) and notes already in another deck
 *     ("Update them where they are" / copies);
 *   - H2: a model id "__proto__" from the file still reaches the planner;
 *   - `planStarterDeck` from the .apkg BYTES (real readApkg, fake SQLite)
 *     gives the same plan as the pure version;
 *   - `addStarterDeck`: reads the bundled asset once, plans on the CURRENT
 *     state, applies and saves; a second add applies nothing; two quick taps
 *     make one deck; 'elsewhere' has deckId null and applies only the changes
 *     to the notes where they are; a bad file (or a bundled file that cannot
 *     be loaded) is an ApkgError and changes nothing;
 *   - a caller's arrival rule (the AddSheet's D3, wave 5c): one read, one
 *     plan for a right guess, one more plan (same read) for a wrong one; never
 *     used for the caller's own arrival, a deck that is there, or 'elsewhere';
 *   - its save result: a save that did not commit is reported, not hidden;
 *   - its images (§5.8): written AFTER the save, from the bundled archive,
 *     into media/<deckId>; written again by an 'upToDate' add (a missing
 *     image comes back); not written when the save failed; a writer error is
 *     reported, not thrown; `writeStarterImages` retries the images alone
 *     (after a save commits, applying nothing);
 *   - the spec's call `planStarterDeck(pack, key, state, bytes)` (no ctx).
 *
 * The native SQLite has no implementation under jest, so `expo-sqlite` is a
 * tiny fake: the "database bytes" are JSON rows, and the fake answers the
 * reader's three queries from them. `expo-asset` and `expo-file-system` are
 * fakes too (the bundled file is a test zip).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Asset } from 'expo-asset';
import { strToU8, zipSync } from 'fflate';

import type { FlushResult } from '../store/actions';
import { FIXED_NOW } from '../test/clock';
import { ankiFixture } from '../test/factories';
import type { ContentPack, StarterDeck } from '../variants/types';
import { pack as genericPack } from '../variants/generic/pack';
import { FIELD_SEP } from './anki';
import { collectionFromRows, readApkg, type ApkgRows } from './import/apkgRead';
import { ApkgError } from './importApkg';
import { makeDeck } from './makeV3';
import type { AnkiCollection, Card, Deck, Id, ImportMediaFolder, ImportPlan, ImportResult, Note, NoteType } from './model';
import { RETIRED_TAG, remapFields } from './noteOps';
import { suggestMapping } from './roles';
import {
  addStarterDeck,
  findStarterDeck,
  planStarterDeck,
  planStarterDeckFrom,
  starterDeckOf,
  starterDeckRows,
  starterIds,
  starterPlacementRank,
  starterSourceKey,
  writeStarterImages,
  type StarterArrivalRule,
  type StarterCtx,
  type StarterDeckPlan,
  type StarterDeps,
  type StarterLibrary,
  type StarterMediaBytes,
} from './starterDecks';
import { DEFAULT_SRS } from './types';

/* ------------------------------------------------------------------ fakes */

jest.mock('expo-sqlite', () => {
  const { strFromU8 } = jest.requireActual<typeof import('fflate')>('fflate');
  return {
    deserializeDatabaseAsync: jest.fn(async (bytes: Uint8Array) => {
      // Our test "database" is JSON: { col, notes, cards }.
      const db = JSON.parse(strFromU8(bytes)) as {
        col: Record<string, unknown>;
        notes: Record<string, unknown>[];
        cards: Record<string, unknown>[];
      };
      return {
        getFirstAsync: async (sql: string) => {
          if (sql.includes('FROM col')) return db.col;
          throw new Error(`unexpected query ${sql}`);
        },
        getAllAsync: async (sql: string) => {
          if (sql.includes('FROM notes')) return db.notes;
          if (sql.includes('FROM cards')) return db.cards;
          throw new Error(`unexpected query ${sql}`);
        },
        closeAsync: async () => undefined,
      };
    }),
  };
});

/** The bytes the fake `File.bytes()` returns, by uri. */
const mockFiles = new Map<string, Uint8Array>();
/** Every uri the fake `File` was made with. */
const mockFileUris: string[] = [];

jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: jest.fn((mod: number) => {
      const asset = {
        name: `pack-${mod}`,
        type: 'apkg',
        uri: `asset:///pack-${mod}.apkg`,
        localUri: null as string | null,
        downloadAsync: async () => {
          asset.localUri = `file:///cache/pack-${mod}.apkg`;
          return asset;
        },
      };
      return asset;
    }),
  },
}));

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
      mockFileUris.push(uri);
    }
    async bytes(): Promise<Uint8Array> {
      const found = mockFiles.get(this.uri);
      if (!found) throw new Error(`no file ${this.uri}`);
      return found;
    }
  },
}));

beforeEach(() => {
  mockFiles.clear();
  mockFileUris.length = 0;
  jest.mocked(Asset.fromModule).mockClear();
});

/* ---------------------------------------------------------- synthetic rows */

const MID = '1700000000001';
const DID_A1 = '1700000000101';
const DID_B1 = '1700000000102';

interface Word {
  guid: string;
  word: string;
  meaning: string;
  /** 'A1' cards go to the subdeck Starter::A1, every other level to Starter::B1. */
  level: string;
  /** Only read when the rows have the "Type" field (`typeField`). */
  type?: string;
}

const WORDS: Word[] = [
  { guid: 'g-haus', word: 'das Haus', meaning: 'the house', level: 'A1' },
  { guid: 'g-hund', word: 'der Hund', meaning: 'the dog', level: 'A1' },
  { guid: 'g-katze', word: 'die Katze', meaning: 'the cat', level: 'A1' },
  { guid: 'g-anlass', word: 'der Anlass', meaning: 'the occasion', level: 'B1' },
  { guid: 'g-umwelt', word: 'die Umwelt', meaning: 'the environment', level: 'B1' },
  { guid: 'g-ziel', word: 'das Ziel', meaning: 'the goal', level: 'B1' },
];

/**
 * Anki's raw rows of a "Starter Words" deck: one note per word, two cards (both directions) per note.
 * `typeField` adds a 4th field "Type" (a rebuilt deck, like §9.6).
 */
function starterRows(words: Word[] = WORDS, mid: string = MID, opts: { typeField?: boolean } = {}): ApkgRows {
  const flds = [
    { name: 'Word', ord: 0 },
    { name: 'Meaning', ord: 1 },
    { name: 'Level', ord: 2 },
  ];
  if (opts.typeField) flds.push({ name: 'Type', ord: 3 });
  const models = {
    [mid]: {
      id: 1,
      name: 'Starter Words',
      type: 0,
      sortf: 0,
      flds,
      tmpls: [
        { name: 'DE-EN', ord: 0, qfmt: '{{Level}} {{Word}}', afmt: '{{FrontSide}}<hr id=answer>{{Meaning}}' },
        { name: 'EN-DE', ord: 1, qfmt: '{{Level}} {{Meaning}}', afmt: '{{FrontSide}}<hr id=answer>{{Word}}' },
      ],
    },
  };
  const decks = {
    '1': { id: 1, name: 'Default' },
    [DID_A1]: { id: Number(DID_A1), name: 'Starter::A1' },
    [DID_B1]: { id: Number(DID_B1), name: 'Starter::B1' },
  };
  // A note id is its creation time: the order of WORDS, whatever was added later.
  const noteId = (w: Word) => 1700000001000 + WORDS.concat(words).findIndex((x) => x.guid === w.guid);
  return {
    fileName: 'ignored.apkg',
    col: { crt: 1_700_000_000, models: JSON.stringify(models), decks: JSON.stringify(decks) },
    notes: words.map((w) => ({
      id: noteId(w),
      guid: w.guid,
      mid,
      flds: (opts.typeField ? [w.word, w.meaning, w.level, w.type ?? ''] : [w.word, w.meaning, w.level]).join(FIELD_SEP),
      tags: '',
    })),
    cards: words.flatMap((w, i) =>
      [0, 1].map((ord) => ({
        id: noteId(w) * 10 + ord,
        nid: noteId(w),
        did: w.level === 'A1' ? DID_A1 : DID_B1,
        odid: 0,
        ord,
        type: 0,
        queue: 0,
        due: i + 1,
        ivl: 0,
        factor: 0,
        reps: 0,
        lapses: 0,
        flags: 0,
        data: '',
      })),
    ),
    media: {},
  };
}

/** The rows as the reader turns them into a collection. */
function starterCollection(words: Word[] = WORDS, mid: string = MID, opts: { typeField?: boolean } = {}): AnkiCollection {
  return collectionFromRows(starterRows(words, mid, opts));
}

/**
 * The rows as a zipped .apkg (the fake SQLite reads the JSON database).
 * `images` are files in the archive, by file name: zip entries "0", "1" …
 * and the `media` manifest that maps them back, like Anki writes them.
 */
function starterApkg(words: Word[] = WORDS, images: [string, Uint8Array][] = []): Uint8Array {
  const r = starterRows(words);
  const manifest: Record<string, string> = {};
  const entries: Record<string, Uint8Array> = {
    'collection.anki2': strToU8(JSON.stringify({ col: r.col, notes: r.notes, cards: r.cards })),
  };
  images.forEach(([name, bytes], i) => {
    manifest[String(i)] = name;
    entries[String(i)] = bytes;
  });
  entries.media = strToU8(JSON.stringify(manifest));
  return zipSync(entries);
}

/* ---------------------------------------------------------------- the pack */

const WORDS_STARTER: StarterDeck = { key: 'words', title: 'Starter words', subtitle: '6 words, A1 to B1', asset: 7, version: 1 };

const PACK: ContentPack = {
  id: 'german',
  starterDecks: [WORDS_STARTER],
  cardTypePresets: [
    {
      match: /^Starter Words/,
      fields: {
        Word: { role: 'term', lang: 'de-DE' },
        Meaning: { role: 'meaning', lang: 'en-US' },
        Level: { role: 'badge' },
      },
    },
  ],
  deckDefaults: { language: 'de-DE', meaningLanguage: 'en-US', genderColors: true, icon: '🇩🇪' },
};

/** The same pack with a newer bundled file. */
const PACK_V2: ContentPack = { ...PACK, starterDecks: [{ ...WORDS_STARTER, version: 2 }] };

/* -------------------------------------------------------------- the library */

type Lib = StarterLibrary & { noteTypes: NoteType[]; notes: Note[]; cards: Card[]; decks: Deck[] };

const emptyLib = (): Lib => ({ noteTypes: [], notes: [], cards: [], decks: [], settings: { srs: DEFAULT_SRS } });

/** Ids 'id-1', 'id-2' …, a new sequence per call. */
function ctx(prefix = 'id', now = FIXED_NOW): StarterCtx {
  let n = 0;
  return { now, newId: () => `${prefix}-${++n}` };
}

/**
 * What `applyImport` does with a plan (the reducer, W3-2), for the tests: a
 * card-type upgrade replaces the type and moves EVERY note of it to the new
 * field order by name; updates; a retired note gets RETIRED_TAG and its cards
 * are suspended. (reducer.test.ts pins the real reducer.)
 */
function apply(lib: Lib, plan: ImportPlan): Lib {
  const upd = new Map(plan.notes.update.map((u) => [u.id, u]));
  const upgrades = new Map(plan.noteTypes.upgrade.map((u) => [u.type.id, u]));
  const retired = new Set(plan.notes.retire);
  return {
    ...lib,
    noteTypes: [...lib.noteTypes.map((t) => upgrades.get(t.id)?.type ?? t), ...plan.noteTypes.add],
    notes: [
      ...lib.notes.map((n) => {
        const up = upgrades.get(n.typeId);
        const moved = up
          ? { ...n, fields: remapFields(n.fields, up.fromFields, up.type.fields.map((f) => f.name)) }
          : n;
        const u = upd.get(n.id);
        const next = u ? { ...moved, fields: u.fields, tags: u.tags, section: u.section ?? moved.section } : moved;
        return retired.has(n.id) ? { ...next, tags: [...next.tags, RETIRED_TAG] } : next;
      }),
      ...plan.notes.add,
    ],
    cards: [...lib.cards.map((c) => (retired.has(c.noteId) ? { ...c, suspended: true } : c)), ...plan.cards.add],
    decks: plan.deck ? [...lib.decks, plan.deck] : lib.decks,
  };
}

/** The ImportResult a plan gives when the library did not change in between. */
function resultOf(lib: Lib, plan: ImportPlan): ImportResult {
  const updatedIds = new Set(plan.notes.update.map((u) => u.id));
  const deckId =
    plan.deck?.id ?? plan.cards.add[0]?.deckId ?? lib.cards.find((c) => updatedIds.has(c.noteId))?.deckId ?? null;
  const s = plan.summary;
  return {
    deckId,
    deckCreated: plan.deck !== null,
    notesAdded: s.notesAdded,
    cardsAdded: s.cardsAdded,
    notesUpdated: s.notesUpdated,
    notesUnchanged: s.notesUnchanged,
    cardsUpdated: s.cardsUpdated,
    updatedDecks: s.updatedDecks,
    cardTypesUpdated: s.cardTypesUpdated,
    notesRetired: s.notesRetired,
    notesSkipped: s.notesSkipped,
    skipped: s.skipped,
    markedKnown: s.markedKnown,
    media: plan.media,
  };
}

/** The "Unfiled cards" deck that DeleteDeckSheet 'keep' makes (store/deckOps.ts: id 'unfiled'), as a v3 deck. */
function unfiledDeck(): Deck {
  return makeDeck({ id: 'unfiled', name: 'Unfiled cards', icon: '🗃️', order: 9 }, FIXED_NOW);
}

/**
 * Delete the deck `deckId` and KEEP its cards (§8.2, store/deckOps.ts):
 * 'keep' moves them to "Unfiled cards", 'move' to a deck the learner picked
 * (`into`). The notes stay; `into` is added to the decks when it is new.
 */
function deleteKeepingCards(lib: Lib, deckId: Id, into: Deck): Lib {
  const decks = lib.decks.filter((d) => d.id !== deckId);
  return {
    ...lib,
    decks: decks.some((d) => d.id === into.id) ? decks : [...decks, into],
    cards: lib.cards.map((c) => (c.deckId === deckId ? { ...c, deckId: into.id } : c)),
  };
}

/** A deck from a FILE import (not the starter deck), holding some notes of the starter file. */
function fileImportLib(): Lib {
  const lib = emptyLib();
  const plan = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('file')).plan;
  // Same notes, but the deck says it came from a file: it is not the starter deck.
  const deck = { ...(plan.deck as Deck), name: 'Starter words', source: 'apkg' as const, sourceKey: 'file:Starter.apkg' };
  return apply(lib, { ...plan, deck });
}

/* ------------------------------------------------------------------- keys */

describe('starter deck keys', () => {
  test("the deck key is 'pack:<pack>:<key>'", () => {
    expect(starterSourceKey('german', 'vocabulary')).toBe('pack:german:vocabulary');
  });

  test('a key the pack does not have throws; the generic pack has no starter decks', () => {
    expect(starterDeckOf(PACK, 'words')).toBe(WORDS_STARTER);
    expect(() => starterDeckOf(PACK, 'verbs')).toThrow('The "german" pack has no starter deck "verbs".');
    expect(genericPack.starterDecks).toEqual([]);
    expect(() => starterDeckOf(genericPack, 'words')).toThrow('no starter deck');
    expect(() => planStarterDeckFrom(PACK, 'verbs', emptyLib(), starterCollection(), ctx())).toThrow('no starter deck');
  });

  test('the deck is found by its sourceKey, even renamed; a file-import deck with the same name is not it', () => {
    const lib = fileImportLib();
    expect(findStarterDeck(lib.decks, 'german', 'words')).toBeUndefined();
    expect(starterDeckRows(PACK, lib.decks)).toEqual([{ starter: WORDS_STARTER, deckId: null }]);

    const added = apply(emptyLib(), planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx()).plan);
    const deckId = added.decks[0].id;
    const renamed = { ...added, decks: [{ ...added.decks[0], name: 'My German', order: 4 }] };
    expect(findStarterDeck(renamed.decks, 'german', 'words')?.id).toBe(deckId);
    expect(starterDeckRows(PACK, renamed.decks)).toEqual([{ starter: WORDS_STARTER, deckId }]);
    // Another pack with the same key is another deck.
    expect(findStarterDeck(renamed.decks, 'generic', 'words')).toBeUndefined();
  });

  test('starterIds gives unique ids that never look like engine ids', () => {
    const a = starterIds(FIXED_NOW);
    const ids = new Set([a(), a(), a()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^p-[0-9a-z]+-[0-9a-z]+-\d+$/);
  });

  test('two starterIds generators of the same millisecond never give the same id, even with the same random salt', () => {
    // Two starter decks added at the same time (onboarding may add 3 with
    // Promise.all) reach `now()` in the same millisecond. Same salt too: the
    // ids must still differ, by construction.
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const a = starterIds(FIXED_NOW);
      const b = starterIds(FIXED_NOW);
      const fromA = Array.from({ length: 20 }, () => a());
      const fromB = Array.from({ length: 20 }, () => b());
      expect(new Set([...fromA, ...fromB]).size).toBe(40);
      for (const id of [...fromA, ...fromB]) expect(id).toMatch(/^p-[0-9a-z]+-[0-9a-z]+-\d+$/);
    } finally {
      random.mockRestore();
    }
    // The salt always has its full width (4 characters), so "<sequence><salt>"
    // never reads the same for two sequence numbers (1 + "2abc" vs 12 + "abc").
    const middle = (id: string) => id.split('-')[2];
    for (const r of [0, 1e-9, 0.5, 0.999999]) {
      const spy = jest.spyOn(Math, 'random').mockReturnValue(r);
      try {
        const x = middle(starterIds(FIXED_NOW)());
        const y = middle(starterIds(FIXED_NOW)());
        expect(x.length).toBeGreaterThanOrEqual(5);
        expect(x.slice(-4)).toBe(y.slice(-4)); // the same salt, 4 characters
        expect(x.slice(0, -4)).not.toBe(y.slice(0, -4)); // another sequence number
      } finally {
        spy.mockRestore();
      }
    }
  });
});

/* ------------------------------------------------------------- first add */

describe('planStarterDeckFrom — the first add', () => {
  test('one new deck with every note, every direction and the pack marks', () => {
    const { kind, plan, sourceKey, existingDeckId, starter } = planStarterDeckFrom(
      PACK,
      'words',
      emptyLib(),
      starterCollection(),
      ctx(),
    );
    expect(kind).toBe('add');
    expect(starter).toBe(WORDS_STARTER);
    expect(sourceKey).toBe('pack:german:words');
    expect(existingDeckId).toBeNull();

    const deck = plan.deck as Deck;
    expect(deck).toMatchObject({
      name: 'Starter words',
      icon: '🇩🇪',
      source: 'pack',
      sourceKey: 'pack:german:words',
      active: true,
      language: 'de-DE',
      meaningLanguage: 'en-US',
      genderColors: true,
      options: { newArrival: 'queued' },
    });

    // Every note, both directions, in the new deck, as New cards.
    expect(plan.notes.add).toHaveLength(6);
    expect(plan.cards.add).toHaveLength(12);
    expect(plan.cards.add.every((c) => c.deckId === deck.id && c.reps === 0 && c.newState === 'queued')).toBe(true);
    expect(new Set(plan.cards.add.map((c) => c.ord))).toEqual(new Set([0, 1]));
    expect(plan.notes.add.map((n) => n.guid)).toEqual(WORDS.map((w) => w.guid));
    expect(plan.notes.add.map((n) => n.section)).toEqual(['A1', 'A1', 'A1', 'B1', 'B1', 'B1']);
    for (const n of plan.notes.add) {
      expect(n.source).toEqual({ kind: 'pack', ref: 'pack:german:words@1', ankiNoteId: expect.any(String) });
    }

    // One new card type, from the Anki model, marked with the pack, with the presets.
    expect(plan.noteTypes.add).toHaveLength(1);
    const type = plan.noteTypes.add[0];
    expect(type.source).toEqual({ ankiMid: MID, packId: 'german' });
    expect(type.fields.map((f) => [f.name, f.role, f.lang])).toEqual([
      ['Word', 'term', 'de-DE'],
      ['Meaning', 'meaning', 'en-US'],
      ['Level', 'badge', undefined],
    ]);
    expect(type.templates.map((t) => t.ord)).toEqual([0, 1]);

    // The summary sees the Level filter and offers "Where do you start?".
    expect(plan.summary.filtersFound).toContain('Level');
    expect(plan.summary.placementGroups).toContainEqual({ facet: 'field:level', label: 'Level', values: ['A1', 'B1'] });
  });

  test('without deck defaults: no language fields, the default icon', () => {
    const bare: ContentPack = { id: 'german', starterDecks: [WORDS_STARTER], cardTypePresets: [] };
    const deck = planStarterDeckFrom(bare, 'words', emptyLib(), starterCollection(), ctx()).plan.deck as Deck;
    expect(deck.name).toBe('Starter words');
    expect(deck.icon).toBe('🗂️');
    expect(deck).not.toHaveProperty('language');
    expect(deck).not.toHaveProperty('meaningLanguage');
    expect(deck).not.toHaveProperty('genderColors');
  });

  test('pure: the same inputs and id sequence give the same plan', () => {
    const a = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const b = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    expect(b).toEqual(a);
  });
});

/* ------------------------------------------------------------- idempotent */

describe('planStarterDeckFrom — idempotent', () => {
  test('the second run is all updates by guid: no new deck, nothing added ("Already up to date.")', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const lib = apply(emptyLib(), first.plan);
    const deckId = (first.plan.deck as Deck).id;

    const second = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('again'));
    expect(second.kind).toBe('upToDate');
    expect(second.existingDeckId).toBe(deckId);
    expect(second.plan.deck).toBeNull();
    expect(second.plan.noteTypes.add).toEqual([]);
    expect(second.plan.noteTypes.reuse[MID]).toBe(first.plan.noteTypes.add[0].id);
    expect(second.plan.notes.add).toEqual([]);
    expect(second.plan.notes.update).toEqual([]);
    expect(second.plan.cards.add).toEqual([]);
    expect(second.plan.summary).toMatchObject({ inTargetDeck: 6, notesUnchanged: 6, notesAdded: 0, cardsAdded: 0 });

    // A third run is the same, and applying it changes nothing.
    const after = apply(lib, second.plan);
    expect(after.decks).toHaveLength(1);
    expect(after.notes).toHaveLength(6);
    expect(after.cards).toHaveLength(12);
    expect(planStarterDeckFrom(PACK, 'words', after, starterCollection(), ctx('third')).kind).toBe('upToDate');
  });

  test('the German Vocabulary fixture: the second run adds nothing', () => {
    const fx = ankiFixture('german_vocabulary');
    const rows: ApkgRows = { fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media };
    const vocab: ContentPack = {
      ...PACK,
      starterDecks: [{ ...WORDS_STARTER, key: 'vocabulary', title: 'German vocabulary' }],
      cardTypePresets: [{ match: /^German Vocabulary/, fields: { Word: { role: 'term', lang: 'de-DE' } } }],
    };
    const first = planStarterDeckFrom(vocab, 'vocabulary', emptyLib(), collectionFromRows(rows), ctx());
    expect(first.kind).toBe('add');
    expect(first.plan.notes.add).toHaveLength(fx.notes.length);
    expect(first.plan.cards.add).toHaveLength(fx.cards.length); // both directions
    expect(first.plan.summary.filtersFound).toContain('Level');

    const lib = apply(emptyLib(), first.plan);
    const second = planStarterDeckFrom(vocab, 'vocabulary', lib, collectionFromRows(rows), ctx('again'));
    expect(second.kind).toBe('upToDate');
    expect(second.plan.summary.inTargetDeck).toBe(fx.notes.length);
    expect(second.plan.deck).toBeNull();
    expect(second.plan.cards.add).toEqual([]);
  });

  test('a newer bundled file updates the same deck and keeps every card and its progress', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    let lib = apply(emptyLib(), first.plan);
    const deckId = (first.plan.deck as Deck).id;
    // The learner studied "das Haus" in both directions.
    const haus = lib.notes.find((n) => n.guid === 'g-haus') as Note;
    lib = {
      ...lib,
      cards: lib.cards.map((c) =>
        c.noteId === haus.id ? { ...c, reps: 3, intervalDays: 6, stepIndex: null, lastReviewedAt: FIXED_NOW } : c,
      ),
    };
    const before = lib.cards.map((c) => ({ ...c }));

    // Version 2: "das Haus" has a better meaning, and one word is new.
    const v2Words: Word[] = [
      ...WORDS.map((w) => (w.guid === 'g-haus' ? { ...w, meaning: 'the house, the building' } : w)),
      { guid: 'g-baum', word: 'der Baum', meaning: 'the tree', level: 'A1' },
    ];
    const next = planStarterDeckFrom(PACK_V2, 'words', lib, starterCollection(v2Words), ctx('v2'));
    expect(next.kind).toBe('update');
    expect(next.existingDeckId).toBe(deckId);
    expect(next.plan.deck).toBeNull();
    expect(next.plan.noteTypes.add).toEqual([]);
    expect(next.plan.notes.update).toEqual([
      { id: haus.id, fields: ['das Haus', 'the house, the building', 'A1'], tags: [] },
    ]);
    expect(next.plan.notes.add.map((n) => [n.guid, n.source.ref])).toEqual([['g-baum', 'pack:german:words@2']]);
    expect(next.plan.cards.add).toHaveLength(2);
    expect(next.plan.cards.add.every((c) => c.deckId === deckId)).toBe(true);
    const oldIds = new Set(before.map((c) => c.id));
    expect(next.plan.cards.add.some((c) => oldIds.has(c.id))).toBe(false);

    const after = apply(lib, next.plan);
    expect(after.decks).toHaveLength(1);
    expect(after.cards.slice(0, before.length)).toEqual(before); // same ids, same progress
    expect(after.notes.find((n) => n.id === haus.id)?.fields[1]).toBe('the house, the building');
    // The new note comes after the deck's current cards.
    const baum = after.notes.find((n) => n.guid === 'g-baum') as Note;
    expect(baum.order).toBeGreaterThan(Math.max(...before.map((c) => c.newPos)));
    // And then it is up to date again.
    expect(planStarterDeckFrom(PACK_V2, 'words', after, starterCollection(v2Words), ctx('v2b')).kind).toBe('upToDate');
  });

  test('a newer file that ADDS a field upgrades the card type: an "update", every note gets the field, ONE card type (§9.6)', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const lib = apply(emptyLib(), first.plan);
    const typeId = first.plan.noteTypes.add[0].id;
    // The learner gave the meaning field a label of their own (deck page): it stays.
    const own: Lib = {
      ...lib,
      noteTypes: lib.noteTypes.map((t) => ({ ...t, fields: t.fields.map((f) => (f.name === 'Meaning' ? { ...f, label: 'English' } : f)) })),
    };

    // Version 2 (a rebuilt deck, §9.6): the same notes (same guids), plus a "Type" field.
    const typed = WORDS.map((w) => ({ ...w, type: w.guid === 'g-ziel' ? 'noun, goal' : 'noun' }));
    const next = planStarterDeckFrom(PACK_V2, 'words', own, starterCollection(typed, MID, { typeField: true }), ctx('v2'));
    expect(next.kind).toBe('update'); // never "Already up to date."
    expect(next.plan.noteTypes.add).toEqual([]);
    expect(next.plan.noteTypes.reuse[MID]).toBe(typeId);
    expect(next.plan.noteTypes.upgrade.map((u) => [u.type.id, u.fromFields, u.type.fields.map((f) => f.name)])).toEqual([
      [typeId, ['Word', 'Meaning', 'Level'], ['Word', 'Meaning', 'Level', 'Type']],
    ]);
    const upgraded = next.plan.noteTypes.upgrade[0].type;
    expect(upgraded.fields.slice(0, 3)).toEqual(own.noteTypes[0].fields); // its own settings, the label too
    // The new field gets the import's choice for it (a starter deck: suggestMapping with the pack presets).
    const suggested = suggestMapping(starterCollection(typed, MID, { typeField: true }), PACK.cardTypePresets).types[0].fields[3];
    expect(upgraded.fields[3]).toEqual(suggested);
    expect(upgraded.fields[3].name).toBe('Type');
    expect(next.plan.notes.update).toHaveLength(6);
    expect(next.plan.summary).toMatchObject({ inTargetDeck: 6, notesUpdated: 6, notesUnchanged: 0, cardTypesUpdated: 1 });

    const after = apply(own, next.plan);
    expect(after.noteTypes.map((t) => [t.id, t.fields.map((f) => f.name)])).toEqual([[typeId, ['Word', 'Meaning', 'Level', 'Type']]]);
    expect(after.notes.every((n) => n.fields.length === 4)).toBe(true);
    expect(after.notes.find((n) => n.guid === 'g-ziel')?.fields).toEqual(['das Ziel', 'the goal', 'B1', 'noun, goal']);
    expect(after.cards).toEqual(own.cards); // every card and its progress stays
    // Then it is up to date.
    expect(planStarterDeckFrom(PACK_V2, 'words', after, starterCollection(typed, MID, { typeField: true }), ctx('v2b')).kind).toBe(
      'upToDate',
    );

    // A NEW note of that file gets the SAME (upgraded) card type: the deck keeps one.
    const more = [...typed, { guid: 'g-baum', word: 'der Baum', meaning: 'the tree', level: 'A1', type: 'noun' }];
    const withNew = planStarterDeckFrom(PACK_V2, 'words', own, starterCollection(more, MID, { typeField: true }), ctx('v2c'));
    expect(withNew.plan.noteTypes.add).toEqual([]);
    expect(withNew.plan.notes.add.map((n) => [n.typeId, n.fields])).toEqual([[typeId, ['der Baum', 'the tree', 'A1', 'noun']]]);
  });

  test('a note the newer file moved to another subdeck (B1 → A1) moves to that section; its cards keep their progress', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const lib = apply(emptyLib(), first.plan);
    const ziel = lib.notes.find((n) => n.guid === 'g-ziel') as Note;
    expect(ziel.section).toBe('B1');
    // Version 2: "das Ziel" is an A1 word now (its Level, and its subdeck Starter::A1).
    const v2 = WORDS.map((w) => (w.guid === 'g-ziel' ? { ...w, level: 'A1' } : w));
    const next = planStarterDeckFrom(PACK_V2, 'words', lib, starterCollection(v2), ctx('v2'));
    expect(next.kind).toBe('update');
    expect(next.plan.notes.update).toEqual([{ id: ziel.id, fields: ['das Ziel', 'the goal', 'A1'], tags: [], section: 'A1' }]);
    const after = apply(lib, next.plan);
    expect(after.notes.find((n) => n.id === ziel.id)?.section).toBe('A1');
    expect(after.cards).toEqual(lib.cards);
    expect(planStarterDeckFrom(PACK_V2, 'words', after, starterCollection(v2), ctx('v2b')).kind).toBe('upToDate');
  });

  test('a newer file whose new field is EMPTY changes no value, but the card type is still upgraded: an "update"', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const lib = apply(emptyLib(), first.plan);
    const next = planStarterDeckFrom(PACK_V2, 'words', lib, starterCollection(WORDS, MID, { typeField: true }), ctx('v2'));
    expect(next.kind).toBe('update');
    expect(next.plan.notes.update).toEqual([]); // the values are the same once moved to the new field order
    expect(next.plan.summary).toMatchObject({ notesUnchanged: 6, notesUpdated: 0, cardTypesUpdated: 1 });
    const after = apply(lib, next.plan);
    expect(after.notes.every((n) => n.fields.length === 4 && n.fields[3] === '')).toBe(true);
  });

  test('notes that a newer file DROPPED are retired: kept with their progress, cards suspended, tagged — once', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const deckId = (first.plan.deck as Deck).id;
    let lib = apply(emptyLib(), first.plan);
    const ziel = lib.notes.find((n) => n.guid === 'g-ziel') as Note;
    // The learner studied "das Ziel", and added a card of their own to the starter deck.
    lib = { ...lib, cards: lib.cards.map((c) => (c.noteId === ziel.id ? { ...c, reps: 4, intervalDays: 9, stepIndex: null } : c)) };
    const ownNote: Note = { ...ziel, id: 'n-own', guid: 'm-own', tags: [], source: { kind: 'manual' } };
    const ownCard: Card = { ...lib.cards.find((c) => c.noteId === ziel.id && c.ord === 0)!, id: 'c-own', noteId: 'n-own', deckId };
    lib = { ...lib, notes: [...lib.notes, ownNote], cards: [...lib.cards, ownCard] };

    // Version 2 drops "das Ziel" (for example a duplicate).
    const v2 = WORDS.filter((w) => w.guid !== 'g-ziel');
    const next = planStarterDeckFrom(PACK_V2, 'words', lib, starterCollection(v2), ctx('v2'));
    expect(next.kind).toBe('update');
    expect(next.plan.notes.retire).toEqual([ziel.id]);
    expect(next.plan.summary).toMatchObject({ notesRetired: 1, notesUpdated: 0, inTargetDeck: 5 });

    const after = apply(lib, next.plan);
    expect(after.notes.find((n) => n.id === ziel.id)?.tags).toEqual([RETIRED_TAG]);
    const zielCards = after.cards.filter((c) => c.noteId === ziel.id);
    expect(zielCards).toHaveLength(2);
    expect(zielCards.every((c) => c.suspended === true && c.reps === 4 && c.intervalDays === 9)).toBe(true);
    // The learner's own card is not from the file: it is never retired.
    expect(after.cards.find((c) => c.id === 'c-own')?.suspended).toBe(false);

    // Once: the next add of the same file has nothing to retire …
    expect(planStarterDeckFrom(PACK_V2, 'words', after, starterCollection(v2), ctx('v2b')).kind).toBe('upToDate');
    // … also after the learner unsuspended "das Ziel" to keep studying it.
    const kept: Lib = { ...after, cards: after.cards.map((c) => ({ ...c, suspended: false })) };
    const third = planStarterDeckFrom(PACK_V2, 'words', kept, starterCollection(v2), ctx('v2c'));
    expect(third.plan.notes.retire).toEqual([]);
    expect(third.kind).toBe('upToDate');
  });

  test('retiring looks only at the starter deck and at the file\'s own guids', () => {
    // "Add as a new deck" after a delete that kept the cards: the starter deck holds COPIES ('m-…' guids).
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const unfiledLib = deleteKeepingCards(apply(emptyLib(), first.plan), (first.plan.deck as Deck).id, unfiledDeck());
    const copy = planStarterDeckFrom(PACK, 'words', unfiledLib, starterCollection(), ctx('copy'), { elsewhere: 'copy' });
    const withCopies = apply(unfiledLib, copy.plan);
    // Version 2 drops "das Ziel": its copy in the starter deck and the note in "Unfiled cards" stay as they are.
    const v2 = WORDS.filter((w) => w.guid !== 'g-ziel');
    const next = planStarterDeckFrom(PACK_V2, 'words', withCopies, starterCollection(v2), ctx('v2'));
    expect(next.plan.notes.retire).toEqual([]);
    expect(next.plan.summary.notesRetired).toBe(0);

    // The first add of a deck retires nothing (there is no starter deck yet).
    expect(planStarterDeckFrom(PACK_V2, 'words', emptyLib(), starterCollection(v2), ctx('new')).plan.notes.retire).toEqual([]);
  });

  test('a deleted starter deck can be added again', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const lib = apply(emptyLib(), first.plan);
    // Delete the deck: its cards, then the notes left without cards (no-orphan rule).
    const deleted: Lib = { ...lib, decks: [], cards: [], notes: [] };
    const again = planStarterDeckFrom(PACK, 'words', deleted, starterCollection(), ctx('again'));
    expect(again.kind).toBe('add');
    expect(again.plan.deck?.sourceKey).toBe('pack:german:words');
    expect(again.plan.deck?.id).not.toBe(first.plan.deck?.id);
    expect(again.plan.cards.add).toHaveLength(12);
    expect(again.elsewhereDecks).toEqual([]);
  });

  test("deleted with 'keep' (Unfiled cards): 'elsewhere' names the deck, and 'copy' adds the starter deck again", () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const starterId = (first.plan.deck as Deck).id;
    const lib = deleteKeepingCards(apply(emptyLib(), first.plan), starterId, unfiledDeck());
    expect(starterDeckRows(PACK, lib.decks)).toEqual([{ starter: WORDS_STARTER, deckId: null }]);

    // No starter deck, and no deck is made: every note is already in "Unfiled cards".
    const again = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('again'));
    expect(again.kind).toBe('elsewhere');
    expect(again.existingDeckId).toBeNull();
    expect(again.plan.deck).toBeNull();
    expect(again.plan.notes.add).toEqual([]);
    expect(again.plan.cards.add).toEqual([]);
    expect(again.plan.summary).toMatchObject({ inOtherDecks: 6, notesUnchanged: 6, notesAdded: 0 });
    expect(again.elsewhereDecks).toEqual([{ deckId: 'unfiled', deckName: 'Unfiled cards', notes: 6 }]);

    // The way out, "Add as a new deck": copies (new guids) in a new starter deck.
    const copy = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('copy'), { elsewhere: 'copy' });
    expect(copy.kind).toBe('add');
    expect(copy.plan.deck?.sourceKey).toBe('pack:german:words');
    expect(copy.plan.cards.add).toHaveLength(12);
    expect(copy.plan.notes.add.every((n) => n.guid.startsWith('m-'))).toBe(true);
    expect(copy.elsewhereDecks).toEqual([{ deckId: 'unfiled', deckName: 'Unfiled cards', notes: 6 }]);

    // The starter deck exists again; the Unfiled cards stay as they are.
    const added = apply(lib, copy.plan);
    const newId = (copy.plan.deck as Deck).id;
    expect(starterDeckRows(PACK, added.decks)).toEqual([{ starter: WORDS_STARTER, deckId: newId }]);
    expect(added.cards.filter((c) => c.deckId === 'unfiled')).toHaveLength(12);
    const third = planStarterDeckFrom(PACK, 'words', added, starterCollection(), ctx('third'));
    expect(third.kind).toBe('upToDate');
    expect(third.existingDeckId).toBe(newId);
    expect(third.elsewhereDecks).toEqual([{ deckId: 'unfiled', deckName: 'Unfiled cards', notes: 6 }]);
  });

  test('"Add as a new deck", then the Unfiled originals deleted: "Add again" finds the copies (never every item twice)', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const lib = deleteKeepingCards(apply(emptyLib(), first.plan), (first.plan.deck as Deck).id, unfiledDeck());
    const copy = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('copy'), { elsewhere: 'copy' });
    const added = apply(lib, copy.plan);
    const starterId = (copy.plan.deck as Deck).id;
    // Clean up: delete "Unfiled cards" with its cards (the originals are gone).
    const unfiledNotes = new Set(added.cards.filter((c) => c.deckId === 'unfiled').map((c) => c.noteId));
    const cleaned: Lib = {
      ...added,
      decks: added.decks.filter((d) => d.id !== 'unfiled'),
      cards: added.cards.filter((c) => c.deckId !== 'unfiled'),
      notes: added.notes.filter((n) => !unfiledNotes.has(n.id)),
    };
    const again = planStarterDeckFrom(PACK, 'words', cleaned, starterCollection(), ctx('again'));
    expect(again.kind).toBe('upToDate');
    expect(again.plan.notes.add).toEqual([]);
    expect(again.plan.summary).toMatchObject({ inTargetDeck: 6, notesAdded: 0 });
    const after = apply(cleaned, again.plan);
    expect(after.cards.filter((c) => c.deckId === starterId)).toHaveLength(12);

    // A newer file updates the copies in place (still 6 items, one each).
    const v2 = WORDS.map((w) => (w.guid === 'g-ziel' ? { ...w, meaning: 'the goal (v2)' } : w));
    const update = planStarterDeckFrom(PACK_V2, 'words', cleaned, starterCollection(v2), ctx('v2'));
    expect(update.kind).toBe('update');
    expect(update.plan.notes.add).toEqual([]);
    expect(update.plan.summary).toMatchObject({ notesUpdated: 1, notesAdded: 0 });
  });

  test("deleted with 'move': 'elsewhere' names the deck the cards went to; a newer file updates them there", () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const starterId = (first.plan.deck as Deck).id;
    const mine = makeDeck({ id: 'd-mine', name: 'My German', order: 1 }, FIXED_NOW);
    const added = apply(emptyLib(), first.plan);
    const lib = deleteKeepingCards({ ...added, decks: [...added.decks, mine] }, starterId, mine);

    const again = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('again'));
    expect(again.kind).toBe('elsewhere');
    expect(again.plan.deck).toBeNull();
    expect(again.elsewhereDecks).toEqual([{ deckId: 'd-mine', deckName: 'My German', notes: 6 }]);

    // Version 2 changes one meaning: it is updated where the note is now
    // ("Update them where they are"), and still no deck is made.
    const v2Words = WORDS.map((w) => (w.guid === 'g-haus' ? { ...w, meaning: 'the house, the building' } : w));
    const next = planStarterDeckFrom(PACK_V2, 'words', lib, starterCollection(v2Words), ctx('v2'));
    expect(next.kind).toBe('elsewhere');
    expect(next.plan.deck).toBeNull();
    expect(next.plan.notes.update).toHaveLength(1);
    expect(next.plan.summary.updatedDecks).toEqual(['My German']);
    expect(next.elsewhereDecks).toEqual([{ deckId: 'd-mine', deckName: 'My German', notes: 6 }]);
  });

  test('only the notes outside the starter deck are named, by deck, most notes first', () => {
    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const starterId = (first.plan.deck as Deck).id;
    const lib = apply(emptyLib(), first.plan);
    const noteOf = (guid: string) => (lib.notes.find((n) => n.guid === guid) as Note).id;
    const a = makeDeck({ id: 'd-a', name: 'Animals', order: 1 }, FIXED_NOW);
    const b = makeDeck({ id: 'd-b', name: 'Big words', order: 2 }, FIXED_NOW);
    // The learner moved the dog to "Animals" and two B1 words to "Big words".
    const where = new Map([
      [noteOf('g-hund'), 'd-a'],
      [noteOf('g-anlass'), 'd-b'],
      [noteOf('g-umwelt'), 'd-b'],
    ]);
    const moved: Lib = {
      ...lib,
      decks: [...lib.decks, a, b],
      cards: lib.cards.map((c) => ({ ...c, deckId: where.get(c.noteId) ?? c.deckId })),
    };
    const again = planStarterDeckFrom(PACK, 'words', moved, starterCollection(), ctx('again'));
    // The starter deck still exists, so this is not 'elsewhere'.
    expect(again.kind).toBe('upToDate');
    expect(again.existingDeckId).toBe(starterId);
    expect(again.plan.summary).toMatchObject({ inTargetDeck: 3, inOtherDecks: 3 });
    expect(again.elsewhereDecks).toEqual([
      { deckId: 'd-b', deckName: 'Big words', notes: 2 },
      { deckId: 'd-a', deckName: 'Animals', notes: 1 },
    ]);
  });
});

/* ---------------------------------------------------------------- choices */

describe('planStarterDeckFrom — choices', () => {
  test("new cards follow the target deck's arrival setting, unless the caller says otherwise", () => {
    expect(
      planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx(), { arrival: 'notStarted' }).plan.cards.add.every(
        (c) => c.newState === 'notStarted',
      ),
    ).toBe(true);

    const first = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx());
    const lib = apply(emptyLib(), first.plan);
    const choosy: Lib = { ...lib, decks: lib.decks.map((d) => ({ ...d, options: { ...d.options, newArrival: 'notStarted' } })) };
    const more = [...WORDS, { guid: 'g-baum', word: 'der Baum', meaning: 'the tree', level: 'A1' as const }];
    const next = planStarterDeckFrom(PACK_V2, 'words', choosy, starterCollection(more), ctx('v2'));
    expect(next.plan.cards.add.map((c) => c.newState)).toEqual(['notStarted', 'notStarted']);
    const queued = planStarterDeckFrom(PACK_V2, 'words', choosy, starterCollection(more), ctx('v2'), { arrival: 'queued' });
    expect(queued.plan.cards.add.map((c) => c.newState)).toEqual(['queued', 'queued']);
  });

  test('"Where do you start?": easier levels are marked Known', () => {
    const probe = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx()).plan.summary;
    const group = probe.placementGroups.find((g) => g.facet === 'field:level');
    expect(group?.values).toEqual(['A1', 'B1']);
    // By VALUE (W3-8 hardening): the caller says "B1", the plan finds it in this deck.
    const { plan } = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(), ctx(), {
      placement: { facet: 'field:level', fromValue: 'B1', below: 'known' },
    });
    const levelOf = new Map(plan.notes.add.map((n) => [n.id, n.fields[2]]));
    for (const c of plan.cards.add) {
      if (levelOf.get(c.noteId) === 'A1') expect(c.knownAt).toBe(FIXED_NOW);
      else expect(c.knownAt ?? null).toBeNull();
    }
    expect(plan.summary.markedKnown).toBe(6);
  });

  test('"Where do you start?" by value works on a deck with NO A1 (the fixed A1 … C2 list does not fit its values)', () => {
    // The same six words, with the levels A2, B1 and B2 (two each).
    const levels = ['A2', 'A2', 'B1', 'B1', 'B2', 'B2'];
    const noA1: Word[] = WORDS.map((w, i) => ({ ...w, level: levels[i] }));
    const probe = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(noA1), ctx()).plan.summary;
    expect(probe.placementGroups.find((g) => g.facet === 'field:level')?.values).toEqual(['A2', 'B1', 'B2']);
    // Onboarding asks once, from A1 … C2: "B1" is index 2 there, but index 1 in this deck.
    const { plan } = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(noA1), ctx(), {
      placement: { facet: 'field:level', fromValue: 'B1', below: 'known' },
    });
    const levelOf = new Map(plan.notes.add.map((n) => [n.id, n.fields[2]]));
    const known = plan.cards.add.filter((c) => c.knownAt != null).map((c) => levelOf.get(c.noteId));
    // Both directions of the two A2 notes; B1 is NOT easier than B1.
    expect(known).toEqual(['A2', 'A2', 'A2', 'A2']);
    expect(plan.summary.markedKnown).toBe(4);
    // "Leave them not started" the same way.
    const later = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(noA1), ctx(), {
      placement: { facet: 'field:level', fromValue: 'B1', below: 'notStarted' },
    }).plan;
    const laterLevel = new Map(later.notes.add.map((n) => [n.id, n.fields[2]]));
    expect(later.cards.add.filter((c) => c.newState === 'notStarted').map((c) => laterLevel.get(c.noteId))).toEqual([
      'A2',
      'A2',
      'A2',
      'A2',
    ]);
  });

  test('starterPlacementRank: the first value at or above the asked one, on one ordinal scale', () => {
    const groups = [{ facet: 'field:level', values: ['A2', 'B1', 'B2'] }];
    const rank = (fromValue: string, facet = 'field:level') => starterPlacementRank(groups, { facet, fromValue });
    expect(rank('B1')).toBe(1);
    expect(rank('b1')).toBe(1);
    expect(rank('A1')).toBe(0); // nothing is easier
    expect(rank('C1')).toBe(3); // every value is easier
    expect(rank('B1+')).toBe(2); // a sub-level sorts between B1 and B2
    expect(rank('B1', 'section')).toBeNull(); // no such group: no placement
    expect(rank('')).toBeNull();
    // Values that are not one ordinal scale: only the same value counts.
    const names = [{ facet: 'section', values: ['Basics', 'Travel'] }];
    expect(starterPlacementRank(names, { facet: 'section', fromValue: 'travel' })).toBe(1);
    expect(starterPlacementRank(names, { facet: 'section', fromValue: 'B1' })).toBeNull();
  });

  test('notes already in another deck are updated where they are (default) or copied', () => {
    const lib = fileImportLib();
    const update = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('s'));
    // Every note is already in the file-import deck and unchanged: no empty
    // deck, nothing doubled. There is no starter deck, so it is 'elsewhere'
    // (not "Already up to date."), and the plan names the deck.
    expect(update.kind).toBe('elsewhere');
    expect(update.plan.deck).toBeNull();
    expect(update.plan.notes.add).toEqual([]);
    expect(update.plan.summary.inOtherDecks).toBe(6);
    expect(update.elsewhereDecks).toEqual([{ deckId: lib.decks[0].id, deckName: 'Starter words', notes: 6 }]);

    const copy = planStarterDeckFrom(PACK, 'words', lib, starterCollection(), ctx('c'), { elsewhere: 'copy' });
    expect(copy.kind).toBe('add');
    expect(copy.plan.notes.add).toHaveLength(6);
    expect(copy.plan.notes.add.every((n) => n.guid.startsWith('m-'))).toBe(true);
  });

  test('H2: a model id "__proto__" from the file still gets the pack presets', () => {
    const { plan } = planStarterDeckFrom(PACK, 'words', emptyLib(), starterCollection(WORDS, '__proto__'), ctx());
    expect(plan.noteTypes.add).toHaveLength(1);
    expect(plan.noteTypes.add[0].source).toEqual({ ankiMid: '__proto__', packId: 'german' });
    expect(plan.noteTypes.add[0].fields.map((f) => f.lang)).toEqual(['de-DE', 'en-US', undefined]);
    expect(plan.cards.add).toHaveLength(12);
  });
});

/* ------------------------------------------------------------ from bytes */

describe('planStarterDeck — from the .apkg bytes', () => {
  test('the real reader gives the same plan as the pure version', async () => {
    const fromBytes = await planStarterDeck(PACK, 'words', emptyLib(), starterApkg(), ctx());
    const pure = planStarterDeckFrom(
      PACK,
      'words',
      emptyLib(),
      collectionFromRows({ ...starterRows(), fileName: 'Starter words.apkg' }),
      ctx(),
    );
    expect(fromBytes).toEqual(pure);
    expect(fromBytes.kind).toBe('add');
  });

  test('idempotent from bytes: the second run is "upToDate"', async () => {
    const first = await planStarterDeck(PACK, 'words', emptyLib(), starterApkg(), ctx());
    const lib = apply(emptyLib(), first.plan);
    const second = await planStarterDeck(PACK, 'words', lib, starterApkg(), ctx('again'));
    expect(second.kind).toBe('upToDate');
    expect(second.plan.deck).toBeNull();
    expect(second.plan.notes.add).toEqual([]);
  });

  test('an unknown key fails before reading; a bad file is an ApkgError', async () => {
    await expect(planStarterDeck(PACK, 'verbs', emptyLib(), starterApkg(), ctx())).rejects.toThrow('no starter deck');
    await expect(planStarterDeck(PACK, 'words', emptyLib(), strToU8('not a zip'), ctx())).rejects.toBeInstanceOf(
      ApkgError,
    );
  });

  test("the spec's call planStarterDeck(pack, key, state, bytes) works: time now, starter ids (W3-8 hardening)", async () => {
    const plan = await planStarterDeck(PACK, 'words', emptyLib(), starterApkg());
    expect(plan.kind).toBe('add');
    expect(plan.plan.cards.add).toHaveLength(12);
    const ids = [plan.plan.deck?.id ?? '', ...plan.plan.notes.add.map((n) => n.id), ...plan.plan.cards.add.map((c) => c.id)];
    expect(ids.every((id) => /^p-/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // Idempotent the same way, without a ctx.
    const second = await planStarterDeck(PACK, 'words', apply(emptyLib(), plan.plan), starterApkg());
    expect(second.kind).toBe('upToDate');
  });
});

/* ------------------------------------------------------------ addStarterDeck */

/** One call of the fake image writer: the folders, and what the reader gave for each file name. */
interface WriteCall {
  folders: ImportMediaFolder[];
  bytes: Map<string, Uint8Array | null>;
  bytesOf: StarterMediaBytes;
}

/**
 * A tiny store: the state, applyImport and flush, like the engine's actions,
 * and an image writer. `flushResult` is what the next flush() resolves;
 * `writeError` makes the writer throw. `events` is the order of the calls.
 */
function fakeStore(initial: Lib = emptyLib()) {
  const store = {
    state: initial,
    applied: [] as ImportPlan[],
    flushes: 0,
    flushResult: { ok: true } as FlushResult,
    written: [] as WriteCall[],
    writeError: null as Error | null,
    events: [] as string[],
    getState: () => store.state,
    applyImport: (plan: ImportPlan): ImportResult => {
      const result = resultOf(store.state, plan);
      store.state = apply(store.state, plan);
      store.applied.push(plan);
      store.events.push('applyImport');
      return result;
    },
    flush: async (): Promise<FlushResult> => {
      store.flushes += 1;
      store.events.push('flush');
      return store.flushResult;
    },
    writeMedia: async (folders: ImportMediaFolder[], bytesOf: StarterMediaBytes): Promise<void> => {
      store.events.push('writeMedia');
      if (store.writeError) throw store.writeError;
      const bytes = new Map<string, Uint8Array | null>();
      for (const f of folders) for (const name of f.files) bytes.set(name, bytesOf(name));
      store.written.push({ folders, bytes, bytesOf });
    },
    now: () => FIXED_NOW,
  };
  return store;
}

describe('addStarterDeck — read, plan on the current state, apply, save', () => {
  test('reads the bundled asset once, adds the deck, saves; the second add applies nothing', async () => {
    mockFiles.set('file:///cache/pack-7.apkg', starterApkg());
    const store = fakeStore();

    const first = await addStarterDeck(PACK, 'words', store);
    expect(Asset.fromModule).toHaveBeenCalledWith(7);
    expect(mockFileUris).toEqual(['file:///cache/pack-7.apkg']); // the downloaded local copy
    expect(first.kind).toBe('add');
    expect(first.starter).toBe(WORDS_STARTER);
    expect(store.applied).toHaveLength(1);
    expect(store.flushes).toBe(1);
    expect(store.state.decks).toHaveLength(1);
    expect(first.deckId).toBe(store.state.decks[0].id);
    expect(first.result).toMatchObject({ deckCreated: true, notesAdded: 6, cardsAdded: 12, media: [] });
    expect(store.state.decks[0].sourceKey).toBe('pack:german:words');
    // The default ids are the starter ids.
    expect(store.state.cards.every((c) => /^p-/.test(c.id))).toBe(true);
    // Saved; no image in this deck, so the writer is not called.
    expect(first.saved).toEqual({ ok: true });
    expect(first.images).toBe('none');
    expect(store.events).toEqual(['applyImport', 'flush']);

    const second = await addStarterDeck(PACK, 'words', store);
    expect(second).toEqual({
      kind: 'upToDate',
      starter: WORDS_STARTER,
      result: null,
      deckId: first.deckId,
      saved: null,
      images: 'none',
      elsewhereDecks: [],
    });
    expect(store.applied).toHaveLength(1);
    expect(store.flushes).toBe(1);
    expect(store.written).toEqual([]);
    expect(store.state.decks).toHaveLength(1);
    expect(store.state.cards).toHaveLength(12);
  });

  test('a newer bundled file updates the same deck', async () => {
    const store = fakeStore();
    await addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => starterApkg() });
    const deckId = store.state.decks[0].id;
    const more = [...WORDS, { guid: 'g-baum', word: 'der Baum', meaning: 'the tree', level: 'A1' as const }];

    const next = await addStarterDeck(PACK_V2, 'words', { ...store, loadBytes: async () => starterApkg(more) });
    expect(next.kind).toBe('update');
    expect(next.deckId).toBe(deckId);
    expect(next.result).toMatchObject({ deckCreated: false, notesAdded: 1, cardsAdded: 2 });
    expect(store.state.decks).toHaveLength(1);
    expect(store.state.cards).toHaveLength(14);
  });

  test("deleted with 'keep': the outcome is 'elsewhere' and names the deck; 'copy' adds the starter deck again", async () => {
    const store = fakeStore();
    const deps = { ...store, loadBytes: async () => starterApkg() };
    const first = await addStarterDeck(PACK, 'words', deps);
    store.state = deleteKeepingCards(store.state, first.deckId as Id, unfiledDeck());

    // Nothing changes and nothing is saved, but the outcome says why and where.
    const again = await addStarterDeck(PACK, 'words', deps);
    expect(again).toEqual({
      kind: 'elsewhere',
      starter: WORDS_STARTER,
      result: null,
      deckId: null,
      saved: null,
      images: 'none',
      elsewhereDecks: [{ deckId: 'unfiled', deckName: 'Unfiled cards', notes: 6 }],
    });
    expect(store.applied).toHaveLength(1);
    expect(store.flushes).toBe(1);

    // "Add as a new deck".
    const copy = await addStarterDeck(PACK, 'words', deps, { elsewhere: 'copy' });
    expect(copy.kind).toBe('add');
    expect(copy.result).toMatchObject({ deckCreated: true, notesAdded: 6, cardsAdded: 12 });
    expect(copy.saved).toEqual({ ok: true });
    expect(copy.deckId).toBe(findStarterDeck(store.state.decks, 'german', 'words')?.id);
    expect(starterDeckRows(PACK, store.state.decks)).toEqual([{ starter: WORDS_STARTER, deckId: copy.deckId }]);
    expect(store.state.cards).toHaveLength(24);
    // And now it is up to date.
    expect((await addStarterDeck(PACK, 'words', deps)).kind).toBe('upToDate');
  });

  test("'elsewhere' with a newer file: the notes are updated where they are and saved; deckId stays null", async () => {
    const store = fakeStore();
    const first = await addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => starterApkg() });
    const mine = makeDeck({ id: 'd-mine', name: 'My German', order: 1 }, FIXED_NOW);
    store.state = deleteKeepingCards({ ...store.state, decks: [...store.state.decks, mine] }, first.deckId as Id, mine);

    const v2Words = WORDS.map((w) => (w.guid === 'g-haus' ? { ...w, meaning: 'the house, the building' } : w));
    const next = await addStarterDeck(PACK_V2, 'words', { ...store, loadBytes: async () => starterApkg(v2Words) });
    expect(next.kind).toBe('elsewhere');
    // The fake applyImport says 'd-mine' (the deck of the updated note); there is still no starter deck.
    expect(next.deckId).toBeNull();
    expect(next.result).toMatchObject({ deckCreated: false, notesAdded: 0, notesUpdated: 1, updatedDecks: ['My German'] });
    expect(next.saved).toEqual({ ok: true });
    expect(next.elsewhereDecks).toEqual([{ deckId: 'd-mine', deckName: 'My German', notes: 6 }]);
    expect(store.applied).toHaveLength(2);
    expect(store.state.decks.map((d) => d.id)).toEqual(['d-mine']);
    expect(store.state.notes.find((n) => n.guid === 'g-haus')?.fields[1]).toBe('the house, the building');
  });

  test('two quick taps on "Add" make ONE deck', async () => {
    const store = fakeStore();
    const deps = { ...store, loadBytes: async () => starterApkg() };
    const [a, b] = await Promise.all([addStarterDeck(PACK, 'words', deps), addStarterDeck(PACK, 'words', deps)]);
    expect([a.kind, b.kind].sort()).toEqual(['add', 'upToDate']);
    expect(store.state.decks).toHaveLength(1);
    expect(store.state.notes).toHaveLength(6);
    expect(store.state.cards).toHaveLength(12);
    expect(a.deckId).toBe(b.deckId);
  });

  test('two starter decks added at the same time get different ids (same millisecond, same salt)', async () => {
    // Onboarding "Start with German" may add the starter decks with Promise.all.
    const MORE: StarterDeck = { key: 'more', title: 'More words', subtitle: '6 more words', asset: 8, version: 1 };
    const twoDecks: ContentPack = { ...PACK, starterDecks: [WORDS_STARTER, MORE] };
    const moreWords = WORDS.map((w) => ({ ...w, guid: `${w.guid}-more` }));
    const store = fakeStore();
    const deps = {
      ...store,
      loadBytes: async (s: StarterDeck) => (s.key === 'more' ? starterApkg(moreWords) : starterApkg()),
    };
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      const [a, b] = await Promise.all([addStarterDeck(twoDecks, 'words', deps), addStarterDeck(twoDecks, 'more', deps)]);
      expect([a.kind, b.kind]).toEqual(['add', 'add']);
      expect(a.deckId).not.toBe(b.deckId);
    } finally {
      random.mockRestore();
    }
    expect(store.state.decks.map((d) => d.sourceKey)).toEqual(['pack:german:words', 'pack:german:more']);
    const ids = [
      ...store.state.decks.map((d) => d.id),
      ...store.state.noteTypes.map((t) => t.id),
      ...store.state.notes.map((n) => n.id),
      ...store.state.cards.map((c) => c.id),
    ];
    expect(ids).toHaveLength(2 + 1 + 12 + 24);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a bad file or an unknown key changes nothing', async () => {
    const store = fakeStore();
    await expect(
      addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => strToU8('broken') }),
    ).rejects.toBeInstanceOf(ApkgError);
    await expect(addStarterDeck(PACK, 'verbs', store)).rejects.toThrow('no starter deck');
    await expect(addStarterDeck(genericPack, 'words', store)).rejects.toThrow('no starter deck');
    expect(store.applied).toEqual([]);
    expect(store.flushes).toBe(0);
    expect(store.state).toEqual(emptyLib());
    expect(Asset.fromModule).not.toHaveBeenCalled();
  });

  test('a bundled file that cannot be loaded is an ApkgError too, and changes nothing', async () => {
    const store = fakeStore();
    // The default loader: the asset has no file behind it (the fake File.bytes() throws).
    const missing = addStarterDeck(PACK, 'words', store);
    await expect(missing).rejects.toBeInstanceOf(ApkgError);
    await expect(missing).rejects.toMatchObject({
      code: 'corrupt',
      message: 'The starter deck "Starter words" could not be loaded: no file file:///cache/pack-7.apkg',
    });
    expect(Asset.fromModule).toHaveBeenCalledWith(7);
    // A loader that throws something that is not an Error.
    const odd = addStarterDeck(PACK, 'words', { ...store, loadBytes: () => Promise.reject('gone') });
    await expect(odd).rejects.toMatchObject({ code: 'corrupt', message: 'The starter deck "Starter words" could not be loaded: gone' });
    // An ApkgError of the loader is passed on as it is.
    const own = new ApkgError('empty', 'No notes in the collection.');
    await expect(addStarterDeck(PACK, 'words', { ...store, loadBytes: () => Promise.reject(own) })).rejects.toBe(own);
    expect(store.applied).toEqual([]);
    expect(store.flushes).toBe(0);
    expect(store.state).toEqual(emptyLib());
  });
});

/* ------------------------------------- addStarterDeck — a caller's arrival rule */

/**
 * The AddSheet's way in (wave 5c): `addStarterDeck` with a StarterArrivalRule
 * (the sheet's D3), so the sheet has no copy of the add steps. The reader and
 * the planner are counted (`readFile`, `planDeck`), and so are the rule's two
 * steps.
 */
function countedDeps(store: ReturnType<typeof fakeStore>, words: Word[] = WORDS) {
  const reads: string[] = [];
  const plans: (string | undefined)[] = [];
  const deps: StarterDeps = {
    ...store,
    loadBytes: async () => starterApkg(words),
    readFile: async (bytes, name) => {
      reads.push(name);
      return readApkg(bytes, name);
    },
    planDeck: (...args) => {
      plans.push(args[5]?.arrival);
      return planStarterDeckFrom(...args);
    },
  };
  return { deps, reads, plans };
}

/** A rule with fixed answers, which records what it was asked. */
function fixedRule(guess: 'queued' | 'notStarted', answer: 'queued' | 'notStarted' | undefined) {
  const asked = { guesses: 0, plans: [] as StarterDeckPlan[] };
  const rule: StarterArrivalRule = {
    guess: () => {
      asked.guesses += 1;
      return guess;
    },
    fromPlan: (planned) => {
      asked.plans.push(planned);
      return answer;
    },
  };
  return { rule, asked };
}

describe("addStarterDeck — a caller's arrival rule (the AddSheet's D3, wave 5c)", () => {
  test('a right guess: ONE read, ONE plan with the guess, and the outcome says what the cards got', async () => {
    const store = fakeStore();
    const { deps, reads, plans } = countedDeps(store);
    const { rule, asked } = fixedRule('notStarted', 'notStarted');
    const out = await addStarterDeck(PACK, 'words', deps, {}, rule);
    expect(reads).toEqual(['Starter words.apkg']);
    expect(plans).toEqual(['notStarted']);
    expect(asked.guesses).toBe(1);
    expect(asked.plans.map((p) => p.plan.summary.newCards)).toEqual([12]);
    expect(out).toMatchObject({ kind: 'add', arrival: 'notStarted', saved: { ok: true }, images: 'none' });
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0].cards.add.every((c) => c.newState === 'notStarted')).toBe(true);
    expect(store.applied[0].deck?.options.newArrival).toBe('notStarted');
    expect(out.deckId).toBe(store.state.decks[0].id);
  });

  test("a wrong guess: one more plan from the SAME read, with the plan's own answer", async () => {
    const store = fakeStore();
    const { deps, reads, plans } = countedDeps(store);
    const { rule } = fixedRule('notStarted', 'queued');
    const out = await addStarterDeck(PACK, 'words', deps, {}, rule);
    expect(reads).toHaveLength(1);
    expect(plans).toEqual(['notStarted', 'queued']);
    expect(out.arrival).toBe('queued');
    expect(store.applied).toHaveLength(1); // only the second plan is applied
    expect(store.applied[0].cards.add.every((c) => c.newState === 'queued')).toBe(true);
  });

  test('a rule that keeps the guess (undefined): one plan, the guess is the answer', async () => {
    const store = fakeStore();
    const { deps, plans } = countedDeps(store);
    const out = await addStarterDeck(PACK, 'words', deps, {}, fixedRule('queued', undefined).rule);
    expect(plans).toEqual(['queued']);
    expect(out.arrival).toBe('queued');
  });

  test("the caller's own arrival, or a starter deck that is there: the rule is never asked", async () => {
    const store = fakeStore();
    const { deps, plans } = countedDeps(store);
    const first = fixedRule('notStarted', 'notStarted');
    // The caller chose (onboarding's "Let me choose what to learn" passes 'notStarted' itself).
    const chosen = await addStarterDeck(PACK, 'words', deps, { arrival: 'queued' }, first.rule);
    expect(first.asked).toEqual({ guesses: 0, plans: [] });
    expect(plans).toEqual(['queued']);
    expect(chosen.kind).toBe('add');
    expect(chosen).not.toHaveProperty('arrival');
    expect(store.applied[0].cards.add.every((c) => c.newState === 'queued')).toBe(true);
    // The deck is in the library now: it keeps its own "new cards start" setting.
    const again = fixedRule('notStarted', 'notStarted');
    const second = await addStarterDeck(PACK, 'words', deps, {}, again.rule);
    expect(again.asked).toEqual({ guesses: 0, plans: [] });
    expect(second).toEqual({
      kind: 'upToDate',
      starter: WORDS_STARTER,
      result: null,
      deckId: chosen.deckId,
      saved: null,
      images: 'none',
      elsewhereDecks: [],
    });
  });

  test("no new deck after all ('elsewhere'): the guess never reaches the plan that is applied", async () => {
    const store = fakeStore();
    const first = await addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => starterApkg() });
    store.state = deleteKeepingCards(store.state, first.deckId as Id, unfiledDeck());
    // A newer file: one note changed, so the 'elsewhere' plan is applied (where the notes are).
    const v2Words = WORDS.map((w) => (w.guid === 'g-haus' ? { ...w, meaning: 'the house, the building' } : w));
    const { deps, reads, plans } = countedDeps(store, v2Words);
    const { rule, asked } = fixedRule('notStarted', 'notStarted');
    const out = await addStarterDeck(PACK_V2, 'words', deps, {}, rule);
    expect(out.kind).toBe('elsewhere');
    expect(out.deckId).toBeNull();
    expect(out).not.toHaveProperty('arrival');
    expect(reads).toHaveLength(1); // the same read for both plans
    expect(plans).toEqual(['notStarted', undefined]); // the applied plan has the caller's options
    expect(asked.plans).toEqual([]); // no new deck: nothing to decide
    expect(store.applied).toHaveLength(2);
    expect(store.applied[1].summary.notesUpdated).toBe(1);
  });

  test('two quick taps with the rule still make ONE deck', async () => {
    const store = fakeStore();
    const { deps } = countedDeps(store);
    const { rule } = fixedRule('notStarted', 'notStarted');
    const [a, b] = await Promise.all([
      addStarterDeck(PACK, 'words', deps, {}, rule),
      addStarterDeck(PACK, 'words', deps, {}, rule),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['add', 'upToDate']);
    expect(store.state.decks).toHaveLength(1);
    expect(store.state.cards).toHaveLength(12);
  });

  test('a file that cannot be loaded: ApkgError "corrupt", nothing read, planned, asked or applied', async () => {
    const store = fakeStore();
    const { deps, reads, plans } = countedDeps(store);
    const { rule, asked } = fixedRule('notStarted', 'notStarted');
    const out = addStarterDeck(PACK, 'words', { ...deps, loadBytes: () => Promise.reject(new Error('gone')) }, {}, rule);
    await expect(out).rejects.toMatchObject({
      code: 'corrupt',
      message: 'The starter deck "Starter words" could not be loaded: gone',
    });
    expect(reads).toEqual([]);
    expect(plans).toEqual([]);
    expect(asked).toEqual({ guesses: 0, plans: [] });
    expect(store.applied).toEqual([]);
    expect(store.flushes).toBe(0);
  });
});

describe('addStarterDeck — the save result and the images (§5.8)', () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const JPG = new Uint8Array([255, 216, 255, 224, 4, 5]);
  /** "das Haus" shows a picture; the archive also has a picture that no note uses. */
  const WITH_IMAGE: Word[] = WORDS.map((w) =>
    w.guid === 'g-haus' ? { ...w, meaning: 'the house <img src="haus.png">' } : w,
  );
  const imageApkg = () =>
    starterApkg(WITH_IMAGE, [
      ['haus.png', PNG],
      ['unused.jpg', JPG],
    ]);

  test('the images are written AFTER the save, into the new deck folder, from the bundled archive', async () => {
    const store = fakeStore();
    const out = await addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => imageApkg() });
    expect(out.kind).toBe('add');
    expect(out.saved).toEqual({ ok: true });
    expect(out.images).toBe('written');
    expect(out.imagesError).toBeUndefined();
    expect(store.events).toEqual(['applyImport', 'flush', 'writeMedia']);

    const folders = [{ deckFolder: `media/${out.deckId}`, files: ['haus.png'] }];
    expect(out.result?.media).toEqual(folders);
    expect(store.written).toHaveLength(1);
    // Only the image a note uses, with its real bytes; a name the archive lacks gives null.
    expect(store.written[0].folders).toEqual(folders);
    expect(store.written[0].bytes).toEqual(new Map([['haus.png', PNG]]));
    expect(store.written[0].bytesOf('unused.jpg')).toEqual(JPG);
    expect(store.written[0].bytesOf('nope.png')).toBeNull();
  });

  test('an "upToDate" add writes the images again (a missing image comes back) and applies nothing', async () => {
    const store = fakeStore();
    const deps = { ...store, loadBytes: async () => imageApkg() };
    const first = await addStarterDeck(PACK, 'words', deps);
    const again = await addStarterDeck(PACK, 'words', deps);
    expect(again).toMatchObject({ kind: 'upToDate', result: null, deckId: first.deckId, saved: { ok: true }, images: 'written' });
    expect(store.applied).toHaveLength(1);
    expect(store.events).toEqual(['applyImport', 'flush', 'writeMedia', 'flush', 'writeMedia']);
    expect(store.written.map((w) => w.folders)).toEqual([
      [{ deckFolder: `media/${first.deckId}`, files: ['haus.png'] }],
      [{ deckFolder: `media/${first.deckId}`, files: ['haus.png'] }],
    ]);
  });

  test('a save that does not commit is reported, and no image is written until a save works', async () => {
    const store = fakeStore();
    const deps = { ...store, loadBytes: async () => imageApkg() };
    store.flushResult = { ok: false, reason: 'write', cause: new Error('disk full') };

    const out = await addStarterDeck(PACK, 'words', deps);
    // The deck is applied (in memory), and the outcome says it is not on the disk.
    expect(out.kind).toBe('add');
    expect(out.deckId).toBe(store.state.decks[0].id);
    expect(out.saved).toEqual({ ok: false, reason: 'write', cause: new Error('disk full') });
    expect(out.images).toBe('skipped');
    expect(store.events).toEqual(['applyImport', 'flush']);
    expect(store.written).toEqual([]);

    // Saving is blocked (for example a read failure, C1): still no image.
    store.flushResult = { ok: false, reason: 'blocked' };
    const blocked = await addStarterDeck(PACK, 'words', deps);
    expect(blocked).toMatchObject({ kind: 'upToDate', saved: { ok: false, reason: 'blocked' }, images: 'skipped' });
    expect(store.written).toEqual([]);

    // The save works again: the next add writes the images.
    store.flushResult = { ok: true };
    const later = await addStarterDeck(PACK, 'words', deps);
    expect(later).toMatchObject({ kind: 'upToDate', saved: { ok: true }, images: 'written' });
    expect(store.written).toHaveLength(1);
    expect(store.applied).toHaveLength(1);
    expect(store.state.decks).toHaveLength(1);
  });

  test('a save that does not commit is reported for a deck without images too', async () => {
    const store = fakeStore();
    store.flushResult = { ok: false, reason: 'write' };
    const out = await addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => starterApkg() });
    expect(out).toMatchObject({ kind: 'add', saved: { ok: false, reason: 'write' }, images: 'none' });
    expect(store.events).toEqual(['applyImport', 'flush']);
  });

  test('an error of the image writer is reported, not thrown: the cards are saved', async () => {
    const store = fakeStore();
    const error = new Error('no space left');
    store.writeError = error;
    const out = await addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => imageApkg() });
    expect(out).toMatchObject({ kind: 'add', saved: { ok: true }, images: 'failed' });
    expect(out.imagesError).toBe(error);
    expect(store.state.decks).toHaveLength(1);
    expect(store.state.cards).toHaveLength(12);
  });

  describe('writeStarterImages — the images alone, after "skipped" or "failed" (W3-8 hardening)', () => {
    test('after a save that failed, a later retry writes the images once a save commits, and applies nothing', async () => {
      const store = fakeStore();
      const deps = { ...store, loadBytes: async () => imageApkg() };
      store.flushResult = { ok: false, reason: 'write' };
      const added = await addStarterDeck(PACK, 'words', deps);
      expect(added.images).toBe('skipped');
      // The row says "Added ✓" now: the deck is there.
      expect(starterDeckRows(PACK, store.state.decks)[0].deckId).toBe(added.deckId);

      // Still failing: skipped again, nothing written.
      const stillFailing = await writeStarterImages(PACK, 'words', deps);
      expect(stillFailing).toMatchObject({ deckId: added.deckId, saved: { ok: false, reason: 'write' }, images: 'skipped' });
      expect(store.written).toEqual([]);

      // The save works again: the images are written, into the starter deck's folder.
      store.flushResult = { ok: true };
      const retry = await writeStarterImages(PACK, 'words', deps);
      expect(retry).toEqual({ deckId: added.deckId, saved: { ok: true }, images: 'written' });
      expect(store.written.map((w) => w.folders)).toEqual([[{ deckFolder: `media/${added.deckId}`, files: ['haus.png'] }]]);
      expect(store.written[0].bytes).toEqual(new Map([['haus.png', PNG]]));
      // Only the images: nothing was applied by the retries.
      expect(store.applied).toHaveLength(1);
      expect(store.events).toEqual(['applyImport', 'flush', 'flush', 'flush', 'writeMedia']);
    });

    test('a newer bundled file is NOT applied by the image retry (that is the "Update" row)', async () => {
      const store = fakeStore();
      await addStarterDeck(PACK, 'words', { ...store, loadBytes: async () => imageApkg() });
      const more = [...WITH_IMAGE, { guid: 'g-baum', word: 'der Baum', meaning: 'the tree', level: 'A1' }];
      const out = await writeStarterImages(PACK_V2, 'words', { ...store, loadBytes: async () => starterApkg(more, [['haus.png', PNG]]) });
      expect(out.images).toBe('written');
      expect(store.applied).toHaveLength(1);
      expect(store.state.notes).toHaveLength(6);
    });

    test('no starter deck: nothing is read, saved or written; a deck without images: no save', async () => {
      const store = fakeStore();
      const load = jest.fn(async () => imageApkg());
      await expect(writeStarterImages(PACK, 'words', { ...store, loadBytes: load })).resolves.toEqual({
        deckId: null,
        saved: null,
        images: 'none',
      });
      expect(load).not.toHaveBeenCalled();
      expect(store.flushes).toBe(0);

      const plain = fakeStore();
      const deps = { ...plain, loadBytes: async () => starterApkg() };
      const added = await addStarterDeck(PACK, 'words', deps);
      await expect(writeStarterImages(PACK, 'words', deps)).resolves.toEqual({ deckId: added.deckId, saved: null, images: 'none' });
      expect(plain.flushes).toBe(1); // only the add's save
    });

    test('an error of the image writer is reported, not thrown; an unknown key throws', async () => {
      const store = fakeStore();
      const deps = { ...store, loadBytes: async () => imageApkg() };
      await addStarterDeck(PACK, 'words', deps);
      const error = new Error('no space left');
      store.writeError = error;
      const out = await writeStarterImages(PACK, 'words', deps);
      expect(out).toMatchObject({ saved: { ok: true }, images: 'failed' });
      expect(out.imagesError).toBe(error);
      await expect(writeStarterImages(PACK, 'verbs', deps)).rejects.toThrow('no starter deck');
    });
  });
});
