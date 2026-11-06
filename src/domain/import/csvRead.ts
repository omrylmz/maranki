/**
 * The CSV reader (spec §5.7, unit W2-5): text → AnkiCollection, the SAME
 * shape the .apkg reader gives. So a spreadsheet goes through the same
 * planner (plan.ts), the same Fields screen and the same preview as an Anki
 * deck. Pure: no React, no I/O, no clock.
 *
 * What it understands:
 *   - Delimiter detection and RFC-4180 quoting are today's (importFile.ts
 *     `detectDelimiter` and `splitCsvRows`, tests H5/L20).
 *   - A HEADER row gives the field names: "Word,Translation,Level,Type" → four
 *     named fields, so Level and Type can become filter groups. The header is
 *     detected with two signals (`isCsvHeaderRow`, the L20 guard, which also
 *     knows "Question,Answer" and "German,English") or forced
 *     with the "First row is a header" toggle (`opts.header`).
 *     If exactly one header cell is named "Tags" (or "Tag"), that column holds
 *     the tags (split on | ; or ,), like today's importer gave such files.
 *   - NO header → fields "Field 1" … "Field N" with today's positions: column
 *     0 Front, 1 Back, 2 Example, 3 Notes, and columns 4+ are TAGS (split on
 *     | ; or ,). So an old file imports the same way as before.
 *   - `csv.tagsCol` says where the tags are, `csv.tagsSpill` whether the
 *     columns after it are tags too (only the no-header rule), and
 *     `csv.tagsSyntax` how they are separated ('anki' white space or 'list').
 *   - Anki "Notes in Plain Text" exports start with header lines. They are
 *     read and never become cards:
 *       #separator:tab|comma|semicolon|pipe|space|colon (or the character)
 *       #html:true|false
 *       #columns:Front<sep>Back<sep>Tags        (the field names)
 *       #tags column:N   #guid column:N   #deck column:N   #notetype column:N   (1-based)
 *       #deck:Name   #notetype:Name   #tags:a b c   (one value for every row)
 *   - `#html:true` → values are stored raw (Anki HTML, rendered safely later).
 *     Otherwise (plain CSV, `#html:false`) values are TEXT, so they are escaped
 *     (& < > and line breaks → <br>): "a < b" never turns into a broken tag.
 *   - A deck column gives sections (its values are Anki deck paths
 *     "German::Verbs::B1"). A notetype column gives one card type per value.
 *
 * Every card type gets two synthesized templates: ord 0 "Front → Back"
 * (first field asked) and ord 1 "Back → Front" (second field asked), and
 * `sortf` 0. These are only today's positions: the planner rebuilds the
 * directions and the sort field from the columns the learner chose as Front
 * and Back (plan.ts `csvFrontBack`). Only ord 0 is enabled by default; "Also
 * make a reverse card" enables ord 1. Each note gets one card row per
 * template (type 0 = new, in row order), so the planner reads CSV and .apkg
 * cards the same way.
 *
 * CLOZE: a card type whose notes hold Anki cloze markup (`{{c1::Berlin}}`) is
 * a cloze type (`type: 1`), like Anki's own "Cloze" note type: an Anki text
 * export of Cloze notes, or a CSV whose column holds cloze text. Its one
 * template asks `{{cloze:<that column>}}` and shows the other columns on the
 * back, and each note gets ONE card row per cloze number (ord = number − 1).
 * Before, it was a standard type, and the question showed the raw markup with
 * the answers in it (`isClozeModel`).
 *
 * Same columns, same card type: `csvSignature()` (folded field names joined)
 * is stored in NoteType.source.csvSignature by the planner, and a second file
 * with the same columns reuses that card type, so both share filter groups.
 *
 * Hermes-safe: no String.normalize / replaceAll / lookbehind.
 */
import { clozeNumbers } from '../cloze';
import { deckNameFromFile, detectDelimiter, splitCsvRows } from '../importFile';
import type { AnkiCollection } from '../model';
import { foldText } from '../text';

/** Model id of a CSV without a notetype column. */
export const CSV_MODEL_ID = 'csv';
/** Deck id of a CSV without a deck column. */
export const CSV_DECK_ID = '1';
/** In a file without a header, columns from this index on are tags (today's rule). */
export const CSV_POSITIONAL_TAGS_COL = 4;

export interface CsvReadOptions {
  /**
   * "First row is a header": true or false. Absent = detect it with
   * `isCsvHeaderRow`. An Anki `#columns:` line always wins (its names are the header).
   */
  header?: boolean;
  /**
   * Make this column (0-based) the tags column (the Fields screen's "Tags"
   * choice), or null = no tags column. Absent = the file's own rule.
   */
  tagsCol?: number | null;
}

/* ------------------------------------------------------------ header row */

/** The first run of latin letters, folded ("Übersetzung:" → "ubersetzung"). */
function leadingToken(cell: string): string {
  const match = foldText((cell ?? '').trim()).match(/^[a-z]+/);
  return match ? match[0] : '';
}

/**
 * Labels that make a FIRST cell read like a header. The first part is the set
 * of today's importer (importFile.ts `parseImportCsv`, kept there as the
 * reference of the OLD mapping); the reader also knows a question column
 * ("Question,Answer", "Frage,Antwort", "Kanji,Meaning", Anki's cloze
 * "Text,Back Extra") and the generic names of the app's own CSV export of a
 * deck without a header ("Field 1,Field 2,Tags,Section").
 */
const HEADER_FIRST_CELLS = new Set<string>([
  'word', 'words', 'front', 'term', 'terms', 'vocab', 'vocabulary', 'headword', 'lemma', 'wort',
  'palabra', 'mot', 'parola', 'begriff', 'terme', 'termino', 'vorderseite',
  'question', 'questions', 'prompt', 'frage', 'pregunta', 'domanda', 'text', 'expression', 'kanji',
  'hanzi', 'field',
]);

/** Labels expected in ANOTHER cell of a header row: the second signal. */
const HEADER_OTHER_CELLS = new Set<string>([
  'translation', 'translations', 'meaning', 'meanings', 'definition', 'back', 'answer', 'gloss',
  'sense', 'example', 'examples', 'sentence', 'usage', 'note', 'notes', 'tag', 'tags',
  'ubersetzung', 'bedeutung', 'beispiel', 'wort', 'traduccion', 'traduction', 'traduzione',
  'significado', 'significato', 'signification', 'ejemplo', 'exemple', 'esempio', 'respuesta',
  'reponse', 'antwort', 'oracion', 'ruckseite', 'section', 'level',
]);

/** Back-side labels that may come FIRST, before a front label ("Translation,Word"). */
const HEADER_BACK_CELLS = new Set<string>([
  'translation', 'translations', 'meaning', 'meanings', 'definition', 'back', 'answer', 'gloss',
  'ubersetzung', 'bedeutung', 'traduccion', 'traduction', 'traduzione', 'significado', 'significato',
  'signification', 'respuesta', 'reponse', 'antwort', 'ruckseite',
]);

/**
 * Language names as column labels ("German,English", "Deutsch,Englisch"),
 * folded, → one code per language. A Map, so a cell such as "constructor"
 * is never a language.
 */
const LANGUAGE_OF = new Map<string, string>([
  ['english', 'en'], ['englisch', 'en'], ['ingles', 'en'], ['anglais', 'en'], ['inglese', 'en'],
  ['german', 'de'], ['deutsch', 'de'], ['aleman', 'de'], ['allemand', 'de'], ['tedesco', 'de'],
  ['spanish', 'es'], ['spanisch', 'es'], ['espanol', 'es'], ['espagnol', 'es'], ['spagnolo', 'es'],
  ['french', 'fr'], ['franzosisch', 'fr'], ['frances', 'fr'], ['francais', 'fr'], ['francese', 'fr'],
  ['italian', 'it'], ['italienisch', 'it'], ['italiano', 'it'], ['italien', 'it'],
  ['portuguese', 'pt'], ['portugiesisch', 'pt'], ['portugues', 'pt'],
  ['dutch', 'nl'], ['niederlandisch', 'nl'], ['russian', 'ru'], ['russisch', 'ru'],
  ['turkish', 'tr'], ['turkisch', 'tr'], ['polish', 'pl'], ['polnisch', 'pl'], ['swedish', 'sv'],
  ['japanese', 'ja'], ['japanisch', 'ja'], ['chinese', 'zh'], ['chinesisch', 'zh'], ['korean', 'ko'],
  ['koreanisch', 'ko'], ['arabic', 'ar'], ['arabisch', 'ar'], ['greek', 'el'], ['latin', 'la'],
]);

/**
 * True when the first row is a header. TWO signals are always needed, so a
 * real first word such as German "Wort" (or a translation pair such as
 * "Wort,word" or "German,Deutsch") is never dropped as a header (L20):
 *   - a Front label first ("Word", "Front", "Question", "Kanji" …) and a
 *     known label or a language name in another cell (today's rule, with
 *     more labels): "Question,Answer", "Word,English", "Text,Back Extra";
 *   - a Back label first and a Front label after it: "Translation,Word";
 *   - a language name first and ANOTHER language (or a known label) in
 *     another cell: "German,English", "Deutsch,Englisch", "English,Notes".
 *     Two names of the SAME language ("German,Deutsch") are a translation
 *     pair, so data.
 *
 *   isCsvHeaderRow(['Question', 'Answer'])  → true
 *   isCsvHeaderRow(['German', 'English'])   → true
 *   isCsvHeaderRow(['German', 'Deutsch'])   → false
 *   isCsvHeaderRow(['Wort', 'word'])        → false
 */
export function isCsvHeaderRow(row: string[]): boolean {
  const first = leadingToken(row[0] ?? '');
  const others = row.slice(1).map((cell) => leadingToken(cell));
  if (HEADER_FIRST_CELLS.has(first) && others.some((t) => HEADER_OTHER_CELLS.has(t) || LANGUAGE_OF.has(t))) return true;
  if (HEADER_BACK_CELLS.has(first) && others.some((t) => HEADER_FIRST_CELLS.has(t))) return true;
  const lang = LANGUAGE_OF.get(first);
  if (lang === undefined) return false;
  return others.some((t) => {
    const other = LANGUAGE_OF.get(t);
    return (other !== undefined && other !== lang) || HEADER_OTHER_CELLS.has(t);
  });
}

/* ------------------------------------------------------------ small helpers */

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Plain text → safe field HTML: & < > escaped, line breaks → <br>. */
export function escapeCsvText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * A header label → a valid field name. Anki field names cannot contain
 * : { } " and cannot start with # / ^ (template syntax), so those become spaces.
 */
function cleanFieldName(raw: string): string {
  return raw
    .replace(/[:{}"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#/^]+\s*/, '');
}

/** Make every name unique: a repeated "Level" becomes "Level 2", "Level 3" … */
function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let out = name;
    for (let k = 2; used.has(foldText(out)); k++) out = `${name} ${k}`;
    used.add(foldText(out));
    return out;
  });
}

/**
 * The CSV signature of a card type: the folded field names joined by '|'
 * (plus the card-type name for a notetype column). Two files with the same
 * columns have the same signature, so they share one card type.
 *
 *   csvSignature(['Word', 'Translation']) → 'word|translation'
 */
export function csvSignature(fieldNames: string[], typeName?: string): string {
  const names = fieldNames.map((n) => foldText(n).trim()).join('|');
  return typeName === undefined ? names : `type:${foldText(typeName).trim()}|${names}`;
}

/**
 * The synthesized templates of a CSV card type: "Front → Back" asks the
 * `front` column, "Back → Front" asks the `back` column. The answer shows
 * the other side first (it is the answer headline), then every other column
 * in column order.
 *
 * The reader does not know the field roles, so it uses columns 0 and 1
 * (today's positions). The planner calls it again with the columns the
 * learner chose as Front and Back (plan.ts `csvFrontBack`).
 *
 *   csvTemplates(['Level', 'Word', 'Meaning'], 1, 2)[0]
 *   → { ord: 0, qfmt: '{{Word}}', afmt: '{{FrontSide}}<hr id=answer>{{Meaning}}<br>{{Level}}' … }
 */
export function csvTemplates(fieldNames: string[], front = 0, back = 1): AnkiCollection['models'][string]['tmpls'] {
  const ref = (i: number) => `{{${fieldNames[i]}}}`;
  // `first` comes first, then the other columns except `skip` and `first`.
  const answer = (skip: number, first: number) =>
    [first, ...fieldNames.map((_, i) => i).filter((i) => i !== skip && i !== first)].map(ref).join('<br>');
  if (fieldNames.length === 0) return [];
  const forward = {
    name: 'Front → Back',
    ord: 0,
    qfmt: ref(front),
    afmt: `{{FrontSide}}<hr id=answer>${fieldNames.length < 2 ? '' : answer(front, back)}`,
  };
  if (fieldNames.length < 2) return [forward];
  return [forward, { name: 'Back → Front', ord: 1, qfmt: ref(back), afmt: `{{FrontSide}}<hr id=answer>${answer(back, front)}` }];
}

/** Anki cloze markup in a value: `{{c1::…}}`. */
const CLOZE_MARK = /\{\{c\d+::/;

/**
 * The column (index into the field names) that makes a CSV card type a CLOZE
 * type, or undefined (a standard type). It is the first column with cloze
 * markup, when
 *   - the card type's name says Cloze ("Cloze", "Cloze (German)") and at
 *     least one of its notes has markup there, or
 *   - EVERY note of the card type has markup there (a plain CSV of cloze
 *     sentences).
 * A column where only some notes have markup, in a type not named Cloze,
 * stays text: a standard card can quote "{{c1::…}}" on purpose.
 *
 *   clozeColumn('Cloze', [['{{c1::Berlin}} ist…', 'Extra']]) → 0
 *   clozeColumn('Basic', [['{{c1::a}}', 'x'], ['plain', 'y']]) → undefined
 */
export function clozeColumn(typeName: string, notes: readonly (readonly string[])[]): number | undefined {
  if (notes.length === 0) return undefined;
  const width = notes.reduce((w, n) => Math.max(w, n.length), 0);
  const named = /cloze/i.test(typeName);
  for (let col = 0; col < width; col++) {
    const marked = notes.filter((n) => CLOZE_MARK.test(n[col] ?? '') && clozeNumbers(n[col] ?? '').length > 0).length;
    if (marked === 0) continue;
    if (named || marked === notes.length) return col;
  }
  return undefined;
}

/**
 * The one template of a CSV cloze type: it asks `{{cloze:<column>}}` and
 * shows every other column on the back (Anki's "Cloze" asks
 * `{{cloze:Text}}` and shows "Back Extra").
 */
export function csvClozeTemplates(fieldNames: string[], cloze: number): AnkiCollection['models'][string]['tmpls'] {
  const ref = (i: number) => `{{${fieldNames[i]}}}`;
  const others = fieldNames.map((_, i) => i).filter((i) => i !== cloze).map(ref);
  const ask = `{{cloze:${fieldNames[cloze]}}}`;
  return [{ name: 'Cloze', ord: 0, qfmt: ask, afmt: others.length > 0 ? `${ask}<br>${others.join('<br>')}` : ask }];
}

/** Today's tag rule: split on | ; , (optionally spilling over several cells), de-duplicated ignoring case. */
function listTags(cells: string[]): string[] {
  return cells
    .join(',')
    .split(/[|;,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Header labels that name the tags column ("Tags", "tag", "TAGS"). */
const TAGS_HEADER = new Set(['tags', 'tag']);

/**
 * The column of a header row that holds the tags: the ONE cell whose folded
 * name is "tags" or "tag". None, or more than one → undefined (the cells stay
 * fields; the Fields screen can still choose a tags column).
 *
 *   tagsHeaderColumn(['Front', 'Back', 'Tags']) → 2
 *   tagsHeaderColumn(['Tags', 'tag'])           → undefined
 */
export function tagsHeaderColumn(header: string[]): number | undefined {
  const cols: number[] = [];
  header.forEach((cell, i) => {
    if (TAGS_HEADER.has(foldText((cell ?? '').trim()))) cols.push(i);
  });
  return cols.length === 1 ? cols[0] : undefined;
}

/** Anki's tag rule: tags are separated by white space. */
function ankiTags(cell: string): string[] {
  return cell.split(/\s+/).filter((t) => t.length > 0);
}

/** Keep the first spelling of each tag, ignoring case (like today's importer). */
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/* --------------------------------------------------- Anki text-export headers */

/**
 * Anki's separator names. A Map, not a plain object: the name comes from the
 * file, and `{}['constructor']` would be Object's built-in function (H2).
 */
const SEPARATORS = new Map<string, string>([
  ['tab', '\t'],
  ['comma', ','],
  ['semicolon', ';'],
  ['pipe', '|'],
  ['space', ' '],
  ['colon', ':'],
]);

interface AnkiHeaders {
  separator?: string;
  html?: boolean;
  columns?: string;
  tagsCol?: number;
  guidCol?: number;
  deckCol?: number;
  notetypeCol?: number;
  deck?: string;
  notetype?: string;
  tags?: string[];
}

/** "3" (1-based, as Anki writes it) → 2; anything else → undefined. */
function columnIndex(value: string): number | undefined {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1 ? n - 1 : undefined;
}

/**
 * Read the `#key:value` lines at the very top of the text. Only known keys
 * are read; the first other line ends the header block.
 * Returns the headers and the text that follows them.
 */
function readAnkiHeaders(text: string): { headers: AnkiHeaders; body: string; found: boolean } {
  const headers: AnkiHeaders = {};
  let offset = 0;
  let found = false;
  while (offset < text.length && text.charAt(offset) === '#') {
    let end = offset;
    while (end < text.length && text.charAt(end) !== '\n' && text.charAt(end) !== '\r') end++;
    const line = text.slice(offset + 1, end);
    const colon = line.indexOf(':');
    if (colon < 0) break;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1);
    const v = value.trim();
    switch (key) {
      case 'separator': {
        const named = SEPARATORS.get(v.toLowerCase());
        headers.separator = named ?? (value.length === 1 ? value : v.charAt(0) || ',');
        break;
      }
      case 'html':
        headers.html = v.toLowerCase() === 'true';
        break;
      case 'columns':
        headers.columns = value;
        break;
      case 'tags column':
        headers.tagsCol = columnIndex(v);
        break;
      case 'guid column':
        headers.guidCol = columnIndex(v);
        break;
      case 'deck column':
        headers.deckCol = columnIndex(v);
        break;
      case 'notetype column':
        headers.notetypeCol = columnIndex(v);
        break;
      case 'deck':
        headers.deck = v;
        break;
      case 'notetype':
        headers.notetype = v;
        break;
      case 'tags':
        headers.tags = ankiTags(v);
        break;
      default:
        // Not an Anki header line: it is data. Stop here.
        return { headers, body: text.slice(offset), found };
    }
    found = true;
    // Step over the line break (\r\n counts as one).
    offset = end;
    if (text.charAt(offset) === '\r') offset++;
    if (text.charAt(offset) === '\n') offset++;
  }
  return { headers, body: text.slice(offset), found };
}

/* ---------------------------------------------------------------- the reader */

/**
 * Read CSV / TSV / Anki text-export text into an AnkiCollection.
 * `fileName` gives the default deck and card-type name ("Fruits.csv" → "Fruits").
 */
export function readCsv(text: string, fileName: string, opts: CsvReadOptions = {}): AnkiCollection {
  const fileDeck = deckNameFromFile(fileName);
  const { headers, body, found: ankiExport } = readAnkiHeaders(stripBom(text ?? ''));
  const delimiter = headers.separator ?? detectDelimiter(body);
  const html = headers.html === true;
  let rows = splitCsvRows(body, delimiter).filter((r) => r.some((cell) => cell.trim() !== ''));

  // 1. The header: #columns wins, then the toggle, then today's detection.
  let header: string[] | null = null;
  if (headers.columns !== undefined) {
    header = splitCsvRows(headers.columns, delimiter)[0] ?? [];
  } else if (rows.length > 0 && (opts.header ?? isCsvHeaderRow(rows[0]))) {
    header = rows[0];
    rows = rows.slice(1);
  }

  // 2. The special columns.
  const guidCol = headers.guidCol;
  const deckCol = headers.deckCol;
  const notetypeCol = headers.notetypeCol;
  let tagsCol = headers.tagsCol;
  let spillTags = false; // today's rule: column 4 AND every column after it
  // An Anki `#tags column` holds space-separated tags; every other tags column uses | ; , like today.
  const ankiTagSyntax = opts.tagsCol === undefined && headers.tagsCol !== undefined;
  if (opts.tagsCol !== undefined) {
    tagsCol = opts.tagsCol ?? undefined;
  } else if (!ankiExport && header === null) {
    tagsCol = CSV_POSITIONAL_TAGS_COL;
    spillTags = true;
  } else if (!ankiExport && header !== null) {
    // A plain CSV with a header: a cell named "Tags" is the tags column (today
    // these files had their tags in columns 4+, so they keep their tags).
    tagsCol = tagsHeaderColumn(header);
  }
  const special = new Set<number>(
    [guidCol, deckCol, notetypeCol, tagsCol].filter((c): c is number => c !== undefined),
  );

  // 3. The field columns and their names.
  let width = header?.length ?? 0;
  for (const r of rows) if (r.length > width) width = r.length;
  if (spillTags) width = Math.min(width, CSV_POSITIONAL_TAGS_COL);
  const fieldCols: number[] = [];
  for (let c = 0; c < width; c++) if (!special.has(c)) fieldCols.push(c);
  const names = uniqueNames(
    fieldCols.map((c, k) => {
      const label = header ? cleanFieldName(header[c] ?? '') : '';
      return label || `Field ${header ? c + 1 : k + 1}`;
    }),
  );
  const tmpls = csvTemplates(names);
  const flds = names.map((name, ord) => ({ name, ord }));

  // 4. Decks (sections) and card types, in first-seen order.
  // The records have no prototype, like the .apkg reader's (H2). Their keys
  // are made here ('1', 'csv:2' …), but the values come from the file.
  const defaultDeck = headers.deck || fileDeck;
  const decks = Object.create(null) as Record<string, string>;
  const didOf = new Map<string, string>();
  const deckId = (name: string): string => {
    let did = didOf.get(name);
    if (did === undefined) {
      did = deckCol === undefined ? CSV_DECK_ID : String(didOf.size + 1);
      didOf.set(name, did);
      decks[did] = name;
    }
    return did;
  };
  const defaultType = headers.notetype || fileDeck;
  const models = Object.create(null) as AnkiCollection['models'];
  const midOf = new Map<string, string>();
  const modelId = (name: string): string => {
    let mid = midOf.get(name);
    if (mid === undefined) {
      mid = notetypeCol === undefined ? CSV_MODEL_ID : `${CSV_MODEL_ID}:${midOf.size + 1}`;
      midOf.set(name, mid);
      models[mid] = { name, type: 0, sortf: 0, flds: flds.map((f) => ({ ...f })), tmpls: tmpls.map((t) => ({ ...t })) };
    }
    return mid;
  };

  // 5. Notes, then their card rows (6).
  const cell = (r: string[], c: number | undefined) => (c === undefined ? '' : (r[c] ?? '').trim());
  const notes: AnkiCollection['notes'] = [];
  const cards: AnkiCollection['cards'] = [];
  const rowOf: { did: string; due: number }[] = []; // by note, in note order
  rows.forEach((r, i) => {
    const values = fieldCols.map((c) => cell(r, c));
    if (values.every((v) => v === '')) return; // a row with no field text is no item
    const nid = String(i + 1);
    const did = deckId(cell(r, deckCol) || defaultDeck);
    const mid = modelId(cell(r, notetypeCol) || defaultType);
    let tags: string[] = headers.tags ? [...headers.tags] : [];
    if (tagsCol !== undefined) {
      if (spillTags) tags = tags.concat(listTags(r.slice(tagsCol)));
      else if (ankiTagSyntax) tags = tags.concat(ankiTags(cell(r, tagsCol)));
      else tags = tags.concat(listTags([cell(r, tagsCol)]));
    }
    notes.push({
      id: nid,
      guid: cell(r, guidCol),
      mid,
      flds: values.map((v) => (html ? v : escapeCsvText(v))),
      tags: dedupeTags(tags),
    });
    rowOf.push({ did, due: i + 1 });
  });

  // 6. Cloze card types (`clozeColumn`), then one card row per template — a
  //    cloze note: one per cloze number of its cloze column.
  const clozeOf = new Map<string, number>(); // mid → its cloze column
  for (const mid of Object.keys(models)) {
    const col = clozeColumn(
      models[mid].name,
      notes.filter((n) => n.mid === mid).map((n) => n.flds),
    );
    if (col === undefined) continue;
    clozeOf.set(mid, col);
    models[mid] = { ...models[mid], type: 1, sortf: col, tmpls: csvClozeTemplates(names, col) };
  }
  notes.forEach((note, k) => {
    const { did, due } = rowOf[k];
    const col = clozeOf.get(note.mid);
    const ords = col === undefined ? models[note.mid].tmpls.map((t) => t.ord) : clozeNumbers(note.flds[col] ?? '').map((n) => n - 1);
    for (const ord of ords) {
      cards.push({
        id: `${note.id}-${ord}`,
        nid: note.id,
        did,
        odid: '0',
        ord,
        type: 0,
        queue: 0,
        due,
        ivl: 0,
        factor: 0,
        reps: 0,
        lapses: 0,
        flags: 0,
      });
    }
  });
  // A file with no rows still has its (empty) deck and card type.
  if (Object.keys(decks).length === 0) deckId(defaultDeck);
  if (Object.keys(models).length === 0) modelId(defaultType);

  return {
    fileName,
    crt: 0,
    models,
    decks,
    notes,
    cards,
    media: Object.create(null) as Record<string, string>,
    csv: {
      // The header cells as written (all columns, special ones too), so the
      // column numbers below index into it. The field names are in `models`.
      header: header ? header.map((h) => h.trim()) : null,
      delimiter,
      html,
      ...(guidCol !== undefined ? { guidCol } : {}),
      ...(deckCol !== undefined ? { deckCol } : {}),
      ...(notetypeCol !== undefined ? { notetypeCol } : {}),
      ...(tagsCol !== undefined
        ? { tagsCol, tagsSpill: spillTags, tagsSyntax: ankiTagSyntax ? ('anki' as const) : ('list' as const) }
        : {}),
    },
  };
}
