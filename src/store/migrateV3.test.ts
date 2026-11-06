/**
 * Tests for the migration v2 → v3 (spec §3.5, unit W2-8), on the REAL
 * documents old builds saved (src/store/__fixtures__, see its README). Every
 * fixture first goes through the real v2 stage of the chain (`migrateToV2`,
 * imported here as `migrate`: v0 → v2 or v1 → v2, with the v2 repairs), then
 * through `v2toV3` — the chain that W3-1 wired into `migrate()`.
 *
 * What is pinned:
 *   - card ids and SRS values byte for byte; one note per card;
 *   - v2.0.x cards become legacy vocabulary notes WITH their Level, Type,
 *     Pronunciation and Example translation ("die Stunde" never doubled) —
 *     also on the document a REAL device saved (v0-v2.0.2-device.json);
 *   - an edited front wins over the raw copy, and an example cleared in v2
 *     stays cleared; the auto-joined notes are dropped, the learner's own
 *     notes kept;
 *   - the chain order (the v2 repairs BEFORE v2toV3) lists every text repair;
 *   - collections → pinned lists, review log seq/bucket, the new tally and
 *     settings keys, the in-flight marker kept;
 *   - the result passes the integrity check with nothing to repair, is valid
 *     JSON, and does not depend on anything but its input.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { BUILTIN_TYPE_IDS, builtinType } from '../domain/builtinTypes';
import { DEFAULT_DECK_OPTIONS } from '../domain/makeV3';
import type * as v3 from '../domain/model';
import { DataStateV2 as DataState } from '../domain/types';
import { FIXED_NOW } from '../test/clock';
import {
  makeCard,
  makeDeck,
  makeReviewLogEntry,
  makeState,
  randomState,
  STATE_FIXTURES,
  stateFixture,
  StateFixtureName,
} from '../test/factories';
import { createRandom } from '../test/random';
import { checkIntegrity } from './checkIntegrity';
import { migrateToV2 as migrate } from './migrate';
import { fieldText, legacyLangOf, v2toV3 } from './migrateV3';

type Obj = Record<string, unknown>;

const NOW = FIXED_NOW;

/** A fixture after today's migrate(): a schema-2 document (the input of v2toV3). */
function v2Of(name: StateFixtureName): DataState {
  const out = migrate(stateFixture(name), NOW);
  if (out.kind !== 'ok') throw new Error(`${name}: expected ok, got ${out.kind}`);
  return out.state;
}

/** A fixture through the whole chain: v0/v1 → v2 → v3. */
const v3Of = (name: StateFixtureName) => v2toV3(v2Of(name), NOW);

/** The value of the field called `name` in `note`, read through its card type in `state`. */
function field(state: v3.DataStateV3, note: v3.Note, name: string): string {
  const type = state.noteTypes.find((t) => t.id === note.typeId);
  if (!type) throw new Error(`no card type ${note.typeId}`);
  const index = type.fields.findIndex((f) => f.name === name);
  if (index < 0) throw new Error(`card type ${type.id} has no field ${name}`);
  return note.fields[index];
}

/** The note of a card. */
function noteOf(state: v3.DataStateV3, card: v3.Card): v3.Note {
  const note = state.notes.find((n) => n.id === card.noteId);
  if (!note) throw new Error(`no note for card ${card.id}`);
  return note;
}

/** A deep copy that throws on any change: proves v2toV3 never writes into its input. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The SRS, flag and history keys a migration must copy byte for byte (spec §3.5). */
const KEPT_CARD_KEYS = [
  'id',
  'deckId',
  'fav',
  'flagged',
  'suspended',
  'buriedUntil',
  'ease',
  'intervalDays',
  'stepIndex',
  'reps',
  'lapses',
  'due',
  'createdAt',
  'lastReviewedAt',
  'legacy',
] as const;

/** The settings schema 3 adds, with their defaults (spec §3.5). */
const NEW_SETTINGS = {
  reminderSkipStudied: true,
  spaceSiblings: true,
  knownChecksPerDay: 5,
  autoBackup: true,
  lastAutoBackupAt: null,
  backupImages: true,
  reminderOfferSeen: false,
};

/**
 * Everything that makes `s` NOT a valid v3 document, as readable lines (an
 * empty list = valid). It checks what the v3 code relies on: the links
 * (card → note → card type, card → deck), one card per note and direction,
 * one deck per note, field counts, no v2 text keys left on cards, and the
 * new keys of the person, settings, review log and state.
 */
function v3Problems(s: v3.DataStateV3): string[] {
  const out: string[] = [];
  if (s.schemaVersion !== 3 || s.minReaderVersion !== 3) out.push('version fields are not 3 / 3');
  const types = new Map(s.noteTypes.map((t) => [t.id, t]));
  const notes = new Map(s.notes.map((n) => [n.id, n]));
  const deckIds = new Set(s.decks.map((d) => d.id));
  if (types.size !== s.noteTypes.length) out.push('two card types share an id');
  if (notes.size !== s.notes.length) out.push('two notes share an id');
  if (deckIds.size !== s.decks.length) out.push('two decks share an id');

  for (const n of s.notes) {
    const type = types.get(n.typeId);
    if (!type) out.push(`note ${n.id}: no card type ${n.typeId}`);
    else if (n.fields.length !== type.fields.length) out.push(`note ${n.id}: ${n.fields.length} values for ${type.fields.length} fields`);
    if (!n.fields.every((f) => typeof f === 'string')) out.push(`note ${n.id}: a value is not a text`);
    if (!(Array.isArray(n.tags) && n.tags.every((t) => typeof t === 'string'))) out.push(`note ${n.id}: bad tags`);
    if (typeof n.section !== 'string' || typeof n.guid !== 'string' || !Number.isFinite(n.order)) out.push(`note ${n.id}: bad shape`);
  }

  const cardIds = new Set<string>();
  const slots = new Set<string>();
  const deckOfNote = new Map<string, string>();
  for (const c of s.cards) {
    if (cardIds.has(c.id)) out.push(`card ${c.id}: id used twice`);
    cardIds.add(c.id);
    if (!notes.has(c.noteId)) out.push(`card ${c.id}: no note ${c.noteId}`);
    if (!deckIds.has(c.deckId)) out.push(`card ${c.id}: no deck ${c.deckId}`);
    const slot = `${c.noteId}/${c.ord}`;
    if (slots.has(slot)) out.push(`card ${c.id}: a second card for ${slot}`);
    slots.add(slot);
    const home = deckOfNote.get(c.noteId);
    if (home !== undefined && home !== c.deckId) out.push(`card ${c.id}: its note is split over two decks`);
    deckOfNote.set(c.noteId, c.deckId);
    for (const key of ['front', 'back', 'example', 'notes', 'tags']) {
      if (key in c) out.push(`card ${c.id}: still has the v2 key ${key}`);
    }
    for (const key of ['ord', 'newPos', 'ease', 'intervalDays', 'reps', 'lapses', 'due', 'createdAt'] as const) {
      if (!Number.isFinite(c[key])) out.push(`card ${c.id}: ${key} is not a finite number`);
    }
  }

  for (const d of s.decks) {
    if (!Number.isFinite(d.order) || typeof d.source !== 'string' || typeof d.options !== 'object') {
      out.push(`deck ${d.id}: no order, source or options`);
    }
  }
  s.reviewLog.forEach((e, i) => {
    if (e.seq !== i + 1) out.push(`reviewLog[${i}]: seq ${e.seq}`);
    if (!['new', 'review', 'check'].includes(e.bucket)) out.push(`reviewLog[${i}]: bucket ${e.bucket}`);
    if (typeof e.deckId !== 'string') out.push(`reviewLog[${i}]: no deckId`);
    if (e.prev.knownAt !== null || e.prev.knownCheckedAt !== null) out.push(`reviewLog[${i}]: prev without known keys`);
    if ('wasNew' in e) out.push(`reviewLog[${i}]: still has wasNew`);
  });
  const dd = s.person.dayDone;
  if (dd.checks !== 0 || typeof dd.newByDeck !== 'object') out.push('dayDone has no checks / newByDeck');
  for (const [key, def] of Object.entries(NEW_SETTINGS)) {
    const v = (s.settings as unknown as Obj)[key];
    if (def === null ? !(v === null || typeof v === 'number') : typeof v !== typeof def) out.push(`settings.${key} is ${String(v)}`);
  }
  if (!Array.isArray(s.lists) || !Array.isArray(s.manualLog) || s.pack !== null) out.push('lists / manualLog / pack missing');
  if (typeof s.listPrefs !== 'object' || s.listPrefs === null) out.push('listPrefs missing');
  return out;
}

/* ------------------------------------------------------ every fixture */

describe('v2toV3 — every fixture, through the real chain', () => {
  it.each(STATE_FIXTURES)('%s: a valid v3 document that needs no integrity repair', (name) => {
    const state = v3Of(name);
    expect(v3Problems(state)).toEqual([]);
    const checked = checkIntegrity(state, NOW);
    expect(checked.repaired).toEqual([]);
    expect(checked.state).toBe(state);
  });

  it.each(STATE_FIXTURES)('%s: card ids, order and SRS values byte for byte', (name) => {
    const before = v2Of(name).cards as unknown as Obj[];
    const after = v3Of(name).cards as unknown as Obj[];
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    after.forEach((card, i) => {
      for (const key of KEPT_CARD_KEYS) expect(card[key]).toStrictEqual(before[i][key]);
      expect(card.ord).toBe(0);
      expect(card.newPos).toBe(before[i].createdAt);
      expect(card.noteId).toBe(`n-${before[i].id}`);
    });
  });

  it.each(STATE_FIXTURES)('%s: one note per card, with its tags, as a migrated item', (name) => {
    const before = v2Of(name).cards;
    const state = v3Of(name);
    expect(state.notes).toHaveLength(before.length);
    state.notes.forEach((note, i) => {
      const card = before[i];
      expect(note).toMatchObject({
        id: `n-${card.id}`,
        guid: `m-${card.id}`,
        section: '',
        order: card.createdAt,
        source: { kind: 'migrated' },
        createdAt: card.createdAt,
        updatedAt: card.createdAt,
      });
      expect(note.tags).toEqual(card.tags ?? []);
      if (card.legacy) expect(note.typeId).toMatch(/^nt-legacy/);
      else expect(note.typeId).toBe(BUILTIN_TYPE_IDS.basic);
    });
  });

  it.each(STATE_FIXTURES)('%s: decks keep their values and get order, source, card type and options', (name) => {
    const before = v2Of(name).decks;
    const { decks } = v3Of(name);
    expect(decks.map((d) => d.id)).toEqual(before.map((d) => d.id));
    // Order by createdAt (ties keep the list order): 0, 1, 2 …
    const byTime = before
      .map((d, i) => ({ id: d.id, t: d.createdAt, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map((d) => d.id);
    expect([...decks].sort((a, b) => a.order - b.order).map((d) => d.id)).toEqual(byTime);
    decks.forEach((deck, i) => {
      const old = before[i];
      expect(deck).toMatchObject({
        name: old.name,
        icon: old.icon,
        active: old.active,
        createdAt: old.createdAt,
        builtin: old.builtin,
        source: 'migrated',
        defaultTypeId: 'nt-basic',
      });
      expect(deck.options).toStrictEqual({ ...DEFAULT_DECK_OPTIONS });
      expect(deck.legacy).toStrictEqual(old.legacy);
    });
  });

  it.each(STATE_FIXTURES)('%s: collections become pinned lists and stay in state', (name) => {
    const v2 = v2Of(name);
    const state = v3Of(name);
    // Every fixture has the seed's three collections.
    expect(state.listPrefs).toStrictEqual({
      'builtin:hard': { pinned: true, hidden: false, order: 0 },
      'builtin:favorites': { pinned: true, hidden: false, order: 1 },
      'builtin:recent': { pinned: true, hidden: false, order: 2 },
    });
    expect(state.collections).toStrictEqual(v2.collections);
    expect(state.lists).toEqual([]);
  });

  it.each(STATE_FIXTURES)('%s: review log gets seq, bucket and the deck of its card', (name) => {
    const v2 = v2Of(name);
    const state = v3Of(name);
    const deckOf = new Map(v2.cards.map((c) => [c.id, c.deckId]));
    expect(state.reviewLog).toHaveLength(v2.reviewLog.length);
    state.reviewLog.forEach((entry, i) => {
      const old = v2.reviewLog[i];
      expect(entry).toStrictEqual({
        id: old.id,
        seq: i + 1,
        cardId: old.cardId,
        deckId: deckOf.get(old.cardId) ?? '',
        rating: old.rating,
        atMs: old.atMs,
        bucket: old.wasNew ? 'new' : 'review',
        prev: { ...old.prev, knownAt: null, knownCheckedAt: null },
      });
    });
  });

  it.each(STATE_FIXTURES)('%s: dayDone gains checks + newByDeck; person, sessions, marker kept', (name) => {
    const v2 = v2Of(name);
    const state = v2toV3(v2, NOW);
    expect(state.person).toStrictEqual({
      ...v2.person,
      dayDone: { ...v2.person.dayDone, checks: 0, newByDeck: {} },
    });
    expect(state.sessions).toBe(v2.sessions);
    expect(state.inProgressSession).toBe(v2.inProgressSession);
    expect(state.onboarded).toBe(v2.onboarded);
    expect(state.manualLog).toEqual([]);
    expect(state.pack).toBeNull();
  });

  it.each(STATE_FIXTURES)('%s: settings keep every v2 key and get the seven new ones', (name) => {
    const v2 = v2Of(name);
    expect(v3Of(name).settings).toStrictEqual({ ...v2.settings, ...NEW_SETTINGS });
  });

  it.each(STATE_FIXTURES)('%s: JSON round trip, same result twice, input never changed', (name) => {
    const input = deepFreeze(v2Of(name));
    const first = v2toV3(input, NOW);
    expect(JSON.parse(JSON.stringify(first))).toStrictEqual(first);
    expect(v2toV3(input, NOW)).toStrictEqual(first);
  });
});

/* ---------------------------------------------------- v2.0.2 (legacy) */

describe('v2toV3 — v2.0.2 cards become legacy vocabulary notes', () => {
  const v2 = v2Of('v0-v2.0.2');
  const state = v2toV3(v2, NOW);
  const byFront = (front: string) => {
    const card = state.cards.find((c) => c.legacy?.word === front);
    if (!card) throw new Error(`no card ${front}`);
    return { card, note: noteOf(state, card) };
  };

  it('German cards use the German type, Spanish cards the Spanish type, and only those types exist', () => {
    expect(state.noteTypes).toStrictEqual([builtinType('legacyVocabDe', NOW), builtinType('legacyVocabEs', NOW)]);
    for (const card of state.cards) {
      const lang = card.legacy?.lang;
      expect(noteOf(state, card).typeId).toBe(lang === 'de' ? 'nt-legacy-de' : 'nt-legacy-es');
    }
  });

  it('"die Stunde": every old value has its own field, and the article is not added again', () => {
    const { note } = byFront('die Stunde');
    expect(note.fields).toEqual([
      'die Stunde', // Word
      'the hour', // Translation
      'Wir treffen uns in einer Stunde.', // Example
      'We meet in an hour.', // Example translation
      '/ˈʃtʊndə/', // Pronunciation
      'A1', // Level
      'noun', // Type
      'die', // Article
      'Stunde', // Base
      '', // Notes: only the auto-joined IPA + translation, so dropped
    ]);
  });

  it('no Word field is ever doubled ("die die Stunde"); Word = the v2 front', () => {
    for (const card of state.cards) {
      const word = field(state, noteOf(state, card), 'Word');
      expect(word).toBe(v2.cards.find((c) => c.id === card.id)!.front);
      expect(word).not.toMatch(/^(der|die|das|el|la|los|las) (der|die|das|el|la|los|las) /);
    }
  });

  it('v2.0.2 users get Level and Type back on EVERY card (the filters of spec §0)', () => {
    for (const card of state.cards) {
      const note = noteOf(state, card);
      expect(field(state, note, 'Level')).toBe(card.legacy?.level ?? '');
      expect(field(state, note, 'Type')).toBe(card.legacy?.type ?? '');
      expect(field(state, note, 'Pronunciation')).toBe(card.legacy?.ipa ?? '');
      expect(field(state, note, 'Example translation')).toBe(card.legacy?.exTr ?? '');
    }
    expect(state.cards.every((c) => field(state, noteOf(state, c), 'Level') !== '')).toBe(true);
  });

  it('the Spanish CSV cards keep their level, type, IPA and tags', () => {
    const { note } = byFront('la cuchara');
    expect(field(state, note, 'Level')).toBe('A1');
    expect(field(state, note, 'Type')).toBe('noun');
    expect(field(state, note, 'Pronunciation')).toBe('/kuˈt͡ʃaɾa/');
    expect(field(state, note, 'Example translation')).toBe('');
    expect(note.tags).toEqual(['cocina']);
    // "picante" has no IPA at all: the field is empty, the card is still there.
    expect(field(state, byFront('picante').note, 'Pronunciation')).toBe('');
  });

  it('decks: German → de-DE with article colours, Spanish → es-ES; answers in English', () => {
    const deck = (id: string) => state.decks.find((d) => d.id === id)!;
    expect(deck('de-everyday')).toMatchObject({ language: 'de-DE', meaningLanguage: 'en-US', genderColors: true });
    expect(deck('de-conversation')).toMatchObject({ language: 'de-DE', meaningLanguage: 'en-US', genderColors: true });
    const spanish = deck('d-mr8wjryg-5');
    expect(spanish).toMatchObject({ language: 'es-ES', meaningLanguage: 'en-US' });
    expect('genderColors' in spanish).toBe(false);
  });

  it('an edited front wins over legacy.word, and the raw copy stays unchanged', () => {
    const edited = {
      ...v2,
      cards: v2.cards.map((c) => (c.legacy?.word === 'die Stunde' ? { ...c, front: 'die Stunde (time)' } : c)),
    };
    const out = v2toV3(edited, NOW);
    const card = out.cards.find((c) => c.legacy?.word === 'die Stunde')!;
    expect(field(out, noteOf(out, card), 'Word')).toBe('die Stunde (time)');
    expect(card.legacy?.word).toBe('die Stunde');
  });

  it('an example the learner cleared in v2 stays cleared; the raw copy still has it', () => {
    // The v2 card editor saves `example: undefined`; after a save and reload
    // (JSON) the key is gone. Both forms must give an empty Example.
    const cleared = (clear: (c: DataState['cards'][number]) => DataState['cards'][number]) => {
      const doc = { ...v2, cards: v2.cards.map((c) => (c.legacy?.word === 'die Stunde' ? clear(c) : c)) };
      const out = v2toV3(doc, NOW);
      const card = out.cards.find((c) => c.legacy?.word === 'die Stunde')!;
      return { example: field(out, noteOf(out, card), 'Example'), raw: card.legacy?.ex };
    };
    const asSaved = cleared((c) => ({ ...c, example: undefined }));
    const asReloaded = cleared((c) => {
      const copy = { ...c };
      delete copy.example;
      return copy;
    });
    for (const out of [asSaved, asReloaded]) {
      expect(out.example).toBe('');
      expect(out.raw).toBe('Wir treffen uns in einer Stunde.');
    }
    // An example the learner kept (or edited) is the one in the note.
    expect(cleared((c) => ({ ...c, example: 'Eine Stunde später.' })).example).toBe('Eine Stunde später.');
  });

  it('the auto-joined notes are dropped, the learner’s own notes are kept', () => {
    const withNotes = (notes: string | undefined) => {
      const doc = {
        ...v2,
        cards: v2.cards.map((c) => (c.legacy?.word === 'die Stunde' ? { ...c, notes } : c)),
      };
      const out = v2toV3(doc, NOW);
      const card = out.cards.find((c) => c.legacy?.word === 'die Stunde')!;
      return field(out, noteOf(out, card), 'Notes');
    };
    expect(withNotes('/ˈʃtʊndə/\nWe meet in an hour.')).toBe(''); // exactly what v0toV2 built
    expect(withNotes(undefined)).toBe('');
    expect(withNotes('feminine, plural -n')).toBe('feminine, plural -n');
    // Edited: the old lines + a line of the learner's own → kept whole (line breaks as <br>).
    expect(withNotes('/ˈʃtʊndə/\nWe meet in an hour.\nmy tip')).toBe('/ˈʃtʊndə/<br>We meet in an hour.<br>my tip');
  });
});

describe('v2toV3 — the German fork', () => {
  const state = v3Of('v0-german-fork');

  it('every card is a German legacy note; the Anki level is a field; a missing type is empty', () => {
    expect(state.noteTypes.map((t) => t.id)).toEqual(['nt-legacy-de']);
    const sagen = state.cards.find((c) => c.legacy?.word === 'sagen')!;
    const note = noteOf(state, sagen);
    expect(field(state, note, 'Level')).toBe('A1');
    expect(field(state, note, 'Type')).toBe(''); // the fork stored type: null
    expect(field(state, note, 'Article')).toBe(''); // article: null
    expect(field(state, note, 'Base')).toBe('sagen');
  });

  it('keeps the killed session’s marker WITH its studyDay', () => {
    expect(state.inProgressSession?.studyDay).toBe('2026-07-15');
  });

  it('all three decks are German decks', () => {
    expect(state.decks.every((d) => d.language === 'de-DE' && d.genderColors === true)).toBe(true);
  });
});

/* ------------------------------------------------- the real device */

/**
 * The REAL-DEVICE fixture: the exact `maranki.state.v1` value that the public
 * v2.0.2 release build saved on an Android emulator (68 German cards in 2
 * decks, a killed session's marker; see __fixtures__/README.md). It is not in
 * STATE_FIXTURES (src/test/factories.ts), so it is read here directly, then
 * goes through the same chain: migrate() → v2toV3.
 */
function deviceV2(): DataState {
  const raw = fs.readFileSync(path.join(__dirname, '__fixtures__', 'v0-v2.0.2-device.json'), 'utf8');
  const out = migrate(JSON.parse(raw), NOW);
  if (out.kind !== 'ok') throw new Error(`device fixture: expected ok, got ${out.kind}`);
  return out.state;
}

describe('v2toV3 — the real-device v2.0.2 document', () => {
  const v2 = deviceV2();
  const state = v2toV3(v2, NOW);
  const byWord = (word: string) => {
    const card = state.cards.find((c) => c.legacy?.word === word);
    if (!card) throw new Error(`no card ${word}`);
    return { card, note: noteOf(state, card) };
  };

  it('is a valid v3 document that needs no integrity repair', () => {
    expect(v3Problems(state)).toEqual([]);
    const checked = checkIntegrity(state, NOW);
    expect(checked.repaired).toEqual([]);
    expect(checked.state).toBe(state);
  });

  it('keeps every card id and every SRS value byte for byte; one German note per card', () => {
    const before = v2.cards as unknown as Obj[];
    const after = state.cards as unknown as Obj[];
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    after.forEach((card, i) => {
      for (const key of KEPT_CARD_KEYS) expect(card[key]).toStrictEqual(before[i][key]);
      expect(card.ord).toBe(0);
    });
    expect(state.notes).toHaveLength(68);
    expect(state.noteTypes.map((t) => t.id)).toEqual(['nt-legacy-de']);
  });

  it('Level and Type land in note fields on EVERY card (and IPA, example translation, article, base)', () => {
    for (const card of state.cards) {
      const note = noteOf(state, card);
      const legacy = card.legacy!;
      expect(field(state, note, 'Level')).toBe(legacy.level);
      expect(field(state, note, 'Type')).toBe(legacy.type);
      expect(field(state, note, 'Pronunciation')).toBe(legacy.ipa);
      expect(field(state, note, 'Example translation')).toBe(legacy.exTr);
      expect(field(state, note, 'Article')).toBe(legacy.article ?? '');
      expect(field(state, note, 'Base')).toBe(legacy.base);
      expect(field(state, note, 'Word')).toBe(legacy.word); // never edited on this device
    }
    // Every card has a Level and a Type: the filters v2.0.2 users lost come back.
    const levels = new Set(state.cards.map((c) => field(state, noteOf(state, c), 'Level')));
    expect([...levels].sort()).toEqual(['A1', 'A2', 'B1', 'B2', 'C1']);
    expect(byWord('die Stunde').note.fields).toEqual([
      'die Stunde', 'the hour', 'Wir treffen uns in einer Stunde.', 'We meet in an hour.',
      '/ˈʃtʊndə/', 'A1', 'noun', 'die', 'Stunde', '',
    ]);
    expect(field(state, byWord('aufräumen').note, 'Type')).toBe('verb');
  });

  it('the favorite and the flag survive; the marker is kept as it is; both decks are German', () => {
    expect(byWord('die Stunde').card.fav).toBe(true);
    expect(byWord('aufräumen').card.flagged).toBe(true);
    expect(state.cards.filter((c) => c.fav || c.flagged)).toHaveLength(2);
    expect(state.inProgressSession).toBe(v2.inProgressSession);
    expect(state.inProgressSession).toMatchObject({ counts: { good: 2 }, total: 2 });
    expect(state.decks.map((d) => [d.id, d.language, d.genderColors])).toEqual([
      ['de-everyday', 'de-DE', true],
      ['de-conversation', 'de-DE', true],
    ]);
  });
});

describe('v2toV3 — main (v1) and the empty library', () => {
  it('v1 cards become Basic notes: Front, Back, Example, Notes', () => {
    const v2 = v2Of('v1-main-1333d48');
    const state = v2toV3(v2, NOW);
    expect(state.noteTypes).toStrictEqual([builtinType('basic', NOW)]);
    state.cards.forEach((card, i) => {
      const old = v2.cards[i];
      expect(noteOf(state, card).fields).toEqual([old.front, old.back, old.example ?? '', old.notes ?? ''].map(fieldText));
    });
    const canada = state.notes.find((n) => n.fields[0] === 'Canada')!;
    expect(canada.fields).toEqual(['Canada', 'Ottawa', '', 'Not Toronto!']);
    // No language on decks made in the app (they had no v0 language).
    expect(state.decks.every((d) => !('language' in d) && !('genderColors' in d))).toBe(true);
    expect(state.settings.sessionLimit).toBe(30);
  });

  it('text the old importer left as an entity ("&sum;") stays exactly as it was', () => {
    const v2 = v2Of('v1-main-1333d48');
    const state = v2toV3(v2, NOW);
    const catalan = v2.cards.find((c) => c.back.includes('&sum;'))!;
    expect(noteOf(state, state.cards.find((c) => c.id === catalan.id)!).fields[1]).toBe(catalan.back);
  });

  it('an empty library: no notes, no card types; review entries of deleted cards get deckId ""', () => {
    const state = v3Of('v0-empty-library');
    expect(state.notes).toEqual([]);
    expect(state.cards).toEqual([]);
    expect(state.noteTypes).toEqual([]);
    expect(state.reviewLog).toHaveLength(2);
    expect(state.reviewLog.every((e) => e.deckId === '')).toBe(true);
  });
});

/* --------------------------------------------------- the order of the chain */

describe('v2toV3 — the order of the chain (see the migrateV3.ts file comment)', () => {
  it('v1-nan-fields: migrate() → v2toV3 → checkIntegrity lists every text repair, and the v3 cards are clean', () => {
    // The order W3-1 must use: the v2 sanitize + mergeDefaults (inside today's
    // migrate()) BEFORE v2toV3, then checkIntegrity.
    const out = migrate(stateFixture('v1-nan-fields'), NOW);
    if (out.kind !== 'ok') throw new Error(`expected ok, got ${out.kind}`);
    const checked = checkIntegrity(v2toV3(out.state, NOW), NOW);
    const repaired = [...out.repaired, ...checked.repaired];

    const idOf = (front: string) =>
      (stateFixture('v1-main-1333d48').cards as Obj[]).find((c) => c.front === front)!.id as string;
    // The text repairs are listed. If v2toV3 ran first, they would be silent:
    // the note would just hold '42' and ''.
    expect(repaired).toEqual(
      expect.arrayContaining([
        `card "${idOf('CO2')}": front 42 → "42"`,
        `card "${idOf('CO2')}": back null → ""`,
        `card "${idOf('Fe')}": back missing → ""`,
        `card "${idOf('France')}": ease null → 2.5`,
      ]),
    );
    // checkIntegrity finds nothing more: the v2 repairs already made every link right.
    expect(checked.repaired).toEqual([]);
    // No bad number reaches a v3 card (ease null, due null …).
    expect(v3Problems(checked.state)).toEqual([]);
    const co2 = checked.state.cards.find((c) => c.id === idOf('CO2'))!;
    expect(noteOf(checked.state, co2).fields.slice(0, 2)).toEqual(['42', '']);
  });
});

/* -------------------------------------------------------- small documents */

describe('v2toV3 — small documents', () => {
  const v0Card = (id: string, lang: string, extra: Obj = {}) =>
    makeCard({
      id,
      deckId: 'd1',
      front: `word ${id}`,
      back: `meaning ${id}`,
      legacy: { word: `word ${id}`, article: null, base: id, tr: `meaning ${id}`, level: 'B2', type: 'verb', lang },
      ...extra,
    });

  it('French → the French type; any other language → the plain legacy type', () => {
    const state = v2toV3(
      makeState({ decks: [makeDeck({ id: 'd1' })], cards: [v0Card('a', 'fr'), v0Card('b', 'it'), v0Card('c', 'de-AT')] }),
      NOW,
    );
    expect(state.notes.map((n) => n.typeId)).toEqual(['nt-legacy-fr', 'nt-legacy', 'nt-legacy-de']);
    expect(state.noteTypes.map((t) => t.id)).toEqual(['nt-legacy-de', 'nt-legacy-fr', 'nt-legacy']);
  });

  it('deck languages: French → fr-FR without article colours; Italian → no language', () => {
    const decks = [
      makeDeck({ id: 'fr', legacy: { flag: '🇫🇷', lang: 'French', level: null } }),
      makeDeck({ id: 'it', legacy: { flag: '🇮🇹', lang: 'Italian', level: null } }),
      makeDeck({ id: 'es', legacy: { lang: 'Español' } }),
    ];
    const state = v2toV3(makeState({ decks }), NOW);
    expect(state.decks[0]).toMatchObject({ language: 'fr-FR', meaningLanguage: 'en-US' });
    expect('genderColors' in state.decks[0]).toBe(false);
    expect('language' in state.decks[1] || 'meaningLanguage' in state.decks[1]).toBe(false);
    expect(state.decks[2].language).toBe('es-ES');
  });

  it('plain text that HTML would misread is made safe; everything else stays as it is', () => {
    const card = makeCard({ id: 'c1', deckId: 'd1', front: 'List<String>', back: 'R&D > sales', notes: 'line 1\nline 2\r\nline 3' });
    const state = v2toV3(makeState({ decks: [makeDeck({ id: 'd1' })], cards: [card] }), NOW);
    expect(state.notes[0].fields).toEqual(['List&lt;String&gt;', 'R&D &gt; sales', '', 'line 1<br>line 2<br>line 3']);
  });

  it('two v2 cards with ONE id: the second gets a new id, and both cards and texts survive', () => {
    const deck = makeDeck({ id: 'd1' });
    const cards = [makeCard({ id: 'x', deckId: 'd1', front: 'first' }), makeCard({ id: 'x', deckId: 'd1', front: 'second' })];
    const state = v2toV3(makeState({ decks: [deck], cards }), NOW);
    expect(state.cards.map((c) => c.id)).toEqual(['x', 'x~2']);
    expect(state.notes.map((n) => [n.id, n.fields[0]])).toEqual([
      ['n-x', 'first'],
      ['n-x~2', 'second'],
    ]);
    expect(checkIntegrity(state, NOW).repaired).toEqual([]);
  });

  it('the new id of a second card never takes the id of a later card', () => {
    const deck = makeDeck({ id: 'd1' });
    const cards = [
      makeCard({ id: 'x', deckId: 'd1', front: 'first' }),
      makeCard({ id: 'x', deckId: 'd1', front: 'second' }),
      makeCard({ id: 'x~2', deckId: 'd1', front: 'third' }),
    ];
    const state = v2toV3(makeState({ decks: [deck], cards }), NOW);
    // 'x~2' keeps its own id (its undo entries and marker still point at it).
    expect(state.cards.map((c) => c.id)).toEqual(['x', 'x~3', 'x~2']);
    expect(state.notes.map((n) => n.fields[0])).toEqual(['first', 'second', 'third']);
    expect(v3Problems(state)).toEqual([]);
  });

  it('a legacy card with no example and an `ex` of only spaces gets an empty Example', () => {
    const card = v0Card('a', 'de', { legacy: { ...v0Card('a', 'de').legacy!, ex: '   ' } });
    const state = v2toV3(makeState({ decks: [makeDeck({ id: 'd1' })], cards: [card] }), NOW);
    expect(field(state, state.notes[0], 'Example')).toBe('');
    expect(state.cards[0].legacy?.ex).toBe('   ');
  });

  it('decks with the same createdAt keep their list order', () => {
    const decks = [makeDeck({ id: 'b', createdAt: 5 }), makeDeck({ id: 'a', createdAt: 5 }), makeDeck({ id: 'c', createdAt: 1 })];
    expect(v2toV3(makeState({ decks }), NOW).decks.map((d) => [d.id, d.order])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 0],
    ]);
  });

  it('collections: by query (incl. flagged), by seed id when the query is unknown, a second one ignored', () => {
    const collections = [
      { id: 'mine', name: 'Flagged', icon: 'flag', desc: '', query: 'flagged' },
      { id: 'fav', name: 'Favorites', icon: 'heart', desc: '', query: 'favorites' },
      { id: 'daily', name: 'Old', icon: 'today', desc: '', query: 'unknown' },
      { id: 'fav2', name: 'Again', icon: 'heart', desc: '', query: 'favorites' },
    ];
    const state = v2toV3(makeState({ collections } as never), NOW);
    expect(state.listPrefs).toStrictEqual({
      'builtin:flagged': { pinned: true, hidden: false, order: 0 },
      'builtin:favorites': { pinned: true, hidden: false, order: 1 },
      'builtin:recent': { pinned: true, hidden: false, order: 2 },
    });
    expect(state.collections).toStrictEqual(collections);
  });

  it('a new setting a wave-2 build already stored keeps its value; a wrong one gets the default', () => {
    const base = makeState();
    const settings = { ...base.settings, lastAutoBackupAt: 1234, autoBackup: false, knownChecksPerDay: -1 };
    const out = v2toV3(makeState({ settings }), NOW).settings;
    expect(out.lastAutoBackupAt).toBe(1234);
    expect(out.autoBackup).toBe(false);
    expect(out.knownChecksPerDay).toBe(5);
  });

  it('a review entry of a new card is bucket "new"; of a deleted card has deckId ""', () => {
    const deck = makeDeck({ id: 'd1' });
    const card = makeCard({ id: 'c1', deckId: 'd1', reps: 1 });
    const gone = makeCard({ id: 'gone', deckId: 'd1' });
    const reviewLog = [makeReviewLogEntry(card, 'good', { wasNew: true }), makeReviewLogEntry(gone, 'again', { wasNew: false })];
    const state = v2toV3(makeState({ decks: [deck], cards: [card], reviewLog }), NOW);
    expect(state.reviewLog.map((e) => [e.seq, e.bucket, e.deckId])).toEqual([
      [1, 'new', 'd1'],
      [2, 'review', ''],
    ]);
  });

  it('50 seeded random documents: valid v3, nothing for the integrity check, ids kept', () => {
    const rnd = createRandom('migrate-v3');
    for (let i = 0; i < 50; i++) {
      const v2 = randomState(rnd.fork(`state-${i}`)) as DataState;
      const state = v2toV3(v2, NOW);
      expect(v3Problems(state)).toEqual([]);
      expect(checkIntegrity(state, NOW).repaired).toEqual([]);
      expect(state.cards.map((c) => c.id)).toEqual(v2.cards.map((c) => c.id));
      // Every text of the v2 card is in its note (fields 0–3 of Basic).
      state.notes.forEach((note, k) => {
        const old = v2.cards[k];
        expect(note.fields).toEqual([old.front, old.back, old.example ?? '', old.notes ?? ''].map(fieldText));
      });
    }
  });
});

/* -------------------------------------------------------------- helpers */

describe('fieldText', () => {
  it.each([
    ['die Stunde', 'die Stunde'],
    ['Über Straße — ¿qué?', 'Über Straße — ¿qué?'],
    ['a < b', 'a &lt; b'],
    ['<b>bold</b>', '&lt;b&gt;bold&lt;/b&gt;'],
    ['Fish & Chips', 'Fish & Chips'],
    ['dp[n] = &sum; dp[i]', 'dp[n] = &sum; dp[i]'],
    ['one\ntwo\r\nthree\rfour', 'one<br>two<br>three<br>four'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(fieldText(input)).toBe(expected);
  });

  it('a value that is not a text becomes String(value ?? "")', () => {
    expect(fieldText(42)).toBe('42');
    expect(fieldText(null)).toBe('');
    expect(fieldText(undefined)).toBe('');
  });
});

describe('legacyLangOf', () => {
  it.each([
    ['de', 'de'],
    ['German', 'de'],
    ['Deutsch', 'de'],
    ['de-DE', 'de'],
    ['de_AT', 'de'],
    ['es', 'es'],
    ['Spanish', 'es'],
    ['Español', 'es'],
    ['fr', 'fr'],
    [' French ', 'fr'],
    ['Français', 'fr'],
  ])('%j → %j', (input, expected) => {
    expect(legacyLangOf(input)).toBe(expected);
  });

  it.each([['it'], ['Italian'], ['des'], [''], [null], [7]])('%j → null', (input) => {
    expect(legacyLangOf(input)).toBeNull();
  });
});
