/**
 * Anki note → card mapping. Pins the cloze split + model gating (L16), field-role
 * detection by the model's field NAMES with a positional fallback (M12), and the
 * subdeck grouping invariant (union of section payloads === the flat payload).
 */
import { describe, expect, test } from '@jest/globals';

import {
  AnkiModel,
  AnkiNoteRow,
  ankiDeckName,
  buildApkgPayload,
  groupNotesBySection,
  mapAnkiNote,
  parseAnkiModels,
} from './anki';

const SEP = '\x1f';

describe('parseAnkiModels', () => {
  test('captures the note-type kind and orders fields by ord', () => {
    const json = JSON.stringify({
      '12': { name: 'Cloze', type: 1, flds: [{ name: 'Extra', ord: 1 }, { name: 'Text', ord: 0 }] },
    });
    expect(parseAnkiModels(json)['12']).toEqual({ name: 'Cloze', type: 1, flds: ['Text', 'Extra'] });
  });
});

describe('mapAnkiNote — normal notes', () => {
  test('maps front/back by model field NAMES, not position', () => {
    const model: AnkiModel = { name: 'Basic', type: 0, flds: ['Grammar', 'Front', 'Back'] };
    const [card] = mapAnkiNote(`adj${SEP}hello${SEP}a greeting`, '', model);
    // Front is field 1 (not 0 = Grammar) because the name, not the position, wins.
    expect(card).toMatchObject({ front: 'hello', back: 'a greeting' });
  });

  test('M12: unrecognised field names fall back to positional front/back', () => {
    // No name matches a known front/back role → field 0 is the front, the next
    // filled field is the back. An unknown-schema deck is never mis-imported.
    const model: AnkiModel = { name: 'Vocab', type: 0, flds: ['Alpha', 'Beta'] };
    const [card] = mapAnkiNote(`gato${SEP}cat`, '', model);
    expect(card).toMatchObject({ front: 'gato', back: 'cat' });
  });

  test('returns [] only when EVERY field is empty (a non-empty field is salvaged)', () => {
    const model: AnkiModel = { name: 'Basic', type: 0, flds: ['Front', 'Back'] };
    // empty front but a filled back → salvaged into one card, not dropped
    expect(mapAnkiNote(`${SEP}only a back`, '', model)).toHaveLength(1);
    // truly empty note → nothing
    expect(mapAnkiNote(`${SEP}`, '', model)).toEqual([]);
  });
});

describe('mapAnkiNote — cloze (L16)', () => {
  const clozeModel: AnkiModel = { name: 'Cloze', type: 1, flds: ['Text'] };

  test('splits a multi-deletion note into one card per cloze number', () => {
    const note = '{{c1::Paris}} is the capital of {{c2::France}}';
    const cards = mapAnkiNote(note, '', clozeModel);
    expect(cards).toHaveLength(2);
    // c1 card: blank c1, REVEAL c2's answer.
    expect(cards[0]).toMatchObject({ front: '[…] is the capital of France', back: 'Paris' });
    // c2 card: reveal c1, blank c2.
    expect(cards[1]).toMatchObject({ front: 'Paris is the capital of […]', back: 'France' });
  });

  test('uses the hint as the blank when present', () => {
    const [card] = mapAnkiNote('The {{c1::cat::animal}} sat', '', clozeModel);
    expect(card.front).toBe('The [animal] sat');
    expect(card.back).toBe('cat');
  });

  test('a NON-cloze model is NOT cloze-processed even if a field mentions {{cN::}}', () => {
    const basic: AnkiModel = { name: 'Basic', type: 0, flds: ['Front', 'Back'] };
    const cards = mapAnkiNote(`The {{c1::cat}} sat${SEP}meaning`, '', basic);
    expect(cards).toHaveLength(1); // not split
    expect(cards[0].front).toBe('The cat sat'); // markup unwrapped, not blanked
    expect(cards[0].back).toBe('meaning');
  });

  test('an unknown model falls back to content-based cloze detection', () => {
    const cards = mapAnkiNote('{{c1::one}} and {{c2::two}}', '', undefined);
    expect(cards).toHaveLength(2);
  });
});

describe('buildApkgPayload', () => {
  test('flattens cloze splits across the notes table', () => {
    const models = parseAnkiModels(
      JSON.stringify({ '7': { name: 'Cloze', type: 1, flds: [{ name: 'Text', ord: 0 }] } }),
    );
    const notes = [
      { mid: '7', flds: '{{c1::a}} {{c2::b}}', tags: '' },
      { mid: '7', flds: '{{c1::solo}}', tags: '' },
    ];
    expect(buildApkgPayload(notes, models)).toHaveLength(3); // 2 + 1
  });
});

describe('groupNotesBySection', () => {
  // A single Basic model shared by all the notes below.
  const models = parseAnkiModels(
    JSON.stringify({ '1': { name: 'Basic', type: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }] } }),
  );
  const note = (id: string, front: string): AnkiNoteRow => ({ id, mid: '1', flds: `${front}${SEP}gloss`, tags: '' });

  const deckNames = {
    '10': 'German::Verbs::A1',
    '20': 'German::Verbs::B1',
    '30': 'German::Vocabulary::A1',
  };

  test('partitions notes into one section per distinct subdeck, with counts', () => {
    const notes = [note('a', 'gehen'), note('b', 'kommen'), note('c', 'der Hund')];
    const noteDid = { a: '20', b: '20', c: '30' };
    const { sections, payload } = groupNotesBySection(notes, noteDid, deckNames, models);

    expect(payload).toHaveLength(3);
    expect(sections.map((s) => s.name)).toEqual(['German::Verbs::B1', 'German::Vocabulary::A1']); // sorted
    const verbs = sections.find((s) => s.did === '20')!;
    expect(verbs.payload).toHaveLength(2);
    expect(verbs.path).toEqual(['German', 'Verbs', 'B1']);
    expect(sections.find((s) => s.did === '30')!.payload).toHaveLength(1);
  });

  test('a cloze note (2 cards from ONE note) attributes BOTH cards to its subdeck', () => {
    // The only way one note yields multiple cards here is a cloze model: {{c1}} +
    // {{c2}} → 2 cards, and BOTH must land in the note's section AND the flat
    // payload. Guards the two-loop append: a regression that dropped the extra
    // card from the section loop (but not the flat payload) would pass every
    // single-card test above yet silently import half a subdeck's cards.
    const clozeModels = parseAnkiModels(
      JSON.stringify({ '2': { name: 'Cloze', type: 1, flds: [{ name: 'Text', ord: 0 }] } }),
    );
    const notes: AnkiNoteRow[] = [{ id: 'a', mid: '2', flds: '{{c1::eins}} und {{c2::zwei}}', tags: '' }];
    const { sections, payload } = groupNotesBySection(notes, { a: '20' }, deckNames, clozeModels);
    expect(payload).toHaveLength(2); // c1 + c2
    expect(sections).toHaveLength(1);
    expect(sections[0].did).toBe('20');
    expect(sections[0].payload).toHaveLength(2); // BOTH cards attributed here
    // Multi-card union === flat (single section → order preserved too).
    expect(sections.flatMap((s) => s.payload)).toEqual(payload);
  });

  test('odid override: a note is attributed via the caller-resolved home deck', () => {
    // The caller resolves odid→did before calling; here a note whose home deck is
    // '10' (A1 verbs) groups under that name, proving section keys follow noteDid.
    const notes = [note('a', 'sein'), note('b', 'gehen')];
    const noteDid = { a: '10', b: '20' };
    const { sections } = groupNotesBySection(notes, noteDid, deckNames, models);
    expect(sections.map((s) => s.name)).toEqual(['German::Verbs::A1', 'German::Verbs::B1']);
  });

  test("a note with no known did → the single '(Other)' bucket", () => {
    const notes = [note('a', 'gehen'), note('b', 'orphan'), note('c', 'nodeck')];
    // 'b' maps to an unknown did; 'c' has no entry at all → both go to (Other).
    const noteDid = { a: '20', b: '999', c: undefined as unknown as string };
    const { sections } = groupNotesBySection(notes, noteDid, deckNames, models);
    const other = sections.find((s) => s.did === '');
    expect(other).toBeDefined();
    expect(other!.name).toBe('(Other)');
    expect(other!.payload).toHaveLength(2);
    expect(other!.path).toEqual(['(Other)']);
  });

  test('INVARIANT: union of all section payloads === the flat payload (count + content)', () => {
    const notes = [note('a', 'gehen'), note('b', 'der Hund'), note('c', 'orphan')];
    const noteDid = { a: '20', b: '30', c: 'missing' };
    const { sections, payload } = groupNotesBySection(notes, noteDid, deckNames, models);
    const union = sections.flatMap((s) => s.payload);
    expect(union).toHaveLength(payload.length);
    // Same objects, same order per section concat (import-all === import-whole-deck).
    const fronts = union.map((c) => c.front).sort();
    expect(fronts).toEqual(payload.map((c) => c.front).sort());
  });

  test('single-section input yields exactly one section', () => {
    const notes = [note('a', 'gehen'), note('b', 'kommen')];
    const { sections } = groupNotesBySection(notes, { a: '20', b: '20' }, deckNames, models);
    expect(sections).toHaveLength(1);
    expect(sections[0].did).toBe('20');
  });

  test('an empty deck (no cards attributed) is dropped', () => {
    // '10' exists in deckNames but no note points at it → it must not appear.
    const notes = [note('a', 'gehen')];
    const { sections } = groupNotesBySection(notes, { a: '20' }, deckNames, models);
    expect(sections.map((s) => s.did)).toEqual(['20']);
    expect(sections.some((s) => s.did === '10')).toBe(false);
  });

  test("notes whose model maps to no card don't create a section", () => {
    // An all-empty note yields 0 cards → contributes nothing (no phantom section).
    const empty: AnkiNoteRow = { id: 'z', mid: '1', flds: `${SEP}`, tags: '' };
    const notes = [note('a', 'gehen'), empty];
    const { sections, payload } = groupNotesBySection(notes, { a: '20', z: '10' }, deckNames, models);
    expect(payload).toHaveLength(1);
    expect(sections.map((s) => s.did)).toEqual(['20']);
  });
});

describe('ankiDeckName over selected subdecks', () => {
  test('a single selected subdeck name → its full friendly name', () => {
    expect(ankiDeckName(['German::Verbs::B1'], 'fallback')).toBe('German Verbs B1');
  });

  test('two sibling subdecks → their common prefix', () => {
    expect(ankiDeckName(['German::Verbs::B1', 'German::Verbs::B2'], 'fallback')).toBe('German Verbs');
  });
});
