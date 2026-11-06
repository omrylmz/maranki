/**
 * The PURE parts of the import screen (src/app/import.tsx, spec §5.7, §5.9).
 * No React, no I/O, no Date.now / Math.random: deterministic and unit-tested.
 *
 *   1. Files: `detectImportKind` / `sniffFileBytes` (is a picked file an
 *      Anki package or text?) and `deckNameFromFile`.
 *   2. CSV text: `detectDelimiter` and the RFC-4180 tokeniser
 *      `splitCsvRows` (import/csvRead.ts reads CSV with them), and
 *      `parseImportCsv`: TODAY's positional CSV mapping (0 Front · 1 Back ·
 *      2 Example · 3 Notes · 4+ Tags). The screen no longer uses it — the
 *      lossless reader is import/csvRead.ts — but it is kept as the reference
 *      that csvRead.test.ts compares against ("same cards as today").
 *   3. The wizard (spec §5.9): who sees which block, the starting choices,
 *      the field-role edits of the Fields stage, every Preview line (counted
 *      by the planner in `plan.summary`), the Done copy (from the
 *      `ImportResult` of `applyImport`), the Sections tree, and the loop that
 *      writes the images after the save (`writeImportImages`).
 *
 * Import cycles: import/plan.ts and import/csvRead.ts import THIS file
 * (`deckNameFromFile`, the CSV tokeniser). So this file never imports their
 * runtime code, only their types (`import type` is removed when the code is
 * built, so it makes no cycle). Helpers that need the planner itself live in
 * plan.ts (`startingTypes`, `buildNoteType`).
 *
 * Hermes-safe (no String.prototype.normalize / replaceAll / lookbehind).
 */
import type { CollectionSection, PlanCtx, TypeStart } from './import/plan';
import { archiveNameIn, freeImageName, isImageName, isSafeMediaName, mediaFolder, sameBytes } from './import/mediaPlan';
import { langLabel } from './lang/bcp47';
import { fieldFacetSpecs } from './libraryIndex';
import type {
  AnkiCollection,
  Deck,
  FieldDef,
  FieldRole,
  Id,
  ImportChoices,
  ImportMediaFolder,
  ImportResult,
  ImportSummary,
  NoteType,
  SourceKind,
  SrsSettings,
} from './model';
import { detectOrdinal } from './ordinal';
import { fieldDisplayLabel } from './render';
import { facetRule, modelTemplates } from './roles';
import { foldText, plural } from './text';

export type ImportKind = 'csv' | 'apkg' | 'unknown';

/** One card of today's positional CSV mapping (`parseImportCsv`). */
export interface CsvCard {
  front: string;
  back: string;
  example?: string;
  notes?: string;
  tags?: string[];
}

/** What `parseImportCsv` returns: today's cards and a deck name from the file name. */
export interface ParsedImport {
  /** One card per row with a front. */
  payload: CsvCard[];
  /** Deck name derived from the file name (extension stripped). */
  name: string;
}

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
  // Anki packages: a ZIP of a SQLite collection (read by import/apkgRead.ts).
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

/** The 4-byte signatures a ZIP file starts with: a local file, an empty archive, a spanned archive. */
const ZIP_SIGNATURES: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // 'PK\x03\x04'
  [0x50, 0x4b, 0x05, 0x06], // 'PK\x05\x06'
  [0x50, 0x4b, 0x07, 0x08], // 'PK\x07\x08'
];

/** The 16-byte header of every SQLite database file: 'SQLite format 3' and a NUL byte. */
const SQLITE_HEADER: readonly number[] = Array.from('SQLite format 3\0', (ch) => ch.charCodeAt(0));

/** True when `bytes` starts with exactly the byte values of `head`. */
function startsWithBytes(bytes: Uint8Array, head: readonly number[]): boolean {
  if (bytes.length < head.length) return false;
  for (let i = 0; i < head.length; i++) if (bytes[i] !== head[i]) return false;
  return true;
}

/**
 * Is a picked file an Anki package or text? Read from the raw bytes ONCE.
 * Android's file picker often gives an opaque name with no `.apkg` ending,
 * so the bytes decide first, by the REAL file signatures: a ZIP (an .apkg is
 * a ZIP) starts with 'PK' and two signature bytes, a bare collection database
 * with the full 16-byte SQLite header. The two letters 'PK' alone are not
 * enough: a German word list can start with "PKW,car" (W3-5 hardening). Then
 * the name: an `.apkg` / `.colpkg` ending is a package (a broken one gets the
 * honest "Could not read that .apkg" message). Everything else is text (CSV,
 * TSV, an Anki text export); the caller checks that with `detectImportKind`.
 *
 *   sniffFileBytes(Uint8Array.of(0x50, 0x4b, 3, 4), 'document:30') → 'apkg'
 *   sniffFileBytes(bytesOf('PKW,car'), 'german.csv')                → 'text'
 *   sniffFileBytes(bytesOf('Word,Meaning'), 'words.csv')            → 'text'
 */
export function sniffFileBytes(bytes: Uint8Array, fileName: string): 'apkg' | 'text' {
  const isZip = ZIP_SIGNATURES.some((signature) => startsWithBytes(bytes, signature));
  const isSqlite = startsWithBytes(bytes, SQLITE_HEADER);
  if (isZip || isSqlite) return 'apkg';
  return /\.(apkg|colpkg)$/i.test(fileName ?? '') ? 'apkg' : 'text';
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
    // Spaces after the delimiter, then a quote: a hand-written `Haus, "house,
    // home"`. The quote still opens the value (the spaces are not part of
    // it), so its comma does not split it. Spaces before anything else stay
    // in the cell (the readers trim it).
    if (fieldStart && (ch === ' ' || ch === '\t') && ch !== delimiter) {
      let j = i + 1;
      while (j < n && (text[j] === ' ' || text[j] === '\t') && text[j] !== delimiter) j++;
      if (text[j] === '"') {
        i = j;
        continue;
      }
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

/**
 * First run of latin letters in a cell, lower-cased and accent-folded with the
 * shared `foldText` (text.ts; it was a local `foldAscii` here before). So
 * "Übersetzung" reads as "ubersetzung", also when the file stores the accent
 * as a separate mark (decomposed text).
 */
function leadingToken(cell: string): string {
  const match = foldText((cell ?? '').trim()).match(/^[a-z]+/);
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
  // Foreign front-column labels (folded): es/fr/it/de. Recognising these lets a
  // foreign header row be skipped (invisible import robustness).
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
  'note',
  'notes',
  'tag',
  'tags',
  'ubersetzung',
  'bedeutung',
  'beispiel',
  'wort',
  // Foreign back/example/answer labels (folded): es/fr/it.
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

/* -------------------------------------------- today's positional CSV mapping */

/**
 * TODAY's CSV mapping (before wave 3): one card per row with a front, by
 * position (0 Front · 1 Back · 2 Example · 3 Notes · 4+ Tags), a header row
 * dropped by `isHeaderRow`. Kept as the REFERENCE for the lossless reader:
 * csvRead.test.ts checks that import/csvRead.ts + the planner give the same
 * cards for the same files. The import screen reads CSV with csvRead.ts.
 */
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

  const payload: CsvCard[] = [];
  for (let r = start; r < rows.length; r++) {
    const cols = rows[r];
    const front = (cols[0] ?? '').trim();
    if (front === '') continue; // a card must have a front

    const back = (cols[1] ?? '').trim();
    const example = (cols[2] ?? '').trim();
    const notes = (cols[3] ?? '').trim();
    const tags = parseTags(cols.slice(4));

    const card: CsvCard = { front, back };
    if (example) card.example = example;
    if (notes) card.notes = notes;
    if (tags) card.tags = tags;

    payload.push(card);
  }

  return { payload, name };
}

/* ======================================================= the wizard (§5.9) */

/** "How should new cards start?" is shown only above this many new cards (spec §5.9). */
export const NEW_CARDS_ASK_ABOVE = 200;
/** Above this many new cards, "Let me choose what to learn" is the default (spec §5.9, decision D3). */
export const CHOOSE_DEFAULT_ABOVE = 1000;

/* ---------------------------------------------------------------- origin */

/** Where the data of an import comes from. */
export type ImportSource =
  | { kind: 'file'; fileName: string; isCsv: boolean }
  | { kind: 'ankiweb'; id: string };

/**
 * The planner's `origin` for a source: the new deck's `source` and
 * `sourceKey`, and each note's `source.kind` / `ref`. The sourceKey makes a
 * second import of the same file (or AnkiWeb deck) find its deck again
 * (`defaultTarget`).
 *
 *   importOrigin({ kind: 'ankiweb', id: '1104981491' })
 *   → { kind: 'ankiweb', ref: '1104981491', sourceKey: 'ankiweb:1104981491' }
 *
 * `namelessKey`: the key of a file the picker gave NO name for
 * (importApkg.ts `namelessSourceKey`, 'file:German.apkg#1x2b9k'). Then the
 * file name is made up (the .apkg's root deck), and each item's `ref` is
 * the key without 'file:' — 'German.apkg#1x2b9k', not 'German.apkg'.
 *
 * WHY (wave 5g, review of E8): the deck page's header names the files the
 * deck's items came from (deckPageLogic.ts `otherSourceFiles`). A ref
 * 'German.apkg' looks like a real file name, so a nameless pick of
 * German_Vocabulary_v4.apkg into the deck of German_Vocabulary_v1.apkg said
 * "Imported from German_Vocabulary_v1.apkg and German.apkg" — a file that
 * does not exist. A ref that ends in '#<hash>' ends in no file extension,
 * so it is never read as a file name (deckPageLogic.ts `realFileName`).
 *
 *   importOrigin({ kind: 'file', fileName: 'German.apkg', isCsv: false }, 'file:German.apkg#1x2b9k')
 *   → { kind: 'apkg', ref: 'German.apkg#1x2b9k', sourceKey: 'file:German.apkg#1x2b9k' }
 */
export function importOrigin(source: ImportSource, namelessKey?: string): NonNullable<PlanCtx['origin']> {
  if (source.kind === 'ankiweb') return { kind: 'ankiweb', ref: source.id, sourceKey: `ankiweb:${source.id}` };
  const kind: SourceKind = source.isCsv ? 'csv' : 'apkg';
  if (namelessKey) return { kind, ref: namelessKey.replace(/^file:/, ''), sourceKey: namelessKey };
  return { kind, ref: source.fileName, sourceKey: `file:${source.fileName}` };
}

/**
 * The planner context of the import screen. Ids come from a counter after a
 * `seed` (the screen makes a new seed in an event handler for every plan it
 * applies, so two imports never share an id); filter groups and level order
 * come from the library index and ordinal.ts (spec §4.3).
 */
export function importPlanCtx(input: {
  now: number;
  seed: string;
  srs: Pick<SrsSettings, 'startingEase' | 'maxIntervalDays'>;
  origin: NonNullable<PlanCtx['origin']>;
  /** The deck folders on the phone (`importMediaNamer`): an image whose name is taken gets its own. */
  mediaName?: PlanCtx['mediaName'];
}): PlanCtx {
  let n = 0;
  return {
    now: input.now,
    newId: () => `imp-${input.seed}-${(n += 1).toString(36)}`,
    srs: { startingEase: input.srs.startingEase, maxIntervalDays: input.srs.maxIntervalDays },
    fieldFacetSpecs,
    detectOrdinal,
    origin: input.origin,
    ...(input.mediaName ? { mediaName: input.mediaName } : {}),
  };
}

/** Reads what a deck folder ('media/<deckId>') holds (importApkg.ts `expoMediaDisk` on the phone). */
export interface MediaFolderReader {
  /** The size of the file, or null when the folder has no such file. */
  fileSize(folder: string, name: string): number | null;
  /** The file's bytes, or null when it cannot be read. */
  readFile(folder: string, name: string): Uint8Array | null;
}

/**
 * The planner's `ctx.mediaName` for the import screen (spec §5.8): the name
 * the archive image `name` gets in the folder of deck `deckId`. The same name
 * when the folder has no file of that name, or the very same picture (a
 * re-import); else a name of its own from its bytes ("image1-9c1f0a2b.jpg",
 * mediaPlan.ts `freeImageName`), so the cards already in the deck keep their
 * picture. An image the archive has no bytes for keeps its name (nothing is
 * written for it). Answers are kept (the folders do not change while the
 * import screen plans), so planning again reads nothing twice.
 *
 *   const name = importMediaNamer(collection.mediaBytes, expoMediaDisk());
 *   name('deck-1', 'image1.jpg') → 'image1.jpg' or 'image1-9c1f0a2b.jpg'
 */
export function importMediaNamer(
  bytesOf: ((name: string) => Uint8Array | null) | undefined,
  disk: MediaFolderReader,
): (deckId: Id, name: string) => string {
  const known = new Map<string, string>();
  return (deckId, name) => {
    const key = JSON.stringify([deckId, name]);
    const kept = known.get(key);
    if (kept !== undefined) return kept;
    let out = name;
    try {
      const folder = mediaFolder(deckId);
      // Most names are free (a new deck has no folder): no bytes are read then.
      const bytes = isSafeMediaName(deckId) && disk.fileSize(folder, name) !== null ? (bytesOf?.(name) ?? null) : null;
      if (bytes) {
        out = freeImageName(name, bytes, [
          { size: (n) => disk.fileSize(folder, n), read: (n) => disk.readFile(folder, n) },
        ]);
      }
    } catch {
      out = name;
    }
    known.set(key, out);
    return out;
  };
}

/* ---------------------------------------------------------------- choices */

/**
 * Where the import goes when the screen opens:
 *   1. the deck the caller named (`/import?deckId=`), if it exists;
 *   2. else the deck that came from the SAME file or AnkiWeb deck before
 *      (same `sourceKey`): a re-import updates it ("Already in this deck");
 *   3. else a new deck with the suggested name.
 */
export function defaultTarget(
  decks: readonly Pick<Deck, 'id' | 'sourceKey'>[],
  origin: Pick<NonNullable<PlanCtx['origin']>, 'sourceKey'>,
  opts: { deckId?: string | null; name: string; icon: string },
): ImportChoices['target'] {
  if (opts.deckId && decks.some((d) => d.id === opts.deckId)) return { kind: 'existing', deckId: opts.deckId };
  const same = origin.sourceKey ? decks.find((d) => d.sourceKey === origin.sourceKey) : undefined;
  if (same) return { kind: 'existing', deckId: same.id };
  return { kind: 'new', name: opts.name, icon: opts.icon };
}

/**
 * What the learner sets on the Preview, besides the sections and the fields.
 * The screen keeps the new deck's name and the existing deck apart, so
 * switching "Import into" back and forth loses neither.
 */
export interface ImportPrefs {
  targetKind: 'new' | 'existing';
  /** The new deck's name ("Deck name [ German ]"). */
  deckName: string;
  /** The new deck's icon (an emoji). */
  deckIcon: string;
  /** The existing deck to import into, or null when there is none. */
  existingDeckId: Id | null;
  progress: ImportChoices['progress'];
  arrival: ImportChoices['arrival'];
  placement?: ImportChoices['placement'];
  elsewhere: ImportChoices['elsewhere'];
  images: boolean;
  skipOverlap: boolean;
}

/**
 * The Preview's starting preferences: the default target (see
 * `defaultTarget`), Anki progress kept, new cards queued, "Update them where
 * they are", images on. `firstPlanChanges` adjusts images and new cards after
 * the first plan.
 */
export function startingPrefs(
  target: ImportChoices['target'],
  opts: { name: string; icon: string; decks: readonly Pick<Deck, 'id'>[] },
): ImportPrefs {
  return {
    targetKind: target.kind,
    deckName: target.kind === 'new' ? target.name : opts.name,
    deckIcon: target.kind === 'new' ? target.icon : opts.icon,
    existingDeckId: target.kind === 'existing' ? target.deckId : (opts.decks[0]?.id ?? null),
    progress: 'keep',
    arrival: 'queued',
    elsewhere: 'update',
    images: true,
    skipOverlap: false,
  };
}

/** The ImportChoices target of the preferences ("Existing deck" without a deck → a new deck). */
export function prefsTarget(p: ImportPrefs): ImportChoices['target'] {
  if (p.targetKind === 'existing' && p.existingDeckId) return { kind: 'existing', deckId: p.existingDeckId };
  return { kind: 'new', name: p.deckName, icon: p.deckIcon };
}

/** Changing only these preferences never changes the plan's numbers, so the Preview does not plan again. */
export function prefsNeedReplan(patch: Partial<ImportPrefs>): boolean {
  return Object.keys(patch).some((key) => key !== 'deckName' && key !== 'deckIcon');
}

/** `record[key]` only when it is the record's own key (keys from a file can be "constructor"). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * The Fields stage's choices as ImportChoices.types (source model id → roles
 * and directions). The record has NO prototype, because the keys are model
 * ids from the file ("__proto__" is an ordinary key then, H2). An Anki model
 * also gets its directions worked out by roles.ts with the chosen roles
 * (`modelTemplates`: badges and hidden fields off the sides, a listening
 * question asks the field it reads aloud), so the planner stores exactly
 * those. A CSV gets no templates: the planner builds them from the columns
 * chosen as Front and Back.
 */
export function choiceTypes(
  collection: AnkiCollection,
  edits: readonly Pick<TypeStart, 'mid' | 'fields' | 'ords'>[],
): ImportChoices['types'] {
  const out = Object.create(null) as ImportChoices['types'];
  for (const edit of edits) {
    const model = own(collection.models, edit.mid);
    if (!model) continue;
    const fields = edit.fields.map((f) => ({ ...f }));
    const entry: ImportChoices['types'][string] = { fields, ords: [...edit.ords] };
    if (collection.csv === undefined && fields.length === model.flds.length) {
      entry.templates = modelTemplates(model, fields);
    }
    out[edit.mid] = entry;
  }
  return out;
}

/**
 * The default for "How should new cards start?" (spec §5.9, D3): "Let me
 * choose what to learn" above 1,000 new cards, else "Add all to my study
 * queue". Without the triage screen (`triageReady` false, wave 3) it is
 * always "Add all": a Not started card could not be chosen anywhere yet.
 */
export function defaultArrival(newCards: number, triageReady: boolean): ImportChoices['arrival'] {
  return triageReady && newCards > CHOOSE_DEFAULT_ABOVE ? 'notStarted' : 'queued';
}

/** True when the Preview shows "How should new cards start?" (more than 200 new cards, and triage exists). */
export function showNewCardsBlock(summary: Pick<ImportSummary, 'newCards'>, triageReady: boolean): boolean {
  return triageReady && summary.newCards > NEW_CARDS_ASK_ABOVE;
}

/** True when the Preview shows "Where do you start?" (an ordinal filter group or section level, and triage exists). */
export function showPlacementBlock(summary: Pick<ImportSummary, 'placementGroups'>, triageReady: boolean): boolean {
  return triageReady && summary.placementGroups.length > 0;
}

/**
 * The changes to make after the FIRST plan of a file, because they depend on
 * its numbers: images above 50 MB are not imported until the learner says
 * yes ("Import 180 MB of images?"), and the new-card default of D3.
 * {} = keep the choices as they are.
 */
export function firstPlanChanges(
  summary: Pick<ImportSummary, 'imagesAskFirst' | 'newCards'>,
  triageReady: boolean,
): Partial<Pick<ImportChoices, 'images' | 'arrival'>> {
  const out: Partial<Pick<ImportChoices, 'images' | 'arrival'>> = {};
  if (summary.imagesAskFirst) out.images = false;
  if (defaultArrival(summary.newCards, triageReady) === 'notStarted') out.arrival = 'notStarted';
  return out;
}

/* ---------------------------------------------------- field roles (Fields stage) */

/** The default filter setting of a role (as roles.ts): free-text roles are never filter groups. */
export function facetForRole(role: FieldRole): FieldDef['facet'] {
  return role === 'badge' || role === 'detail' || role === 'hidden' ? 'auto' : 'off';
}

/** Roles that are shown on the answer side as an extra row (not the headline, not an example). */
const BACK_ROW_ROLES: readonly FieldRole[] = ['detail', 'pronunciation', 'exampleMeaning'];

/** A field with a new role and that role's default filter setting. `multiSep` only stays on a badge. */
function withRole(f: FieldDef, role: FieldRole): FieldDef {
  const out: FieldDef = { ...f, role, facet: facetForRole(role) };
  if (role !== 'badge') delete out.multiSep;
  return out;
}

/** Field `i` gets `role`; the field that had it before gets `partner` when `i` had `partner`, else 'detail'. */
function swapRole(fields: readonly FieldDef[], i: number, role: FieldRole, partner: FieldRole): FieldDef[] {
  if (i < 0 || i >= fields.length || fields[i].role === role) return [...fields];
  const swap = fields[i].role === partner;
  return fields.map((f, j) => {
    if (j === i) return withRole(f, role);
    if (f.role === role) return withRole(f, swap ? partner : 'detail');
    return f;
  });
}

/**
 * "Front [Word ▾]": field `i` becomes the Front (role 'term', the big
 * headline). The old Front becomes a back row; when `i` was the Back, the two
 * swap.
 *
 *   setFrontField([Word=term, Meaning=meaning], 1) → [Word=meaning, Meaning=term]
 */
export function setFrontField(fields: readonly FieldDef[], i: number): FieldDef[] {
  return swapRole(fields, i, 'term', 'meaning');
}

/** "Back [Translation ▾]": field `i` becomes the Back (role 'meaning'); see setFrontField. */
export function setBackField(fields: readonly FieldDef[], i: number): FieldDef[] {
  return swapRole(fields, i, 'meaning', 'term');
}

/** "Examples … [Change]": field `i` is an example or a back row. The Front and the Back never change here. */
export function setExampleField(fields: readonly FieldDef[], i: number, on: boolean): FieldDef[] {
  const f = fields[i];
  if (!f || f.role === 'term' || f.role === 'meaning') return [...fields];
  if (on === (f.role === 'example')) return [...fields];
  return fields.map((g, j) => (j === i ? withRole(g, on ? 'example' : 'detail') : g));
}

/**
 * "Shown on back ☑ Grammar": field `i` is shown as a back row, or hidden
 * (kept and searchable, never shown). Its filter setting does not change.
 * Shown again, it gets back its suggested role (`suggested`, e.g.
 * 'pronunciation') when that is a back-row role, else 'detail'.
 */
export function setShownOnBack(
  fields: readonly FieldDef[],
  i: number,
  shown: boolean,
  suggested?: FieldRole,
): FieldDef[] {
  const f = fields[i];
  if (!f) return [...fields];
  if (!shown) return fields.map((g, j) => (j === i ? { ...g, role: 'hidden' as const } : g));
  if (f.role !== 'hidden') return [...fields];
  const role: FieldRole = suggested && BACK_ROW_ROLES.includes(suggested) ? suggested : 'detail';
  return fields.map((g, j) => (j === i ? { ...g, role } : g));
}

/**
 * "Filters ☑ Level (5 values)": field `i` is a filter group, or not. On →
 * 'auto' when the field passes the data rule (spec §4.3), else 'on' (forced).
 */
export function setFilterField(fields: readonly FieldDef[], i: number, on: boolean, passesRule: boolean): FieldDef[] {
  const facet: FieldDef['facet'] = on ? (passesRule ? 'auto' : 'on') : 'off';
  return fields.map((g, j) => (j === i ? { ...g, facet } : g));
}

/** "Read aloud Front: [German ▾]": the read-aloud language of field `i`; null = "Device voice". */
export function setFieldLang(fields: readonly FieldDef[], i: number, lang: string | null): FieldDef[] {
  return fields.map((g, j) => {
    if (j !== i) return g;
    const out: FieldDef = { ...g };
    if (lang) out.lang = lang;
    else delete out.lang;
    return out;
  });
}

/** True when a field is a filter group on the Fields stage (its filter setting is not 'off'). */
export function isFilterOn(f: Pick<FieldDef, 'facet'>): boolean {
  return f.facet !== 'off';
}

/**
 * The fields the Fields stage offers as filters: badges, fields forced on,
 * and the other non-free-text fields whose values pass the data rule (spec §4.3:
 * few short repeating values in most notes). Read from the notes of card type
 * `mid` once (the values do not change on this screen). `passes` says whether
 * the field passes the data rule; turning a filter on gives it 'auto' then,
 * else 'on' (see setFilterField).
 *
 *   filterCandidates(germanVocabulary, mid, fields) → [{ index: 6, passes: true }]   (Level)
 */
export function filterCandidates(
  collection: AnkiCollection,
  mid: string,
  fields: readonly FieldDef[],
): { index: number; passes: boolean }[] {
  const rows = collection.notes.filter((n) => n.mid === mid).map((n) => n.flds);
  const out: { index: number; passes: boolean }[] = [];
  fields.forEach((f, i) => {
    const free = f.role === 'term' || f.role === 'meaning' || f.role === 'example' || f.role === 'exampleMeaning';
    if (free && f.facet !== 'on') return;
    const passes = facetRule(rows.map((r) => r[i] ?? '')).pass;
    if (passes || f.role === 'badge' || f.facet === 'on') out.push({ index: i, passes });
  });
  return out;
}

/** 'de-DE' → 'German' (the region is left out: a direction name is short). */
function languageName(tag: string | undefined): string | null {
  if (!tag) return null;
  const label = langLabel(tag);
  return label ? label.replace(/\s*\(.*\)$/, '') : null;
}

/**
 * The name of a direction in the Fields stage: "German → English" when the
 * question and the answer headline have two different read-aloud languages,
 * else the template's own name ("DE-EN", "Card 1"), else "Direction {n}".
 */
export function directionName(type: Pick<NoteType, 'fields' | 'templates'>, ord: number): string {
  const t = type.templates.find((x) => x.ord === ord);
  if (!t) return `Direction ${ord + 1}`;
  const from = languageName(type.fields[t.prompt[0]]?.lang);
  const to = languageName(type.fields[t.answer[0]]?.lang);
  if (from && to && from !== to) return `${from} → ${to}`;
  return t.name.trim() || `Direction ${ord + 1}`;
}

/**
 * The one line that replaces the Fields stage when the guess is certain
 * (spec §5.9): "Fields: Front → front, Back → back" (the Preview adds
 * "· Change"). '' when the card type has no Front or no Back. The fields
 * are named by the one label rule (`fieldDisplayLabel`, wave 5d R6).
 */
export function fieldsLine(fields: readonly FieldDef[]): string {
  const term = fields.find((f) => f.role === 'term');
  const meaning = fields.find((f) => f.role === 'meaning');
  if (!term || !meaning) return '';
  return `Fields: ${fieldDisplayLabel(term)} → front, ${fieldDisplayLabel(meaning)} → back`;
}

/**
 * The Fields stage's line for an Anki card type the library already has
 * (plan.ts `startingTypes`: `reused`, and `addedFields` / `removedFields` when
 * a newer version of its model adds or removes fields). The fields are named
 * by their labels. A removed field loses no text: a card that the file does
 * not update keeps it (plan.ts `upgradeNoteType`, `keep`).
 *
 *   reusedTypeLine(vocab, [])
 *   → 'Already in your library as “German Vocabulary”. Its fields stay as they are. Fields: Word → front, …'
 *   reusedTypeLine(vocab, ['Type', 'Plural'])
 *   → 'Already in your library as “German Vocabulary”. This file adds 2 fields: Type, Plural.
 *      The other fields stay as they are. Fields: Word → front, …'
 *   reusedTypeLine(vocab, [], ['MarankiExample'])
 *   → 'Already in your library as “German Vocabulary”. This file no longer has 1 field: Example.
 *      A card that this file does not update keeps its text there. The other fields stay as they are. …'
 */
export function reusedTypeLine(
  type: Pick<NoteType, 'name' | 'fields'>,
  addedFields: readonly string[] = [],
  removedFields: readonly string[] = [],
): string {
  const label = (name: string) => fieldDisplayLabel(type.fields.find((f) => f.name === name) ?? { name });
  const added = addedFields.map(label);
  const removed = removedFields.map(label);
  const changes: string[] = [];
  if (added.length > 0) changes.push(`This file adds ${plural(added.length, 'field')}: ${added.join(', ')}.`);
  if (removed.length > 0) {
    changes.push(
      `${added.length > 0 ? 'It' : 'This file'} no longer has ${plural(removed.length, 'field')}: ${removed.join(', ')}. ` +
        'A card that this file does not update keeps its text there.',
    );
  }
  const stay = changes.length > 0 ? `${changes.join(' ')} The other fields stay as they are.` : 'Its fields stay as they are.';
  return `Already in your library as “${type.name}”. ${stay} ${fieldsLine(type.fields)}`.trim();
}

/* ------------------------------------------------------- CSV columns (Fields stage) */

/** What one CSV column is, on the Fields stage (spec §5.9). 'tags' is not a field: the file is read again. */
export type CsvColumnRole = 'front' | 'back' | 'example' | 'showOnBack' | 'filter' | 'tags' | 'ignore';

/** The column choices, in the spec's order, with their labels. */
export const CSV_COLUMN_ROLES: readonly { id: CsvColumnRole; label: string }[] = [
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'example', label: 'Example' },
  { id: 'showOnBack', label: 'Show on back' },
  { id: 'filter', label: 'Filter' },
  { id: 'tags', label: 'Tags' },
  { id: 'ignore', label: 'Ignore' },
];

/** A CSV field's column choice, read from its role. */
export function csvColumnRole(f: FieldDef): Exclude<CsvColumnRole, 'tags'> {
  switch (f.role) {
    case 'term':
      return 'front';
    case 'meaning':
      return 'back';
    case 'example':
    case 'exampleMeaning':
      return 'example';
    case 'badge':
      return 'filter';
    case 'hidden':
      return 'ignore';
    default:
      return f.facet === 'on' ? 'filter' : 'showOnBack';
  }
}

/**
 * Field `i` of a CSV gets a column choice: Front / Back (the old one moves,
 * see setFrontField), Example, Show on back (a back row, not a filter),
 * Filter (a pill and always a filter group) or Ignore (kept, never shown).
 */
export function setCsvColumnRole(
  fields: readonly FieldDef[],
  i: number,
  role: Exclude<CsvColumnRole, 'tags'>,
): FieldDef[] {
  const f = fields[i];
  if (!f) return [...fields];
  const put = (next: FieldDef) => fields.map((g, j) => (j === i ? next : g));
  switch (role) {
    case 'front':
      return setFrontField(fields, i);
    case 'back':
      return setBackField(fields, i);
    case 'example':
      return put(withRole(f, 'example'));
    case 'showOnBack':
      return put({ ...withRole(f, 'detail'), facet: 'off' });
    case 'filter':
      return put({ ...withRole(f, 'badge'), facet: 'on' });
    case 'ignore':
      return put({ ...withRole(f, 'hidden'), facet: 'off' });
  }
}

/**
 * The file column (0-based) of every field of a CSV collection. The reader
 * leaves the special columns (guid, deck, notetype, tags) out of the fields,
 * so field k is the k-th column that is not special. "Tags" on the Fields
 * stage reads the file again with that column number (csvRead `tagsCol`).
 *
 *   header Word,Tags,Meaning (tags column 1) → fields [Word, Meaning] → [0, 2]
 */
export function csvFieldColumns(collection: AnkiCollection, fieldCount: number): number[] {
  const csv = collection.csv;
  if (!csv) return [];
  const special = new Set<number>(
    [csv.guidCol, csv.deckCol, csv.notetypeCol, csv.tagsCol].filter((c): c is number => c !== undefined),
  );
  const out: number[] = [];
  for (let c = 0; out.length < fieldCount && c < fieldCount + special.size; c++) {
    if (!special.has(c)) out.push(c);
  }
  return out;
}

/** The tags column of a CSV for the Fields stage ("Tags: Topic", "Tags: column 5 and after"), or ''. */
export function csvTagsLabel(collection: AnkiCollection): string {
  const csv = collection.csv;
  if (!csv || csv.tagsCol === undefined) return '';
  const name = csv.header?.[csv.tagsCol]?.trim() || `column ${csv.tagsCol + 1}`;
  return csv.tagsSpill ? `Tags: ${name} and after` : `Tags: ${name}`;
}

/* ---------------------------------------------------------------- the Preview */

/** One line of the Preview, counted by the planner (`plan.summary`). */
export interface PreviewRow {
  key: 'filters' | 'inTarget' | 'inOther' | 'progress' | 'suspended' | 'images' | 'audio';
  label: string;
  value: string;
}

const num = (n: number) => n.toLocaleString('en-US');

/** 180 MB, never "0 MB". */
export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024))).toLocaleString('en-US')} MB`;
}

/**
 * The Preview's first line (spec §5.9):
 *   "15,960 cards from 8,433 items · 15 sections"
 * When the same import ALSO updates items, the cards are called NEW, so the
 * learner can tell the new number from the updated one (the update count is
 * the line under it, `previewUpdateLine`; wave 5g, walkthrough E8):
 *   "1,000 new cards from 500 items · 5 sections"
 * When nothing is new: "{n} new cards for items already here" (newly enabled
 * directions), "Nothing new · {u} items will be updated", or
 * "Already up to date".
 */
export function previewHeadline(
  summary: Pick<ImportSummary, 'cardsAdded' | 'notesAdded' | 'sections' | 'notesUpdated' | 'cardTypesUpdated'>,
): string {
  if (summary.notesAdded > 0) {
    const sections = summary.sections > 0 ? ` · ${plural(summary.sections, 'section')}` : '';
    const cards = plural(summary.cardsAdded, summary.notesUpdated > 0 ? 'new card' : 'card');
    return `${cards} from ${plural(summary.notesAdded, 'item')}${sections}`;
  }
  if (summary.cardsAdded > 0) return `${plural(summary.cardsAdded, 'new card')} for items already here`;
  if (summary.notesUpdated > 0) return `Nothing new · ${plural(summary.notesUpdated, 'item')} will be updated`;
  // A newer version of a card type (new fields or directions) whose values are all the same.
  if (summary.cardTypesUpdated > 0) return `Nothing new · ${plural(summary.cardTypesUpdated, 'card type')} will be updated`;
  return 'Already up to date';
}

/**
 * The Preview's line under the headline when the import adds cards AND
 * updates items (wave 5g, walkthrough E8): "{u} items will be updated in
 * {decks}". Before, only the Done stage said that items were updated. The
 * Preview showed "Already in this deck 4,000" and "Import 1,000 cards", but
 * not that those 4,000 items would get the file's new text.
 *
 * '' when nothing is updated, and when the headline already says it ("Nothing
 * new · {u} items will be updated"). `notesUpdated` counts only the items
 * whose text, tags or section really change: an item that is the same in the
 * file (`notesUnchanged`) is never called updated. The decks are the ones
 * that hold the updated items (`updatedDecks`), so an item updated where it
 * is (in another deck, "Update them where they are") names that deck too.
 *
 *   previewUpdateLine({ cardsAdded: 1000, notesUpdated: 4000, updatedDecks: ['German Vocabulary'] })
 *   → '4,000 items will be updated in German Vocabulary'
 */
export function previewUpdateLine(summary: Pick<ImportSummary, 'cardsAdded' | 'notesUpdated' | 'updatedDecks'>): string {
  // No new card: the headline already says "Nothing new · {u} items will be updated".
  if (summary.notesUpdated === 0 || summary.cardsAdded === 0) return '';
  const decks = summary.updatedDecks.filter((d) => d !== '').join(', ');
  return `${plural(summary.notesUpdated, 'item')} will be updated${decks ? ` in ${decks}` : ''}`;
}

/**
 * The Preview's numbered lines, every one from `plan.summary` (spec §5.9).
 * Study progress, suspension, images and audio exist only in Anki files, so a
 * CSV (`anki: false`) shows none of those lines. `images` is the current
 * "Include images" choice.
 *
 * `imagesHere` (wave 5i): how many of the plan's image files the deck folders
 * already hold, byte for byte (`importImagesHere`). When that is every file
 * of the plan, nothing new is copied, and the row says so: "57 — already
 * here". Before, an unchanged file showed "Already up to date" above
 * "Images 57 — will be imported" (release re-measure): a contradiction. When
 * some pictures are new (or it is not known), the row keeps "— will be
 * imported".
 *
 *   images row: imagesFound 0                          → 'none'
 *               "Include images" off                   → '57 — not imported'
 *               every planned file is in its folder    → '57 — already here'
 *               else                                   → '57 — will be imported'
 */
export function previewRows(
  summary: ImportSummary,
  opts: { anki: boolean; images: boolean; imagesHere?: number },
): PreviewRow[] {
  const rows: PreviewRow[] = [
    { key: 'filters', label: 'Filters found', value: summary.filtersFound.join(', ') || 'none' },
    // By guid, and the CSV rows found in this deck by their Front ("already here", §5.6 rule 4).
    { key: 'inTarget', label: 'Already in this deck', value: num(summary.inTargetDeck + summary.skipped.alreadyHere) },
    { key: 'inOther', label: 'Already in other decks', value: num(summary.inOtherDecks) },
  ];
  if (!opts.anki) return rows;
  rows.push({
    key: 'progress',
    label: 'Study progress in this file',
    value: summary.progressCards > 0 ? plural(summary.progressCards, 'card') : 'none',
  });
  rows.push({ key: 'suspended', label: 'Suspended in Anki', value: num(summary.suspended) });
  rows.push({ key: 'images', label: 'Images', value: imagesRowValue(summary, opts.images, opts.imagesHere ?? 0) });
  rows.push({
    key: 'audio',
    label: 'Audio',
    value: summary.audioClips === 0 ? 'none' : `${plural(summary.audioClips, 'clip')} — not imported yet. Cards keep their text.`,
  });
  return rows;
}

/** The value of the Preview's "Images" row (see previewRows). */
function imagesRowValue(summary: Pick<ImportSummary, 'imagesFound' | 'images'>, include: boolean, here: number): string {
  if (summary.imagesFound === 0) return 'none';
  const found = num(summary.imagesFound);
  if (!include) return `${found} — not imported`;
  // Every file the import would write is already in its folder with the same bytes: nothing new.
  if (summary.images > 0 && here >= summary.images) return `${found} — already here`;
  return `${found} — will be imported`;
}

/**
 * Counts the image files of a plan (`plan.media`) that their deck folders
 * ALREADY hold with the very same bytes (wave 5i): an import writes nothing
 * new for them. The Preview's "Images" row reads it ("57 — already here").
 *
 * `bytesOf(name)` reads one image from the archive (AnkiCollection.mediaBytes);
 * `disk` reads the folders (importApkg.ts `expoMediaDisk` on the phone). The
 * size is compared first; the bytes only when the sizes are the same. A file
 * that cannot be read, or a name that is not safe, counts as NOT here.
 * Answers are kept per folder and name (the folders do not change while the
 * import screen plans, the same rule as `importMediaNamer`), so planning again
 * after a choice reads nothing twice. Never throws.
 *
 *   const here = importImagesHere(collection.mediaBytes, expoMediaDisk());
 *   here(plan.media) → 57   (an unchanged re-import of Algo_Patterns.apkg)
 */
export function importImagesHere(
  bytesOf: ((name: string) => Uint8Array | null) | undefined,
  disk: MediaFolderReader,
): (folders: readonly ImportMediaFolder[]) => number {
  const known = new Map<string, boolean>();
  const isHere = (folder: ImportMediaFolder, name: string): boolean => {
    const key = JSON.stringify([folder.deckFolder, name]);
    const kept = known.get(key);
    if (kept !== undefined) return kept;
    let here = false;
    try {
      if (bytesOf && isMediaFolder(folder.deckFolder) && isSafeMediaName(name)) {
        const size = disk.fileSize(folder.deckFolder, name);
        // A file renamed in this folder (its name was taken) is read by its archive name.
        const bytes = size === null ? null : bytesOf(archiveNameIn(folder, name));
        if (bytes && size === bytes.length) {
          const there = disk.readFile(folder.deckFolder, name);
          here = there !== null && sameBytes(there, bytes);
        }
      }
    } catch {
      here = false;
    }
    known.set(key, here);
    return here;
  };
  return (folders) => {
    let count = 0;
    for (const folder of folders) for (const name of folder.files) if (isHere(folder, name)) count += 1;
    return count;
  };
}

/** "Import 180 MB of images?" (spec §5.8), or '' when the images are 50 MB or less. */
export function imagesQuestion(summary: Pick<ImportSummary, 'imagesAskFirst' | 'imagesFoundBytes'>): string {
  return summary.imagesAskFirst ? `Import ${formatMegabytes(summary.imagesFoundBytes)} of images?` : '';
}

/** "{n} duplicate ids in this file were renamed." (spec §5.6 rule 1), or ''. */
export function renamedNotice(summary: Pick<ImportSummary, 'guidsRenamed'>): string {
  const n = summary.guidsRenamed;
  if (n === 0) return '';
  return n === 1 ? '1 duplicate id in this file was renamed.' : `${num(n)} duplicate ids in this file were renamed.`;
}

/**
 * The headword note (spec §5.6 rule 5): "{n} items have the same text as
 * items in {deck}. They are studied separately."
 *
 * It says WHAT it counts: the same text (the folded sort field, for example
 * the Front), not the same item. Before (wave 5g, walkthrough E8) it said
 * "4 items also appear in three-words" right under "Already in other decks
 * 0", and the two lines read as a contradiction. "Already in other decks"
 * counts the SAME items (the same Anki id). This note counts DIFFERENT items
 * with the same text; they are imported as items of their own.
 *
 *   overlapText({ deckName: 'three-words', notes: 4 })
 *   → '4 items have the same text as items in three-words. They are studied separately.'
 *   overlapText({ deckName: 'X', notes: 1 })
 *   → '1 item has the same text as an item in X. They are studied separately.'
 */
export function overlapText(o: { deckName: string; notes: number }): string {
  const same = o.notes === 1 ? 'has the same text as an item' : 'have the same text as items';
  return `${plural(o.notes, 'item')} ${same} in ${o.deckName}. They are studied separately.`;
}

/** The label of "[Skip these {n}]": the count when one deck overlaps (with several, one note can count twice). */
export function overlapSkipLabel(summary: Pick<ImportSummary, 'overlap'>): string {
  return summary.overlap.length === 1 ? `Skip these ${num(summary.overlap[0].notes)}` : 'Skip these';
}

/** The three answers to "Already in other decks" (spec §5.6 rule 3), the default first. */
export const ELSEWHERE_OPTIONS: readonly { id: ImportChoices['elsewhere']; label: string }[] = [
  { id: 'update', label: 'Update them where they are' },
  { id: 'copy', label: 'Import as copies here' },
  { id: 'skip', label: 'Skip them' },
];

/** The two answers to "How should new cards start?" (spec §5.9), with the daily new limit in the first. */
export function newCardsOptions(dailyNewLimit: number): { id: ImportChoices['arrival']; title: string; sub: string }[] {
  return [
    { id: 'queued', title: 'Add all to my study queue', sub: `${num(dailyNewLimit)} new a day, in deck order` },
    { id: 'notStarted', title: 'Let me choose what to learn', sub: 'cards start as Not started' },
  ];
}

/** True when the import changes something (new cards or updated items): the Import button is live. */
export function canImport(summary: Pick<ImportSummary, 'cardsAdded' | 'notesUpdated' | 'cardTypesUpdated'>): boolean {
  return summary.cardsAdded > 0 || summary.notesUpdated > 0 || summary.cardTypesUpdated > 0;
}

/** "Import 15,960 cards", "Update 12 items", "Update 1 card type", or "Already up to date". */
export function importButtonLabel(summary: Pick<ImportSummary, 'cardsAdded' | 'notesUpdated' | 'cardTypesUpdated'>): string {
  if (summary.cardsAdded > 0) return `Import ${plural(summary.cardsAdded, 'card')}`;
  if (summary.notesUpdated > 0) return `Update ${plural(summary.notesUpdated, 'item')}`;
  if (summary.cardTypesUpdated > 0) return `Update ${plural(summary.cardTypesUpdated, 'card type')}`;
  return 'Already up to date';
}

/* ---------------------------------------------------------------- Done */

/** The Done stage's words (spec §5.6, §5.9), from what `applyImport` really did. */
export interface DoneCopy {
  /**
   * 'queue'    new cards are in the study queue: "Study {k} now" · "Open deck";
   * 'choose'   new cards start Not started: "Choose what to learn" · "Open deck";
   * 'updated'  nothing new, items updated: "Updated {n} cards ({u} items) in {decks}." "Nothing new.";
   * 'upToDate' nothing changed: "Already up to date.".
   */
  mode: 'queue' | 'choose' | 'updated' | 'upToDate';
  title: string;
  lines: string[];
}

/**
 * A number of cards with its number of items: "8 cards (4 items)", and also
 * "1 card (1 item)". The items are ALWAYS said (wave 5i): the Preview counts
 * an update in items ("1 item will be updated", the button "Update 1 item"),
 * so the Done title names that same unit. Before, the items were left out
 * when the two numbers were equal, and the Preview's "Update 1 item" ended in
 * "Updated 1 card in Algo Deck." (release re-measure).
 */
function cardsWithItems(cards: number, items: number): string {
  return `${plural(cards, 'card')} (${plural(items, 'item')})`;
}

/**
 * The Done copy. `deckName` is the deck the import went into; `notStarted`
 * is the number of added cards that start Not started (the plan's summary);
 * the 'choose' mode exists only with the triage screen.
 *
 * Every number says its UNIT (wave 5g, walkthrough E8). Before, "1,000 cards
 * added" counted cards and the next line "4,000 updated" counted ITEMS
 * (4,000 items = 8,000 cards), so the two numbers could not be compared.
 * Now: "{n} cards added", "{u} items updated · {s} items skipped (already
 * here)", and "Updated {n} cards ({u} items) in {decks}." — the item count
 * is the number the Preview said ("{u} items will be updated").
 *
 *   doneCopy({ cardsAdded: 15960, notesUpdated: 0, … }, { deckName: 'German', notStarted: 0, triageReady: false })
 *   → { mode: 'queue', title: 'German is ready', lines: ['15,960 cards added'] }
 *   doneCopy({ cardsAdded: 1000, notesUpdated: 4000, … }, …).lines
 *   → ['1,000 cards added', '4,000 items updated']
 */
export function doneCopy(
  result: Pick<
    ImportResult,
    'cardsAdded' | 'notesUpdated' | 'cardsUpdated' | 'updatedDecks' | 'skipped' | 'markedKnown' | 'cardTypesUpdated'
  >,
  opts: { deckName: string; notStarted: number; triageReady: boolean },
): DoneCopy {
  // A CSV row "already here" is one item (§5.6 rule 4).
  const skippedLine =
    result.skipped.alreadyHere > 0 ? `${plural(result.skipped.alreadyHere, 'item')} skipped (already here)` : '';
  const knownLine =
    result.markedKnown > 0 ? `${plural(result.markedKnown, 'card')} marked Known (easier levels).` : '';
  const counts = [result.notesUpdated > 0 ? `${plural(result.notesUpdated, 'item')} updated` : '', skippedLine]
    .filter((s) => s !== '')
    .join(' · ');

  if (result.cardsAdded > 0) {
    const mode = opts.triageReady && opts.notStarted > 0 ? 'choose' : 'queue';
    const lines = [`${plural(result.cardsAdded, 'card')} added`, counts, knownLine].filter((s) => s !== '');
    return { mode, title: `${opts.deckName} is ready`, lines };
  }
  if (result.notesUpdated > 0) {
    const decks = result.updatedDecks.filter((d) => d !== '').join(', ');
    const where = decks ? ` in ${decks}` : '';
    // "{u} items updated" would only repeat the title: keep the skip count.
    const lines = ['Nothing new.', skippedLine].filter((s) => s !== '');
    return { mode: 'updated', title: `Updated ${cardsWithItems(result.cardsUpdated, result.notesUpdated)}${where}.`, lines };
  }
  if (result.cardTypesUpdated > 0) {
    // Only a card type changed (new fields or directions); every value was already the same.
    const lines = ['Nothing new.', skippedLine].filter((s) => s !== '');
    return { mode: 'updated', title: `Updated ${plural(result.cardTypesUpdated, 'card type')}.`, lines };
  }
  return { mode: 'upToDate', title: 'Already up to date.', lines: [counts, knownLine].filter((s) => s !== '') };
}

/**
 * The honest Done line when the save after `applyImport` did not commit
 * (`actions.flush()` resolved `{ ok: false }`), or '' when it did:
 *   'write'   — the save failed; the next save tries again (M15);
 *   'blocked' — writes are not allowed now (the saved data could not be read, C1).
 */
export function saveWarning(saved: { ok: boolean; reason?: 'blocked' | 'write' }): string {
  if (saved.ok) return '';
  return saved.reason === 'blocked'
    ? 'Your cards were added, but they could not be saved on this phone.'
    : 'Your cards were added, but saving failed. Maranki will try again.';
}

/** The Done line when some images could not be copied, or ''. */
export function imagesWarning(failed: number): string {
  if (failed === 0) return '';
  return failed === 1 ? '1 image could not be copied.' : `${num(failed)} images could not be copied.`;
}

/* ---------------------------------------------------------------- Sections */

/** One row of the Sections stage: a subdeck. */
export interface SectionLeaf {
  did: string;
  label: string;
  cards: number;
}

/** The Sections stage's tree (spec §5.4): flat rows, or category headers with level rows. */
export type SectionTree =
  | { mode: 'flat'; leaves: SectionLeaf[] }
  | { mode: 'grouped'; groups: { key: string; leaves: SectionLeaf[]; cards: number }[] };

/**
 * The subdecks of a file as a tree for the Sections stage. The leading parts
 * that every subdeck shares are left out ("German::Verbs::A1" and
 * "German::Vocabulary::A1" → "Verbs" / "Vocabulary"), but every row keeps at
 * least one part. With two or more parts left, the first part is a header and
 * the rest the row ("Verbs" → "A1", "B1"); else one flat row per subdeck.
 */
export function sectionTree(
  sections: readonly Pick<CollectionSection, 'did' | 'name' | 'path' | 'cards'>[],
): SectionTree {
  if (sections.length === 0) return { mode: 'flat', leaves: [] };
  const paths = sections.map((s) => s.path);
  let minLen = paths[0].length;
  for (const p of paths) if (p.length < minLen) minLen = p.length;
  let common = 0;
  for (let i = 0; i < minLen; i++) {
    const seg = paths[0][i];
    if (seg && paths.every((p) => p[i] === seg)) common++;
    else break;
  }
  if (common >= minLen) common = Math.max(0, minLen - 1);

  const rest = (s: (typeof sections)[number]) => s.path.slice(common);
  let maxRest = 0;
  for (const s of sections) maxRest = Math.max(maxRest, rest(s).length);

  if (maxRest >= 2) {
    const order: string[] = [];
    const byKey = new Map<string, SectionLeaf[]>();
    for (const s of sections) {
      const r = rest(s);
      const key = r[0] || s.name;
      const label = r.length > 1 ? r.slice(1).join(' · ') : r[0] || s.name;
      let list = byKey.get(key);
      if (!list) {
        byKey.set(key, (list = []));
        order.push(key);
      }
      list.push({ did: s.did, label, cards: s.cards });
    }
    return {
      mode: 'grouped',
      groups: order.map((key) => {
        const leaves = byKey.get(key) ?? [];
        return { key, leaves, cards: leaves.reduce((sum, l) => sum + l.cards, 0) };
      }),
    };
  }
  return {
    mode: 'flat',
    leaves: sections.map((s) => ({ did: s.did, label: rest(s).join(' · ') || s.name, cards: s.cards })),
  };
}

/** The Sections stage's footer: "4,480 cards in 5 sections". */
export function sectionsFooter(chosen: readonly Pick<CollectionSection, 'cards'>[]): string {
  const cards = chosen.reduce((sum, s) => sum + s.cards, 0);
  return `${plural(cards, 'card')} in ${plural(chosen.length, 'section')}`;
}

/* ---------------------------------------------------------------- AnkiWeb */

/**
 * One AnkiWeb search result's second line (spec §5.9: notes, rating, has
 * audio / images): "6,845 items · ▲ 120 · has audio · has images". The UI
 * never says "note" (glossary §1.2): a number of notes is "{n} items", the
 * same words as the Fields stage ("German Vocabulary · 6,845 items").
 */
export function ankiWebMeta(deck: { notes: number; upvotes: number; audio: number; images: number }): string {
  const parts = [plural(deck.notes, 'item'), `▲ ${num(deck.upvotes)}`];
  if (deck.audio > 0) parts.push('has audio');
  if (deck.images > 0) parts.push('has images');
  return parts.join(' · ');
}

/**
 * The details of an AnkiWeb deck before "Download & preview", from its
 * listing: Items (the deck's notes, glossary §1.2), Rating, Audio, Images,
 * Updated. A pasted link has no listing: only "AnkiWeb deck #id".
 */
export function ankiWebDetailRows(
  id: string,
  deck: { notes: number; upvotes: number; downvotes: number; audio: number; images: number; modifiedSec: number } | null,
): [string, string][] {
  if (!deck) return [['AnkiWeb deck', `#${id}`]];
  const rows: [string, string][] = [
    ['Items', num(deck.notes)],
    ['Rating', `▲ ${num(deck.upvotes)} · ▼ ${num(deck.downvotes)}`],
    ['Audio', deck.audio > 0 ? `${plural(deck.audio, 'clip')} — not imported yet` : 'none'],
    ['Images', deck.images > 0 ? num(deck.images) : 'none'],
  ];
  if (deck.modifiedSec > 0) {
    rows.push(['Updated', new Date(deck.modifiedSec * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })]);
  }
  return rows;
}

/* ---------------------------------------------------------------- images */

/** What writing the images of an import did. */
export interface ImageWriteResult {
  /** Files in place: written, or already in the folder with the same bytes (not written again). */
  written: number;
  /** 'media/<deckId>/<name>' of every file that was not written (unsafe, missing in the archive, disk error). */
  failed: string[];
}

/** A plan folder is exactly 'media/<deckId>' with a plain deck id. */
function isMediaFolder(folder: string): boolean {
  const parts = folder.split('/');
  return parts.length === 2 && parts[0] === 'media' && isSafeMediaName(parts[1]);
}

/**
 * Is `name` in `folder` already, with exactly `bytes`? Only when the disk
 * can read (`fileSize` + `readFile`); a read error is "no".
 */
function sameFileThere(disk: Partial<MediaFolderReader>, folder: string, name: string, bytes: Uint8Array): boolean {
  if (!disk.fileSize || !disk.readFile) return false;
  try {
    if (disk.fileSize(folder, name) !== bytes.length) return false;
    const there = disk.readFile(folder, name);
    return there !== null && sameBytes(there, bytes);
  } catch {
    return false;
  }
}

/**
 * Write the image files of an applied import (`ImportResult.media`) AFTER the
 * save commits (spec §5.8). `bytesOf(name)` reads one image from the archive
 * (AnkiCollection.mediaBytes); `disk` writes it (importApkg.ts
 * `expoMediaDisk` on the phone). A pure loop, so it is tested with a fake disk.
 *
 * A file that is in its folder already with the same bytes is not written
 * again (an unchanged re-import, whose Preview said "57 — already here"),
 * when the disk can read; it counts as `written` (it is in place).
 *
 * A name or folder that could leave the deck's media folder, a file that is
 * not an image, missing bytes and a disk error are each counted in `failed`;
 * one failure never stops the other files.
 */
export function writeImportImages(
  folders: readonly ImportMediaFolder[],
  bytesOf: ((name: string) => Uint8Array | null) | undefined,
  disk: { ensureFolder(folder: string): void; writeFile(folder: string, name: string, bytes: Uint8Array): void } & Partial<MediaFolderReader>,
): ImageWriteResult {
  const out: ImageWriteResult = { written: 0, failed: [] };
  for (const folder of folders) {
    const { deckFolder, files } = folder;
    const fail = (names: readonly string[]) => {
      for (const name of names) out.failed.push(`${deckFolder}/${name}`);
    };
    if (files.length === 0) continue;
    if (!isMediaFolder(deckFolder) || !bytesOf) {
      fail(files);
      continue;
    }
    try {
      disk.ensureFolder(deckFolder);
    } catch {
      fail(files);
      continue;
    }
    for (const name of files) {
      if (!isSafeMediaName(name) || !isImageName(name)) {
        fail([name]);
        continue;
      }
      // A file renamed in this folder (its name was taken) is read by its archive name.
      const bytes = bytesOf(archiveNameIn(folder, name));
      if (!bytes) {
        fail([name]);
        continue;
      }
      if (sameFileThere(disk, deckFolder, name, bytes)) {
        out.written += 1;
        continue;
      }
      try {
        disk.writeFile(deckFolder, name, bytes);
        out.written += 1;
      } catch {
        fail([name]);
      }
    }
  }
  return out;
}
