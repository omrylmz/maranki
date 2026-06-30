/**
 * Pure parsing for the "From a file" import source (import hub, B6).
 *
 * Two responsibilities, both side-effect-free:
 *   1. detectImportKind() — sniff a picked file as CSV vs Anki package vs unknown,
 *      by extension first and content second. .apkg is a ZIP wrapping a SQLite DB;
 *      this app ships no unzip/sqlite, so we DETECT and DECLINE it honestly rather
 *      than pretend to import — the caller shows guidance to export CSV from Anki.
 *   2. parseImportCsv() — turn raw CSV text into ImportCardPayload[] (+ a deck name
 *      derived from the file name). The result is fed straight into the existing
 *      staged flow: the caller stages { payload, name } as a 'file' import item,
 *      so preview → progress → done → "Study the new deck" is reused as-is.
 *      importDeck() (DataContext) fills SRS defaults + lang for any field we omit.
 *
 * Constraints: no React, no I/O, no Date.now / Math.random — deterministic and
 * unit-testable. Hermes-safe (no String.prototype.normalize / replaceAll).
 *
 * CSV column contract promised by the import UI (positional):
 *   0 Word · 1 Translation · 2 Example · 3 Level · 4 Type · 5 Pronunciation · 6 Tags
 */
import { ImportCardPayload } from './importSamples';
import { CefrLevel, WordType } from './types';
import { splitArticle } from './words';

export type ImportKind = 'csv' | 'apkg' | 'unknown';

export interface ParsedImport {
  /** Cards ready for importDeck(); dedupe/SRS defaults happen downstream. */
  payload: ImportCardPayload[];
  /** Deck name derived from the file name (extension stripped). */
  name: string;
  /**
   * Field/header labels when the source exposes them (CSV header row, Anki model
   * field names). Fed to inferLang so a foreign header (Palabra/Traducción) sets
   * the language even when the deck name carries no hint (H6). Absent ⇒ no header.
   */
  fieldNames?: string[];
}

const CEFR_LEVELS: readonly CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const WORD_TYPES: readonly WordType[] = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'phrase',
  'preposition',
  'pronoun',
  'conjunction',
];

/* ----------------------------------------------------------- file helpers */

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Last path segment, tolerating both / and \ separators. */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Lowercased extension without the dot, or '' when there is none. */
function extensionOf(fileName: string): string {
  const base = basename(fileName).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

/**
 * File name minus directory and extension → a friendly deck name.
 *
 * Android's Storage Access Framework returns opaque content-URI document ids
 * (e.g. "document:30", "msf:1000000123") rather than a display name, so
 * `File.name` can be junk. ':' is not a legal filename character on Android/
 * Windows, so any colon — or a bare numeric id — means we did NOT get a real
 * name; fall back to a clean default instead of titling the deck "document:30".
 * Real filenames (incl. non-Latin scripts) pass through untouched.
 */
export function deckNameFromFile(fileName: string): string {
  const base = basename(fileName ?? '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/\s+/g, ' ').trim();
  const looksLikeSafId = cleaned.includes(':') || /^\d+$/.test(cleaned);
  if (cleaned.length === 0 || looksLikeSafId) return 'Imported deck';
  return cleaned;
}

/* ----------------------------------------------------------- kind sniffing */

export function detectImportKind(fileName: string, sampleText?: string): ImportKind {
  const ext = extensionOf(fileName ?? '');
  // Text-ish extensions we can actually parse as delimited text.
  if (ext === 'csv' || ext === 'tsv' || ext === 'tab' || ext === 'txt' || ext === 'text') {
    return 'csv';
  }
  // Anki packages: a ZIP of a SQLite collection — recognised, not parseable here.
  if (ext === 'apkg' || ext === 'colpkg') return 'apkg';
  // Backups (.json) belong to the Backup tab, not this picker.
  if (ext === 'json') return 'unknown';
  // Inconclusive extension ('', 'zip', renamed/temp files) → look at the bytes.
  return sniffKind(sampleText);
}

function sniffKind(sampleText?: string): ImportKind {
  if (!sampleText) return 'unknown';
  const s = stripBom(sampleText);
  if (s.length === 0) return 'unknown';
  // ZIP local/central/spanned magic — an .apkg is a ZIP.
  if (s.startsWith('PK\x03\x04') || s.startsWith('PK\x05\x06') || s.startsWith('PK\x07\x08')) {
    return 'apkg';
  }
  // A bare/decompressed Anki collection.
  if (s.includes('SQLite format 3') || s.includes('collection.anki2')) return 'apkg';
  // Binary we don't recognise — refuse rather than feed garbage to the CSV parser.
  if (looksBinary(s)) return 'unknown';
  return 'csv';
}

function looksBinary(s: string): boolean {
  const span = Math.min(s.length, 2048);
  if (span === 0) return false;
  let control = 0;
  for (let i = 0; i < span; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) return true; // NUL ⇒ definitely binary
    // control chars other than tab (9), LF (10), CR (13)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++;
  }
  return control / span > 0.05;
}

/* ------------------------------------------------------- delimiter + tokens */

const DELIMITERS = [',', ';', '\t'] as const;
type Delimiter = (typeof DELIMITERS)[number];

/**
 * Tie-break preference when two delimiters split the sample equally well. A
 * comma occurs freely *inside* field content (synonym lists — "to go, to walk",
 * decimal/thousand groups), whereas a tab or semicolon almost never does, so
 * the rarer-in-content delimiter is the likelier structural one. Higher wins.
 */
const DELIM_PRIORITY: Record<Delimiter, number> = { '\t': 3, ';': 2, ',': 1 };

/** Up to `n` leading non-blank lines, rejoined — the delimiter-sniffing sample. */
function sampleLines(text: string, n: number): string {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    out.push(line);
    if (out.length >= n) break;
  }
  return out.join('\n');
}

/** Most frequent value in a non-empty list (ties: first seen). */
function modeOf(nums: number[]): number {
  const freq = new Map<number, number>();
  let mode = nums[0] ?? 0;
  let modeCount = 0;
  for (const v of nums) {
    const c = (freq.get(v) ?? 0) + 1;
    freq.set(v, c);
    if (c > modeCount) {
      modeCount = c;
      mode = v;
    }
  }
  return mode;
}

/**
 * Pick the delimiter by running the REAL tokeniser (splitCsvRows) over the first
 * several content lines and ranking each candidate by how UNIFORMLY it splits —
 * a real table has a consistent column count. Sniffing one line misreads a
 * single-column header or a comma hiding inside one quoted cell; sampling many
 * lines and sharing splitCsvRows means the sniffer and the parser can never
 * disagree about quoting.
 *
 * Column COUNT is deliberately NOT a reward: a TSV/semicolon table whose value
 * column holds a comma-separated synonym list ("gehen\tto go, to walk") makes a
 * comma split into MORE — but equally consistent — columns than the real tab. So
 * we rank on consistency and break ties toward the delimiter that is rarest
 * inside field content (tab > semicolon > comma; H5). A file no candidate splits
 * (single column) falls back to comma.
 */
export function detectDelimiter(text: string): Delimiter {
  const sample = sampleLines(text, 10);
  if (sample === '') return ',';
  let best: Delimiter = ',';
  let bestConsistency = -1;
  let bestPriority = -1;
  for (const d of DELIMITERS) {
    const rows = splitCsvRows(sample, d).filter((r) => r.some((cell) => cell.trim() !== ''));
    if (rows.length === 0) continue;
    const widths = rows.map((r) => r.length);
    if (Math.max(...widths) < 2) continue; // this delimiter splits nothing → not it
    const modal = modeOf(widths);
    const consistency = widths.filter((w) => w === modal).length / widths.length;
    const priority = DELIM_PRIORITY[d];
    // Most consistent table wins; equal consistency → the rarer-in-content
    // delimiter, so a comma inside one field can't out-vote a real tab/semicolon.
    if (consistency > bestConsistency || (consistency === bestConsistency && priority > bestPriority)) {
      bestConsistency = consistency;
      bestPriority = priority;
      best = d;
    }
  }
  return best;
}

/**
 * RFC-4180-style tokeniser. Handles quoted fields with embedded delimiters,
 * embedded newlines, and escaped "" quotes; both LF and CRLF (and lone CR)
 * row terminators. Returns rows of raw (untrimmed) cells. Blank-line filtering
 * and BOM stripping are the caller's job.
 */
export function splitCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true; // a quote only "opens" at the very start of a field
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch; // delimiters / newlines are literal inside quotes
      i++;
      continue;
    }

    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStart = true;
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStart = true;
      i++;
      continue;
    }
    if (ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStart = true;
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += ch;
    fieldStart = false;
    i++;
  }

  // Flush the final field/row (handles files with no trailing newline).
  row.push(field);
  rows.push(row);
  return rows;
}

/* --------------------------------------------------------- value coercion */

/** ASCII-fold the common Latin diacritics without relying on String.normalize. */
function foldAscii(s: string): string {
  return s
    .replace(/[àáâãäåā]/g, 'a')
    .replace(/[èéêëē]/g, 'e')
    .replace(/[ìíîïī]/g, 'i')
    .replace(/[òóôõöō]/g, 'o')
    .replace(/[ùúûüū]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/ç/g, 'c')
    .replace(/ß/g, 'ss')
    .replace(/ý/g, 'y');
}

/** First run of latin letters in a cell, ascii-folded and lowercased. */
function leadingToken(cell: string): string {
  const match = foldAscii((cell ?? '').trim().toLowerCase()).match(/^[a-z]+/);
  return match ? match[0] : '';
}

const HEADER_FIRST_CELLS = new Set<string>([
  'word',
  'words',
  'front',
  'term',
  'terms',
  'vocab',
  'vocabulary',
  'headword',
  'lemma',
  'wort',
  // Foreign word-column labels (folded): es/fr/it/de. Recognising these lets a
  // foreign header be both skipped and used as a language hint (H6/L20).
  'palabra',
  'mot',
  'parola',
  'begriff',
  'terme',
  'termino',
  'vorderseite',
]);

/** Header labels expected in a SECOND column — the corroborating signal. */
const HEADER_OTHER_CELLS = new Set<string>([
  'translation',
  'translations',
  'meaning',
  'meanings',
  'definition',
  'back',
  'answer',
  'gloss',
  'sense',
  'example',
  'examples',
  'sentence',
  'usage',
  'level',
  'cefr',
  'type',
  'pos',
  'pronunciation',
  'ipa',
  'reading',
  'tag',
  'tags',
  'ubersetzung',
  'bedeutung',
  'beispiel',
  'wort',
  // Foreign translation/example/answer labels (folded): es/fr/it.
  'traduccion',
  'traduction',
  'traduzione',
  'significado',
  'significato',
  'signification',
  'ejemplo',
  'exemple',
  'esempio',
  'respuesta',
  'reponse',
  'antwort',
  'oracion',
  'ruckseite',
]);

/**
 * A row is the header iff its FIRST cell reads like "Word"/"Front"/"Term" AND at
 * least one OTHER cell reads like a known header label. Requiring that second
 * signal stops a genuine first data word that merely looks header-like — German
 * "Wort" (= "word"), "Term", "Vocab" — from being silently dropped as a header
 * (L20). A single-column file therefore never loses its first row.
 */
function isHeaderRow(row: string[]): boolean {
  if (!HEADER_FIRST_CELLS.has(leadingToken(row[0] ?? ''))) return false;
  return row.slice(1).some((cell) => HEADER_OTHER_CELLS.has(leadingToken(cell)));
}

/**
 * Parse free text to a CEFR level, tolerant of "Level B2" etc. Returns null
 * when the input is absent or unrecognised, so a missing column reads as "no
 * level" rather than a fabricated A1.
 */
export function clampLevel(raw: string | undefined): CefrLevel | null {
  if (!raw) return null;
  const up = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const lv of CEFR_LEVELS) {
    if (up === lv) return lv;
  }
  const m = up.match(/[ABC][12]/);
  if (m && (CEFR_LEVELS as readonly string[]).includes(m[0])) return m[0] as CefrLevel;
  return null;
}

const TYPE_ALIASES: Record<string, WordType> = {
  // noun
  n: 'noun',
  nn: 'noun',
  noun: 'noun',
  nouns: 'noun',
  nomen: 'noun',
  substantiv: 'noun',
  substantive: 'noun',
  sustantivo: 'noun',
  nom: 'noun',
  // verb
  v: 'verb',
  vb: 'verb',
  verb: 'verb',
  verbs: 'verb',
  verbo: 'verb',
  verbe: 'verb',
  // adjective
  adj: 'adjective',
  adjective: 'adjective',
  adjectives: 'adjective',
  adjektiv: 'adjective',
  adjetivo: 'adjective',
  adjectif: 'adjective',
  // adverb
  adv: 'adverb',
  adverb: 'adverb',
  adverbs: 'adverb',
  adverbio: 'adverb',
  adverbe: 'adverb',
  // phrase
  phr: 'phrase',
  phrase: 'phrase',
  phrases: 'phrase',
  idiom: 'phrase',
  expression: 'phrase',
  sentence: 'phrase',
  satz: 'phrase',
  frase: 'phrase',
  redewendung: 'phrase',
  // preposition
  prep: 'preposition',
  preposition: 'preposition',
  praposition: 'preposition',
  preposicion: 'preposition',
  // pronoun
  pron: 'pronoun',
  pronoun: 'pronoun',
  pronouns: 'pronoun',
  pronomen: 'pronoun',
  pronombre: 'pronoun',
  // conjunction
  conj: 'conjunction',
  conjunction: 'conjunction',
  konjunktion: 'conjunction',
  conjuncion: 'conjunction',
};

/**
 * Map free-text part-of-speech to a WordType. Returns null when the input is
 * absent or unrecognised, so a missing column reads as "no type" rather than a
 * fabricated noun.
 */
function mapType(raw: string | undefined): WordType | null {
  if (!raw) return null;
  const token = foldAscii(raw.toLowerCase()).replace(/[^a-z]/g, '');
  if (!token) return null;
  const exact = TYPE_ALIASES[token];
  if (exact) return exact;
  if (token.length >= 3) {
    for (const wt of WORD_TYPES) {
      if (token.startsWith(wt) || wt.startsWith(token)) return wt;
    }
  }
  return null;
}

/** Split tag text on | ; or , — folding any spillover columns back in first. */
function parseTags(extraCells: string[]): string[] | undefined {
  const joined = extraCells.join(',');
  const parts = joined
    .split(/[|;,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (parts.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of parts) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/* --------------------------------------------------------------- the parser */

export function parseImportCsv(text: string, fileName: string): ParsedImport {
  const name = deckNameFromFile(fileName);
  const clean = stripBom(text ?? '');
  if (clean.trim() === '') return { payload: [], name };

  const delimiter = detectDelimiter(clean);
  const rawRows = splitCsvRows(clean, delimiter);

  // Drop fully-blank rows (blank lines + the trailing-newline artifact).
  const rows = rawRows.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (rows.length === 0) return { payload: [], name };

  // Skip the first row only if it reads like a header.
  const start = isHeaderRow(rows[0]) ? 1 : 0;
  // A real header row doubles as a language hint (Palabra/Traducción → Spanish).
  const fieldNames =
    start === 1 ? rows[0].map((cell) => cell.trim()).filter((cell) => cell !== '') : undefined;

  const payload: ImportCardPayload[] = [];
  for (let r = start; r < rows.length; r++) {
    const cols = rows[r];
    const word = (cols[0] ?? '').trim();
    if (word === '') continue; // a card must have a front

    const tr = (cols[1] ?? '').trim();
    const ex = (cols[2] ?? '').trim();
    const ipa = (cols[5] ?? '').trim();
    const tags = parseTags(cols.slice(6));
    const { article, base } = splitArticle(word);

    const card: ImportCardPayload = {
      word,
      tr,
      level: clampLevel(cols[3]),
      type: mapType(cols[4]),
      article,
      base,
    };
    if (ex) card.ex = ex;
    if (ipa) card.ipa = ipa;
    if (tags) card.tags = tags;

    payload.push(card);
  }

  return { payload, name, fieldNames };
}
