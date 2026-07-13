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
import { splitArticle } from './words';

/** Unit Separator that joins Anki field values inside `notes.flds`. */
export const FIELD_SEP = '\x1f';

export interface AnkiModel {
  name: string;
  /** Field display names, in ordinal order. */
  flds: string[];
  /** Anki note-type kind: 0 = standard, 1 = cloze. */
  type?: number;
}
export type AnkiModelMap = Record<string, AnkiModel>;

export interface AnkiNoteRow {
  /** Note id (stringified) — links a note to its card rows (cards.nid) so the
   *  note can be attributed to a subdeck. Optional so existing callers/tests that
   *  build rows without it (buildApkgPayload) keep compiling. */
  id?: string;
  /** Model id (stringified — JS can't hold Anki's 53-bit+ ids exactly as keys). */
  mid: string;
  flds: string;
  tags: string;
}

/**
 * One selectable subdeck within an imported .apkg. An Anki collection groups its
 * cards into decks (German::Verbs::B1, …); parsing preserves that structure so
 * the UI can offer "import just this subdeck" instead of one flattened deck.
 */
export interface ImportSection {
  /** Anki deck id (stringified) — the stable selection key. '' = "(Other)". */
  did: string;
  /** Full deck name, e.g. "German::Verbs::B1". */
  name: string;
  /** name split on "::" and trimmed, e.g. ['German','Verbs','B1']. */
  path: string[];
  /** Cards mapped from the notes that live in this subdeck. */
  payload: ImportCardPayload[];
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
    const m = raw[mid] as {
      name?: string;
      type?: number;
      flds?: { name?: string; ord?: number }[];
    };
    const flds = Array.isArray(m?.flds)
      ? [...m.flds]
          .sort((a, b) => (a?.ord ?? 0) - (b?.ord ?? 0))
          .map((f) => (typeof f?.name === 'string' ? f.name : ''))
      : [];
    out[mid] = {
      name: typeof m?.name === 'string' ? m.name : '',
      flds,
      type: typeof m?.type === 'number' ? m.type : 0,
    };
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
/** Same, but capturing the cloze NUMBER (group 1) so cards can be split per c-num. */
const CLOZE_RE_NUM = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
/** Non-global probe (safe for .test — no lastIndex state). */
const CLOZE_DETECT = /\{\{c\d+::/;

/** Distinct cloze numbers present, ascending (e.g. {{c1}}+{{c2}} → [1, 2]). */
function clozeNumbers(s: string): number[] {
  const nums: number[] = [];
  const seen = new Set<number>();
  CLOZE_RE_NUM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOZE_RE_NUM.exec(s)) !== null) {
    const k = parseInt(m[1], 10);
    if (!seen.has(k)) {
      seen.add(k);
      nums.push(k);
    }
  }
  return nums.sort((a, b) => a - b);
}

/**
 * Build the front/back for ONE cloze number `k` (Anki renders each c-number as a
 * separate card): blank only c`k`'s deletions (hint in [..] or a [..] blank) and
 * REVEAL every other deletion as its plain answer. Back = c`k`'s answers joined.
 */
function clozeCard(src: string, k: number): { front: string; back: string } {
  const answers: string[] = [];
  const front = src.replace(CLOZE_RE_NUM, (_full, num: string, ans: string, hint?: string) => {
    if (parseInt(num, 10) === k) {
      answers.push(ans);
      return hint ? `[${hint}]` : '[…]';
    }
    return ans; // a different deletion → shown, not blanked, on this card
  });
  return { front, back: answers.join(', ') };
}

/**
 * Treat a note as cloze only when its MODEL is a cloze type (Anki: `type === 1`,
 * or a "Cloze" model name) — not merely because some field contains {{cN::}}
 * text, which a normal note about Anki syntax legitimately could. An unknown
 * model (unmatched mid) falls back to content detection so cloze still works.
 */
function isClozeModel(model: AnkiModel | undefined, values: string[]): boolean {
  if (model) return model.type === 1 || /cloze/i.test(model.name);
  return values.some((v) => CLOZE_DETECT.test(v || ''));
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
// Field-role names cover EN/DE plus common ES/FR/IT labels; when none match, the
// positional fallback below still maps front/back, so an unknown-language deck
// is never mis-imported, just less precisely (M12).
const WORD_RE = /(?:^|[^a-z0-9])(word|wort|front|vorderseite|begriff|term|termino|término|terme|expression|expresion|expresión|frage|question|prompt|headword|lemma|vocab|palabra|mot|parola|vocabolo)/i;
const TR_RE = /(?:^|[^a-z0-9])(translation|traduccion|traducción|traduction|traduzione|ubersetzung|übersetzung|meaning|significado|significato|signification|bedeutung|back(?![a-z])|ruckseite|rückseite|definition|definicion|definición|answer|antwort|respuesta|reponse|réponse|risposta|output|english|gloss|sense|sentido|senso)/i;
const EX_RE = /(?:^|[^a-z0-9])(example|ejemplo|exemple|esempio|beispiel|satz|sentence|frase|phrase|oracion|oración|usage|context|contexto|sample)/i;
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
 * Map one Anki note to card payload(s) using its model's field names. A cloze
 * note yields ONE CARD PER cloze number (matching Anki); a normal note yields a
 * single card, or none when no usable front survives. `model` may be undefined
 * (unknown mid) → positional fallback. Words are split into article/base so a
 * German article renders de-emphasised, exactly like the CSV path (L16/L17).
 */
export function mapAnkiNote(
  flds: string,
  tags: string,
  model: AnkiModel | undefined,
): ImportCardPayload[] {
  const values = (flds ?? '').split(FIELD_SEP);
  const names = model?.flds && model.flds.length ? model.flds : values.map(() => '');
  const cardTags = (tags ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Cloze notes: ONLY when the model is a cloze type (not any field that merely
  // mentions {{cN::}}). Build a front (prompt with blanks) and back (answers)
  // per cloze number — Anki makes c1, c2, … into separate cards.
  const clozeIdx = isClozeModel(model, values)
    ? values.findIndex((v) => CLOZE_DETECT.test(v || ''))
    : -1;
  if (clozeIdx >= 0) {
    const src = values[clozeIdx];
    const ci = findField(names, EX_RE, new Set([clozeIdx]));
    const exRaw = ci >= 0 ? stripHtml(values[ci] || '') : '';
    const cards: ImportCardPayload[] = [];
    for (const k of clozeNumbers(src)) {
      const { front, back } = clozeCard(src, k);
      const word = stripHtml(front);
      if (word === '') continue;
      const { article, base } = splitArticle(word);
      const card: ImportCardPayload = { word, article, base, tr: stripHtml(back), level: null, type: null };
      if (exRaw) card.ex = exRaw;
      if (cardTags.length) card.tags = cardTags;
      cards.push(card);
    }
    return cards;
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
  if (word === '') return []; // genuinely empty note: skip
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

  const { article, base } = splitArticle(word);
  const card: ImportCardPayload = {
    word,
    article,
    base,
    tr: ti >= 0 ? stripHtml(values[ti] || '') : '',
    level: li >= 0 ? clampLevel(stripHtml(values[li] || '')) : null,
    type: null,
  };
  const ex = ei >= 0 ? stripHtml(values[ei] || '') : '';
  const ipa = ii >= 0 ? stripHtml(values[ii] || '') : '';
  if (ex) card.ex = ex;
  if (ipa) card.ipa = ipa;
  if (cardTags.length) card.tags = cardTags;
  return [card];
}

/** Map a whole notes table to card payloads (one note may yield 0..N cards). */
export function buildApkgPayload(notes: AnkiNoteRow[], models: AnkiModelMap): ImportCardPayload[] {
  const out: ImportCardPayload[] = [];
  for (const n of notes) out.push(...mapAnkiNote(n.flds, n.tags, models[n.mid]));
  return out;
}

/**
 * Map the notes table AND partition the cards by subdeck. Returns the same flat
 * `payload` buildApkgPayload would (so nothing regresses when the caller ignores
 * sections) PLUS one `ImportSection` per distinct deck the notes fall into.
 *
 * A note is placed by `noteDid[note.id]` (nid → home deck id, resolved by the
 * caller from the cards table); a note with no known did — or a did with no name
 * — falls into a single '(Other)' bucket so the sections always PARTITION every
 * mapped card (union of section payloads === flat payload, same order/content).
 * Empty decks (e.g. an unused 'Default') carry no cards and are dropped.
 *
 * Pure + Hermes-safe: no normalize/replaceAll/lookbehind, no Date/Math.random,
 * a plain a<b comparator (not localeCompare).
 */
export function groupNotesBySection(
  notes: AnkiNoteRow[],
  noteDid: Record<string, string>,
  deckNames: Record<string, string>,
  models: AnkiModelMap,
): { payload: ImportCardPayload[]; sections: ImportSection[] } {
  const payload: ImportCardPayload[] = [];
  const byDid = new Map<string, ImportSection>();

  for (const n of notes) {
    const cards = mapAnkiNote(n.flds, n.tags, models[n.mid]);
    if (cards.length === 0) continue;
    for (const c of cards) payload.push(c);

    // Resolve the note's home deck; unknown did or unnamed deck → '(Other)'.
    const rawDid = noteDid[n.id ?? ''];
    const hasName = rawDid !== undefined && typeof deckNames[rawDid] === 'string';
    const did = hasName ? rawDid : '';
    const name = hasName ? deckNames[rawDid] : '(Other)';

    let section = byDid.get(did);
    if (!section) {
      section = { did, name, path: name.split('::').map((s) => s.trim()), payload: [] };
      byDid.set(did, section);
    }
    for (const c of cards) section.payload.push(c);
  }

  const sections = Array.from(byDid.values()).filter((s) => s.payload.length > 0);
  // Plain string comparator (Hermes lacks a reliable Intl/localeCompare).
  sections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { payload, sections };
}
