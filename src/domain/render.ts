/**
 * Card faces from notes (spec §6.2, `renderFace`). A card has no text of its
 * own in the note model: its text is DERIVED from its note, its card type
 * and its direction (`ord`), every time it is drawn.
 *
 *   renderFace(note, germanVerbs, 1)   // the "EN-DE" direction
 *     → prompt  [Meaning, CaseInfo]             (question side; first = headline)
 *       answer  [Verb, Conjugation, Perfekt …]  (revealed side; first = headline)
 *       badges  [Level, Tags]                   (pills on the top row)
 *
 * How a face is built:
 *   - The template of `ord` gives the fields of each side, in order
 *     (roles.ts builds templates from Anki's qfmt/afmt).
 *   - A field with role 'badge' is never on a side: every non-empty badge
 *     field is a pill in `badges`. A field with role 'hidden' is never shown.
 *   - EMPTY fields are skipped (spec §6.2 "empty fields are skipped"), so the
 *     first block of a side is always something to show. A field that holds
 *     only a placeholder dash ("-", "–", "—") counts as empty too: Anki decks
 *     often put a dash where there is nothing to say ("GRAMMAR –" was shown
 *     on both sides before, walkthrough L4). See isDashOnly.
 *   - Each block's `label` is the field's display label (fieldDisplayLabel):
 *     FieldDef.label, else the field name made readable ("VerbForms" →
 *     "Verb Forms", "MarankiExample" → "Example"; walkthrough L3/R6).
 *   - Each field's raw HTML goes through the safe subset (htmlLines.ts).
 *   - Cloze (kind 'cloze', ord = cloze number − 1): the prompt shows the text
 *     with deletion k as "[…]" (or "[hint]"); the answer shows it again with
 *     deletion k in bold, then the other answer fields (Extra) as rows. The
 *     markup is read by cloze.ts, the one cloze parser ({{c1,2::…}} belongs
 *     to cards 1 and 2; {{c0::…}} to no card, so it shows as plain text).
 *   - A DICTATION card ("listen, then type the word": Anki qfmt
 *     '{{tts de_DE:Word}}{{type:Word}}') asks nothing it may show: the field
 *     it reads aloud is the answer it types. Its question would be blank, and
 *     the speaker button would have nothing to read. So when the template
 *     shows no field on the question and has a typing field, the question
 *     gets ONE speaker block for that field:
 *       lines  [[ '🔊' ]]          what the card shows — never the word;
 *       plain  'die Stunde'        what read-aloud speaks (with `lang`, de-DE);
 *       promptPlain '🔊'           rows, snackbars and the Today card show no answer either.
 *     A screen draws a block's `lines`; it reads `plain` of a speaker block
 *     only to speak it (isSpeakerBlock tells such a block apart). The 🔊
 *     button speaks `speechOf(face, side)` (face.ts): the headline's `plain`
 *     and `lang`, so it says "die Stunde", never the name of the emoji. A–Z
 *     sorts by `faceSortKey(face)` (face.ts): by the word, not by '🔊'.
 *
 * Cache: one entry per Note OBJECT (a WeakMap), holding the faces of every
 * ord. Siblings (the other directions of the same note) read the same entry
 * and share the same FieldBlock objects, so they can never disagree. The
 * store never edits a note in place (a changed note is a new object), so a
 * changed note gets new faces. A changed card type (a new object) or other
 * deck languages also start a fresh entry.
 *
 * Pure: no React, no I/O.
 */
import { clozeAnswers, clozeSide, hasCloze } from './cloze';
import { htmlToLines, htmlToPlain, linesToPlain } from './htmlLines';
import type { CardFace, Deck, FieldBlock, FieldDef, Inline, Note, NoteType, TemplateDef } from './model';

/** The deck values used as a read-aloud fallback (spec §6.8). */
export type LangFallback = Pick<Deck, 'language' | 'meaningLanguage'>;

/* ------------------------------------------------------------ languages */

/**
 * The read-aloud language of a field (spec §6.8):
 *   1. `FieldDef.lang` (from {{tts}}, the mapping step, a pack or the card-type editor);
 *   2. only for NON-Anki card types (made in the app or from CSV: no
 *      `source.ankiMid`): `deck.language` for term/example fields,
 *      `deck.meaningLanguage` for meaning/exampleMeaning fields;
 *   3. none → undefined (the device voice).
 *
 * WHY rule 2 skips Anki types: an Anki card type says its languages in its
 * templates. So 906 English grammar questions in a German deck are never
 * read with a German voice.
 */
export function resolveFieldLang(
  def: FieldDef,
  type: Pick<NoteType, 'source'>,
  deck?: LangFallback | null,
): string | undefined {
  if (def.lang) return def.lang;
  if (!deck || type.source?.ankiMid) return undefined;
  if (def.role === 'term' || def.role === 'example') return deck.language || undefined;
  if (def.role === 'meaning' || def.role === 'exampleMeaning') return deck.meaningLanguage || undefined;
  return undefined;
}

/* --------------------------------------------------------- field labels */

/**
 * Name prefixes that tools (Maranki's own deck builder) put in front of a
 * field name to keep it apart from the deck's own fields. They mean nothing
 * to the learner, so a label never shows them: "MarankiExample" → "Example".
 */
export const APP_FIELD_PREFIXES: readonly string[] = ['Maranki'];

/* Letter classes without Unicode property escapes (Hermes-safe): ASCII plus
 * the Latin-1 letters, so "ÜbungText" and "BeispielSätze" split too. */
const UPPER = /^[A-ZÀ-ÖØ-Þ]$/;
const LOWER = /^[a-zß-öø-ÿ]$/;
const isUpper = (ch: string) => UPPER.test(ch);
const isLower = (ch: string) => LOWER.test(ch);

/**
 * The parts of one CamelCase word: "VerbForms" → ["Verb", "Forms"],
 * "IPAText" → ["IPA", "Text"]. A part is never shorter than 2 letters, so
 * "iPhone" stays one word.
 */
function camelParts(word: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i < word.length; i++) {
    const prev = word[i - 1];
    const ch = word[i];
    const next = word[i + 1] ?? '';
    // "bF" in "VerbForms", or the end of a run of capitals ("AT" in "IPAText").
    const hump = (isLower(prev) && isUpper(ch)) || (isUpper(prev) && isUpper(ch) && isLower(next));
    if (hump && i - start >= 2) {
      parts.push(word.slice(start, i));
      start = i;
    }
  }
  parts.push(word.slice(start));
  return parts;
}

/**
 * A field name made readable, for a field that has no label of its own
 * (walkthrough L3 / R6):
 *   - a known app prefix is dropped ("MarankiExample" → "Example");
 *   - CamelCase and snake_case names become words ("VerbForms" → "Verb
 *     Forms", "CaseInfo" → "Case Info", "example_translation" → "Example
 *     translation"). Each word keeps its own capitals (a German noun stays
 *     a capital: "BeispielSätze" → "Beispiel Sätze"); only the first letter
 *     becomes a capital;
 *   - a name that is already words ("Back Extra", "Example sentence") or one
 *     word ("Front", "IPA") comes back unchanged.
 * Never empty: a name that is only the prefix ("Maranki") stays as it is.
 */
export function humanizeFieldName(name: string): string {
  const original = String(name ?? '');
  let text = original.trim();
  let changed = false;

  // 1. A known app prefix, followed by the real name ("MarankiExample", "Maranki_Notes").
  for (const prefix of APP_FIELD_PREFIXES) {
    if (text.length <= prefix.length || text.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) continue;
    const rest = text.slice(prefix.length);
    const first = rest[0];
    if (!isUpper(first) && !/[\s_\-.]/.test(first)) continue; // "Marankis" is a word, not a prefix
    const trimmed = rest.replace(/^[\s_\-.]+/, '');
    if (trimmed !== '') {
      text = trimmed;
      changed = true;
    }
    break;
  }

  // 2. snake_case → words.
  if (/_/.test(text)) {
    text = text.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    changed = true;
  }

  // 3. CamelCase → words; each keeps its case, the first letter becomes a capital.
  const words = text.split(' ').filter((w) => w !== '');
  const out: string[] = [];
  for (const word of words) {
    const parts = camelParts(word);
    if (parts.length > 1) changed = true;
    out.push(...parts);
  }
  if (!changed || out.length === 0) return original;
  const joined = out.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * The label a field shows on cards, in the Card sheet and to a screen
 * reader: FieldDef.label when it has one, else the readable field name
 * (humanizeFieldName). The internal name ("MarankiExample") is never shown.
 *
 *   fieldDisplayLabel({ name: 'Prateritum', label: 'Präteritum' }) → 'Präteritum'
 *   fieldDisplayLabel({ name: 'MarankiExample' })                  → 'Example'
 */
export function fieldDisplayLabel(field: Pick<FieldDef, 'name' | 'label'>): string {
  const label = typeof field.label === 'string' ? field.label.trim() : '';
  return label !== '' ? label : humanizeFieldName(field.name);
}

/* ------------------------------------------------------ placeholder dashes */

/** One or more dashes: hyphen-minus, the Unicode hyphens and dashes (U+2010–2015) and the minus sign. */
const DASHES_ONLY = /^[-\u2010-\u2015\u2212]+$/;

/**
 * True when a field's text is only a placeholder dash ("-", "–", "—", "--",
 * "- -"): Anki decks put a dash where a value is missing. Such a field is
 * empty for the card: it is skipped on both sides (walkthrough L4).
 *
 *   isDashOnly('–')    → true
 *   isDashOnly(' — ')  → true
 *   isDashOnly('-n')   → false   (a real value: a plural ending)
 *   isDashOnly('')     → false   (empty is empty; this asks about dashes)
 */
export function isDashOnly(text: string): boolean {
  const squeezed = String(text ?? '').replace(/\s+/g, '');
  return squeezed !== '' && DASHES_ONLY.test(squeezed);
}

/** True when the lines show nothing but a placeholder dash (an image or a sound is always a value). */
function isPlaceholder(lines: Inline[][]): boolean {
  for (const line of lines) for (const part of line) if (part.t !== 'text') return false;
  return isDashOnly(linesToPlain(lines));
}

/* ---------------------------------------------------------------- cloze */

/*
 * The cloze helpers live in cloze.ts (the ONE cloze parser). They are also
 * exported from here, so older imports of './render' keep working; new code
 * imports from './cloze'.
 */
export { clozeAnswers, clozeNumbers, clozeSide, hasCloze } from './cloze';

/* ---------------------------------------------------------------- faces */

/** What a speaker block of a dictation question shows instead of its text (see the file header). */
export const SPEAKER_PROMPT = '🔊';

/** The lines of a speaker block: one line with the speaker, nothing else. */
function speakerLines(): Inline[][] {
  return [[{ t: 'text', text: SPEAKER_PROMPT }]];
}

/**
 * True for the speaker block of a dictation question: it SHOWS only the
 * speaker, and its `plain` is the hidden text that read-aloud speaks.
 */
export function isSpeakerBlock(block: FieldBlock): boolean {
  const line = block.lines.length === 1 ? block.lines[0] : null;
  const only = line && line.length === 1 ? line[0] : null;
  return only !== null && only.t === 'text' && only.text === SPEAKER_PROMPT && block.plain !== SPEAKER_PROMPT;
}

/** The cached faces of one note. */
interface Entry {
  type: NoteType;
  /** The deck languages the blocks were built with ('' = none used). */
  langKey: string;
  faces: Map<number, CardFace>;
  /** Shared blocks by field index: undefined = not built yet, null = the field is empty. */
  blocks: (FieldBlock | null | undefined)[];
}

const cache = new WeakMap<Note, Entry>();

/** Only non-Anki card types read the deck languages, so only they depend on them. */
function langKeyOf(type: NoteType, deck: LangFallback | null | undefined): string {
  if (!deck || type.source?.ankiMid) return '';
  return `${deck.language ?? ''}|${deck.meaningLanguage ?? ''}`;
}

/** A block for field `i` with these lines, or null when the lines are empty or only a placeholder dash. */
function makeBlock(
  i: number,
  def: FieldDef,
  lines: Inline[][],
  type: NoteType,
  deck: LangFallback | null | undefined,
): FieldBlock | null {
  if (lines.length === 0 || isPlaceholder(lines)) return null;
  const block: FieldBlock = {
    field: i,
    label: fieldDisplayLabel(def),
    role: def.role,
    lines,
    plain: linesToPlain(lines),
  };
  const lang = resolveFieldLang(def, type, deck);
  if (lang) block.lang = lang;
  return block;
}

/** The parts of a card type that decide which fields are on which side. */
type SideShape = Pick<NoteType, 'kind' | 'fields' | 'templates' | 'sortField'>;

/** The template of `ord`. A cloze type has one template for every ord. */
function templateFor(type: SideShape, ord: number): TemplateDef {
  const found =
    type.kind === 'cloze' ? type.templates[0] : type.templates.find((t) => t.ord === ord) ?? type.templates[0];
  if (found) return found;
  // No template at all (damaged data): the sort field asks, every other field answers.
  const sort = type.sortField >= 0 && type.sortField < type.fields.length ? type.sortField : 0;
  return {
    ord: 0,
    name: '',
    prompt: [sort],
    answer: type.fields.map((_, i) => i).filter((i) => i !== sort),
  };
}

/** Field indexes in order, without repeats and without indexes outside the type. */
function cleanIndexes(indexes: readonly number[], keep: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (const i of indexes) {
    if (keep(i) && !out.includes(i)) out.push(i);
  }
  return out;
}

function notNull<T>(x: T | null): x is T {
  return x !== null;
}

/** True when field `i` exists and may be on a side (badges are pills; hidden fields are never shown). */
function onSideOf(fields: SideShape['fields']): (i: number) => boolean {
  return (i) =>
    Number.isInteger(i) && i >= 0 && i < fields.length && fields[i].role !== 'badge' && fields[i].role !== 'hidden';
}

/**
 * True when field `i` shows on the cards of this type: a badge (a pill on the
 * top row), or a field that a direction's question or answer names. False for
 * a hidden field, and for a field that no direction names — for example a
 * field a newer deck file dropped, kept only for the notes that still have
 * text in it (plan.ts upgradeNoteType). The card editor says so under it.
 *
 *   fieldShownOnCard(vocabulary, 0)                 // Word → true
 *   fieldShownOnCard(vocabularyWithKept, keptIndex) // MarankiExample → false
 */
export function fieldShownOnCard(type: SideShape, i: number): boolean {
  if (!Number.isInteger(i) || i < 0 || i >= type.fields.length) return false;
  const role = type.fields[i].role;
  if (role === 'badge') return true;
  if (role === 'hidden') return false;
  const templates = type.kind === 'cloze' || type.templates.length === 0 ? [templateFor(type, 0)] : type.templates;
  return templates.some((t) => t.prompt.includes(i) || t.answer.includes(i));
}

/**
 * The fields of a cloze card type in which renderFace hides deletions: the
 * question fields of its template, without badges and hidden fields, in
 * order. (A type with no template asks its sort field.)
 *
 * addNote / editNote (noteOps.clozeOrds) and the import guess
 * (roles.suggestMapping) read the cloze numbers of THESE fields only. So a
 * card is made for a number exactly when its face can hide that number:
 * the question is never blank or unchanged.
 */
export function clozeFields(type: SideShape): number[] {
  return cleanIndexes(templateFor(type, 0).prompt, onSideOf(type.fields));
}

/**
 * The speaker block of a dictation question (see the file header), or null:
 * only for a template with a typing field whose text is not empty. It reads
 * aloud the typing field; it shows only the speaker. Its label, role and
 * `lang` are the field's own (the language comes from {{tts de_DE:…}}).
 */
function speakerBlock(
  template: TemplateDef,
  fieldCount: number,
  shared: (i: number) => FieldBlock | null,
): FieldBlock | null {
  const i = template.typeField;
  if (i === undefined || !Number.isInteger(i) || i < 0 || i >= fieldCount) return null;
  const field = shared(i);
  if (!field || field.plain === '') return null;
  const block: FieldBlock = { field: i, label: field.label, role: field.role, lines: speakerLines(), plain: field.plain };
  if (field.lang) block.lang = field.lang;
  return block;
}

/** Build (no cache) the face of direction `ord`. */
function buildFace(
  note: Note,
  type: NoteType,
  ord: number,
  deck: LangFallback | null | undefined,
  entry: Entry,
): CardFace {
  const fields = type.fields;
  const raw = (i: number) => {
    const value = note.fields[i];
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  };
  /** The shared block of field i (built once per note). */
  const shared = (i: number): FieldBlock | null => {
    let block = entry.blocks[i];
    if (block === undefined) {
      block = makeBlock(i, fields[i], htmlToLines(raw(i)), type, deck);
      entry.blocks[i] = block;
    }
    return block;
  };
  const onSide = onSideOf(fields);

  const template = templateFor(type, ord);
  // For a cloze type this is clozeFields(type): the same fields the cards are made from.
  const promptIdx = cleanIndexes(template.prompt, onSide);
  const answerIdx = cleanIndexes(template.answer, (i) => onSide(i) && !promptIdx.includes(i));
  const badges = fields.map((f, i) => (f.role === 'badge' ? shared(i) : null)).filter(notNull);

  if (type.kind !== 'cloze') {
    const prompt = promptIdx.map(shared).filter(notNull);
    const answer = answerIdx.map(shared).filter(notNull);
    // Only when the TEMPLATE shows no field on the question (a dictation card). A
    // note whose question field is just empty keeps its blank question: reading
    // its typing field aloud would read out the answer of another kind of card.
    const speaker = promptIdx.length === 0 ? speakerBlock(template, fields.length, shared) : null;
    if (speaker) {
      return { promptPlain: SPEAKER_PROMPT, answerPlain: answer[0]?.plain ?? '', badges, prompt: [speaker], answer };
    }
    return {
      promptPlain: prompt[0]?.plain ?? '',
      answerPlain: answer[0]?.plain ?? '',
      badges,
      prompt,
      answer,
    };
  }

  // Cloze: card k hides deletion k on the prompt and shows it in bold on the answer.
  const k = ord + 1;
  const prompt: FieldBlock[] = [];
  const revealed: FieldBlock[] = [];
  const answers: string[] = [];
  for (const i of promptIdx) {
    const text = raw(i);
    if (!hasCloze(text)) {
      const block = shared(i);
      if (block) prompt.push(block);
      continue;
    }
    const q = makeBlock(i, fields[i], htmlToLines(clozeSide(text, k, 'prompt')), type, deck);
    const a = makeBlock(i, fields[i], htmlToLines(clozeSide(text, k, 'answer')), type, deck);
    if (q) prompt.push(q);
    if (a) revealed.push(a);
    for (const answer of clozeAnswers(text, k)) {
      const plain = htmlToPlain(answer);
      if (plain) answers.push(plain);
    }
  }
  const answer = [...revealed, ...answerIdx.map(shared).filter(notNull)];
  return {
    promptPlain: prompt[0]?.plain ?? '',
    // For rows and snackbars, the deletion's answer ("Paris") says more than the whole text.
    answerPlain: answers.length > 0 ? answers.join(', ') : answer[0]?.plain ?? '',
    badges,
    prompt,
    answer,
  };
}

/**
 * The face of the card with direction `ord` of `note` (card type `type`).
 * `deck` (optional) gives the read-aloud fallback languages of §6.8 to
 * non-Anki card types; see resolveFieldLang.
 *
 * Cached per note object: the same (note, type, ord, deck languages) always
 * returns the same face object, and sibling faces share their FieldBlocks.
 */
export function renderFace(
  note: Note,
  type: NoteType,
  ord: number,
  deck?: LangFallback | null,
): CardFace {
  const langKey = langKeyOf(type, deck);
  let entry = cache.get(note);
  if (!entry || entry.type !== type || entry.langKey !== langKey) {
    entry = { type, langKey, faces: new Map(), blocks: [] };
    cache.set(note, entry);
  }
  let face = entry.faces.get(ord);
  if (!face) {
    face = buildFace(note, type, ord, deck, entry);
    entry.faces.set(ord, face);
  }
  return face;
}
