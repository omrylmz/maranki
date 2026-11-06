/**
 * The pure parts of the import screen (src/domain/importFile.ts).
 *
 * Today's CSV helpers: the delimiter sniffer (H5 — sample many lines, not
 * one), the header guard (L20 — a real first word must not be dropped), the
 * shared-tokeniser quote handling, and today's positional mapping
 * (0 Front · 1 Back · 2 Example · 3 Notes · 4 Tags), kept as csvRead's reference.
 *
 * The wizard (unit W3-5, spec §5.6–§5.9):
 *   - file sniffing, origin, the default target (re-import finds its deck);
 *   - the choices the Fields stage hands the planner (no prototype; Anki
 *     directions from roles.ts; none for a CSV);
 *   - "Let me choose" above 1,000 new cards and the placement block ONLY with
 *     the triage screen (TRIAGE_READY), "How should new cards start?" above 200;
 *   - every field-role edit and the CSV column choices;
 *   - every Preview line from the summary, and the Done copy from the result;
 *   - the Sections tree, the AnkiWeb row, and the image writer (fake disk and
 *     the in-memory expo-file-system of jest-expo);
 *   - end to end on the real German Verbs fixture: defaults → 40 cards, both
 *     directions; the same file again → "Already up to date"; a CSV with a
 *     header and a reverse card, imported twice;
 *   - wave 5h (I3): where a CSV picked again starts (deckPageLogic.ts
 *     `importStartPlan`, run as import.tsx runs it): only a deck that came
 *     from a FILE can be its home, never a deck made in the app or a starter
 *     pack; the walkthrough E8 fix (three-words.csv) stays.
 */
import { describe, expect, test } from '@jest/globals';
import { Directory, File, Paths } from 'expo-file-system';

import { chosenCountOf, chosenGuidsOf, importStartPlan, reimportHomeDeck } from '../components/deck/deckPageLogic';
import { FIXED_NOW } from '../test/clock';
import { ankiFixture, type AnkiFixtureName } from '../test/factories';
import { collectionFromRows } from './import/apkgRead';
import { CSV_MODEL_ID, readCsv } from './import/csvRead';
import {
  chosenNotesByMid,
  collectionSections,
  planImport,
  startingTypes,
  suggestDeckName,
  type PlanLibrary,
} from './import/plan';
import { uniqueImageName } from './import/mediaPlan';
import { expoMediaDisk, fallbackFileName, guidHomeDeck, namelessSourceKey } from './importApkg';
import {
  ankiWebDetailRows,
  ankiWebMeta,
  canImport,
  choiceTypes,
  CHOOSE_DEFAULT_ABOVE,
  csvColumnRole,
  csvFieldColumns,
  csvTagsLabel,
  defaultArrival,
  defaultTarget,
  detectDelimiter,
  detectImportKind,
  directionName,
  doneCopy,
  facetForRole,
  fieldsLine,
  filterCandidates,
  firstPlanChanges,
  formatMegabytes,
  importButtonLabel,
  importImagesHere,
  importMediaNamer,
  imagesQuestion,
  imagesWarning,
  importOrigin,
  importPlanCtx,
  isFilterOn,
  NEW_CARDS_ASK_ABOVE,
  newCardsOptions,
  overlapSkipLabel,
  reusedTypeLine,
  overlapText,
  parseImportCsv,
  prefsNeedReplan,
  prefsTarget,
  previewHeadline,
  previewRows,
  previewUpdateLine,
  renamedNotice,
  saveWarning,
  sectionsFooter,
  sectionTree,
  setBackField,
  setCsvColumnRole,
  setExampleField,
  setFieldLang,
  setFilterField,
  setFrontField,
  setShownOnBack,
  showNewCardsBlock,
  showPlacementBlock,
  sniffFileBytes,
  splitCsvRows,
  startingPrefs,
  writeImportImages,
  type ImportPrefs,
} from './importFile';
import { buildLibraryIndex } from './libraryIndex';
import { makeDeck } from './makeV3';
import type { AnkiCollection, Card, Deck, FieldDef, ImportChoices, ImportPlan, ImportSummary, Note, NoteType } from './model';
import { suggestMapping } from './roles';
import { DEFAULT_SRS } from './types';

describe('detectDelimiter — scores across lines, not just the first (H5)', () => {
  test('comma, semicolon and tab tables are each recognised', () => {
    expect(detectDelimiter('Front,Back\napple,fruit')).toBe(',');
    expect(detectDelimiter('Front;Back\napple;fruit')).toBe(';');
    expect(detectDelimiter('Front\tBack\napple\tfruit')).toBe('\t');
  });

  test('a misleading FIRST line cannot pick the wrong delimiter', () => {
    // The header has commas; every DATA row is semicolon-delimited. The old
    // single-line sniff chose ',' and then split every data row into one column.
    const csv = 'Front, Back, and notes\napple;fruit;a food\ncat;feline;an animal';
    expect(detectDelimiter(csv)).toBe(';');
  });

  test('a single-column file falls back to comma (splits nothing)', () => {
    expect(detectDelimiter('apple\ncat\nbird')).toBe(',');
  });

  test('a comma inside a value column cannot out-vote the real tab/semicolon (H5)', () => {
    // A 2-column TSV whose meaning column is a comma-separated synonym list.
    // Comma splits each row into MORE (but equally consistent) columns; the old
    // count-rewarding score chose ',', embedding a literal tab into the front.
    expect(detectDelimiter('go\tto go, to walk\nrun\tto run, to jog')).toBe('\t');
    // Two commas per row — comma would yield 3 uniform columns vs the tab's 2.
    expect(
      detectDelimiter('go\tto go, to walk, to march\nrun\tto run, to jog, to sprint'),
    ).toBe('\t');
    // Same hazard with a semicolon-delimited file.
    expect(detectDelimiter('go;to go, to walk\nrun;to run, to jog')).toBe(';');
  });

  test('the synonym-list TSV parses into clean front/back pairs (H5)', () => {
    const { payload } = parseImportCsv('go\tto go, to walk\nrun\tto run, to jog', 'verbs.tsv');
    expect(payload.map((p) => p.front)).toEqual(['go', 'run']);
    expect(payload.map((p) => p.back)).toEqual(['to go, to walk', 'to run, to jog']);
  });
});

describe('splitCsvRows — RFC-4180 quoting', () => {
  test('quoted delimiters, escaped quotes and embedded newlines are literal', () => {
    const rows = splitCsvRows('"a,b","he said ""hi""","line1\nline2"', ',');
    expect(rows).toEqual([['a,b', 'he said "hi"', 'line1\nline2']]);
  });

  test('a space after the delimiter before a quote still opens the quote (no phantom column)', () => {
    // Hand-written CSV: `Haus, "house, home"` is two values, not three.
    expect(splitCsvRows('Word, Translation\nHaus, "house, home"\nAuto,\t"car"', ',')).toEqual([
      ['Word', ' Translation'],
      ['Haus', 'house, home'],
      ['Auto', 'car'],
    ]);
    // Spaces before anything else stay in the cell (the readers trim it), and a
    // quote in the MIDDLE of a value is still a plain character.
    expect(splitCsvRows('a,  b,c "d" e', ',')).toEqual([['a', '  b', 'c "d" e']]);
    // A space delimiter: the space is the delimiter, never skipped as padding.
    expect(splitCsvRows('a "b c"', ' ')).toEqual([['a', 'b c']]);
  });
});

describe('parseImportCsv — header detection (L20)', () => {
  test('drops a real header row (first + corroborating label)', () => {
    const { payload } = parseImportCsv('Front,Back\napple,the fruit', 'deck.csv');
    expect(payload.map((p) => p.front)).toEqual(['apple']);
  });

  test('KEEPS a first data word that merely looks header-like', () => {
    // "Front" reads like a header label, but the rest of the row is data, not
    // header labels — so it's a genuine first card, not a header, and is kept.
    const { payload } = parseImportCsv('Front,the opening move\napple,the fruit', 'deck.csv');
    expect(payload.map((p) => p.front)).toEqual(['Front', 'apple']);
  });

  test('a single-column file never loses its first row', () => {
    const { payload } = parseImportCsv('Front\napple\ncat', 'deck.csv');
    expect(payload.map((p) => p.front)).toEqual(['Front', 'apple', 'cat']);
  });

  // W1-5: header labels are folded with the shared foldText (text.ts).
  test('accented header labels are recognised (Wort,Übersetzung · Término,Traducción)', () => {
    expect(parseImportCsv('Wort,Übersetzung\nHaus,house', 'de.csv').payload.map((p) => p.front)).toEqual([
      'Haus',
    ]);
    expect(
      parseImportCsv('Término;Traducción\ncasa;house', 'es.csv').payload.map((p) => p.front),
    ).toEqual(['casa']);
  });

  test('upper-case and decomposed accents in a header are folded too', () => {
    // 'Ü' as 'U' + a separate combining diaeresis (U+0308), as some exports store it.
    const decomposed = 'WORT,ÜBERSETZUNG\nHaus,house';
    expect(parseImportCsv(decomposed, 'de.csv').payload.map((p) => p.front)).toEqual(['Haus']);
  });
});

describe('parseImportCsv — column mapping', () => {
  test('maps front/back/example/notes/tags positionally', () => {
    const { payload } = parseImportCsv(
      'apple,a round fruit,I ate an apple.,Common in pies,fruit|food',
      'Fruits.csv',
    );
    expect(payload[0]).toMatchObject({
      front: 'apple',
      back: 'a round fruit',
      example: 'I ate an apple.',
      notes: 'Common in pies',
      tags: ['fruit', 'food'],
    });
  });

  test('derives the deck name from the file name', () => {
    expect(parseImportCsv('apple,fruit', 'Fruit Vocabulary.csv').name).toBe('Fruit Vocabulary');
  });
});

/* ====================================================== the wizard (W3-5) */

/* ---------------------------------------------------------------- helpers */

function fixture(name: AnkiFixtureName): AnkiCollection {
  const fx = ankiFixture(name);
  return collectionFromRows({ fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media });
}

/** An ImportSummary with every number 0, then `over`. */
function summaryOf(over: Partial<ImportSummary> = {}): ImportSummary {
  return {
    notesAdded: 0,
    cardsAdded: 0,
    sections: 0,
    filtersFound: [],
    inTargetDeck: 0,
    inOtherDecks: 0,
    notesUpdated: 0,
    notesUnchanged: 0,
    cardsUpdated: 0,
    updatedDecks: [],
    cardTypesUpdated: 0,
    notesRetired: 0,
    notesSkipped: 0,
    skipped: { alreadyHere: 0, elsewhere: 0, overlap: 0, empty: 0 },
    guidsRenamed: 0,
    overlap: [],
    progressCards: 0,
    suspended: 0,
    newCards: 0,
    notStarted: 0,
    markedKnown: 0,
    placementGroups: [],
    images: 0,
    imageBytes: 0,
    imagesFound: 0,
    imagesFoundBytes: 0,
    imagesAskFirst: false,
    audioClips: 0,
    ...over,
  };
}

const field = (name: string, role: FieldDef['role'], extra: Partial<FieldDef> = {}): FieldDef => ({
  name,
  role,
  facet: facetForRole(role),
  ...extra,
});

interface Lib {
  noteTypes: NoteType[];
  notes: Note[];
  cards: Card[];
  decks: Deck[];
}

/** What applyImport does to the four lists (enough for planning the next import). */
function apply(lib: Lib, plan: ImportPlan): Lib {
  const upd = new Map(plan.notes.update.map((u) => [u.id, u]));
  return {
    noteTypes: [...lib.noteTypes, ...plan.noteTypes.add],
    notes: [
      ...lib.notes.map((n) => {
        const u = upd.get(n.id);
        return u ? { ...n, fields: u.fields, tags: u.tags } : n;
      }),
      ...plan.notes.add,
    ],
    cards: [...lib.cards, ...plan.cards.add],
    decks: plan.deck ? [...lib.decks, plan.deck] : lib.decks,
  };
}

/** The screen's path: suggested roles → starting types → choices → plan (with the default target). */
function screenPlan(c: AnkiCollection, lib: PlanLibrary, seed: string, over: Partial<ImportPrefs> = {}): ImportPlan {
  const origin = importOrigin(
    c.csv ? { kind: 'file', fileName: c.fileName, isCsv: true } : { kind: 'file', fileName: c.fileName, isCsv: false },
  );
  const starts = startingTypes(c, suggestMapping(c), lib.noteTypes);
  const sections = new Set(collectionSections(c).map((s) => s.did));
  const name = suggestDeckName(c, sections);
  const target = defaultTarget(lib.decks, origin, { name, icon: '🗂️' });
  const prefs = { ...startingPrefs(target, { name, icon: '🗂️', decks: lib.decks }), ...over };
  const choices: ImportChoices = {
    sections,
    target: prefsTarget(prefs),
    types: choiceTypes(c, starts),
    progress: prefs.progress,
    arrival: prefs.arrival,
    elsewhere: prefs.elsewhere,
    images: prefs.images,
    skipOverlap: prefs.skipOverlap,
  };
  return planImport(c, lib, choices, importPlanCtx({ now: FIXED_NOW, seed, srs: DEFAULT_SRS, origin }));
}

const emptyLib = (): Lib => ({ noteTypes: [], notes: [], cards: [], decks: [] });

/* ---------------------------------------------------------------- files */

describe('sniffFileBytes and detectImportKind', () => {
  const bytes = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  test('a ZIP or a bare SQLite collection is an Anki package, whatever its name', () => {
    expect(sniffFileBytes(Uint8Array.of(0x50, 0x4b, 3, 4), 'document:30')).toBe('apkg');
    expect(sniffFileBytes(bytes('SQLite format 3\0'), 'msf:1000')).toBe('apkg');
    expect(sniffFileBytes(bytes(''), 'Deck.APKG')).toBe('apkg');
  });
  test('anything else is text', () => {
    expect(sniffFileBytes(bytes('Word,Meaning\nHaus,house'), 'w.csv')).toBe('text');
    expect(sniffFileBytes(bytes('P'), 'p.txt')).toBe('text');
    expect(detectImportKind('w.tsv', 'a\tb')).toBe('csv');
    expect(detectImportKind('backup.json', '{}')).toBe('unknown');
  });
  test('a word list that starts with "PK" is text, not a package (W3-5 hardening)', () => {
    // "PKW" (car) as the first word: the two letters 'PK' are not a ZIP signature.
    expect(sniffFileBytes(bytes('PKW,car\nHaus,house'), 'german.csv')).toBe('text');
    expect(sniffFileBytes(bytes('PKW,car\nHaus,house'), 'document:30')).toBe('text');
    expect(detectImportKind('german.csv', 'PKW,car\nHaus,house')).toBe('csv');
    expect(detectImportKind('document:30', 'PKW,car\nHaus,house')).toBe('csv');
    // Only the full SQLite header counts, not its first letters.
    expect(sniffFileBytes(bytes('SQLite is small,klein'), 'words.csv')).toBe('text');
    expect(sniffFileBytes(bytes('SQLi'), 'x.txt')).toBe('text');
  });
  test('every real ZIP signature is a package, also under a text name (a renamed .apkg)', () => {
    for (const third of [[3, 4], [5, 6], [7, 8]]) {
      expect(sniffFileBytes(Uint8Array.of(0x50, 0x4b, third[0], third[1], 0, 0), 'words.csv')).toBe('apkg');
    }
    expect(sniffFileBytes(Uint8Array.of(0x50, 0x4b, 3), 'short.csv')).toBe('text'); // too short to be a ZIP
    expect(sniffFileBytes(bytes('SQLite format 3\0rest'), 'words.txt')).toBe('apkg');
  });
});

describe('importOrigin and defaultTarget', () => {
  test('a file and an AnkiWeb deck get their own source and sourceKey', () => {
    expect(importOrigin({ kind: 'file', fileName: 'German.apkg', isCsv: false })).toEqual({
      kind: 'apkg',
      ref: 'German.apkg',
      sourceKey: 'file:German.apkg',
    });
    expect(importOrigin({ kind: 'file', fileName: 'w.csv', isCsv: true }).kind).toBe('csv');
    expect(importOrigin({ kind: 'ankiweb', id: '1104981491' })).toEqual({
      kind: 'ankiweb',
      ref: '1104981491',
      sourceKey: 'ankiweb:1104981491',
    });
  });

  test('wave 5g (review): a nameless pick keys the deck AND refs its items by the nameless key, never by the made-up name alone', () => {
    // The picker gave no name: the .apkg is named after its root deck ("German.apkg", made up).
    expect(importOrigin({ kind: 'file', fileName: 'German.apkg', isCsv: false }, 'file:German.apkg#1x2b9k')).toEqual({
      kind: 'apkg',
      ref: 'German.apkg#1x2b9k',
      sourceKey: 'file:German.apkg#1x2b9k',
    });
    expect(importOrigin({ kind: 'file', fileName: 'Imported deck.csv', isCsv: true }, 'file:Imported deck.csv#9z')).toEqual({
      kind: 'csv',
      ref: 'Imported deck.csv#9z',
      sourceKey: 'file:Imported deck.csv#9z',
    });
    // No key (a real name) or an empty one: as before.
    expect(importOrigin({ kind: 'file', fileName: 'German.apkg', isCsv: false }, undefined).ref).toBe('German.apkg');
    expect(importOrigin({ kind: 'file', fileName: 'German.apkg', isCsv: false }, '').sourceKey).toBe('file:German.apkg');
    // An AnkiWeb deck always has its own id.
    expect(importOrigin({ kind: 'ankiweb', id: '7' }, 'file:x#1').sourceKey).toBe('ankiweb:7');
  });

  test('the named deck first, then the deck of the same source, else a new deck', () => {
    const decks = [
      { id: 'a', sourceKey: 'file:German.apkg' },
      { id: 'b', sourceKey: undefined },
    ];
    const opts = { name: 'German', icon: '🇩🇪' };
    expect(defaultTarget(decks, { sourceKey: 'file:German.apkg' }, { ...opts, deckId: 'b' })).toEqual({ kind: 'existing', deckId: 'b' });
    expect(defaultTarget(decks, { sourceKey: 'file:German.apkg' }, { ...opts, deckId: 'gone' })).toEqual({ kind: 'existing', deckId: 'a' });
    expect(defaultTarget(decks, { sourceKey: 'file:Other.apkg' }, opts)).toEqual({ kind: 'new', name: 'German', icon: '🇩🇪' });
    expect(defaultTarget(decks, {}, opts).kind).toBe('new');
  });

  test('preferences keep the new deck and the existing deck apart; only the name and icon need no new plan', () => {
    const p = startingPrefs({ kind: 'new', name: 'German', icon: '🇩🇪' }, { name: 'x', icon: 'y', decks: [{ id: 'd1' }] });
    expect(p).toMatchObject({ targetKind: 'new', deckName: 'German', existingDeckId: 'd1', progress: 'keep', arrival: 'queued', elsewhere: 'update', images: true });
    expect(prefsTarget(p)).toEqual({ kind: 'new', name: 'German', icon: '🇩🇪' });
    expect(prefsTarget({ ...p, targetKind: 'existing' })).toEqual({ kind: 'existing', deckId: 'd1' });
    // "Existing deck" with no deck to pick → a new deck.
    expect(prefsTarget({ ...p, targetKind: 'existing', existingDeckId: null }).kind).toBe('new');
    expect(prefsNeedReplan({ deckName: 'G' })).toBe(false);
    expect(prefsNeedReplan({ deckIcon: '📚' })).toBe(false);
    expect(prefsNeedReplan({ progress: 'reset' })).toBe(true);
    expect(prefsNeedReplan({ targetKind: 'existing' })).toBe(true);
  });
});

/* ---------------------------------------------------------------- choices */

describe('choiceTypes: what the Fields stage hands the planner', () => {
  test('the record has no prototype, so a model id "__proto__" or "constructor" is an ordinary key', () => {
    const c = fixture('german_vocabulary');
    const mid = Object.keys(c.models)[0];
    // Keys from a variable: TypeScript reads `x.constructor` as Object's own property.
    const PROTO: string = '__proto__';
    const CTOR: string = 'constructor';
    const models = Object.create(null) as AnkiCollection['models'];
    models[PROTO] = c.models[mid];
    models[CTOR] = c.models[mid];
    const odd: AnkiCollection = { ...c, models };
    const fields = c.models[mid].flds.map((f) => field(f.name, 'detail'));
    const out = choiceTypes(odd, [
      { mid: '__proto__', fields, ords: [0] },
      { mid: 'constructor', fields, ords: [1] },
      { mid: 'missing', fields, ords: [0] },
    ]);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.keys(out)).toEqual(['__proto__', 'constructor']);
    expect(out[PROTO].ords).toEqual([0]);
    expect(out[CTOR].ords).toEqual([1]);
  });

  test('an Anki model gets roles.ts directions with the chosen roles; a CSV gets none', () => {
    const c = fixture('german_vocabulary');
    const starts = startingTypes(c, suggestMapping(c), []);
    const anki = choiceTypes(c, starts)[starts[0].mid];
    expect(anki.templates?.map((t) => t.ord)).toEqual([0, 1]);
    // The fields are copies: changing the choice never changes the edit.
    anki.fields[0].label = 'changed';
    expect(starts[0].fields[0].label).toBeUndefined();

    const csv = readCsv('Word,Meaning\nHaus,house', 'w.csv');
    const csvStarts = startingTypes(csv, suggestMapping(csv), []);
    expect(choiceTypes(csv, csvStarts)[CSV_MODEL_ID].templates).toBeUndefined();
    // A CSV starts with "Front → Back" only ("Also make a reverse card" adds ord 1).
    expect(csvStarts[0].ords).toEqual([0]);
  });
});

describe('new cards: defaults and blocks, gated by the triage screen (TRIAGE_READY)', () => {
  test('"Let me choose" is the default above 1,000 new cards — only when triage exists', () => {
    expect(CHOOSE_DEFAULT_ABOVE).toBe(1000);
    expect(defaultArrival(1001, true)).toBe('notStarted');
    expect(defaultArrival(1000, true)).toBe('queued');
    // Wave 3: no triage screen, so a big import never strands Not started cards.
    expect(defaultArrival(15960, false)).toBe('queued');
  });

  test('"How should new cards start?" above 200 new cards; "Where do you start?" with an ordinal group', () => {
    expect(NEW_CARDS_ASK_ABOVE).toBe(200);
    expect(showNewCardsBlock(summaryOf({ newCards: 201 }), true)).toBe(true);
    expect(showNewCardsBlock(summaryOf({ newCards: 200 }), true)).toBe(false);
    expect(showNewCardsBlock(summaryOf({ newCards: 5000 }), false)).toBe(false);
    const levels = summaryOf({ placementGroups: [{ facet: 'field:level', label: 'Level', values: ['A1', 'A2'] }] });
    expect(showPlacementBlock(levels, true)).toBe(true);
    expect(showPlacementBlock(levels, false)).toBe(false);
    expect(showPlacementBlock(summaryOf(), true)).toBe(false);
  });

  test('after the first plan: images above 50 MB wait for a yes; the D3 default with triage', () => {
    expect(firstPlanChanges(summaryOf({ imagesAskFirst: true, newCards: 10 }), false)).toEqual({ images: false });
    expect(firstPlanChanges(summaryOf({ newCards: 15960 }), true)).toEqual({ arrival: 'notStarted' });
    expect(firstPlanChanges(summaryOf({ newCards: 15960 }), false)).toEqual({});
  });

  test('the two answers name the daily new limit', () => {
    expect(newCardsOptions(10)).toEqual([
      { id: 'queued', title: 'Add all to my study queue', sub: '10 new a day, in deck order' },
      { id: 'notStarted', title: 'Let me choose what to learn', sub: 'cards start as Not started' },
    ]);
  });
});

/* ---------------------------------------------------------------- field roles */

describe('field roles on the Fields stage', () => {
  const base = [field('Word', 'term'), field('Meaning', 'meaning'), field('Grammar', 'detail'), field('Ex', 'example')];

  test('Front / Back: the chosen field takes the role; the two swap when Back becomes Front', () => {
    expect(setFrontField(base, 1).map((f) => f.role)).toEqual(['meaning', 'term', 'detail', 'example']);
    expect(setFrontField(base, 2).map((f) => f.role)).toEqual(['detail', 'meaning', 'term', 'example']);
    expect(setBackField(base, 0).map((f) => f.role)).toEqual(['meaning', 'term', 'detail', 'example']);
    // The new Front is free text: never a filter group.
    expect(setFrontField(base, 2)[2].facet).toBe('off');
    // The old Front, now a back row, may be a filter again (the data rule decides).
    expect(setFrontField(base, 2)[0].facet).toBe('auto');
    // Out of range or already so: unchanged (a copy).
    expect(setFrontField(base, 9)).toEqual(base);
    expect(setFrontField(base, 0)).not.toBe(base);
  });

  test('a badge that becomes the Front loses its multi-value separator', () => {
    const fields = [field('Tags', 'badge', { multiSep: ',' }), field('Word', 'term')];
    const next = setFrontField(fields, 0);
    expect(next[0]).toEqual({ name: 'Tags', role: 'term', facet: 'off' });
  });

  test('examples: on and off, never the Front or the Back', () => {
    expect(setExampleField(base, 2, true)[2].role).toBe('example');
    expect(setExampleField(base, 3, false)[3].role).toBe('detail');
    expect(setExampleField(base, 0, false)[0].role).toBe('term');
    expect(setExampleField(base, 1, true)[1].role).toBe('meaning');
  });

  test('shown on back: hidden keeps the filter setting; shown again restores the suggested back-row role', () => {
    const fields = [field('Word', 'term'), field('IPA', 'pronunciation'), field('Level', 'detail', { facet: 'on' })];
    const hidden = setShownOnBack(fields, 2, false);
    expect(hidden[2]).toEqual({ name: 'Level', role: 'hidden', facet: 'on' });
    expect(setShownOnBack(hidden, 2, true, 'detail')[2]).toEqual({ name: 'Level', role: 'detail', facet: 'on' });
    const ipaHidden = setShownOnBack(fields, 1, false);
    expect(setShownOnBack(ipaHidden, 1, true, 'pronunciation')[1].role).toBe('pronunciation');
    // A suggested role that is not a back row (the Front) → 'detail'.
    expect(setShownOnBack(setShownOnBack(fields, 0, false), 0, true, 'term')[0].role).toBe('detail');
  });

  test('filters: on = auto when the data rule passes, else forced on; off = off', () => {
    expect(setFilterField(base, 2, true, true)[2].facet).toBe('auto');
    expect(setFilterField(base, 2, true, false)[2].facet).toBe('on');
    expect(setFilterField(base, 2, false, true)[2].facet).toBe('off');
    expect(isFilterOn({ facet: 'auto' })).toBe(true);
    expect(isFilterOn({ facet: 'off' })).toBe(false);
  });

  test('read aloud: a language, or the device voice', () => {
    const de = setFieldLang(base, 0, 'de-DE');
    expect(de[0].lang).toBe('de-DE');
    expect('lang' in setFieldLang(de, 0, null)[0]).toBe(false);
  });

  test('filterCandidates: the German Level field passes the data rule; free text is never offered', () => {
    const c = fixture('german_vocabulary');
    const start = startingTypes(c, suggestMapping(c), [])[0];
    const names = start.fields.map((f) => f.name);
    const found = filterCandidates(c, start.mid, start.fields);
    expect(found).toContainEqual({ index: names.indexOf('Level'), passes: true });
    for (const { index } of found) expect(['term', 'meaning', 'example', 'exampleMeaning']).not.toContain(start.fields[index].role);
  });

  test('directionName: two languages → "German → English", else the template name', () => {
    const type = {
      fields: [field('Word', 'term', { lang: 'de-DE' }), field('Meaning', 'meaning', { lang: 'en-GB' })],
      templates: [
        { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
        { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
        { ord: 2, name: ' ', prompt: [0], answer: [0] },
      ],
    };
    expect(directionName(type, 0)).toBe('German → English');
    expect(directionName(type, 1)).toBe('English → German');
    expect(directionName(type, 2)).toBe('Direction 3'); // same language both sides, and no name
    expect(directionName({ ...type, fields: [field('Word', 'term'), field('Meaning', 'meaning')] }, 0)).toBe('DE-EN');
    expect(directionName(type, 7)).toBe('Direction 8');
  });

  test('fieldsLine: the one line of a certain guess', () => {
    expect(fieldsLine([field('Front', 'term'), field('Back', 'meaning')])).toBe('Fields: Front → front, Back → back');
    expect(fieldsLine([field('Front', 'term')])).toBe('');
  });

  test('reusedTypeLine: a card type already in the library, and the fields a newer file adds (by their labels)', () => {
    const type = {
      name: 'German Vocabulary',
      fields: [field('Word', 'term'), field('Translation', 'meaning'), field('Type', 'badge'), field('MarankiPlural', 'detail')],
    };
    expect(reusedTypeLine(type)).toBe(
      'Already in your library as “German Vocabulary”. Its fields stay as they are. Fields: Word → front, Translation → back',
    );
    expect(reusedTypeLine(type, ['Type', 'MarankiPlural'])).toBe(
      'Already in your library as “German Vocabulary”. This file adds 2 fields: Type, Plural. The other fields stay as they are. ' +
        'Fields: Word → front, Translation → back',
    );
    expect(reusedTypeLine({ name: 'X', fields: [field('Extra', 'detail')] }, ['Extra'])).toBe(
      'Already in your library as “X”. This file adds 1 field: Extra. The other fields stay as they are.',
    );
  });

  test('reusedTypeLine: the fields a newer file no longer has (German vocabulary version 3), alone and with added ones', () => {
    // The upgraded type no longer has the field: it is named by its readable name.
    const type = { name: 'German Vocabulary', fields: [field('Word', 'term'), field('Translation', 'meaning')] };
    expect(reusedTypeLine(type, [], ['MarankiExample'])).toBe(
      'Already in your library as “German Vocabulary”. This file no longer has 1 field: Example. ' +
        'A card that this file does not update keeps its text there. The other fields stay as they are. ' +
        'Fields: Word → front, Translation → back',
    );
    const grown = { name: 'X', fields: [field('Word', 'term'), field('Translation', 'meaning'), field('Type', 'badge')] };
    expect(reusedTypeLine(grown, ['Type'], ['Old', 'Older'])).toBe(
      'Already in your library as “X”. This file adds 1 field: Type. It no longer has 2 fields: Old, Older. ' +
        'A card that this file does not update keeps its text there. The other fields stay as they are. ' +
        'Fields: Word → front, Translation → back',
    );
  });
});

describe('CSV columns', () => {
  test('a column choice and its role go both ways', () => {
    const fields = [field('Word', 'term'), field('Meaning', 'meaning'), field('Level', 'detail'), field('Note', 'detail')];
    for (const role of ['front', 'back', 'example', 'showOnBack', 'filter', 'ignore'] as const) {
      const next = setCsvColumnRole(fields, 3, role);
      expect(csvColumnRole(next[3])).toBe(role);
    }
    expect(setCsvColumnRole(fields, 2, 'filter')[2]).toEqual({ name: 'Level', role: 'badge', facet: 'on' });
    expect(setCsvColumnRole(fields, 2, 'showOnBack')[2]).toEqual({ name: 'Level', role: 'detail', facet: 'off' });
    expect(setCsvColumnRole(fields, 2, 'ignore')[2]).toEqual({ name: 'Level', role: 'hidden', facet: 'off' });
    // A default back row (facet auto) reads as "Show on back".
    expect(csvColumnRole(field('Notes', 'detail'))).toBe('showOnBack');
  });

  test('csvFieldColumns: the file column of each field, around the special columns', () => {
    const tagsInMiddle = readCsv('Word,Tags,Meaning\nHaus,noun,house', 'w.csv');
    expect(tagsInMiddle.models[CSV_MODEL_ID].flds.map((f) => f.name)).toEqual(['Word', 'Meaning']);
    expect(csvFieldColumns(tagsInMiddle, 2)).toEqual([0, 2]);
    expect(csvTagsLabel(tagsInMiddle)).toBe('Tags: Tags');
    // No header: columns 4 and after are tags (today's rule).
    const positional = readCsv('a,b,c,d,t1,t2', 'p.csv');
    expect(csvFieldColumns(positional, 4)).toEqual([0, 1, 2, 3]);
    expect(csvTagsLabel(positional)).toBe('Tags: column 5 and after');
    // "Tags" on the Fields stage = read again with that file column.
    const again = readCsv('Word,Topic,Meaning\nHaus,home,house', 'w.csv', { tagsCol: csvFieldColumns(readCsv('Word,Topic,Meaning\nHaus,home,house', 'w.csv'), 3)[1] });
    expect(again.notes[0].tags).toEqual(['home']);
    expect(csvTagsLabel(again)).toBe('Tags: Topic');
    expect(csvFieldColumns(fixture('german_verbs'), 3)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- Preview */

describe('Preview lines come from the summary', () => {
  test('the headline: cards, items and sections; or what happens when nothing is new', () => {
    expect(previewHeadline(summaryOf({ cardsAdded: 15960, notesAdded: 8433, sections: 15 }))).toBe(
      '15,960 cards from 8,433 items · 15 sections',
    );
    expect(previewHeadline(summaryOf({ cardsAdded: 1, notesAdded: 1 }))).toBe('1 card from 1 item');
    expect(previewHeadline(summaryOf({ cardsAdded: 20 }))).toBe('20 new cards for items already here');
    expect(previewHeadline(summaryOf({ notesUpdated: 3 }))).toBe('Nothing new · 3 items will be updated');
    expect(previewHeadline(summaryOf({ notesUnchanged: 8433 }))).toBe('Already up to date');
  });

  test('every row of an Anki file; a CSV shows no progress, suspension, images or audio', () => {
    const s = summaryOf({
      filtersFound: ['Level', 'Section', 'Verb tags'],
      inTargetDeck: 2,
      inOtherDecks: 1,
      progressCards: 830,
      suspended: 4,
      imagesFound: 57,
      audioClips: 120,
    });
    expect(previewRows(s, { anki: true, images: true })).toEqual([
      { key: 'filters', label: 'Filters found', value: 'Level, Section, Verb tags' },
      { key: 'inTarget', label: 'Already in this deck', value: '2' },
      { key: 'inOther', label: 'Already in other decks', value: '1' },
      { key: 'progress', label: 'Study progress in this file', value: '830 cards' },
      { key: 'suspended', label: 'Suspended in Anki', value: '4' },
      { key: 'images', label: 'Images', value: '57 — will be imported' },
      { key: 'audio', label: 'Audio', value: '120 clips — not imported yet. Cards keep their text.' },
    ]);
    // CSV rows found in this deck by their Front count as already here too.
    const csvAgain = summaryOf({ skipped: { alreadyHere: 3, elsewhere: 0, overlap: 0, empty: 0 } });
    expect(previewRows(csvAgain, { anki: false, images: true })[1]).toEqual({ key: 'inTarget', label: 'Already in this deck', value: '3' });
    expect(previewRows(s, { anki: true, images: false })[5].value).toBe('57 — not imported');
    const none = previewRows(summaryOf(), { anki: true, images: true });
    expect(none.map((r) => r.value)).toEqual(['none', '0', '0', 'none', '0', 'none', 'none']);
    expect(previewRows(s, { anki: false, images: true }).map((r) => r.key)).toEqual(['filters', 'inTarget', 'inOther']);
  });

  test('the images row says what will really happen: "already here" when every planned picture is there (wave 5i)', () => {
    // The release re-measure: an unchanged Algo_Patterns.apkg said "Already up to date" above
    // "Images 57 — will be imported". Every one of the 57 files was already in the deck's folder.
    const unchanged = summaryOf({ notesUnchanged: 57, inTargetDeck: 57, imagesFound: 57, images: 57 });
    const imagesOf = (opts: { images: boolean; imagesHere?: number }) =>
      previewRows(unchanged, { anki: true, ...opts }).find((r) => r.key === 'images')?.value;
    expect(previewHeadline(unchanged)).toBe('Already up to date');
    expect(imagesOf({ images: true, imagesHere: 57 })).toBe('57 — already here');
    // Some pictures are new (or nothing is known about the folders): they will be copied.
    expect(imagesOf({ images: true, imagesHere: 56 })).toBe('57 — will be imported');
    expect(imagesOf({ images: true })).toBe('57 — will be imported');
    // "Include images" off: nothing is copied, whatever the folders hold.
    expect(imagesOf({ images: false, imagesHere: 57 })).toBe('57 — not imported');
    // No planned file (nothing is written) is not "already here" by itself.
    expect(previewRows(summaryOf({ imagesFound: 3, images: 0 }), { anki: true, images: true, imagesHere: 0 })[5].value).toBe(
      '3 — will be imported',
    );
    expect(previewRows(summaryOf(), { anki: true, images: true, imagesHere: 0 })[5].value).toBe('none');
  });

  test('notices: renamed ids, the headword overlap and its button, the image question', () => {
    expect(renamedNotice(summaryOf({ guidsRenamed: 3 }))).toBe('3 duplicate ids in this file were renamed.');
    expect(renamedNotice(summaryOf({ guidsRenamed: 1 }))).toBe('1 duplicate id in this file was renamed.');
    expect(renamedNotice(summaryOf())).toBe('');
    // Wave 5g (E8): the note says what it counts — the same TEXT, not the same item.
    expect(overlapText({ deckName: 'German Vocabulary', notes: 475 })).toBe(
      '475 items have the same text as items in German Vocabulary. They are studied separately.',
    );
    expect(overlapText({ deckName: 'X', notes: 1 })).toBe('1 item has the same text as an item in X. They are studied separately.');
    expect(overlapSkipLabel(summaryOf({ overlap: [{ deckId: 'd', deckName: 'X', notes: 475 }] }))).toBe('Skip these 475');
    expect(
      overlapSkipLabel(
        summaryOf({
          overlap: [
            { deckId: 'a', deckName: 'A', notes: 3 },
            { deckId: 'b', deckName: 'B', notes: 2 },
          ],
        }),
      ),
    ).toBe('Skip these');
    expect(imagesQuestion(summaryOf({ imagesAskFirst: true, imagesFoundBytes: 180 * 1024 * 1024 }))).toBe(
      'Import 180 MB of images?',
    );
    expect(imagesQuestion(summaryOf({ imagesFoundBytes: 4_800_000 }))).toBe('');
    expect(formatMegabytes(10)).toBe('1 MB');
  });

  test('the Import button: cards, else updates, else nothing to do', () => {
    expect(importButtonLabel(summaryOf({ cardsAdded: 15960 }))).toBe('Import 15,960 cards');
    expect(importButtonLabel(summaryOf({ notesUpdated: 2 }))).toBe('Update 2 items');
    expect(importButtonLabel(summaryOf())).toBe('Already up to date');
    expect(canImport(summaryOf())).toBe(false);
    expect(canImport(summaryOf({ notesUpdated: 1 }))).toBe(true);
    // A newer version of a card type with the same values (for example a new empty field) is still a change.
    expect(importButtonLabel(summaryOf({ cardTypesUpdated: 1 }))).toBe('Update 1 card type');
    expect(canImport(summaryOf({ cardTypesUpdated: 1 }))).toBe(true);
    expect(previewHeadline(summaryOf({ cardTypesUpdated: 1 }))).toBe('Nothing new · 1 card type will be updated');
  });

  test('wave 5g (E8): new cards AND updated items — the Preview says both, before the Import', () => {
    // The walkthrough: German_Vocabulary_v4.apkg into the v1 deck.
    const v4 = summaryOf({
      cardsAdded: 1000,
      notesAdded: 500,
      sections: 5,
      inTargetDeck: 4000,
      notesUpdated: 4000,
      updatedDecks: ['German Vocabulary'],
    });
    expect(previewHeadline(v4)).toBe('1,000 new cards from 500 items · 5 sections');
    expect(previewUpdateLine(v4)).toBe('4,000 items will be updated in German Vocabulary');
    expect(importButtonLabel(v4)).toBe('Import 1,000 cards');
    // Some items of the file are the same as in the deck: only the CHANGED ones are called updated.
    const some = summaryOf({ cardsAdded: 2, notesAdded: 1, inTargetDeck: 10, notesUpdated: 4, notesUnchanged: 6 });
    expect(previewUpdateLine(some)).toBe('4 items will be updated');
    expect(previewUpdateLine(summaryOf({ cardsAdded: 2, notesAdded: 1, notesUpdated: 1, updatedDecks: ['A', 'B'] }))).toBe(
      '1 item will be updated in A, B',
    );
    // Nothing changes in the items that are already here: no update line, and no "new" in the headline.
    const unchanged = summaryOf({ cardsAdded: 2, notesAdded: 1, inTargetDeck: 10, notesUnchanged: 10 });
    expect(previewUpdateLine(unchanged)).toBe('');
    expect(previewHeadline(unchanged)).toBe('2 cards from 1 item');
    // Nothing new: the headline says the update already, so there is no second line.
    expect(previewHeadline(summaryOf({ notesUpdated: 3 }))).toBe('Nothing new · 3 items will be updated');
    expect(previewUpdateLine(summaryOf({ notesUpdated: 3 }))).toBe('');
    // New cards for items already here (a newly enabled direction) plus updates: both said.
    const both = summaryOf({ cardsAdded: 20, notesUpdated: 2 });
    expect(previewHeadline(both)).toBe('20 new cards for items already here');
    expect(previewUpdateLine(both)).toBe('2 items will be updated');
  });
});

/* ---------------------------------------------------------------- Done */

describe('Done copy comes from the ImportResult', () => {
  const result = (over: Partial<Parameters<typeof doneCopy>[0]> = {}): Parameters<typeof doneCopy>[0] => ({
    cardsAdded: 0,
    notesUpdated: 0,
    cardsUpdated: 0,
    updatedDecks: [],
    skipped: { alreadyHere: 0, elsewhere: 0, overlap: 0, empty: 0 },
    markedKnown: 0,
    cardTypesUpdated: 0,
    ...over,
  });
  const opts = { deckName: 'German', notStarted: 0, triageReady: false };

  test('queue mode: "{deck} is ready" · "{n} cards added", with the counts', () => {
    expect(doneCopy(result({ cardsAdded: 15960 }), opts)).toEqual({
      mode: 'queue',
      title: 'German is ready',
      lines: ['15,960 cards added'],
    });
    const busy = doneCopy(
      result({ cardsAdded: 3, notesUpdated: 2, skipped: { alreadyHere: 5, elsewhere: 0, overlap: 0, empty: 0 }, markedKnown: 40 }),
      opts,
    );
    // Wave 5g (E8): every number says its unit — cards added, ITEMS updated and skipped.
    expect(busy.lines).toEqual([
      '3 cards added',
      '2 items updated · 5 items skipped (already here)',
      '40 cards marked Known (easier levels).',
    ]);
  });

  test('choose mode only with the triage screen and Not started cards', () => {
    expect(doneCopy(result({ cardsAdded: 3 }), { ...opts, notStarted: 3, triageReady: true }).mode).toBe('choose');
    expect(doneCopy(result({ cardsAdded: 3 }), { ...opts, notStarted: 3, triageReady: false }).mode).toBe('queue');
    expect(doneCopy(result({ cardsAdded: 3 }), { ...opts, notStarted: 0, triageReady: true }).mode).toBe('queue');
  });

  test('every item an update: "Updated {n} cards ({u} items) in {decks}. Nothing new."', () => {
    // Wave 5g (E8): the items are named too — the number the Preview said ("4 items will be updated").
    expect(doneCopy(result({ notesUpdated: 4, cardsUpdated: 8, updatedDecks: ['German', 'Verbs'] }), opts)).toEqual({
      mode: 'updated',
      title: 'Updated 8 cards (4 items) in German, Verbs.',
      lines: ['Nothing new.'],
    });
    // Wave 5i (release re-measure): the items are ALWAYS said, also when there is one card per
    // item. The Preview counts an update in items ("Update 1 item"), so Done names that unit too;
    // before it said "Updated 1 card in Algo Deck." after "Update 1 item".
    expect(doneCopy(result({ notesUpdated: 3, cardsUpdated: 3, updatedDecks: ['German'] }), opts).title).toBe(
      'Updated 3 cards (3 items) in German.',
    );
    const oneItem = summaryOf({ notesUpdated: 1, cardsUpdated: 1, updatedDecks: ['Algo Deck'] });
    expect(importButtonLabel(oneItem)).toBe('Update 1 item');
    expect(doneCopy({ ...oneItem, markedKnown: 0 }, opts).title).toBe('Updated 1 card (1 item) in Algo Deck.');
    expect(doneCopy(result({ notesUpdated: 1, cardsUpdated: 2 }), opts).title).toBe('Updated 2 cards (1 item).');
  });

  test('only a card type got new fields: "Updated 1 card type." "Nothing new."', () => {
    expect(doneCopy(result({ cardTypesUpdated: 1 }), opts)).toEqual({
      mode: 'updated',
      title: 'Updated 1 card type.',
      lines: ['Nothing new.'],
    });
    // Updated items win: the card type is part of that update.
    expect(doneCopy(result({ cardTypesUpdated: 1, notesUpdated: 2, cardsUpdated: 4 }), opts).title).toBe('Updated 4 cards (2 items).');
  });

  test('nothing changed: "Already up to date."', () => {
    expect(doneCopy(result(), opts)).toEqual({ mode: 'upToDate', title: 'Already up to date.', lines: [] });
    expect(doneCopy(result({ skipped: { alreadyHere: 12, elsewhere: 0, overlap: 0, empty: 0 } }), opts).lines).toEqual([
      '12 items skipped (already here)',
    ]);
    expect(doneCopy(result({ skipped: { alreadyHere: 1, elsewhere: 0, overlap: 0, empty: 0 } }), opts).lines).toEqual([
      '1 item skipped (already here)',
    ]);
  });

  test('honest warnings after the save', () => {
    expect(saveWarning({ ok: true })).toBe('');
    expect(saveWarning({ ok: false, reason: 'write' })).toBe('Your cards were added, but saving failed. Maranki will try again.');
    expect(saveWarning({ ok: false, reason: 'blocked' })).toBe(
      'Your cards were added, but they could not be saved on this phone.',
    );
    expect(imagesWarning(0)).toBe('');
    expect(imagesWarning(1)).toBe('1 image could not be copied.');
    expect(imagesWarning(3)).toBe('3 images could not be copied.');
  });
});

/* ---------------------------------------------------------------- Sections, AnkiWeb */

describe('the Sections tree', () => {
  const s = (did: string, name: string, cards: number) => ({ did, name, path: name.split('::'), cards });

  test('nested subdecks: the shared part goes, the next part is a header', () => {
    const tree = sectionTree([
      s('1', 'German::Verbs::A1', 10),
      s('2', 'German::Verbs::B1', 20),
      s('3', 'German::Vocabulary::A1', 5),
    ]);
    expect(tree).toEqual({
      mode: 'grouped',
      groups: [
        { key: 'Verbs', cards: 30, leaves: [{ did: '1', label: 'A1', cards: 10 }, { did: '2', label: 'B1', cards: 20 }] },
        { key: 'Vocabulary', cards: 5, leaves: [{ did: '3', label: 'A1', cards: 5 }] },
      ],
    });
  });

  test('one level left: flat rows; a row always keeps a label', () => {
    expect(sectionTree([s('1', 'German::A1', 1), s('2', 'German::A2', 2)])).toEqual({
      mode: 'flat',
      leaves: [{ did: '1', label: 'A1', cards: 1 }, { did: '2', label: 'A2', cards: 2 }],
    });
    expect(sectionTree([s('1', 'Same', 1), s('2', 'Same', 2)]).mode).toBe('flat');
    expect(sectionTree([])).toEqual({ mode: 'flat', leaves: [] });
    expect(sectionsFooter([{ cards: 4000 }, { cards: 480 }])).toBe('4,480 cards in 2 sections');
  });

  test('the real German Verbs file: six level rows under one shared root', () => {
    const tree = sectionTree(collectionSections(fixture('german_verbs')));
    expect(tree.mode).toBe('flat');
    if (tree.mode === 'flat') expect(tree.leaves.map((l) => l.label)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  });
});

test('an AnkiWeb row: items (never "notes", glossary §1.2), rating, has audio / images', () => {
  expect(ankiWebMeta({ notes: 6845, upvotes: 120, audio: 3, images: 1 })).toBe('6,845 items · ▲ 120 · has audio · has images');
  expect(ankiWebMeta({ notes: 1, upvotes: 0, audio: 0, images: 0 })).toBe('1 item · ▲ 0');
});

test('the AnkiWeb details before "Download & preview"', () => {
  const deck = { notes: 6845, upvotes: 120, downvotes: 3, audio: 2, images: 0, modifiedSec: 0 };
  expect(ankiWebDetailRows('42', deck)).toEqual([
    ['Items', '6,845'],
    ['Rating', '▲ 120 · ▼ 3'],
    ['Audio', '2 clips — not imported yet'],
    ['Images', 'none'],
  ]);
  expect(ankiWebDetailRows('42', { ...deck, modifiedSec: 1_700_000_000 }).map((r) => r[0])).toContain('Updated');
  expect(ankiWebDetailRows('42', null)).toEqual([['AnkiWeb deck', '#42']]);
});

/* ---------------------------------------------------------------- images */

describe('writeImportImages (after the save commits)', () => {
  function fakeDisk(failOn: string[] = []) {
    const files = new Map<string, Uint8Array>();
    const folders: string[] = [];
    return {
      files,
      folders,
      ensureFolder(folder: string) {
        if (failOn.includes(folder)) throw new Error('disk full');
        folders.push(folder);
      },
      writeFile(folder: string, name: string, bytes: Uint8Array) {
        if (failOn.includes(name)) throw new Error('disk full');
        files.set(`${folder}/${name}`, bytes);
      },
    };
  }
  const bytesOf = (name: string) => (name.startsWith('missing') ? null : Uint8Array.of(1, 2, 3));

  test('writes every planned image into its deck folder', () => {
    const disk = fakeDisk();
    const out = writeImportImages(
      [
        { deckFolder: 'media/deck-1', files: ['a.png', 'b.webp'] },
        { deckFolder: 'media/deck-2', files: ['a.png'] },
      ],
      bytesOf,
      disk,
    );
    expect(out).toEqual({ written: 3, failed: [] });
    expect([...disk.files.keys()]).toEqual(['media/deck-1/a.png', 'media/deck-1/b.webp', 'media/deck-2/a.png']);
  });

  test('unsafe names and folders, non-images, missing bytes and disk errors fail alone', () => {
    const disk = fakeDisk(['bad.png', 'media/deck-3']);
    const out = writeImportImages(
      [
        { deckFolder: 'media/deck-1', files: ['../x.png', 'a/b.png', 'song.mp3', 'missing.png', 'bad.png', 'ok.png'] },
        { deckFolder: 'media/../etc', files: ['c.png'] },
        { deckFolder: 'media/deck-3', files: ['d.png'] },
        { deckFolder: 'media/deck-4', files: [] },
      ],
      bytesOf,
      disk,
    );
    expect(out.written).toBe(1);
    expect(out.failed).toEqual([
      'media/deck-1/../x.png',
      'media/deck-1/a/b.png',
      'media/deck-1/song.mp3',
      'media/deck-1/missing.png',
      'media/deck-1/bad.png',
      'media/../etc/c.png',
      'media/deck-3/d.png',
    ]);
    expect(disk.folders).toEqual(['media/deck-1']);
  });

  test('no archive reader: every file fails, nothing is written', () => {
    const disk = fakeDisk();
    expect(writeImportImages([{ deckFolder: 'media/d', files: ['a.png'] }], undefined, disk)).toEqual({
      written: 0,
      failed: ['media/d/a.png'],
    });
  });

  test('expoMediaDisk writes to Paths.document/media/<deckId>/<name> and replaces an older file', () => {
    const disk = expoMediaDisk();
    const out = writeImportImages([{ deckFolder: 'media/deck-x', files: ['example.webp'] }], () => Uint8Array.of(7, 8), disk);
    expect(out).toEqual({ written: 1, failed: [] });
    const file = new File(new Directory(Paths.document, 'media', 'deck-x'), 'example.webp');
    expect(Array.from(file.bytesSync())).toEqual([7, 8]);
    writeImportImages([{ deckFolder: 'media/deck-x', files: ['example.webp'] }], () => Uint8Array.of(9), disk);
    expect(Array.from(file.bytesSync())).toEqual([9]);
    // Written through <name>.tmp and a move: no .tmp file is left, and the reader sees the file.
    expect(new File(new Directory(Paths.document, 'media', 'deck-x'), 'example.webp.tmp').exists).toBe(false);
    expect(disk.fileSize('media/deck-x', 'example.webp')).toBe(1);
    expect(disk.fileSize('media/deck-x', 'nope.png')).toBeNull();
    expect(Array.from(disk.readFile('media/deck-x', 'example.webp') ?? [])).toEqual([9]);
  });

  test('a file already in its folder with the same bytes is not written again (wave 5i "already here")', () => {
    const disk = {
      ...fakeDisk(),
      fileSize: (folder: string, name: string) => (name === 'gone.png' ? null : 3),
      readFile: (folder: string, name: string) => (name === 'other.png' ? Uint8Array.of(9, 9, 9) : Uint8Array.of(1, 2, 3)),
    };
    const out = writeImportImages([{ deckFolder: 'media/deck-1', files: ['same.png', 'other.png', 'gone.png'] }], bytesOf, disk);
    // All three are in place; only the changed one and the missing one are written.
    expect(out).toEqual({ written: 3, failed: [] });
    expect([...disk.files.keys()]).toEqual(['media/deck-1/other.png', 'media/deck-1/gone.png']);
  });

  test('a disk that cannot read writes every file (no "same" check)', () => {
    const disk = { ...fakeDisk(), fileSize: () => 3, readFile: () => { throw new Error('read'); } };
    const out = writeImportImages([{ deckFolder: 'media/deck-1', files: ['a.png'] }], bytesOf, disk);
    expect(out).toEqual({ written: 1, failed: [] });
    expect([...disk.files.keys()]).toEqual(['media/deck-1/a.png']);
  });

  test('a file renamed in its folder is read by its ARCHIVE name', () => {
    const disk = fakeDisk();
    const read: string[] = [];
    const out = writeImportImages(
      [{ deckFolder: 'media/deck-1', files: ['image1-0a0b0c0d.jpg', 'b.png'], renamed: [{ name: 'image1-0a0b0c0d.jpg', from: 'image1.jpg' }] }],
      (name) => {
        read.push(name);
        return Uint8Array.of(1);
      },
      disk,
    );
    expect(out).toEqual({ written: 2, failed: [] });
    expect(read).toEqual(['image1.jpg', 'b.png']);
    expect([...disk.files.keys()]).toEqual(['media/deck-1/image1-0a0b0c0d.jpg', 'media/deck-1/b.png']);
  });
});

describe('one name, one picture: an import into a deck that has a DIFFERENT image1.jpg', () => {
  const DOG = Uint8Array.of(1, 1, 1);
  const CAT = Uint8Array.of(2, 2, 2, 2);
  /** A one-note Basic .apkg whose Back shows image1.jpg (`bytes`). */
  const pictureFile = (guid: string, word: string, bytes: Uint8Array): AnkiCollection => ({
    fileName: `${word}.apkg`,
    crt: 0,
    models: {
      m: {
        name: 'Basic',
        type: 0,
        sortf: 0,
        flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
        tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }],
      },
    },
    decks: { d: 'Spanish' },
    notes: [{ id: '1', guid, mid: 'm', flds: [word, '<img src="image1.jpg">'], tags: [] }],
    cards: [{ id: 'c1', nid: '1', did: 'd', odid: '0', ord: 0, type: 0, queue: 0, due: 0, ivl: 0, factor: 0, reps: 0, lapses: 0, flags: 0 }],
    media: { '0': 'image1.jpg' },
    mediaBytes: (name) => (name === 'image1.jpg' ? bytes : null),
  });
  const choicesFor = (c: AnkiCollection, target: ImportChoices['target']): ImportChoices => ({
    sections: new Set(collectionSections(c).map((s) => s.did)),
    target,
    types: choiceTypes(c, startingTypes(c, suggestMapping(c), [])),
    progress: 'keep',
    arrival: 'queued',
    elsewhere: 'update',
    images: true,
  });
  const origin = importOrigin({ kind: 'file', fileName: 'x.apkg', isCsv: false });

  test('importMediaNamer: free or the same picture keeps the name; another picture gets its own', () => {
    const files = new Map<string, Uint8Array>([
      ['media/d1/same.jpg', DOG],
      ['media/d1/taken.jpg', DOG],
    ]);
    const reader = {
      fileSize: (folder: string, name: string) => files.get(`${folder}/${name}`)?.length ?? null,
      readFile: (folder: string, name: string) => files.get(`${folder}/${name}`) ?? null,
    };
    const name = importMediaNamer((n) => (n === 'same.jpg' ? DOG : n === 'gone.jpg' ? null : CAT), reader);
    expect(name('d1', 'free.jpg')).toBe('free.jpg');
    expect(name('d1', 'same.jpg')).toBe('same.jpg');
    expect(name('d1', 'gone.jpg')).toBe('gone.jpg'); // no bytes: nothing is written for it
    const own = name('d1', 'taken.jpg');
    expect(own).toBe(uniqueImageName('taken.jpg', CAT));
    expect(own).not.toBe('taken.jpg');
    // That name already holds the same picture (an earlier import): it is used again.
    files.set(`media/d2/taken.jpg`, DOG);
    files.set(`media/d2/${own}`, CAT);
    expect(name('d2', 'taken.jpg')).toBe(own);
  });

  test('importImagesHere: only a file with the very same bytes is "already here"; answers are kept', () => {
    const files = new Map<string, Uint8Array>([
      ['media/d1/same.jpg', DOG],
      ['media/d1/other.jpg', DOG],
      ['media/d1/short.jpg', Uint8Array.of(1)],
      ['media/d1/image1-0a0b0c0d.jpg', CAT],
    ]);
    const reads: string[] = [];
    const reader = {
      fileSize: (folder: string, name: string) => files.get(`${folder}/${name}`)?.length ?? null,
      readFile: (folder: string, name: string) => {
        reads.push(`${folder}/${name}`);
        return files.get(`${folder}/${name}`) ?? null;
      },
    };
    const bytesOf = (n: string) => (n === 'same.jpg' ? DOG : n === 'gone.jpg' ? null : CAT);
    const here = importImagesHere(bytesOf, reader);
    const one = (name: string) => here([{ deckFolder: 'media/d1', files: [name] }]);
    expect(one('same.jpg')).toBe(1);
    expect(one('other.jpg')).toBe(0); // the same size, other bytes
    expect(one('short.jpg')).toBe(0); // another size: its bytes are never read
    expect(one('new.jpg')).toBe(0); // no such file yet
    expect(one('gone.jpg')).toBe(0); // the archive has no bytes for it
    expect(one('../x.jpg')).toBe(0); // not a safe name
    expect(here([{ deckFolder: 'media/../d1', files: ['same.jpg'] }])).toBe(0); // not a deck folder
    // A renamed file is compared with the archive file it comes from.
    expect(
      here([{ deckFolder: 'media/d1', files: ['image1-0a0b0c0d.jpg'], renamed: [{ name: 'image1-0a0b0c0d.jpg', from: 'image1.jpg' }] }]),
    ).toBe(1);
    expect(reads).not.toContain('media/d1/short.jpg');
    // Asked again (a new plan after a choice): nothing is read twice.
    const before = reads.length;
    expect(here([{ deckFolder: 'media/d1', files: ['same.jpg', 'other.jpg', 'new.jpg'] }])).toBe(1);
    expect(reads.length).toBe(before);
    // A reader that throws counts as "not here" and never throws itself.
    const broken = importImagesHere(bytesOf, {
      fileSize: () => {
        throw new Error('disk');
      },
      readFile: () => null,
    });
    expect(broken([{ deckFolder: 'media/d1', files: ['same.jpg'] }])).toBe(0);
    expect(importImagesHere(undefined, reader)([{ deckFolder: 'media/d1', files: ['same.jpg'] }])).toBe(0);
  });

  test('importImagesHere on real plans: 0 before the first import writes, all of them for the same file again', () => {
    const disk = expoMediaDisk();
    const lib0: PlanLibrary = { noteTypes: [], notes: [], cards: [], decks: [] };
    const ctxFor = (seed: string, c: AnkiCollection) =>
      importPlanCtx({ now: FIXED_NOW, seed, srs: DEFAULT_SRS, origin, mediaName: importMediaNamer(c.mediaBytes, disk) });
    const file = pictureFile('g-owl', 'buho', Uint8Array.of(7, 7, 7, 7, 7));
    const plan1 = planImport(file, lib0, choicesFor(file, { kind: 'new', name: 'Owls', icon: '' }), ctxFor('owl-1', file));
    const deckId = (plan1.deck as Deck).id;
    expect(importImagesHere(file.mediaBytes, disk)(plan1.media)).toBe(0);
    expect(previewRows(plan1.summary, { anki: true, images: true, imagesHere: 0 })[5].value).toBe('1 — will be imported');
    writeImportImages(plan1.media, file.mediaBytes, disk);
    const lib1 = apply(lib0 as Lib, plan1);
    // The same file again: nothing new, and its one picture is already in the deck's folder.
    const plan2 = planImport(file, lib1, choicesFor(file, { kind: 'existing', deckId }), ctxFor('owl-2', file));
    expect(previewHeadline(plan2.summary)).toBe('Already up to date');
    const here = importImagesHere(file.mediaBytes, disk)(plan2.media);
    expect(here).toBe(1);
    expect(previewRows(plan2.summary, { anki: true, images: true, imagesHere: here })[5].value).toBe('1 — already here');
  });

  test('the old cards keep their dog, the new card shows its cat, and the same file again changes nothing', () => {
    const disk = expoMediaDisk();
    const lib0: PlanLibrary = { noteTypes: [], notes: [], cards: [], decks: [] };
    const ctxFor = (seed: string, c: AnkiCollection) =>
      importPlanCtx({ now: FIXED_NOW, seed, srs: DEFAULT_SRS, origin, mediaName: importMediaNamer(c.mediaBytes, disk) });

    // File 1 (the dog) makes the deck.
    const file1 = pictureFile('g-dog', 'perro', DOG);
    const plan1 = planImport(file1, lib0, choicesFor(file1, { kind: 'new', name: 'Spanish', icon: '' }), ctxFor('a', file1));
    const deckId = (plan1.deck as Deck).id;
    expect(plan1.media).toEqual([{ deckFolder: `media/${deckId}`, files: ['image1.jpg'] }]);
    writeImportImages(plan1.media, file1.mediaBytes, disk);
    const lib1 = apply(lib0 as Lib, plan1);

    // File 2 (a different deck, the cat) into the same deck.
    const file2 = pictureFile('g-cat', 'gato', CAT);
    const plan2 = planImport(file2, lib1, choicesFor(file2, { kind: 'existing', deckId }), ctxFor('b', file2));
    const catName = uniqueImageName('image1.jpg', CAT);
    expect(plan2.notes.add[0].fields[1]).toBe(`<img src="${catName}">`);
    expect(plan2.media).toEqual([{ deckFolder: `media/${deckId}`, files: [catName], renamed: [{ name: catName, from: 'image1.jpg' }] }]);
    expect(writeImportImages(plan2.media, file2.mediaBytes, disk)).toEqual({ written: 1, failed: [] });
    const folder = `media/${deckId}`;
    expect(Array.from(disk.readFile(folder, 'image1.jpg') ?? [])).toEqual(Array.from(DOG)); // the old cards' picture
    expect(Array.from(disk.readFile(folder, catName) ?? [])).toEqual(Array.from(CAT));
    expect(lib1.notes[0].fields[1]).toBe('<img src="image1.jpg">');

    // File 2 again: the cat is found under its own name, nothing changes.
    const lib2 = apply(lib1 as Lib, plan2);
    const plan3 = planImport(file2, lib2, choicesFor(file2, { kind: 'existing', deckId }), ctxFor('c', file2));
    expect(plan3.summary).toMatchObject({ notesAdded: 0, notesUpdated: 0, notesUnchanged: 1 });
    expect(plan3.media).toEqual([{ deckFolder: folder, files: [catName], renamed: [{ name: catName, from: 'image1.jpg' }] }]);

    // File 1 again with a CHANGED dog picture: the note points at the new picture; the old file stays.
    const DOG2 = Uint8Array.of(3, 3, 3);
    const file1b = pictureFile('g-dog', 'perro', DOG2);
    const plan4 = planImport(file1b, lib2, choicesFor(file1b, { kind: 'existing', deckId }), ctxFor('d', file1b));
    expect(plan4.notes.update).toEqual([
      expect.objectContaining({ fields: ['perro', `<img src="${uniqueImageName('image1.jpg', DOG2)}">`] }),
    ]);
    // With "Include images" off nothing is written, so the note keeps the picture it has.
    const off = planImport(file1b, lib2, { ...choicesFor(file1b, { kind: 'existing', deckId }), images: false }, ctxFor('e', file1b));
    expect(off.summary).toMatchObject({ notesUpdated: 0, notesUnchanged: 1 });
    writeImportImages(plan4.media, file1b.mediaBytes, disk);
    expect(Array.from(disk.readFile(folder, 'image1.jpg') ?? [])).toEqual(Array.from(DOG));
  });
});

/* ---------------------------------------------------------------- end to end */

describe('end to end with the screen helpers (real fixtures)', () => {
  test('German Verbs: defaults import both directions; the same file again is "Already up to date"', () => {
    const c = fixture('german_verbs');
    const first = screenPlan(c, emptyLib(), 'a');
    expect(first.summary).toMatchObject({ notesAdded: 20, cardsAdded: 40, sections: 6, newCards: 40, notStarted: 0 });
    expect(previewHeadline(first.summary)).toBe('40 cards from 20 items · 6 sections');
    expect(first.deck).toMatchObject({ name: 'German Verbs', sourceKey: 'file:German_Verbs.apkg', source: 'apkg' });
    expect(doneCopy({ ...first.summary, markedKnown: 0 }, { deckName: 'German Verbs', notStarted: 0, triageReady: false }).title).toBe(
      'German Verbs is ready',
    );

    // Again: the default target is the deck from the same file, and every note is unchanged.
    const lib = apply(emptyLib(), first);
    const origin = importOrigin({ kind: 'file', fileName: c.fileName, isCsv: false });
    expect(defaultTarget(lib.decks, origin, { name: 'x', icon: 'y' })).toEqual({ kind: 'existing', deckId: first.deck?.id });
    const again = screenPlan(c, lib, 'b');
    expect(again.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0, notesUpdated: 0, inTargetDeck: 20, notesUnchanged: 20 });
    expect(again.noteTypes.add).toEqual([]); // the card type is reused, not split
    expect(previewHeadline(again.summary)).toBe('Already up to date');
    expect(canImport(again.summary)).toBe(false);
    expect(doneCopy({ ...again.summary, markedKnown: 0 }, { deckName: 'German Verbs', notStarted: 0, triageReady: false }).title).toBe(
      'Already up to date.',
    );
  });

  test('a changed note in the file updates in place and keeps its cards', () => {
    const c = fixture('german_verbs');
    const first = screenPlan(c, emptyLib(), 'a');
    const lib = apply(emptyLib(), first);
    const changed: AnkiCollection = {
      ...c,
      notes: c.notes.map((n, i) => (i === 0 ? { ...n, flds: n.flds.map((v, k) => (k === 1 ? `${v} (new)` : v)) } : n)),
    };
    const again = screenPlan(changed, lib, 'b');
    expect(again.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0, notesUpdated: 1, cardsUpdated: 2 });
    expect(importButtonLabel(again.summary)).toBe('Update 1 item');
    expect(doneCopy({ ...again.summary, markedKnown: 0 }, { deckName: 'German Verbs', notStarted: 0, triageReady: false })).toEqual({
      mode: 'updated',
      title: 'Updated 2 cards (1 item) in German Verbs.',
      lines: ['Nothing new.'],
    });
  });

  test('wave 5g (E8): a newer version of the file adds AND updates — Preview and Done say both, each with its unit', () => {
    const c = fixture('german_verbs');
    // "v1": the first 15 items of the file.
    const first15 = new Set(c.notes.slice(0, 15).map((n) => n.id));
    const v1: AnkiCollection = { ...c, notes: c.notes.filter((n) => first15.has(n.id)), cards: c.cards.filter((x) => first15.has(x.nid)) };
    const lib = apply(emptyLib(), screenPlan(v1, emptyLib(), 'a'));
    // "v4": all 20 items, and the first 3 have a new text.
    const v4: AnkiCollection = {
      ...c,
      notes: c.notes.map((n, i) => (i < 3 ? { ...n, flds: n.flds.map((v, k) => (k === 1 ? `${v} (v4)` : v)) } : n)),
    };
    const plan = screenPlan(v4, lib, 'b');
    expect(plan.summary).toMatchObject({ notesAdded: 5, cardsAdded: 10, inTargetDeck: 15, notesUpdated: 3, notesUnchanged: 12 });
    expect(previewHeadline(plan.summary)).toMatch(/^10 new cards from 5 items/);
    expect(previewUpdateLine(plan.summary)).toBe('3 items will be updated in German Verbs');
    // Done: cards added, ITEMS updated (3 items = 6 cards; never "3 updated" next to "10 cards").
    expect(doneCopy({ ...plan.summary, markedKnown: 0 }, { deckName: 'German Verbs', notStarted: 0, triageReady: false })).toEqual({
      mode: 'queue',
      title: 'German Verbs is ready',
      lines: ['10 cards added', '3 items updated'],
    });
    // The same v1 again: nothing changes, and nothing is called updated.
    const same = screenPlan(v1, lib, 'c');
    expect(same.summary).toMatchObject({ notesAdded: 0, notesUpdated: 0, notesUnchanged: 15 });
    expect(previewHeadline(same.summary)).toBe('Already up to date');
    expect(previewUpdateLine(same.summary)).toBe('');
  });

  test('a CSV with a header and "Also make a reverse card": 2 cards per row; again → already here', () => {
    const text = 'Word,Translation,Level\nHaus,house,A1\nBaum,tree,A1\nGeld,money,A2\nZeit,time,A2';
    const c = readCsv(text, 'words.csv');
    const starts = startingTypes(c, suggestMapping(c), []);
    expect(starts[0].fields.map((f) => [f.name, f.role])).toEqual([
      ['Word', 'term'],
      ['Translation', 'meaning'],
      // Not on a question side, so not a pill; a back row that the data rule makes a filter group.
      ['Level', 'detail'],
    ]);
    const origin = importOrigin({ kind: 'file', fileName: 'words.csv', isCsv: true });
    const choices = (lib: Lib): ImportChoices => ({
      sections: new Set(collectionSections(c).map((s) => s.did)),
      target: defaultTarget(lib.decks, origin, { name: 'Words', icon: '🗂️' }),
      types: choiceTypes(c, [{ ...starts[0], ords: [0, 1] }]),
      progress: 'keep',
      arrival: 'queued',
      elsewhere: 'update',
      images: true,
    });
    const ctx = (seed: string) => importPlanCtx({ now: FIXED_NOW, seed, srs: DEFAULT_SRS, origin });
    const first = planImport(c, emptyLib(), choices(emptyLib()), ctx('a'));
    expect(first.summary).toMatchObject({ notesAdded: 4, cardsAdded: 8 });
    expect(first.summary.filtersFound).toContain('Level');
    expect(previewRows(first.summary, { anki: false, images: true }).map((r) => r.key)).toEqual(['filters', 'inTarget', 'inOther']);
    const lib = apply(emptyLib(), first);
    const again = planImport(c, lib, choices(lib), ctx('b'));
    expect(again.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0 });
    expect(again.summary.skipped.alreadyHere).toBe(4);
    // The rows already here still say what the file has (was 'none').
    expect(again.summary.filtersFound).toContain('Level');
    expect(doneCopy({ ...again.summary, markedKnown: 0 }, { deckName: 'Words', notStarted: 0, triageReady: false })).toEqual({
      mode: 'upToDate',
      title: 'Already up to date.',
      lines: ['4 items skipped (already here)'],
    });
  });

  test('a re-import that changes nothing still shows the file\'s filters (not "Filters found: none")', () => {
    const c = fixture('german_grammar');
    const first = screenPlan(c, emptyLib(), 'f1');
    expect(first.summary.filtersFound).toContain('Level');
    const lib = apply(emptyLib(), first);
    const again = screenPlan(c, lib, 'f2');
    expect(again.summary).toMatchObject({ notesAdded: 0, notesUpdated: 0, notesUnchanged: first.summary.notesAdded });
    expect(again.summary.filtersFound).toEqual(first.summary.filtersFound);
    const row = previewRows(again.summary, { anki: true, images: true }).find((r) => r.key === 'filters');
    expect(row?.value).toBe(first.summary.filtersFound.join(', '));
    // Placement still offers only what is NEW: nothing here.
    expect(again.summary.placementGroups).toEqual([]);
  });

  test('ids come from the seed: two applied imports never share an id', () => {
    const c = fixture('german_grammar');
    const a = screenPlan(c, emptyLib(), 'seed1');
    const b = screenPlan(c, emptyLib(), 'seed2');
    const ids = (p: ImportPlan) => [...p.notes.add.map((n) => n.id), ...p.cards.add.map((x) => x.id), ...(p.deck ? [p.deck.id] : [])];
    const shared = ids(a).filter((id) => ids(b).includes(id));
    expect(shared).toEqual([]);
    expect(ids(a).every((id) => id.startsWith('imp-seed1-'))).toBe(true);
  });
});

describe('filter groups across decks: one card type never removes another deck’s group', () => {
  /** A CSV with these headers and rows, planned with the screen's defaults and applied. */
  function importCsv(lib: Lib, text: string, fileName: string, seed: string): { plan: ImportPlan; lib: Lib } {
    const plan = screenPlan(readCsv(text, fileName), lib, seed);
    return { plan, lib: apply(lib, plan) };
  }
  const levels = ['A1', 'A2', 'B1'];
  /** 30 words with a real level column (passes the data rule). */
  const wordsCsv = ['Word,Translation,Level', ...Array.from({ length: 30 }, (_, i) => `w${i},t${i},${levels[i % 3]}`)].join('\n');
  /** 40 words whose "Level" is a lesson number used once each (fails the data rule: 40 one-off values). */
  const lessonsCsv = ['Term,Meaning,Level', ...Array.from({ length: 40 }, (_, i) => `x${i},m${i},Lesson ${i}`)].join('\n');
  const levelOf = (lib: Lib, note: Note) => buildLibraryIndex(lib.notes, lib.noteTypes).facetValues(note).get('level');

  test('a word list with a free-text Level column keeps the Level group of the other deck (and its saved filters)', () => {
    const words = importCsv(emptyLib(), wordsCsv, 'words.csv', 'a');
    const firstWord = words.plan.notes.add[0];
    expect(buildLibraryIndex(words.lib.notes, words.lib.noteTypes).fieldSpecs.has('level')).toBe(true);
    expect(levelOf(words.lib, firstWord)).toEqual(['a1']);

    const both = importCsv(words.lib, lessonsCsv, 'lessons.csv', 'b');
    expect(both.lib.noteTypes).toHaveLength(2); // two card types: two members of the Level group
    const spec = buildLibraryIndex(both.lib.notes, both.lib.noteTypes).fieldSpecs.get('level');
    // The word deck keeps its Level group; the lesson column (which fails the rule) is not a member.
    expect([...(spec?.fieldIndexByType.keys() ?? [])]).toEqual([words.plan.noteTypes.add[0].id]);
    expect(levelOf(both.lib, firstWord)).toEqual(['a1']);
    expect(levelOf(both.lib, both.plan.notes.add[0])).toBeUndefined();
    // The lesson import's Preview does not promise a Level filter it will not have.
    expect(both.plan.summary.filtersFound).not.toContain('Level');
  });

  test('the Preview runs the rule on the library AFTER the import: it promises exactly the groups the Library will have', () => {
    // Imported first, the lesson list has no Level group.
    const lessons = importCsv(emptyLib(), lessonsCsv, 'lessons.csv', 'a');
    expect(buildLibraryIndex(lessons.lib.notes, lessons.lib.noteTypes).fieldSpecs.has('level')).toBe(false);
    const words = importCsv(lessons.lib, wordsCsv, 'words.csv', 'b');
    expect(words.plan.summary.filtersFound).toContain('Level');
    expect(levelOf(words.lib, words.plan.notes.add[0])).toEqual(['a1']);

    // A small list whose 3 levels are each used once fails the rule ALONE, but
    // joins the Level group that the library already has: the Preview says so.
    const tinyCsv = 'Wort,Bedeutung,Level\nHaus,house,A1\nBaum,tree,B1\nGeld,money,C1';
    const alone = importCsv(emptyLib(), tinyCsv, 'tiny.csv', 'c');
    expect(alone.plan.summary.filtersFound).not.toContain('Level');
    expect(buildLibraryIndex(alone.lib.notes, alone.lib.noteTypes).fieldSpecs.has('level')).toBe(false);
    const joined = importCsv(words.lib, tinyCsv, 'tiny.csv', 'd');
    expect(joined.plan.summary.filtersFound).toContain('Level');
    expect(levelOf(joined.lib, joined.plan.notes.add[0])).toEqual(['a1']);
  });
});

/* ======================================== wave 5h (I3): the home deck of a CSV */

describe('wave 5h (I3): a CSV picked again starts only on a deck that came from a FILE', () => {
  /** The walkthrough's file (E8). */
  const TEXT = 'Front,Back\nder Hund,the dog\ndie Katze,the cat\ndas Haus,the house';
  /** One pick of a file in the system picker: the file read as a collection, and where it came from. */
  type FilePick = { c: AnkiCollection; origin: ReturnType<typeof importOrigin> };
  /** three-words.csv picked WITH its real name. */
  const named = (): FilePick => ({
    c: readCsv(TEXT, 'three-words.csv'),
    origin: importOrigin({ kind: 'file', fileName: 'three-words.csv', isCsv: true }),
  });
  /** The same file picked WITHOUT a name (the picker gave 'msf:102'): a made-up name and a nameless key. */
  const nameless = (): FilePick => {
    const fileName = fallbackFileName('csv', '');
    return { c: readCsv(TEXT, fileName), origin: importOrigin({ kind: 'file', fileName, isCsv: true }, namelessSourceKey(fileName, TEXT)) };
  };
  /** The planner's choices for `target` (import.tsx `choicesOf`); `p` defaults to the screen's start. */
  const choicesOf = (c: AnkiCollection, lib: Lib, target: ImportChoices['target'], p?: ImportPrefs): ImportChoices => {
    const prefs = p ?? startingPrefs(target, { name: 'x', icon: '🗂️', decks: lib.decks });
    return {
      sections: new Set(collectionSections(c).map((s) => s.did)),
      target,
      types: choiceTypes(c, startingTypes(c, suggestMapping(c), lib.noteTypes)),
      progress: prefs.progress,
      arrival: prefs.arrival,
      elsewhere: prefs.elsewhere,
      images: prefs.images,
      skipOverlap: prefs.skipOverlap,
    };
  };
  const ctxOf = (pick: FilePick, seed: string) => importPlanCtx({ now: FIXED_NOW, seed, srs: DEFAULT_SRS, origin: pick.origin });
  /** Imports the pick into `target` (the real planner); returns the library after it. */
  const importInto = (lib: Lib, pick: FilePick, target: ImportChoices['target'], seed: string): Lib =>
    apply(lib, planImport(pick.c, lib, choicesOf(pick.c, lib, target), ctxOf(pick, seed)));
  /**
   * The Preview's start EXACTLY as import.tsx `startPlanning` makes it: the
   * same inputs into the same pure step (deckPageLogic.ts `importStartPlan`),
   * with the real planner. `planned` lists the target of every plan, in
   * order ('new' or a deck id); `deck` is the deck the Preview starts on
   * ("Existing deck: …"), or null for "New deck".
   */
  const startOf = (lib: Lib, pick: FilePick) => {
    const { c, origin } = pick;
    const sel = new Set(collectionSections(c).map((s) => s.did));
    const name = suggestDeckName(c, sel);
    const chosen = chosenNotesByMid(c, sel);
    const home = reimportHomeDeck(guidHomeDeck(c, sel, lib), chosenGuidsOf(chosen), lib);
    const target = defaultTarget(lib.decks, origin, { deckId: home, name, icon: '🗂️' });
    const first = startingPrefs(target, { name, icon: '🗂️', decks: lib.decks });
    const planned: string[] = [];
    const start = importStartPlan({
      earlier: null,
      first,
      home,
      csv: c.csv ? { rows: chosenCountOf(chosen), sourceKey: origin.sourceKey } : null,
      decks: lib.decks,
      triageReady: true,
      planWith: (p) => {
        const there = prefsTarget(p);
        planned.push(there.kind === 'existing' ? there.deckId : 'new');
        return planImport(c, lib, choicesOf(c, lib, there, p), ctxOf(pick, `p${planned.length}`));
      },
    });
    return { ...start, planned, deck: start.prefs.targetKind === 'existing' ? start.prefs.existingDeckId : null };
  };

  /** Decks that did NOT come from a file the learner picked. */
  const notFromAFile: [string, Deck][] = [
    ['made in the app', makeDeck({ id: 'mine', name: 'My words' }, FIXED_NOW)],
    ['from a starter pack', makeDeck({ id: 'mine', name: 'My words', source: 'pack', sourceKey: 'pack:german:vocabulary' }, FIXED_NOW)],
    ['from AnkiWeb', makeDeck({ id: 'mine', name: 'My words', source: 'ankiweb', sourceKey: 'ankiweb:1104981491' }, FIXED_NOW)],
  ];

  test.each(notFromAFile)('a deck %s that holds every row is never the home: "New deck", and the same-text note names it', (_kind, mine) => {
    // three-words.csv imported INTO that deck ("Import more into this deck"). The deck keeps its
    // own source and key: only a NEW deck gets the file's key.
    const lib = importInto({ ...emptyLib(), decks: [mine] }, named(), { kind: 'existing', deckId: 'mine' }, 'a');
    expect(lib.decks).toEqual([mine]);
    expect(lib.cards.filter((x) => x.deckId === 'mine')).toHaveLength(3);
    // The rows ARE there: planned into that deck, all 3 are "already here". That is at least half,
    // so before wave 5h a pick with no name started on "Existing deck: My words" — a guess.
    const again = nameless();
    const into = planImport(again.c, lib, choicesOf(again.c, lib, { kind: 'existing', deckId: 'mine' }), ctxOf(again, 'x'));
    expect(into.summary.skipped.alreadyHere).toBe(3);

    // Picked again, without its name and with it: that deck has no file, so it is never "the same file".
    for (const pick of [nameless(), named()]) {
      const s = startOf(lib, pick);
      expect(s.deck).toBeNull();
      expect(s.prefs.targetKind).toBe('new');
      expect(s.planned).toEqual(['new']); // that deck is not even planned again
      // The Preview still shows the shared rows, and one tap skips them.
      expect(s.plan.summary.overlap).toEqual([{ deckId: 'mine', deckName: 'My words', notes: 3 }]);
      expect(overlapText(s.plan.summary.overlap[0])).toBe('3 items have the same text as items in My words. They are studied separately.');
      expect(overlapSkipLabel(s.plan.summary)).toBe('Skip these 3');
    }
  });

  test('walkthrough E8 stays fixed: three-words.csv with its name, then without → "Existing deck: three-words", already up to date', () => {
    // A deck made in the app holds the same rows too: it is never asked; the file's own deck is.
    const mine = makeDeck({ id: 'mine', name: 'My words' }, FIXED_NOW);
    let lib = importInto({ ...emptyLib(), decks: [mine] }, named(), { kind: 'existing', deckId: 'mine' }, 'a');
    lib = importInto(lib, named(), { kind: 'new', name: 'three-words', icon: '🗂️' }, 'b');
    const deck = lib.decks.find((d) => d.name === 'three-words');
    expect(deck).toMatchObject({ source: 'csv', sourceKey: 'file:three-words.csv' });

    const s = startOf(lib, nameless());
    expect(s.deck).toBe(deck?.id);
    expect(s.planned).toEqual(['new', deck?.id]); // "My words" was not planned again
    expect(s.plan.summary.skipped.alreadyHere).toBe(3);
    expect(previewHeadline(s.plan.summary)).toBe('Already up to date');
    // The same file WITH its name finds the deck by its key, as always.
    expect(startOf(lib, named()).deck).toBe(deck?.id);
  });

  test('a deck from a file is still found by its rows: the other order of E8, an old "file:msf:96" key, an old CSV deck with no key', () => {
    // The first pick had no name: deck "Imported deck" with the nameless key.
    const first = importInto(emptyLib(), nameless(), { kind: 'new', name: 'Imported deck', icon: '🗂️' }, 'a');
    const deck = first.decks[0];
    expect(deck).toMatchObject({ name: 'Imported deck', source: 'csv', sourceKey: nameless().origin.sourceKey });
    // Then the same file WITH its name: the rows find that deck.
    expect(startOf(first, named()).deck).toBe(deck.id);
    // Older data: the deck's key is a document id, or it has no key at all. It is still a CSV deck.
    for (const old of [{ ...deck, sourceKey: 'file:msf:96' }, { ...deck, sourceKey: undefined }]) {
      const lib = { ...first, decks: [old] };
      expect(startOf(lib, nameless()).deck).toBe(deck.id);
      expect(startOf(lib, named()).deck).toBe(deck.id);
    }
  });
});
