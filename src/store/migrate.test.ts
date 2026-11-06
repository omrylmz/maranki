/**
 * Tests for the schema migration (spec §3.1–§3.5; units W1-1 and W3-1), on
 * the REAL documents old builds saved (src/store/__fixtures__, see its README).
 *
 * The chain (W3-1): v0toV2 / v1toV2 → sanitizeV2 → mergeDefaultsV2
 * (= `migrateToV2`, the v2 stage) → v2toV3 → checkIntegrity → sanitize →
 * mergeDefaults. What is pinned:
 *   - the v2 stage (`migrateToV2`): v0 (v2.0.2, German fork, empty library,
 *     a REAL device) → schema 2, lossless; v1 (main@1333d48) → only the
 *     version fields and two settings change; damaged v1 documents →
 *     repaired, never dropped, every repair listed;
 *   - the WHOLE chain (`migrate`): every fixture ends in a valid schema-3
 *     document — card ids and SRS values unchanged, v0 Level/Type/IPA lifted
 *     into note fields, the marker banked once — and is a fixed point; search,
 *     every "Study N" count and every Library sort work on the migrated v0 data;
 *   - a damaged v3 document (card types, templates, saved lists, the
 *     manual-edit log) is repaired, so renderFace, the library index, the
 *     filter groups, listsById and the manual-edit commands never throw on
 *     what `migrate()` returns, and an imported type keeps its Level group;
 *   - too-new / invalid documents; a v3 document is too new for a schema-2
 *     build; a newer readable document keeps its version and unknown fields;
 *   - the v3 `sanitize` and `mergeDefaults`, and the order of the repair list.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { BUILTIN_TYPE_IDS, builtinType } from '../domain/builtinTypes';
import { deriveFacets } from '../domain/facets';
import { termHelpers } from '../domain/lang';
import { buildCardLookup, buildLibraryIndex, plainText } from '../domain/libraryIndex';
import { isBuried, life } from '../domain/life';
import { listsById } from '../domain/lists';
import { MANUAL_LOG_MAX_EDITS, pushManualEdit, undoManualEdit } from '../domain/manualLog';
import { compileQuery, type MatchCtx } from '../domain/query';
import { renderFace } from '../domain/render';
import { planQueue, readyCounts, type ScheduleCtx, selectPractice, selectScheduled } from '../domain/schedule';
import { buildSeedState } from '../domain/seed';
import { markKnown, setFlags } from '../domain/triage';
import {
  Card,
  CardV2,
  DataState,
  DataStateV2,
  DAY,
  dayKeyOf,
  DEFAULT_APP_SETTINGS,
  DEFAULT_APP_SETTINGS_V2,
  DEFAULT_SRS,
  DeckV2,
  FieldDef,
  HOUR,
  ManualEdit,
  Note,
  NoteType,
} from '../domain/types';
import { FIXED_NOW, localTime } from '../test/clock';
import {
  makeCard,
  makeDeck,
  makeMarker,
  makeState,
  randomState,
  STATE_FIXTURES,
  stateFixture,
  StateFixtureName,
  stateProblems,
} from '../test/factories';
import { makeStateV3, noteWithCards, randomStateV3, stateProblemsV3, makeDeckV3 } from '../test/factoriesV3';
import { createRandom } from '../test/random';
import { UNFILED_DECK_ID } from './deckOps';
import {
  CURRENT_SCHEMA,
  detectVersion,
  mergeDefaults,
  mergeDefaultsV2,
  migrate,
  migrateToV2,
  MIN_READER,
  sanitize,
  sanitizeV2,
  tooNewFor,
  v0toV2,
  v1toV2,
} from './migrate';
import { fieldText } from './migrateV3';
import { reconcileOnBoot, undoLastReview } from './reducer';
import { emptyDayDone } from './tally';

type Obj = Record<string, unknown>;

/** The v2 stage of a fixture (`migrateToV2`); the test fails with the outcome when it is not 'ok'. */
function migratedV2(name: StateFixtureName, now: number = FIXED_NOW) {
  const out = migrateToV2(stateFixture(name), now);
  if (out.kind !== 'ok') throw new Error(`${name}: expected ok, got ${out.kind}`);
  return out;
}

/** The whole chain on a document; the test fails with the outcome when it is not 'ok'. */
function migratedDoc(doc: unknown, now: number = FIXED_NOW) {
  const out = migrate(doc, now);
  if (out.kind !== 'ok') throw new Error(`expected ok, got ${out.kind}`);
  return out;
}

/** The whole chain on a fixture. */
const migratedV3 = (name: StateFixtureName, now: number = FIXED_NOW) => migratedDoc(stateFixture(name), now);

const rawCards = (name: StateFixtureName) => stateFixture(name).cards as Obj[];
const rawDecks = (name: StateFixtureName) => stateFixture(name).decks as Obj[];

const V0_FIXTURES = ['v0-v2.0.2', 'v0-german-fork', 'v0-empty-library'] as const;
const V1_FIXTURES = ['v1-main-1333d48', 'v1-marker-no-studyDay', 'v1-orphan-card', 'v1-nan-fields'] as const;

/** The SRS and marker fields a migration must copy byte for byte. */
const KEPT_CARD_KEYS = [
  'id',
  'deckId',
  'tags',
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
] as const;

/** The card keys that schema 2 and schema 3 share, copied unchanged by v2toV3 (spec §3.5). */
const SRS_KEYS = [
  'id',
  'deckId',
  'ease',
  'intervalDays',
  'stepIndex',
  'reps',
  'lapses',
  'due',
  'createdAt',
  'lastReviewedAt',
  'buriedUntil',
  'legacy',
] as const;

/** The settings schema 3 added (spec §3.5), with the kind of value each holds. */
const V3_SETTINGS_KEYS = [
  'reminderSkipStudied',
  'spaceSiblings',
  'knownChecksPerDay',
  'autoBackup',
  'lastAutoBackupAt',
  'backupImages',
  'reminderOfferSeen',
] as const;

/**
 * Everything that makes `s` NOT a valid v3 document the app can run on, as
 * readable lines (an empty list = valid): the links and numbers of
 * stateProblemsV3, no v2 text key left on a card, the version fields, every
 * default setting present with the right kind, the v3 day tally and the v3
 * top-level keys.
 */
function v3Problems(s: DataState): string[] {
  const out = stateProblemsV3(s);
  if (s.schemaVersion < 3 || s.minReaderVersion !== 3) out.push(`version fields ${s.schemaVersion} / ${s.minReaderVersion}`);
  for (const c of s.cards) {
    for (const key of ['front', 'back', 'example', 'notes', 'tags']) if (key in c) out.push(`card ${c.id}: v2 key ${key}`);
  }
  for (const [key, def] of Object.entries(DEFAULT_APP_SETTINGS)) {
    const v = (s.settings as unknown as Obj)[key];
    const ok = key === 'lastAutoBackupAt' ? v === null || typeof v === 'number' : typeof v === typeof def;
    if (!ok) out.push(`settings.${key} is ${JSON.stringify(v)}`);
  }
  for (const key of Object.keys(DEFAULT_SRS)) {
    if (!(key in s.settings.srs)) out.push(`settings.srs.${key} is missing`);
  }
  const dd = s.person.dayDone;
  if (!(typeof dd.dayKey === 'string' && Number.isInteger(dd.reviews) && Number.isInteger(dd.neww))) out.push('dayDone v2 part');
  if (!Number.isInteger(dd.checks) || typeof dd.newByDeck !== 'object' || dd.newByDeck === null) out.push('dayDone v3 part');
  for (const key of ['noteTypes', 'notes', 'lists', 'manualLog', 'collections', 'sessions', 'reviewLog'] as const) {
    if (!Array.isArray(s[key])) out.push(`${key} is not a list`);
  }
  if (typeof s.listPrefs !== 'object' || s.listPrefs === null) out.push('listPrefs is not an object');
  if (s.pack !== null && typeof s.pack !== 'object') out.push('pack is not null or an object');
  if (typeof s.onboarded !== 'boolean') out.push('onboarded is not a boolean');
  return out;
}

/** The value of the field called `name` in the note of `card`. */
function fieldOf(state: DataState, card: Card, name: string): string {
  const note = state.notes.find((n) => n.id === card.noteId)!;
  const type = state.noteTypes.find((t) => t.id === note.typeId)!;
  return note.fields[type.fields.findIndex((f) => f.name === name)];
}

/** The note of a card. */
const noteOf = (state: DataState, card: Card): Note => state.notes.find((n) => n.id === card.noteId)!;

/** The scheduler's context for a whole v3 state (what scope.ts builds), with an empty day. */
function scheduleCtx(state: DataState, now: number): ScheduleCtx {
  const typeOf = new Map(state.notes.map((n) => [n.id, n.typeId]));
  return {
    now,
    decks: new Map(state.decks.map((d) => [d.id, d])),
    typeIdOf: (card) => typeOf.get(card.noteId),
    done: emptyDayDone(dayKeyOf(now)),
    settings: state.settings,
    lookup: buildCardLookup(state.cards),
  };
}

/**
 * The A–Z sort key of a card: its note's sort field as plain text, through
 * the language helper of that field (German: without the article). This is
 * the `ScheduleCtx.sortKey` that scope.ts injects (W3-4), written out here.
 */
function termSortKey(state: DataState): NonNullable<ScheduleCtx['sortKey']> {
  const index = buildLibraryIndex(state.notes, state.noteTypes);
  return (card) => {
    const note = index.noteById.get(card.noteId)!;
    const type = index.typeById.get(note.typeId)!;
    return termHelpers(type.fields[type.sortField].lang).sortKey(plainText(note.fields[type.sortField]));
  };
}

/** The query context for a whole v3 state. */
function matchCtx(state: DataState, now: number): MatchCtx {
  return {
    now,
    index: buildLibraryIndex(state.notes, state.noteTypes),
    decks: new Map(state.decks.map((d) => [d.id, d])),
    lists: listsById(state.lists),
  };
}

let idCount = 0;
const ctxFor = (now: number) => ({ now, newId: (p: string) => `${p}-${(idCount += 1)}` });

/* -------------------------------------------------------------- versions */

describe('schema constants', () => {
  it('wave 3 writes schema 3 and only schema-3 readers may read it', () => {
    expect(CURRENT_SCHEMA).toBe(3);
    expect(MIN_READER).toBe(3);
  });
});

describe('detectVersion', () => {
  it.each(V0_FIXTURES)('%s is schema 0', (name) => {
    expect(detectVersion(stateFixture(name))).toBe(0);
  });

  it.each(V1_FIXTURES)('%s is schema 1', (name) => {
    expect(detectVersion(stateFixture(name))).toBe(1);
  });

  it('a document with schemaVersion says its own version', () => {
    expect(detectVersion(makeState() as unknown as Obj)).toBe(2);
    expect(detectVersion(buildSeedState(FIXED_NOW) as unknown as Obj)).toBe(3);
    expect(detectVersion({ schemaVersion: 9 })).toBe(9);
  });

  it('with no cards, a deck with a flag and no icon means schema 0', () => {
    const doc = { cards: [], decks: [{ id: 'd', flag: '🇩🇪' }], settings: { readAloudEnabled: true } };
    expect(detectVersion(doc)).toBe(0);
    expect(detectVersion({ ...doc, decks: [{ id: 'd', icon: '🌍' }] })).toBe(1);
  });

  it('the empty-library fixture is told apart by its settings only', () => {
    const doc = stateFixture('v0-empty-library');
    expect(doc.cards).toEqual([]);
    expect(doc.decks).toEqual([]);
    expect(detectVersion(doc)).toBe(0);
  });
});

/* -------------------------------------------- the v2 stage: v0 → v2 */

describe('migrateToV2 — v0 (the public v2.0.2 release)', () => {
  const out = migratedV2('v0-v2.0.2');
  const { state } = out;
  const raw = stateFixture('v0-v2.0.2');

  it('is ok, from 0, a valid schema-2 document, with nothing to repair', () => {
    expect(out.from).toBe(0);
    expect(out.repaired).toEqual([]);
    expect(state.schemaVersion).toBe(2);
    expect(state.minReaderVersion).toBe(2);
    expect(stateProblems(state)).toEqual([]);
  });

  it('keeps the number of cards, decks, sessions, review entries and collections', () => {
    expect(state.cards).toHaveLength((raw.cards as unknown[]).length);
    expect(state.decks).toHaveLength((raw.decks as unknown[]).length);
    expect(state.sessions).toEqual(raw.sessions);
    expect(state.reviewLog).toEqual(raw.reviewLog);
    expect(state.collections).toEqual(raw.collections);
    expect(state.person).toEqual(raw.person);
    expect(state.onboarded).toBe(true);
  });

  it('every card has a text front and back, and a raw legacy copy of the ten language fields', () => {
    const before = rawCards('v0-v2.0.2');
    state.cards.forEach((card, i) => {
      expect(typeof card.front).toBe('string');
      expect(typeof card.back).toBe('string');
      expect(card.front).toBe(before[i].word);
      expect(card.back).toBe(before[i].tr);
      const legacy = Object.fromEntries(
        ['word', 'article', 'base', 'tr', 'ipa', 'ex', 'exTr', 'level', 'type', 'lang']
          .filter((k) => before[i][k] !== undefined)
          .map((k) => [k, before[i][k]]),
      );
      expect(card.legacy).toStrictEqual(legacy);
      // The old fields left the top level (they live in `legacy` now).
      expect(Object.keys(card)).not.toEqual(expect.arrayContaining(['word']));
      expect('tr' in card || 'lang' in card || 'level' in card).toBe(false);
    });
  });

  it('copies id, deck, flags and every SRS field byte for byte', () => {
    const before = rawCards('v0-v2.0.2');
    state.cards.forEach((card, i) => {
      for (const key of KEPT_CARD_KEYS) expect((card as unknown as Obj)[key]).toStrictEqual(before[i][key]);
    });
  });

  it('"die Stunde" stays "die Stunde" (the article is never added again)', () => {
    const stunde = state.cards.find((c) => c.legacy?.base === 'Stunde');
    expect(stunde).toBeDefined();
    expect(stunde!.front).toBe('die Stunde');
    expect(stunde!.back).toBe('the hour');
    expect(stunde!.example).toBe('Wir treffen uns in einer Stunde.');
    expect(stunde!.notes).toBe('/ˈʃtʊndə/\nWe meet in an hour.');
    expect(state.cards.some((c) => c.front.startsWith('die die '))).toBe(false);
  });

  it('notes hold the IPA and the example translation, and exist only when one of them does', () => {
    const before = rawCards('v0-v2.0.2');
    state.cards.forEach((card, i) => {
      const parts = [before[i].ipa, before[i].exTr].filter((x) => typeof x === 'string' && x !== '');
      if (parts.length) expect(card.notes).toBe(parts.join('\n'));
      else expect('notes' in card).toBe(false);
      if (before[i].ex) expect(card.example).toBe(before[i].ex);
      else expect('example' in card).toBe(false);
    });
    // "picante" (CSV import) has an example but no IPA and no translation.
    const picante = state.cards.find((c) => c.front === 'picante')!;
    expect(picante.example).toBe('Esta salsa es muy picante, ¿no?');
    expect('notes' in picante).toBe(false);
  });

  it('decks get their flag as the icon and keep flag, language and level in legacy', () => {
    const before = rawDecks('v0-v2.0.2');
    state.decks.forEach((deck, i) => {
      expect(deck.icon).toBe(before[i].flag);
      expect(deck.legacy).toStrictEqual({ flag: before[i].flag, lang: before[i].lang, level: before[i].level });
      expect(deck.builtin).toBe(before[i].builtin);
      expect('flag' in deck || 'lang' in deck || 'level' in deck).toBe(false);
    });
    expect(state.decks.map((d) => d.icon)).toEqual(['🇩🇪', '🇩🇪', '🇪🇸']);
  });

  it('maps the read-aloud settings, turns the reminder off and keeps the rest', () => {
    const settings = state.settings as unknown as Obj;
    expect(settings.readAloudEnabled).toBe(true); // ttsEnabled: true
    expect(settings.autoReadAloud).toBe(true); // autoPlayAudio: true (not the default)
    expect(settings.reminderEnabled).toBe(false); // was true; it never worked
    expect('ttsEnabled' in settings || 'autoPlayAudio' in settings).toBe(false);
    expect(settings.pronunciationPrompt).toBe(true); // unknown key, left for v4
    expect(state.settings.srs).toStrictEqual((raw.settings as Obj).srs);
  });

  it('keeps the killed session’s marker as it is (no studyDay — tally.ts falls back)', () => {
    expect(state.inProgressSession).toStrictEqual(raw.inProgressSession);
    expect('studyDay' in (state.inProgressSession as object)).toBe(false);
  });
});

/* ------------------------------------------- v0 → v2 on a REAL device */

/**
 * The REAL-DEVICE fixture: the exact `maranki.state.v1` value that the public
 * v2.0.2 release build saved on an Android emulator (synthetic study data;
 * see __fixtures__/README.md). The other fixtures were made by running the old
 * code in jest; this one proves the migration also reads what a real phone
 * wrote. It is not in STATE_FIXTURES (src/test/factories.ts), so it is read
 * here directly.
 */
const deviceRaw = (): string =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'v0-v2.0.2-device.json'), 'utf8');
const deviceDoc = (): Obj => JSON.parse(deviceRaw()) as Obj;
/** The learner opens the updated app one hour after the last review the old app saved. */
const reopen = (): number => Math.max(...((deviceDoc().reviewLog as { atMs: number }[]).map((e) => e.atMs))) + HOUR;

describe('migrateToV2 — v0 on a real device (the v2.0.2 release build, Android emulator)', () => {
  const raw = deviceDoc();
  const before = raw.cards as Obj[];
  const out = migrateToV2(deviceDoc(), reopen());
  if (out.kind !== 'ok') throw new Error(`device fixture: expected ok, got ${out.kind}`);
  const { state } = out;

  it('the file is exactly the stored value: one JSON.stringify line, no newline at the end', () => {
    expect(deviceRaw()).toBe(JSON.stringify(raw));
  });

  it('is detected as v0 and becomes a valid schema-2 document with nothing to repair', () => {
    expect(detectVersion(raw)).toBe(0);
    expect(out.from).toBe(0);
    expect(out.repaired).toEqual([]);
    expect(state.schemaVersion).toBe(2);
    expect(state.minReaderVersion).toBe(2);
    expect(stateProblems(state)).toEqual([]);
  });

  it('every card gets front === word and back === tr, and keeps the ten old fields in legacy', () => {
    expect(before.every((c) => typeof c.word === 'string' && c.front === undefined)).toBe(true);
    state.cards.forEach((card, i) => {
      expect(card.front).toBe(before[i].word);
      expect(card.back).toBe(before[i].tr);
      expect(card.legacy).toStrictEqual(
        Object.fromEntries(
          ['word', 'article', 'base', 'tr', 'ipa', 'ex', 'exTr', 'level', 'type', 'lang'].map((k) => [k, before[i][k]]),
        ),
      );
    });
    const stunde = state.cards.find((c) => c.legacy?.base === 'Stunde')!;
    expect(stunde.front).toBe('die Stunde'); // never "die die Stunde"
    expect(stunde.notes).toBe('/ˈʃtʊndə/\nWe meet in an hour.');
  });

  it('keeps every count: 68 cards, 2 decks, 1 session, 9 review entries, 3 collections, the person', () => {
    expect(state.cards).toHaveLength(68);
    expect(state.decks.map((d) => [d.id, d.icon])).toEqual([
      ['de-everyday', '🇩🇪'],
      ['de-conversation', '🇩🇪'],
    ]);
    expect(state.cards.filter((c) => c.deckId === 'de-everyday')).toHaveLength(44);
    expect(state.cards.filter((c) => c.deckId === 'de-conversation')).toHaveLength(24);
    expect(state.sessions).toEqual(raw.sessions);
    expect(state.reviewLog).toEqual(raw.reviewLog);
    expect(state.reviewLog).toHaveLength(9);
    expect(state.collections).toEqual(raw.collections);
    expect(state.person).toEqual(raw.person);
    expect(state.onboarded).toBe(true);
  });

  it('copies id, deck, flags and every SRS field byte for byte', () => {
    state.cards.forEach((card, i) => {
      for (const key of KEPT_CARD_KEYS) expect((card as unknown as Obj)[key]).toStrictEqual(before[i][key]);
    });
    expect(state.cards.filter((c) => c.reps > 0)).toHaveLength(7); // the cards the learner studied
  });

  it('keeps the favorite "die Stunde" and the flag on "aufräumen" — and nothing else is marked', () => {
    expect(state.cards.filter((c) => c.fav).map((c) => c.front)).toEqual(['die Stunde']);
    expect(state.cards.filter((c) => c.flagged).map((c) => c.front)).toEqual(['aufräumen']);
  });

  it('maps the settings: read aloud on, "speak on reveal" off, reminder off, the rest kept', () => {
    const settings = state.settings as unknown as Obj;
    expect(settings.readAloudEnabled).toBe(true); // ttsEnabled: true
    expect(settings.autoReadAloud).toBe(false); // autoPlayAudio: false
    expect(settings.reminderEnabled).toBe(false); // was true; it never worked
    // Wave 5b L7: the old app's default time (it could not be changed, and the reminder never
    // worked) becomes the new default, so Today and Settings › Reminders offer 8:00 PM.
    expect((raw.settings as Obj).reminderTime).toBe('21:00');
    expect(settings.reminderTime).toBe('20:00');
    expect(state.settings.srs).toStrictEqual((raw.settings as Obj).srs);
  });

  it('the killed session’s marker (2 Good ratings, no studyDay) survives as it is', () => {
    expect(state.inProgressSession).toStrictEqual(raw.inProgressSession);
    expect(state.inProgressSession).toMatchObject({ kind: 'scheduled', counts: { good: 2 }, total: 2 });
    expect('studyDay' in (state.inProgressSession as object)).toBe(false);
  });
});

describe('migrateToV2 — v0 German fork', () => {
  const { state, from, repaired } = migratedV2('v0-german-fork');
  const raw = stateFixture('v0-german-fork');

  it('is ok and valid, with every card mapped and a legacy copy on each', () => {
    expect(from).toBe(0);
    expect(repaired).toEqual([]);
    expect(stateProblems(state)).toEqual([]);
    expect(state.cards).toHaveLength((raw.cards as unknown[]).length);
    expect(state.cards.every((c) => typeof c.front === 'string' && c.legacy?.word === c.front)).toBe(true);
  });

  it('keeps the marker WITH its studyDay', () => {
    expect(state.inProgressSession).toStrictEqual(raw.inProgressSession);
    expect(state.inProgressSession?.studyDay).toBe('2026-07-15');
  });

  it('maps autoPlayAudio: false to autoReadAloud: false, and the deck flags to icons', () => {
    expect(state.settings.autoReadAloud).toBe(false);
    expect(state.settings.readAloudEnabled).toBe(true);
    expect(state.settings.reminderEnabled).toBe(false);
    expect(state.settings.srs.dailyNewLimit).toBe(8);
    expect(state.decks.every((d) => d.icon === '🇩🇪' && d.legacy?.lang === 'German')).toBe(true);
  });
});

describe('migrateToV2 — v0 empty library', () => {
  const { state, from } = migratedV2('v0-empty-library');
  const raw = stateFixture('v0-empty-library');

  it('keeps the progress of a learner who deleted every deck', () => {
    expect(from).toBe(0);
    expect(stateProblems(state)).toEqual([]);
    expect(state.cards).toEqual([]);
    expect(state.decks).toEqual([]);
    expect(state.sessions).toEqual(raw.sessions);
    expect(state.reviewLog).toEqual(raw.reviewLog);
    expect(state.person).toEqual(raw.person);
    expect(state.onboarded).toBe(true);
    expect(state.settings.readAloudEnabled).toBe(true);
    expect(state.settings.autoReadAloud).toBe(false);
  });
});

/* -------------------------------------------- the v2 stage: v1 → v2 */

describe('migrateToV2 — v1 (main@1333d48)', () => {
  // Wave 5b L7: the old default reminder time '21:00' also becomes '20:00' (migrate.ts moveOldReminderTime).
  it('changes only the version fields, the new autoReadAloud, reminderEnabled and the old default reminder time', () => {
    const raw = stateFixture('v1-main-1333d48');
    const out = migratedV2('v1-main-1333d48');
    expect(out.from).toBe(1);
    expect(out.repaired).toEqual([]);
    expect(out.state).toStrictEqual({
      ...raw,
      schemaVersion: 2,
      minReaderVersion: 2,
      settings: { ...(raw.settings as Obj), autoReadAloud: false, reminderEnabled: false, reminderTime: '20:00' },
    });
    expect((raw.settings as Obj).reminderEnabled).toBe(true);
    expect((raw.settings as Obj).reminderTime).toBe('21:00');
    expect(stateProblems(out.state)).toEqual([]);
  });

  it('a reminder time other than the old default is kept as it is', () => {
    const raw = stateFixture('v1-main-1333d48');
    const doc = { ...raw, settings: { ...(raw.settings as Obj), reminderTime: '07:30' } };
    expect(v1toV2(doc as unknown as Parameters<typeof v1toV2>[0], FIXED_NOW).settings.reminderTime).toBe('07:30');
    const v0 = stateFixture('v0-v2.0.2');
    const v0doc = { ...v0, settings: { ...(v0.settings as Obj), reminderTime: '06:45' } };
    expect(v0toV2(v0doc as unknown as Parameters<typeof v0toV2>[0], FIXED_NOW).settings.reminderTime).toBe('06:45');
    expect(v0toV2(v0 as unknown as Parameters<typeof v0toV2>[0], FIXED_NOW).settings.reminderTime).toBe('20:00');
  });

  it('a marker without studyDay survives as it is', () => {
    const raw = stateFixture('v1-marker-no-studyDay');
    const { state } = migratedV2('v1-marker-no-studyDay');
    expect(state.inProgressSession).toStrictEqual(raw.inProgressSession);
    expect(state.inProgressSession).not.toBeNull();
    expect('studyDay' in (state.inProgressSession as object)).toBe(false);
  });

  it('an orphan card moves to "Unfiled cards" and the repair is listed', () => {
    const raw = stateFixture('v1-orphan-card');
    const { state, repaired } = migratedV2('v1-orphan-card');
    const nacl = state.cards.find((c) => c.front === 'NaCl')!;
    expect(nacl.deckId).toBe(UNFILED_DECK_ID);
    expect(state.decks.find((d) => d.id === UNFILED_DECK_ID)).toMatchObject({ name: 'Unfiled cards', active: true });
    expect(state.cards).toHaveLength((raw.cards as unknown[]).length);
    expect(state.decks).toHaveLength((raw.decks as unknown[]).length + 1);
    expect(repaired).toEqual([
      'card "c-mrt6jw28-9": deckId "d-deleted-deck" → "unfiled"',
      'deck "unfiled": created for cards whose deck was missing',
    ]);
    expect(stateProblems(state)).toEqual([]);
  });

  it('NaN and broken fields are repaired (spec §3.3) and each repair is listed', () => {
    const now = localTime('2026-07-22', '10:00');
    const { state, repaired } = migratedV2('v1-nan-fields', now);
    const byFront = (front: string) => state.cards.find((c) => c.id === idOf(front))!;
    const idOf = (front: string) => (stateFixture('v1-main-1333d48').cards as Obj[]).find((c) => c.front === front)!.id;

    expect(byFront('France')).toMatchObject({ ease: DEFAULT_SRS.startingEase, due: now });
    expect(byFront('Japan').ease).toBe(1.3);
    expect(byFront('Canada')).toMatchObject({ intervalDays: 0, reps: 0, lapses: 0 });
    expect(byFront('Kenya')).toMatchObject({ reps: 0, lapses: 0 });
    expect(byFront('Australia')).toMatchObject({ reps: 3, stepIndex: 0 });
    expect(byFront('H2O')).toMatchObject({ reps: 0, stepIndex: null });
    expect(byFront('CO2')).toMatchObject({ front: '42', back: '' });
    expect(byFront('CH4').due).toBe(now);
    expect(byFront('Fe').back).toBe('');

    expect(repaired).toEqual([
      `card "${idOf('France')}": ease null → 2.5`,
      `card "${idOf('France')}": due null → ${now}`,
      `card "${idOf('Japan')}": ease 1.1 → 1.3`,
      `card "${idOf('Canada')}": intervalDays null → 0`,
      `card "${idOf('Canada')}": reps null → 0`,
      `card "${idOf('Canada')}": lapses null → 0`,
      `card "${idOf('Kenya')}": reps -2 → 0`,
      `card "${idOf('Kenya')}": lapses -1 → 0`,
      `card "${idOf('Australia')}": stepIndex 1.5 → 0`,
      `card "${idOf('H2O')}": stepIndex -1 → null`,
      `card "${idOf('CO2')}": front 42 → "42"`,
      `card "${idOf('CO2')}": back null → ""`,
      `card "${idOf('CH4')}": due "2026-07-22" → ${now}`,
      `card "${idOf('Fe')}": back missing → ""`,
    ]);
    expect(stateProblems(state)).toEqual([]);
    // Repair, never drop: every card is still there.
    expect(state.cards).toHaveLength(rawCards('v1-nan-fields').length);
  });

  it('a schema-3 document has no schema-2 form: migrateToV2 says invalid (migrate() reads it)', () => {
    expect(migrateToV2(buildSeedState(FIXED_NOW), FIXED_NOW)).toEqual({ kind: 'invalid' });
    expect(migrate(buildSeedState(FIXED_NOW), FIXED_NOW).kind).toBe('ok');
  });
});

/* ------------------------------------------------- the whole chain → v3 */

describe('migrate — every fixture ends in a valid schema-3 document', () => {
  const ALL = [...STATE_FIXTURES];

  it.each(ALL)('%s: ok, version 3 / 3, valid, the same cards (ids, order, SRS) as the v2 stage', (name) => {
    const v2 = migratedV2(name);
    const out = migratedV3(name);
    expect(out.from).toBe(v2.from);
    expect(out.state.schemaVersion).toBe(3);
    expect(out.state.minReaderVersion).toBe(3);
    expect(v3Problems(out.state)).toEqual([]);
    expect(out.state.cards.map((c) => c.id)).toEqual(v2.state.cards.map((c) => c.id));
    out.state.cards.forEach((card, i) => {
      const old = v2.state.cards[i] as unknown as Obj;
      for (const key of SRS_KEYS) expect((card as unknown as Obj)[key]).toStrictEqual(old[key]);
      // Flags: an absent v2 flag is `false` in v3 (makeCard's default).
      for (const key of ['fav', 'flagged', 'suspended'] as const) expect(card[key]).toBe(old[key] === true);
      expect(card.ord).toBe(0);
      expect(card.newPos).toBe(old.createdAt);
    });
    // One note per card; the decks, sessions and collections are all still there.
    expect(out.state.notes).toHaveLength(v2.state.cards.length);
    expect(out.state.decks.map((d) => d.id)).toEqual(v2.state.decks.map((d) => d.id));
    expect(out.state.sessions).toEqual(v2.state.sessions);
    expect(out.state.collections).toEqual(v2.state.collections);
  });

  it.each(ALL)('%s: the whole chain lists exactly the v2-stage repairs (the v3 checks find nothing more)', (name) => {
    expect(migratedV3(name).repaired).toEqual(migratedV2(name).repaired);
  });

  it.each(ALL)('%s: idempotent — migrating the result again changes nothing', (name) => {
    const first = migratedV3(name).state;
    const again = migratedDoc(JSON.parse(JSON.stringify(first)), FIXED_NOW + 86_400_000);
    expect(again.from).toBe(3);
    expect(again.repaired).toEqual([]);
    expect(again.state).toStrictEqual(first);
  });

  it('v0: the old Level, Type, Pronunciation and Example translation are note fields (the Level/Type filters come back)', () => {
    const { state } = migratedV3('v0-v2.0.2');
    const before = rawCards('v0-v2.0.2');
    expect(state.notes.every((n) => n.typeId.startsWith('nt-legacy'))).toBe(true);
    state.cards.forEach((card, i) => {
      expect(fieldOf(state, card, 'Word')).toBe(before[i].word);
      expect(fieldOf(state, card, 'Level')).toBe(before[i].level ?? '');
      expect(fieldOf(state, card, 'Type')).toBe(before[i].type ?? '');
    });
    const stunde = state.cards.find((c) => c.legacy?.base === 'Stunde')!;
    expect(fieldOf(state, stunde, 'Word')).toBe('die Stunde');
    expect(fieldOf(state, stunde, 'Pronunciation')).toBe('/ˈʃtʊndə/');
    expect(fieldOf(state, stunde, 'Example translation')).toBe('We meet in an hour.');
    // The auto-joined notes are not the learner's own: the Notes field is empty.
    expect(fieldOf(state, stunde, 'Notes')).toBe('');
    const level = state.noteTypes.find((t) => t.id === BUILTIN_TYPE_IDS.legacyVocabDe)!.fields.find((f) => f.name === 'Level')!;
    expect(level).toMatchObject({ role: 'badge', facet: 'on' });
    expect(state.decks.map((d) => d.language)).toEqual(['de-DE', 'de-DE', 'es-ES']);
  });

  it('v1: every card becomes a Basic note [front, back, example, notes] with its tags', () => {
    const { state } = migratedV3('v1-main-1333d48');
    const before = rawCards('v1-main-1333d48');
    state.cards.forEach((card, i) => {
      const note = noteOf(state, card);
      expect(note.typeId).toBe(BUILTIN_TYPE_IDS.basic);
      expect(note.fields.slice(0, 2)).toEqual([fieldText(before[i].front), fieldText(before[i].back)]);
      expect(note.tags).toEqual(before[i].tags ?? []);
      expect(note).toMatchObject({ id: `n-${card.id}`, guid: `m-${card.id}`, section: '', source: { kind: 'migrated' } });
    });
  });

  it('the orphan card is in a real v3 "Unfiled cards" deck (its own order, source, options)', () => {
    const { state } = migratedV3('v1-orphan-card');
    const unfiled = state.decks.find((d) => d.id === UNFILED_DECK_ID)!;
    expect(unfiled).toMatchObject({ name: 'Unfiled cards', active: true, source: 'migrated' });
    expect(new Set(state.decks.map((d) => d.order)).size).toBe(state.decks.length);
    expect(unfiled.options).toEqual({ newPerDay: null, newOrder: 'source', newArrival: 'queued', knownChecks: true });
    const nacl = state.cards.find((c) => fieldOf(state, c, 'Front') === 'NaCl')!;
    expect(nacl.deckId).toBe(UNFILED_DECK_ID);
  });

  it('the v3 settings get the seven new keys; the stored v2 settings are kept (the old default reminder time is the new one)', () => {
    const { state } = migratedV3('v1-main-1333d48');
    const raw = stateFixture('v1-main-1333d48').settings as Obj;
    expect(state.settings).toMatchObject({
      reminderSkipStudied: true,
      spaceSiblings: true,
      knownChecksPerDay: 5,
      autoBackup: true,
      lastAutoBackupAt: null,
      backupImages: true,
      reminderOfferSeen: false,
      // The v1 → v2 step moved the old default '21:00' to '20:00' (wave 5b L7); v2 → v3 keeps it.
      reminderTime: raw.reminderTime === '21:00' ? '20:00' : raw.reminderTime,
      sessionLimit: raw.sessionLimit,
    });
    for (const key of V3_SETTINGS_KEYS) expect(key in state.settings).toBe(true);
  });

  it('the old collections become pinned built-in lists; review entries get seq and bucket; the tally gets checks', () => {
    const { state } = migratedV3('v0-v2.0.2');
    expect(state.listPrefs).toEqual({
      'builtin:hard': { pinned: true, hidden: false, order: 0 },
      'builtin:favorites': { pinned: true, hidden: false, order: 1 },
      'builtin:recent': { pinned: true, hidden: false, order: 2 },
    });
    expect(state.reviewLog.map((e) => e.seq)).toEqual(state.reviewLog.map((_, i) => i + 1));
    expect(state.reviewLog.every((e) => e.bucket === 'new' || e.bucket === 'review')).toBe(true);
    expect(state.person.dayDone).toMatchObject({ checks: 0, newByDeck: {} });
    expect(state).toMatchObject({ lists: [], manualLog: [], pack: null });
  });

  it('search and every "Study N" count work on the migrated v0 data (the v2.0.2 crash), and count === queue', () => {
    const { state } = migratedV3('v0-v2.0.2');
    const now = localTime('2026-07-08', '09:00');
    const all = state.cards.filter(compileQuery({ text: 'a' }, matchCtx(state, now)));
    expect(all.length).toBeGreaterThan(0);
    const stunde = state.cards.filter(compileQuery({ text: 'stunde' }, matchCtx(state, now)));
    expect(stunde.map((c) => fieldOf(state, c, 'Word'))).toContain('die Stunde');

    for (const at of [localTime('2026-07-07', '09:00'), localTime('2026-07-09', '18:00')]) {
      const ctx = scheduleCtx(state, at);
      const pool = state.cards.filter((c) => state.decks.find((d) => d.id === c.deckId)!.active);
      const sel = selectScheduled(pool, ctx);
      expect(readyCounts(sel).total).toBeGreaterThan(0);
      expect(readyCounts(sel).total).toBe(planQueue(sel).length);
      for (const deck of state.decks) {
        const deckSel = selectScheduled(pool.filter((c) => c.deckId === deck.id), ctx);
        expect(readyCounts(deckSel).total).toBe(planQueue(deckSel).length);
      }
    }
  });

  it('every Library sort works on the migrated v0 cards and keeps every card (the v2.0.2 A–Z crash)', () => {
    const { state } = migratedV3('v0-v2.0.2');
    const now = localTime('2026-07-08', '09:00');
    // Every migrated v0 card can be practised: none is suspended, buried, Known or Not started.
    expect(state.cards.filter((c) => c.suspended || isBuried(c, now) || life(c) === 'known' || life(c) === 'notStarted')).toEqual([]);
    // sessionLimit 0 = no session cap, so selectPractice returns the WHOLE eligible pool.
    const ctx: ScheduleCtx = {
      ...scheduleCtx(state, now),
      settings: { ...state.settings, sessionLimit: 0 },
      sortKey: termSortKey(state),
    };
    const searched = state.cards.filter(compileQuery({ text: 'a' }, matchCtx(state, now)));
    expect(searched.length).toBeGreaterThan(0);
    const ids = (cards: readonly Card[]) => cards.map((c) => c.id).sort();
    for (const by of ['source', 'due', 'az', 'newest', 'hardest'] as const) {
      for (const pool of [state.cards, searched]) {
        const run = () => selectPractice(pool, { by }, ctx);
        expect(run).not.toThrow();
        expect(ids(run())).toEqual(ids(pool));
      }
    }
    // A–Z really sorts by the word (German: without the article), and returns every card.
    const az = selectPractice(state.cards, { by: 'az' }, ctx);
    expect(az).toHaveLength(state.cards.length);
    const keys = az.map((c) => ctx.sortKey!(c, { by: 'az' }) as string);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain('stunde');
  });
});

describe('migrate — the real device document, through the whole chain', () => {
  const raw = deviceDoc();
  const before = raw.cards as Obj[];
  const now = reopen();
  const out = migratedDoc(deviceDoc(), now);
  const { state } = out;

  it('is a valid schema-3 document with nothing to repair; 68 cards, the same ids and SRS values', () => {
    expect(out.from).toBe(0);
    expect(out.repaired).toEqual([]);
    expect(v3Problems(state)).toEqual([]);
    expect(state.cards).toHaveLength(68);
    state.cards.forEach((card, i) => {
      for (const key of ['id', 'deckId', 'ease', 'intervalDays', 'stepIndex', 'reps', 'lapses', 'due', 'createdAt', 'lastReviewedAt'] as const) {
        expect(card[key]).toStrictEqual(before[i][key]);
      }
    });
    expect(state.cards.filter((c) => c.reps > 0)).toHaveLength(7);
  });

  it('Level and Type became note fields for every card; Word is the old display form', () => {
    state.cards.forEach((card, i) => {
      expect(fieldOf(state, card, 'Word')).toBe(before[i].word);
      expect(fieldOf(state, card, 'Translation')).toBe(before[i].tr);
      expect(fieldOf(state, card, 'Level')).toBe(before[i].level ?? '');
      expect(fieldOf(state, card, 'Type')).toBe(before[i].type ?? '');
    });
    expect(state.cards.some((c) => fieldOf(state, c, 'Level') !== '')).toBe(true);
    expect(state.cards.some((c) => fieldOf(state, c, 'Word').startsWith('die die '))).toBe(false);
  });

  it('keeps the favorite and the flag, and the old German decks get their languages', () => {
    expect(state.cards.filter((c) => c.fav).map((c) => fieldOf(state, c, 'Word'))).toEqual(['die Stunde']);
    expect(state.cards.filter((c) => c.flagged).map((c) => fieldOf(state, c, 'Word'))).toEqual(['aufräumen']);
    expect(state.decks.map((d) => [d.id, d.language, d.genderColors])).toEqual([
      ['de-everyday', 'de-DE', true],
      ['de-conversation', 'de-DE', true],
    ]);
  });

  it('the killed session’s marker survives the update, and the boot banks it once (M5)', () => {
    expect(state.inProgressSession).toStrictEqual(raw.inProgressSession);
    const boot = reconcileOnBoot(state, undefined, ctxFor(now));
    expect(boot.result.banked).toBe(true);
    expect(boot.state.sessions).toHaveLength(2);
    expect(boot.state.sessions[1]).toMatchObject({ kind: 'scheduled', total: 2, counts: { again: 0, hard: 0, good: 2, easy: 0 } });
    expect(boot.state.inProgressSession).toBeNull();
    expect(reconcileOnBoot(boot.state, undefined, ctxFor(now)).result.banked).toBe(false); // exactly once
  });

  it('is idempotent', () => {
    const again = migratedDoc(JSON.parse(JSON.stringify(state)), now + HOUR);
    expect(again.from).toBe(3);
    expect(again.repaired).toEqual([]);
    expect(again.state).toStrictEqual(state);
  });
});

describe('migrate — random documents', () => {
  it('50 seeded random schema-2 documents become valid v3 documents, and stay fixed points', () => {
    const rnd = createRandom('migrate-v2-to-v3');
    for (let i = 0; i < 50; i++) {
      const v2 = randomState(rnd.fork(`v2-${i}`));
      const out = migratedDoc(JSON.parse(JSON.stringify(v2)), FIXED_NOW);
      expect(out.repaired).toEqual([]);
      expect(v3Problems(out.state)).toEqual([]);
      expect(out.state.cards.map((c) => c.id)).toEqual(v2.cards.map((c) => c.id));
      const again = migratedDoc(JSON.parse(JSON.stringify(out.state)), FIXED_NOW);
      expect(again.repaired).toEqual([]);
      expect(again.state).toStrictEqual(out.state);
    }
  });

  it('a valid v3 document (the seed, 50 seeded random libraries) comes back unchanged', () => {
    const rnd = createRandom('migrate-v3-fixed-point');
    const states: DataState[] = [buildSeedState(FIXED_NOW), makeStateV3()];
    for (let i = 0; i < 50; i++) states.push(randomStateV3(rnd.fork(`v3-${i}`)));
    for (const s of states) {
      const out = migratedDoc(JSON.parse(JSON.stringify(s)), FIXED_NOW);
      expect(out.from).toBe(3);
      expect(out.repaired).toEqual([]);
      expect(out.state).toStrictEqual(s);
    }
  });

  it('an intact v3 state keeps its lists by identity (the row diff writes nothing)', () => {
    const s = randomStateV3(createRandom('identity'));
    const out = migratedDoc(s, FIXED_NOW);
    expect(out.state.cards).toBe(s.cards);
    expect(out.state.notes).toBe(s.notes);
    expect(out.state.decks).toBe(s.decks);
    expect(out.state.noteTypes).toBe(s.noteTypes);
  });
});

/* ------------------------------------------------- too-new and invalid */

describe('migrate — documents from a newer app', () => {
  it('{schemaVersion: 9, minReaderVersion: 9} → too-new, whatever its shape', () => {
    expect(migrate({ schemaVersion: 9, minReaderVersion: 9 }, FIXED_NOW)).toEqual({ kind: 'too-new', version: 9 });
    expect(migrate({ ...buildSeedState(FIXED_NOW), schemaVersion: 9, minReaderVersion: 9 }, FIXED_NOW)).toEqual({
      kind: 'too-new',
      version: 9,
    });
    expect(migrate({ ...buildSeedState(FIXED_NOW), schemaVersion: 4, minReaderVersion: 4 }, FIXED_NOW)).toEqual({
      kind: 'too-new',
      version: 4,
    });
  });

  it('a newer document with no minReaderVersion is too new (never guess it is readable)', () => {
    expect(migrate({ ...buildSeedState(FIXED_NOW), schemaVersion: 4, minReaderVersion: undefined }, FIXED_NOW)).toEqual({
      kind: 'too-new',
      version: 4,
    });
  });

  it('a v3 document read by a schema-2 build (CURRENT_SCHEMA = 2) is too new — it is never misread', () => {
    // tooNewFor is the rule-6 check of migrate(); a wave-1/2 build runs it with its CURRENT_SCHEMA = 2.
    const written = migratedV3('v0-v2.0.2').state;
    expect(tooNewFor(written as unknown as Obj, 2)).toBe(3);
    expect(tooNewFor(buildSeedState(FIXED_NOW) as unknown as Obj, 2)).toBe(3);
    // Every document this build writes says "only schema-3 readers": minReaderVersion 3 > 2.
    expect(written.minReaderVersion).toBe(3);
    // This build reads its own documents; a schema-2 document is never too new for anyone.
    expect(tooNewFor(written as unknown as Obj, 3)).toBeNull();
    expect(tooNewFor(makeState() as unknown as Obj, 2)).toBeNull();
    expect(tooNewFor({ schemaVersion: 3 }, 2)).toBe(3);
  });

  it('{schemaVersion: 9, minReaderVersion: 3} (a v3 shape) is read as it is: version stays 9, unknown fields survive', () => {
    const { note, cards } = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'c1' } });
    const base = makeStateV3({
      decks: [makeDeckV3({ id: 'd1' })],
      noteTypes: [builtinType('basic', FIXED_NOW)],
      notes: [{ ...note, futureNoteKey: 1 } as Note],
      cards: [{ ...cards[0], futureCardKey: { x: 1 } } as Card],
    });
    const doc = { ...base, schemaVersion: 9, minReaderVersion: 3, futureList: [{ id: 'f1' }] };
    doc.settings = { ...doc.settings, newSetting: 'kept' } as typeof doc.settings;
    const out = migratedDoc(JSON.parse(JSON.stringify(doc)), FIXED_NOW);
    expect(out.from).toBe(9);
    expect(out.repaired).toEqual([]);
    expect(out.state.schemaVersion).toBe(9);
    expect(out.state.minReaderVersion).toBe(3);
    expect(out.state).toStrictEqual(doc);
  });

  it('{schemaVersion: 9, minReaderVersion: 2} has the v2 shape: it goes through v2toV3, keeps version 9 and its unknown keys', () => {
    const deck = makeDeck({ id: 'd1' });
    const card = makeCard({ id: 'c1', deckId: 'd1', front: 'Ottawa', back: 'Canada' });
    const doc = { ...makeState({ decks: [deck], cards: [card] }), schemaVersion: 9, minReaderVersion: 2, futureList: [1] };
    doc.settings = { ...doc.settings, newSetting: 'kept' } as typeof doc.settings;
    const out = migratedDoc(JSON.parse(JSON.stringify(doc)), FIXED_NOW);
    expect(out.from).toBe(9);
    expect(out.repaired).toEqual([]);
    expect(out.state.schemaVersion).toBe(9);
    expect(out.state.minReaderVersion).toBe(3); // the note model: only schema-3 readers from now on
    expect(v3Problems(out.state)).toEqual([]);
    expect(out.state.cards.map((c) => c.id)).toEqual(['c1']);
    expect(out.state.notes[0].fields.slice(0, 2)).toEqual(['Ottawa', 'Canada']);
    // Unknown top-level and settings keys survive. (v2toV3 builds each v3 card
    // from the known keys one by one, so the v2 text keys never stay on a card.)
    expect((out.state as unknown as Obj).futureList).toEqual([1]);
    expect((out.state.settings as unknown as Obj).newSetting).toBe('kept');
  });

  it('{schemaVersion: 3} with no minReaderVersion is this build’s own schema: it is read', () => {
    const doc = { ...buildSeedState(FIXED_NOW), minReaderVersion: undefined };
    const out = migratedDoc(JSON.parse(JSON.stringify(doc)), FIXED_NOW);
    expect(out.state.minReaderVersion).toBe(3);
  });
});

describe('migrate — not a Maranki document', () => {
  it.each([
    ['null', null],
    ['a list', []],
    ['a text', 'x'],
    ['a number', 42],
    ['no person and no settings', { cards: [], decks: [] }],
    ['no card list', { decks: [], person: {}, settings: {} }],
    ['a text version', { ...makeState(), schemaVersion: '2' }],
    ['a negative version', { ...makeState(), schemaVersion: -1 }],
    ['a broken version', { ...makeState(), schemaVersion: 2.5 }],
    ['a v3 document without a card list', { ...buildSeedState(FIXED_NOW), cards: 'x' }],
  ])('%s → invalid', (_label, doc) => {
    expect(migrate(doc, FIXED_NOW)).toEqual({ kind: 'invalid' });
    expect(migrateToV2(doc, FIXED_NOW)).toEqual({ kind: 'invalid' });
  });
});

/* ------------------------------------------------- the order of the chain */

describe('migrate — the order of the chain and of the repair list', () => {
  it('v2 repairs and v2 defaults come first, each listed once (the v3 steps find nothing more)', () => {
    const doc = stateFixture('v1-orphan-card');
    doc.settings = { ...(doc.settings as Obj), sessionLimit: null };
    const out = migratedDoc(doc);
    expect(out.state.settings.sessionLimit).toBe(DEFAULT_APP_SETTINGS.sessionLimit);
    expect(out.repaired).toEqual([
      'card "c-mrt6jw28-9": deckId "d-deleted-deck" → "unfiled"',
      'deck "unfiled": created for cards whose deck was missing',
      'settings: sessionLimit null → 50',
    ]);
  });

  it('a damaged v3 document: the link repairs (checkIntegrity), then the values (sanitize), then the defaults', () => {
    const { note, cards } = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'c1' } });
    const s = makeStateV3({
      decks: [makeDeckV3({ id: 'd1' })],
      notes: [note],
      cards: [{ ...cards[0], deckId: 'gone', ease: null } as unknown as Card],
    });
    const doc = JSON.parse(JSON.stringify(s)) as Obj;
    (doc.settings as Obj).knownChecksPerDay = -1;
    const out = migratedDoc(doc);
    expect(out.repaired).toEqual([
      'card type "nt-basic": missing, the built-in "Basic" was added again',
      'card "c1": deckId "gone" → "unfiled" (its deck is missing)',
      'deck "unfiled": created for cards whose deck was missing',
      `card "c1": ease null → ${DEFAULT_SRS.startingEase}`,
      'settings: knownChecksPerDay -1 → 5',
    ]);
    expect(v3Problems(out.state)).toEqual([]);
    expect(out.state.cards[0]).toMatchObject({ deckId: UNFILED_DECK_ID, ease: DEFAULT_SRS.startingEase });
  });

  it('a throwing step is never swallowed: migrate() lets the bug through (the caller blocks writes)', () => {
    const doc = Object.defineProperty({ ...buildSeedState(FIXED_NOW) }, 'noteTypes', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => migrate(doc, FIXED_NOW)).toThrow('boom');
  });
});

/* ----------------------------------------------- v0toV2 / v1toV2 alone */

describe('v0toV2 / v1toV2 on small documents', () => {
  const v0Card = (extra: Obj) => ({
    id: 'c1',
    deckId: 'd1',
    word: 'der Hund',
    article: 'der',
    base: 'Hund',
    tr: 'the dog',
    level: 'A1',
    type: 'noun',
    lang: 'de',
    ease: 2.5,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: FIXED_NOW,
    createdAt: FIXED_NOW,
    lastReviewedAt: null,
    ...extra,
  });
  const v0Doc = (cards: Obj[], decks: Obj[] = [{ id: 'd1', name: 'Deutsch', builtin: false, active: true, createdAt: 0 }]) => ({
    cards,
    decks,
    settings: { ttsEnabled: false },
    person: {},
  });

  it('empty example, IPA and translation leave no example and no notes', () => {
    const s = v0toV2(v0Doc([v0Card({ ex: '', ipa: '', exTr: '  ' })]), FIXED_NOW);
    const card = s.cards[0];
    expect(card.front).toBe('der Hund');
    expect('example' in card || 'notes' in card).toBe(false);
    expect(card.legacy).toMatchObject({ ex: '', ipa: '', exTr: '  ' });
  });

  it('only the IPA → notes is the IPA alone', () => {
    expect(v0toV2(v0Doc([v0Card({ ipa: '/hʊnt/' })]), FIXED_NOW).cards[0].notes).toBe('/hʊnt/');
  });

  it('a deck without a flag gets the fallback icon and no legacy copy', () => {
    const deck = v0toV2(v0Doc([]), FIXED_NOW).decks[0];
    expect(deck.icon).toBe('🗂️');
    expect('legacy' in deck).toBe(false);
  });

  it('ttsEnabled: false → readAloudEnabled: false; no autoPlayAudio → autoReadAloud: false', () => {
    const s = v0toV2(v0Doc([]), FIXED_NOW).settings as unknown as Obj;
    expect(s.readAloudEnabled).toBe(false);
    expect(s.autoReadAloud).toBe(false);
    expect(s.reminderEnabled).toBe(false);
  });

  it('v1toV2 sets only the two settings and the versions', () => {
    const doc = { cards: [], decks: [], person: { xp: 1 }, settings: { reminderEnabled: true, hapticsEnabled: false } };
    expect(v1toV2(doc, FIXED_NOW)).toStrictEqual({
      ...doc,
      settings: { reminderEnabled: false, hapticsEnabled: false, autoReadAloud: false },
      schemaVersion: 2,
      minReaderVersion: 2,
    });
  });

  it('the whole chain on a small v0 document: a German legacy note with Level A1 and Type noun', () => {
    const out = migratedDoc(v0Doc([v0Card({ ipa: '/hʊnt/', ex: 'Der Hund bellt.', exTr: 'The dog barks.' })]));
    const card = out.state.cards[0];
    expect(noteOf(out.state, card).typeId).toBe(BUILTIN_TYPE_IDS.legacyVocabDe);
    expect(fieldOf(out.state, card, 'Level')).toBe('A1');
    expect(fieldOf(out.state, card, 'Type')).toBe('noun');
    expect(fieldOf(out.state, card, 'Example')).toBe('Der Hund bellt.');
    expect(fieldOf(out.state, card, 'Notes')).toBe('');
  });
});

/* ------------------------------------------------------- sanitizeV2 alone */

describe('sanitizeV2 (the schema-2 repairs, before v2toV3)', () => {
  const v2 = (s: Partial<DataStateV2>) => makeState(s);

  it('an intact state keeps the same card and deck objects and lists no repair', () => {
    const deck = makeDeck({ id: 'd1' });
    const state = v2({ decks: [deck], cards: [makeCard({ deckId: 'd1' })] });
    const out = sanitizeV2(state, FIXED_NOW);
    expect(out.repaired).toEqual([]);
    expect(out.state.cards).toBe(state.cards);
    expect(out.state.decks).toBe(state.decks);
  });

  it('entries that are not objects are removed and listed', () => {
    const deck = makeDeck({ id: 'd1' });
    const state = v2({ decks: [deck, null as unknown as DeckV2], cards: [makeCard({ deckId: 'd1' }), 7 as unknown as CardV2] });
    const out = sanitizeV2(state, FIXED_NOW);
    expect(out.state.decks).toHaveLength(1);
    expect(out.state.cards).toHaveLength(1);
    expect(out.repaired).toEqual(['deck #1: null is not a deck, removed', 'card #1: 7 is not a card, removed']);
  });

  it('card tags that are not a list of texts keep what they hold (repair, never drop); the note gets them', () => {
    const deck = makeDeck({ id: 'd1' });
    const cards = [
      makeCard({ id: 'c1', deckId: 'd1', tags: ['ok', 3] as never }),
      makeCard({ id: 'c2', deckId: 'd1', tags: 'verb A1' as never }),
      makeCard({ id: 'c3', deckId: 'd1', tags: null as never }),
    ];
    const out = sanitizeV2(v2({ decks: [deck], cards }), FIXED_NOW);
    expect(out.state.cards.map((c) => c.tags)).toEqual([['ok', '3'], ['verb', 'A1'], []]);
    expect(out.repaired).toEqual([
      'card "c1": tags ["ok",3] → ["ok","3"]',
      'card "c2": tags "verb A1" → ["verb","A1"]',
      'card "c3": tags null → []',
    ]);
    const v3 = migratedDoc(JSON.parse(JSON.stringify(v2({ decks: [deck], cards }))));
    expect(v3.state.notes.map((n) => n.tags)).toEqual([['ok', '3'], ['verb', 'A1'], []]);
  });

  it('deck fields of the wrong type get the addDeck defaults', () => {
    const broken = { id: 'd1', name: 7, icon: null, builtin: 'no', active: undefined, createdAt: 'x' } as unknown as DeckV2;
    const out = sanitizeV2(v2({ decks: [broken] }), FIXED_NOW);
    expect(out.state.decks[0]).toStrictEqual({ id: 'd1', name: '7', icon: '🗂️', builtin: false, active: true, createdAt: FIXED_NOW });
  });

  it('a session marker the boot reconcile cannot read is removed (it would crash completeSession)', () => {
    const state = v2({ inProgressSession: { kind: 'scheduled', label: 'All decks' } as never });
    const out = sanitizeV2(state, FIXED_NOW);
    expect(out.state.inProgressSession).toBeNull();
    expect(out.repaired).toHaveLength(1);
  });

  it('a marker that is not an object is removed and listed', () => {
    const out = sanitizeV2(v2({ inProgressSession: 'x' as never }), FIXED_NOW);
    expect(out.state.inProgressSession).toBeNull();
    expect(out.repaired).toEqual(['inProgressSession: "x" is not a valid session marker, removed']);
  });

  it('a marker with ONE bad number is repaired, not removed — the session is still banked', () => {
    const marker = makeMarker({ durationSec: null as never });
    const state = v2({ inProgressSession: marker });
    const out = sanitizeV2(state, FIXED_NOW);
    expect(out.state.inProgressSession).toStrictEqual({ ...marker, durationSec: 0 });
    expect(out.repaired).toEqual(['inProgressSession: durationSec null → 0']);
    // The boot reconcile (M5) banks it after the update: one more session, the marker cleared.
    const v3 = migratedDoc(JSON.parse(JSON.stringify(state))).state;
    const banked = reconcileOnBoot(v3, undefined, ctxFor(FIXED_NOW));
    expect(banked.result.banked).toBe(true);
    expect(banked.state.sessions).toHaveLength(state.sessions.length + 1);
    expect(banked.state.inProgressSession).toBeNull();
  });

  it('each marker field is repaired by its own rule, and each repair is listed', () => {
    const broken = {
      kind: 5,
      label: null,
      counts: { again: -1, hard: 1.5, good: 2, easy: null },
      total: 'x',
      bestRun: -3,
      durationSec: 12.7,
      fastAnswers: null,
      studyDay: 20260715,
    };
    const out = sanitizeV2(v2({ inProgressSession: broken as never }), FIXED_NOW);
    expect(out.state.inProgressSession).toStrictEqual({
      kind: 'scheduled',
      label: '',
      counts: { again: 0, hard: 1, good: 2, easy: 0 },
      total: 3, // rebuilt from the repaired counts
      bestRun: 0,
      durationSec: 12,
      fastAnswers: 0,
    });
    expect(out.repaired).toEqual([
      'inProgressSession: kind 5 → "scheduled"',
      'inProgressSession: label null → ""',
      'inProgressSession.counts: again -1 → 0',
      'inProgressSession.counts: hard 1.5 → 1',
      'inProgressSession.counts: easy null → 0',
      'inProgressSession: total "x" → 3',
      'inProgressSession: bestRun -3 → 0',
      'inProgressSession: durationSec 12.7 → 12',
      'inProgressSession: fastAnswers null → 0',
      'inProgressSession: studyDay 20260715 removed',
    ]);

    // An unknown kind (a text, but not a SessionKind) and a valid total that does not match the counts.
    const wrong = { ...makeMarker({ counts: { again: 0, hard: 0, good: 2, easy: 0 } }), kind: 'foo', total: 0 };
    const fixed = sanitizeV2(v2({ inProgressSession: wrong as never }), FIXED_NOW);
    expect(fixed.state.inProgressSession).toStrictEqual({ ...wrong, kind: 'scheduled', total: 2 });
    expect(fixed.repaired).toEqual(['inProgressSession: kind "foo" → "scheduled"', 'inProgressSession: total 0 → 2']);
  });

  it('every known session kind is kept (v3 adds "practice"); a text like "constructor" is not a kind', () => {
    for (const kind of ['scheduled', 'ahead', 'practice', 'cram', 'hardest', 'deck', 'collection'] as const) {
      const marker = makeMarker({ kind: kind as never });
      const out = sanitizeV2(v2({ inProgressSession: marker }), FIXED_NOW);
      expect(out.repaired).toEqual([]);
      expect(out.state.inProgressSession).toBe(marker);
    }
    const proto = sanitizeV2(v2({ inProgressSession: makeMarker({ kind: 'constructor' as never }) }), FIXED_NOW);
    expect(proto.state.inProgressSession?.kind).toBe('scheduled');
  });

  it('the marker’s mode (wave 5h): every valid mode is kept as it is; a marker without one needs no repair', () => {
    for (const mode of ['flash', 'type', 'mc', 'mix', 'article'] as const) {
      const marker = { ...makeMarker(), mode };
      const out = sanitizeV2(v2({ inProgressSession: marker as never }), FIXED_NOW);
      expect(out.repaired).toEqual([]);
      expect(out.state.inProgressSession).toBe(marker); // the same object: nothing to repair
    }
    const old = makeMarker();
    expect('mode' in old).toBe(false);
    const out = sanitizeV2(v2({ inProgressSession: old }), FIXED_NOW);
    expect(out.repaired).toEqual([]);
    expect(out.state.inProgressSession).toBe(old);
  });

  it('an invalid marker mode is removed (listed); the marker stays and the boot banks it once, with no mode', () => {
    for (const bad of ['foo', 5, null, 'constructor', '']) {
      const marker = { ...makeMarker(), mode: bad };
      const out = sanitizeV2(v2({ inProgressSession: marker as never }), FIXED_NOW);
      expect(out.repaired).toEqual([`inProgressSession: mode ${JSON.stringify(bad)} removed`]);
      // Every other field is kept as it is.
      expect(out.state.inProgressSession).toStrictEqual(makeMarker());
    }
    // Through the whole migration (schema 3) and the boot reconcile (M5).
    const doc = stateFixture('v1-main-1333d48');
    doc.inProgressSession = { ...(doc.inProgressSession as Obj), mode: 'cram' };
    const migrated = migratedDoc(doc);
    expect(migrated.repaired).toEqual(['inProgressSession: mode "cram" removed']);
    expect(v3Problems(migrated.state)).toEqual([]);
    expect(migrated.state.inProgressSession).not.toBeNull();
    expect('mode' in (migrated.state.inProgressSession as object)).toBe(false);
    const boot = reconcileOnBoot(migrated.state, undefined, ctxFor(FIXED_NOW));
    expect(boot.result.banked).toBe(true);
    expect(boot.state.inProgressSession).toBeNull();
    expect('mode' in boot.state.sessions[boot.state.sessions.length - 1]).toBe(false);
    expect(reconcileOnBoot(boot.state, undefined, ctxFor(FIXED_NOW)).result.banked).toBe(false);
  });

  it('migrate(): a marker WITH a valid mode survives the update and a second migration, and the boot reconcile writes it to the record', () => {
    const doc = stateFixture('v1-main-1333d48');
    doc.inProgressSession = { ...(doc.inProgressSession as Obj), mode: 'mc' };
    const first = migratedDoc(doc);
    expect(first.repaired).toEqual([]);
    expect(first.state.inProgressSession?.mode).toBe('mc');
    // Idempotent: the schema-3 result migrates to itself, the mode kept.
    const again = migratedDoc(JSON.parse(JSON.stringify(first.state)));
    expect(again.repaired).toEqual([]);
    expect(again.state.inProgressSession).toStrictEqual(first.state.inProgressSession);
    const boot = reconcileOnBoot(again.state, undefined, ctxFor(FIXED_NOW));
    expect(boot.state.sessions[boot.state.sessions.length - 1].mode).toBe('mc');
    expect(boot.state.inProgressSession).toBeNull();
  });

  it('a total above the counts is repaired to their sum too, and the boot reconcile banks exactly that', () => {
    const marker = { ...makeMarker({ counts: { again: 1, hard: 0, good: 2, easy: 0 } }), total: 9 };
    const state = v2({ inProgressSession: marker as never });
    const out = sanitizeV2(state, FIXED_NOW);
    expect(out.repaired).toEqual(['inProgressSession: total 9 → 3']);
    expect(stateProblems(out.state)).toEqual([]);
    const v3 = migratedDoc(JSON.parse(JSON.stringify(state))).state;
    const banked = reconcileOnBoot(v3, undefined, ctxFor(FIXED_NOW));
    const record = banked.state.sessions[banked.state.sessions.length - 1];
    expect(record).toMatchObject({ kind: 'scheduled', total: 3, counts: marker.counts });
  });

  it('migrate(): a marker with an unknown kind passes the shared validity check afterwards', () => {
    const doc = stateFixture('v1-main-1333d48');
    doc.inProgressSession = { ...(doc.inProgressSession as Obj), kind: 'foo' };
    const out = migratedDoc(doc);
    expect(out.repaired).toEqual(['inProgressSession: kind "foo" → "scheduled"']);
    expect(v3Problems(out.state)).toEqual([]);
    expect(out.state.inProgressSession?.kind).toBe('scheduled');
  });

  it('a marker with ONE damaged counter keeps its valid, higher total (no reviews or XP are lost)', () => {
    // good was damaged on disk; the stored total still says 5 reviews happened.
    const marker = makeMarker({ counts: { again: 1, hard: 0, good: 'x' as never, easy: 1 }, total: 5 });
    const out = sanitizeV2(v2({ inProgressSession: marker }), FIXED_NOW);
    const fixed = out.state.inProgressSession!;
    expect(fixed.counts).toEqual({ again: 1, hard: 0, good: 0, easy: 1 });
    expect(fixed.total).toBe(5);
  });

  it('intact counters stay the truth: a total that disagrees with them is set to their sum', () => {
    const marker = makeMarker({ counts: { again: 1, hard: 0, good: 2, easy: 0 }, total: 7 });
    const out = sanitizeV2(v2({ inProgressSession: marker }), FIXED_NOW);
    expect(out.state.inProgressSession!.total).toBe(3);
  });

  it('a marker with no readable count (counts {}, total "x") is removed — boot banks nothing', () => {
    const broken = { ...makeMarker(), counts: {}, total: 'x' };
    const state = v2({ inProgressSession: broken as never });
    const out = sanitizeV2(state, FIXED_NOW);
    expect(out.state.inProgressSession).toBeNull();
    // One line for the whole marker (not the field repairs of a marker that is removed).
    expect(out.repaired).toEqual([`inProgressSession: ${JSON.stringify(broken)} records no reviews, removed`]);
    // The boot reconcile (M5) has nothing to bank: no session, no XP, no streak day.
    const v3 = migratedDoc(JSON.parse(JSON.stringify(state))).state;
    const boot = reconcileOnBoot(v3, undefined, ctxFor(FIXED_NOW));
    expect(boot.result.banked).toBe(false);
    expect(boot.state.sessions).toBe(v3.sessions);
    expect(boot.state.person).toBe(v3.person);
  });

  it('a marker that records 0 reviews is removed, even when every field is valid (the app never saves one)', () => {
    const zero = makeMarker({ counts: { again: 0, hard: 0, good: 0, easy: 0 } });
    expect(zero.total).toBe(0);
    const out = sanitizeV2(v2({ inProgressSession: zero }), FIXED_NOW);
    expect(out.state.inProgressSession).toBeNull();
    expect(out.repaired).toEqual([`inProgressSession: ${JSON.stringify(zero)} records no reviews, removed`]);
  });

  it('a marker whose counts are unreadable but whose total is readable is kept (the reviews happened)', () => {
    const marker = { ...makeMarker(), counts: {}, total: 3 };
    const out = sanitizeV2(v2({ inProgressSession: marker as never }), FIXED_NOW);
    expect(out.state.inProgressSession).toStrictEqual({ ...marker, counts: { again: 0, hard: 0, good: 0, easy: 0 } });
    expect(out.repaired).toEqual([
      'inProgressSession.counts: again missing → 0',
      'inProgressSession.counts: hard missing → 0',
      'inProgressSession.counts: good missing → 0',
      'inProgressSession.counts: easy missing → 0',
    ]);
  });

  it('a studyDay that is not a day key is removed (tally falls back); a real one is kept', () => {
    const bad = sanitizeV2(v2({ inProgressSession: makeMarker({ studyDay: 'yesterday' }) }), FIXED_NOW);
    expect('studyDay' in (bad.state.inProgressSession as object)).toBe(false);
    expect(bad.repaired).toEqual(['inProgressSession: studyDay "yesterday" removed']);
    const good = v2({ inProgressSession: makeMarker({ studyDay: '2026-07-15' }) });
    const kept = sanitizeV2(good, FIXED_NOW);
    expect(kept.repaired).toEqual([]);
    expect(kept.state.inProgressSession).toBe(good.inProgressSession);
  });

  it('migrate(): a fixture whose marker has one bad number keeps the marker', () => {
    const doc = stateFixture('v1-main-1333d48');
    const marker = doc.inProgressSession as Record<string, unknown>;
    doc.inProgressSession = { ...marker, fastAnswers: null };
    const out = migratedDoc(doc);
    expect(out.state.inProgressSession).toStrictEqual({ ...marker, fastAnswers: 0 });
    expect(out.repaired).toEqual(['inProgressSession: fastAnswers null → 0']);
  });

  it('an ease that is not finite uses the document’s own starting ease', () => {
    const deck = makeDeck({ id: 'd1' });
    const state = v2({
      decks: [deck],
      cards: [makeCard({ deckId: 'd1', ease: Number.NaN })],
      settings: { ...makeState().settings, srs: { ...DEFAULT_SRS, startingEase: 2.2 } },
    });
    expect(sanitizeV2(state, FIXED_NOW).state.cards[0].ease).toBe(2.2);
  });
});

/* -------------------------------------------------- mergeDefaultsV2 alone */

describe('mergeDefaultsV2 (the schema-2 defaults, before v2toV3)', () => {
  const bare = { cards: [], decks: [], person: {}, settings: {} } as unknown as DataStateV2;

  it('fills missing lists, the marker and onboarded', () => {
    const s = mergeDefaultsV2(bare, FIXED_NOW);
    expect(s.collections).toEqual([]);
    expect(s.sessions).toEqual([]);
    expect(s.reviewLog).toEqual([]);
    expect(s.inProgressSession).toBeNull();
    expect(s.onboarded).toBe(false);
    const withCards = { ...bare, cards: [makeCard()] } as DataStateV2;
    expect(mergeDefaultsV2(withCards, FIXED_NOW).onboarded).toBe(true);
  });

  it('settings: every v2 default (and no v3 key yet), and a saved NaN (JSON null) is a missing value', () => {
    const s = mergeDefaultsV2(
      { ...bare, settings: { srs: { dailyNewLimit: null, startingEase: 2.1 }, sessionLimit: null, keepMe: 1 } } as never,
      FIXED_NOW,
    );
    expect(s.settings.srs).toStrictEqual({ ...DEFAULT_SRS, startingEase: 2.1 });
    expect(s.settings.sessionLimit).toBe(DEFAULT_APP_SETTINGS_V2.sessionLimit);
    expect(s.settings.autoReadAloud).toBe(false);
    expect(s.settings.reminderEnabled).toBe(false);
    expect((s.settings as unknown as Obj).keepMe).toBe(1);
    expect('knownChecksPerDay' in s.settings).toBe(false);
    // A copy: the shared default steps list must never be handed out.
    expect(s.settings.srs.learningStepsMin).not.toBe(DEFAULT_SRS.learningStepsMin);
  });

  it('person: over the seed person, and dayDone over a zero v2 day of today', () => {
    const s = mergeDefaultsV2({ ...bare, person: { xp: 40, streak: null, dayDone: { reviews: 3 } } } as never, FIXED_NOW);
    const { dayDone: _seedDay, ...seed } = buildSeedState(FIXED_NOW).person;
    expect(s.person).toStrictEqual({
      ...seed,
      xp: 40,
      dayDone: { dayKey: dayKeyOf(FIXED_NOW), reviews: 3, neww: 0 },
    });
  });

  it('lists every STORED value it replaces (each one was damaged)', () => {
    const repaired: string[] = [];
    mergeDefaultsV2(
      {
        ...bare,
        sessions: 'x',
        onboarded: 'yes',
        settings: { sessionLimit: null, hapticsEnabled: 'on', srs: { dailyNewLimit: 'x', learningStepsMin: [1, -10] } },
        person: {
          xp: -5,
          streak: null,
          freezeUsedDays: ['2026-07-01', 3],
          lastStudyDay: 5,
          dayDone: { dayKey: 7, reviews: -1 },
          achievements: { scholar: 1, broken: 'x' },
        },
      } as never,
      FIXED_NOW,
      repaired,
    );
    expect(repaired).toEqual([
      'sessions: "x" → []',
      'onboarded: "yes" → false',
      'settings: hapticsEnabled "on" → true',
      'settings: sessionLimit null → 50',
      'settings.srs: learningStepsMin [1,-10] → [1,10]',
      'settings.srs: dailyNewLimit "x" → 10',
      'person: xp -5 → 0',
      'person: streak null → 0',
      'person: freezeUsedDays ["2026-07-01",3] → ["2026-07-01"]',
      'person: lastStudyDay 5 → ""',
      `person.dayDone: dayKey 7 → "${dayKeyOf(FIXED_NOW)}"`,
      'person.dayDone: reviews -1 → 0',
      'person: achievements {"scholar":1,"broken":"x"} → {"scholar":1}',
    ]);
  });

  it('a key that was only MISSING gets its default without a line (an older build had no such key)', () => {
    const repaired: string[] = [];
    mergeDefaultsV2(bare, FIXED_NOW, repaired);
    expect(repaired).toEqual([]);
  });

  it('settings, person or dayDone that are not objects are listed once each', () => {
    const repaired: string[] = [];
    mergeDefaultsV2({ ...bare, settings: 3, person: { dayDone: 'today' } } as never, FIXED_NOW, repaired);
    expect(repaired).toEqual([
      'settings: 3 is not an object, defaults used',
      'person: dayDone "today" is not an object, defaults used',
    ]);
  });

  it('a studyMode that is not one of the four modes → "flash" (listed)', () => {
    const repaired: string[] = [];
    const s = mergeDefaultsV2({ ...bare, settings: { studyMode: 'article' } } as never, FIXED_NOW, repaired);
    expect(s.settings.studyMode).toBe('flash');
    expect(repaired).toEqual(['settings: studyMode "article" → "flash"']);
  });
});

/* ------------------------------------------------------------ sanitize (v3) */

describe('sanitize (the v3 values, after checkIntegrity)', () => {
  /** A v3 state with one Basic note + card in deck d1, plus overrides of the card, deck and note. */
  function oneCard(card: Obj = {}, deck: Obj = {}, note: Obj = {}): DataState {
    const group = noteWithCards({ deckId: 'd1', note: { id: 'n1', order: 77 }, card: { id: 'c1', reps: 0 } });
    return makeStateV3({
      decks: [{ ...makeDeckV3({ id: 'd1', order: 3 }), ...deck } as never],
      notes: [{ ...group.note, ...note } as never],
      cards: [{ ...group.cards[0], ...card } as never],
    });
  }

  it('an intact state keeps the same lists and lists no repair', () => {
    const s = oneCard();
    const out = sanitize(s, FIXED_NOW);
    expect(out.repaired).toEqual([]);
    expect(out.state).toStrictEqual(s);
    expect(out.state.cards).toBe(s.cards);
    expect(out.state.decks).toBe(s.decks);
    expect(out.state.notes).toBe(s.notes);
  });

  it('the schedule of a v3 card is repaired like a v2 one (a bad number never reaches the SM-2 math)', () => {
    const out = sanitize(oneCard({ ease: null, intervalDays: -1, reps: 2.5, lapses: 'x', stepIndex: 1.5, due: null, fav: 'yes' }), FIXED_NOW);
    expect(out.state.cards[0]).toMatchObject({ ease: 2.5, intervalDays: 0, reps: 2, lapses: 0, stepIndex: 0, due: FIXED_NOW, fav: false });
    expect(out.repaired).toEqual([
      'card "c1": fav "yes" → false',
      'card "c1": ease null → 2.5',
      'card "c1": intervalDays -1 → 0',
      'card "c1": reps 2.5 → 2',
      'card "c1": lapses "x" → 0',
      'card "c1": stepIndex 1.5 → 0',
      `card "c1": due null → ${FIXED_NOW}`,
    ]);
  });

  it('the v3 card keys: newState, newPos (→ the note order), knownAt, knownCheckedAt, flagColor', () => {
    const out = sanitize(oneCard({ newState: 'later', newPos: null, knownAt: 'x', knownCheckedAt: {}, flagColor: 9 }), FIXED_NOW);
    const card = out.state.cards[0];
    expect('newState' in card || 'flagColor' in card).toBe(false);
    expect(card).toMatchObject({ newPos: 77, knownAt: null, knownCheckedAt: null });
    expect(out.repaired).toEqual([
      'card "c1": newState "later" removed',
      'card "c1": newPos null → 77',
      'card "c1": knownAt "x" → null',
      'card "c1": knownCheckedAt {} → null',
      'card "c1": flagColor 9 removed',
    ]);
    // Valid values are kept as they are.
    const fine = oneCard({ newState: 'notStarted', knownAt: 5, knownCheckedAt: null, flagColor: 3 });
    expect(sanitize(fine, FIXED_NOW).repaired).toEqual([]);
  });

  it('deck values: name, icon, active, order (→ after the last deck), source, optional keys and options', () => {
    const out = sanitize(
      oneCard(
        {},
        {
          name: 5,
          icon: null,
          active: 'no',
          createdAt: 'x',
          order: null,
          source: 'cloud',
          builtin: 'yes',
          language: 4,
          options: { newPerDay: -2, newOrder: 'shuffle', newArrival: 'soon', knownChecks: 'x' },
        },
      ),
      FIXED_NOW,
    );
    expect(out.state.decks[0]).toMatchObject({ name: '5', icon: '🗂️', active: true, createdAt: FIXED_NOW, order: 0, source: 'manual' });
    expect('builtin' in out.state.decks[0] || 'language' in out.state.decks[0]).toBe(false);
    expect(out.state.decks[0].options).toEqual({ newPerDay: null, newOrder: 'source', newArrival: 'queued', knownChecks: true });
    expect(out.repaired).toEqual([
      'deck "d1": name 5 → "5"',
      'deck "d1": icon null → "🗂️"',
      'deck "d1": active "no" → true',
      `deck "d1": createdAt "x" → ${FIXED_NOW}`,
      'deck "d1": order null → 0',
      'deck "d1": source "cloud" → "manual"',
      'deck "d1": builtin "yes" removed',
      'deck "d1": language 4 removed',
      'deck "d1".options: newPerDay -2 → null',
      'deck "d1".options: newOrder "shuffle" → "source"',
      'deck "d1".options: newArrival "soon" → "queued"',
      'deck "d1".options: knownChecks "x" → true',
    ]);
  });

  it('deck options: a key that is only MISSING gets its default without a line ("We fixed {n} items" counts real repairs only)', () => {
    const empty = sanitize(oneCard({}, { options: {} }), FIXED_NOW);
    expect(empty.state.decks[0].options).toEqual({ newPerDay: null, newOrder: 'source', newArrival: 'queued', knownChecks: true });
    expect(empty.repaired).toEqual([]);
    // One damaged value and three missing keys: only the damaged value is listed.
    const one = sanitize(oneCard({}, { options: { newPerDay: -2, directions: { 'nt-basic': [0] } } }), FIXED_NOW);
    expect(one.state.decks[0].options).toEqual({
      newPerDay: null,
      newOrder: 'source',
      newArrival: 'queued',
      knownChecks: true,
      directions: { 'nt-basic': [0] },
    });
    expect(one.repaired).toEqual(['deck "d1".options: newPerDay -2 → null']);
    // The whole chain: a stored v3 deck with `options: {}` adds no repair line.
    const stored = (deck: Obj) => JSON.parse(JSON.stringify(oneCard({}, deck))) as Obj;
    expect(migratedDoc(stored({ options: {} })).repaired).toEqual(migratedDoc(stored({})).repaired);
  });

  it('a deck with a broken order goes after the last deck with a real one', () => {
    const s = oneCard();
    const decks = [...s.decks, { ...makeDeckV3({ id: 'd2' }), order: Number.NaN }, makeDeckV3({ id: 'd3', order: 8 })];
    const out = sanitize({ ...s, decks }, FIXED_NOW);
    expect(out.state.decks.map((d) => [d.id, d.order])).toEqual([
      ['d1', 3],
      ['d2', 9],
      ['d3', 8],
    ]);
  });

  it('note values: times, order and source', () => {
    const out = sanitize(oneCard({}, {}, { createdAt: null, updatedAt: 'x', order: 'first', source: 'apkg' }), FIXED_NOW);
    expect(out.state.notes[0]).toMatchObject({ createdAt: FIXED_NOW, updatedAt: FIXED_NOW, order: FIXED_NOW, source: { kind: 'manual' } });
    expect(out.repaired).toEqual([
      `note "n1": createdAt null → ${FIXED_NOW}`,
      `note "n1": updatedAt "x" → ${FIXED_NOW}`,
      `note "n1": order "first" → ${FIXED_NOW}`,
      'note "n1": source "apkg" → {"kind":"manual"}',
    ]);
  });

  it('the in-flight marker is repaired with the same rules (and "practice" is a v3 kind)', () => {
    const practice = sanitize({ ...oneCard(), inProgressSession: makeMarker({ kind: 'practice' as never }) as never }, FIXED_NOW);
    expect(practice.repaired).toEqual([]);
    const broken = sanitize({ ...oneCard(), inProgressSession: { ...makeMarker(), bestRun: -1 } as never }, FIXED_NOW);
    expect(broken.repaired).toEqual(['inProgressSession: bestRun -1 → 0']);
  });
});

/* ------------------------------------------------------- mergeDefaults (v3) */

describe('mergeDefaults (the v3 defaults)', () => {
  const bare = { cards: [], decks: [], person: {}, settings: {} } as unknown as DataState;

  it('fills every v3 list, listPrefs, pack, the marker and onboarded — without a line', () => {
    const repaired: string[] = [];
    const s = mergeDefaults(bare, FIXED_NOW, repaired);
    expect(repaired).toEqual([]);
    expect(s).toMatchObject({
      noteTypes: [],
      notes: [],
      lists: [],
      listPrefs: {},
      manualLog: [],
      collections: [],
      sessions: [],
      reviewLog: [],
      pack: null,
      inProgressSession: null,
      onboarded: false,
    });
    expect(s.settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(s.person.dayDone).toEqual(emptyDayDone(dayKeyOf(FIXED_NOW)));
  });

  it('the v3 settings: lastAutoBackupAt null is a real value; a broken knownChecksPerDay is repaired', () => {
    const repaired: string[] = [];
    const s = mergeDefaults(
      { ...bare, settings: { lastAutoBackupAt: null, knownChecksPerDay: 2.5, spaceSiblings: 'no', autoBackup: false } } as never,
      FIXED_NOW,
      repaired,
    );
    expect(s.settings).toMatchObject({ lastAutoBackupAt: null, knownChecksPerDay: 5, spaceSiblings: true, autoBackup: false });
    expect(repaired).toEqual(['settings: spaceSiblings "no" → true', 'settings: knownChecksPerDay 2.5 → 5']);
    const time = mergeDefaults({ ...bare, settings: { lastAutoBackupAt: 'x' } } as never, FIXED_NOW, []);
    expect(time.settings.lastAutoBackupAt).toBeNull();
  });

  it('the v3 day tally: checks and newByDeck are repaired; every deck id stays a key ("__proto__" too)', () => {
    const repaired: string[] = [];
    const byDeck = JSON.parse('{"d1": 2, "__proto__": 1, "d2": "x"}') as Obj;
    const s = mergeDefaults(
      { ...bare, person: { dayDone: { dayKey: '2026-06-10', reviews: 1, neww: 3, checks: -1, newByDeck: byDeck } } } as never,
      FIXED_NOW,
      repaired,
    );
    expect(s.person.dayDone.checks).toBe(0);
    expect(Object.keys(s.person.dayDone.newByDeck)).toEqual(['d1', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(s.person.dayDone.newByDeck, '__proto__')?.value).toBe(1);
    expect(repaired).toEqual(['person.dayDone: checks -1 → 0', 'person.dayDone: newByDeck {"d1":2,"__proto__":1,"d2":"x"} → {"d1":2,"__proto__":1}']);
  });

  it('listPrefs and pack: damaged entries are repaired or reset, each listed', () => {
    const repaired: string[] = [];
    const s = mergeDefaults(
      {
        ...bare,
        listPrefs: { 'builtin:hard': { pinned: 'yes', hidden: false, order: 1 }, 'builtin:x': 4, mine: { pinned: true, hidden: true, order: 2 } },
        pack: { id: 7 },
      } as never,
      FIXED_NOW,
      repaired,
    );
    expect(s.listPrefs).toEqual({ 'builtin:hard': { pinned: false, hidden: false, order: 1 }, mine: { pinned: true, hidden: true, order: 2 } });
    expect(s.pack).toBeNull();
    expect(repaired).toEqual([
      'listPrefs."builtin:hard": pinned "yes" → false',
      'listPrefs: "builtin:x" 4 is not a list preference, removed',
      'pack: {"id":7} → null',
    ]);
    const intact = { ...bare, listPrefs: { a: { pinned: true, hidden: false, order: 0 } }, pack: { id: 'german', installed: { vocabulary: 'd1' } } };
    const kept = mergeDefaults(intact as never, FIXED_NOW, []);
    expect(kept.listPrefs).toBe(intact.listPrefs);
    expect(kept.pack).toBe(intact.pack);
  });

  it('a list that is not a list is listed and read as empty', () => {
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, manualLog: 'x', lists: {} } as never, FIXED_NOW, repaired);
    expect(s.manualLog).toEqual([]);
    expect(s.lists).toEqual([]);
    expect(repaired).toEqual(['lists: {} → []', 'manualLog: "x" → []']);
  });

  it('saved lists: an entry that is not an object is removed; a damaged key of a list is repaired, each listed', () => {
    const repaired: string[] = [];
    const good = { id: 'l1', name: 'B1 verbs', icon: '🔖', query: { tags: ['verb'] }, sort: { by: 'az' }, createdAt: 5, updatedAt: 6 };
    const damaged = [null, good, { id: 7, name: 3, icon: null, query: 'verbs', sort: { by: 'size' }, createdAt: 'x' }, 'B2'];
    const s = mergeDefaults({ ...bare, lists: damaged } as never, FIXED_NOW, repaired);
    expect(s.lists[0]).toBe(good);
    expect(s.lists).toEqual([
      good,
      { id: 'list-repaired-2', name: '3', icon: '🔖', query: {}, createdAt: FIXED_NOW, updatedAt: FIXED_NOW },
    ]);
    expect(repaired).toEqual([
      'list #0: null is not a saved list, removed',
      'list #2: id 7 → "list-repaired-2"',
      'list #2: name 3 → "3"',
      'list #2: icon null → "🔖"',
      'list #2: query "verbs" → {}',
      'list #2: sort {"by":"size"} removed',
      `list #2: createdAt "x" → ${FIXED_NOW}`,
      `list #2: updatedAt missing → ${FIXED_NOW}`,
      'list #3: "B2" is not a saved list, removed',
    ]);
    // listsById (the MatchCtx of every filter) reads list.id of every entry: it works again.
    expect([...listsById(s.lists).keys()]).toContain('list-repaired-2');
  });

  /** A readable manual edit: one card entry (favorite on). */
  const flagEdit = (id: string, cardId = 'c1'): ManualEdit => ({
    id,
    at: 5,
    kind: 'flags',
    label: '1 card favorited',
    cards: [{ id: cardId, before: { fav: false }, after: { fav: true } }],
  });

  it('the manual-edit log: an edit that undo cannot read is removed (pushManualEdit threw before)', () => {
    const valid = flagEdit('edit-1');
    const damaged = [null, {}, valid];
    expect(() => pushManualEdit(damaged as never, flagEdit('edit-2'))).toThrow(TypeError);
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, manualLog: damaged } as never, FIXED_NOW, repaired);
    expect(s.manualLog).toEqual([valid]);
    expect(s.manualLog[0]).toBe(valid);
    expect(repaired).toEqual([
      'manualLog #0: null is not an edit, removed',
      'manualLog #1: an edit with no usable id (missing), removed',
    ]);
    // The next manual edit is recorded again.
    const next = flagEdit('edit-2');
    expect(pushManualEdit(s.manualLog, next)).toEqual({ log: [valid, next], stored: true });
    // Again: nothing more to repair.
    const again: string[] = [];
    expect(mergeDefaults(s, FIXED_NOW, again).manualLog).toBe(s.manualLog);
    expect(again).toEqual([]);
  });

  it('the manual-edit log: unreadable entries inside an edit are removed, the rest of the edit is kept', () => {
    const c1 = { id: 'c1', before: { fav: false }, after: { fav: true } };
    const n1 = { id: 'n1', before: { tags: ['a'] }, after: { tags: ['a', 'b'], section: 'S' } };
    const log = [
      { ...flagEdit('e1'), cards: [c1, null, { id: 'c2', before: 3, after: {} }, { before: {}, after: {} }] },
      {
        id: 'e2',
        at: 2,
        kind: 'tags',
        label: '1 card tagged',
        cards: [],
        notes: [n1, { id: 'n2', before: { tags: 'a' }, after: { tags: [] } }, { id: 'n3', before: { tags: [] }, after: { tags: [], section: 4 } }],
      },
      { ...flagEdit('e3'), cards: 7 },
      { ...flagEdit('e4'), notes: 'n1' },
    ];
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, manualLog: log } as never, FIXED_NOW, repaired);
    expect(s.manualLog).toEqual([{ ...log[0], cards: [c1] }, { ...log[1], notes: [n1] }, flagEdit('e4')]);
    expect(repaired).toEqual([
      'manualLog "e1": 3 of its 4 card entries could not be read, removed',
      'manualLog "e2": 2 of its 3 note entries could not be read, removed',
      'manualLog "e3": cards 7 is not a list, the edit is removed',
      'manualLog "e4": notes "n1" removed',
    ]);
  });

  it('the manual-edit log: more than 50 edits → the oldest leave first (the caps of pushManualEdit); an intact log keeps its identity', () => {
    const many = Array.from({ length: MANUAL_LOG_MAX_EDITS + 2 }, (_, i) => flagEdit(`e${i}`));
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, manualLog: many } as never, FIXED_NOW, repaired);
    expect(s.manualLog).toHaveLength(MANUAL_LOG_MAX_EDITS);
    expect(s.manualLog[0]).toBe(many[2]);
    expect(repaired).toEqual(['manualLog: the 2 oldest edits removed (the log keeps at most 50 edits and 20,000 snapshots)']);
    const intact = many.slice(0, MANUAL_LOG_MAX_EDITS);
    const kept: string[] = [];
    expect(mergeDefaults({ ...bare, manualLog: intact } as never, FIXED_NOW, kept).manualLog).toBe(intact);
    expect(kept).toEqual([]);
  });

  /** A readable review-log entry of card c1 (a review rated Good). */
  const rating = (seq: number, over: Obj = {}): Obj => ({
    id: `r${seq}`,
    seq,
    cardId: 'c1',
    deckId: 'd1',
    rating: 'good',
    atMs: FIXED_NOW - 1000 + seq,
    bucket: 'review',
    prev: { ease: 2.5, intervalDays: 3, stepIndex: null, reps: 4, lapses: 0, due: FIXED_NOW - HOUR, lastReviewedAt: null, knownAt: null, knownCheckedAt: null, newState: undefined },
    ...over,
  });

  // Adapted in W4-7: a rating whose prev is not an object was REMOVED, and
  // so it lost its history row on the first copy and on a Restore. Its prev
  // is now rebuilt (spec §3.1 rule 4 "Repair, never drop").
  it('the review log: a rating with no bucket, deck, seq or prev is repaired; one with no card or not a rating is removed — each listed', () => {
    const cards = [{ id: 'c1', deckId: 'd1' }];
    const log = [
      rating(1),
      null,
      rating(2, { bucket: undefined, deckId: undefined, seq: 1.5 }), // the finding's case: no bucket
      rating(3, { cardId: '' }),
      rating(4, { prev: null }),
      rating(5, { bucket: 'later', prev: { ...(rating(5).prev as Obj), reps: 0 } }),
      rating(6, { seq: 1 }), // a seq an earlier rating already has
    ];
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, cards, reviewLog: log } as never, FIXED_NOW, repaired);
    expect(s.reviewLog.map((e) => [e.id, e.seq, e.bucket, e.deckId])).toEqual([
      ['r1', 1, 'review', 'd1'],
      ['r2', 6, 'review', 'd1'],
      ['r4', 4, 'review', 'd1'],
      ['r5', 5, 'new', 'd1'],
      ['r6', 7, 'review', 'd1'],
    ]);
    expect(s.reviewLog[0]).toBe(log[0]); // an intact entry keeps its identity
    expect(repaired).toEqual([
      'reviewLog #1: null is not a rating, removed',
      'reviewLog #2: bucket missing → "review"',
      'reviewLog #2: deckId missing → "d1"',
      'reviewLog #2: seq 1.5 → 6',
      'reviewLog #3: a rating with no usable card id (""), removed',
      'reviewLog #4: prev null is not the card before the rating → rebuilt from the card as it is now',
      'reviewLog #5: bucket "later" → "new"',
      'reviewLog #6: seq 1 → 7',
    ]);
    // The rebuilt prev holds every key undo needs (the card has no schedule here, so the safe defaults).
    expect(s.reviewLog[2].prev).toEqual({
      ease: 2.5,
      intervalDays: 0,
      reps: 0,
      lapses: 0,
      due: FIXED_NOW - 1000 + 4, // the time of the rating
      stepIndex: null,
      lastReviewedAt: null,
    });
    // Again: nothing more to repair, and the log keeps its identity.
    const again: string[] = [];
    expect(mergeDefaults(s, FIXED_NOW, again).reviewLog).toBe(s.reviewLog);
    expect(again).toEqual([]);
    // A deck id for a card that is gone → ''.
    const gone = mergeDefaults({ ...bare, reviewLog: [rating(1, { cardId: 'gone', deckId: 7 })] } as never, FIXED_NOW, []);
    expect(gone.reviewLog[0].deckId).toBe('');
    // A rating of a KNOWN card (prev.knownAt is a number) is a Check: the
    // reducer's bucket (reviewBucket), also when the card was never studied.
    const knownPrev = { ...(rating(1).prev as Obj), knownAt: FIXED_NOW - 24 * HOUR };
    const checks: string[] = [];
    const known = mergeDefaults(
      {
        ...bare,
        cards,
        reviewLog: [
          rating(1, { bucket: undefined, prev: { ...knownPrev, reps: 5 } }),
          rating(2, { bucket: 'later', prev: { ...knownPrev, reps: 0 } }),
        ],
      } as never,
      FIXED_NOW,
      checks,
    );
    expect(known.reviewLog.map((e) => e.bucket)).toEqual(['check', 'check']);
    expect(checks).toEqual(['reviewLog #0: bucket missing → "check"', 'reviewLog #1: bucket "later" → "check"']);
  });

  it('the review log: after the repair, "undo" of the damaged rating keeps a real day tally (it wrote undefined before)', () => {
    const group = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'c1', reps: 5, intervalDays: 4 } });
    const doc = JSON.parse(
      JSON.stringify(
        makeStateV3({
          decks: [makeDeckV3({ id: 'd1', order: 0 })],
          notes: [group.note],
          cards: group.cards,
          reviewLog: [rating(1, { bucket: undefined })] as never,
        }),
      ),
    ) as Obj;
    const out = migratedDoc(doc);
    expect(out.repaired).toContain('reviewLog #0: bucket missing → "review"');
    const undone = undoLastReview(out.state, undefined, { now: FIXED_NOW, newId: (p) => `${p}-1` });
    expect(undone.result).toBe(true);
    expect(undone.state.person.dayDone).toMatchObject({ dayKey: dayKeyOf(FIXED_NOW), reviews: 0, neww: 0, checks: 0 });
    expect(undone.state.reviewLog).toEqual([]);
  });

  it('the review log: undo of a repaired Check (no bucket, prev.knownAt a number) takes it back from the checks counter', () => {
    const knownAt = FIXED_NOW - 24 * HOUR;
    const group = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'c1', reps: 5, intervalDays: 30, knownAt, knownCheckedAt: FIXED_NOW } });
    const doc = JSON.parse(
      JSON.stringify(
        makeStateV3({
          decks: [makeDeckV3({ id: 'd1', order: 0 })],
          notes: [group.note],
          cards: group.cards,
          reviewLog: [rating(1, { bucket: undefined, prev: { ...(rating(1).prev as Obj), reps: 5, intervalDays: 30, knownAt } })] as never,
        }),
      ),
    ) as Obj;
    // Today the Check was counted, and one review of another card too.
    const person = doc.person as Obj;
    person.dayDone = { ...(person.dayDone as Obj), dayKey: dayKeyOf(FIXED_NOW), reviews: 1, neww: 0, checks: 1 };
    const out = migratedDoc(doc);
    expect(out.repaired).toContain('reviewLog #0: bucket missing → "check"');
    const undone = undoLastReview(out.state, undefined, { now: FIXED_NOW, newId: (p) => `${p}-1` });
    expect(undone.result).toBe(true);
    // The Check leaves the Known-check budget; the other review stays counted.
    expect(undone.state.person.dayDone).toMatchObject({ dayKey: dayKeyOf(FIXED_NOW), reviews: 1, neww: 0, checks: 0 });
    expect(undone.state.cards[0]).toMatchObject({ id: 'c1', knownAt });
  });

  // Adapted in W4-7: these ratings were REMOVED, and so they lost their
  // history rows on the first copy from the old storage and on a Restore
  // (the row store writes those rows from the review log). Now each broken
  // value of `prev` is repaired, with one line each (spec §3.1 rule 4).
  it('the review log: a prev value undo cannot put back is REPAIRED (never the rating removed), with one line each', () => {
    // The card has no schedule of its own here, so every repair is a safe default.
    const cards = [{ id: 'c1', deckId: 'd1' }];
    const known = { ...(rating(1).prev as Obj), knownAt: FIXED_NOW - 24 * HOUR, knownCheckedAt: null };
    const at = (seq: number) => FIXED_NOW - 1000 + seq; // the rating's atMs
    const log = [
      rating(1, { bucket: 'check', prev: known }), // intact: a Check of a Known card
      rating(2, { bucket: 'check', prev: {} }), // undo would take the card out of Known
      rating(3, { prev: { ...known, ease: null } }), // a NaN, saved as null: undo would write ease = null
      rating(4, { prev: { ...known, stepIndex: 1.5 } }),
      rating(5, { prev: { ...known, lastReviewedAt: 'x' } }),
      rating(6, { prev: { ...known, knownCheckedAt: 'yes' } }),
      rating(7, { prev: { ...known, newState: 'later' } }),
      rating(8, { bucket: 'check', prev: { ...known, knownAt: null } }), // a Check: the card WAS Known
      rating(9, { prev: { ...(rating(9).prev as Obj), stepIndex: 0, lastReviewedAt: FIXED_NOW - HOUR, newState: 'queued' } }), // intact
    ];
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, cards, reviewLog: log } as never, FIXED_NOW, repaired);
    expect(s.reviewLog.map((e) => e.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(s.reviewLog[0]).toBe(log[0]); // intact entries keep their identity
    expect(s.reviewLog[8]).toBe(log[8]);
    expect(repaired).toEqual([
      'reviewLog #1: prev.ease missing → 2.5',
      'reviewLog #1: prev.intervalDays missing → 0',
      'reviewLog #1: prev.reps missing → 0',
      'reviewLog #1: prev.lapses missing → 0',
      `reviewLog #1: prev.due missing → ${at(2)}`,
      'reviewLog #1: prev.stepIndex missing → null',
      'reviewLog #1: prev.lastReviewedAt missing → null',
      `reviewLog #1: prev.knownAt missing → ${at(2)}`,
      'reviewLog #2: prev.ease null → 2.5',
      'reviewLog #3: prev.stepIndex 1.5 → 0',
      'reviewLog #4: prev.lastReviewedAt "x" → null',
      'reviewLog #5: prev.knownCheckedAt "yes" removed',
      'reviewLog #6: prev.newState "later" removed',
      `reviewLog #7: prev.knownAt null → ${at(8)}`,
    ]);
    // Every other key of a repaired prev stays as it was.
    expect(s.reviewLog[2].prev).toEqual({ ...known, ease: 2.5 });
    expect(s.reviewLog[5].prev).not.toHaveProperty('knownCheckedAt');
    // Again: nothing more to repair.
    const again: string[] = [];
    expect(mergeDefaults(s, FIXED_NOW, again).reviewLog).toBe(s.reviewLog);
    expect(again).toEqual([]);
  });

  it("the review log: a broken prev value takes the CARD's value, so the undo leaves that key as it is", () => {
    const card = {
      id: 'c1',
      deckId: 'd1',
      ease: 2.1,
      intervalDays: 12,
      reps: 6,
      lapses: 1,
      due: FIXED_NOW + 12 * DAY,
      stepIndex: null,
      lastReviewedAt: FIXED_NOW - 1000,
      knownCheckedAt: null,
      newState: 'queued',
    };
    const broken = { ease: null, intervalDays: 'x', reps: null, lapses: null, due: null, stepIndex: 1.5, lastReviewedAt: 'x', knownCheckedAt: 'yes', newState: 'later' };
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, cards: [card], reviewLog: [rating(1, { prev: broken })] } as never, FIXED_NOW, repaired);
    expect(s.reviewLog[0].prev).toEqual({
      ease: 2.1,
      intervalDays: 12,
      reps: 6,
      lapses: 1,
      due: FIXED_NOW + 12 * DAY,
      stepIndex: null,
      lastReviewedAt: FIXED_NOW - 1000,
      knownCheckedAt: null,
      newState: 'queued',
    });
    expect(repaired).toEqual([
      'reviewLog #0: prev.ease null → 2.1',
      'reviewLog #0: prev.intervalDays "x" → 12',
      'reviewLog #0: prev.reps null → 6',
      'reviewLog #0: prev.lapses null → 1',
      `reviewLog #0: prev.due null → ${FIXED_NOW + 12 * DAY}`,
      'reviewLog #0: prev.stepIndex 1.5 → null',
      `reviewLog #0: prev.lastReviewedAt "x" → ${FIXED_NOW - 1000}`,
      'reviewLog #0: prev.knownCheckedAt "yes" → null',
      'reviewLog #0: prev.newState "later" → "queued"',
    ]);
  });

  it('the review log: a Check with prev {} on a Known card is repaired from the card — undo keeps it Known with its schedule, and gives the check back', () => {
    const knownAt = FIXED_NOW - 24 * HOUR;
    const group = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'c1', reps: 5, intervalDays: 30, knownAt, knownCheckedAt: FIXED_NOW - HOUR } });
    const doc = JSON.parse(
      JSON.stringify(
        makeStateV3({
          decks: [makeDeckV3({ id: 'd1', order: 0 })],
          notes: [group.note],
          cards: group.cards,
          reviewLog: [rating(1, { bucket: 'check', prev: {} })] as never,
        }),
      ),
    ) as Obj;
    const person = doc.person as Obj;
    person.dayDone = { ...(person.dayDone as Obj), dayKey: dayKeyOf(FIXED_NOW), reviews: 0, neww: 0, checks: 1 };
    const out = migratedDoc(doc);
    expect(out.repaired).toContain('reviewLog #0: prev.ease missing → 2.5');
    expect(out.repaired).toContain(`reviewLog #0: prev.knownAt missing → ${knownAt}`); // the card's own time
    expect(out.state.reviewLog).toHaveLength(1); // the rating stays (its history row too)
    const before = out.state.cards[0];
    const undone = undoLastReview(out.state, undefined, { now: FIXED_NOW, newId: (p) => `${p}-1` });
    expect(undone.result).toBe(true);
    // Still Known, and the schedule is the card's own: undo changed nothing it could not know.
    expect(undone.state.cards[0]).toMatchObject({
      id: 'c1',
      knownAt,
      ease: before.ease,
      intervalDays: 30,
      reps: 5,
      lapses: before.lapses,
      due: before.due,
    });
    expect(undone.state.person.dayDone).toMatchObject({ checks: 0 });
    expect(undone.state.reviewLog).toEqual([]);
  });

  it('saved lists: an intact list of lists keeps its identity (every sort and an absent sort are fine)', () => {
    const lists = (['source', 'due', 'az', 'newest', 'hardest', 'field', undefined] as const).map((by, i) => ({
      id: `l${i}`,
      name: `List ${i}`,
      icon: '⭐',
      query: {},
      ...(by ? { sort: { by, ...(by === 'field' ? { field: 'level' } : {}) } } : {}),
      createdAt: 1,
      updatedAt: 2,
    }));
    const repaired: string[] = [];
    const s = mergeDefaults({ ...bare, lists } as never, FIXED_NOW, repaired);
    expect(repaired).toEqual([]);
    expect(s.lists).toBe(lists);
  });
});

/* ------------------------------------- a damaged v3 document, through migrate */

describe('migrate — a damaged v3 document is repaired before any screen reads it', () => {
  /** A v3 document (as stored) with one note n1 of card type `type`, its card for ord 0, and `extra` keys. */
  function v3Doc(type: Obj, extra: Obj = {}): Obj {
    const group = noteWithCards({ deckId: 'd1', typeId: 'nt-basic', note: { id: 'n1' }, card: { id: 'c1' }, ords: [0] });
    const state = makeStateV3({
      noteTypes: [type as never],
      decks: [makeDeckV3({ id: 'd1', order: 0 })],
      notes: [{ ...group.note, typeId: type.id as string }],
      cards: group.cards,
      ...extra,
    });
    return JSON.parse(JSON.stringify(state)) as Obj;
  }

  /** renderFace on every card of a migrated state (it must not throw); the question line of each. */
  function questions(state: DataState): string[] {
    return state.cards.map((c) => {
      const n = noteOf(state, c);
      return renderFace(n, state.noteTypes.find((t) => t.id === n.typeId)!, c.ord).promptPlain;
    });
  }

  const basic = builtinType('basic', FIXED_NOW);

  it('a card type whose templates are [null] gets a working template (renderFace threw before)', () => {
    const out = migratedDoc(v3Doc({ ...basic, id: 'nt-x', templates: [null] }));
    expect(out.repaired).toEqual([
      'card type "nt-x": template #0 null is not a template, removed',
      'card type "nt-x": no usable template, 1 template made for the directions its cards use',
    ]);
    expect(out.state.noteTypes[0].templates).toEqual([{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2, 3] }]);
    expect(questions(out.state)).toEqual(['front n1']);
    expect(migratedDoc(out.state).repaired).toEqual([]);
  });

  it('a template whose prompt and answer are not lists gets working sides (renderFace threw before)', () => {
    const out = migratedDoc(v3Doc({ ...basic, id: 'nt-x', templates: [{ ord: 0, name: 'A', prompt: 'x', answer: 5 }] }));
    expect(out.repaired).toEqual([
      'card type "nt-x", direction 0: prompt "x" → [0]',
      'card type "nt-x", direction 0: answer 5 → [1,2,3]',
    ]);
    expect(questions(out.state)).toEqual(['front n1']);
  });

  it('a damaged imported card type keeps its fields and its Level filter group; the index, the filter groups and renderFace work', () => {
    const front: FieldDef = { name: 'Front', role: 'term', facet: 'off', lang: 'de-DE' };
    const back: FieldDef = { name: 'Back', role: 'meaning', facet: 'off', lang: 'en-US' };
    const level: FieldDef = { name: 'Level', role: 'badge', facet: 'on' };
    const anki: NoteType = {
      id: 'nt-anki-1',
      name: 'German vocabulary',
      kind: 'standard',
      fields: [front, back, level],
      templates: [{ ord: 0, name: 'DE-EN', prompt: [0], answer: [1, 2] }],
      sortField: 0,
      source: { ankiMid: '1' },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    // Three notes of the imported type and three Basic notes: the same count,
    // so the "card type" filter group compares the two type NAMES.
    const groups = [
      ...['A1', 'B1', 'A2'].map((lv, i) =>
        noteWithCards({ deckId: 'd1', typeId: anki.id, fields: [`Wort ${i}`, `word ${i}`, lv], note: { id: `a${i}` }, card: { id: `ca${i}` } }, [anki]),
      ),
      ...[0, 1, 2].map((i) => noteWithCards({ deckId: 'd1', note: { id: `b${i}` }, card: { id: `cb${i}` } })),
    ];
    // One bad value in each part: the name, a field language, a whole field, a field label, the templates.
    const damaged = { ...anki, name: 5, fields: [{ ...front, lang: 5 }, null, { ...level, label: 5 }], templates: null };
    const doc = JSON.parse(
      JSON.stringify(
        makeStateV3({
          noteTypes: [damaged as never, basic],
          decks: [makeDeckV3({ id: 'd1', order: 0 })],
          notes: groups.map((g) => g.note),
          cards: groups.flatMap((g) => g.cards),
        }),
      ),
    ) as Obj;
    // Before: the library index (every filter and search) throws on the stored document.
    expect(() => buildLibraryIndex(doc.notes as never, doc.noteTypes as never)).toThrow(TypeError);

    const out = migratedDoc(doc);
    expect(out.repaired).toEqual([
      'card type "nt-anki-1": name 5 → "5"',
      'card type "nt-anki-1", field "Front": lang 5 removed',
      'card type "nt-anki-1", field #1: null is not a field → {"name":"Field 2","role":"detail","facet":"auto"}',
      'card type "nt-anki-1", field "Level": label 5 removed',
      'card type "nt-anki-1": templates null → []',
      'card type "nt-anki-1": no usable template, 1 template made for the directions its cards use',
    ]);
    // The type is repaired in place, not replaced by a "Recovered" one: Level keeps its name, role and filter rule.
    expect(out.state.noteTypes[0]).toEqual({
      ...anki,
      name: '5',
      fields: [{ name: 'Front', role: 'term', facet: 'off' }, { name: 'Field 2', role: 'detail', facet: 'auto' }, level],
      templates: [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2] }],
    });
    const facets = deriveFacets(out.state.cards, {}, {}, matchCtx(out.state, FIXED_NOW));
    expect(facets.map((f) => f.key)).toEqual(expect.arrayContaining(['field:level', 'noteType']));
    const levels = facets.find((f) => f.key === 'field:level')!.values.map((v) => v.label);
    expect([...levels].sort()).toEqual(['A1', 'A2', 'B1']);
    expect(questions(out.state)).toEqual(['Wort 0', 'Wort 1', 'Wort 2', 'front b0', 'front b1', 'front b2']);
    expect(stateProblemsV3(out.state)).toEqual([]);
    expect(migratedDoc(out.state).repaired).toEqual([]);
  });

  it('a manual-edit log with edits undo cannot read is repaired (every triage, flag and undo command threw before)', () => {
    const base = v3Doc({ ...basic }) as unknown as DataState;
    const known = markKnown(base, { cardIds: ['c1'] }, ctxFor(FIXED_NOW));
    const editId = known.result.edit.id;
    const doc = JSON.parse(JSON.stringify({ ...known.state, manualLog: [null, {}, ...known.state.manualLog] })) as Obj;
    expect(() => setFlags(doc as never, { cardIds: ['c1'], patch: { fav: true } }, ctxFor(FIXED_NOW))).toThrow(TypeError);

    const out = migratedDoc(doc);
    expect(out.repaired).toEqual([
      'manualLog #0: null is not an edit, removed',
      'manualLog #1: an edit with no usable id (missing), removed',
    ]);
    expect(out.state.manualLog.map((e) => e.id)).toEqual([editId]);
    expect(stateProblemsV3(out.state)).toEqual([]);
    // A new manual edit is recorded, and the old one is still undoable.
    const flagged = setFlags(out.state, { cardIds: ['c1'], patch: { fav: true } }, ctxFor(FIXED_NOW));
    expect(flagged.result.undoable).toBe(true);
    const undone = undoManualEdit(flagged.state, { editId }, ctxFor(FIXED_NOW));
    expect(undone.result).toEqual({ found: true, reverted: 1, skipped: 0 });
    expect(undone.state.cards[0].knownAt).toBeNull();
    expect(migratedDoc(out.state).repaired).toEqual([]);
  });

  it('saved lists that are not objects, or have no usable id, are repaired (listsById threw before)', () => {
    const doc = v3Doc({ ...basic }, { lists: [null, { name: 'Verbs', icon: '🔖', query: { tags: ['verb'] }, createdAt: 1, updatedAt: 1 }] });
    expect(() => listsById(doc.lists as never)).toThrow(TypeError);
    const out = migratedDoc(doc);
    expect(out.repaired).toEqual([
      'list #0: null is not a saved list, removed',
      'list #1: id missing → "list-repaired-1"',
    ]);
    expect(out.state.lists.map((l) => [l.id, l.name])).toEqual([['list-repaired-1', 'Verbs']]);
    // The card has no tag 'verb', so it does not match: the list's own query was kept (not replaced by "every card").
    const matches = out.state.cards.filter(compileQuery({ list: 'list-repaired-1' }, matchCtx(out.state, FIXED_NOW)));
    expect(matches).toEqual([]);
    expect(migratedDoc(out.state).repaired).toEqual([]);
  });
});
