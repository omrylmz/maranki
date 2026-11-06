/**
 * The German build variant and content pack (spec §9.4, §9.5, unit W5-1).
 *
 * Pinned here:
 *   - the pack itself (the ContentPack interface): id 'german'; the three
 *     starter decks with unique, stable keys and the exact titles and
 *     subtitles; deck defaults; the 12 level names; the onboarding copy;
 *   - the deck files: they are private, so this public repo holds none (the
 *     build reads them from assets/packs/german/ on the author's computer,
 *     RELEASING.md "The German decks"); the subtitles' numbers are the real
 *     note counts, which the fixtures keep in `about.totals`;
 *   - the card-type presets match the REAL card-type and field names of the
 *     fixtures (src/domain/__fixtures__/anki/german_*.json), every one of
 *     them, and the Grammar Question is read in ENGLISH (en-US);
 *   - end to end on the fixtures (the starter-deck loader's pure planner):
 *     the presets and deck defaults land on the new card types and decks,
 *     both directions are made, and "Where do you start?" by value marks the
 *     easier levels Known while every other new card starts Not started;
 *   - the build: app.config.ts (both variants, unknown names stop the build,
 *     app.json is the static base); Metro maps `@variant/pack` to this file
 *     for APP_VARIANT=german; only this file requires the German decks; the
 *     scripts and the release matrix;
 *   - the starter rows of the AddSheet and onboarding's progress lines
 *     (W5-1 leftovers of wave 4b): which version a deck came from, when a row
 *     offers "Update {title} (keeps your progress)" or "Add again", the
 *     one-task-at-a-time guard, and the result lines;
 *   - the W5-1 review round 1: the import screen uses the pack presets too;
 *     onboarding's "Try again" after a failed save keeps what the first try
 *     added; the confirmed version is kept on the device (a restart does not
 *     bring "Update" back); a fork deck with the same name is noticed before
 *     a second copy is added; a NEW starter deck follows decision D3 (more
 *     than 1,000 new cards start Not started); the lint rule allows `.apkg`
 *     with no change in pack.ts; `npm run android` builds the generic app;
 *   - the W5-1 review round 2: `npm run android` / `android:german` delete
 *     android/ only when it was made for the OTHER variant (with no git
 *     prompt that could let the old folder through), else a plain prebuild
 *     keeps the Gradle outputs (the scripts run with a fake `expo`); a
 *     re-add after a failed save saves first, and confirms nothing until it
 *     is on the disk; onboarding's line of an unsaved deck whose next try
 *     throws says "not saved yet", not "Could not be added.";
 *   - wave 5b (walkthrough L3 / R6): no field of a German card type shows an
 *     internal name. "MarankiExample" (vocabulary versions 1 and 2; version 3
 *     has no such field) reads "Example": render.ts drops the app prefix. Every
 *     other field reads well (its label, else the readable name);
 *   - wave 5d: the deck page's sheets and the import's Preview use the same
 *     readable names in the generic build too (fieldText.ts `fieldLabel`,
 *     PreviewStage.tsx `readableSummary`), and D3 is pinned on the sheet's ONE
 *     add (`addStarterOnce`): the old probe `withStarterArrival` (a second
 *     read and plan of the file) is deleted.
 *
 * `require('…apkg')` has no jest transform (it is a Metro asset), and the
 * files are not in this repo, so each deck is a VIRTUAL fake asset module: a
 * number, like the one Metro gives.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import appConfig, { VARIANTS, variantOf } from '../../../app.config';
import {
  addStarterOnce,
  checkedVersions,
  confirmsBundledVersion,
  installedStarterVersions,
  parseCheckedVersions,
  readCheckedVersions,
  saveCheckedVersions,
  serializeCheckedVersions,
  STARTER_AGAIN_COPY,
  STARTER_CHECKED_KEY,
  STARTER_CHOOSE_COPY,
  STARTER_LOOKALIKE_COPY,
  starterArrivalFor,
  starterChooseQuery,
  starterLookalikes,
  starterOutcomeLine,
  starterRowAction,
  starterRunCounts,
  STARTER_RUN_LINE,
  starterRunRow,
  starterRunRowAfter,
  starterRunRowThrew,
  type StarterRunRow,
  starterRunSummary,
  starterTaskGuard,
  type StarterTry,
  withSettledSave,
} from '../../components/sheets/AddSheet';
import { readableSummary } from '../../components/import/PreviewStage';
import { PLACEMENT_LEVELS } from '../../components/settings/onboardingDiff';
import { fieldLabel } from '../../domain/fieldText';
import { collectionFromRows, type ApkgRows } from '../../domain/import/apkgRead';
import { fieldsLine, saveWarning } from '../../domain/importFile';
import { LEVEL_NAMES, levelNames } from '../../domain/gamification';
import { deriveFacets } from '../../domain/facets';
import { buildLibraryIndex } from '../../domain/libraryIndex';
import { listsById } from '../../domain/lists';
import type { AnkiCollection, Card, DataStateV3, Deck, ImportPlan, ImportResult, Note, NoteType } from '../../domain/model';
import { RETIRED_TAG } from '../../domain/noteOps';
import { fieldDisplayLabel, renderFace } from '../../domain/render';
import { suggestMapping } from '../../domain/roles';
import {
  addStarterDeck,
  planStarterDeckFrom,
  starterDeckRows,
  type StarterCtx,
  type StarterDeckOutcome,
  type StarterDeps,
  type StarterLibrary,
} from '../../domain/starterDecks';
import { foldText } from '../../domain/text';
import { DEFAULT_SRS } from '../../domain/types';
import type { FlushResult } from '../../store/actions';
import { migrate } from '../../store/migrate';
import { applyImport } from '../../store/reducer';
import { FIXED_NOW } from '../../test/clock';
import { ankiFixture, type AnkiFixture, stateFixture } from '../../test/factories';
import { makeStateV3, notesWithoutCards, stateProblemsV3, testCtx } from '../../test/factoriesV3';
import { starterMessage } from '../../components/today/todayLogic';
import { choosePack, configuredVariant } from '../index';
import { pack as genericPack } from '../generic/pack';
import type { ContentPack } from '../types';
import { pack } from './pack';

/* ------------------------------------------------------------------ mocks */

// The decks are Metro assets: in the app `require()` gives a number for expo-asset.
jest.mock('../../../assets/packs/german/German_Vocabulary.apkg', () => 9001, { virtual: true });
jest.mock('../../../assets/packs/german/German_Grammar.apkg', () => 9002, { virtual: true });
jest.mock('../../../assets/packs/german/German_Verbs.apkg', () => 9003, { virtual: true });
// The AddSheet module reads the theme through ThemeContext (kv-store); its helpers need none.
jest.mock('../../theme/ThemeContext', () => ({ useColors: () => ({}) }));
// The kv-store of the confirmed versions (AddSheet `readCheckedVersions` / `saveCheckedVersions`):
// an in-memory fake with the two methods the AddSheet uses.
const mockKv = {
  items: new Map<string, string>(),
  failRead: false,
  failWrite: false,
  getItemSync(key: string): string | null {
    if (mockKv.failRead) throw new Error('read failed');
    return mockKv.items.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    if (mockKv.failWrite) throw new Error('disk full');
    mockKv.items.set(key, value);
  },
};
jest.mock('../../store/storage/kvStoragePort', () => ({ getKvStore: () => mockKv }));
// A kv writer waits for the app storage's first load: here it is done at once.
jest.mock('../../store/storage', () => ({ afterAppStorageLoad: () => Promise.resolve() }));

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const PACK_DIR = path.join(ROOT, 'assets', 'packs', 'german');

/* ------------------------------------------------------- the decks, by key */

/** Each starter deck: its file, its Anki fixture, and the exact row copy of spec §9.4. */
const DECKS = [
  {
    key: 'vocabulary',
    file: 'German_Vocabulary.apkg',
    fixture: 'german_vocabulary',
    title: 'German vocabulary',
    subtitle: '7,517 words, A1 to C1',
    model: 'German Vocabulary (bidirectional)',
    // 2 = the rebuilt deck of 2026-10 (Type and Plural fields); 3 = ONE example field
    // (no MarankiExample); 4 = no answer on the
    // question side.
    version: 4,
  },
  {
    key: 'grammar',
    file: 'German_Grammar.apkg',
    fixture: 'german_grammar',
    title: 'German grammar',
    subtitle: '906 questions, A1 to B2',
    model: 'German Grammar',
    // 2 = the 5 open rows of the June review fixed.
    version: 2,
  },
  {
    key: 'verbs',
    file: 'German_Verbs.apkg',
    fixture: 'german_verbs',
    title: 'German verbs',
    subtitle: '682 verbs with conjugation, A1 to C2',
    model: 'German Verbs (bidirectional)',
    // 2 = the fixed deck of 2026-10 (46 notes corrected); 3 = + the missing "er" forms of 29 verbs;
    // 4 = the same notes, templates without triple braces; 5 = hints that do not name the verb.
    version: 5,
  },
] as const;

/** The bundled version of the vocabulary deck in THIS build. */
const VOCAB_VERSION = DECKS[0].version;

/**
 * The German pack of a LATER build: its vocabulary file is one version newer
 * than this build's (the AddSheet rows then offer "Update").
 */
const PACK_NEXT: ContentPack = {
  ...pack,
  starterDecks: pack.starterDecks.map((s) => (s.key === 'vocabulary' ? { ...s, version: VOCAB_VERSION + 1 } : s)),
};

type DeckKey = (typeof DECKS)[number]['key'];

function fixtureOf(key: DeckKey): AnkiFixture {
  return ankiFixture(DECKS.find((d) => d.key === key)!.fixture);
}

/** The fixture as the rows the .apkg reader gives (collectionFromRows). */
function rowsOf(fx: AnkiFixture): ApkgRows {
  return { fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media };
}

/** The card types of a fixture: name → field names. */
function modelsOf(fx: AnkiFixture): { name: string; fields: string[] }[] {
  const models = JSON.parse(fx.col.models) as Record<string, { name: string; flds: { name: string }[] }>;
  return Object.values(models).map((m) => ({ name: m.name, fields: m.flds.map((f) => f.name) }));
}

/* ------------------------------------------------------------- the library */

type Lib = StarterLibrary & { noteTypes: NoteType[]; notes: Note[]; cards: Card[]; decks: Deck[] };

const emptyLib = (): Lib => ({ noteTypes: [], notes: [], cards: [], decks: [], settings: { srs: DEFAULT_SRS } });

/** Ids 'id-1', 'id-2' …, a new sequence per call. */
function ctx(prefix = 'id'): StarterCtx {
  let n = 0;
  return { now: FIXED_NOW, newId: () => `${prefix}-${++n}` };
}

/** What `applyImport` does with a plan (the reducer), enough for these tests. */
function apply(lib: Lib, plan: ImportPlan): Lib {
  const upd = new Map(plan.notes.update.map((u) => [u.id, u]));
  return {
    ...lib,
    noteTypes: [...lib.noteTypes, ...plan.noteTypes.add],
    notes: [
      ...lib.notes.map((n) => {
        const u = upd.get(n.id);
        return u ? { ...n, fields: u.fields, tags: u.tags, section: u.section ?? n.section } : n;
      }),
      ...plan.notes.add,
    ],
    cards: [...lib.cards, ...plan.cards.add],
    decks: plan.deck ? [...lib.decks, plan.deck] : lib.decks,
  };
}

/** The plan of adding one German starter deck (from its fixture) to `lib`. */
function planOf(key: DeckKey, lib: Lib = emptyLib(), opts = {}, p: ContentPack = pack) {
  return planStarterDeckFrom(p, key, lib, collectionFromRows(rowsOf(fixtureOf(key))), ctx(key), opts);
}

/** The field definitions of the one new card type of a plan, by field name. */
function fieldsOf(plan: ImportPlan) {
  expect(plan.noteTypes.add).toHaveLength(1);
  return new Map(plan.noteTypes.add[0].fields.map((f) => [f.name, f]));
}

/** The two ImportResult numbers the result lines read (the rest does not matter here). */
function importResult(cardsAdded: number, markedKnown: number): ImportResult {
  return { cardsAdded, markedKnown } as unknown as ImportResult;
}

/** The German fork's saved data (fixture v0-german-fork.json) after migrate(): what an in-place upgrade opens. */
function forkState(): DataStateV3 {
  const out = migrate(stateFixture('v0-german-fork'), FIXED_NOW);
  if (out.kind !== 'ok') throw new Error(`the fork fixture did not migrate: ${out.kind}`);
  return out.state;
}

/* ================================================================ the pack */

describe('the German pack (ContentPack, spec §9.4)', () => {
  test('id german; three starter decks with unique keys, exact titles, subtitles and versions', () => {
    expect(pack.id).toBe('german');
    expect(pack.starterDecks.map((s) => ({ key: s.key, title: s.title, subtitle: s.subtitle, version: s.version }))).toEqual(
      DECKS.map((d) => ({ key: d.key, title: d.title, subtitle: d.subtitle, version: d.version })),
    );
    const keys = pack.starterDecks.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const titles = pack.starterDecks.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const s of pack.starterDecks) {
      // A key is a plain name: it becomes the sourceKey 'pack:german:<key>' forever.
      expect(s.key).toMatch(/^[a-z][a-z0-9-]*$/);
      // The asset is the module number Metro gives for the bundled file (a fake here).
      expect(typeof s.asset).toBe('number');
      expect(Number.isInteger(s.version) && s.version >= 1).toBe(true);
    }
    expect(new Set(pack.starterDecks.map((s) => s.asset)).size).toBe(3);
  });

  test('deck defaults, level names and onboarding copy are exactly the spec', () => {
    expect(pack.deckDefaults).toEqual({ language: 'de-DE', meaningLanguage: 'en-US', genderColors: true, icon: '🇩🇪' });
    expect(pack.onboarding).toEqual({
      tagline: 'Learn German. Keep it.',
      firstChoice: { title: 'Start with German', sub: '9,105 words and grammar, A1 to C2' },
      placementField: 'Level',
    });
    expect(pack.levelNames).toEqual([
      'Novice',
      'Apprentice',
      'Student',
      'Reader',
      'Scribe',
      'Linguist',
      'Wordsmith',
      'Scholar',
      'Sage',
      'Polyglot',
      'Lexicographer',
      'Luminary',
    ]);
  });

  test('the level names override exactly the four generic ones (Keeper, Maker, Mentor, Master)', () => {
    const names = levelNames(pack.levelNames);
    expect(names).toEqual(pack.levelNames);
    const changed = LEVEL_NAMES.map((generic, i) => (generic === names[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([5, 6, 9, 10]);
    expect(changed.map((i) => LEVEL_NAMES[i])).toEqual(['Keeper', 'Maker', 'Mentor', 'Master']);
  });

  test('the field preset records have no prototype (a field called "constructor" finds nothing)', () => {
    for (const preset of pack.cardTypePresets) {
      expect(Object.getPrototypeOf(preset.fields)).toBeNull();
      expect(preset.fields.constructor).toBeUndefined();
      expect(preset.fields.toString).toBeUndefined();
    }
  });
});

/* ======================================================= the private decks */

describe('the private decks (assets/packs/german)', () => {
  test('.gitignore ignores deck files, and the deck-file check is part of `npm run verify`', () => {
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n')).toContain('*.apkg');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.verify).toContain('check-no-deck-files.sh');
  });

  test.each(DECKS)('$file: the $fixture fixture names this file and is marked as made up', (deck) => {
    const fx = ankiFixture(deck.fixture);
    expect(fx.about.source).toBe(deck.file);
    expect(fx.about.synthetic).toContain('Made-up text');
  });

  // The deck files are private, so they are only on the author's computer. There,
  // this test checks that each file is a zip file. It does not prove that the file is
  // the deck of the fixture, because the public fixtures hold no hash. CI skips it.
  describe.each(DECKS)('$file (only where the private file exists)', (deck) => {
    const file = path.join(PACK_DIR, deck.file);
    (fs.existsSync(file) ? test : test.skip)('is a zip file, and the fixture saved its note count', () => {
      expect(fs.readFileSync(file).subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
      expect(ankiFixture(deck.fixture).about.totals.notes).toBeGreaterThan(0);
    });
  });

  test("the subtitles' numbers equal the note counts the fixtures saved", () => {
    const notes = (key: DeckKey) => fixtureOf(key).about.totals.notes;
    const sub = (key: DeckKey) => pack.starterDecks.find((s) => s.key === key)!.subtitle;
    const fmt = (n: number) => n.toLocaleString('en-US');
    expect(sub('vocabulary').startsWith(`${fmt(notes('vocabulary'))} words`)).toBe(true);
    expect(sub('grammar').startsWith(`${fmt(notes('grammar'))} questions`)).toBe(true);
    expect(sub('verbs').startsWith(`${fmt(notes('verbs'))} verbs`)).toBe(true);
    const all = notes('vocabulary') + notes('grammar') + notes('verbs');
    expect(all).toBe(9105);
    expect(pack.onboarding?.firstChoice?.sub.startsWith(`${fmt(all)} words and grammar`)).toBe(true);
  });

  test('only this pack file requires the German decks', () => {
    const source = fs.readFileSync(path.join(__dirname, 'pack.ts'), 'utf8');
    const required = [...source.matchAll(/require\('([^']+\.apkg)'\)/g)].map((m) => m[1]);
    expect(required.map((r) => path.basename(r))).toEqual(DECKS.map((d) => d.file));
    for (const r of required) expect(path.dirname(path.resolve(__dirname, r))).toBe(PACK_DIR);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && full !== path.join(__dirname, 'pack.ts')) {
          if (fs.readFileSync(full, 'utf8').includes('packs/german/')) offenders.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

/* ======================================== presets vs the real card types */

describe('card-type presets match the Anki card types of the fixtures', () => {
  const realModels = DECKS.map((d) => ({ key: d.key, models: modelsOf(ankiFixture(d.fixture)) }));

  test.each(DECKS)('$model: one card type in $fixture, and the expected name', (deck) => {
    expect(modelsOf(ankiFixture(deck.fixture)).map((m) => m.name)).toEqual([deck.model]);
  });

  test('every preset matches exactly one real card type, and every real card type has a preset', () => {
    const all = realModels.flatMap((r) => r.models);
    for (const preset of pack.cardTypePresets) {
      expect(all.filter((m) => preset.match.test(m.name)).map((m) => m.name)).toHaveLength(1);
    }
    for (const model of all) {
      expect(pack.cardTypePresets.filter((p) => p.match.test(model.name))).toHaveLength(1);
    }
  });

  test('every preset field name is a real field of its card type (no typo silently does nothing)', () => {
    for (const preset of pack.cardTypePresets) {
      const model = realModels.flatMap((r) => r.models).find((m) => preset.match.test(m.name))!;
      const names = Object.keys(preset.fields);
      expect(names.filter((n) => !model.fields.includes(n))).toEqual([]);
      // And every field of the card type is pinned by the preset (spec §9.4 lists all of them).
      expect([...model.fields].sort()).toEqual([...names].sort());
    }
  });

  test('the spec table, field by field', () => {
    const presetOf = (name: string) => pack.cardTypePresets.find((p) => p.match.test(name))!.fields;
    const vocab = presetOf('German Vocabulary (bidirectional)');
    expect(vocab).toEqual({
      Word: { role: 'term', lang: 'de-DE' },
      Grammar: { role: 'detail', label: 'Grammar' },
      VerbForms: { role: 'detail', label: 'Verb forms' },
      // Version 3: the ONE example field (MarankiExample is gone, see the deck table).
      Examples: { role: 'example', lang: 'de-DE' },
      Translation: { role: 'meaning', lang: 'en-US' },
      Level: { role: 'badge' },
      // Since version 2: the part of speech (a filter group) and the plural.
      Type: { role: 'badge' },
      Plural: { role: 'detail', lang: 'de-DE' },
    });
    const verbs = presetOf('German Verbs (bidirectional)');
    expect(verbs).toEqual({
      Verb: { role: 'term', lang: 'de-DE' },
      Meaning: { role: 'meaning', lang: 'en-US' },
      CaseInfo: { role: 'detail', label: 'Case / preposition' },
      Conjugation: { role: 'detail' },
      Perfekt: { role: 'detail' },
      Prateritum: { role: 'detail', label: 'Präteritum' },
      Example: { role: 'example', lang: 'de-DE' },
      Level: { role: 'badge' },
      Tags: { role: 'badge', multiSep: ',', label: 'Verb type' },
    });
    const grammar = presetOf('German Grammar');
    expect(grammar).toEqual({
      Question: { role: 'term', lang: 'en-US' },
      Answer: { role: 'meaning', lang: 'en-US' },
      Example: { role: 'example', lang: 'de-DE' },
      Level: { role: 'badge' },
    });
  });

  test('the Grammar Question is read in ENGLISH (the fix for "906 grammar questions read with a German voice")', () => {
    const grammar = pack.cardTypePresets.find((p) => p.match.test('German Grammar'))!;
    expect(grammar.fields.Question).toEqual({ role: 'term', lang: 'en-US' });
  });
});

/* ========================================== end to end on the fixtures */

describe('a German starter deck planned from its fixture', () => {
  test('vocabulary: one new deck with the pack defaults, every direction, the presets on the card type', () => {
    const fx = fixtureOf('vocabulary');
    const planned = planOf('vocabulary');
    expect(planned.kind).toBe('add');
    const deck = planned.plan.deck as Deck;
    expect(deck).toMatchObject({
      name: 'German vocabulary',
      icon: '🇩🇪',
      source: 'pack',
      sourceKey: 'pack:german:vocabulary',
      language: 'de-DE',
      meaningLanguage: 'en-US',
      genderColors: true,
    });
    expect(planned.plan.notes.add).toHaveLength(fx.notes.length);
    expect(planned.plan.cards.add).toHaveLength(fx.cards.length); // DE-EN and EN-DE
    expect(planned.plan.notes.add.every((n) => n.source.ref === `pack:german:vocabulary@${VOCAB_VERSION}`)).toBe(true);
    const fields = fieldsOf(planned.plan);
    expect(fields.get('Word')).toMatchObject({ role: 'term', lang: 'de-DE' });
    expect(fields.get('Translation')).toMatchObject({ role: 'meaning', lang: 'en-US' });
    expect(fields.get('Grammar')).toMatchObject({ role: 'detail', label: 'Grammar' });
    expect(fields.get('VerbForms')).toMatchObject({ role: 'detail', label: 'Verb forms' });
    expect(fields.get('Examples')).toMatchObject({ role: 'example', lang: 'de-DE' });
    // Version 3: no field is named after the app.
    expect([...fields.keys()].filter((name) => /maranki/i.test(name))).toEqual([]);
    expect(fields.get('Level')).toMatchObject({ role: 'badge', facet: 'auto' });
    expect(fields.get('Type')).toMatchObject({ role: 'badge', facet: 'auto' });
    expect(fields.get('Plural')).toMatchObject({ role: 'detail', lang: 'de-DE' });
    expect(planned.plan.noteTypes.add[0].source?.packId).toBe('german');
    expect(planned.plan.summary.filtersFound).toEqual(expect.arrayContaining(['Level', 'Type']));
  });

  test('grammar: the question field is the English term, one direction', () => {
    const fx = fixtureOf('grammar');
    const planned = planOf('grammar');
    const fields = fieldsOf(planned.plan);
    expect(fields.get('Question')).toMatchObject({ role: 'term', lang: 'en-US' });
    expect(fields.get('Answer')).toMatchObject({ role: 'meaning', lang: 'en-US' });
    expect(fields.get('Example')).toMatchObject({ role: 'example', lang: 'de-DE' });
    const type = planned.plan.noteTypes.add[0];
    const question = type.fields.findIndex((f) => f.name === 'Question');
    expect(type.templates.map((t) => t.prompt)).toEqual([[question]]);
    expect(planned.plan.cards.add).toHaveLength(fx.cards.length);
  });

  test('verbs: Tags is the multi-value "Verb type" filter; Präteritum and the case info are labelled rows', () => {
    const fields = fieldsOf(planOf('verbs').plan);
    expect(fields.get('Verb')).toMatchObject({ role: 'term', lang: 'de-DE' });
    expect(fields.get('Meaning')).toMatchObject({ role: 'meaning', lang: 'en-US' });
    expect(fields.get('Tags')).toMatchObject({ role: 'badge', multiSep: ',', label: 'Verb type' });
    expect(fields.get('Prateritum')).toMatchObject({ role: 'detail', label: 'Präteritum' });
    expect(fields.get('CaseInfo')).toMatchObject({ role: 'detail', label: 'Case / preposition' });
  });

  test.each(DECKS.map((d) => d.key))('%s: "Where do you start?" offers the Level field', (key) => {
    const facet = `field:${foldText(pack.onboarding!.placementField!)}`;
    const group = planOf(key).plan.summary.placementGroups.find((g) => g.facet === facet);
    expect(group).toBeDefined();
    // Every level of the deck is one of the onboarding choices A1 … C2.
    for (const v of group!.values) expect(PLACEMENT_LEVELS as readonly string[]).toContain(v.toUpperCase());
  });

  test.each(DECKS.map((d) => d.key))(
    '%s: onboarding "A2" marks the A1 cards Known; every other new card starts Not started',
    (key) => {
      const fx = fixtureOf(key);
      const levelAt = modelsOf(fx)[0].fields.indexOf('Level');
      const a1Notes = new Set(fx.notes.filter((n) => n.flds.split('\x1f')[levelAt] === 'A1').map((n) => n.id));
      const a1Cards = fx.cards.filter((c) => a1Notes.has(c.nid)).length;
      expect(a1Cards).toBeGreaterThan(0);

      const facet = `field:${foldText(pack.onboarding!.placementField!)}`;
      const planned = planOf(key, emptyLib(), {
        arrival: 'notStarted',
        placement: { facet, fromValue: 'A2', below: 'known' },
      });
      const cards = planned.plan.cards.add;
      expect(planned.plan.summary.markedKnown).toBe(a1Cards);
      expect(cards.filter((c) => c.knownAt != null)).toHaveLength(a1Cards);
      expect(cards.filter((c) => c.knownAt == null).every((c) => c.newState === 'notStarted')).toBe(true);
    },
  );

  test('the second add of the same file changes nothing ("Already up to date.")', () => {
    for (const { key } of DECKS) {
      const lib = apply(emptyLib(), planOf(key).plan);
      const again = planOf(key, lib);
      expect(again.kind).toBe('upToDate');
      expect(again.plan.deck).toBeNull();
      expect(again.plan.cards.add).toEqual([]);
    }
  });
});

/* ============================================== the AddSheet starter rows */

describe('AddSheet starter rows: "Add", "Add again" or "Update {title} (keeps your progress)"', () => {
  /** The library after the first add of these starter decks. */
  function libWith(keys: DeckKey[]): Lib {
    let lib = emptyLib();
    for (const key of keys) lib = apply(lib, planOf(key, lib).plan);
    return lib;
  }

  test('the installed version is read from the notes of each starter deck (null = not in the library)', () => {
    const lib = libWith(['vocabulary', 'verbs']);
    const versions = installedStarterVersions(pack, lib);
    expect([...versions]).toEqual([
      ['vocabulary', VOCAB_VERSION],
      ['grammar', null],
      ['verbs', DECKS[2].version],
    ]);
  });

  test('not added → "Add"; added from the same version → "Add again"; from an older one → "Update"', () => {
    const lib = libWith(['vocabulary']);
    const rows = starterDeckRows(PACK_NEXT, lib.decks);
    const versions = installedStarterVersions(PACK_NEXT, lib);
    const action = (key: string) => {
      const row = rows.find((r) => r.starter.key === key)!;
      return starterRowAction(row, versions.get(key) ?? null, undefined);
    };
    expect(action('vocabulary')).toBe('update'); // the deck came from this build's version, the later build has a newer one
    expect(action('grammar')).toBe('add');
    expect(STARTER_AGAIN_COPY.update('German vocabulary')).toBe('Update German vocabulary (keeps your progress)');

    const same = starterDeckRows(pack, lib.decks).find((r) => r.starter.key === 'vocabulary')!;
    expect(starterRowAction(same, installedStarterVersions(pack, lib).get('vocabulary') ?? null, undefined)).toBe('again');
    expect(STARTER_AGAIN_COPY.again).toBe('Add again');
  });

  test('a newer file that ADDS notes moves the version on; an update the sheet confirmed counts too', () => {
    const lib = libWith(['vocabulary']);
    const next = VOCAB_VERSION + 1;
    // The same file as the next version: every note matched by guid, nothing added → the notes still say this version …
    const updated = planOf('vocabulary', lib, {}, PACK_NEXT);
    expect(updated.kind).toBe('upToDate');
    const row = starterDeckRows(PACK_NEXT, lib.decks)[0];
    expect(starterRowAction(row, installedStarterVersions(PACK_NEXT, lib).get('vocabulary') ?? null, undefined)).toBe('update');
    // … so the sheet remembers what its add found (`checked`), and the row says "Add again".
    expect(starterRowAction(row, VOCAB_VERSION, next)).toBe('again');
    // A note that the next version ADDS carries '@<next>': then the notes say so on their own.
    const deckId = row.deckId!;
    const newNote: Note = { ...lib.notes[0], id: 'n-new', guid: 'g-new', source: { kind: 'pack', ref: `pack:german:vocabulary@${next}` } };
    const newCard: Card = { ...lib.cards.find((c) => c.noteId === lib.notes[0].id)!, id: 'c-new', noteId: 'n-new', deckId };
    const lib2 = { ...lib, notes: [...lib.notes, newNote], cards: [...lib.cards, newCard] };
    expect(installedStarterVersions(PACK_NEXT, lib2).get('vocabulary')).toBe(next);
    expect(starterRowAction(row, next, undefined)).toBe('again');
  });

  test('no version anywhere (every note deleted, or notes from elsewhere) is never an "Update"', () => {
    const lib = libWith(['vocabulary']);
    const empty = { ...lib, notes: [], cards: [] };
    expect(installedStarterVersions(PACK_NEXT, empty).get('vocabulary')).toBeNull();
    const row = starterDeckRows(PACK_NEXT, empty.decks)[0];
    expect(starterRowAction(row, null, undefined)).toBe('again');
    // A note of another source in the starter deck does not count.
    const other = { ...lib, notes: lib.notes.map((n) => ({ ...n, source: { kind: 'manual' as const } })) };
    expect(installedStarterVersions(PACK_NEXT, other).get('vocabulary')).toBeNull();
  });

  test('an add confirms the bundled version only when it found the deck, changed nothing more, and is saved', () => {
    expect(confirmsBundledVersion({ kind: 'upToDate', deckId: 'd', saved: null })).toBe(true);
    expect(confirmsBundledVersion({ kind: 'update', deckId: 'd', saved: { ok: true } })).toBe(true);
    expect(confirmsBundledVersion({ kind: 'update', deckId: 'd', saved: { ok: false, reason: 'write' } })).toBe(false);
    expect(confirmsBundledVersion({ kind: 'add', deckId: 'd', saved: { ok: true } })).toBe(false);
    expect(confirmsBundledVersion({ kind: 'elsewhere', deckId: null, saved: null })).toBe(false);
  });
});

/* ========= the vocabulary update: version 1 or 2 → the current version (2026-10) */

describe('the vocabulary update: a learner who added version 1 or 2 gets the current version', () => {
  /** The pack of an older build: the same German pack, with vocabulary version `v`. */
  const packWith = (v: number): ContentPack => ({
    ...pack,
    starterDecks: pack.starterDecks.map((s) => (s.key === 'vocabulary' ? { ...s, version: v } : s)),
  });
  const PACK_V1 = packWith(1);
  const V1 = () => collectionFromRows(rowsOf(ankiFixture('german_vocabulary_v1')));
  const V2 = () => collectionFromRows(rowsOf(ankiFixture('german_vocabulary_v2')));
  /** The bundled file of THIS build (version 4; since version 3: one Examples field, no MarankiExample). */
  const CURRENT = () => collectionFromRows(rowsOf(fixtureOf('vocabulary')));
  const VOCAB_MID = '2710111000';
  const CURRENT_FIELDS = ['Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'Level', 'Type', 'Plural'];

  /**
   * `addStarterDeck` with the REAL reducer (and a save that works). The
   * bundled file is given as its collection (the fixture), so no .apkg is read.
   */
  function realStore(initial: DataStateV3, collection: () => AnkiCollection) {
    const store = { state: initial };
    const deps: StarterDeps = {
      getState: () => store.state,
      applyImport: (plan) => {
        const step = applyImport(store.state, { plan }, testCtx());
        store.state = step.state;
        return step.result;
      },
      flush: async () => ({ ok: true }),
      writeMedia: async () => undefined,
      now: () => FIXED_NOW,
      loadBytes: async () => new Uint8Array(0),
      readFile: async () => collection(),
    };
    return { store, deps };
  }

  /** The library of a learner who added version 1 and studied "der Mensch" (both directions). */
  async function learnerWithV1(): Promise<{ state: DataStateV3; deckId: string }> {
    const one = realStore(makeStateV3(), V1);
    const added = await addStarterDeck(PACK_V1, 'vocabulary', one.deps);
    expect(added.kind).toBe('add');
    const mensch = one.store.state.notes.find((n) => n.fields[0] === 'der Mensch') as Note;
    const cards = one.store.state.cards.map((c) =>
      c.noteId === mensch.id ? { ...c, reps: 6, intervalDays: 21, stepIndex: null, lastReviewedAt: FIXED_NOW } : c,
    );
    return { state: { ...one.store.state, cards }, deckId: added.deckId as string };
  }

  test('the row offers "Update German vocabulary (keeps your progress)"', async () => {
    const { state } = await learnerWithV1();
    expect(state.noteTypes.find((t) => t.source?.ankiMid === VOCAB_MID)?.fields).toHaveLength(7);
    expect(installedStarterVersions(pack, state).get('vocabulary')).toBe(1);
    const row = starterDeckRows(pack, state.decks)[0];
    expect(starterRowAction(row, 1, undefined)).toBe('update');
  });

  test('the update: changed notes updated by guid, new notes added, dropped notes retired — one card type, progress kept', async () => {
    const { state, deckId } = await learnerWithV1();
    const two = realStore(state, CURRENT);
    const updated = await addStarterDeck(pack, 'vocabulary', two.deps);
    expect(updated.kind).toBe('update'); // never "Already up to date."
    expect(updated.deckId).toBe(deckId);
    expect(updated.result).toMatchObject({
      cardTypesUpdated: 1,
      notesUpdated: 18, // every note of version 1 that the current version still has
      notesAdded: 2,
      cardsAdded: 4,
      notesRetired: 2,
    });
    expect(starterMessage(updated).text).toBe(
      'Updated German vocabulary: 18 items changed, 2 new. Your progress is kept. 2 old items are not in the new version, so they are suspended.',
    );
    const after = two.store.state;
    expect(stateProblemsV3(after)).toEqual([]);
    expect(notesWithoutCards(after)).toEqual([]);

    // ONE card type: the current fields (the new ones have the pack presets), and
    // MarankiExample KEPT last, because the 2 retired notes still have text in it.
    const types = after.noteTypes.filter((t) => t.source?.ankiMid === VOCAB_MID);
    expect(types).toHaveLength(1);
    const type = types[0];
    expect(type.fields.map((f) => f.name)).toEqual([...CURRENT_FIELDS, 'MarankiExample']);
    expect(type.templates.flatMap((t) => [...t.prompt, ...t.answer])).not.toContain(CURRENT_FIELDS.length);
    const def = (name: string) => type.fields.find((f) => f.name === name);
    expect(def('Type')).toMatchObject({ role: 'badge', facet: 'auto' });
    expect(def('Plural')).toMatchObject({ role: 'detail', lang: 'de-DE' });
    expect(after.notes.filter((n) => n.typeId === type.id)).toHaveLength(22);

    // "der Mensch": the current values, and its cards keep their progress.
    const mensch = after.notes.find((n) => n.fields[0] === 'der Mensch') as Note;
    const value = (n: Note, name: string) => n.fields[type.fields.findIndex((f) => f.name === name)];
    expect(value(mensch, 'Type')).toBe('noun');
    expect(value(mensch, 'Plural')).toBe('die Goro');
    expect(value(mensch, 'Grammar')).toBe('Tilu kumi tera zavizo/Votéfi mozi mapere gibi ribu poba vidomaso valenube luse/Naraño ßaki bäpasoke buba');
    expect(value(mensch, 'MarankiExample')).toBe(''); // its sentence is one of the Examples now
    expect(mensch.tags).toEqual(['noun', 'v2026-10']);
    const menschCards = after.cards.filter((c) => c.noteId === mensch.id);
    expect(menschCards).toHaveLength(2);
    expect(menschCards.every((c) => c.reps === 6 && c.intervalDays === 21 && c.suspended !== true)).toBe(true);
    expect(menschCards).toEqual(state.cards.filter((c) => c.noteId === mensch.id));

    // The 2 notes the newer versions dropped: still there, with their cards, but suspended
    // and tagged; their own example sentence is kept.
    const dropped = after.notes.filter((n) => n.tags.includes(RETIRED_TAG));
    expect(dropped.map((n) => n.fields[0]).sort()).toEqual(['das Internet (Sg.)', 'der Reis (Sg.)']);
    for (const n of dropped) {
      expect([value(n, 'Type'), value(n, 'Plural')]).toEqual(['', '']); // nothing invented
      expect(value(n, 'MarankiExample')).not.toBe('');
      const cards = after.cards.filter((c) => c.noteId === n.id);
      expect(cards).toHaveLength(2);
      expect(cards.every((c) => c.suspended === true && c.deckId === deckId)).toBe(true);
    }
    // The 2 new notes say the current version, so the row says "Add again" now.
    const added = after.notes.filter((n) => n.source.ref === `pack:german:vocabulary@${VOCAB_VERSION}`);
    expect(added.map((n) => n.fields[0]).sort()).toEqual(['das Foko', 'fababozu']);
    expect(added.every((n) => n.typeId === type.id)).toBe(true);
    expect(installedStarterVersions(pack, after).get('vocabulary')).toBe(VOCAB_VERSION);
    expect(starterRowAction(starterDeckRows(pack, after.decks)[0], VOCAB_VERSION, undefined)).toBe('again');

    // The next tap: "Already up to date." (a retired note is never retired twice, and the
    // kept field is not "upgraded" again).
    const three = realStore(after, CURRENT);
    const again = await addStarterDeck(pack, 'vocabulary', three.deps);
    expect(again.kind).toBe('upToDate');
    expect(three.store.state).toBe(after);
  });

  test('version 2 → the current version: the MarankiExample field is removed (its sentence is one of the Examples); nothing retired', async () => {
    const one = realStore(makeStateV3(), V2);
    const first = await addStarterDeck(packWith(2), 'vocabulary', one.deps);
    expect(first.kind).toBe('add');
    const bad = one.store.state.notes.find((n) => n.fields[0] === 'das Bad') as Note;
    const studied = one.store.state.cards.map((c) => (c.noteId === bad.id ? { ...c, reps: 4, intervalDays: 9 } : c));
    const v2State: DataStateV3 = { ...one.store.state, cards: studied };
    expect(installedStarterVersions(pack, v2State).get('vocabulary')).toBe(2);
    expect(starterRowAction(starterDeckRows(pack, v2State.decks)[0], 2, undefined)).toBe('update');

    const two = realStore(v2State, CURRENT);
    const updated = await addStarterDeck(pack, 'vocabulary', two.deps);
    expect(updated.kind).toBe('update');
    expect(updated.result).toMatchObject({ cardTypesUpdated: 1, notesUpdated: 20, notesAdded: 0, cardsAdded: 0, notesRetired: 0 });
    const after = two.store.state;
    expect(stateProblemsV3(after)).toEqual([]);
    const types = after.noteTypes.filter((t) => t.source?.ankiMid === VOCAB_MID);
    expect(types.map((t) => t.fields.map((f) => f.name))).toEqual([CURRENT_FIELDS]);
    expect(after.notes.every((n) => n.fields.length === CURRENT_FIELDS.length)).toBe(true);
    // "das Bad": its old MarankiExample sentence is one of its Examples; progress kept.
    const examples = (after.notes.find((n) => n.id === bad.id) as Note).fields[CURRENT_FIELDS.indexOf('Examples')];
    expect(examples).toContain('Fafefo nakute fafefo guno tirapuna sañomifo remüto?');
    expect(after.cards.filter((c) => c.noteId === bad.id).every((c) => c.reps === 4 && c.intervalDays === 9)).toBe(true);
    expect(after.cards).toEqual(v2State.cards);
    // The next tap: "Already up to date."
    const three = realStore(after, CURRENT);
    expect((await addStarterDeck(pack, 'vocabulary', three.deps)).kind).toBe('upToDate');
  });

  test('after the update, Type is a filter group of the deck in the Library, next to Level', async () => {
    const { state, deckId } = await learnerWithV1();
    const two = realStore(state, CURRENT);
    await addStarterDeck(pack, 'vocabulary', two.deps);
    const after = two.store.state;
    const ctx = {
      now: FIXED_NOW,
      index: buildLibraryIndex(after.notes, after.noteTypes),
      decks: new Map(after.decks.map((d) => [d.id, d])),
      lists: listsById([]),
    };
    const facets = deriveFacets(after.cards, { decks: [deckId] }, {}, ctx);
    const type = facets.find((f) => f.key === 'field:type');
    expect(type?.label).toBe('Type');
    expect(type?.values.map((v) => v.label).sort()).toEqual(['adjective', 'adverb', 'determiner', 'noun', 'prefix', 'verb']);
    expect(facets.some((f) => f.key === 'field:level')).toBe(true);
    // Before the update the deck had no Type group.
    const before = deriveFacets(state.cards, { decks: [deckId] }, {}, {
      ...ctx,
      index: buildLibraryIndex(state.notes, state.noteTypes),
      decks: new Map(state.decks.map((d) => [d.id, d])),
    });
    expect(before.some((f) => f.key === 'field:type')).toBe(false);
  });

  test('a fresh install of the current version: one card type with its 8 fields, none named after the app', async () => {
    const fresh = realStore(makeStateV3(), CURRENT);
    const added = await addStarterDeck(pack, 'vocabulary', fresh.deps);
    expect(added.kind).toBe('add');
    expect(added.result).toMatchObject({ notesAdded: 20, cardsAdded: 40, notesRetired: 0, cardTypesUpdated: 0 });
    const types = fresh.store.state.noteTypes.filter((t) => t.source?.ankiMid === VOCAB_MID);
    expect(types.map((t) => t.fields.map((f) => f.name))).toEqual([CURRENT_FIELDS]);
    expect(stateProblemsV3(fresh.store.state)).toEqual([]);
  });
});

/* ============ the verbs update: version 1 → the current version (2026-10) */

describe('the verbs update: a learner who added version 1 gets the current fixed version', () => {
  /** The pack of the build BEFORE: the same German pack, verbs version 1. */
  const PACK_V1: ContentPack = {
    ...pack,
    starterDecks: pack.starterDecks.map((s) => (s.key === 'verbs' ? { ...s, version: 1 } : s)),
  };
  const V1 = () => collectionFromRows(rowsOf(ankiFixture('german_verbs_v1')));
  const V2 = () => collectionFromRows(rowsOf(fixtureOf('verbs')));

  test('"Update German verbs": the corrected values only; the same notes, card type and progress; nothing retired', () => {
    const first = planStarterDeckFrom(PACK_V1, 'verbs', emptyLib(), V1(), ctx('v1'));
    const lib = apply(emptyLib(), first.plan);
    const deck = lib.decks[0];
    expect(installedStarterVersions(pack, lib).get('verbs')).toBe(1);
    expect(starterRowAction(starterDeckRows(pack, lib.decks).find((r) => r.starter.key === 'verbs')!, 1, undefined)).toBe('update');

    const updated = planStarterDeckFrom(pack, 'verbs', lib, V2(), ctx('v2'));
    expect(updated.kind).toBe('update');
    expect(updated.existingDeckId).toBe(deck.id);
    expect(updated.plan.noteTypes).toMatchObject({ add: [], upgrade: [] });
    expect(updated.plan.notes.add).toEqual([]);
    expect(updated.plan.notes.retire).toEqual([]);
    expect(updated.plan.cards.add).toEqual([]);
    // In the sample, six notes were corrected: a wrong verb form (version 2), a missing
    // verb form (version 3), and five hints that named the verb on the question side
    // (version 5: the hint shows "~" in place of the verb).
    const fieldAt = (name: string) => lib.noteTypes[0].fields.findIndex((f) => f.name === name);
    const conjugation = fieldAt('Conjugation');
    const caseInfo = fieldAt('CaseInfo');
    const noteOf = (verb: string) => lib.notes.find((n) => n.fields[0] === verb) as Note;
    const newValue = (verb: string, field = conjugation) =>
      updated.plan.notes.update.find((u) => u.id === noteOf(verb).id)?.fields[field];
    expect(noteOf('fortsetzen').fields[conjugation]).toBe('Vidomaso gifiruzu ñozutémi boliñovu danopula fave poba telo tépaketo, Galu lovida nuño rinapa, Legateßa pure lebäzoki keva');
    expect(newValue('fortsetzen')).toBe('Vidomaso gifiruzu ñozutémi boliñovu danopula fave poba telo tépaketo, Legateßa pure lebäzoki keva, Legateßa pure lebäzoki keva');
    expect(noteOf('nachdenken').fields[conjugation]).toBe('Gele kaboga telepi divo rikazefi donazoma samu, Megote bäre kaboga sivubora dafari fipi');
    expect(newValue('nachdenken')).toBe('Gele kaboga telepi divo rikazefi donazoma samu, Megote bäre kaboga sivubora dafari fipi, Femiruza popavu ßavu pamegi');
    expect(noteOf('träumen').fields[caseInfo]).toBe('kakö <b>duki</b> + Siderali');
    expect(newValue('träumen', caseInfo)).toBe('~ <b>duki</b> + Siderali');
    expect(updated.plan.notes.update.map((u) => u.fields[0])).toEqual([
      'träumen',
      'tauschen',
      'nachdenken',
      'verwechseln',
      'fortsetzen',
      'verwirklichen',
    ]);
    expect(updated.plan.summary).toMatchObject({ notesUpdated: 6, notesUnchanged: 14, cardTypesUpdated: 0, notesRetired: 0 });

    const after = apply(lib, updated.plan);
    expect(after.cards).toEqual(lib.cards);
    expect(planStarterDeckFrom(pack, 'verbs', after, V2(), ctx('v2b')).kind).toBe('upToDate');
  });
});

/* === the verbs templates: {{{CaseInfo}}} (versions 1–3) → {{CaseInfo}} (version 4 on) */

describe('the verbs templates without triple braces (version 4): the card type is reused as it is', () => {
  /** The pack of a build BEFORE: the same German pack, verbs version 3. */
  const PACK_V3: ContentPack = {
    ...pack,
    starterDecks: pack.starterDecks.map((s) => (s.key === 'verbs' ? { ...s, version: 3 } : s)),
  };
  /**
   * The bundled notes with the templates of versions 1–3 ({{{CaseInfo}}} and
   * {{{Conjugation}}}). Version 4 changed only that text (and the Anki note ids:
   * notes match by guid).
   */
  const TRIPLE = () => {
    const fx = fixtureOf('verbs');
    const models = fx.col.models.replace(/\{\{(CaseInfo|Conjugation)\}\}/g, '{{{$1}}}');
    return collectionFromRows({ ...rowsOf(fx), col: { ...fx.col, models } });
  };
  const BUNDLED = () => collectionFromRows(rowsOf(fixtureOf('verbs')));
  const BUNDLED_VERSION = DECKS[2].version;

  test('only the template text differs → "Already up to date.": the same card type, notes and directions', () => {
    const triple = TRIPLE();
    expect(triple.models['2710131000'].tmpls[1].qfmt).toContain('Hint: {{{CaseInfo}}}');
    const lib = apply(emptyLib(), planStarterDeckFrom(PACK_V3, 'verbs', emptyLib(), triple, ctx('v3')).plan);
    expect(installedStarterVersions(pack, lib).get('verbs')).toBe(3);
    const row = starterDeckRows(pack, lib.decks).find((r) => r.starter.key === 'verbs')!;
    expect(starterRowAction(row, 3, undefined)).toBe('update');

    const again = planStarterDeckFrom(pack, 'verbs', lib, BUNDLED(), ctx('now'));
    expect(again.kind).toBe('upToDate');
    expect(again.plan.noteTypes).toMatchObject({ add: [], upgrade: [] });
    expect(again.plan.notes).toMatchObject({ add: [], update: [], retire: [] });
    expect(again.plan.cards.add).toEqual([]);
    expect(again.plan.summary).toMatchObject({ notesUpdated: 0, notesUnchanged: 20, cardTypesUpdated: 0, notesRetired: 0 });
    // The sheet remembers the bundled version for this deck, and the row says "Add again".
    expect(confirmsBundledVersion({ kind: again.kind, deckId: again.existingDeckId, saved: null })).toBe(true);
    expect(starterRowAction(row, 3, BUNDLED_VERSION)).toBe('again');
    // The card type keeps the old template text; both forms read the same.
    const type = lib.noteTypes[0];
    expect(type.templates[1].qfmt).toContain('Hint: {{{CaseInfo}}}');
    expect(type.templates[1].prompt.map((i) => type.fields[i].name)).toEqual(['Meaning', 'CaseInfo']);
  });
});

describe('one starter task at a time (the snackbar retry respects the busy guard)', () => {
  test('a second task while one runs does not run; after it ends, the next one runs', async () => {
    const seen: (string | null)[] = [];
    const guard = starterTaskGuard((key) => seen.push(key));
    let release!: () => void;
    const ran: string[] = [];
    const first = guard.run('vocabulary', async () => {
      ran.push('vocabulary');
      await new Promise<void>((resolve) => (release = resolve));
    });
    expect(guard.running()).toBe('vocabulary');
    // A snackbar "Try again" / "Add as a new deck" of an EARLIER add, tapped now.
    await expect(guard.run('grammar', async () => void ran.push('grammar'))).resolves.toBe(false);
    expect(ran).toEqual(['vocabulary']);
    release();
    await expect(first).resolves.toBe(true);
    expect(guard.running()).toBeNull();
    await expect(guard.run('grammar', async () => void ran.push('grammar'))).resolves.toBe(true);
    expect(ran).toEqual(['vocabulary', 'grammar']);
    expect(seen).toEqual(['vocabulary', null, 'grammar', null]);
  });

  test('a task that throws frees the guard and passes the error on', async () => {
    const guard = starterTaskGuard();
    await expect(
      guard.run('verbs', async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(guard.running()).toBeNull();
    await expect(guard.run('verbs', async () => {})).resolves.toBe(true);
  });

  test('the busy message names the deck that is still being added', () => {
    expect(STARTER_AGAIN_COPY.busy('German verbs')).toBe('Still adding German verbs. Try again when it is done.');
  });
});

describe("onboarding's progress lines and summary", () => {
  /** The two ImportResult numbers the line reads (the rest does not matter here). */
  const result = (cardsAdded: number, markedKnown: number) =>
    ({ cardsAdded, markedKnown }) as unknown as NonNullable<Parameters<typeof starterOutcomeLine>[0]['result']>;

  test('one line per outcome; every count uses plural()', () => {
    expect(starterOutcomeLine({ kind: 'add', result: result(13690, 1162), images: 'none', elsewhereDecks: [] })).toBe(
      '13,690 cards added · 1,162 cards marked Known',
    );
    expect(starterOutcomeLine({ kind: 'add', result: result(1, 0), images: 'none', elsewhereDecks: [] })).toBe('1 card added');
    expect(starterOutcomeLine({ kind: 'update', result: result(0, 0), images: 'none', elsewhereDecks: [] })).toBe(
      'Updated · your progress is kept',
    );
    expect(starterOutcomeLine({ kind: 'upToDate', result: null, images: 'none', elsewhereDecks: [] })).toBe('Already up to date.');
    expect(
      starterOutcomeLine({
        kind: 'elsewhere',
        result: null,
        images: 'none',
        elsewhereDecks: [{ deckId: 'u', deckName: 'Unfiled cards', notes: 3 }],
      }),
    ).toBe('Already in Unfiled cards');
    expect(starterOutcomeLine({ kind: 'add', result: result(2, 0), images: 'failed', elsewhereDecks: [] })).toBe(
      '2 cards added · Some images were not saved.',
    );
  });

  test('the summary snackbar', () => {
    expect(starterRunSummary(3, 0, 1162)).toBe('Added 3 starter decks. 1,162 cards marked Known (easier levels).');
    expect(starterRunSummary(3, 0, 0)).toBe('Added 3 starter decks.');
    expect(starterRunSummary(2, 1, 1)).toBe(
      "Added 2 starter decks. 1 card marked Known (easier levels). 1 starter deck could not be added. Try again from Today's + button.",
    );
    expect(starterRunSummary(0, 3, 0)).toBe("3 starter decks could not be added. Try again from Today's + button.");
    expect(starterRunSummary(2, 0, 0, 1)).toBe('Added 2 starter decks. 1 starter deck added but not saved yet.');
  });
});

/* ======================================================= review round 1 */

describe('the import screen uses the pack presets too (spec §5.1, §5.3 rule 1)', () => {
  test('German_Grammar.apkg picked as a FILE: the question is the English term (not a guessed language)', () => {
    const collection = collectionFromRows(rowsOf(fixtureOf('grammar')));
    // What the import screen's first guess is, with the pack presets.
    const fields = new Map(suggestMapping(collection, pack.cardTypePresets).types[0].fields.map((f) => [f.name, f]));
    expect(fields.get('Question')).toMatchObject({ role: 'term', lang: 'en-US' });
    expect(fields.get('Answer')).toMatchObject({ role: 'meaning', lang: 'en-US' });
    expect(fields.get('Example')).toMatchObject({ role: 'example', lang: 'de-DE' });
    // Without the presets (the screen's call before the fix) the question has no English voice.
    const bare = suggestMapping(collection).types[0].fields.find((f) => f.name === 'Question');
    expect(bare?.lang).not.toBe('en-US');
  });

  test('German_Verbs.apkg picked as a file: the labels and the multi-value "Verb type" filter', () => {
    const collection = collectionFromRows(rowsOf(fixtureOf('verbs')));
    const fields = new Map(suggestMapping(collection, pack.cardTypePresets).types[0].fields.map((f) => [f.name, f]));
    expect(fields.get('Prateritum')).toMatchObject({ role: 'detail', label: 'Präteritum' });
    expect(fields.get('CaseInfo')).toMatchObject({ role: 'detail', label: 'Case / preposition' });
    expect(fields.get('Tags')).toMatchObject({ role: 'badge', multiSep: ',', label: 'Verb type' });
    const vocab = collectionFromRows(rowsOf(fixtureOf('vocabulary')));
    const vocabFields = new Map(suggestMapping(vocab, pack.cardTypePresets).types[0].fields.map((f) => [f.name, f]));
    expect(vocabFields.get('VerbForms')).toMatchObject({ role: 'detail', label: 'Verb forms' });
  });

  test('an OLD German_Vocabulary.apkg (version 2) picked as a file: "MarankiExample" is an example that reads "Example" (L3 / R6)', () => {
    // No preset names it any more (version 3 has no such field): the general rules do.
    const vocab = collectionFromRows(rowsOf(ankiFixture('german_vocabulary_v2')));
    const fields = new Map(suggestMapping(vocab, pack.cardTypePresets).types[0].fields.map((f) => [f.name, f]));
    const field = fields.get('MarankiExample')!;
    expect(field.role).toBe('example');
    expect(fieldDisplayLabel(field)).toBe('Example');
  });

  test("src/app/import.tsx gives the build's presets to EVERY suggestMapping call", () => {
    const source = fs.readFileSync(path.join(SRC, 'app', 'import.tsx'), 'utf8');
    const calls = [...source.matchAll(/suggestMapping\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toMatch(/,\s*activePack\.cardTypePresets$/);
    expect(source).toContain("import { activePack } from '@/variants';");
  });
});

describe("onboarding's \"Try again\" after a failed save keeps what the first try did", () => {
  const vocab = pack.starterDecks.find((s) => s.key === 'vocabulary')!;
  type Outcome = Pick<StarterDeckOutcome, 'kind' | 'result' | 'deckId' | 'images' | 'elsewhereDecks'>;
  const firstAdd: Outcome = { kind: 'add', result: importResult(13690, 1101), deckId: 'd-v', images: 'none', elsewhereDecks: [] };
  // The deck is in memory now, so the second add changes nothing.
  const nothingNew: Outcome = { kind: 'upToDate', result: null, deckId: 'd-v', images: 'none', elsewhereDecks: [] };
  const writeFailed = { ok: false as const, reason: 'write' as const };

  test('the first try is applied but not saved: "failed", and the try is kept on the row', () => {
    const row = starterRunRowAfter(starterRunRow(vocab), firstAdd, writeFailed);
    expect(row.status).toBe('failed');
    expect(row.line).toBe('Your cards were added, but saving failed. Maranki will try again.');
    expect(row.unsaved).toEqual({
      kind: 'add',
      cardsAdded: 13690,
      markedKnown: 1101,
      images: 'none',
      deckIds: ['d-v'],
      elsewhereDecks: [],
    });
  });

  test('"Try again" only saves: the line still says what was added, and the Known count is kept', () => {
    const failed = starterRunRowAfter(starterRunRow(vocab), firstAdd, writeFailed);
    const row = starterRunRowAfter(failed, nothingNew, { ok: true });
    expect(row).toMatchObject({
      status: 'added',
      line: '13,690 cards added · 1,101 cards marked Known',
      deckIds: ['d-v'],
      markedKnown: 1101,
      unsaved: null,
    });
    // The bug: the old row said "Already up to date." and lost the 1,101.
    expect(row.line).not.toContain('Already up to date.');
  });

  test('a save that fails again keeps the first try; images skipped first and written later are not a warning', () => {
    const once = starterRunRowAfter(starterRunRow(vocab), { ...firstAdd, images: 'skipped' }, writeFailed);
    const twice = starterRunRowAfter(once, { ...nothingNew, images: 'skipped' }, { ok: false, reason: 'blocked' });
    expect(twice.status).toBe('failed');
    expect(twice.line).toBe('Your cards were added, but they could not be saved on this phone.');
    expect(twice.unsaved?.cardsAdded).toBe(13690);
    expect(twice.unsaved?.markedKnown).toBe(1101);
    const done = starterRunRowAfter(twice, { ...nothingNew, images: 'written' }, { ok: true });
    expect(done.line).toBe('13,690 cards added · 1,101 cards marked Known');
  });

  test('a row with nothing kept works as before (one try, saved)', () => {
    expect(starterRunRowAfter(starterRunRow(vocab), firstAdd, { ok: true })).toMatchObject({
      status: 'added',
      line: '13,690 cards added · 1,101 cards marked Known',
      markedKnown: 1101,
      unsaved: null,
    });
    expect(starterRunRowAfter(starterRunRow(vocab), nothingNew, null)).toMatchObject({
      status: 'added',
      line: 'Already up to date.',
      markedKnown: 0,
    });
  });

  test('a new run (another level) starts with the kept try of the last run', () => {
    const kept: StarterTry = { kind: 'add', cardsAdded: 5, markedKnown: 2, images: 'none', deckIds: ['d-v'], elsewhereDecks: [] };
    const row = starterRunRow(vocab, kept);
    expect(row).toEqual({ starter: vocab, status: 'waiting', line: '', deckIds: [], markedKnown: 0, unsaved: kept });
    expect(starterRunRowAfter(row, nothingNew, { ok: true }).line).toBe('5 cards added · 2 cards marked Known');
  });

  test('"Continue" counts an unsaved deck as added but not saved yet, never as "could not be added"', () => {
    const [grammar, verbs] = [pack.starterDecks[1], pack.starterDecks[2]];
    const added = starterRunRowAfter(starterRunRow(vocab), firstAdd, { ok: true });
    const unsaved = starterRunRowAfter(
      starterRunRow(grammar),
      { kind: 'add', result: importResult(906, 7), deckId: 'd-g', images: 'none', elsewhereDecks: [] },
      writeFailed,
    );
    const missing: StarterRunRow = { ...starterRunRow(verbs), status: 'failed', line: 'Could not be added.' };
    const counts = starterRunCounts([added, unsaved, missing]);
    expect(counts).toEqual({ added: 1, unsaved: 1, missing: 1, markedKnown: 1108, deckIds: ['d-v', 'd-g'] });
    expect(starterRunSummary(counts.added, counts.missing, counts.markedKnown, counts.unsaved)).toBe(
      'Added 1 starter deck. 1 starter deck added but not saved yet. 1,108 cards marked Known (easier levels). ' +
        "1 starter deck could not be added. Try again from Today's + button.",
    );
    // Only saves failed: nothing is missing.
    expect(starterRunCounts([added, unsaved]).missing).toBe(0);
  });
});

/* ======================================================= review round 2 */

describe('a try that throws after a kept unsaved try says "not saved yet", never "Could not be added."', () => {
  const vocab = pack.starterDecks.find((s) => s.key === 'vocabulary')!;
  const kept: StarterTry = { kind: 'add', cardsAdded: 13690, markedKnown: 0, images: 'none', deckIds: ['d-v'], elsewhereDecks: [] };

  test('a new run (another level): the row starts with the kept try and an empty line, then its try throws', () => {
    const threw = starterRunRowThrew(starterRunRow(vocab, kept));
    expect(threw).toMatchObject({ status: 'failed', line: 'Added, but not saved yet.', unsaved: kept });
    // The screen counts it as "not saved yet" (title "Some decks are not saved yet"): the line agrees.
    expect(starterRunCounts([threw])).toMatchObject({ added: 0, unsaved: 1, missing: 0, deckIds: ['d-v'] });
    expect(threw.line).not.toBe(STARTER_RUN_LINE.failed);
  });

  test('the same run ("Try again"): the save warning of the failed save stays on the line', () => {
    const failedSave = starterRunRowAfter(
      starterRunRow(vocab),
      { kind: 'add', result: importResult(13690, 0), deckId: 'd-v', images: 'none', elsewhereDecks: [] },
      { ok: false, reason: 'write' },
    );
    const threw = starterRunRowThrew(failedSave);
    expect(threw.status).toBe('failed');
    expect(threw.line).toBe('Your cards were added, but saving failed. Maranki will try again.');
    expect(threw.unsaved).toEqual(failedSave.unsaved);
  });

  test('nothing kept: "Could not be added." (the deck is not in the library), counted as missing', () => {
    const threw = starterRunRowThrew(starterRunRow(vocab));
    expect(threw).toMatchObject({ status: 'failed', line: 'Could not be added.', unsaved: null });
    expect(starterRunCounts([threw])).toMatchObject({ unsaved: 0, missing: 1 });
    expect(STARTER_RUN_LINE).toEqual({ failed: 'Could not be added.', unsaved: 'Added, but not saved yet.' });
  });
});

describe('a re-add after a failed save saves first: no "Already up to date." and no confirm until it is on the disk', () => {
  const failed = { ok: false as const, reason: 'write' as const };

  test('"Update" → the save fails; the next tap changes nothing, so the sheet saves again before it answers', async () => {
    const flush = jest.fn(async (): Promise<FlushResult> => failed);
    const saved: string[] = [];
    const memory = checkedVersions(new Map(), (text) => saved.push(text));
    /** What the sheet does with an add's outcome: settle the save, then confirm (or not). */
    const answer = async (outcome: Pick<StarterDeckOutcome, 'kind' | 'deckId' | 'saved'>) => {
      const settled = await withSettledSave(outcome, flush);
      if (confirmsBundledVersion(settled) && settled.deckId !== null) memory.confirm(settled.deckId, 2, ['d-v']);
      return settled.saved.ok ? 'Already up to date.' : saveWarning(settled.saved);
    };

    // 1) "Update German vocabulary": applied, its own save failed → no second flush, no confirm.
    expect(await answer({ kind: 'update', deckId: 'd-v', saved: failed })).toBe(
      'Your cards were added, but saving failed. Maranki will try again.',
    );
    expect(flush).not.toHaveBeenCalled();
    // 2) The row still says "Update"; tap it again. Nothing more to change, so the add saved
    //    nothing (saved null) — the bug: that counted as "saved". Now the sheet flushes first.
    expect(await answer({ kind: 'upToDate', deckId: 'd-v', saved: null })).toBe(
      'Your cards were added, but saving failed. Maranki will try again.',
    );
    expect(flush).toHaveBeenCalledTimes(1);
    // Still only in memory: nothing is remembered on the device, so "Update" stays after a restart.
    expect(memory.get().size).toBe(0);
    expect(saved).toEqual([]);
    // 3) The save works now: "Already up to date.", and version 2 is remembered.
    flush.mockResolvedValueOnce({ ok: true });
    expect(await answer({ kind: 'upToDate', deckId: 'd-v', saved: null })).toBe('Already up to date.');
    expect([...memory.get()]).toEqual([['d-v', 2]]);
  });

  test('an outcome with its own save keeps it (no second flush); the rest of the outcome is unchanged', async () => {
    const flush = jest.fn(async (): Promise<FlushResult> => ({ ok: true }));
    const outcome = { kind: 'add' as const, deckId: 'd-v', saved: { ok: true as const }, images: 'none' as const };
    await expect(withSettledSave(outcome, flush)).resolves.toEqual(outcome);
    expect(flush).not.toHaveBeenCalled();
    await expect(withSettledSave({ ...outcome, kind: 'upToDate' as const, saved: null }, flush)).resolves.toEqual({
      ...outcome,
      kind: 'upToDate',
      saved: { ok: true },
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe('the confirmed version is kept on this device (a restart does not bring "Update" back)', () => {
  beforeEach(() => {
    mockKv.items.clear();
    mockKv.failRead = false;
    mockKv.failWrite = false;
  });

  test('the saved text is a list of pairs; a broken or strange text gives nothing', () => {
    const map = new Map([
      ['d-1', 2],
      ['__proto__', 3],
    ]);
    const text = serializeCheckedVersions(map);
    expect(text).toBe('[["d-1",2],["__proto__",3]]');
    expect([...parseCheckedVersions(text)]).toEqual([...map]);
    for (const bad of [null, '', 'oops', '{"d-1":2}', '[["d-1","2"]]', '[["d-1",0]]', '[["",1]]', '[["d-1",1.5]]', '[1]']) {
      expect(parseCheckedVersions(bad).size).toBe(0);
    }
    expect([...parseCheckedVersions('[["d-1",2],"x",["d-2",1]]')]).toEqual([
      ['d-1', 2],
      ['d-2', 1],
    ]);
  });

  test('confirm() remembers the version, forgets deleted decks, and saves', () => {
    const saved: string[] = [];
    const memory = checkedVersions(new Map([['d-gone', 1]]), (text) => saved.push(text));
    expect([...memory.confirm('d-v', 2, ['d-v', 'd-g'])]).toEqual([['d-v', 2]]);
    expect([...memory.confirm('d-g', 1, ['d-v', 'd-g'])]).toEqual([
      ['d-v', 2],
      ['d-g', 1],
    ]);
    expect(memory.get().get('d-v')).toBe(2);
    expect(saved).toEqual(['[["d-v",2]]', '[["d-v",2],["d-g",1]]']);
  });

  test('an update that only changed notes, then a restart: the row says "Add again", not "Update"', async () => {
    // This build's version is in the library; a later build bundles the next one (same notes: nothing is added).
    const next = VOCAB_VERSION + 1;
    const lib = apply(emptyLib(), planOf('vocabulary').plan);
    const update = planOf('vocabulary', lib, {}, PACK_NEXT);
    expect(update.kind).toBe('upToDate');
    const row = starterDeckRows(PACK_NEXT, lib.decks)[0];
    const installed = installedStarterVersions(PACK_NEXT, lib).get('vocabulary') ?? null;
    expect(installed).toBe(VOCAB_VERSION); // the notes still say the older version
    expect(starterRowAction(row, installed, undefined)).toBe('update');

    // The tap: the add confirms the next version for this deck, and the sheet saves it on the device.
    const outcome = { kind: update.kind, deckId: row.deckId, saved: null };
    expect(confirmsBundledVersion(outcome)).toBe(true);
    const memory = checkedVersions(readCheckedVersions(), (text) => void saveCheckedVersions(text));
    memory.confirm(row.deckId!, next, lib.decks.map((d) => d.id));
    await saveCheckedVersions(serializeCheckedVersions(memory.get()));
    expect(mockKv.items.get(STARTER_CHECKED_KEY)).toBe(`[["${row.deckId}",${next}]]`);

    // "Restart": a NEW sheet reads the device's memory.
    const afterRestart = readCheckedVersions();
    expect(starterRowAction(row, installed, afterRestart.get(row.deckId!))).toBe('again');
  });

  test('a failed read gives an empty memory; a failed write never throws (the memory works until a restart)', async () => {
    mockKv.items.set(STARTER_CHECKED_KEY, '[["d-1",2]]');
    mockKv.failRead = true;
    expect(readCheckedVersions().size).toBe(0);
    mockKv.failRead = false;
    mockKv.failWrite = true;
    await expect(saveCheckedVersions('[["d-1",3]]')).resolves.toBeUndefined();
    expect(mockKv.items.get(STARTER_CHECKED_KEY)).toBe('[["d-1",2]]');
    // The next write goes on after the failed one (the writes run one after another).
    mockKv.failWrite = false;
    await saveCheckedVersions('[["d-1",4]]');
    expect(readCheckedVersions().get('d-1')).toBe(4);
  });
});

describe('fork users who upgrade in place: a deck from before is noticed (spec §9.5)', () => {
  test('the fork decks have no sourceKey and no Anki guid: the rows say "Add", and an add would make a second copy', () => {
    const state = forkState();
    expect(state.decks.map((d) => d.name)).toEqual(expect.arrayContaining(['German Verbs', 'German Grammar']));
    expect(state.decks.every((d) => d.sourceKey === undefined)).toBe(true);
    expect(starterDeckRows(pack, state.decks).map((r) => r.deckId)).toEqual([null, null, null]);
    // Nothing matches by guid, so the planner makes a NEW deck next to the fork's own "German Verbs".
    expect(planOf('verbs', state).kind).toBe('add');
  });

  test('…so the row finds them by name and says "You may already have this deck"', () => {
    const state = forkState();
    const names = (key: DeckKey) =>
      starterLookalikes(pack.starterDecks.find((s) => s.key === key)!, state.decks).map((d) => d.name);
    expect(names('verbs')).toEqual(['German Verbs']);
    expect(names('grammar')).toEqual(['German Grammar']);
    expect(names('vocabulary')).toEqual([]); // this fork user never added it
    expect(STARTER_LOOKALIKE_COPY.note('German Verbs')).toBe('You may already have this deck: German Verbs');
    expect(STARTER_LOOKALIKE_COPY.ask('German Verbs')).toBe('You may already have this deck: German Verbs. Add a second copy?');
    expect(STARTER_LOOKALIKE_COPY.addAnyway).toBe('Add anyway');
  });

  test('case, accents and spaces are ignored; a deck WITH a sourceKey is never one of them', () => {
    const verbs = pack.starterDecks.find((s) => s.key === 'verbs')!;
    const deck = (name: string, sourceKey?: string) => ({ ...forkState().decks[0], id: name, name, sourceKey });
    const decks = [
      deck('  german   VERBS '),
      deck('German Verbs', 'file:German_Verbs.apkg'),
      deck('German Verbs', 'pack:german:verbs'),
      deck('German verbs 2'),
    ];
    expect(starterLookalikes(verbs, decks).map((d) => d.id)).toEqual(['  german   VERBS ']);
  });
});

describe('an "Add" of a NEW starter deck follows decision D3 (spec §5.9)', () => {
  /**
   * A phone for the sheet's ONE add (`addStarterOnce`): the library (`apply`
   * is the reducer's applyImport, enough here), the applied plans, and how
   * often the bundled file is loaded.
   */
  const phone = (start: Lib = emptyLib()) => {
    let lib = start;
    const applied: ImportPlan[] = [];
    const loadBytes = jest.fn(async () => new Uint8Array([1, 2, 3]));
    let n = 0;
    const deps: StarterDeps = {
      getState: () => lib,
      applyImport: (plan) => {
        applied.push(plan);
        lib = apply(lib, plan);
        return { deckId: plan.deck?.id ?? null, cardsAdded: plan.cards.add.length, markedKnown: 0, media: plan.media } as unknown as ImportResult;
      },
      flush: async () => ({ ok: true }),
      writeMedia: async () => {},
      now: () => FIXED_NOW,
      newId: () => `id-${++n}`,
      loadBytes,
    };
    return { deps, applied, loadBytes, lib: () => lib };
  };
  /**
   * The vocabulary fixture as a BIGGER file (its notes and cards copied
   * `copies` times, with new ids and guids), so a new deck has more than
   * 1,000 new cards, like the real German_Vocabulary.apkg.
   */
  const bigVocabulary = (copies: number): AnkiCollection => {
    const rows = rowsOf(fixtureOf('vocabulary'));
    const notes: ApkgRows['notes'] = [];
    const cards: ApkgRows['cards'] = [];
    for (let k = 0; k < copies; k++) {
      const shift = k * 1_000_000;
      for (const n of rows.notes as unknown as ApkgRows['notes']) notes.push({ ...n, id: Number(n.id) + shift, guid: `${n.guid}~${k}` });
      for (const c of rows.cards as unknown as ApkgRows['cards']) cards.push({ ...c, id: Number(c.id) + shift, nid: Number(c.nid) + shift });
    }
    return collectionFromRows({ ...rows, notes, cards } as ApkgRows);
  };
  /** The real planner, counting its plans and the arrival each one was made with. */
  const countingPlanner = () => {
    const arrivals: (string | undefined)[] = [];
    const plan: typeof planStarterDeckFrom = (...args) => {
      arrivals.push(args[5]?.arrival);
      return planStarterDeckFrom(...args);
    };
    return { plan, arrivals };
  };

  test('more than 1,000 new cards → Not started; 1,000 or fewer → the study queue; no new deck → the deck decides', () => {
    expect(starterArrivalFor({ kind: 'add', plan: { summary: { newCards: 13690 } } })).toBe('notStarted');
    expect(starterArrivalFor({ kind: 'add', plan: { summary: { newCards: 1001 } } })).toBe('notStarted');
    expect(starterArrivalFor({ kind: 'add', plan: { summary: { newCards: 1000 } } })).toBe('queued');
    expect(starterArrivalFor({ kind: 'add', plan: { summary: { newCards: 906 } } })).toBe('queued');
    for (const kind of ['update', 'upToDate', 'elsewhere'] as const) {
      expect(starterArrivalFor({ kind, plan: { summary: { newCards: 5000 } } })).toBeUndefined();
    }
  });

  // Wave 5d (F1c): the old probe (`withStarterArrival`, AddSheet.tsx) read and planned the file a
  // second time BEFORE the add, and only a test still called it (the sheet stopped in wave 5b).
  // It was deleted. These tests pin the sheet's ONE add (`addStarterOnce`) on the German pack instead.
  test('the sheet’s add of a BIG new German deck: the file is loaded, read and planned ONCE; every new card Not started', async () => {
    const big = bigVocabulary(26); // more than 1,000 new cards, like the real vocabulary file
    const p = phone();
    const read = jest.fn(async () => big);
    const planner = countingPlanner();
    const run = await addStarterOnce(pack, 'vocabulary', p.deps, {}, read, planner.plan);
    expect(p.loadBytes).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(planner.arrivals).toEqual(['notStarted']); // ONE plan, with the arrival of D3
    expect(run.arrival).toBe('notStarted');
    expect(run.outcome).toMatchObject({ kind: 'add', saved: { ok: true } });
    expect(p.applied).toHaveLength(1);
    const plan = p.applied[0];
    expect(plan.summary.newCards).toBeGreaterThan(1000);
    expect(plan.cards.add.every((c) => c.newState === 'notStarted')).toBe(true);
    expect(plan.deck?.sourceKey).toBe('pack:german:vocabulary');
    // …so the snackbar offers "Choose what to learn" over the new deck's Not started cards.
    expect(starterChooseQuery(run.outcome, run.arrival)).toEqual({ decks: [plan.deck!.id], life: ['notStarted'], notFlags: ['suspended'] });
  });

  test('a SMALL new German deck (the fixture): the study queue; "Add as a new deck" keeps its own options', async () => {
    const small = collectionFromRows(rowsOf(fixtureOf('grammar')));
    const p = phone();
    const planner = countingPlanner();
    const run = await addStarterOnce(pack, 'grammar', p.deps, {}, async () => small, planner.plan);
    expect([run.arrival, planner.arrivals]).toEqual(['queued', ['queued']]);
    expect(p.applied[0].cards.add.every((c) => c.newState === 'queued')).toBe(true);
    // "Add as a new deck" (copies): the same add, the caller's other options kept.
    const copy = phone();
    const copyPlanner = countingPlanner();
    await addStarterOnce(pack, 'grammar', copy.deps, { elsewhere: 'copy' }, async () => small, copyPlanner.plan);
    expect(copyPlanner.arrivals).toEqual(['queued']);
    expect(copy.applied).toHaveLength(1);
  });

  test('no D3 when the caller chose (onboarding: Not started) or the deck is already there (its own setting decides)', async () => {
    const small = collectionFromRows(rowsOf(fixtureOf('grammar')));
    // Onboarding chooses: its arrival, even for a small deck.
    const chosen = phone();
    const run = await addStarterOnce(pack, 'grammar', chosen.deps, { arrival: 'notStarted' }, async () => small);
    expect(run.arrival).toBe('notStarted');
    expect(chosen.applied[0].cards.add.every((c) => c.newState === 'notStarted')).toBe(true);
    // The deck is there: "Add again" plans no arrival of its own (undefined), and adds nothing new.
    const again = phone(chosen.lib());
    const planner = countingPlanner();
    const second = await addStarterOnce(pack, 'grammar', again.deps, {}, async () => small, planner.plan);
    expect(planner.arrivals.every((a) => a === undefined)).toBe(true);
    expect(second.outcome.kind).toBe('upToDate');
    expect(second.arrival).toBeUndefined();
  });

  test('a file that cannot be loaded stops before anything is read, planned or applied', async () => {
    const p = phone();
    p.deps.loadBytes = async () => Promise.reject(new Error('gone'));
    const read = jest.fn(async () => collectionFromRows(rowsOf(fixtureOf('vocabulary'))));
    const planner = countingPlanner();
    await expect(addStarterOnce(pack, 'vocabulary', p.deps, {}, read, planner.plan)).rejects.toThrow('gone');
    expect(read).not.toHaveBeenCalled();
    expect(planner.arrivals).toEqual([]);
    expect(p.applied).toEqual([]);
  });

  test('on the deck fixture: "notStarted" makes every new card Not started, and the deck keeps it for later cards', () => {
    const planned = planOf('vocabulary', emptyLib(), { arrival: 'notStarted' });
    expect(planned.plan.cards.add.every((c) => c.newState === 'notStarted')).toBe(true);
    expect(planned.plan.deck?.options.newArrival).toBe('notStarted');
  });

  test('then the snackbar offers "Choose what to learn" over the Not started cards of the new deck', () => {
    expect(starterChooseQuery({ kind: 'add', deckId: 'd-v' }, 'notStarted')).toEqual({
      decks: ['d-v'],
      life: ['notStarted'],
      notFlags: ['suspended'],
    });
    expect(starterChooseQuery({ kind: 'add', deckId: 'd-v' }, 'queued')).toBeNull();
    expect(starterChooseQuery({ kind: 'add', deckId: 'd-v' }, undefined)).toBeNull();
    expect(starterChooseQuery({ kind: 'upToDate', deckId: 'd-v' }, 'notStarted')).toBeNull();
    expect(starterChooseQuery({ kind: 'add', deckId: null }, 'notStarted')).toBeNull();
    expect(STARTER_CHOOSE_COPY).toEqual({ notStarted: 'They start as Not started.', choose: 'Choose what to learn' });
  });
});

/* ================================================================ the build */

describe('app.config.ts (the two variants)', () => {
  const savedVariant = process.env.APP_VARIANT;
  afterEach(() => {
    if (savedVariant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = savedVariant;
  });

  const appJson = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')) as { expo: Record<string, unknown> };

  /** The config Expo would build with this APP_VARIANT (undefined = not set), from the real app.json. */
  function configFor(variant: string | undefined) {
    if (variant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = variant;
    const base = appJson().expo;
    const frozen = JSON.parse(JSON.stringify(base)) as typeof base;
    const out = appConfig({
      config: base,
      projectRoot: ROOT,
      staticConfigPath: path.join(ROOT, 'app.json'),
      packageJsonPath: path.join(ROOT, 'package.json'),
    });
    // The static base is never changed in place.
    expect(base).toEqual(frozen);
    return out;
  }

  test('not set or generic → Maranki, com.omrylmz.maranki, scheme maranki', () => {
    for (const variant of [undefined, 'generic']) {
      const config = configFor(variant);
      expect(config).toMatchObject({ name: 'Maranki', slug: 'maranki', scheme: 'maranki', icon: './assets/images/icon.png' });
      expect(config.android?.package).toBe('com.omrylmz.maranki');
      expect(config.ios?.bundleIdentifier).toBe('com.omrylmz.maranki');
      expect(config.extra?.variant).toBe('generic');
    }
  });

  test('german → Maranki German, com.omrylmz.marankide (the fork package: in-place upgrade), scheme marankide', () => {
    const config = configFor('german');
    expect(config).toMatchObject({ name: 'Maranki German', slug: 'maranki', scheme: 'marankide' });
    expect(config.android?.package).toBe('com.omrylmz.marankide');
    expect(config.ios?.bundleIdentifier).toBe('com.omrylmz.marankide');
    expect(config.extra?.variant).toBe('german');
    // The generic icon files (the fork's icon was byte-identical; RELEASING.md).
    expect(config.icon).toBe('./assets/images/icon.png');
  });

  test('everything else comes from app.json unchanged (plugins, icons, splash, experiments)', () => {
    const base = appJson().expo as Record<string, Record<string, unknown>>;
    const config = configFor('german') as unknown as Record<string, Record<string, unknown>>;
    expect(config.plugins).toEqual(base.plugins);
    expect(config.experiments).toEqual(base.experiments);
    expect(config.android.adaptiveIcon).toEqual(base.android.adaptiveIcon);
    expect(config.ios.icon).toEqual(base.ios.icon);
    expect(config.version).toBe(base.version);
  });

  test('app.json is the static base: the per-variant fields live only in app.config.ts', () => {
    const base = appJson().expo as Record<string, Record<string, unknown> | unknown>;
    for (const key of ['name', 'slug', 'scheme', 'icon']) expect(base).not.toHaveProperty(key);
    expect(base.ios).not.toHaveProperty('bundleIdentifier');
    expect(base.android).not.toHaveProperty('package');
  });

  test('an unknown APP_VARIANT stops the build (also names that are keys of every object)', () => {
    expect(variantOf(undefined)).toBe('generic');
    expect(variantOf('german')).toBe('german');
    for (const bad of ['klingon', '', 'German', 'constructor', '__proto__', 'toString']) {
      expect(() => variantOf(bad)).toThrow(`Unknown APP_VARIANT "${bad}". Use one of: generic, german.`);
      expect(() => configFor(bad)).toThrow('Unknown APP_VARIANT');
    }
  });

  test('every variant has a pack file whose id is the variant, so the run-time check passes', () => {
    expect(Object.keys(VARIANTS)).toEqual(['generic', 'german']);
    const packs: Record<string, ContentPack> = { generic: genericPack, german: pack };
    for (const id of Object.keys(VARIANTS)) {
      expect(fs.existsSync(path.join(SRC, 'variants', id, 'pack.ts'))).toBe(true);
      const config = configFor(id);
      const warn = jest.fn();
      expect(choosePack(packs[id], configuredVariant(config.extra), { dev: true, fallback: genericPack, warn })).toBe(packs[id]);
      expect(warn).not.toHaveBeenCalled();
    }
  });
});

describe('metro.config.js with APP_VARIANT=german', () => {
  const savedVariant = process.env.APP_VARIANT;
  afterEach(() => {
    if (savedVariant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = savedVariant;
  });

  test('@variant/pack → src/variants/german/pack.ts (through Metro\'s own resolver)', () => {
    process.env.APP_VARIANT = 'german';
    type Resolve = (ctx: unknown, moduleName: string, platform: string | null) => unknown;
    let config: { resolver: { assetExts: string[]; resolveRequest: Resolve } } | undefined;
    jest.isolateModules(() => {
      jest.doMock('expo/metro-config', () => ({ getDefaultConfig: () => ({ resolver: { assetExts: ['png'] } }) }));
      config = jest.requireActual(path.join(ROOT, 'metro.config.js'));
    });
    const calls: string[] = [];
    const context = {
      resolveRequest: (_ctx: unknown, name: string) => {
        calls.push(name);
        return { type: 'sourceFile', filePath: name };
      },
    };
    const file = path.join(SRC, 'variants', 'german', 'pack.ts');
    expect(config!.resolver.resolveRequest(context, '@variant/pack', 'android')).toEqual({ type: 'sourceFile', filePath: file });
    expect(calls).toEqual([file]);
    expect(config!.resolver.assetExts).toContain('apkg');
  });
});

describe('scripts and the release workflow', () => {
  const scripts = () =>
    (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

  /**
   * Runs the package.json script `name` with `sh` in an empty folder, with a
   * FAKE `expo` first on the PATH: it only writes down how it was called
   * ("APP_VARIANT=… EXPO_NO_GIT_STATUS=… expo <args>"), and `expo prebuild`
   * exits with `prebuildExit`. `applicationId` = the id in the folder's
   * android/app/build.gradle (what the last prebuild wrote), or null = no
   * android/ folder. Returns the calls, in order.
   */
  function runScript(name: string, applicationId: string | null, prebuildExit = 0): string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maranki-script-'));
    try {
      const bin = path.join(dir, 'bin');
      const log = path.join(dir, 'calls.log');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'expo'),
        [
          '#!/bin/sh',
          `echo "APP_VARIANT=$APP_VARIANT EXPO_NO_GIT_STATUS=$EXPO_NO_GIT_STATUS expo $*" >> '${log}'`,
          `if [ "$1" = prebuild ]; then exit ${prebuildExit}; fi`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      if (applicationId !== null) {
        fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
        // The line as Expo's prebuild template writes it.
        fs.writeFileSync(path.join(dir, 'android', 'app', 'build.gradle'), `android {\n    defaultConfig {\n        applicationId '${applicationId}'\n    }\n}\n`);
      }
      try {
        // Only the fake `expo`, grep and sh: nothing of the real project runs.
        execFileSync('sh', ['-c', scripts()[name]], {
          cwd: dir,
          env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin` },
          stdio: 'pipe',
        });
      } catch {
        // A step that failed stops the script; the log says what ran.
      }
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('package.json: start:german clears the Metro cache', () => {
    expect(scripts()['start:german']).toBe('APP_VARIANT=german expo start --clear');
  });

  test('android / android:german: a CLEAN prebuild only when android/ is missing or made for the other variant', () => {
    for (const [name, variant, other] of [
      ['android', 'generic', 'german'],
      ['android:german', 'german', 'generic'],
    ] as const) {
      const clean = `APP_VARIANT=${variant} EXPO_NO_GIT_STATUS=1 expo prebuild -p android --clean --no-install`;
      const run = `APP_VARIANT=${variant} EXPO_NO_GIT_STATUS= expo run:android`;
      // No android/ yet → a fresh one for this variant, then the build.
      expect(runScript(name, null)).toEqual([clean, run]);
      // android/ of the OTHER variant (its package id) → deleted and made again. The git
      // prompt is off (EXPO_NO_GIT_STATUS=1): a "No" there would make prebuild stop with
      // exit code 0, and `expo run:android` would still install the other variant's package.
      expect(runScript(name, VARIANTS[other].id)).toEqual([clean, run]);
      // android/ of THIS variant → a plain prebuild (applies the config, keeps the Gradle
      // outputs, so the native code is not compiled again), then the build.
      expect(runScript(name, VARIANTS[variant].id)).toEqual([
        `APP_VARIANT=${variant} EXPO_NO_GIT_STATUS= expo prebuild -p android --no-install`,
        run,
      ]);
    }
  });

  test('android / android:german: a prebuild that fails stops the script (nothing is built or installed)', () => {
    expect(runScript('android', VARIANTS.german.id, 1)).toEqual([
      'APP_VARIANT=generic EXPO_NO_GIT_STATUS=1 expo prebuild -p android --clean --no-install',
    ]);
    expect(runScript('android:german', VARIANTS.german.id, 1)).toEqual([
      'APP_VARIANT=german EXPO_NO_GIT_STATUS= expo prebuild -p android --no-install',
    ]);
  });

  test('the lint rule allows `.apkg` asset requires in eslint.config.js; pack.ts changes no lint rule', () => {
    const source = fs.readFileSync(path.join(__dirname, 'pack.ts'), 'utf8');
    // No inline ESLint config or suppression of any kind in the pack file.
    expect(source).not.toMatch(/\/\*\s*eslint[\s-]/);
    expect(source).not.toMatch(/\/\/\s*eslint-/);
    // The app's ESLint config: Expo's asset list for `no-require-imports`, plus apkg.
    type Rule = [string, { allow?: string[] }];
    let configs: { files?: string[]; rules?: Record<string, Rule> }[] = [];
    jest.isolateModules(() => {
      configs = jest.requireActual(path.join(ROOT, 'eslint.config.js'));
    });
    const rule = configs.filter((c) => c.rules?.['@typescript-eslint/no-require-imports']).at(-1)!.rules![
      '@typescript-eslint/no-require-imports'
    ];
    expect(rule[0]).toBe('warn');
    const allow = (rule[1].allow ?? []).map((pattern) => new RegExp(pattern));
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    expect(required).toHaveLength(3);
    for (const file of required) expect(allow.some((re) => re.test(file))).toBe(true);
    // Expo's own list is still there (png, json …), and a code file is still not allowed.
    expect(allow.some((re) => re.test('./icon.png'))).toBe(true);
    expect(allow.some((re) => re.test('./other.ts'))).toBe(false);
  });

  test('release-apk.yml builds only the generic app: a German APK on the public Releases page would give the private decks away', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-apk.yml'), 'utf8');
    expect(yml).toMatch(/variant: \[generic\]/);
    expect(yml).toMatch(/APP_VARIANT: \$\{\{ matrix\.variant \}\}/);
    expect(yml).toContain('maranki-${TAG}.apk');
    expect(yml).not.toContain('maranki-german-${TAG}.apk');
    expect(yml).not.toMatch(/variant: \[[^\]]*german/);
  });
});

/* ===================================== wave 5b: labels (walkthrough L3 / R6) */

describe('no German field shows an internal name (walkthrough L3 / R6)', () => {
  test('every field of every German card type reads well: no "Maranki" prefix, no CamelCase hump', () => {
    for (const key of DECKS.map((d) => d.key)) {
      const type = planOf(key).plan.noteTypes.add[0];
      for (const field of type.fields) {
        const label = fieldDisplayLabel(field);
        expect([field.name, label]).not.toEqual([field.name, expect.stringMatching(/^maranki/i)]);
        // A hump = a small letter right before a capital ("VerbForms").
        expect([field.name, /[a-zäöüß][A-ZÄÖÜ]/.test(label)]).toEqual([field.name, false]);
      }
    }
  });

  test('the Card sheet rows of a vocabulary card (an OLD version 2 file) say "Example", never "MarankiExample"', () => {
    const v2 = collectionFromRows(rowsOf(ankiFixture('german_vocabulary_v2')));
    const planned = planStarterDeckFrom(pack, 'vocabulary', emptyLib(), v2, ctx('v2')).plan;
    const type = planned.noteTypes.add[0];
    const ord = (name: string) => type.fields.findIndex((f) => f.name === name);
    // A note with both example fields filled.
    const note = planned.notes.add.find((n) => n.fields[ord('MarankiExample')] && n.fields[ord('Examples')]);
    expect(note).toBeDefined();
    const labels = renderFace(note!, type, 0).answer.map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(['Examples', 'Example']));
    expect(labels).not.toContain('MarankiExample');
  });

  // Wave 5d (R6): the cards read well, but fieldText.ts `fieldLabel` returned `label ?? name`, so the
  // deck page's "Card types & fields" and "Read aloud" sheets (and the import's Fields stage and
  // Preview) still said "MarankiExample" / "VerbForms" in the GENERIC build (no presets, no labels).
  test('the GENERIC build (no presets): the deck page sheets and the import name every German field like the cards do', () => {
    const files = [rowsOf(fixtureOf('vocabulary')), rowsOf(fixtureOf('verbs')), rowsOf(ankiFixture('german_vocabulary_v2'))];
    const seen = new Map<string, string>();
    for (const rows of files) {
      for (const field of suggestMapping(collectionFromRows(rows), genericPack.cardTypePresets).types[0].fields) {
        // ONE label rule: the sheets (fieldLabel) say what the cards say (fieldDisplayLabel).
        expect([field.name, fieldLabel(field)]).toEqual([field.name, fieldDisplayLabel(field)]);
        expect([field.name, /[a-zäöüß][A-ZÄÖÜ]/.test(fieldLabel(field))]).toEqual([field.name, false]);
        expect([field.name, /^maranki/i.test(fieldLabel(field))]).toEqual([field.name, false]);
        seen.set(field.name, fieldLabel(field));
      }
    }
    expect(seen.get('VerbForms')).toBe('Verb Forms');
    expect(seen.get('MarankiExample')).toBe('Example');
    expect(seen.get('CaseInfo')).toBe('Case Info');
  });

  test('the import Preview names its filters and placement groups readably too (readableSummary); numbers and keys stay', () => {
    const summary = planOf('verbs').plan.summary;
    const raw = {
      ...summary,
      filtersFound: ['Level', 'VerbForms', 'MarankiExample', 'Tags'],
      placementGroups: [{ facet: 'field:verbforms', label: 'VerbForms', values: ['A1', 'A2'] }],
    };
    const shown = readableSummary(raw);
    expect(shown.filtersFound).toEqual(['Level', 'Verb Forms', 'Example', 'Tags']);
    expect(shown.placementGroups).toEqual([{ facet: 'field:verbforms', label: 'Verb Forms', values: ['A1', 'A2'] }]);
    // Only the text changes: every number is the planner's, and the planner's summary is not changed.
    expect({ ...shown, filtersFound: raw.filtersFound, placementGroups: raw.placementGroups }).toEqual(raw);
    expect(raw.filtersFound).toEqual(['Level', 'VerbForms', 'MarankiExample', 'Tags']);
    // On the real German verbs plan: every filter it found reads well.
    for (const label of readableSummary(summary).filtersFound) expect([label, /[a-zäöüß][A-ZÄÖÜ]/.test(label)]).toEqual([label, false]);
    // The Preview's "Fields: … → front, … → back" line (importFile.ts fieldsLine) uses the same rule.
    expect(
      fieldsLine([
        { name: 'MarankiWord', role: 'term', facet: 'off' },
        { name: 'VerbForms', role: 'meaning', facet: 'off' },
      ]),
    ).toBe('Fields: Word → front, Verb Forms → back');
    expect(fieldsLine([{ name: 'Verb', label: 'Verb (infinitive)', role: 'term', facet: 'off' }, { name: 'Meaning', role: 'meaning', facet: 'off' }])).toBe(
      'Fields: Verb (infinitive) → front, Meaning → back',
    );
  });
});
