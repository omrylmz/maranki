/**
 * CSV import parsing. Pins the delimiter sniffer (H5 — sample many lines, not
 * one), the header guard (L20 — a real first word must not be dropped), and the
 * shared-tokeniser quote handling.
 */
import { describe, expect, test } from '@jest/globals';

import { detectDelimiter, parseImportCsv, splitCsvRows } from './importFile';

describe('detectDelimiter — scores across lines, not just the first (H5)', () => {
  test('comma, semicolon and tab tables are each recognised', () => {
    expect(detectDelimiter('Word,Translation\nHund,dog')).toBe(',');
    expect(detectDelimiter('Wort;Übersetzung\nHund;dog')).toBe(';');
    expect(detectDelimiter('Wort\tÜbersetzung\nHund\tdog')).toBe('\t');
  });

  test('a misleading FIRST line cannot pick the wrong delimiter', () => {
    // The header has commas; every DATA row is semicolon-delimited. The old
    // single-line sniff chose ',' and then split every data row into one column.
    const csv = 'Word, Translation, and notes\nHund;dog;das Tier\nKatze;cat;das Tier';
    expect(detectDelimiter(csv)).toBe(';');
  });

  test('a single-column file falls back to comma (splits nothing)', () => {
    expect(detectDelimiter('Hund\nKatze\nVogel')).toBe(',');
  });

  test('a comma inside a value column cannot out-vote the real tab/semicolon (H5)', () => {
    // A 2-column TSV whose meaning column is a comma-separated synonym list.
    // Comma splits each row into MORE (but equally consistent) columns; the old
    // count-rewarding score chose ',', embedding a literal tab into the word.
    expect(detectDelimiter('gehen\tto go, to walk\nlaufen\tto run, to jog')).toBe('\t');
    // Two commas per row — comma would yield 3 uniform columns vs the tab's 2.
    expect(
      detectDelimiter('gehen\tto go, to walk, to march\nlaufen\tto run, to jog, to sprint'),
    ).toBe('\t');
    // Same hazard with a semicolon-delimited file.
    expect(detectDelimiter('gehen;to go, to walk\nlaufen;to run, to jog')).toBe(';');
  });

  test('the synonym-list TSV parses into clean word/translation pairs (H5)', () => {
    const { payload } = parseImportCsv('gehen\tto go, to walk\nlaufen\tto run, to jog', 'verbs.tsv');
    expect(payload.map((p) => p.word)).toEqual(['gehen', 'laufen']);
    expect(payload.map((p) => p.tr)).toEqual(['to go, to walk', 'to run, to jog']);
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
    const { payload } = parseImportCsv('Word,Translation\nHund,the dog', 'deck.csv');
    expect(payload.map((p) => p.word)).toEqual(['Hund']);
  });

  test('KEEPS a first data word that merely looks header-like ("Wort")', () => {
    // "Wort" is German for "word" — a genuine vocabulary entry, not a header,
    // because the rest of the row is data, not header labels.
    const { payload } = parseImportCsv('Wort,the word\nHund,the dog', 'deck.csv');
    expect(payload.map((p) => p.word)).toEqual(['Wort', 'Hund']);
  });

  test('a single-column file never loses its first row', () => {
    const { payload } = parseImportCsv('Word\nHund\nKatze', 'deck.csv');
    expect(payload.map((p) => p.word)).toEqual(['Word', 'Hund', 'Katze']);
  });

  test('surfaces a header row as fieldNames for language inference (H6)', () => {
    // A Spanish header whose deck name has no language hint: the header labels
    // are returned so inferLang can pick Spanish downstream.
    const { fieldNames } = parseImportCsv('Palabra,Traducción\ngato,cat', 'Lección 1.csv');
    expect(fieldNames).toEqual(['Palabra', 'Traducción']);
    // No header ⇒ no field names (nothing to infer from).
    expect(parseImportCsv('gato,cat\nperro,dog', 'deck.csv').fieldNames).toBeUndefined();
  });
});

describe('parseImportCsv — column mapping', () => {
  test('splits a German article into article/base and maps level/type', () => {
    const { payload } = parseImportCsv('der Hund,the dog,Der Hund bellt.,A1,noun', 'Tiere.csv');
    expect(payload[0]).toMatchObject({
      word: 'der Hund',
      article: 'der',
      base: 'Hund',
      tr: 'the dog',
      ex: 'Der Hund bellt.',
      level: 'A1',
      type: 'noun',
    });
  });

  test('derives the deck name from the file name', () => {
    expect(parseImportCsv('Hund,dog', 'German Animals.csv').name).toBe('German Animals');
  });
});
