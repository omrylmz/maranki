/**
 * Card faces — the READ SEAM for card text (spec §6.2, units W1-5 and W3-4).
 *
 * A `CardFace` (type in ./model.ts) is everything a screen shows of a card:
 * the question side (`prompt`), the answer side (`answer`), top-row pills
 * (`badges`) and two one-line strings for rows and snackbars (`promptPlain`,
 * `answerPlain`). Each side is a list of `FieldBlock`s, and each block has a
 * ROLE ('term', 'meaning', 'example', 'detail' …) that decides its style.
 *
 * WHY a seam: screens never read `card.front` / `card.back` / `card.example` /
 * `card.notes`. They call `useFaces()` (src/store/faces.ts) and draw the
 * face. A guard test (face.test.ts) keeps direct reads out of src/app and
 * src/components.
 *
 * From wave 3 a card has no text of its own: the text lives in its NOTE.
 * `faceOfCard(card, library)` finds the card's note and card type and calls
 * `renderFace(note, type, card.ord)` (render.ts, cached per note object, so
 * siblings share their blocks and can never disagree). `facesFor(library,
 * decks)` is the same as ONE function per library: what `useFaces()` returns.
 *
 * `legacyFace(card)` is the face of a card that still CARRIES its text (the
 * schema-2 shape: front/back/example/notes). It is the plain-text twin of the
 * built-in "Basic" card type (builtinTypes.ts), so such a card looks the same
 * as the Basic note it is migrated to:
 *
 *   field 0 Front   (term)    → prompt  (headline)
 *   field 1 Back    (meaning) → answer  (headline)
 *   field 2 Example (example) → answer
 *   field 3 Notes   (detail)  → answer
 *
 * faceOfCard falls back to it when a card has no note in the library (a card
 * from before the note model, or damaged data). A v3 card has none of these
 * keys, so it gets an empty face — never a crash.
 *
 * Missing text becomes ''. Empty blocks stay in a legacy face; screens skip
 * them with `blockHasContent`.
 *
 * Two readers of a face that every screen must share (so two screens never
 * disagree about the same card):
 *   - `speechOf(face, side)`  what the 🔊 button speaks (spec §6.8);
 *   - `faceSortKey(face)`     the A–Z sort key (spec §9.2).
 * Both read the HEADLINE block (the first block of a side). For a dictation
 * card that is the speaker block: it shows only '🔊', and its `plain` is the
 * word. So the speaker reads the word, and A–Z sorts by the word — never by
 * the '🔊' sign.
 *
 * `faceHeadline(card, library, decks)` (unit P1) gives the A–Z key and the
 * headline text of a card WITHOUT building its whole face: it reads only the
 * question fields, until the first one with something to show. The release
 * build needed 685 ms for the first A–Z sort of 16,260 cards, because every
 * face was built with all its answer fields (long HTML examples). The values
 * are exactly the ones of the whole face (face.test.ts checks it on every
 * card of the real decks and of random notes):
 *
 *   faceHeadline(card, index, decks).sortKey === faceSortKey(faceOfCard(card, index, decks))
 *
 * Pure: no React. Faces are cached per card OBJECT (a WeakMap), so asking
 * again for the same card is free. A changed card is a new object (the store
 * never edits a card in place), so it gets a new face.
 */
import { builtinType } from './builtinTypes';
import { clozeSide, hasCloze } from './cloze';
import { htmlToLines, linesToPlain } from './htmlLines';
import { termHelpers } from './lang';
import type { LibraryIndex } from './libraryIndex';
import type { Card, CardFace, FieldBlock, FieldDef, FieldRole, Id, Inline, Note, NoteType, TemplateDef } from './model';
import { isDashOnly, type LangFallback, renderFace, resolveFieldLang } from './render';
import { foldText, oneLine } from './text';

/**
 * The text keys legacyFace reads (the schema-2 card). All optional and of
 * any type: missing text → '', a damaged number → its text.
 */
export interface LegacyTextCard {
  front?: unknown;
  back?: unknown;
  example?: unknown;
  notes?: unknown;
}

/**
 * The built-in Basic card type, built once. Its fields and its one template
 * ("Front → Back": prompt [0], answer [1, 2, 3]) decide the blocks of a legacy face.
 */
const BASIC = builtinType('basic', 0);
const BASIC_TEMPLATE = BASIC.templates[0];

/* --------------------------------------------------------------- helpers */

/**
 * Any stored value → text. A string stays as it is; null/undefined → '';
 * anything else (a damaged number …) → String(x).
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value == null ? '' : String(value);
}

/**
 * Plain text → lines of inlines, one line per line break.
 *   'ich bin\ndu bist' → [[{t:'text', text:'ich bin'}], [{t:'text', text:'du bist'}]]
 *   ''                 → []
 * An empty line inside the text stays as an empty line ([]).
 */
export function textLines(text: string): Inline[][] {
  if (text === '') return [];
  return text
    .split(/\r\n|\r|\n/)
    .map((line): Inline[] => (line === '' ? [] : [{ t: 'text', text: line }]));
}

/**
 * The text of a block, with its line breaks (images and sounds are left out).
 * This is what a plain-text renderer draws.
 *   [[ich bin], [du bist]] → 'ich bin\ndu bist'
 */
export function blockText(block: FieldBlock | undefined): string {
  if (!block) return '';
  return block.lines
    .map((line) => line.map((part) => (part.t === 'text' ? part.text : '')).join(''))
    .join('\n');
}

/**
 * True when a block has something to show: visible text, an image or a sound.
 * Screens skip empty Example / Notes blocks with this (spec §6.2 "empty
 * fields are skipped").
 */
export function blockHasContent(block: FieldBlock): boolean {
  return block.lines.some((line) =>
    line.some((part) => part.t !== 'text' || part.text.trim() !== ''),
  );
}

/**
 * The blocks a screen draws AFTER the headline (the first block) of one side:
 * every block that has content, except 'hidden' ones (stored and searchable,
 * never shown). For a Basic answer side that is [Example, Notes] minus the empty ones.
 */
export function blocksAfterHeadline(blocks: FieldBlock[]): FieldBlock[] {
  return blocks.slice(1).filter((b) => b.role !== 'hidden' && blockHasContent(b));
}

/** A side of a card: the question ('prompt') or the revealed answer ('answer'). */
export type FaceSide = 'prompt' | 'answer';

/** What read-aloud speaks: the text, and its BCP-47 language (none = the device voice). */
export interface SpokenText {
  text: string;
  lang?: string;
}

/**
 * What the 🔊 button speaks for one side of a card (spec §6.8: "🔊 speaks
 * the headline block of the visible side"): the `plain` text and `lang` of
 * the side's FIRST block.
 *   - A dictation question: its one block is the speaker block. It SHOWS only
 *     '🔊', and its `plain` is the hidden word, so the word is spoken
 *     (never the name of the emoji).
 *   - A side with no block (an empty field): its one-line text, no language.
 *
 *   speechOf(dictationFace, 'prompt') → { text: 'die Stunde', lang: 'de-DE' }
 *   speechOf(basicFace, 'answer')     → { text: 'the hour' }
 */
export function speechOf(face: CardFace, side: FaceSide): SpokenText {
  const head = face[side][0];
  if (!head) return { text: side === 'prompt' ? face.promptPlain : face.answerPlain };
  return head.lang ? { text: head.plain, lang: head.lang } : { text: head.plain };
}

/**
 * The A–Z sort key of a card (spec §9.2), the ONE rule for every A–Z sort
 * (the practice sort in scope.ts and the old Library in browseFilter.ts):
 *   - the text of the question's headline block — for a dictation card that
 *     is the word it reads aloud, not the '🔊' it shows;
 *   - a 'term' field uses the rules of its language: a German term sorts by
 *     the word, not by its article ("die Abfahrt" under A);
 *   - any other text is only folded (lower case, no accents).
 *
 *   faceSortKey(face of the German term 'die Abfahrt') → 'abfahrt'
 *   faceSortKey(face of the meaning 'The Hour')         → 'the hour'
 */
export function faceSortKey(face: CardFace): string {
  const head = face.prompt[0];
  const helpers = termHelpers(head?.role === 'term' ? head.lang : null);
  return helpers.sortKey(head ? head.plain : face.promptPlain);
}

/** One field of a card type + its text → a plain-text block. */
function plainBlock(field: number, def: FieldDef, text: string): FieldBlock {
  const block: FieldBlock = {
    field,
    label: def.label ?? def.name,
    role: def.role,
    lines: textLines(text),
    plain: oneLine(text),
  };
  if (def.lang) block.lang = def.lang;
  return block;
}

/* ----------------------------------------------------------- legacy face */

const cache = new WeakMap<object, CardFace>();

/** Build (no cache) the face of a card that carries its own text. */
function buildLegacyFace(card: LegacyTextCard): CardFace {
  // Aligned with the Basic type's fields: 0 Front · 1 Back · 2 Example · 3 Notes.
  const texts = [asText(card.front), asText(card.back), asText(card.example), asText(card.notes)];
  const blocks = (indexes: number[]) =>
    indexes.map((i) => plainBlock(i, BASIC.fields[i], texts[i]));
  const prompt = blocks(BASIC_TEMPLATE.prompt);
  const answer = blocks(BASIC_TEMPLATE.answer);
  return {
    promptPlain: prompt[0]?.plain ?? '',
    answerPlain: answer[0]?.plain ?? '',
    badges: [],
    prompt,
    answer,
  };
}

/**
 * The face of a card that carries its own text (the schema-2 card): prompt
 * [Front as term], answer [Back as meaning, Example, Notes]; no badges.
 * Missing text → ''. Any object is accepted: a card without these keys (a v3
 * card whose note is missing) gets an empty face.
 *
 *   legacyFace({ front: 'die Stunde', back: 'the hour' }).promptPlain → 'die Stunde'
 *
 * Cached per card object: the same object always returns the same face object.
 */
export function legacyFace(card: object): CardFace {
  const hit = cache.get(card);
  if (hit) return hit;
  const face = buildLegacyFace(card);
  cache.set(card, face);
  return face;
}

/* ------------------------------------------------------- faces from notes */

/**
 * What faceOfCard reads of a card: its deck (for the read-aloud languages of
 * §6.8), its note and its direction. Every v3 Card fits. `noteId` and `ord`
 * are optional, so a card from before the note model (it has neither) fits
 * too: it is drawn from its own text (legacyFace).
 */
export type FaceCard = Pick<Card, 'deckId'> & Partial<Pick<Card, 'noteId' | 'ord'>>;

/** The part of the library index (§4.4) that faces need: notes and card types by id. */
export type FaceLibrary = Pick<LibraryIndex, 'noteById' | 'typeById'>;

/** Turns a card into its face (the text to draw, by field role). */
export type FaceOf = (card: FaceCard) => CardFace;

/**
 * The face of one card, rendered from its note (spec §6.2):
 *   renderFace(note, card type, card.ord, deck)
 * The deck gives the read-aloud fallback languages of card types made in the
 * app (render.ts resolveFieldLang). A card without a note in `library` (no
 * noteId, an unknown note or an unknown card type) falls back to legacyFace(card).
 *
 *   faceOfCard(card, index, decks).promptPlain → 'die Stunde'
 */
export function faceOfCard(
  card: FaceCard,
  library: FaceLibrary | null | undefined,
  decks?: ReadonlyMap<Id, LangFallback> | null,
): CardFace {
  const note = card.noteId !== undefined ? library?.noteById.get(card.noteId) : undefined;
  const type = note ? library?.typeById.get(note.typeId) : undefined;
  if (!note || !type) return legacyFace(card);
  return renderFace(note, type, card.ord ?? 0, decks?.get(card.deckId) ?? null);
}

/** library → decks → its FaceOf, so one library always gives the SAME function. */
const facesCache = new WeakMap<FaceLibrary, WeakMap<ReadonlyMap<Id, LangFallback>, FaceOf>>();
/** The decks key when the caller has no decks. */
const NO_DECKS: ReadonlyMap<Id, LangFallback> = new Map();

/**
 * The card → face function of one library (what `useFaces()` returns).
 * The same (library, decks) always give the same function object, so it is
 * safe in React dependency lists. Faces are cached per note (renderFace) and
 * per legacy card (legacyFace), so calling it again is free.
 */
export function facesFor(library: FaceLibrary, decks?: ReadonlyMap<Id, LangFallback> | null): FaceOf {
  const deckKey = decks ?? NO_DECKS;
  let byDecks = facesCache.get(library);
  if (!byDecks) {
    byDecks = new WeakMap();
    facesCache.set(library, byDecks);
  }
  let fn = byDecks.get(deckKey);
  if (!fn) {
    fn = (card) => faceOfCard(card, library, deckKey);
    byDecks.set(deckKey, fn);
  }
  return fn;
}

/* ------------------------------------------------- the headline (A–Z key) */

/**
 * The question headline of a card, as lists use it (unit P1):
 *   plain        the headline's text: `face.prompt[0]?.plain ?? face.promptPlain`
 *                (for a dictation card: the word it reads aloud, not '🔊');
 *   plainFolded  the same text on one line, folded (lower case, no accents);
 *   sortKey      the A–Z key: exactly `faceSortKey(face)`.
 */
export interface FaceHeadline {
  plain: string;
  plainFolded: string;
  sortKey: string;
}

/** The parts of the headline block that the key needs: its text, role and language. */
interface HeadBlock {
  plain: string;
  role: FieldRole;
  lang?: string;
}

/** One note's headlines: by direction (ord), for one card type and one set of deck languages. */
interface HeadlineEntry {
  type: NoteType;
  langKey: string;
  byOrd: Map<number, FaceHeadline>;
}

/** Cached per note OBJECT, like renderFace: a changed note is a new object and gets new headlines. */
const headlineCache = new WeakMap<Note, HeadlineEntry>();
/** The headline of a card drawn from its own text (legacyFace), per face object. */
const legacyHeadlineCache = new WeakMap<CardFace, FaceHeadline>();

/**
 * The deck languages a card type reads (render.ts langKeyOf): only card types
 * made in the app or from CSV (no Anki model) read them, so only they depend on them.
 */
function headlineLangKey(type: NoteType, deck: LangFallback | null | undefined): string {
  if (!deck || type.source?.ankiMid) return '';
  return `${deck.language ?? ''}|${deck.meaningLanguage ?? ''}`;
}

/** The headline of a ready face (sortKey = faceSortKey(face)). */
function headlineOfFace(face: CardFace): FaceHeadline {
  const plain = face.prompt[0]?.plain ?? face.promptPlain;
  return { plain, plainFolded: foldText(oneLine(plain)), sortKey: faceSortKey(face) };
}

/**
 * The question template of direction `ord`, as render.ts templateFor finds it:
 * a cloze type has one template for every ord; a missing template falls back
 * to the first one; no template at all (damaged data) asks the sort field.
 */
function questionTemplate(type: NoteType, ord: number): Pick<TemplateDef, 'prompt' | 'typeField'> {
  const found =
    type.kind === 'cloze' ? type.templates[0] : type.templates.find((t) => t.ord === ord) ?? type.templates[0];
  if (found) return found;
  const sort = type.sortField >= 0 && type.sortField < type.fields.length ? type.sortField : 0;
  return { prompt: [sort] };
}

/**
 * The FIRST block of the question side of `ord` — the block renderFace puts
 * first in `face.prompt` — or null when the question has no block. The same
 * rules as render.ts buildFace, for the question side only:
 *   - the template's question fields, in order, without repeats, without
 *     fields that do not exist, badges and hidden fields;
 *   - an empty field, or one that holds only a placeholder dash, is skipped;
 *   - a template with no question field and a typing field (a dictation
 *     card) asks with the typing field's text (the speaker block);
 *   - cloze: a field with deletions shows deletion `ord + 1` hidden.
 * Only the fields up to the first one with something to show are read.
 */
function questionHead(note: Note, type: NoteType, ord: number, deck: LangFallback | null): HeadBlock | null {
  const fields = type.fields;
  const raw = (i: number): string => {
    const value = note.fields[i];
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  };
  /** The block of field i with this HTML, or null when it shows nothing (render.ts makeBlock). */
  const block = (i: number, html: string): HeadBlock | null => {
    const lines = htmlToLines(html);
    if (lines.length === 0) return null;
    const plain = linesToPlain(lines);
    // A placeholder: only text, and the text is only a dash (an image or a sound is always a value).
    let onlyText = true;
    for (const line of lines) for (const part of line) if (part.t !== 'text') onlyText = false;
    if (onlyText && isDashOnly(plain)) return null;
    const def = fields[i];
    const lang = resolveFieldLang(def, type, deck);
    return lang ? { plain, role: def.role, lang } : { plain, role: def.role };
  };
  const onSide = (i: number) =>
    Number.isInteger(i) && i >= 0 && i < fields.length && fields[i].role !== 'badge' && fields[i].role !== 'hidden';

  const template = questionTemplate(type, ord);
  const asked: number[] = [];
  for (const i of template.prompt) if (onSide(i) && !asked.includes(i)) asked.push(i);

  if (type.kind === 'cloze') {
    const k = ord + 1;
    for (const i of asked) {
      const text = raw(i);
      const head = hasCloze(text) ? block(i, clozeSide(text, k, 'prompt')) : block(i, text);
      if (head) return head;
    }
    return null;
  }
  for (const i of asked) {
    const head = block(i, raw(i));
    if (head) return head;
  }
  // A dictation card: no question field, a typing field with text (render.ts speakerBlock).
  if (asked.length === 0) {
    const i = template.typeField;
    if (i === undefined || !Number.isInteger(i) || i < 0 || i >= fields.length) return null;
    const head = block(i, raw(i));
    return head && head.plain !== '' ? head : null;
  }
  return null;
}

/**
 * The headline of one card (see FaceHeadline), without building its face.
 * Cached per note object and direction (and card type and deck languages,
 * like renderFace), so asking again is a lookup. A card without a note in
 * `library` is drawn from its own text (legacyFace), exactly like faceOfCard.
 *
 *   faceHeadline(card, index, decks).sortKey    // 'abfahrt' for "die Abfahrt"
 */
export function faceHeadline(
  card: FaceCard,
  library: FaceLibrary | null | undefined,
  decks?: ReadonlyMap<Id, LangFallback> | null,
): FaceHeadline {
  const note = card.noteId !== undefined ? library?.noteById.get(card.noteId) : undefined;
  const type = note ? library?.typeById.get(note.typeId) : undefined;
  if (!note || !type) {
    const face = legacyFace(card);
    let hit = legacyHeadlineCache.get(face);
    if (!hit) {
      hit = headlineOfFace(face);
      legacyHeadlineCache.set(face, hit);
    }
    return hit;
  }
  const ord = card.ord ?? 0;
  const deck = decks?.get(card.deckId) ?? null;
  const langKey = headlineLangKey(type, deck);
  let entry = headlineCache.get(note);
  if (!entry || entry.type !== type || entry.langKey !== langKey) {
    entry = { type, langKey, byOrd: new Map() };
    headlineCache.set(note, entry);
  }
  let hit = entry.byOrd.get(ord);
  if (!hit) {
    const head = questionHead(note, type, ord, deck);
    const plain = head ? head.plain : '';
    const helpers = termHelpers(head?.role === 'term' ? head.lang : null);
    hit = { plain, plainFolded: foldText(oneLine(plain)), sortKey: helpers.sortKey(plain) };
    entry.byOrd.set(ord, hit);
  }
  return hit;
}

/** The A–Z key of a card (spec §9.2): faceHeadline(…).sortKey, the same value as faceSortKey(faceOfCard(…)). */
export function faceSortKeyOf(
  card: FaceCard,
  library: FaceLibrary | null | undefined,
  decks?: ReadonlyMap<Id, LangFallback> | null,
): string {
  return faceHeadline(card, library, decks).sortKey;
}
