/**
 * Pure Anki → Maranki mapping for .apkg import (the I/O — unzip + SQLite — lives
 * in importApkg.ts; everything here is side-effect-free and unit-testable).
 *
 * An Anki collection stores a `notes` row per item: `flds` is the field values
 * joined by the unit separator (\x1f), `tags` is a space-separated string, and
 * `mid` points at a note *model* (in the col table's `models` JSON) that names
 * the fields. We map fields to Maranki's card shape by the model's field NAMES
 * (not by position) — decks order fields differently, e.g. one real deck is
 * [Word, Grammar, VerbForms, Examples, Translation, MarankiExample, Level], so a
 * positional "field 1 = translation" would wrongly grab the empty Grammar field.
 *
 * Field HTML is stripped to plain text (Anki fields are HTML; Maranki cards are
 * plain). Hermes-safe: no String.normalize / replaceAll / lookbehind.
 */
import { clampLevel } from './importFile';
import { ImportCardPayload } from './importSamples';

/** Unit Separator that joins Anki field values inside `notes.flds`. */
export const FIELD_SEP = '\x1f';

export interface AnkiModel {
  name: string;
  /** Field display names, in ordinal order. */
  flds: string[];
}
export type AnkiModelMap = Record<string, AnkiModel>;

export interface AnkiNoteRow {
  /** Model id (stringified — JS can't hold Anki's 53-bit+ ids exactly as keys). */
  mid: string;
  flds: string;
  tags: string;
}

/* ----------------------------------------------------------- models + decks */

/** Parse the col.models JSON into a slim {mid: {name, flds[]}} map. Tolerant. */
export function parseAnkiModels(modelsJson: string): AnkiModelMap {
  const out: AnkiModelMap = {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(modelsJson) as Record<string, unknown>;
  } catch {
    return out;
  }
  for (const mid of Object.keys(raw)) {
    const m = raw[mid] as { name?: string; flds?: { name?: string; ord?: number }[] };
    const flds = Array.isArray(m?.flds)
      ? [...m.flds]
          .sort((a, b) => (a?.ord ?? 0) - (b?.ord ?? 0))
          .map((f) => (typeof f?.name === 'string' ? f.name : ''))
      : [];
    out[mid] = { name: typeof m?.name === 'string' ? m.name : '', flds };
  }
  return out;
}

/**
 * A friendly deck name from the collection's deck names — the longest common
 * "::" prefix of the non-Default decks (e.g. "German::Vocabulary::A1" + "…::B1"
 * → "German Vocabulary"). Falls back to `fallback` (usually the file name).
 */
export function ankiDeckName(deckNames: string[], fallback: string): string {
  const real = deckNames.filter((n) => n && n.trim().toLowerCase() !== 'default');
  if (real.length === 0) return fallback;
  const split = real.map((n) => {
    const parts = n.split('::').map((s) => s.trim());
    // "Default::Sub" → "Sub": don't leak Anki's default container into the name.
    if (parts.length > 1 && parts[0].toLowerCase() === 'default') parts.shift();
    return parts;
  });
  const first = split[0];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (seg && split.every((parts) => parts[i] === seg)) common.push(seg);
    else break;
  }
  const name = (common.length ? common : first).join(' ').replace(/\s+/g, ' ').trim();
  return name.length ? name : fallback;
}

/* ----------------------------------------------------------------- HTML strip */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ntilde: 'ñ',
  iexcl: '¡',
  iquest: '¿',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Reject 0 / out-of-range / lone surrogates (0xD800–0xDFFF) — keep the raw
      // entity rather than emit an invalid lone UTF-16 surrogate.
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return m;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : m;
  });
}

/* ----------------------------------------------------------------- cloze */

/** {{c1::answer}} / {{c1::answer::hint}} — global, for replace + scanning. */
const CLOZE_RE = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
/** Non-global probe (safe for .test — no lastIndex state). */
const CLOZE_DETECT = /\{\{c\d+::/;

/** Cloze text → the prompt: each deletion becomes its hint in [..] or a [..] blank. */
function clozeBlank(s: string): string {
  return s.replace(CLOZE_RE, (_m, _ans, hint) => (hint ? `[${hint}]` : '[…]'));
}

/** Cloze text → the answer side: the deletion answers, comma-joined. */
function clozeAnswers(s: string): string {
  const out: string[] = [];
  s.replace(CLOZE_RE, (_m: string, ans: string) => {
    out.push(ans);
    return '';
  });
  return out.join(', ');
}

/**
 * Anki field HTML → readable plain text. The negated classes EXCLUDE the opening
 * delimiter ([^<>] not [^>], [^\][] not [^\]]) so a run of unmatched openers
 * can't be re-scanned per position — that keeps every pass linear instead of
 * O(n²), which on a pathological field (e.g. code with many '<' and no '>')
 * would otherwise freeze the single JS thread for minutes.
 */
export function stripHtml(input: string): string {
  if (!input) return '';
  let s = input;
  s = s.replace(/<\s*(script|style)\b[^<>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' '); // drop script/style
  s = s.replace(/\[(?:sound|anki|image|img):[^\][]*\]/gi, ' '); // [sound:foo.mp3] etc.
  s = s.replace(CLOZE_RE, '$1'); // unwrap any stray {{c1::answer::hint}} → answer
  s = s.replace(/<\s*br\s*\/?\s*>/gi, ' '); // <br> → space
  s = s.replace(/<\s*\/\s*(?:div|p|tr|li|h[1-6]|td|th)\s*>/gi, ' '); // block ends → space
  s = s.replace(/<[^<>]*>/g, ''); // any remaining tag
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim(); // collapse whitespace
  return s;
}

/* --------------------------------------------------------------- field roles */

// Leading boundary is `(?:^|[^a-z0-9])` rather than `\b`: under /i the negated
// class also excludes A-Z, so it behaves like \b for ASCII but ALSO fires at the
// start of a name beginning with a non-ASCII letter (e.g. "Übersetzung", which a
// plain \b never matched). `back(?![a-z])` keeps a bare "Back" field but stops it
// stealing "Background"/"Backstory".
const WORD_RE = /(?:^|[^a-z0-9])(word|wort|front|vorderseite|begriff|term|expression|frage|question|prompt|headword|lemma|vocab)/i;
const TR_RE = /(?:^|[^a-z0-9])(translation|ubersetzung|übersetzung|meaning|bedeutung|back(?![a-z])|ruckseite|rückseite|definition|answer|antwort|output|english|gloss|sense)/i;
const EX_RE = /(?:^|[^a-z0-9])(example|beispiel|satz|sentence|usage|context|sample)/i;
const LEVEL_RE = /(?:^|[^a-z0-9])(level|niveau|cefr|stufe|grade)/i;
const IPA_RE = /(?:^|[^a-z0-9])(ipa|pronunciation|aussprache|phonetic|reading|romaji|pinyin)/i;

/** First field index whose name matches `re` and isn't already taken. */
function findField(names: string[], re: RegExp, taken: Set<number>): number {
  for (let i = 0; i < names.length; i++) {
    if (!taken.has(i) && re.test(names[i] || '')) return i;
  }
  return -1;
}

/** First not-yet-taken field with non-empty stripped content. */
function firstFilled(values: string[], taken: Set<number>): number {
  for (let i = 0; i < values.length; i++) {
    if (!taken.has(i) && stripHtml(values[i] || '') !== '') return i;
  }
  return -1;
}

/**
 * Map one Anki note to a card payload using its model's field names. Returns
 * null when no usable front (word) text survives. `model` may be undefined
 * (unknown mid) → purely positional fallback.
 */
export function mapAnkiNote(
  flds: string,
  tags: string,
  model: AnkiModel | undefined,
): ImportCardPayload | null {
  const values = (flds ?? '').split(FIELD_SEP);
  const names = model?.flds && model.flds.length ? model.flds : values.map(() => '');
  const cardTags = (tags ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Cloze notes ({{cN::answer::hint}}): build a real front (prompt with blanks)
  // and back (the answers) from the deletion field — Cloze is a built-in Anki
  // note type, so positional mapping would otherwise leak raw {{..}} markup.
  const clozeIdx = values.findIndex((v) => CLOZE_DETECT.test(v || ''));
  if (clozeIdx >= 0) {
    const src = values[clozeIdx];
    const word = stripHtml(clozeBlank(src));
    if (word === '') return null;
    const ci = findField(names, EX_RE, new Set([clozeIdx]));
    const card: ImportCardPayload = {
      word,
      tr: stripHtml(clozeAnswers(src)),
      level: null,
      type: null,
    };
    const ex = ci >= 0 ? stripHtml(values[ci] || '') : '';
    if (ex) card.ex = ex;
    if (cardTags.length) card.tags = cardTags;
    return card;
  }

  const taken = new Set<number>();

  // word (front): named match, else positional field 0; if that strips to empty
  // (a media-only [sound:]/<img> field or a blank), salvage the first field with
  // real content before giving up — a media-first note isn't malformed.
  let wi = findField(names, WORD_RE, taken);
  if (wi < 0) wi = 0;
  let word = stripHtml(values[wi] || '');
  if (word === '') {
    const alt = firstFilled(values, new Set([wi]));
    if (alt >= 0) {
      wi = alt;
      word = stripHtml(values[alt] || '');
    }
  }
  if (word === '') return null; // genuinely empty note: skip
  taken.add(wi);

  // Reserve the NAMED translation/example/ipa/level roles BEFORE the translation
  // fallback, so firstFilled() can't steal a recognizable Example/Level/IPA field
  // as the back. Reserving the translation index first also stops a field that
  // matches two roles (e.g. "Answer example") being assigned twice.
  const ti0 = findField(names, TR_RE, taken);
  if (ti0 >= 0) taken.add(ti0);
  const ei = findField(names, EX_RE, taken);
  if (ei >= 0) taken.add(ei);
  const ii = findField(names, IPA_RE, taken);
  if (ii >= 0) taken.add(ii);
  const li = findField(names, LEVEL_RE, taken);
  if (li >= 0) taken.add(li);

  // translation: the named field, else the first remaining filled field.
  let ti = ti0;
  if (ti < 0) ti = firstFilled(values, taken);

  const card: ImportCardPayload = {
    word,
    tr: ti >= 0 ? stripHtml(values[ti] || '') : '',
    level: li >= 0 ? clampLevel(stripHtml(values[li] || '')) : null,
    type: null,
  };
  const ex = ei >= 0 ? stripHtml(values[ei] || '') : '';
  const ipa = ii >= 0 ? stripHtml(values[ii] || '') : '';
  if (ex) card.ex = ex;
  if (ipa) card.ipa = ipa;
  if (cardTags.length) card.tags = cardTags;
  return card;
}

/** Map a whole notes table to card payloads (drops notes with no front). */
export function buildApkgPayload(notes: AnkiNoteRow[], models: AnkiModelMap): ImportCardPayload[] {
  const out: ImportCardPayload[] = [];
  for (const n of notes) {
    const card = mapAnkiNote(n.flds, n.tags, models[n.mid]);
    if (card) out.push(card);
  }
  return out;
}
