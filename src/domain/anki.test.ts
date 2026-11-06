/**
 * The Anki helpers that stay in anki.ts (unit W3-5): `stripHtml`,
 * `ankiDeckName`, `FIELD_SEP`.
 *
 * W3-5 removed `mapAnkiNote` (one flat v2 card per note) and its helpers
 * `buildApkgPayload` / `groupNotesBySection` / `parseAnkiModels` (spec §10.6).
 * Their tests went with them. What those tests guaranteed is pinned here
 * again, on the LOSSLESS path that replaces them (apkgRead → roles
 * `suggestMapping` → plan `planImport`), with the real German Verbs fixture:
 *   - fields map by their NAMES, not their position (M12);
 *   - a cloze note gives one card per cloze number; a NON-cloze note that
 *     only mentions {{c1::…}} is not split (L16);
 *   - sections partition the notes: choosing every section imports every note;
 *   - and what mapAnkiNote threw away now arrives: every field, both
 *     directions, the guid.
 */
import { describe, expect, test } from '@jest/globals';

import { FIXED_NOW } from '../test/clock';
import { ankiFixture } from '../test/factories';
import { ankiDeckName, FIELD_SEP, stripHtml } from './anki';
import { unwrapCloze } from './cloze';
import { collectionFromRows } from './import/apkgRead';
import { collectionSections, planImport, startingTypes, type PlanCtx } from './import/plan';
import { choiceTypes, importPlanCtx } from './importFile';
import type { AnkiCollection, ImportChoices } from './model';
import { suggestMapping } from './roles';
import { DEFAULT_SRS } from './types';

/* ---------------------------------------------------------------- helpers */

function verbs(): AnkiCollection {
  const fx = ankiFixture('german_verbs');
  return collectionFromRows({ fileName: fx.fileName, col: fx.col, notes: fx.notes, cards: fx.cards, media: fx.media });
}

function ctx(): PlanCtx {
  return importPlanCtx({ now: FIXED_NOW, seed: 'a', srs: DEFAULT_SRS, origin: { kind: 'apkg', ref: 'x.apkg' } });
}

/** The screen's default choices: every section, the suggested roles, every direction. */
function defaults(c: AnkiCollection, over: Partial<ImportChoices> = {}): ImportChoices {
  const starts = startingTypes(c, suggestMapping(c), []);
  return {
    sections: new Set(collectionSections(c).map((s) => s.did)),
    target: { kind: 'new', name: '', icon: '🗂️' },
    types: choiceTypes(c, starts),
    progress: 'keep',
    arrival: 'queued',
    elsewhere: 'update',
    images: true,
    ...over,
  };
}

const emptyLib = { noteTypes: [], notes: [], cards: [], decks: [] };

/** A one-model collection with the given notes (one card row per ord in `ords`). */
function oneModel(model: AnkiCollection['models'][string], notes: string[][], ords: number[]): AnkiCollection {
  return {
    fileName: 'test.apkg',
    crt: 0,
    models: { m: model },
    decks: { d: 'Test' },
    notes: notes.map((flds, i) => ({ id: String(i + 1), guid: `g${i + 1}`, mid: 'm', flds, tags: [] })),
    cards: notes.flatMap((_, i) =>
      ords.map((ord) => ({
        id: `c${i + 1}-${ord}`,
        nid: String(i + 1),
        did: 'd',
        odid: '0',
        ord,
        type: 0,
        queue: 0,
        due: i + 1,
        ivl: 0,
        factor: 0,
        reps: 0,
        lapses: 0,
        flags: 0,
      })),
    ),
    media: {},
  };
}

/* ---------------------------------------------------------------- stripHtml */

describe('stripHtml', () => {
  test('tags go, <br> and block ends become spaces, entities are decoded, white space collapses', () => {
    expect(stripHtml('<b>die</b>&nbsp;Stunde<br>the hour')).toBe('die Stunde the hour');
    expect(stripHtml('<div>eins</div><div>zwei</div>')).toBe('eins zwei');
    expect(stripHtml('H&auml;user &amp; B&#228;ume &#x2014; ok')).toBe('Häuser & Bäume — ok');
    expect(stripHtml('  a \n\t b  ')).toBe('a b');
  });

  test('media tags and scripts leave nothing behind', () => {
    expect(stripHtml('Haus [sound:haus.mp3]')).toBe('Haus');
    expect(stripHtml('<img src="a.png">')).toBe('');
    expect(stripHtml('x<script>alert(1)</script>y<style>p{}</style>z')).toBe('x y z');
  });

  test('an entity name from the file is only an entity name ("&constructor;" stays as written)', () => {
    expect(stripHtml('&constructor; &toString; &__proto__;')).toBe('&constructor; &toString; &__proto__;');
    // A broken numeric entity stays as written, too.
    expect(stripHtml('&#0; &#xD800; &#99999999;')).toBe('&#0; &#xD800; &#99999999;');
  });

  test('cloze markup is left as written: cloze.ts is the one cloze reader (W3-5)', () => {
    const text = '{{c1::Paris::city}} is in {{c2,3::France}}';
    expect(stripHtml(text)).toBe(text);
    // A caller that may hold deletions reads them with cloze.ts first.
    expect(stripHtml(unwrapCloze(`<b>${text}</b>`))).toBe('Paris is in France');
  });

  test('stays linear on a field with many "<" and no ">" (no freeze)', () => {
    const big = 'if (a<b) '.repeat(20_000);
    const t0 = Date.now();
    expect(stripHtml(big).length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

/* ---------------------------------------------------------------- deck names */

describe('ankiDeckName over selected subdecks', () => {
  test('a single selected subdeck name → its full friendly name', () => {
    expect(ankiDeckName(['German::Verbs::B1'], 'fallback')).toBe('German Verbs B1');
  });

  test('two sibling subdecks → their common prefix', () => {
    expect(ankiDeckName(['German::Verbs::B1', 'German::Verbs::B2'], 'fallback')).toBe('German Verbs');
  });

  test('Anki\'s "Default" deck never leaks into the name; only Default → the fallback', () => {
    expect(ankiDeckName(['Default', 'Default::Spanish'], 'file')).toBe('Spanish');
    expect(ankiDeckName(['Default'], 'file')).toBe('file');
    expect(ankiDeckName([], 'file')).toBe('file');
  });
});

test('FIELD_SEP is the unit separator Anki joins fields with', () => {
  expect(FIELD_SEP).toBe('\x1f');
  expect('a\x1fb'.split(FIELD_SEP)).toEqual(['a', 'b']);
});

/* --------------------------------- what replaces mapAnkiNote: the lossless path */

describe('the lossless import path keeps what mapAnkiNote dropped (real German Verbs fixture)', () => {
  test('every field, both directions and the guid of every note arrive', () => {
    const c = verbs();
    const plan = planImport(c, emptyLib, defaults(c), ctx());
    expect(plan.summary.notesAdded).toBe(20);
    // mapAnkiNote made ONE card per note; the file has two directions (DE-EN, EN-DE).
    expect(plan.summary.cardsAdded).toBe(40);
    expect(new Set(plan.cards.add.map((x) => x.ord))).toEqual(new Set([0, 1]));
    for (const note of plan.notes.add) {
      const source = c.notes.find((n) => n.guid === note.guid);
      expect(source).toBeDefined();
      // Every field, raw (mapAnkiNote kept front / back / one example only).
      expect(note.fields).toEqual(source?.flds);
    }
  });

  test('M12: the Front and Back come from the field NAMES, not their position', () => {
    // "Grammar" first: a positional mapping would take it as the Front.
    const model = {
      name: 'Basic',
      type: 0 as const,
      sortf: 1,
      flds: [{ name: 'Grammar', ord: 0 }, { name: 'Front', ord: 1 }, { name: 'Back', ord: 2 }],
      tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}<br>{{Grammar}}' }],
    };
    const c = oneModel(model, [['adj', 'hello', 'a greeting']], [0]);
    const plan = planImport(c, emptyLib, defaults(c), ctx());
    const type = plan.noteTypes.add[0];
    expect(type.fields.map((f) => f.role)).toEqual(['detail', 'term', 'meaning']);
    expect(type.templates[0]).toMatchObject({ prompt: [1], answer: [2, 0] });
  });

  test('L16: a cloze note gives one card per cloze number; a NON-cloze note that mentions {{c1::}} is not split', () => {
    const cloze = oneModel(
      {
        name: 'Cloze',
        type: 1,
        sortf: 0,
        flds: [{ name: 'Text', ord: 0 }, { name: 'Extra', ord: 1 }],
        tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Extra}}' }],
      },
      [['{{c1::Paris}} is the capital of {{c2::France}}', '']],
      [0, 1],
    );
    const clozePlan = planImport(cloze, emptyLib, defaults(cloze), ctx());
    expect(clozePlan.cards.add.map((x) => x.ord)).toEqual([0, 1]);

    const basic = oneModel(
      {
        name: 'Basic',
        type: 0,
        sortf: 0,
        flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
        tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
      },
      [['The {{c1::cat}} sat', 'meaning']],
      [0],
    );
    const basicPlan = planImport(basic, emptyLib, defaults(basic), ctx());
    expect(basicPlan.cards.add).toHaveLength(1);
    expect(basicPlan.noteTypes.add[0].kind).toBe('standard');
    // The text is kept raw, as written.
    expect(basicPlan.notes.add[0].fields[0]).toBe('The {{c1::cat}} sat');
  });

  test('sections partition the notes: each section alone, together, is every note once', () => {
    const c = verbs();
    const sections = collectionSections(c);
    expect(sections.map((s) => s.name)).toEqual([
      'German::Verbs::A1',
      'German::Verbs::A2',
      'German::Verbs::B1',
      'German::Verbs::B2',
      'German::Verbs::C1',
      'German::Verbs::C2',
    ]);
    let total = 0;
    const guids = new Set<string>();
    for (const s of sections) {
      const plan = planImport(c, emptyLib, defaults(c, { sections: new Set([s.did]) }), ctx());
      total += plan.summary.notesAdded;
      for (const n of plan.notes.add) guids.add(n.guid);
      // One subdeck chosen → the deck is that subdeck, the section ''.
      expect(plan.notes.add.every((n) => n.section === '')).toBe(true);
    }
    expect(total).toBe(20);
    expect(guids.size).toBe(20);
    // Everything chosen → deck "German Verbs", sections A1 … C2.
    const all = planImport(c, emptyLib, defaults(c), ctx());
    expect(all.deck?.name).toBe('German Verbs');
    expect(new Set(all.notes.add.map((n) => n.section))).toEqual(new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']));
  });
});
