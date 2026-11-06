/**
 * The import planner (spec §5.4–§5.6, §5.9, unit W2-5).
 *
 * Pinned here:
 *   - sections → deck name + `note.section` (real German Verbs fixture);
 *     Anki's "Default" deck is the root (only Default → the file name);
 *   - one card per enabled direction; the card type and its directions;
 *     `{{type:F}}` on the answer side shows F;
 *   - a CSV: the columns chosen as Front and Back give the questions and the
 *     sort field ("already here" and the overlap compare the Front column);
 *   - a guid update keeps card ids and SRS (the plan never rewrites a card),
 *     newly enabled directions add cards, a second run is "Already up to date";
 *     an Anki model imported before is reused with its own roles;
 *   - same guid in another deck follows `elsewhere` (update / copy / skip);
 *   - duplicate guids in the file are renamed to a DERIVED guid, so the same
 *     file imported again adds nothing;
 *   - no guid → per-deck sort-field duplicate ("already here");
 *   - headword overlap count (and "Skip these");
 *   - arrival + placement ("Where do you start?"), also by the last level of
 *     nested sections;
 *   - Anki progress keep / reset, suspended, flags, `marked`, and a card in a
 *     filtered deck (its home-deck due);
 *   - images and audio, per deck folder (a note updated where it is gets its
 *     images in its own deck);
 *   - PROPERTY: on 200 seeded random imports, every summary number equals
 *     the plan contents, and every chosen note is counted exactly once.
 *
 * `fieldFacetSpecs` and `detectOrdinal` belong to W2-4 (built in parallel),
 * so the tests pass small hand-written versions: a field is a filter group
 * when its role is 'badge' or its facet is 'on'; CEFR levels are ordinal.
 */
import { describe, expect, test } from '@jest/globals';

import { FIXED_NOW } from '../../test/clock';
import { ankiFixture, type AnkiFixtureName } from '../../test/factories';
import { createRandom, type Random } from '../../test/random';
import type {
  AnkiCollection,
  Card,
  Deck,
  FacetFieldSpec,
  FieldDef,
  FieldRole,
  ImportChoices,
  ImportPlan,
  Note,
  NoteType,
} from '../model';
import { remapFields } from '../noteOps';
import { modelTemplates } from '../roles';
import { foldText } from '../text';
import { DEFAULT_SRS } from '../types';
import { ankiDayToMs } from './ankiSrs';
import { collectionFromRows } from './apkgRead';
import { CSV_MODEL_ID, readCsv } from './csvRead';
import {
  alreadyHereKey,
  buildNoteType,
  cardOrdsByNote,
  chosenNotesByMid,
  collectionSections,
  copyGuid,
  copyOrigin,
  csvFrontBack,
  fileGuids,
  findReusableType,
  findUpgradableType,
  ownValue,
  planImport,
  positionalFieldDefs,
  sectionCut,
  sourceOrder,
  startingTypes,
  suggestDeckName,
  templateFieldRefs,
  templatesFromModel,
  upgradeNoteType,
  type OrdinalRanker,
  type PlanCtx,
} from './plan';

/* ---------------------------------------------------------------- helpers */

interface Lib {
  noteTypes: NoteType[];
  notes: Note[];
  cards: Card[];
  decks: Deck[];
}
const emptyLib = (): Lib => ({ noteTypes: [], notes: [], cards: [], decks: [] });

/** Test version of W2-4 fieldFacetSpecs: badge-role or facet 'on' fields, grouped by folded name. */
function testFacetSpecs(types: NoteType[], _notes: Note[]): Map<string, FacetFieldSpec> {
  const out = new Map<string, FacetFieldSpec>();
  for (const t of types) {
    t.fields.forEach((f, i) => {
      if (f.facet === 'off' || (f.role !== 'badge' && f.facet !== 'on')) return;
      const key = foldText(f.name);
      let spec = out.get(key);
      if (!spec) {
        spec = { key, label: f.label ?? f.name, fieldIndexByType: new Map(), forced: f.facet === 'on' };
        if (f.multiSep) spec.multiSep = f.multiSep;
        out.set(key, spec);
      }
      (spec.fieldIndexByType as Map<string, number>).set(t.id, i);
    });
  }
  return out;
}

const CEFR = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
/** Test version of W2-4 detectOrdinal: CEFR levels only. */
function cefr(labels: string[]): OrdinalRanker | null {
  if (!labels.every((l) => CEFR.includes(l.trim().toLowerCase()))) return null;
  return { rank: (v) => CEFR.indexOf(v.trim().toLowerCase()) };
}

function ctx(prefix = 'id'): PlanCtx {
  let n = 0;
  return {
    now: FIXED_NOW,
    newId: () => `${prefix}-${++n}`,
    srs: { startingEase: DEFAULT_SRS.startingEase, maxIntervalDays: DEFAULT_SRS.maxIntervalDays },
    fieldFacetSpecs: testFacetSpecs,
    detectOrdinal: cefr,
  };
}

function fixture(name: AnkiFixtureName): AnkiCollection {
  const fx = ankiFixture(name);
  return collectionFromRows({ fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media });
}

/** Positional roles, then the given overrides by field name; every direction on. */
function mapping(c: AnkiCollection, over: Record<string, Partial<FieldDef>> = {}): ImportChoices['types'] {
  const types: ImportChoices['types'] = {};
  for (const mid of Object.keys(c.models)) {
    const names = c.models[mid].flds.map((f) => f.name);
    types[mid] = {
      fields: positionalFieldDefs(names).map((f) => ({ ...f, ...(over[f.name] ?? {}) })),
      ords: c.models[mid].tmpls.map((t) => t.ord),
    };
  }
  return types;
}

/** German Verbs as roles.ts would map it: Level a badge, the Tags field a multi-value badge "Verb tags". */
const VERBS_ROLES: Record<string, Partial<FieldDef>> = {
  Level: { role: 'badge', facet: 'auto' },
  Tags: { role: 'badge', facet: 'auto', multiSep: ',', label: 'Verb tags' },
  Example: { role: 'example', facet: 'off' },
};

function choices(c: AnkiCollection, over: Partial<ImportChoices> = {}): ImportChoices {
  return {
    sections: new Set(collectionSections(c).map((s) => s.did)),
    target: { kind: 'new', name: '', icon: '🇩🇪' },
    types: mapping(c),
    progress: 'keep',
    arrival: 'queued',
    elsewhere: 'update',
    images: true,
    ...over,
  };
}

/** The reducer's applyImport, enough for these tests (a card-type upgrade moves EVERY note of the type by field name). */
function apply(lib: Lib, plan: ImportPlan): Lib {
  const upd = new Map(plan.notes.update.map((u) => [u.id, u]));
  const upgrades = new Map(plan.noteTypes.upgrade.map((u) => [u.type.id, u]));
  return {
    noteTypes: [...lib.noteTypes.map((t) => upgrades.get(t.id)?.type ?? t), ...plan.noteTypes.add],
    notes: [
      ...lib.notes.map((n) => {
        const up = upgrades.get(n.typeId);
        const moved = up ? { ...n, fields: remapFields(n.fields, up.fromFields, up.type.fields.map((f) => f.name)) } : n;
        const u = upd.get(n.id);
        return u ? { ...moved, fields: u.fields, tags: u.tags, section: u.section ?? moved.section } : moved;
      }),
      ...plan.notes.add,
    ],
    cards: [...lib.cards, ...plan.cards.add],
    decks: plan.deck ? [...lib.decks, plan.deck] : lib.decks,
  };
}

/** A copy of a collection with some notes / cards changed (collections are plain data). */
function edit(c: AnkiCollection, fn: (draft: AnkiCollection) => void): AnkiCollection {
  const draft: AnkiCollection = {
    ...c,
    notes: c.notes.map((n) => ({ ...n, flds: [...n.flds], tags: [...n.tags] })),
    cards: c.cards.map((x) => ({ ...x })),
  };
  fn(draft);
  return draft;
}

const didOf = (c: AnkiCollection, name: string) => Object.keys(c.decks).find((d) => c.decks[d] === name) as string;

/* ---------------------------------------------------------------- sections */

describe('sections → deck name + note.section (German Verbs)', () => {
  const verbs = fixture('german_verbs');

  test('collectionSections lists the subdecks that hold notes, with counts', () => {
    const sections = collectionSections(verbs);
    expect(sections.map((s) => s.name)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((l) => `German::Verbs::${l}`));
    expect(sections[0]).toMatchObject({ notes: 4, cards: 8, path: ['German', 'Verbs', 'A1'] });
  });

  test('everything chosen → deck "German Verbs", sections A1 … C2', () => {
    const plan = planImport(verbs, emptyLib(), choices(verbs), ctx());
    expect(plan.deck?.name).toBe('German Verbs');
    expect(plan.deck).toMatchObject({ icon: '🇩🇪', source: 'apkg', sourceKey: 'file:German_Verbs.apkg', order: 0 });
    expect(new Set(plan.notes.add.map((n) => n.section))).toEqual(new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']));
    expect(plan.summary.sections).toBe(6);
    // A note's section is its own subdeck: 'sagen' is in German::Verbs::A1.
    expect(plan.notes.add.find((n) => n.fields[0] === 'sagen')?.section).toBe('A1');
  });

  test('A1 + B1 chosen → only their notes; one subdeck → full name and section ""', () => {
    const two = new Set([didOf(verbs, 'German::Verbs::A1'), didOf(verbs, 'German::Verbs::B1')]);
    const plan = planImport(verbs, emptyLib(), choices(verbs, { sections: two }), ctx());
    expect(plan.notes.add).toHaveLength(7);
    expect(new Set(plan.notes.add.map((n) => n.section))).toEqual(new Set(['A1', 'B1']));
    expect(plan.deck?.name).toBe('German Verbs');

    const one = new Set([didOf(verbs, 'German::Verbs::B1')]);
    expect(suggestDeckName(verbs, one)).toBe('German Verbs B1');
    const single = planImport(verbs, emptyLib(), choices(verbs, { sections: one }), ctx());
    expect(single.deck?.name).toBe('German Verbs B1');
    expect(single.notes.add.every((n) => n.section === '')).toBe(true);
    expect(single.summary.sections).toBe(0);
  });

  test('the name the learner typed wins; no common prefix → the file name', () => {
    const plan = planImport(verbs, emptyLib(), choices(verbs, { target: { kind: 'new', name: ' Verben ', icon: '' } }), ctx());
    expect(plan.deck?.name).toBe('Verben');
    expect(plan.deck?.icon).toBe('🗂️');
    const mixed = { ...verbs, decks: { ...verbs.decks, '2710130001': 'Other::Verbs' } };
    expect(suggestDeckName(mixed)).toBe('German_Verbs');
  });

  test('Anki\'s "Default" deck is the root: only Default → the file name; its notes get section ""', () => {
    // A tiny Basic collection: one note (and one card) per entry of `homes`, in that subdeck.
    const tiny = (decks: Record<string, string>, homes: string[]): AnkiCollection => ({
      fileName: 'MyDeck.apkg',
      crt: 0,
      models: { m: { name: 'Basic', type: 0, sortf: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
        tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }] } },
      decks,
      notes: homes.map((_, i) => ({ id: String(i + 1), guid: `g${i}`, mid: 'm', flds: [`w${i}`, `m${i}`], tags: [] })),
      cards: homes.map((did, i) => ({ id: `c${i}`, nid: String(i + 1), did, odid: '0', ord: 0, type: 0, queue: 0, due: i,
        ivl: 0, factor: 0, reps: 0, lapses: 0, flags: 0 })),
      media: {},
    });
    // Exported from Anki's "Default" deck → named after the file, as today (anki.ts ankiDeckName).
    const onlyDefault = tiny({ '1': 'Default' }, ['1', '1']);
    expect(suggestDeckName(onlyDefault)).toBe('MyDeck');
    const plan = planImport(onlyDefault, emptyLib(), choices(onlyDefault), ctx());
    expect(plan.deck?.name).toBe('MyDeck');
    expect(plan.notes.add.map((n) => n.section)).toEqual(['', '']);

    // Default next to real subdecks: the name comes from the subdecks (today: "German"), and no
    // section is called "Default".
    const mixed = tiny({ '1': 'Default', '2': 'German::A1', '3': 'German::A2' }, ['1', '2', '3']);
    expect(suggestDeckName(mixed)).toBe('German');
    const mixedPlan = planImport(mixed, emptyLib(), choices(mixed), ctx());
    expect(mixedPlan.deck?.name).toBe('German');
    expect(mixedPlan.notes.add.map((n) => n.section)).toEqual(['', 'A1', 'A2']);
    // The "Choose sections" list still shows the Default deck by its name.
    expect(collectionSections(mixed).map((s) => s.name)).toEqual(['Default', 'German::A1', 'German::A2']);
  });

  test('sectionCut: how deep the root was when a section was cut from a path', () => {
    expect(sectionCut(['German', 'Verbs', 'A1'], '')).toBe(3);
    expect(sectionCut(['German', 'Verbs', 'A1'], 'A1')).toBe(2);
    expect(sectionCut(['German', 'Verbs', 'A1'], 'Verbs::A1')).toBe(1);
    expect(sectionCut(['German', 'Verbs', 'A1'], 'B2')).toBeNull();
    expect(sectionCut(['A1'], 'Verbs::A1')).toBeNull();
  });

  /** Sections of the target deck's notes, by section → count. */
  const sectionCounts = (lib: Lib, deckId: string) => {
    const inDeck = new Set(lib.cards.filter((c) => c.deckId === deckId).map((c) => c.noteId));
    const out: Record<string, number> = {};
    for (const n of lib.notes) if (inDeck.has(n.id)) out[n.section] = (out[n.section] ?? 0) + 1;
    return out;
  };
  const only = (...levels: string[]) => new Set(levels.map((l) => didOf(verbs, `German::Verbs::${l}`)));

  test('A1 now, the whole file later into that deck: A1 moves to section "A1" (one consistent tree)', () => {
    const a1 = planImport(verbs, emptyLib(), choices(verbs, { sections: only('A1') }), ctx('a'));
    const deckId = (a1.deck as Deck).id;
    const lib = apply(emptyLib(), a1);
    expect(sectionCounts(lib, deckId)).toEqual({ '': 4 });
    const all = planImport(verbs, lib, choices(verbs, { target: { kind: 'existing', deckId } }), ctx('b'));
    const after = apply(lib, all);
    expect(sectionCounts(after, deckId)).toEqual({ A1: 4, A2: 4, B1: 3, B2: 3, C1: 3, C2: 3 });
    expect(all.summary).toMatchObject({ notesUpdated: 4, inTargetDeck: 4 });
    // Again: nothing moves any more.
    const again = planImport(verbs, after, choices(verbs, { target: { kind: 'existing', deckId } }), ctx('c'));
    expect(again.summary).toMatchObject({ notesUpdated: 0, notesAdded: 0, notesUnchanged: 20 });
  });

  test('A1 now, A2 later into that deck: sections A1 and A2 (the A1 notes are not chosen, only their section moves)', () => {
    const a1 = planImport(verbs, emptyLib(), choices(verbs, { sections: only('A1') }), ctx('a'));
    const deckId = (a1.deck as Deck).id;
    const lib = apply(emptyLib(), a1);
    const a2 = planImport(verbs, lib, choices(verbs, { sections: only('A2'), target: { kind: 'existing', deckId } }), ctx('b'));
    expect(a2.notes.add.every((n) => n.section === 'A2')).toBe(true);
    const a1Notes = lib.notes.map((n) => n.id);
    expect(a2.notes.update.map((u) => [u.id, u.section])).toEqual(a1Notes.map((id) => [id, 'A1']));
    // Only the section changes: fields and tags stay.
    for (const u of a2.notes.update) {
      const before = lib.notes.find((n) => n.id === u.id) as Note;
      expect([u.fields, u.tags]).toEqual([before.fields, before.tags]);
    }
    expect(sectionCounts(apply(lib, a2), deckId)).toEqual({ A1: 4, A2: 4 });
  });

  test('A2 + B1 now, C1 later (the default target): C1 gets section "C1", not ""', () => {
    const first = planImport(verbs, emptyLib(), choices(verbs, { sections: only('A2', 'B1') }), ctx('a'));
    const deckId = (first.deck as Deck).id;
    const lib = apply(emptyLib(), first);
    const c1 = planImport(verbs, lib, choices(verbs, { sections: only('C1'), target: { kind: 'existing', deckId } }), ctx('b'));
    expect(c1.notes.add.map((n) => n.section)).toEqual(['C1', 'C1', 'C1']);
    expect(c1.notes.update).toEqual([]); // A2 and B1 were cut from the same root: nothing moves
  });

  test('everything, B1 deleted, then only B1 again into the deck: B1 gets section "B1"', () => {
    const all = planImport(verbs, emptyLib(), choices(verbs), ctx('a'));
    const deckId = (all.deck as Deck).id;
    const full = apply(emptyLib(), all);
    const b1 = new Set(full.notes.filter((n) => n.section === 'B1').map((n) => n.id));
    const lib: Lib = { ...full, notes: full.notes.filter((n) => !b1.has(n.id)), cards: full.cards.filter((c) => !b1.has(c.noteId)) };
    const again = planImport(verbs, lib, choices(verbs, { sections: only('B1'), target: { kind: 'existing', deckId } }), ctx('b'));
    expect(again.notes.add.map((n) => n.section)).toEqual(['B1', 'B1', 'B1']);
    expect(again.notes.update).toEqual([]);
  });

  test('a section the learner chose is kept; a deck without notes of this file keeps today\'s rule', () => {
    const a1 = planImport(verbs, emptyLib(), choices(verbs, { sections: only('A1') }), ctx('a'));
    const deckId = (a1.deck as Deck).id;
    const lib = apply(emptyLib(), a1);
    // The learner moved one A1 note to their own section "Favourites".
    const moved: Lib = { ...lib, notes: lib.notes.map((n, i) => (i === 0 ? { ...n, section: 'Favourites' } : n)) };
    const all = planImport(verbs, moved, choices(verbs, { target: { kind: 'existing', deckId } }), ctx('b'));
    const after = apply(moved, all);
    expect(after.notes.find((n) => n.id === moved.notes[0].id)?.section).toBe('Favourites');
    // One subdeck into a deck that holds nothing of this file: section '' (spec §5.4).
    const other = planImport(verbs, emptyLib(), choices(verbs, { sections: only('B2') }), ctx('c'));
    const lib2 = apply(emptyLib(), { ...other, notes: { ...other.notes, add: [] }, cards: { add: [] } });
    const deck2 = (other.deck as Deck).id;
    const b2 = planImport(verbs, lib2, choices(verbs, { sections: only('B2'), target: { kind: 'existing', deckId: deck2 } }), ctx('d'));
    expect(b2.notes.add.every((n) => n.section === '')).toBe(true);
  });

  test('a card in a filtered deck counts in its home deck (odid)', () => {
    const c = edit(verbs, (d) => {
      const first = d.cards.find((x) => x.nid === d.notes[0].id && x.ord === 0);
      if (first) {
        first.odid = first.did;
        first.did = '1'; // the "Default" deck plays the filtered deck
      }
    });
    const plan = planImport(c, emptyLib(), choices(c), ctx());
    expect(plan.notes.add.find((n) => n.fields[0] === 'sagen')?.section).toBe('A1');
  });
});

/* ------------------------------------------------------- types and cards */

describe('card types and directions', () => {
  const verbs = fixture('german_verbs');

  test('one card per enabled direction; siblings share deck and newPos', () => {
    const both = planImport(verbs, emptyLib(), choices(verbs), ctx());
    expect(both.cards.add).toHaveLength(40);
    expect(both.summary).toMatchObject({ notesAdded: 20, cardsAdded: 40, newCards: 40 });
    const t = mapping(verbs);
    t['2710131000'].ords = [1];
    const reverseOnly = planImport(verbs, emptyLib(), choices(verbs, { types: t }), ctx());
    expect(reverseOnly.cards.add).toHaveLength(20);
    expect(reverseOnly.cards.add.every((c) => c.ord === 1)).toBe(true);
    for (const n of both.notes.add) {
      const cards = both.cards.add.filter((c) => c.noteId === n.id);
      expect(cards.map((c) => c.ord)).toEqual([0, 1]);
      expect(new Set(cards.map((c) => c.deckId))).toEqual(new Set([both.deck?.id]));
      expect(cards.every((c) => c.newPos === n.order)).toBe(true);
    }
    // New-card order follows the note ids (genanki: every new position is 0).
    expect(both.notes.add.map((n) => n.order)).toEqual([...both.notes.add.keys()]);
  });

  test('the card type: fields from the mapping, directions from the templates (EN-DE prompt = Meaning + CaseInfo)', () => {
    const plan = planImport(verbs, emptyLib(), choices(verbs, { types: mapping(verbs, VERBS_ROLES) }), ctx());
    expect(plan.noteTypes.add).toHaveLength(1);
    const type = plan.noteTypes.add[0];
    expect(type).toMatchObject({
      name: 'German Verbs (bidirectional)',
      kind: 'standard',
      sortField: 0,
      source: { ankiMid: '2710131000' },
    });
    expect(type.fields.map((f) => [f.name, f.role])).toEqual([
      ['Verb', 'term'],
      ['Meaning', 'meaning'],
      ['CaseInfo', 'example'],
      ['Conjugation', 'detail'],
      ['Perfekt', 'detail'],
      ['Prateritum', 'detail'],
      ['Example', 'example'],
      ['Level', 'badge'],
      ['Tags', 'badge'],
    ]);
    const [deEn, enDe] = type.templates;
    expect(deEn).toMatchObject({ ord: 0, name: 'DE-EN', prompt: [0] });
    expect(deEn.answer).toEqual([1, 2, 3, 4, 5, 6]);
    expect(enDe).toMatchObject({ ord: 1, name: 'EN-DE', prompt: [1, 2] });
    expect(enDe.answer).toEqual([0, 3, 4, 5, 6]);
    expect(enDe.qfmt).toContain('Hint:');
    expect(plan.notes.add[0].fields).toHaveLength(9);
    expect(plan.notes.add[0].source).toEqual({ kind: 'apkg', ref: 'German_Verbs.apkg', ankiNoteId: verbs.notes[0].id });
    expect(plan.notes.add[0].guid).toBe(verbs.notes[0].guid);
  });

  test('templates given by roles.ts (choices.types[mid].templates) are stored as they are', () => {
    const t = mapping(verbs, VERBS_ROLES);
    const given = [
      { ord: 0, name: 'German → English', prompt: [0], answer: [1] },
      { ord: 1, name: 'English → German', prompt: [1, 2], answer: [0] },
    ];
    t['2710131000'].templates = given;
    const plan = planImport(verbs, emptyLib(), choices(verbs, { types: t }), ctx());
    expect(plan.noteTypes.add[0].templates).toEqual(given);
    expect(plan.noteTypes.add[0].templates).not.toBe(given);
  });

  test('templateFieldRefs: conditionals, triple braces, tts, type and filters', () => {
    const names = ['Word', 'Meaning', 'Audio', 'Level'];
    expect(
      templateFieldRefs('{{#Meaning}}{{{Meaning}}}{{/Meaning}} {{text:Word}} {{tts de_DE:Word}} {{FrontSide}} {{Nope}}', names),
    ).toEqual({ shown: [1, 0] });
    expect(templateFieldRefs('{{Word}} {{type:Meaning}}', names)).toEqual({ shown: [0], typeField: 1 });
    expect(templateFieldRefs('{{cloze:Word}} {{word}}', names)).toEqual({ shown: [0] });
  });

  test('{{type:F}} on the answer side shows F: "Basic (type in the answer)" has an answer on reveal', () => {
    const names = ['Front', 'Back', 'Extra'];
    // Anki's stock "Basic (type in the answer)" templates.
    const qfmt = '{{Front}}\n\n{{type:Back}}';
    const afmt = '{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}';
    expect(templateFieldRefs(qfmt, names)).toEqual({ shown: [0], typeField: 1 }); // a typing box, not the answer
    expect(templateFieldRefs(afmt, names, { side: 'answer' })).toEqual({ shown: [0, 1], typeField: 1 });
    const fields: FieldDef[] = [
      { name: 'Front', role: 'term', facet: 'off' },
      { name: 'Back', role: 'meaning', facet: 'off' },
      { name: 'Extra', role: 'detail', facet: 'auto' },
    ];
    const model = (a: string) => ({ name: 'Basic (type in the answer)', type: 0 as const, sortf: 0,
      flds: names.map((name, ord) => ({ name, ord })), tmpls: [{ name: 'Card 1', ord: 0, qfmt, afmt: a }] });
    expect(templatesFromModel(model(afmt), fields, 0)[0]).toMatchObject({ prompt: [0], answer: [1], typeField: 1 });
    // {{FrontSide}} repeats the question; Anki shows the typed-answer check (the correct answer) in its place.
    expect(templatesFromModel(model('{{FrontSide}}<hr id=answer>{{Extra}}'), fields, 0)[0]).toMatchObject({
      prompt: [0],
      answer: [1, 2],
      typeField: 1,
    });
  });

  test('a prompt made only of badges keeps its raw fields (never an empty question)', () => {
    const model = { name: 'm', type: 0 as const, sortf: 0, flds: [{ name: 'A', ord: 0 }, { name: 'L', ord: 1 }],
      tmpls: [{ name: 't', ord: 0, qfmt: '{{L}}', afmt: '{{A}}' }] };
    const fields: FieldDef[] = [
      { name: 'A', role: 'term', facet: 'off' },
      { name: 'L', role: 'badge', facet: 'auto' },
    ];
    expect(templatesFromModel(model, fields, 0)[0]).toMatchObject({ prompt: [1], answer: [0] });
  });

  test('a cloze card type imports every cloze card, whatever the ords', () => {
    const c: AnkiCollection = {
      fileName: 'cloze.apkg',
      crt: 0,
      models: { m: { name: 'Cloze', type: 1, sortf: 0, flds: [{ name: 'Text', ord: 0 }, { name: 'Extra', ord: 1 }],
        tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Extra}}' }] } },
      decks: { d: 'Cloze deck' },
      notes: [{ id: '1', guid: 'g', mid: 'm', flds: ['{{c1::Berlin}} is in {{c2::Germany}}', ''], tags: [] }],
      cards: [0, 1].map((ord) => ({ id: `c${ord}`, nid: '1', did: 'd', odid: '0', ord, type: 0, queue: 0, due: 1, ivl: 0,
        factor: 0, reps: 0, lapses: 0, flags: 0 })),
      media: {},
    };
    const t = mapping(c);
    t.m.ords = [0];
    const plan = planImport(c, emptyLib(), choices(c, { types: t }), ctx());
    expect(plan.noteTypes.add[0].kind).toBe('cloze');
    expect(plan.cards.add.map((x) => x.ord)).toEqual([0, 1]);
  });

  test('a note whose card type is unknown, or that has no card, is skipped as empty', () => {
    const c = edit(verbs, (d) => {
      d.notes[0].mid = 'missing';
      d.cards = d.cards.filter((x) => x.nid !== d.notes[1].id);
    });
    // Notes without card rows have no home subdeck: choose the '' bucket too.
    const sections = new Set([...collectionSections(c).map((s) => s.did), '']);
    const plan = planImport(c, emptyLib(), choices(c, { sections }), ctx());
    expect(plan.summary.skipped.empty).toBe(2);
    expect(plan.summary.notesAdded).toBe(18);
  });

  test('an existing target deck that is gone throws', () => {
    expect(() =>
      planImport(verbs, emptyLib(), choices(verbs, { target: { kind: 'existing', deckId: 'nope' } }), ctx()),
    ).toThrow('does not exist');
  });
});

/* ------------------------------------------------------------- re-import */

describe('re-import by guid', () => {
  const verbs = fixture('german_verbs');
  const first = planImport(verbs, emptyLib(), choices(verbs), ctx('a'));
  const deckId = first.deck?.id as string;
  // The learner studied one card since the first import.
  const studied = apply(emptyLib(), first);
  studied.cards = studied.cards.map((c, i) =>
    i === 0 ? { ...c, reps: 4, intervalDays: 12, ease: 2.3, stepIndex: null, due: FIXED_NOW + 5 } : c,
  );

  test('same guid in the target deck → fields + tags updated, cards and progress untouched', () => {
    const changed = edit(verbs, (d) => {
      d.notes[0].flds[1] = 'to say (new meaning)';
      d.notes[0].tags = ['edited'];
    });
    const plan = planImport(changed, studied, choices(changed, { target: { kind: 'existing', deckId } }), ctx('b'));
    expect(plan.deck).toBeNull();
    expect(plan.noteTypes).toEqual({ add: [], reuse: { '2710131000': first.noteTypes.add[0].id }, upgrade: [] });
    expect(plan.notes.add).toEqual([]);
    expect(plan.cards.add).toEqual([]); // the plan never rewrites a card: ids and SRS stay
    const target = studied.notes.find((n) => n.guid === verbs.notes[0].guid) as Note;
    expect(plan.notes.update).toEqual([
      { id: target.id, fields: expect.arrayContaining(['to say (new meaning)']), tags: ['edited'] },
    ]);
    expect(plan.summary).toMatchObject({
      inTargetDeck: 20,
      inOtherDecks: 0,
      notesUpdated: 1,
      notesUnchanged: 19,
      cardsUpdated: 2,
      updatedDecks: ['German Verbs'],
      notesAdded: 0,
      cardsAdded: 0,
    });
  });

  test('the same file again → "Already up to date" (nothing added, nothing updated)', () => {
    const plan = planImport(verbs, studied, choices(verbs, { target: { kind: 'existing', deckId } }), ctx('c'));
    expect(plan.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0, notesUpdated: 0, notesUnchanged: 20 });
    expect(plan.notes.update).toEqual([]);
  });

  test('newly enabled directions add cards next to the existing siblings', () => {
    const t = mapping(verbs);
    t['2710131000'].ords = [0];
    const forwardOnly = planImport(verbs, emptyLib(), choices(verbs, { types: t }), ctx('d'));
    const lib = apply(emptyLib(), forwardOnly);
    const plan = planImport(verbs, lib, choices(verbs, { target: { kind: 'existing', deckId: forwardOnly.deck?.id as string } }), ctx('e'));
    expect(plan.cards.add).toHaveLength(20);
    for (const card of plan.cards.add) {
      const sibling = lib.cards.find((c) => c.noteId === card.noteId) as Card;
      expect(card.ord).toBe(1);
      expect(card.deckId).toBe(sibling.deckId);
      expect(card.newPos).toBe(sibling.newPos);
    }
    expect(plan.summary).toMatchObject({ notesUnchanged: 20, cardsAdded: 20, notesAdded: 0 });
  });

  test('same guid in ANOTHER deck: update where it is (default), copy, or skip', () => {
    const changed = edit(verbs, (d) => {
      d.notes[2].flds[1] = 'to visit!';
    });
    const toNew = (elsewhere: ImportChoices['elsewhere']) =>
      planImport(changed, studied, choices(changed, { elsewhere, target: { kind: 'new', name: 'Fresh', icon: '📗' } }), ctx('f'));

    const update = toNew('update');
    expect(update.deck).toBeNull(); // every note is an update: no empty deck
    expect(update.summary).toMatchObject({ inOtherDecks: 20, notesUpdated: 1, notesUnchanged: 19, notesAdded: 0 });
    expect(update.notes.update[0].fields[1]).toBe('to visit!');

    const copy = toNew('copy');
    expect(copy.deck?.name).toBe('Fresh');
    expect(copy.notes.add).toHaveLength(20);
    expect(copy.notes.add.every((n) => n.guid.startsWith('m-'))).toBe(true);
    expect(new Set(copy.notes.add.map((n) => n.guid)).size).toBe(20);
    expect(copy.summary.overlap).toEqual([]); // a copy of the same item is not an "overlap"

    const skip = toNew('skip');
    expect(skip.deck).toBeNull();
    expect(skip.summary).toMatchObject({ notesSkipped: 20, skipped: { elsewhere: 20, alreadyHere: 0, overlap: 0, empty: 0 } });
    expect(skip.noteTypes.add).toEqual([]);
  });

  test('copies get a DERIVED guid, so a later import into their deck updates them instead of adding them again', () => {
    // Deck A has the originals (`studied`); "Import as copies here" makes deck B.
    const copy = planImport(verbs, studied, choices(verbs, { elsewhere: 'copy', target: { kind: 'new', name: 'B', icon: '📗' } }), ctx('cp'));
    const deckB = (copy.deck as Deck).id;
    expect(copy.notes.add.map((n) => n.guid)).toEqual(verbs.notes.map((n) => copyGuid(n.guid, deckB)));
    expect(copy.notes.add.map((n) => copyOrigin(n.guid))).toEqual(verbs.notes.map((n) => n.guid));
    const withB = apply(studied, copy);

    // The same file into deck B with "copy" again: every copy is found there, nothing is added.
    const again = planImport(verbs, withB, choices(verbs, { elsewhere: 'copy', target: { kind: 'existing', deckId: deckB } }), ctx('cp2'));
    expect(again.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0, inTargetDeck: 20, inOtherDecks: 0, notesUnchanged: 20 });

    // The originals are deleted (deck A and its cards): the default 'update' into B still finds the copies.
    const onlyB: Lib = {
      ...withB,
      notes: withB.notes.filter((n) => copyOrigin(n.guid) !== null),
      cards: withB.cards.filter((c) => c.deckId === deckB),
      decks: withB.decks.filter((d) => d.id === deckB),
    };
    const changed = edit(verbs, (d) => {
      d.notes[0].flds[1] = 'to say (new)';
    });
    const update = planImport(changed, onlyB, choices(changed, { target: { kind: 'existing', deckId: deckB } }), ctx('cp3'));
    expect(update.summary).toMatchObject({ notesAdded: 0, inTargetDeck: 20, notesUpdated: 1, notesUnchanged: 19 });
    expect(update.notes.update[0].fields[1]).toBe('to say (new)');
  });

  test('an Anki model imported before is reused with its OWN roles, whatever the new mapping says', () => {
    // The first import used positional roles; now the Fields screen says Level is a badge.
    const t = mapping(verbs, VERBS_ROLES);
    const plan = planImport(verbs, studied, choices(verbs, { types: t, target: { kind: 'existing', deckId } }), ctx('h'));
    expect(plan.noteTypes).toEqual({ add: [], reuse: { '2710131000': first.noteTypes.add[0].id }, upgrade: [] });
    // The Fields screen can show those roles: findReusableType finds the type with or without a choice.
    const reused = findReusableType(verbs, '2710131000', studied.noteTypes, t['2710131000']);
    expect(reused?.id).toBe(first.noteTypes.add[0].id);
    expect(findReusableType(verbs, '2710131000', studied.noteTypes)?.fields[7].role).toBe('detail');
    expect(findReusableType(verbs, 'unknown-model', studied.noteTypes)).toBeUndefined();
  });

  test('a changed card type is updated by field NAME', () => {
    const lib = apply(emptyLib(), first);
    // The FILE now has another card type (a new model id, fields in another order),
    // but the same guids: each value goes to the field with the same name.
    const other = edit(verbs, (d) => {
      d.models = { x: { ...verbs.models['2710131000'], flds: [{ name: 'Meaning', ord: 0 }, { name: 'Verb', ord: 1 }] } };
      d.notes = d.notes.map((n) => ({ ...n, mid: 'x', flds: ['MEANING ' + n.flds[0], n.flds[0]] }));
    });
    const plan = planImport(other, lib, choices(other, { target: { kind: 'existing', deckId } }), ctx('g'));
    const u = plan.notes.update[0];
    const before = lib.notes.find((n) => n.id === u.id) as Note;
    expect(u.fields[0]).toBe(before.fields[0]); // Verb: same value from the "Verb" column
    expect(u.fields[1]).toBe(`MEANING ${before.fields[0]}`);
    expect(u.fields.slice(2)).toEqual(before.fields.slice(2)); // fields the file lacks keep their value
    expect(plan.cards.add).toEqual([]); // another card type: no new directions
  });
});

/* -------------------------------------------------------------- duplicates */

describe('duplicates and overlaps', () => {
  test('a duplicate guid inside the file gets a fresh guid', () => {
    const verbs = edit(fixture('german_verbs'), (d) => {
      d.notes[1].guid = d.notes[0].guid;
    });
    const plan = planImport(verbs, emptyLib(), choices(verbs), ctx());
    expect(plan.summary.guidsRenamed).toBe(1);
    expect(plan.notes.add).toHaveLength(20);
    expect(plan.notes.add[0].guid).toBe(verbs.notes[0].guid);
    expect(plan.notes.add[1].guid).toMatch(/^m-/);
    expect(plan.notes.add[1].guid).toBe(`m-${verbs.notes[0].guid}~1`);
  });

  test('the same file with a duplicate guid imported again adds nothing (the renamed guid is derived)', () => {
    const verbs = edit(fixture('german_verbs'), (d) => {
      d.notes[1].guid = d.notes[0].guid;
    });
    const first = planImport(verbs, emptyLib(), choices(verbs), ctx('a'));
    const lib = apply(emptyLib(), first);
    const deckId = first.deck?.id as string;
    for (const prefix of ['b', 'c']) {
      const again = planImport(verbs, lib, choices(verbs, { target: { kind: 'existing', deckId } }), ctx(prefix));
      expect(again.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0, notesUpdated: 0, notesUnchanged: 20, inTargetDeck: 20 });
      expect(again.summary.guidsRenamed).toBe(0);
    }
    // The renamed note is found by its derived guid: an edit in the file updates it.
    const edited = edit(verbs, (d) => {
      d.notes[1].flds[1] = 'changed';
    });
    const update = planImport(edited, lib, choices(edited, { target: { kind: 'existing', deckId } }), ctx('d'));
    expect(update.summary).toMatchObject({ notesAdded: 0, notesUpdated: 1 });
    expect(update.notes.update[0].id).toBe(first.notes.add[1].id);
    // Into a new deck it is found where it is, like every other note.
    const elsewhere = planImport(verbs, lib, choices(verbs), ctx('e'));
    expect(elsewhere.deck).toBeNull();
    expect(elsewhere.summary).toMatchObject({ notesAdded: 0, inOtherDecks: 20, notesUnchanged: 20 });
  });

  test('fileGuids: a repeat gets m-<guid>~<k>, never a guid the file already has; decided over the whole file', () => {
    expect(fileGuids([{ guid: 'a' }, { guid: 'a' }, { guid: '' }, { guid: 'a' }, { guid: 'm-a~2' }, { guid: '' }])).toEqual([
      { guid: 'a', renamed: false },
      { guid: 'm-a~1', renamed: true },
      { guid: '', renamed: false },
      { guid: 'm-a~3', renamed: true }, // m-a~2 is a real guid of the file
      { guid: 'm-a~2', renamed: false },
      { guid: '', renamed: false },
    ]);
    // The first note with the guid is in a section that is NOT chosen: the repeat is still renamed,
    // so its guid does not depend on the sections the learner picks.
    const base = fixture('german_verbs');
    const k = base.notes.findIndex((n) => homeDidOf(base, n.id) !== homeDidOf(base, base.notes[0].id));
    const verbs = edit(base, (d) => {
      d.notes[k].guid = d.notes[0].guid;
    });
    const plan = planImport(verbs, emptyLib(), choices(verbs, { sections: new Set([homeDidOf(verbs, verbs.notes[k].id)]) }), ctx());
    const repeat = plan.notes.add.find((n) => n.source.ankiNoteId === verbs.notes[k].id) as Note;
    expect(repeat.guid).toBe(`m-${verbs.notes[0].guid}~1`);
    expect(plan.summary.guidsRenamed).toBe(1);
  });

  test('no guid: skipped when the TARGET deck has the same card type and folded sort field', () => {
    const csv = (text: string) => readCsv(text, 'words.csv');
    const base = csv('Äpfel,apples\ncat,animal');
    const lib = apply(emptyLib(), planImport(base, emptyLib(), csvChoices(base), ctx('a')));
    const deckId = lib.decks[0].id;
    const again = csv('apfel,APPLES\ndog,animal');
    const plan = planImport(again, lib, csvChoices(again, { target: { kind: 'existing', deckId } }), ctx('b'));
    expect(plan.summary.skipped.alreadyHere).toBe(1);
    expect(plan.notes.add.map((n) => n.fields[0])).toEqual(['dog']);
    expect(plan.notes.add[0].guid).toMatch(/^m-/);
    // Into a NEW deck nothing is "already here".
    const fresh = planImport(again, lib, csvChoices(again), ctx('c'));
    expect(fresh.summary.skipped.alreadyHere).toBe(0);
    expect(fresh.notes.add).toHaveLength(2);
  });

  test('same headword in another deck with another guid → counted per deck; "Skip these" skips them', () => {
    const vocab = readCsv('sagen,to say\nkennen,to know\nHaus,house', 'Vocab.csv');
    const lib = apply(emptyLib(), planImport(vocab, emptyLib(), csvChoices(vocab), ctx('a')));
    const verbs = fixture('german_verbs');
    const plan = planImport(verbs, lib, choices(verbs), ctx('b'));
    expect(plan.summary.overlap).toEqual([{ deckId: lib.decks[0].id, deckName: 'Vocab', notes: 2 }]);
    expect(plan.notes.add).toHaveLength(20); // imported normally
    const skip = planImport(verbs, lib, choices(verbs, { skipOverlap: true }), ctx('c'));
    expect(skip.summary.skipped.overlap).toBe(2);
    expect(skip.notes.add).toHaveLength(18);
    expect(skip.summary.overlap[0].notes).toBe(2); // the line stays, so the choice can be undone
  });
});

function csvChoices(c: AnkiCollection, over: Partial<ImportChoices> = {}): ImportChoices {
  const types: ImportChoices['types'] = {};
  for (const mid of Object.keys(c.models)) {
    types[mid] = { fields: positionalFieldDefs(c.models[mid].flds.map((f) => f.name)), ords: [0] };
  }
  return choices(c, { types, sections: new Set(Object.keys(c.decks)), ...over });
}

/* -------------------------------------------------- CSV: Front and Back */

describe('CSV: the columns chosen as Front and Back', () => {
  // "Level" first, as many word lists have it: Level = Filter, Word = Front, Meaning = Back.
  const LEVEL_FIRST: FieldDef[] = [
    { name: 'Level', role: 'badge', facet: 'on' },
    { name: 'Word', role: 'term', facet: 'off' },
    { name: 'Meaning', role: 'meaning', facet: 'off' },
  ];
  const read = (rows: string, file = 'words.csv') => readCsv(`Level,Word,Meaning\n${rows}`, file, { header: true });
  const levelFirst = (c: AnkiCollection, over: Partial<ImportChoices> = {}, ords = [0]) =>
    csvChoices(c, { types: { [CSV_MODEL_ID]: { fields: LEVEL_FIRST.map((f) => ({ ...f })), ords } }, ...over });

  test('csvFrontBack: Front = the term column, Back = the meaning column; the fallbacks', () => {
    expect(csvFrontBack(positionalFieldDefs(['Field 1', 'Field 2', 'Field 3']))).toEqual({ front: 0, back: 1 });
    expect(csvFrontBack(LEVEL_FIRST)).toEqual({ front: 1, back: 2 });
    const f = (role: FieldRole): FieldDef => ({ name: role, role, facet: 'off' });
    // No Front chosen → the first shown column; no Back → the first other shown column.
    expect(csvFrontBack([f('badge'), f('detail'), f('example')])).toEqual({ front: 1, back: 2 });
    // Nothing else is shown → the first other column.
    expect(csvFrontBack([f('hidden'), f('term')])).toEqual({ front: 1, back: 0 });
    // One column: there is no reverse direction.
    expect(csvFrontBack([f('term')])).toEqual({ front: 0, back: 0 });
  });

  test('the question and the sort field are the Front column, not column 0', () => {
    const c = read('A1,Haus,house\n,Wald,forest');
    const plan = planImport(c, emptyLib(), levelFirst(c, {}, [0, 1]), ctx());
    const type = plan.noteTypes.add[0];
    expect(type.sortField).toBe(1);
    expect(type.templates.map((t) => [t.ord, t.prompt, t.answer])).toEqual([
      [0, [1], [2]], // Word → Meaning (Level is a pill, never the question)
      [1, [2], [1]], // "Also make a reverse card" asks the Meaning column
    ]);
    // A blank Level does not make the question blank: "Wald" is imported.
    expect(plan.summary.skipped.empty).toBe(0);
    expect(plan.notes.add.map((n) => n.fields[1])).toEqual(['Haus', 'Wald']);
    expect(plan.cards.add).toHaveLength(4);
  });

  test('the answer headline is the Back column, then the other shown columns in order', () => {
    const c = readCsv('Example,Word,Meaning\nDas Haus ist alt.,Haus,house', 'e.csv', { header: true });
    const fields: FieldDef[] = [
      { name: 'Example', role: 'example', facet: 'off' },
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
    ];
    const plan = planImport(c, emptyLib(), csvChoices(c, { types: { [CSV_MODEL_ID]: { fields, ords: [0, 1] } } }), ctx());
    expect(plan.noteTypes.add[0].templates.map((t) => [t.prompt, t.answer])).toEqual([
      [[1], [2, 0]],
      [[2], [1, 0]],
    ]);
  });

  test('"already here" and the headword overlap compare the Front column', () => {
    const first = read('A1,Haus,house\nA1,Baum,tree');
    const lib = apply(emptyLib(), planImport(first, emptyLib(), levelFirst(first), ctx('a')));
    const deckId = lib.decks[0].id;
    // New words with the same Level are NOT "already here"; a word the deck has is.
    const second = read('A1,Katze,cat\nA1,Hund,dog\nB2,haus,home', 'b.csv');
    const into = planImport(second, lib, levelFirst(second, { target: { kind: 'existing', deckId } }), ctx('b'));
    expect(into.summary.skipped.alreadyHere).toBe(1);
    expect(into.notes.add.map((n) => n.fields[1])).toEqual(['Katze', 'Hund']);
    // Into a new deck: only "haus" also appears in the first deck (the shared Level "A1" does not count).
    const fresh = planImport(second, lib, levelFirst(second), ctx('c'));
    expect(fresh.summary.overlap).toEqual([{ deckId, deckName: 'words', notes: 1 }]);
  });
});

/* ------------------------------------------------------ arrival, placement */

describe('arrival and "Where do you start?"', () => {
  const verbs = fixture('german_verbs');
  const types = mapping(verbs, VERBS_ROLES);

  test('arrival notStarted → new cards start Not started; the new deck remembers it', () => {
    const plan = planImport(verbs, emptyLib(), choices(verbs, { types, arrival: 'notStarted' }), ctx());
    expect(plan.cards.add.every((c) => c.newState === 'notStarted')).toBe(true);
    expect(plan.summary.notStarted).toBe(40);
    expect(plan.deck?.options.newArrival).toBe('notStarted');
  });

  test('filter groups found, and the Level group offered in level order (Section collapses into Level)', () => {
    const plan = planImport(verbs, emptyLib(), choices(verbs, { types }), ctx());
    expect(plan.summary.filtersFound).toEqual(['Level', 'Verb tags']);
    expect(plan.summary.placementGroups).toEqual([
      { facet: 'field:level', label: 'Level', values: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
    ]);
  });

  test('"I know them" marks the easier levels Known; "Leave them not started" leaves them Not started', () => {
    const placement = { facet: 'field:level', fromRank: 2, below: 'known' as const };
    const known = planImport(verbs, emptyLib(), choices(verbs, { types, placement }), ctx());
    const levelOf = (card: Card) => known.notes.add.find((n) => n.id === card.noteId)?.fields[7];
    const easy = known.cards.add.filter((c) => ['A1', 'A2'].includes(levelOf(c) ?? ''));
    expect(easy).toHaveLength(16);
    expect(easy.every((c) => c.knownAt === FIXED_NOW)).toBe(true);
    expect(known.cards.add.filter((c) => c.knownAt != null)).toHaveLength(16);
    expect(known.summary.markedKnown).toBe(16);

    const later = planImport(verbs, emptyLib(), choices(verbs, { types, placement: { ...placement, below: 'notStarted' } }), ctx());
    expect(later.summary).toMatchObject({ notStarted: 16, markedKnown: 0 });
  });

  test('placement by section when the sections are levels and no field holds them', () => {
    const c = readCsv('#deck column:3\nHaus,house,Course::A1\nBaum,tree,Course::A2\nWald,forest,Course::B1', 'c.csv');
    const plan = planImport(c, emptyLib(), csvChoices(c, { placement: { facet: 'section', fromRank: 1, below: 'notStarted' } }), ctx());
    expect(plan.deck?.name).toBe('Course');
    expect(plan.summary.filtersFound).toEqual(['Section']);
    expect(plan.summary.placementGroups).toEqual([{ facet: 'section', label: 'Section', values: ['A1', 'A2', 'B1'] }]);
    expect(plan.cards.add.map((x) => x.newState)).toEqual(['notStarted', 'queued', 'queued']);
  });

  test('placement by the LAST section level when the sections are nested ("Vocabulary::A1", "Verbs::A1" …)', () => {
    const c = readCsv(
      '#deck column:3\nHaus,house,Course::Vocabulary::A1\nBaum,tree,Course::Vocabulary::A2\n' +
        'gehen,to go,Course::Verbs::A1\nsagen,to say,Course::Verbs::B1',
      'c.csv',
    );
    const plan = planImport(c, emptyLib(), csvChoices(c, { placement: { facet: 'section', fromRank: 1, below: 'known' } }), ctx());
    expect(plan.notes.add.map((n) => n.section)).toEqual(['Vocabulary::A1', 'Vocabulary::A2', 'Verbs::A1', 'Verbs::B1']);
    expect(plan.summary.placementGroups).toEqual([{ facet: 'section', label: 'Section', values: ['A1', 'A2', 'B1'] }]);
    // Both A1 sections are below A2 → Known; A2 and B1 stay New.
    expect(plan.cards.add.map((x) => x.knownAt != null)).toEqual([true, false, true, false]);
    expect(plan.summary.markedKnown).toBe(2);

    // Last levels that have no order → no "Where do you start?" block.
    const topics = readCsv('#deck column:3\nHaus,house,C::A1::Home\nBaum,tree,C::A2::Nature', 'c.csv');
    expect(planImport(topics, emptyLib(), csvChoices(topics), ctx()).summary.placementGroups).toEqual([]);
  });

  test('a placement that names no offered group, or a bad rank, changes nothing', () => {
    for (const placement of [
      { facet: 'field:nope', fromRank: 2, below: 'known' as const },
      { facet: 'field:level', fromRank: 99, below: 'known' as const },
    ]) {
      const plan = planImport(verbs, emptyLib(), choices(verbs, { types, placement }), ctx());
      expect(plan.summary.markedKnown).toBe(0);
    }
  });
});

/* ----------------------------------------------------------- Anki progress */

describe('Anki progress, suspension, flags, marked', () => {
  const crtDay = 20_000; // a review due day number
  const c = edit(fixture('german_grammar'), (d) => {
    d.cards[0] = { ...d.cards[0], type: 2, queue: 2, due: crtDay, ivl: 30, factor: 2400, reps: 6, lapses: 1 };
    d.cards[1] = { ...d.cards[1], type: 1, queue: 1, due: Math.floor(FIXED_NOW / 1000) + 60, reps: 1 };
    d.cards[2] = { ...d.cards[2], queue: -1 };
    d.cards[3] = { ...d.cards[3], flags: 4 };
    d.notes[4].tags = ['marked', 'grammar'];
  });

  test("'keep' maps progress; counts come from the plan", () => {
    const plan = planImport(c, emptyLib(), choices(c), ctx());
    const byAnki = (i: number) => plan.cards.add[plan.notes.add.findIndex((n) => n.source.ankiNoteId === c.cards[i].nid)];
    expect(byAnki(0)).toMatchObject({ reps: 6, lapses: 1, intervalDays: 30, ease: 2.4, stepIndex: null });
    expect(byAnki(1)).toMatchObject({ reps: 1, stepIndex: 0 });
    expect(byAnki(2).suspended).toBe(true);
    expect(byAnki(3)).toMatchObject({ flagged: true, flagColor: 4 });
    expect(plan.summary).toMatchObject({ progressCards: 2, suspended: 1, newCards: 18 });
    const marked = plan.notes.add.find((n) => n.source.ankiNoteId === c.notes[4].id) as Note;
    expect(marked.tags).toEqual(['grammar']); // the tag is removed …
    expect(plan.cards.add.find((x) => x.noteId === marked.id)?.fav).toBe(true); // … and the card is a favorite
  });

  test('a card in a filtered deck keeps its real schedule and new position (odue), not -100000 + n', () => {
    const fx = ankiFixture('german_grammar');
    const newNid = fx.cards[0].nid;
    const reviewNid = fx.cards[1].nid;
    fx.cards = fx.cards.map((x) => {
      if (x.nid === newNid) return { ...x, odid: x.did, did: 1, due: -99995, odue: 7 };
      if (x.nid === reviewNid) return { ...x, odid: x.did, did: 1, type: 2, queue: 2, due: -99994, odue: crtDay, ivl: 30, factor: 2400, reps: 6 };
      return x;
    });
    const filtered = collectionFromRows({ fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media });
    const plan = planImport(filtered, emptyLib(), choices(filtered), ctx());
    const noteOf = (nid: number) => plan.notes.add.find((n) => n.source.ankiNoteId === String(nid)) as Note;
    // Every other new card has position 0 (genanki), so position 7 comes after them all (not first).
    const otherNew = plan.notes.add.filter((n) => ![String(newNid), String(reviewNid)].includes(n.source.ankiNoteId ?? ''));
    expect(otherNew).toHaveLength(18);
    expect(otherNew.every((n) => n.order < noteOf(newNid).order)).toBe(true);
    const review = plan.cards.add.find((x) => x.noteId === noteOf(reviewNid).id) as Card;
    expect(review.due).toBe(ankiDayToMs(fx.col.crt, crtDay)); // not a date around the year 1750
    expect(noteOf(newNid).section).toBe(noteOf(reviewNid).section); // the home deck still gives the section
  });

  test("'reset' → every card New; the preview still knows how many had progress", () => {
    const plan = planImport(c, emptyLib(), choices(c, { progress: 'reset' }), ctx());
    expect(plan.cards.add.every((x) => x.reps === 0 && x.stepIndex === null)).toBe(true);
    expect(plan.summary).toMatchObject({ progressCards: 2, newCards: 20, suspended: 1 });
  });
});

/* --------------------------------------------------------------- media */

describe('images and audio', () => {
  const coding = { ...fixture('algo_patterns'), mediaSize: () => 1000 };

  test('referenced images are planned into media/<deckId>', () => {
    const plan = planImport(coding, emptyLib(), choices(coding), ctx());
    expect(plan.media).toHaveLength(1);
    expect(plan.media[0].files).toHaveLength(10);
    expect(plan.media[0].deckFolder).toBe(`media/${plan.deck?.id}`);
    expect(plan.summary).toMatchObject({ images: 10, imageBytes: 10_000, imagesFound: 10, imagesAskFirst: false });
  });

  test('"Include images" off → nothing planned, still counted', () => {
    const plan = planImport(coding, emptyLib(), choices(coding, { images: false }), ctx());
    expect(plan.media).toEqual([]);
    expect(plan.summary).toMatchObject({ images: 0, imageBytes: 0, imagesFound: 10, imagesFoundBytes: 10_000 });
  });

  test('a note updated where it is (another deck) gets its images in THAT deck folder; its audio counts', () => {
    const base: AnkiCollection = {
      fileName: 'pics.apkg',
      crt: 0,
      models: { m: { name: 'Basic', type: 0, sortf: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
        tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }] } },
      decks: { d: 'Pics' },
      notes: [
        { id: '1', guid: 'g1', mid: 'm', flds: ['cat', 'a cat'], tags: [] },
        { id: '2', guid: 'g2', mid: 'm', flds: ['dog', '<img src="dog.png">'], tags: [] },
      ],
      cards: ['1', '2'].map((nid) => ({ id: `c${nid}`, nid, did: 'd', odid: '0', ord: 0, type: 0, queue: 0, due: 0, ivl: 0,
        factor: 0, reps: 0, lapses: 0, flags: 0 })),
      media: { '0': 'cat.png', '1': 'dog.png', '2': 'cow.png' },
      mediaSize: () => 10,
    };
    const first = planImport(base, emptyLib(), choices(base), ctx('a'));
    expect(first.media).toEqual([{ deckFolder: `media/${first.deck?.id}`, files: ['dog.png'] }]);
    const lib = apply(emptyLib(), first);
    const oldDeck = first.deck?.id as string;

    // A newer file: 'cat' now has an image and a clip; 'cow' is new. Imported into a NEW deck.
    const newer = edit(base, (d) => {
      d.notes[0].flds[1] = 'a cat <img src="cat.png"> [sound:cat.mp3]';
      d.notes.push({ id: '3', guid: 'g3', mid: 'm', flds: ['cow', '<img src="cow.png">'], tags: [] });
      d.cards.push({ ...d.cards[0], id: 'c3', nid: '3' });
    });
    const plan = planImport(newer, lib, choices(newer, { target: { kind: 'new', name: 'More', icon: '' } }), ctx('b'));
    expect(plan.notes.update.map((u) => u.fields[0])).toEqual(['cat']); // updated in the OLD deck
    expect(plan.notes.add.map((n) => n.fields[0])).toEqual(['cow']);
    expect(plan.media).toEqual([
      { deckFolder: `media/${plan.deck?.id}`, files: ['cow.png'] },
      { deckFolder: `media/${oldDeck}`, files: ['cat.png', 'dog.png'] },
    ]);
    expect(plan.summary).toMatchObject({ images: 3, imageBytes: 30, imagesFound: 3, imagesFoundBytes: 30, audioClips: 1 });

    // Every note updated where it is (no new deck): the images still go to the old deck.
    const onlyUpdates = edit(newer, (d) => {
      d.notes = d.notes.slice(0, 2);
      d.cards = d.cards.slice(0, 2);
    });
    const plan2 = planImport(onlyUpdates, lib, choices(onlyUpdates), ctx('c'));
    expect(plan2.deck).toBeNull();
    expect(plan2.media).toEqual([{ deckFolder: `media/${oldDeck}`, files: ['cat.png', 'dog.png'] }]);
    expect(plan2.summary.audioClips).toBe(1);
  });

  test('audio clips are counted, never imported', () => {
    const c = edit(fixture('german_grammar'), (d) => {
      d.notes[0].flds[0] += ' [sound:a.mp3]';
      d.notes[1].flds[1] += ' [sound:a.mp3][sound:b.mp3]';
    });
    const plan = planImport(c, emptyLib(), choices(c), ctx());
    expect(plan.summary.audioClips).toBe(2);
    expect(plan.notes.add[0].fields[0]).toContain('[sound:a.mp3]'); // the text keeps the tag
  });
});

/* -------------------------------------------- H2: source order of studied notes */

describe('H2: notes studied in Anki keep their place in the deck order', () => {
  /** German Grammar (one card per note, notes in id order): the chosen cards studied, the others new at position i. */
  const studied = (studiedIdx: number[], originalPos: Record<number, number> = {}) =>
    edit(fixture('german_grammar'), (d) => {
      d.cards.forEach((x, i) => {
        d.cards[i] = studiedIdx.includes(i)
          ? {
              ...x,
              type: 2,
              queue: 2,
              due: 20_000,
              ivl: 10,
              factor: 2500,
              reps: 3,
              ...(i in originalPos ? { originalPos: originalPos[i] } : {}),
            }
          : { ...x, type: 0, queue: 0, due: i };
      });
    });
  /** The fixture indexes of the notes, in the order the plan gives them (note.order). */
  const feedOrder = (c: AnkiCollection, plan: ImportPlan): number[] =>
    [...plan.notes.add]
      .sort((a, b) => a.order - b.order)
      .map((n) => c.notes.findIndex((x) => x.id === n.source.ankiNoteId));
  const inIdOrder = Array.from({ length: 20 }, (_, i) => i);

  test("'reset': the two studied notes with the lowest ids come first, not last", () => {
    const c = studied([0, 1]);
    const plan = planImport(c, emptyLib(), choices(c, { progress: 'reset' }), ctx());
    expect(feedOrder(c, plan)).toEqual(inIdOrder);
    const orderOf = (i: number) => plan.notes.add.find((n) => n.source.ankiNoteId === c.notes[i].id)?.order;
    expect([orderOf(0), orderOf(1)]).toEqual([0, 1]); // was [18, 19]
    expect([orderOf(2), orderOf(3)]).toEqual([2, 3]);
    // The new-card feed reads newPos: every (now New) card has its note's order.
    for (const n of plan.notes.add) {
      for (const x of plan.cards.add.filter((card) => card.noteId === n.id)) expect(x.newPos).toBe(n.order);
    }
    // 'keep' gives the same order (the Library's "source" sort).
    const keep = planImport(c, emptyLib(), choices(c), ctx());
    expect(feedOrder(c, keep)).toEqual(inIdOrder);
  });

  test('a studied note in the middle stays right after the note before it (by note id)', () => {
    const c = studied([10, 11]);
    const plan = planImport(c, emptyLib(), choices(c, { progress: 'reset' }), ctx());
    expect(feedOrder(c, plan)).toEqual(inIdOrder);
  });

  test('the original position of a studied card (cards.data "pos", Anki 2.1.55+) is used when the file keeps it', () => {
    // Note 5 was moved to position 12 in Anki and then studied: it keeps that place.
    const c = studied([0, 1, 5], { 5: 12 });
    const plan = planImport(c, emptyLib(), choices(c, { progress: 'reset' }), ctx());
    expect(feedOrder(c, plan)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 5, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test('sourceOrder: by position, then note id; an unknown position takes its id neighbour', () => {
    const notes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id) => ({ id }));
    const pos: Record<string, number | undefined> = { n3: 7, n4: 8, n6: 3 };
    expect(sourceOrder(notes, (n) => pos[n.id]).map((n) => n.id)).toEqual(['n6', 'n1', 'n2', 'n3', 'n4', 'n5']);
    // Note ids compare as whole numbers (length first), not as text.
    const ids = [{ id: '100' }, { id: '99' }, { id: '1000' }];
    expect(sourceOrder(ids, () => undefined).map((n) => n.id)).toEqual(['99', '100', '1000']);
    // No position at all (or not a finite number) → note id order.
    expect(sourceOrder(ids, () => NaN).map((n) => n.id)).toEqual(['99', '100', '1000']);
    expect(sourceOrder([], () => 1)).toEqual([]);
  });
});

/* -------------------------------------- H2: a blank Front with a reverse card */

describe('H2: a CSV row with a blank Front and a reverse card is found again on re-import', () => {
  const bothDirections = (c: AnkiCollection, over: Partial<ImportChoices> = {}) =>
    csvChoices(c, {
      types: {
        [CSV_MODEL_ID]: { fields: positionalFieldDefs(c.models[CSV_MODEL_ID].flds.map((f) => f.name)), ords: [0, 1] },
      },
      ...over,
    });

  test('the same file again into its own deck adds nothing, every time', () => {
    const file = readCsv('Word,Translation\n,house\nBaum,tree', 'w.csv');
    const first = planImport(file, emptyLib(), bothDirections(file), ctx('a'));
    expect(first.notes.add).toHaveLength(2);
    expect(first.cards.add).toHaveLength(3); // the blank-Front row has only "Back → Front"
    let lib = apply(emptyLib(), first);
    const deckId = first.deck?.id as string;
    for (const prefix of ['b', 'c', 'd']) {
      const again = planImport(file, lib, bothDirections(file, { target: { kind: 'existing', deckId } }), ctx(prefix));
      expect(again.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0 });
      expect(again.summary.skipped.alreadyHere).toBe(2); // was 1: "house" was added again every time
      lib = apply(lib, again);
    }
    expect(lib.notes).toHaveLength(2);
  });

  test('another blank-Front row is still new; an image-only row finds itself too', () => {
    const file = readCsv('Word,Translation\n,house\nBaum,tree', 'w.csv');
    const lib = apply(emptyLib(), planImport(file, emptyLib(), bothDirections(file), ctx('a')));
    const deckId = lib.decks[0].id;
    const more = readCsv('Word,Translation\n,mouse\n,HOUSE', 'w.csv');
    const plan = planImport(more, lib, bothDirections(more, { target: { kind: 'existing', deckId } }), ctx('b'));
    expect(plan.notes.add.map((n) => n.fields[1])).toEqual(['mouse']);
    expect(plan.summary.skipped.alreadyHere).toBe(1); // ",HOUSE" = ",house" (folded, like the sort field)

    // An Anki text export with HTML: a row whose only content is an image.
    const html = readCsv('#separator:comma\n#html:true\n#columns:Front,Back\n,<img src="a.png">\nBaum,tree', 'h.txt');
    const firstHtml = planImport(html, emptyLib(), bothDirections(html), ctx('c'));
    expect(firstHtml.notes.add).toHaveLength(2);
    const libHtml = apply(emptyLib(), firstHtml);
    const intoOwn = bothDirections(html, { target: { kind: 'existing', deckId: libHtml.decks[0].id } });
    const againHtml = planImport(html, libHtml, intoOwn, ctx('d'));
    expect(againHtml.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0 });
    expect(againHtml.summary.skipped.alreadyHere).toBe(2);
  });

  test('alreadyHereKey: the sort field; every field when it is blank; nothing when all are blank', () => {
    expect(alreadyHereKey(['<b>Haus</b>', 'house'], 0)).toBe('s:haus');
    expect(alreadyHereKey(['Haus', 'house'], 1)).toBe('s:house');
    expect(alreadyHereKey(['', 'House '], 0)).toBe('f:\u001fhouse');
    // W3-5: an image-only field counts by its file name (it was the raw HTML before).
    expect(alreadyHereKey(['  ', '<img src="a.png">'], 0)).toBe('f:\u001fimg:a.png');
    expect(alreadyHereKey(['', '[sound:a.mp3]'], 0)).toBe('f:\u001fsound:a.mp3');
    expect(alreadyHereKey(['', ''], 0)).toBe('');
    // A sort-field key never equals an every-field key.
    expect(alreadyHereKey(['f:x'], 0)).not.toBe(alreadyHereKey(['', 'x'], 0));
  });

  test('W3-5: a blank sort field folds every field the same plain-text way as the sort field', () => {
    // HTML, entities, case and accents: the same folding as the 's:' key.
    expect(alreadyHereKey(['', '<b>House</b>&nbsp;'], 0)).toBe(alreadyHereKey(['', 'house'], 0));
    expect(alreadyHereKey(['', 'H&auml;user'], 0)).toBe(alreadyHereKey(['', 'Häuser'], 0));
    expect(alreadyHereKey(['', 'Haus<br>home'], 0)).toBe(alreadyHereKey(['', 'Haus home'], 0));
    // The 's:' key of a field and the 'f:' text of the same field are the same text.
    expect(alreadyHereKey(['<i>Käse</i>'], 0)).toBe('s:kase');
    expect(alreadyHereKey(['', '<i>Käse</i>'], 0)).toBe('f:\u001fkase');
    // Cloze markup is read by cloze.ts: the answer counts, not the markup.
    expect(alreadyHereKey(['{{c1::Paris}} is nice'], 0)).toBe('s:paris is nice');
  });

  test('W3-5: a re-import of an HTML export whose blank-Front row changed only its markup is "already here"', () => {
    const first = readCsv('#separator:comma\n#html:true\n#columns:Front,Back\n,<b>house</b>\nBaum,tree', 'h.txt');
    const plan1 = planImport(first, emptyLib(), bothDirections(first), ctx('a'));
    const lib = apply(emptyLib(), plan1);
    const again = readCsv('#separator:comma\n#html:true\n#columns:Front,Back\n,House&nbsp;\nBaum,tree', 'h.txt');
    const plan2 = planImport(again, lib, bothDirections(again, { target: { kind: 'existing', deckId: lib.decks[0].id } }), ctx('b'));
    expect(plan2.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0 });
    expect(plan2.summary.skipped.alreadyHere).toBe(2);
  });
});

describe('PROPERTY (H2): the same CSV file imported again into its own deck adds nothing (300 seeds)', () => {
  const CELLS = ['Haus', 'haus', 'Baum', '', '', 'gehen', '<b>x</b>', 'A1', 'B2', 'tree, wood', 'Äpfel'];
  test.each(Array.from({ length: 300 }, (_, i) => i))('seed %i', (seed) => {
    const rnd = createRandom(`csv-reimport-${seed}`);
    const width = rnd.int(1, 4);
    const header = rnd.bool(0.5) ? `${['Word', 'Meaning', 'Level', 'Notes'].slice(0, width).join(',')}\n` : '';
    const rows = Array.from({ length: rnd.int(0, 12) }, () =>
      Array.from({ length: width }, () => rnd.pick(CELLS))
        .map((v) => (v.includes(',') ? `"${v}"` : v))
        .join(','),
    );
    const file = readCsv(`${header}${rows.join('\n')}`, 'p.csv', { header: header !== '' });
    const names = file.models[CSV_MODEL_ID].flds.map((f) => f.name);
    const fields = positionalFieldDefs(names).map((f, i) =>
      i === 2 && rnd.bool(0.5) ? { ...f, role: 'badge' as const, facet: 'on' as const } : f,
    );
    const ords = names.length > 1 && rnd.bool(0.6) ? [0, 1] : [0];
    const pick = (over: Partial<ImportChoices> = {}) =>
      csvChoices(file, { types: { [CSV_MODEL_ID]: { fields, ords } }, ...over });
    const first = planImport(file, emptyLib(), pick(), ctx('a'));
    let lib = apply(emptyLib(), first);
    const deckId = first.deck?.id;
    if (deckId === undefined) {
      expect(first.notes.add).toEqual([]); // nothing to import, so no deck to import into again
      return;
    }
    for (const prefix of ['b', 'c']) {
      const again = planImport(file, lib, pick({ target: { kind: 'existing', deckId } }), ctx(prefix));
      expect(again.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0 });
      // Every note the first import added (and each repeat of it in the file) is "already here" now.
      expect(again.summary.skipped.alreadyHere).toBe(first.notes.add.length + first.summary.skipped.alreadyHere);
      lib = apply(lib, again);
    }
  });
});

/* ---------------------------------------- H2: 'Filters found' lists a label once */

describe('H2: "Filters found" lists each label once', () => {
  test('a field named "Tags" and the notes\' Anki tags give one "Tags"', () => {
    const verbs = edit(fixture('german_verbs'), (d) => {
      d.notes[0].tags = ['verb'];
    });
    // The Tags field with its default label "Tags" (no pack preset).
    const types = mapping(verbs, { ...VERBS_ROLES, Tags: { role: 'badge', facet: 'auto', multiSep: ',' } });
    const plan = planImport(verbs, emptyLib(), choices(verbs, { types }), ctx());
    expect(plan.summary.filtersFound).toEqual(['Level', 'Tags']); // was ['Level', 'Tags', 'Tags']
  });

  test('a field labelled "section" and the subdecks give one "Section"', () => {
    const c = readCsv(
      '#separator:comma\n#columns:Word,Meaning,Deck,Section\n#deck column:3\n' +
        'Haus,house,C::A1,x\nBaum,tree,C::A2,x\nWald,forest,C::B1,y',
      'c.txt',
    );
    const names = c.models[CSV_MODEL_ID].flds.map((f) => f.name);
    expect(names).toEqual(['Word', 'Meaning', 'Section']);
    const fields = positionalFieldDefs(names).map((f) =>
      f.name === 'Section' ? { ...f, role: 'badge' as const, facet: 'on' as const, label: 'section' } : f,
    );
    const plan = planImport(c, emptyLib(), csvChoices(c, { types: { [CSV_MODEL_ID]: { fields, ords: [0] } } }), ctx());
    expect(plan.summary.sections).toBe(3);
    expect(plan.summary.filtersFound).toEqual(['section']); // was ['section', 'Section']
  });
});

/* ------------------------- H2: keys from the file ("constructor", "__proto__") */

describe('H2: model ids, deck ids and field names like "constructor" or "__proto__"', () => {
  const tricky = ['__proto__', 'constructor', 'toString'];

  /** An .apkg-like collection whose model ids and deck ids are the tricky names (read by the real reader). */
  const trickyCollection = (): AnkiCollection => {
    // JSON text, so "__proto__" is an ordinary key (a JS literal `{ '__proto__': x }` would set the prototype).
    const models = tricky
      .map(
        (key) =>
          `${JSON.stringify(key)}: ${JSON.stringify({
            name: `Model ${key}`,
            type: 0,
            sortf: 0,
            flds: [
              { name: key, ord: 0 },
              { name: 'hasOwnProperty', ord: 1 },
            ],
            tmpls: [{ name: 'Card 1', ord: 0, qfmt: `{{${key}}}`, afmt: '{{hasOwnProperty}}' }],
          })}`,
      )
      .join(', ');
    const decks = tricky.map((key) => `${JSON.stringify(key)}: ${JSON.stringify({ name: `Root::${key}` })}`).join(', ');
    const card = (id: string, nid: string, did: string, due: number) => ({
      id, nid, did, odid: '0', ord: 0, type: 0, queue: 0, due, ivl: 0, factor: 0, reps: 0, lapses: 0, flags: 0,
    });
    const notes = tricky.map((mid, i) => ({ id: String(100 + i), guid: `g-${mid}`, mid, flds: `word ${i}\x1fmeaning ${i}`, tags: '' }));
    const cards = tricky.map((did, i) => card(String(200 + i), String(100 + i), did, i));
    // A note of a model the file does not have, named like a built-in method, in a deck that is not there.
    notes.push({ id: '199', guid: 'g-ghost', mid: 'hasOwnProperty', flds: 'x\x1fy', tags: '' });
    cards.push(card('299', '199', 'valueOf', 9));
    return collectionFromRows({
      fileName: 'Tricky.apkg',
      col: { crt: 1_700_000_000, models: `{${models}}`, decks: `{${decks}}` },
      notes,
      cards,
      media: null,
    });
  };

  /** choices.types as the import screen should build it for such a file: no prototype. */
  const trickyChoices = (c: AnkiCollection, over: Partial<ImportChoices> = {}): ImportChoices => {
    const types = Object.create(null) as ImportChoices['types'];
    for (const mid of Object.keys(c.models)) {
      types[mid] = { fields: positionalFieldDefs(c.models[mid].flds.map((f) => f.name)), ords: [0] };
    }
    return choices(c, { types, ...over });
  };

  test('ownValue reads only own keys', () => {
    expect(ownValue({ a: 1 }, 'a')).toBe(1);
    expect(ownValue({ a: 1 }, 'constructor')).toBeUndefined();
    expect(ownValue({ a: 1 }, '__proto__')).toBeUndefined();
    expect(ownValue({ a: 1 }, 'toString')).toBeUndefined();
    const bare = Object.create(null) as Record<string, number>;
    bare['__proto__'] = 2;
    expect(ownValue(bare, '__proto__')).toBe(2);
  });

  test('every tricky model and deck is imported; a missing "hasOwnProperty" model is skipped, not a crash', () => {
    const c = trickyCollection();
    expect(Object.keys(c.models)).toEqual(tricky);
    expect(collectionSections(c).map((s) => s.name)).toEqual(['(Other)', ...tricky.map((k) => `Root::${k}`)]);
    const plan = planImport(c, emptyLib(), trickyChoices(c), ctx());
    expect(plan.notes.add.map((n) => n.guid)).toEqual(tricky.map((k) => `g-${k}`));
    expect(plan.notes.add.map((n) => n.section)).toEqual(tricky);
    expect(plan.noteTypes.add.map((t) => t.source?.ankiMid)).toEqual(tricky);
    expect(plan.noteTypes.add.map((t) => t.fields[0].name)).toEqual(tricky);
    expect(plan.noteTypes.add.map((t) => [t.templates[0].prompt, t.templates[0].answer])).toEqual(
      tricky.map(() => [[0], [1]]),
    );
    expect(plan.summary.skipped.empty).toBe(1); // the note of the missing "hasOwnProperty" model
    expect(plan.deck?.name).toBe('Root');

    // Imported again: every model is reused, "__proto__" too (an own key of `reuse`, no prototype change).
    const lib = apply(emptyLib(), plan);
    const again = planImport(c, lib, trickyChoices(c, { target: { kind: 'existing', deckId: lib.decks[0].id } }), ctx('b'));
    expect(Object.keys(again.noteTypes.reuse)).toEqual(tricky);
    expect(again.noteTypes.reuse['__proto__']).toBe(plan.noteTypes.add[0].id);
    expect(again.summary).toMatchObject({ notesAdded: 0, notesUnchanged: 3 });
  });

  test("choices.types as a plain {} without those ids → today's positions, not Object's methods", () => {
    const c = trickyCollection();
    const plan = planImport(c, emptyLib(), choices(c, { types: {} }), ctx());
    expect(plan.notes.add).toHaveLength(3);
    expect(plan.noteTypes.add.every((t) => t.fields[0].role === 'term' && t.fields[1].role === 'meaning')).toBe(true);
    expect(findReusableType(c, 'valueOf', plan.noteTypes.add)).toBeUndefined();
    expect(findReusableType(c, 'hasOwnProperty', plan.noteTypes.add)).toBeUndefined();
  });

  test('a CSV header with those names, and notetype / deck values like them, import like any other', () => {
    const c = readCsv(
      '#separator:comma\n#columns:__proto__,constructor,toString,Type,Deck\n#notetype column:4\n#deck column:5\n' +
        'Haus,house,x,__proto__,__proto__::A\nBaum,tree,y,constructor,constructor::B',
      'c.txt',
    );
    expect(Object.values(c.models).map((m) => m.name)).toEqual(['__proto__', 'constructor']);
    expect(Object.values(c.decks)).toEqual(['__proto__::A', 'constructor::B']);
    const plan = planImport(c, emptyLib(), csvChoices(c), ctx());
    expect(plan.notes.add.map((n) => n.fields)).toEqual([
      ['Haus', 'house', 'x'],
      ['Baum', 'tree', 'y'],
    ]);
    expect(plan.noteTypes.add.map((t) => t.fields.map((f) => f.name))).toEqual([
      ['__proto__', 'constructor', 'toString'],
      ['__proto__', 'constructor', 'toString'],
    ]);
    expect(plan.noteTypes.add[0].templates[0]).toMatchObject({ prompt: [0], answer: [1, 2] });
    // The same columns again: the card types are reused.
    const lib = apply(emptyLib(), plan);
    expect(Object.keys(planImport(c, lib, csvChoices(c), ctx('b')).noteTypes.reuse)).toEqual(Object.keys(c.models));
  });
});

/* -------------------------------------------------------- property test */

const LEVELS = ['A1', 'A2', 'B1', 'B2', ''];
const WORDS = ['Haus', 'haus', 'Baum', 'gehen', 'sagen', 'Wald', 'Bad', 'See', '<b>Haus</b>', ''];

/** A random small collection: apkg-like (guids) or CSV-like (some without guid), two models, three subdecks. */
function randomCollection(rnd: Random, tag: string): AnkiCollection {
  const csv = rnd.bool(0.5);
  const models: AnkiCollection['models'] = {};
  const mids = rnd.bool(0.7) ? ['m1'] : ['m1', 'm2'];
  for (const mid of mids) {
    models[mid] = {
      name: `Model ${mid}`,
      type: 0,
      sortf: 0,
      flds: ['Word', 'Meaning', 'Level'].map((name, ord) => ({ name, ord })),
      tmpls: [
        { name: 'F', ord: 0, qfmt: '{{Word}} {{Level}}', afmt: '{{Meaning}}' },
        { name: 'R', ord: 1, qfmt: '{{Meaning}}', afmt: '{{Word}}' },
      ],
    };
  }
  const decks = { '11': 'R::A1', '12': 'R::A2', '13': 'R::B1', '20': 'Other' };
  const dids = Object.keys(decks);
  const notes: AnkiCollection['notes'] = [];
  const cards: AnkiCollection['cards'] = [];
  const count = rnd.int(0, 18);
  for (let i = 0; i < count; i++) {
    const id = String(1000 + i);
    const guid = csv && rnd.bool(0.5) ? '' : `g${rnd.int(0, 12)}`;
    const tags = rnd.bool(0.2) ? ['marked'] : rnd.bool(0.3) ? ['x'] : [];
    notes.push({
      id,
      guid,
      mid: rnd.bool(0.05) ? 'ghost' : rnd.pick(mids),
      flds: [rnd.pick(WORDS), rnd.pick(['m1', 'm2', '']), rnd.pick(LEVELS)],
      tags,
    });
    const did = rnd.pick(dids);
    for (const ord of [0, 1]) {
      if (rnd.bool(0.15)) continue;
      const type = rnd.pick([0, 0, 0, 1, 2, 3]);
      cards.push({
        id: `${tag}-c${i}-${ord}`,
        nid: id,
        did,
        odid: '0',
        ord,
        type,
        queue: rnd.pick([0, 1, 2, -1, -2]),
        due: rnd.bool(0.05) ? NaN : type === 1 ? 1_790_000_000 + rnd.int(0, 1000) : rnd.int(0, 400),
        ivl: rnd.int(-60, 400),
        factor: rnd.pick([0, 1300, 2500, 9000]),
        reps: rnd.int(0, 20),
        lapses: rnd.int(0, 5),
        flags: rnd.int(0, 15),
      });
    }
  }
  return {
    fileName: `${tag}.apkg`,
    crt: 1_700_000_000,
    models,
    decks,
    notes,
    cards,
    media: {},
    ...(csv ? { csv: { header: ['Word', 'Meaning', 'Level'], delimiter: ',', html: false } } : {}),
  };
}

function randomChoices(rnd: Random, c: AnkiCollection, lib: Lib): ImportChoices {
  const all = [...collectionSections(c).map((s) => s.did)];
  const types: ImportChoices['types'] = {};
  for (const mid of Object.keys(c.models)) {
    const ords = rnd.bool(0.2) ? [0] : rnd.bool(0.1) ? [] : [0, 1];
    types[mid] = {
      fields: positionalFieldDefs(['Word', 'Meaning', 'Level']).map((f) =>
        f.name === 'Level' ? { ...f, role: 'badge' as const, facet: 'auto' as const } : f,
      ),
      ords,
    };
  }
  const target: ImportChoices['target'] =
    lib.decks.length > 0 && rnd.bool(0.5)
      ? { kind: 'existing', deckId: rnd.pick(lib.decks).id }
      : { kind: 'new', name: rnd.pick(['', 'Mine']), icon: '📘' };
  return {
    sections: new Set(rnd.sample(all, rnd.int(0, all.length))),
    target,
    types,
    progress: rnd.pick(['keep', 'reset'] as const),
    arrival: rnd.pick(['queued', 'notStarted'] as const),
    elsewhere: rnd.pick(['update', 'copy', 'skip'] as const),
    images: rnd.bool(),
    skipOverlap: rnd.bool(0.3),
    ...(rnd.bool(0.6)
      ? {
          placement: {
            facet: rnd.pick(['field:level', 'field:level', 'field:level', 'section']),
            fromRank: rnd.int(0, 4),
            below: rnd.pick(['known', 'notStarted'] as const),
          },
        }
      : {}),
  };
}

describe('PROPERTY: the summary equals the plan contents (200 seeded random imports)', () => {
  test.each(Array.from({ length: 200 }, (_, i) => i))('seed %i', (seed) => {
    const rnd = createRandom(`plan-${seed}`);
    // A library made by up to three earlier imports.
    let lib = emptyLib();
    const earlier = rnd.int(0, 3);
    for (let k = 0; k < earlier; k++) {
      const c0 = randomCollection(rnd.fork(`lib${k}`), `lib${k}`);
      lib = apply(lib, planImport(c0, lib, randomChoices(rnd.fork(`libc${k}`), c0, lib), ctx(`l${k}`)));
    }
    const c = randomCollection(rnd.fork('file'), 'file');
    const ch = randomChoices(rnd.fork('choices'), c, lib);
    const plan = planImport(c, lib, ch, ctx('p'));
    const s = plan.summary;
    const chosen = c.notes.filter((n) => ch.sections.has(homeDidOf(c, n.id)));

    // Counts equal the plan.
    expect(s.notesAdded).toBe(plan.notes.add.length);
    expect(s.cardsAdded).toBe(plan.cards.add.length);
    expect(s.notesUpdated).toBe(plan.notes.update.length);
    expect(s.cardTypesUpdated).toBe(plan.noteTypes.upgrade.length);
    expect(s.notesRetired).toBe(plan.notes.retire.length);
    expect(plan.notes.retire).toEqual([]); // only a starter deck update retires notes
    expect(s.notesSkipped).toBe(s.skipped.alreadyHere + s.skipped.elsewhere + s.skipped.overlap + s.skipped.empty);
    // Every chosen note is counted exactly once.
    expect(s.notesAdded + s.notesUpdated + s.notesUnchanged + s.notesSkipped).toBe(chosen.length);
    expect(s.inTargetDeck + s.inOtherDecks).toBeGreaterThanOrEqual(s.notesUpdated + s.notesUnchanged);
    const libCards = (noteId: string) => lib.cards.filter((x) => x.noteId === noteId);
    expect(s.cardsUpdated).toBe(plan.notes.update.reduce((sum, u) => sum + libCards(u.id).length, 0));
    expect(s.updatedDecks).toEqual([
      ...new Set(plan.notes.update.map((u) => lib.decks.find((d) => d.id === libCards(u.id)[0].deckId)?.name)),
    ]);
    expect(s.sections).toBe(new Set(plan.notes.add.map((n) => n.section).filter(Boolean)).size);
    expect(s.suspended).toBe(plan.cards.add.filter((x) => x.suspended).length);
    expect(s.newCards).toBe(plan.cards.add.filter((x) => x.reps === 0).length);
    expect(s.notStarted).toBe(
      plan.cards.add.filter((x) => x.reps === 0 && x.knownAt == null && x.newState === 'notStarted').length,
    );
    expect(s.markedKnown).toBe(plan.cards.add.filter((x) => x.knownAt != null).length);
    expect(s.images).toBe(plan.media.reduce((sum, m) => sum + m.files.length, 0));
    expect(plan.media.every((m) => m.files.length > 0)).toBe(true);
    expect(new Set(plan.media.map((m) => m.deckFolder)).size).toBe(plan.media.length);
    expect(s.guidsRenamed).toBeLessThanOrEqual(plan.notes.add.filter((n) => n.guid.startsWith('m-')).length);
    if (ch.progress === 'keep') {
      expect(s.progressCards).toBe(plan.cards.add.filter((x) => x.reps > 0).length);
    } else {
      expect(plan.cards.add.every((x) => x.reps === 0)).toBe(true);
      const keep = planImport(c, lib, { ...ch, progress: 'keep' }, ctx('p'));
      expect(s.progressCards).toBe(keep.summary.progressCards);
    }
    for (const o of s.overlap) expect(o.notes).toBeGreaterThan(0);

    // The plan is consistent.
    const isNew = ch.target.kind === 'new';
    expect(plan.deck !== null).toBe(isNew && s.notesAdded > 0);
    const upgraded = new Map(plan.noteTypes.upgrade.map((u) => [u.type.id, u.type]));
    const types = new Map([...lib.noteTypes.map((t) => upgraded.get(t.id) ?? t), ...plan.noteTypes.add].map((t) => [t.id, t]));
    for (const u of plan.notes.update) {
      const note = lib.notes.find((n) => n.id === u.id);
      const type = note ? types.get(note.typeId) : undefined;
      if (type) expect(u.fields.length).toBe(type.fields.length);
    }
    const addedIds = new Set(plan.notes.add.map((n) => n.id));
    const target = isNew ? plan.deck?.id : (ch.target as { deckId: string }).deckId;
    for (const n of plan.notes.add) {
      expect(types.get(n.typeId)?.fields.length).toBe(n.fields.length);
      const own = plan.cards.add.filter((x) => x.noteId === n.id);
      expect(own.length).toBeGreaterThan(0);
      expect(new Set(own.map((x) => x.deckId))).toEqual(new Set([target]));
      expect(new Set(own.map((x) => x.newPos)).size).toBe(1);
    }
    const libGuids = new Set(lib.notes.filter((n) => libCards(n.id).length > 0).map((n) => n.guid));
    const addedGuids = plan.notes.add.map((n) => n.guid);
    expect(new Set(addedGuids).size).toBe(addedGuids.length);
    for (const g of addedGuids) expect(libGuids.has(g)).toBe(false);
    const allCards = [...lib.cards, ...plan.cards.add];
    expect(new Set(allCards.map((x) => x.id)).size).toBe(allCards.length);
    expect(new Set(allCards.map((x) => `${x.noteId}/${x.ord}`)).size).toBe(allCards.length);
    for (const x of plan.cards.add) {
      expect(addedIds.has(x.noteId) || lib.notes.some((n) => n.id === x.noteId)).toBe(true);
      for (const k of ['ease', 'intervalDays', 'reps', 'lapses', 'due', 'newPos'] as const) {
        expect(Number.isFinite(x[k])).toBe(true);
      }
    }
    for (const t of plan.noteTypes.add) expect(plan.notes.add.some((n) => n.typeId === t.id)).toBe(true);
  });
});

/** A note's home subdeck, computed here on its own (lowest-ord card; '' when unknown). */
function homeDidOf(c: AnkiCollection, nid: string): string {
  const first = c.cards.filter((x) => x.nid === nid).sort((a, b) => a.ord - b.ord)[0];
  const home = first ? (first.odid !== '0' ? first.odid : first.did) : '';
  return c.decks[home] !== undefined ? home : '';
}

/* ------------------------------- W3-5: the card type the import screen shows */

describe('W3-5: buildNoteType and startingTypes (the Fields stage)', () => {
  test('buildNoteType is exactly the card type planImport adds (Anki and CSV)', () => {
    const verbs = fixture('german_verbs');
    const types = mapping(verbs, VERBS_ROLES);
    const plan = planImport(verbs, emptyLib(), choices(verbs, { types }), ctx());
    const added = plan.noteTypes.add[0];
    const mid = Object.keys(verbs.models)[0];
    expect(buildNoteType(verbs, mid, types[mid], added.id, FIXED_NOW)).toEqual(added);

    const csv = readCsv('Level,Word,Meaning\nA1,Haus,house\nA1,Baum,tree', 'w.csv', { header: true });
    const fields: FieldDef[] = [
      { name: 'Level', role: 'badge', facet: 'on' },
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
    ];
    const csvTypes = { [CSV_MODEL_ID]: { fields, ords: [0, 1] } };
    const csvPlan = planImport(csv, emptyLib(), csvChoices(csv, { types: csvTypes }), ctx());
    const csvType = buildNoteType(csv, CSV_MODEL_ID, csvTypes[CSV_MODEL_ID], csvPlan.noteTypes.add[0].id, FIXED_NOW);
    expect(csvType).toEqual(csvPlan.noteTypes.add[0]);
    // The column chosen as Front asks, and is the sort field.
    expect(csvType?.sortField).toBe(1);
    expect(csvType?.templates[0]).toMatchObject({ ord: 0, prompt: [1] });
  });

  test('chosenNotesByMid and cardOrdsByNote: the notes of the chosen sections, the card ords of every note', () => {
    const verbs = fixture('german_verbs');
    const mid = Object.keys(verbs.models)[0];
    const a1 = didOf(verbs, 'German::Verbs::A1');
    const byMid = chosenNotesByMid(verbs, new Set([a1]));
    expect([...byMid.keys()]).toEqual([mid]);
    expect(byMid.get(mid)?.map((n) => homeDidOf(verbs, n.id))).toEqual([a1, a1, a1, a1]);
    expect(chosenNotesByMid(verbs, new Set()).size).toBe(0);
    const ords = cardOrdsByNote(verbs);
    expect(ords.size).toBe(20);
    expect([...ords.values()].every((list) => list.join() === '0,1')).toBe(true);
  });

  test('an unknown model, or one without fields, gives no card type', () => {
    const verbs = fixture('german_verbs');
    expect(buildNoteType(verbs, 'missing', undefined, 't', FIXED_NOW)).toBeNull();
    expect(buildNoteType(verbs, 'constructor', undefined, 't', FIXED_NOW)).toBeNull();
  });

  test('startingTypes: suggested roles and every Anki direction; a CSV starts with "Front → Back" only', () => {
    const verbs = fixture('german_verbs');
    const mid = Object.keys(verbs.models)[0];
    const draft = { types: [{ mid, fields: positionalFieldDefs(verbs.models[mid].flds.map((f) => f.name)), ords: [0, 1] }] };
    const [start] = startingTypes(verbs, draft, []);
    expect(start).toMatchObject({ mid, ords: [0, 1], reused: null });
    expect(start.fields).toEqual(draft.types[0].fields);
    expect(start.fields).not.toBe(draft.types[0].fields); // a copy

    const csv = readCsv('Word,Meaning\nHaus,house', 'w.csv');
    const csvDraft = { types: [{ mid: CSV_MODEL_ID, fields: positionalFieldDefs(['Word', 'Meaning']), ords: [0, 1] }] };
    expect(startingTypes(csv, csvDraft, [])[0].ords).toEqual([0]);
  });

  test('startingTypes: a re-import starts from the library card type (its OWN roles), so the type is reused', () => {
    const verbs = fixture('german_verbs');
    const mid = Object.keys(verbs.models)[0];
    const first = planImport(verbs, emptyLib(), choices(verbs, { types: mapping(verbs, VERBS_ROLES) }), ctx('a'));
    const lib = apply(emptyLib(), first);
    // A new guess with OTHER roles: the library type still wins.
    const draft = { types: [{ mid, fields: positionalFieldDefs(verbs.models[mid].flds.map((f) => f.name)), ords: [0, 1] }] };
    const [start] = startingTypes(verbs, draft, lib.noteTypes);
    expect(start.reused?.id).toBe(first.noteTypes.add[0].id);
    expect(start.fields).toEqual(first.noteTypes.add[0].fields);
    const again = planImport(
      verbs,
      lib,
      choices(verbs, { types: { [mid]: { fields: start.fields, ords: start.ords } } }),
      ctx('b'),
    );
    expect(again.noteTypes.add).toEqual([]);
    expect(again.summary.notesUnchanged).toBe(20);
  });

  test('startingTypes: a CSV with the same columns starts from that card type; unchanged, it is reused', () => {
    const file = readCsv('Word,Meaning,Level\nHaus,house,A1\nBaum,tree,A1', 'w.csv');
    const fields: FieldDef[] = [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
      { name: 'Level', role: 'badge', facet: 'on' },
    ];
    const first = planImport(file, emptyLib(), csvChoices(file, { types: { [CSV_MODEL_ID]: { fields, ords: [0] } } }), ctx('a'));
    const lib = apply(emptyLib(), first);
    const other = readCsv('Word,Meaning,Level\nGeld,money,A2\nZeit,time,A2', 'other.csv');
    const draft = { types: [{ mid: CSV_MODEL_ID, fields: positionalFieldDefs(['Word', 'Meaning', 'Level']), ords: [0] }] };
    const [start] = startingTypes(other, draft, lib.noteTypes);
    expect(start.reused?.id).toBe(first.noteTypes.add[0].id);
    expect(start.fields).toEqual(fields);
    const plan = planImport(other, lib, csvChoices(other, { types: { [CSV_MODEL_ID]: { fields: start.fields, ords: start.ords } } }), ctx('b'));
    expect(plan.noteTypes.add).toEqual([]);
    expect(plan.notes.add.every((n) => n.typeId === first.noteTypes.add[0].id)).toBe(true);
  });
});

/* ------------------------- a newer version of an Anki model: the card type is upgraded */

describe('card-type upgrade: a newer version of an Anki model (German Vocabulary v1 → v2)', () => {
  const v1 = fixture('german_vocabulary_v1');
  const v2 = fixture('german_vocabulary_v2');
  const MID = '2710111000';
  const V1_FIELDS = ['Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'MarankiExample', 'Level'];
  const V2_FIELDS = [...V1_FIELDS, 'Type', 'Plural'];
  /** Level (and in v2 Type) as roles.ts maps them: badges. */
  const ROLES: Record<string, Partial<FieldDef>> = {
    Level: { role: 'badge', facet: 'auto' },
    Type: { role: 'badge', facet: 'auto' },
    Plural: { role: 'detail', facet: 'off', lang: 'de-DE' },
  };

  /** The library after importing v1 (the learner then labelled Translation "English"). */
  function libV1(): Lib {
    const lib = apply(emptyLib(), planImport(v1, emptyLib(), choices(v1, { types: mapping(v1, ROLES) }), ctx('a')));
    const label = (f: FieldDef): FieldDef => (f.name === 'Translation' ? { ...f, label: 'English' } : f);
    return { ...lib, noteTypes: lib.noteTypes.map((t) => ({ ...t, fields: t.fields.map(label) })) };
  }
  const intoV1Deck = (lib: Lib, over: Partial<ImportChoices> = {}) =>
    choices(v2, { types: mapping(v2, ROLES), target: { kind: 'existing', deckId: lib.decks[0].id }, ...over });

  test('the v1 card type is found to upgrade; it is not reused as it is, and the same file never upgrades it', () => {
    const lib = libV1();
    expect(v2.models[MID].flds.map((f) => f.name)).toEqual(V2_FIELDS);
    expect(findReusableType(v2, MID, lib.noteTypes)).toBeUndefined();
    expect(findUpgradableType(v2, MID, lib.noteTypes)?.id).toBe(lib.noteTypes[0].id);
    expect(findReusableType(v1, MID, lib.noteTypes)?.id).toBe(lib.noteTypes[0].id);
    expect(findUpgradableType(v1, MID, lib.noteTypes)).toBeUndefined();
  });

  test('upgradeNoteType: the model\'s fields, the type\'s own settings, the new fields from the choice, the v2 directions', () => {
    const lib = libV1();
    const old = lib.noteTypes[0];
    const choice = mapping(v2, ROLES)[MID];
    const up = upgradeNoteType(v2, MID, old, choice, FIXED_NOW + 1) as NoteType;
    expect(up).toMatchObject({ id: old.id, name: old.name, kind: old.kind, source: old.source, createdAt: old.createdAt });
    expect(up.updatedAt).toBe(FIXED_NOW + 1);
    expect(up.fields.map((f) => f.name)).toEqual(V2_FIELDS);
    expect(up.fields.slice(0, 7)).toEqual(old.fields); // "English" stays
    expect(up.fields.slice(7)).toEqual(choice.fields.slice(7));
    expect(up.templates).toEqual(modelTemplates(v2.models[MID], up.fields));
    // DE-EN asks the word, its plural and grammar notes; Level and Type are pills.
    const names = (ix: number[]) => ix.map((i) => up.fields[i].name);
    expect(names(up.templates[0].prompt)).toEqual(['Word', 'Plural', 'Grammar']);
    expect(names(up.templates[1].answer)).toEqual(['Word', 'Plural', 'Grammar', 'VerbForms', 'Examples', 'MarankiExample']);
    expect(up.sortField).toBe(0);
  });

  test('the plan upgrades the type in place: matched notes are updated in the new field order, new notes use it too', () => {
    const lib = libV1();
    const old = lib.noteTypes[0];
    const plan = planImport(v2, lib, intoV1Deck(lib), ctx('b'));
    expect(plan.noteTypes.add).toEqual([]);
    expect(plan.noteTypes.reuse[MID]).toBe(old.id);
    expect(plan.noteTypes.upgrade.map((u) => [u.type.id, u.fromFields, u.type.fields.map((f) => f.name)])).toEqual([
      [old.id, V1_FIELDS, V2_FIELDS],
    ]);
    // 18 of the 20 v1 notes are in v2 (same guid); 2 v2 notes are new.
    expect(plan.summary).toMatchObject({ inTargetDeck: 18, notesUpdated: 18, notesUnchanged: 0, notesAdded: 2, cardTypesUpdated: 1 });
    expect(plan.notes.update.every((u) => u.fields.length === 9)).toBe(true);
    expect(plan.notes.add.every((n) => n.typeId === old.id && n.fields.length === 9)).toBe(true);
    expect(plan.cards.add).toHaveLength(4); // only the cards of the 2 new notes: every card keeps its id and progress
    const bad = lib.notes.find((n) => n.fields[0] === 'das Bad') as Note;
    const update = plan.notes.update.find((u) => u.id === bad.id)!;
    expect(update.fields[7]).toBe('noun');
    expect(update.fields[8]).toBe('die Bäder');
    expect(update.tags).toEqual(['noun', 'v2026-10']);
    expect(plan.summary.filtersFound).toEqual(expect.arrayContaining(['Level', 'Type']));

    // Applied: ONE card type with 9 fields, every note fits it; the same file again changes nothing.
    const after = apply(lib, plan);
    expect(after.noteTypes).toHaveLength(1);
    expect(after.notes.every((n) => n.fields.length === 9)).toBe(true);
    const again = planImport(v2, after, intoV1Deck(after), ctx('c'));
    expect(again.noteTypes.upgrade).toEqual([]);
    expect(again.summary).toMatchObject({ notesUpdated: 0, notesAdded: 0, notesUnchanged: 20, cardTypesUpdated: 0 });
  });

  test('a note of the upgraded type that the file does NOT have is not in the plan (the reducer moves it)', () => {
    const lib = libV1();
    const plan = planImport(v2, lib, intoV1Deck(lib), ctx('b'));
    const dropped = lib.notes.filter((n) => !v2.notes.some((x) => x.guid === n.guid));
    expect(dropped.map((n) => n.fields[0]).sort()).toEqual(['das Internet (Sg.)', 'der Reis (Sg.)']);
    for (const n of dropped) expect(plan.notes.update.some((u) => u.id === n.id)).toBe(false);
    const after = apply(lib, plan);
    for (const n of dropped) expect(after.notes.find((x) => x.id === n.id)?.fields).toEqual([...n.fields, '', '']);
  });

  test('no upgrade when no note of the file lands on the type ("Skip them" for notes in another deck)', () => {
    const lib = libV1();
    const plan = planImport(v2, lib, choices(v2, { types: mapping(v2, ROLES), elsewhere: 'skip' }), ctx('b'));
    expect(plan.summary.skipped.elsewhere).toBe(18);
    // The 2 new notes are added (to a new deck) with the upgraded card type: the upgrade stays.
    expect(plan.noteTypes.upgrade).toHaveLength(1);
    // Without them, no note of the file lands on the type: no upgrade.
    const onlyOld = edit(v2, (d) => {
      d.notes = d.notes.filter((n) => lib.notes.some((x) => x.guid === n.guid));
    });
    const skipped = planImport(onlyOld, lib, choices(onlyOld, { types: mapping(onlyOld, ROLES), elsewhere: 'skip' }), ctx('c'));
    expect(skipped.summary.skipped.elsewhere).toBe(18);
    expect(skipped.noteTypes.upgrade).toEqual([]);
    expect(skipped.summary.cardTypesUpdated).toBe(0);
  });

  test('startingTypes (the Fields stage) shows the type as the import will upgrade it, and names the new fields', () => {
    const lib = libV1();
    const draft = { types: [{ mid: MID, fields: mapping(v2, ROLES)[MID].fields, ords: [0, 1] }] };
    const [start] = startingTypes(v2, draft, lib.noteTypes);
    expect(start.reused?.id).toBe(lib.noteTypes[0].id);
    expect(start.reused?.fields.map((f) => f.name)).toEqual(V2_FIELDS);
    expect(start.fields).toEqual(start.reused?.fields);
    expect(start.addedFields).toEqual(['Type', 'Plural']);
    // Unchanged on the Fields stage, the plan makes the same upgrade.
    const plan = planImport(v2, lib, intoV1Deck(lib, { types: { [MID]: { fields: start.fields, ords: start.ords } } }), ctx('d'));
    expect(plan.noteTypes.upgrade[0].type.fields).toEqual(start.fields);
  });
});

describe('card-type upgrade: field order, new directions, and the models that are never upgraded', () => {
  /** A tiny Anki collection: one model, one note per [guid, values], a card for each template ord. */
  function tiny(
    names: string[],
    tmpls: { name: string; qfmt: string; afmt: string }[],
    rows: [string, string[]][],
    opts: { type?: 0 | 1; csv?: boolean } = {},
  ): AnkiCollection {
    return {
      fileName: 'tiny.apkg',
      crt: 0,
      models: {
        m1: {
          name: 'Tiny',
          type: opts.type ?? 0,
          sortf: 0,
          flds: names.map((name, ord) => ({ name, ord })),
          tmpls: tmpls.map((t, ord) => ({ ...t, ord })),
        },
      },
      decks: { '1': 'Tiny' },
      notes: rows.map(([guid, flds], i) => ({ id: String(100 + i), guid, mid: 'm1', flds, tags: [] })),
      cards: rows.flatMap((_, i) =>
        tmpls.map((__, ord) => ({
          id: `${100 + i}${ord}`, nid: String(100 + i), did: '1', odid: '0', ord,
          type: 0, queue: 0, due: i, ivl: 0, factor: 0, reps: 0, lapses: 0, flags: 0,
        })),
      ),
      media: {},
      ...(opts.csv ? { csv: { header: names, delimiter: ',', html: false } } : {}),
    };
  }
  const FWD = { name: 'Forward', qfmt: '{{Word}}', afmt: '{{FrontSide}}<hr id=answer>{{Meaning}}' };
  const BACK = { name: 'Back', qfmt: '{{Meaning}}', afmt: '{{FrontSide}}<hr id=answer>{{Word}}' };
  const firstImport = (c: AnkiCollection) => apply(emptyLib(), planImport(c, emptyLib(), choices(c), ctx('a')));
  const into = (c: AnkiCollection, lib: Lib) => choices(c, { target: { kind: 'existing', deckId: lib.decks[0].id } });

  test('a new field in the MIDDLE and a new direction: values move by name, the matched note gets the new card', () => {
    const lib = firstImport(tiny(['Word', 'Meaning'], [FWD], [['g1', ['Haus', 'house']]]));
    const studied: Lib = { ...lib, cards: lib.cards.map((c) => ({ ...c, reps: 3, intervalDays: 5 })) };
    const v2 = tiny(['Word', 'Note', 'Meaning'], [FWD, BACK], [['g1', ['Haus', 'n.', 'house']]]);
    const plan = planImport(v2, studied, into(v2, studied), ctx('b'));
    expect(plan.noteTypes.upgrade.map((u) => u.type.fields.map((f) => f.name))).toEqual([['Word', 'Note', 'Meaning']]);
    expect(plan.notes.update.map((u) => u.fields)).toEqual([['Haus', 'n.', 'house']]);
    // The new direction "Back" gets a card for the note already here; the studied card is not touched.
    expect(plan.cards.add.map((c) => [c.noteId, c.ord, c.reps])).toEqual([[studied.notes[0].id, 1, 0]]);
    const after = apply(studied, plan);
    expect(after.cards.find((c) => c.ord === 0)).toEqual(studied.cards[0]);
    expect(after.noteTypes[0].templates.map((t) => t.name)).toEqual(['Forward', 'Back']);
  });

  test('a note the file moved to another subdeck: the section stays (import screen), or follows the file (followSections)', () => {
    /** The notes of `rows`, each in the subdeck Tiny::<level>. */
    const leveled = (rows: [string, string[], 'A1' | 'B1'][]): AnkiCollection => {
      const c = tiny(['Word', 'Meaning'], [FWD], rows.map(([guid, flds]) => [guid, flds]));
      const did = (nid: string) => (rows[Number(nid) - 100][2] === 'A1' ? '1' : '2');
      return { ...c, decks: { '1': 'Tiny::A1', '2': 'Tiny::B1' }, cards: c.cards.map((x) => ({ ...x, did: did(x.nid) })) };
    };
    const before = leveled([
      ['g1', ['Haus', 'house'], 'A1'],
      ['g2', ['Hund', 'dog'], 'B1'],
    ]);
    const lib = apply(emptyLib(), planImport(before, emptyLib(), choices(before), ctx('a')));
    expect(lib.notes.map((n) => n.section)).toEqual(['A1', 'B1']);
    // The newer file: "Hund" is an A1 word now, and a new B1 word.
    const moved = leveled([
      ['g1', ['Haus', 'house'], 'A1'],
      ['g2', ['Hund', 'dog'], 'A1'],
      ['g3', ['Ziel', 'goal'], 'B1'],
    ]);
    const target = { kind: 'existing' as const, deckId: lib.decks[0].id };
    const keep = planImport(moved, lib, choices(moved, { target }), ctx('b'));
    expect(keep.notes.update).toEqual([]);
    expect(keep.summary.notesUnchanged).toBe(2);
    const follow = planImport(moved, lib, choices(moved, { target, followSections: true }), ctx('c'));
    expect(follow.notes.update).toEqual([{ id: lib.notes[1].id, fields: ['Hund', 'dog'], tags: [], section: 'A1' }]);
    expect(follow.summary).toMatchObject({ notesUpdated: 1, notesUnchanged: 1, notesAdded: 1 });
    // The section is the one a fresh add of the same file gives.
    const fresh = planImport(moved, emptyLib(), choices(moved), ctx('d'));
    expect(fresh.notes.add.find((n) => n.guid === 'g2')?.section).toBe('A1');
  });

  test('the sort field stays the same field when the fields move', () => {
    const lib = firstImport(tiny(['Word', 'Meaning'], [FWD], [['g1', ['Haus', 'house']]]));
    const v2 = tiny(['Level', 'Word', 'Meaning'], [FWD], [['g1', ['A1', 'Haus', 'house']]]);
    const up = upgradeNoteType(v2, 'm1', lib.noteTypes[0], undefined, FIXED_NOW) as NoteType;
    expect(up.fields.map((f) => f.name)).toEqual(['Level', 'Word', 'Meaning']);
    expect(up.sortField).toBe(1); // still "Word"
  });

  test('never upgraded: a model without the sort field, a CSV, another kind, repeated field names', () => {
    const lib = firstImport(tiny(['Word', 'Meaning', 'Extra'], [FWD], [['g1', ['Haus', 'house', 'x']]]));
    // The headword (sort) field is what makes it the same card type.
    const noWord = tiny(['Meaning', 'Extra'], [BACK_X], [['g1', ['house', 'x']]]);
    expect(findUpgradableType(noWord, 'm1', lib.noteTypes)).toBeUndefined();
    const grown = tiny(['Word', 'Meaning', 'Extra', 'More'], [FWD], [['g1', ['Haus', 'house', 'x', 'y']]]);
    expect(findUpgradableType(grown, 'm1', lib.noteTypes)?.id).toBe(lib.noteTypes[0].id);
    expect(findUpgradableType({ ...grown, csv: { header: null, delimiter: ',', html: false } }, 'm1', lib.noteTypes)).toBeUndefined();
    const cloze = tiny(['Word', 'Meaning', 'Extra', 'More'], [FWD], [['g1', ['Haus', 'house', 'x', 'y']]], { type: 1 });
    expect(findUpgradableType(cloze, 'm1', lib.noteTypes)).toBeUndefined();
    const twice = tiny(['Word', 'Meaning', 'Extra', 'Word'], [FWD], [['g1', ['Haus', 'house', 'x', 'y']]]);
    expect(findUpgradableType(twice, 'm1', lib.noteTypes)).toBeUndefined();
    // A model without the sort field gets its own NEW card type, as before.
    const plan = planImport(noWord, lib, into(noWord, lib), ctx('b'));
    expect(plan.noteTypes.upgrade).toEqual([]);
  });
  const BACK_X = { name: 'Back', qfmt: '{{Meaning}}', afmt: '{{FrontSide}}<hr id=answer>{{Extra}}' };
});

describe('card-type upgrade: a model that LOST a field (German vocabulary v3 removed MarankiExample)', () => {
  /** A tiny Anki collection, as above: one model "m1", one note per [guid, values]. */
  function tiny(names: string[], afmt: string, rows: [string, string[]][]): AnkiCollection {
    return {
      fileName: 'tiny.apkg',
      crt: 0,
      models: {
        m1: { name: 'Tiny', type: 0, sortf: 0, flds: names.map((name, ord) => ({ name, ord })), tmpls: [{ name: 'Forward', qfmt: '{{Word}}', afmt, ord: 0 }] },
      },
      decks: { '1': 'Tiny' },
      notes: rows.map(([guid, flds], i) => ({ id: String(100 + i), guid, mid: 'm1', flds, tags: [] })),
      cards: rows.map((_, i) => ({
        id: `${100 + i}0`, nid: String(100 + i), did: '1', odid: '0', ord: 0,
        type: 0, queue: 0, due: i, ivl: 0, factor: 0, reps: 0, lapses: 0, flags: 0,
      })),
      media: {},
    };
  }
  // Version 1 shows Extra on the back; version 2 no longer has it.
  const V1 = (rows: [string, string[]][]) => tiny(['Word', 'Extra', 'Meaning'], '{{FrontSide}}<hr id=answer>{{Meaning}}<br>{{Extra}}', rows);
  const V2 = (rows: [string, string[]][]) => tiny(['Word', 'Meaning'], '{{FrontSide}}<hr id=answer>{{Meaning}}', rows);
  const firstImport = (c: AnkiCollection) => apply(emptyLib(), planImport(c, emptyLib(), choices(c), ctx('a')));
  const into = (c: AnkiCollection, lib: Lib) => choices(c, { target: { kind: 'existing', deckId: lib.decks[0].id } });
  const names = (t: NoteType) => t.fields.map((f) => f.name);

  test('the type loses the field (one card type, not two); the notes the file updates lose its text; again = nothing', () => {
    const lib = firstImport(V1([['g1', ['Haus', 'x', 'house']], ['g2', ['Hund', 'y', 'dog']]]));
    const v2 = V2([['g1', ['Haus', 'house']], ['g2', ['Hund', 'dog']]]);
    expect(findUpgradableType(v2, 'm1', lib.noteTypes)?.id).toBe(lib.noteTypes[0].id);
    const plan = planImport(v2, lib, into(v2, lib), ctx('b'));
    expect(plan.noteTypes.add).toEqual([]);
    expect(plan.noteTypes.upgrade.map((u) => [u.fromFields, names(u.type)])).toEqual([[['Word', 'Extra', 'Meaning'], ['Word', 'Meaning']]]);
    expect(plan.notes.update.map((u) => u.fields)).toEqual([['Haus', 'house'], ['Hund', 'dog']]);
    expect(plan.summary).toMatchObject({ cardTypesUpdated: 1, notesUpdated: 2, notesUnchanged: 0, notesAdded: 0 });
    const after = apply(lib, plan);
    expect(after.noteTypes.map(names)).toEqual([['Word', 'Meaning']]);
    expect(after.notes.map((n) => n.fields)).toEqual([['Haus', 'house'], ['Hund', 'dog']]);
    const again = planImport(v2, after, into(v2, after), ctx('c'));
    expect(again.noteTypes.upgrade).toEqual([]);
    expect(again.summary).toMatchObject({ cardTypesUpdated: 0, notesUpdated: 0, notesUnchanged: 2 });
  });

  test('the LAST field lost, and the only change of a note is that text: it is still an update (the reducer needs it)', () => {
    const lib = firstImport(tiny(['Word', 'Meaning', 'Extra'], '{{FrontSide}}<hr id=answer>{{Meaning}}', [['g1', ['Haus', 'house', 'x']]]));
    const v2 = V2([['g1', ['Haus', 'house']]]);
    const plan = planImport(v2, lib, into(v2, lib), ctx('b'));
    expect(plan.noteTypes.upgrade.map((u) => names(u.type))).toEqual([['Word', 'Meaning']]);
    expect(plan.notes.update).toEqual([{ id: lib.notes[0].id, fields: ['Haus', 'house'], tags: [] }]);
    expect(plan.summary.notesUnchanged).toBe(0);
  });

  test('a lost field is KEPT (last, on no side of the card) while a note the file does not update has text in it', () => {
    // "Hund" is not in the newer file (a retired item, or the learner's own card).
    const lib = firstImport(V1([['g1', ['Haus', 'x', 'house']], ['g2', ['Hund', 'y', 'dog']]]));
    const v2 = V2([['g1', ['Haus', 'house']]]);
    const plan = planImport(v2, lib, into(v2, lib), ctx('b'));
    const up = plan.noteTypes.upgrade[0].type;
    expect(names(up)).toEqual(['Word', 'Meaning', 'Extra']);
    expect(up.templates.flatMap((t) => [...t.prompt, ...t.answer])).not.toContain(2);
    // The note the file updates loses the text there (the newer version has none).
    expect(plan.notes.update.map((u) => u.fields)).toEqual([['Haus', 'house', '']]);
    const after = apply(lib, plan);
    expect(after.notes.map((n) => n.fields)).toEqual([['Haus', 'house', ''], ['Hund', 'dog', 'y']]);
    // The same file again: nothing to change while "Hund" still has text there …
    const again = planImport(v2, after, into(v2, after), ctx('c'));
    expect(again.noteTypes.upgrade).toEqual([]);
    expect(again.summary).toMatchObject({ cardTypesUpdated: 0, notesUpdated: 0, notesUnchanged: 1 });
    // … and text the learner typed there later is kept on an update.
    const typed = { ...after, notes: after.notes.map((n) => (n.guid === 'g1' ? { ...n, fields: ['Haus', 'house', 'mine'] } : n)) };
    expect(planImport(v2, typed, into(v2, typed), ctx('d')).summary).toMatchObject({ notesUpdated: 0, notesUnchanged: 1 });
    // When the last text there is gone, the next import removes the field.
    const cleared = { ...after, notes: after.notes.map((n) => (n.guid === 'g2' ? { ...n, fields: ['Hund', 'dog', ''] } : n)) };
    const last = planImport(v2, cleared, into(v2, cleared), ctx('e'));
    expect(last.noteTypes.upgrade.map((u) => names(u.type))).toEqual([['Word', 'Meaning']]);
    expect(apply(cleared, last).notes.map((n) => n.fields)).toEqual([['Haus', 'house'], ['Hund', 'dog']]);
  });

  test('a note in another deck that the import skips keeps the field too ("Skip them" does not update it)', () => {
    const lib = firstImport(V1([['g1', ['Haus', 'x', 'house']]]));
    const v2 = V2([['g1', ['Haus', 'house']], ['g9', ['Ziel', 'goal']]]);
    // Into a NEW deck, "Skip them": g1 stays as it is, so its "x" must stay.
    const plan = planImport(v2, lib, choices(v2, { elsewhere: 'skip' }), ctx('b'));
    expect(plan.summary.skipped.elsewhere).toBe(1);
    expect(plan.noteTypes.upgrade.map((u) => names(u.type))).toEqual([['Word', 'Meaning', 'Extra']]);
    expect(apply(lib, plan).notes.map((n) => n.fields)).toEqual([['Haus', 'house', 'x'], ['Ziel', 'goal', '']]);
  });

  test('startingTypes (the Fields stage) names the fields the file no longer has', () => {
    const lib = firstImport(V1([['g1', ['Haus', 'x', 'house']]]));
    const v2 = V2([['g1', ['Haus', 'house']]]);
    const draft = { types: [{ mid: 'm1', fields: positionalFieldDefs(['Word', 'Meaning']), ords: [0] }] };
    const [start] = startingTypes(v2, draft, lib.noteTypes);
    expect(start.reused && names(start.reused)).toEqual(['Word', 'Meaning']);
    expect(start.fields.map((f) => f.name)).toEqual(['Word', 'Meaning']);
    expect(start).toMatchObject({ addedFields: [], removedFields: ['Extra'] });
  });
});
