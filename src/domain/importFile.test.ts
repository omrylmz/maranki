/**
 * CSV import parsing. Pins the delimiter sniffer (H5 — sample many lines, not
 * one), the header guard (L20 — a real first word must not be dropped), and the
 * shared-tokeniser quote handling. Column contract (positional):
 *   0 Front · 1 Back · 2 Example · 3 Notes · 4 Tags
 */
import { describe, expect, test } from '@jest/globals';

import { detectDelimiter, parseImportCsv, splitCsvRows } from './importFile';

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
