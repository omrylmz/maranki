/**
 * Anki note → card mapping. Pins the cloze split + model gating (L16), the
 * article split on import (L17), and multilingual field-role detection (M12).
 */
import { describe, expect, test } from '@jest/globals';

import { AnkiModel, buildApkgPayload, mapAnkiNote, parseAnkiModels } from './anki';

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
    const model: AnkiModel = { name: 'Basic', type: 0, flds: ['Grammar', 'Word', 'Translation'] };
    const [card] = mapAnkiNote(`adj${SEP}der Hund${SEP}the dog`, '', model);
    // Word is field 1 (not 0 = Grammar); article is split off.
    expect(card).toMatchObject({ word: 'der Hund', article: 'der', base: 'Hund', tr: 'the dog' });
  });

  test('M12: recognises Spanish/French field names', () => {
    const model: AnkiModel = { name: 'Vocab', type: 0, flds: ['Palabra', 'Traducción'] };
    const [card] = mapAnkiNote(`gato${SEP}cat`, '', model);
    expect(card).toMatchObject({ word: 'gato', tr: 'cat' });
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
    expect(cards[0]).toMatchObject({ word: '[…] is the capital of France', tr: 'Paris' });
    // c2 card: reveal c1, blank c2.
    expect(cards[1]).toMatchObject({ word: 'Paris is the capital of […]', tr: 'France' });
  });

  test('uses the hint as the blank when present', () => {
    const [card] = mapAnkiNote('The {{c1::cat::animal}} sat', '', clozeModel);
    expect(card.word).toBe('The [animal] sat');
    expect(card.tr).toBe('cat');
  });

  test('a NON-cloze model is NOT cloze-processed even if a field mentions {{cN::}}', () => {
    const basic: AnkiModel = { name: 'Basic', type: 0, flds: ['Front', 'Back'] };
    const cards = mapAnkiNote(`The {{c1::cat}} sat${SEP}meaning`, '', basic);
    expect(cards).toHaveLength(1); // not split
    expect(cards[0].word).toBe('The cat sat'); // markup unwrapped, not blanked
    expect(cards[0].tr).toBe('meaning');
  });

  test('an unknown model falls back to content-based cloze detection', () => {
    const cards = mapAnkiNote('{{c1::eins}} und {{c2::zwei}}', '', undefined);
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
