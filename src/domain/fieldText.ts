/**
 * Pure helpers of the card editor and the deck editor (spec §8.10, unit W3-6).
 * The two screens (src/app/card-editor.tsx, src/app/deck-editor.tsx) keep only
 * React state and layout; every rule they follow lives here, with tests.
 *
 * 1. Field text — what the learner edits vs what the note stores.
 *    A note field keeps Anki's RAW text, which may be HTML (spec §3.4). The
 *    editor shows raw HTML as text, but a line break is a real line break:
 *
 *      toEditable('ich bin<br>du bist')   → 'ich bin\ndu bist'
 *      fromEditable('ich <b>bin</b>\ndu') → 'ich <b>bin</b><br>du'
 *      fromEditable('Haus\nhouse')        → 'Haus\nhouse'    (plain text: "\n" is already a line)
 *      fromEditable('ArrayList<Integer>') → 'ArrayList&lt;Integer&gt;' (not HTML: the card shows it as typed)
 *      toEditable('ArrayList&lt;Integer&gt;') → 'ArrayList<Integer>'
 *      fromEditable('<div>a</div>\nb')    → '<div>a</div>\nb' (a block already ends the line: no <br>)
 *
 *    WHY two modes: the renderer (htmlLines.ts) reads a field WITH a tag as
 *    HTML (there "\n" is only a space, and <br> is a line) and a field WITHOUT
 *    a tag as plain text (there "\n" is a line). So `fromEditable` writes
 *    <br> only for an HTML field (the text has a tag, or the field had one
 *    before the edit). Both directions keep what the card SHOWS. `fieldsForSave` keeps an UNCHANGED field byte for byte (it never
 *    passes through the conversion), so opening and saving a note never
 *    rewrites the imported HTML.
 *
 * 2. Card types: `typeById`, `splitFields` (main fields + "More fields"),
 *    `missingFields` (what blocks Save), `carryFields` (values kept when the
 *    learner switches the card type), `cardTypeOptions` (the picker list).
 *
 * 3. Tags: `parseTagInput`, `tagSuggestions` ("suggestions from this deck",
 *    the ones that start with the word being typed), `pickSuggestion` (a
 *    tap finishes the half-typed word).
 *
 * 4. Decks: `sortDecks`, `noteIdsInDeck`, `lastUsedDeckId` (the deck a new
 *    card goes to when the caller gives none — spec §7 #50),
 *    `deckEditorStart` (new / edit / a deck that no longer exists).
 *
 * 5. Duplicates: `duplicateKey`, `duplicateIndex`, `findDuplicate`,
 *    `checksDuplicate` — the same-deck warning "“comer” is already in this
 *    deck" (same folded sort field, same card type, same deck; also when an
 *    edit moves the note into another deck).
 *
 * 6. Icons: `firstGlyph` — the deck editor's "Type any emoji" input keeps one
 *    emoji (a flag or a family emoji is ONE glyph made of several code points).
 *
 * Pure: no React, no clock. Hermes-safe: no lookbehind, no `replaceAll`, no
 * `Intl.Segmenter`.
 */
import { BUILTIN_TYPE_IDS, builtinKindOf, builtinType } from './builtinTypes';
import { clozeNumbers } from './cloze';
import { hasHtmlTags, htmlToLines } from './htmlLines';
import { fieldKey, plainText } from './libraryIndex';
import type { Card, Deck, FieldDef, Id, Note, NoteType, ReviewLogEntry } from './model';
import { cleanTags } from './noteOps';
import { clozeFields, fieldDisplayLabel } from './render';
import { foldText, plural } from './text';

/* ============================================================ 1. field text */

/**
 * The tags AFTER which the card already starts a new line ("block ends"):
 *   - every CLOSING block tag of htmlLines.ts (`BLOCK_TAGS`) without </pre>,
 *     which has its own token below: "</div>", "</p>", "</li>", "</tr>" …;
 *   - the <hr> tag ("<hr>", "<hr/>", "<hr class=…>"): it has no closing tag,
 *     and the renderer ends the line at it like at a closing block tag.
 * After a block end the next text is already on a new line on the card, so a
 * line break typed right after it must not become a <br> (that would draw an
 * extra empty line). fieldText.test.ts checks that each one really ends a
 * line in htmlToLines. (An OPENING block tag such as "<div>" is not in the
 * list: Anki writes an empty line as "<div><br></div>", and that field must
 * keep its <br> byte for byte when it is edited.)
 */
const BLOCK_END =
  '<\\/(?:address|article|aside|blockquote|center|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|section|summary|table|tbody|tfoot|thead|tr|ul)\\b[^<>]*>|<hr\\b[^<>]*>';

/**
 * Tokens of the raw → editable scan: an HTML comment (copied as it is: the
 * renderer drops it, so a "<pre>" inside it means nothing), a <pre> tag (open
 * or close; groups 1 and 2), a <br> tag (any spelling: <br>, <BR>, <br/>,
 * <br />), a block end (group 3: a closing block tag or <hr>), or one line
 * break (CRLF counts as one, like the renderer). The tag rule is the
 * renderer's: '<' + name + no '<' and no '>' + '>'. `\b` after the name:
 * "<bra>" is not a <br>, "<hra>" is not an <hr>. An unclosed comment runs to
 * the end (as in htmlLines).
 */
const RAW_TOKENS = new RegExp(
  `<!--[\\s\\S]*?(?:-->|$)|<(\\/?)pre\\b([^<>]*)>|<br\\b[^<>]*>|(${BLOCK_END})|\\r\\n|\\r|\\n`,
  'gi',
);

/** Tokens of the editable → raw scan: an HTML comment, a <pre> tag, a block end (group 3), or one line break. */
const EDIT_TOKENS = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|<(\\/?)pre\\b([^<>]*)>|(${BLOCK_END})|\\r\\n|\\r|\\n`, 'gi');

/** True for a comment token ("<!--…"). */
function isComment(token: string): boolean {
  return token.charCodeAt(1) === 33 /* ! */;
}

/* ---------------------------------------------- typed "<…>" that is not HTML */

/**
 * Every token the renderer (htmlLines.ts `HTML_TAG`) reads as markup: a
 * comment (to "-->" or to the end), or '<' + a letter, '/', '!' or '?' + no
 * '<' and no '>' + '>'. By this rule "List<Integer>" holds a tag.
 */
const MARKUP_TOKENS = /<!--[\s\S]*?(?:-->|$)|<[a-z!/?][^<>]*>/gi;

/** HTML elements that have no closing tag: one of them alone is real HTML. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** The HTML element names (HTML standard, plus the old ones Anki fields still use: font, center, big, tt …). */
const HTML_ELEMENTS: ReadonlySet<string> = new Set([
  ...VOID_ELEMENTS,
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'body', 'button',
  'canvas', 'caption', 'center', 'cite', 'code', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn',
  'dialog', 'dir', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'font', 'footer', 'form', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'html', 'i', 'iframe', 'ins', 'kbd', 'label',
  'legend', 'li', 'main', 'map', 'mark', 'marquee', 'math', 'menu', 'meter', 'nav', 'nobr', 'noscript', 'object',
  'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'script', 'search', 'section', 'select', 'slot', 'small', 'span', 'strike', 'strong', 'style', 'sub',
  'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', 'tr', 'tt', 'u', 'ul', 'var', 'video',
]);

/**
 * The element name of a tag token, as an HTML parser reads it: the text after
 * '<' or '</' up to white space, '/' or '>', in lower case.
 *   '<b class="x">' → 'b'   '</Div>' → 'div'   '<A, B>' → 'a,'   '<String, Integer>' → 'string,'
 */
function elementName(token: string): string {
  const start = token.charCodeAt(1) === 47 /* / */ ? 2 : 1;
  let end = start;
  while (end < token.length - 1) {
    const c = token.charCodeAt(end);
    if (c === 47 /* / */ || c === 32 || c === 9 || c === 10 || c === 12 || c === 13) break;
    end += 1;
  }
  return token.slice(start, end).toLowerCase();
}

/**
 * True when typed text holds REAL HTML, not just "<…>" that looks like a tag:
 *   - a comment, "<!doctype …>" or "<?…?>";
 *   - an HTML element that has no closing tag (<br>, <img …>, <hr> …), or a
 *     self-closing HTML element ("<pre/>");
 *   - an HTML element that is opened AND closed later ("<b>bin</b>").
 * Not real HTML: "ArrayList<Integer>", "Map<String, List<Integer>>",
 * "if a<b and c>d" (no "</b>"), "List<Object>" (no "</object>"), "<T>", a
 * JSX "<Foo />" — a coding card shows them as typed.
 *
 *   hasRealMarkup('ich <b>bin</b>')     → true
 *   hasRealMarkup('line 1<br>line 2')   → true
 *   hasRealMarkup('ArrayList<Integer>') → false
 *   hasRealMarkup('if a<b and c>d')     → false
 */
function hasRealMarkup(text: string): boolean {
  const opened = new Set<string>();
  MARKUP_TOKENS.lastIndex = 0;
  for (let m = MARKUP_TOKENS.exec(text); m !== null; m = MARKUP_TOKENS.exec(text)) {
    const token = m[0];
    const c1 = token.charCodeAt(1);
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) return true;
    const name = elementName(token);
    if (!HTML_ELEMENTS.has(name)) continue;
    if (VOID_ELEMENTS.has(name)) return true;
    if (c1 === 47 /* / */) {
      if (opened.has(name)) return true;
    } else if (token.charCodeAt(token.length - 2) === 47 /* "/>" */) {
      return true;
    } else {
      opened.add(name);
    }
  }
  return false;
}

/** Every '<' and '>' as an entity: "<" → "&lt;", ">" → "&gt;" (the text shows them as typed). */
function escapeAngles(text: string): string {
  return text.replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));
}

/**
 * A PLAIN raw field (no tag) as the learner typed it: "&lt;" and "&gt;" back
 * to "<" and ">" — only when saving that text gives back exactly this field
 * (fromEditable escapes it again). So the editor shows "ArrayList<Integer>",
 * like the card, and a save never changes the field. Anything else stays as
 * it is (old behaviour): "a &lt; b" (saving "a < b" would keep the bare "<"),
 * or "&lt;b&gt;x&lt;/b&gt;" (that is real HTML once decoded: it would turn bold).
 */
function decodeTypedAngles(raw: string): string {
  if (raw.indexOf('&lt;') === -1 && raw.indexOf('&gt;') === -1) return raw;
  const typed = raw.replace(/&lt;|&gt;/g, (entity) => (entity === '&lt;' ? '<' : '>'));
  return fromEditable(typed, false) === raw ? typed : raw;
}

/**
 * True when a raw field holds HTML (at least one real tag). The editor then
 * shows the note "Formatted text — edits keep line breaks".
 */
export function isFormatted(raw: string): boolean {
  return hasHtmlTags(raw ?? '');
}

/** A <pre> token: +1 when it opens, -1 when it closes, 0 for a self-closing "<pre/>". */
function preStep(slash: string, body: string): number {
  if (body.charCodeAt(body.length - 1) === 47 /* / */) return 0;
  return slash === '/' ? -1 : 1;
}

/**
 * Raw note field → the text the learner edits.
 *   - Plain text (no tag): unchanged. A "\n" is already a line. Only the
 *     "&lt;…&gt;" that fromEditable wrote for typed "<…>" shows as "<…>"
 *     again (decodeTypedAngles): toEditable('List&lt;T&gt;') → 'List<T>'.
 *   - HTML: every <br> becomes "\n". A raw line break in HTML is only white
 *     space, so it becomes one space (or nothing, next to other white space
 *     or at a line start — the card looks the same). Inside <pre> a raw line
 *     break IS a line, so it stays "\n" — except the one right after "<pre>",
 *     which the renderer does not show either (like a browser).
 *   - Right after a block end (a closing block tag "</div>", "</p>", "</li>",
 *     "</tr>", "</pre>" …, or an <hr>; outside <pre>) the card already starts
 *     a new line. There a raw line break is shown as "\n" (it is the line
 *     break the learner sees), and a <br> as "\n\n" (the card draws an empty
 *     line: the block's own break, then the <br>). A comment right after a
 *     block end draws nothing, so the block end counts from after the
 *     comment. `fromEditable` reads them back the same way (W3-6 hardening,
 *     A5 review round 1):
 *       toEditable('<div>a</div>\n<div>b</div>') → '<div>a</div>\n<div>b</div>'
 *       toEditable('<div>a</div><br>b')          → '<div>a</div>\n\nb'
 *       toEditable('a<hr><br>b')                 → 'a<hr>\n\nb'
 * The tags themselves stay as text: raw HTML is edited as text (spec §8.10).
 */
export function toEditable(raw: string): string {
  const s = raw ?? '';
  if (!hasHtmlTags(s)) return decodeTypedAngles(s);
  let out = '';
  let last = 0;
  let pre = 0;
  /** The index right after the last opening <pre> tag (its first line break is not shown). */
  let afterPreOpen = -1;
  /** The index right after the last block end outside <pre> (-1: none). */
  let afterBlockEnd = -1;
  RAW_TOKENS.lastIndex = 0;
  for (let m = RAW_TOKENS.exec(s); m !== null; m = RAW_TOKENS.exec(s)) {
    out += s.slice(last, m.index);
    last = m.index + m[0].length;
    const token = m[0];
    const rightAfterBlock = pre === 0 && m.index === afterBlockEnd;
    if (token.charCodeAt(0) === 60 /* < */) {
      if (isComment(token)) {
        out += token;
        // The card draws nothing for a comment: a block end right before it still counts.
        if (rightAfterBlock) afterBlockEnd = last;
      } else if (m[2] !== undefined) {
        // A <pre> tag: kept as written; it switches how line breaks are read.
        out += token;
        const step = preStep(m[1], m[2]);
        if (step > 0) {
          pre += 1;
          afterPreOpen = last;
        } else if (step < 0 && pre > 0) {
          pre -= 1;
        }
        // "</pre>" is a closing block tag too (also a stray one).
        if (m[1] === '/' && pre === 0) afterBlockEnd = last;
      } else if (m[3] !== undefined) {
        // A block end (a closing block tag or <hr>): the card starts a new line after it.
        out += token;
        if (pre === 0) afterBlockEnd = last;
      } else {
        // A <br>. Right after a block end it draws an EMPTY line.
        out += rightAfterBlock ? '\n\n' : '\n';
      }
      continue;
    }
    // A raw line break.
    if (pre > 0) {
      if (m.index !== afterPreOpen) out += '\n';
      continue;
    }
    if (rightAfterBlock) {
      out += '\n'; // the line break the card shows after the block
      continue;
    }
    const prev = out.charCodeAt(out.length - 1);
    const atSpace = out.length === 0 || prev === 32 || prev === 10 || prev === 9;
    if (!atSpace) out += ' ';
  }
  return out + s.slice(last);
}

/**
 * The text the learner typed → the raw note field.
 *   - Plain text (no REAL HTML, and `formatted` is false): unchanged; "\n" is
 *     a line. A "<…>" that only looks like a tag ("ArrayList<Integer>",
 *     "if a<b and c>d", "List<Object>": no closing tag) is text: every "<"
 *     and ">" is saved as "&lt;" / "&gt;", so the card, search and the
 *     duplicate check see what the learner typed (the renderer would drop the
 *     "tag": "ArrayList"). Real HTML (hasRealMarkup: "<b>…</b>", "<br>", a
 *     comment) keeps the HTML rules below, as before.
 *       fromEditable('ArrayList<Integer>') → 'ArrayList&lt;Integer&gt;'
 *       fromEditable('if i<n: x')          → 'if i<n: x'   (no "tag" at all: unchanged)
 *   - HTML (the text has a tag, or `formatted` says the field WAS HTML):
 *     every "\n" becomes <br>. Inside <pre> a line break stays a raw "\n"
 *     (pre keeps line breaks) — except right after "<pre>", where the
 *     renderer would not show it, so it is written as <br>.
 *   - A "\n" RIGHT AFTER a block end (a closing block tag "</div>", "</p>",
 *     "</pre>" …, or an <hr>; outside <pre>; a comment in between does not
 *     count) stays a raw "\n": the card already starts a new line there, so
 *     a <br> would draw an extra empty line the learner never typed (W3-6
 *     hardening, A5 review round 1). A second "\n" there is a <br>: a real
 *     empty line.
 *       fromEditable('<div>a</div>\nb')            → '<div>a</div>\nb'      (a, b)
 *       fromEditable('<div>a</div>\n\nb')          → '<div>a</div>\n<br>b'  (a, empty line, b)
 *       fromEditable('a<hr>\nb')                   → 'a<hr>\nb'             (a, b)
 *       fromEditable('<p>a</p><!-- c -->\nb', true) → '<p>a</p><!-- c -->\nb' (a, b)
 * `formatted` = isFormatted(the field's raw text before the edit). WHY: in
 * "ich bin<br>du bist" the only tags are <br>, so the edited text has no tag
 * left. It must still be saved with <br> ("edits keep line breaks"), so the
 * field stays HTML, as Anki wrote it.
 *
 * Round trip (fieldText.test.ts): toEditable(fromEditable(t, f)) === t for any
 * typed text without "\r" and without a typed "<br>"; and fromEditable(
 * toEditable(raw), isFormatted(raw)) draws the same card as `raw` (and is
 * `raw` byte for byte when raw uses plain <br> and no raw line breaks).
 */
export function fromEditable(text: string, formatted = false): string {
  const s = text ?? '';
  if (!formatted && !hasRealMarkup(s)) {
    // Plain text. "<…>" that only LOOKS like a tag is text: the renderer
    // would drop it ("ArrayList<Integer>" would show as "ArrayList").
    return hasHtmlTags(s) ? escapeAngles(s) : s;
  }
  let out = '';
  let last = 0;
  let pre = 0;
  let afterPreOpen = -1;
  /** The index right after the last block end outside <pre> (-1: none). */
  let afterBlockEnd = -1;
  EDIT_TOKENS.lastIndex = 0;
  for (let m = EDIT_TOKENS.exec(s); m !== null; m = EDIT_TOKENS.exec(s)) {
    out += s.slice(last, m.index);
    last = m.index + m[0].length;
    const token = m[0];
    if (token.charCodeAt(0) === 60 /* < */) {
      out += token;
      if (isComment(token)) {
        // The card draws nothing for a comment: a block end right before it still counts.
        if (pre === 0 && m.index === afterBlockEnd) afterBlockEnd = last;
        continue;
      }
      if (m[3] !== undefined) {
        // A block end (a closing block tag or <hr>): the card starts a new line after it.
        if (pre === 0) afterBlockEnd = last;
        continue;
      }
      const step = preStep(m[1], m[2] ?? '');
      if (step > 0) {
        pre += 1;
        afterPreOpen = last;
      } else if (step < 0 && pre > 0) {
        pre -= 1;
      }
      // "</pre>" is a closing block tag too (also a stray one).
      if (m[1] === '/' && pre === 0) afterBlockEnd = last;
      continue;
    }
    // Right after a block end the card starts a new line anyway: a raw "\n"
    // (only white space in HTML), never a <br> (an extra empty line).
    if (pre === 0 && m.index === afterBlockEnd) {
      out += '\n';
      continue;
    }
    out += pre > 0 && m.index !== afterPreOpen ? '\n' : '<br>';
  }
  return out + s.slice(last);
}

/**
 * The field values to save. A field the learner did not change keeps its
 * raw text EXACTLY (no conversion, so imported HTML is never rewritten). A
 * changed field is trimmed and converted with `fromEditable` (a field that
 * was HTML stays HTML). `raw` = the values before the edit ('' for a new card).
 *
 *   fieldsForSave(['a<br/>b', 'x<br>y'], ['a\nb', 'x\ny'], ['a\nb', 'x\nz']) → ['a<br/>b', 'x<br>z']
 */
export function fieldsForSave(
  raw: readonly string[],
  initial: readonly string[],
  edited: readonly string[],
): string[] {
  return edited.map((text, i) => {
    const before = raw[i] ?? '';
    return text === initial[i] ? before : fromEditable(text.trim(), isFormatted(before));
  });
}

/** True when a field draws nothing on a card: no text, no image, no sound (only tags or white space). */
export function isBlankField(raw: string): boolean {
  return htmlToLines(raw ?? '').length === 0;
}

/* ============================================================ 2. card types */

/**
 * A card type by id: the one in state, or — for a built-in id not in state
 * yet — the built-in definition (it is written into state by its first note).
 * null = unknown id. The built-in's createdAt is not used here (0).
 */
export function typeById(noteTypes: readonly NoteType[], typeId: Id | null | undefined): NoteType | null {
  if (!typeId) return null;
  const stored = noteTypes.find((t) => t.id === typeId);
  if (stored) return stored;
  const kind = builtinKindOf(typeId);
  return kind ? builtinType(kind, 0) : null;
}

/**
 * The label a field shows in the editors and the deck page's sheets ("Card
 * types & fields", "Read aloud", the card type picker): render.ts
 * `fieldDisplayLabel`, the ONE label rule of the app — the field's own label
 * when it has one, else its name made readable. So these screens show the
 * same words as the cards (wave 5d, R6). Before, an imported field without a
 * label showed its raw name here ("MarankiExample", "VerbForms").
 *
 *   fieldLabel({ name: 'Prateritum', label: 'Präteritum' }) → 'Präteritum'
 *   fieldLabel({ name: 'MarankiExample' })                  → 'Example'
 *   fieldLabel({ name: 'VerbForms' })                       → 'Verb Forms'
 */
export function fieldLabel(field: Pick<FieldDef, 'name' | 'label'>): string {
  return fieldDisplayLabel(field);
}

/** `i` when it is a valid field index of `type`, else null. */
function validIndex(type: NoteType, i: number | undefined): number | null {
  return i !== undefined && Number.isInteger(i) && i >= 0 && i < type.fields.length ? i : null;
}

/**
 * The fields the editor always shows (`main`, marked required) and the rest
 * (`more`, under "More fields"), both in the card type's field order.
 *   - Cloze: the field(s) that hold the deletions (usually Text).
 *   - Standard: the first 'term' field and the first 'meaning' field. Without
 *     a 'term' field: the sort field. Without a 'meaning' field: the first
 *     answer field of the first direction.
 *
 *   Basic → main [Front, Back], more [Example, Notes]
 */
export function splitFields(type: NoteType): { main: number[]; more: number[] } {
  const n = type.fields.length;
  if (n === 0) return { main: [], more: [] };
  const main = new Set<number>();
  if (type.kind === 'cloze') {
    for (const i of clozeFields(type)) main.add(i);
    if (main.size === 0) main.add(validIndex(type, type.sortField) ?? 0);
  } else {
    const term = type.fields.findIndex((f) => f.role === 'term');
    main.add(term >= 0 ? term : (validIndex(type, type.sortField) ?? 0));
    const meaning = type.fields.findIndex((f) => f.role === 'meaning');
    if (meaning >= 0) {
      main.add(meaning);
    } else {
      const first = [...type.templates].sort((a, b) => a.ord - b.ord)[0];
      const answer = first?.answer.map((i) => validIndex(type, i)).find((i) => i !== null && !main.has(i));
      if (answer !== undefined && answer !== null) main.add(answer);
    }
  }
  const all = type.fields.map((_, i) => i);
  return { main: all.filter((i) => main.has(i)), more: all.filter((i) => !main.has(i)) };
}

/** Why a required field blocks Save: it is empty, or (cloze) it hides nothing. */
export type MissingReason = 'empty' | 'noCloze';

/**
 * The required fields (the `main` fields of splitFields) that block Save.
 * `edited` is the editable text of every field.
 *
 * Editing an existing note (`initial` given): a field that was already empty
 * (or had no deletion) may stay that way — an imported note must never be
 * stuck because Anki allowed it. Only a field that HAD content may not be
 * emptied.
 *
 *   missingFields(basic, ['Haus', ''])            → [{ index: 1, reason: 'empty' }]
 *   missingFields(cloze, ['Berlin is big', ''])   → [{ index: 0, reason: 'noCloze' }]
 */
export function missingFields(
  type: NoteType,
  edited: readonly string[],
  initial?: readonly string[],
): { index: number; reason: MissingReason }[] {
  const out: { index: number; reason: MissingReason }[] = [];
  for (const i of splitFields(type).main) {
    // Blank or not does not depend on <br> vs "\n", so the plain conversion is enough here.
    const now = fromEditable(edited[i] ?? '');
    const before = initial ? fromEditable(initial[i] ?? '') : null;
    if (isBlankField(now)) {
      if (before === null || !isBlankField(before)) out.push({ index: i, reason: 'empty' });
      continue;
    }
    if (type.kind === 'cloze' && clozeNumbers(now).length === 0) {
      if (before === null || clozeNumbers(before).length > 0) out.push({ index: i, reason: 'noCloze' });
    }
  }
  return out;
}

/**
 * The values to keep when the learner switches the card type of a NEW card
 * (so typed text is not lost). For every field of `to`: the value of the
 * field of `from` with the same name (folded), else of the first unused
 * field with the same role, else ''.
 *
 *   Basic ['Haus', 'house', '', ''] → Basic + reverse ['Haus', 'house', '', '']   (same names)
 *   Basic ['Haus', 'house', '', 'n'] → Cloze ['Haus', 'n']                        (term → Text, detail → Extra)
 */
export function carryFields(from: NoteType, values: readonly string[], to: NoteType): string[] {
  const used = new Set<number>();
  const take = (i: number): string => {
    used.add(i);
    return values[i] ?? '';
  };
  const byName = new Map<string, number>();
  from.fields.forEach((f, i) => {
    const key = fieldKey(f.name);
    if (!byName.has(key)) byName.set(key, i);
  });
  // Pass 1: same name. Pass 2: same role, for the fields still empty.
  const out = to.fields.map((f) => {
    const i = byName.get(fieldKey(f.name));
    return i !== undefined ? take(i) : null;
  });
  return out.map((v, j) => {
    if (v !== null) return v;
    const role = to.fields[j].role;
    const i = from.fields.findIndex((f, k) => !used.has(k) && f.role === role);
    return i >= 0 ? take(i) : '';
  });
}

/** One row of the card type picker. */
export interface CardTypeOption {
  id: Id;
  name: string;
  /** "2 directions · Front, Back, Example, Notes". */
  sub: string;
}

/** "2 directions · Front, Back, Example, Notes" (a cloze type: "Cloze · Text, Extra"). */
function typeSub(type: NoteType): string {
  const labels = type.fields.map(fieldLabel);
  const shown = labels.length > 5 ? `${labels.slice(0, 5).join(', ')}, …` : labels.join(', ');
  const kind = type.kind === 'cloze' ? 'Cloze' : plural(type.templates.length, 'direction');
  return shown ? `${kind} · ${shown}` : kind;
}

/**
 * The card types a new card can use, for the picker:
 *   0. `current` (the type the form uses now) when it would not be listed
 *      otherwise — a caller's `typeId` or a deck's default type — so the
 *      picker always shows what is chosen;
 *   1. the card types of the notes in this deck, the most used first (so an
 *      imported deck offers its own type, with every field);
 *   2. then Basic, Basic + reverse and Cloze (when not already listed).
 * `noteIds` = the notes of the deck (noteIdsInDeck).
 */
export function cardTypeOptions(
  noteTypes: readonly NoteType[],
  notes: readonly Pick<Note, 'id' | 'typeId'>[],
  noteIds: ReadonlySet<Id>,
  current?: NoteType | null,
): CardTypeOption[] {
  const uses = new Map<Id, number>();
  for (const note of notes) {
    if (noteIds.has(note.id)) uses.set(note.typeId, (uses.get(note.typeId) ?? 0) + 1);
  }
  const deckTypes = [...uses.entries()]
    .map(([id, count]) => ({ type: typeById(noteTypes, id), count }))
    .filter((x): x is { type: NoteType; count: number } => x.type !== null)
    .sort((a, b) => b.count - a.count || (a.type.name < b.type.name ? -1 : a.type.name > b.type.name ? 1 : 0))
    .map((x) => x.type);
  const builtins = [BUILTIN_TYPE_IDS.basic, BUILTIN_TYPE_IDS.basicReverse, BUILTIN_TYPE_IDS.cloze]
    .map((id) => typeById(noteTypes, id))
    .filter((t): t is NoteType => t !== null);
  const listed = [...deckTypes, ...builtins];
  if (current && !listed.some((t) => t.id === current.id)) listed.unshift(current);
  const out: CardTypeOption[] = [];
  const seen = new Set<Id>();
  for (const type of listed) {
    if (seen.has(type.id)) continue;
    seen.add(type.id);
    out.push({ id: type.id, name: type.name, sub: typeSub(type) });
  }
  return out;
}

/* ================================================================== 3. tags */

/**
 * What the learner typed into the tag input → tags. Anki tags have no
 * spaces, so white space and commas separate tags. '::' (hierarchy) is kept.
 *
 *   parseTagInput('verb, irregular  A1') → ['verb', 'irregular', 'A1']
 */
export function parseTagInput(text: string): string[] {
  return (text ?? '').split(/[\s,]+/).filter((t) => t !== '');
}

/**
 * The tags to save: the chips plus a tag still being typed (so a tag typed
 * but not confirmed is not lost on Save), cleaned (cleanTags: trimmed, no
 * repeats without regard to case).
 */
export function tagsWithDraft(tags: readonly string[], draft: string): string[] {
  return cleanTags([...tags, ...parseTagInput(draft)]);
}

/**
 * The learner taps the suggestion `tag` while `draft` is typed in the box.
 * When the draft is the start of the tag (case and accents ignored), the tap
 * FINISHES the word: the draft is replaced by the tag, and the box is empty.
 * Else the tag is added and the draft stays (the learner is still typing
 * another tag). WHY: the card editor saves the draft too (`tagsWithDraft`),
 * so a half word left in the box would be saved as an extra tag (W3-6
 * hardening: typing "ver" and tapping "+ verb" saved ['verb', 'ver']).
 *
 *   pickSuggestion(['noun'], 'ver', 'verb') → { tags: ['noun', 'verb'], draft: '' }
 *   pickSuggestion([], 'irr', 'verb')       → { tags: ['verb'], draft: 'irr' }
 */
export function pickSuggestion(tags: readonly string[], draft: string, tag: string): { tags: string[]; draft: string } {
  const typed = foldText(draft.trim());
  const finishes = typed === '' || foldText(tag).startsWith(typed);
  return { tags: tagsWithDraft(tags, tag), draft: finishes ? '' : draft };
}

/**
 * Tag suggestions "from this deck": the tags of the deck's notes, the most
 * used first (then A–Z), without the tags already chosen (any case).
 * `typed` = the tag the learner is typing now: only tags that START with it
 * are suggested (case and accents ignored), so a tap finishes the word.
 *
 *   tagSuggestions(notes, inDeck, [], 8, 'ver') → ['verb', 'verbs']   (not 'noun')
 */
export function tagSuggestions(
  notes: readonly Pick<Note, 'id' | 'tags'>[],
  noteIds: ReadonlySet<Id>,
  chosen: readonly string[],
  limit = 8,
  typed = '',
): string[] {
  const taken = new Set(chosen.map((t) => t.toLowerCase()));
  const prefix = foldText(typed.trim());
  const counts = new Map<string, { tag: string; n: number }>();
  for (const note of notes) {
    if (!noteIds.has(note.id)) continue;
    for (const raw of note.tags) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (!tag || taken.has(key)) continue;
      if (prefix && !foldText(tag).startsWith(prefix)) continue;
      const entry = counts.get(key);
      if (entry) entry.n += 1;
      else counts.set(key, { tag, n: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((e) => e.tag);
}

/* ================================================================= 4. decks */

/** What the deck editor opens as (see deckEditorStart). */
export type DeckEditorStart<D> = { kind: 'new' } | { kind: 'edit'; deck: D } | { kind: 'missing' };

/**
 * What the deck editor opens as (spec §8.10):
 *   - no `deckId` → 'new' (the "New deck" form);
 *   - the deck is in the library → 'edit';
 *   - a `deckId` that is NOT in the library (a deck page or sheet that was
 *     open while the deck was deleted) → 'missing': the screen says "This
 *     deck no longer exists". It must never fall back to the "New deck"
 *     form: "Create deck" would then make a new deck when the learner wanted
 *     to rename one (W3-6 hardening).
 *
 *   deckEditorStart(decks, undefined) → { kind: 'new' }
 *   deckEditorStart(decks, 'gone')    → { kind: 'missing' }
 */
export function deckEditorStart<D extends Pick<Deck, 'id'>>(
  decks: readonly D[],
  deckId: string | null | undefined,
): DeckEditorStart<D> {
  if (!deckId) return { kind: 'new' };
  const deck = decks.find((d) => d.id === deckId);
  return deck ? { kind: 'edit', deck } : { kind: 'missing' };
}

/** Decks in list order: `order`, then creation time, then name. A new array. */
export function sortDecks<D extends Pick<Deck, 'order' | 'createdAt' | 'name'>>(decks: readonly D[]): D[] {
  const num = (v: number) => (Number.isFinite(v) ? v : 0);
  return [...decks].sort(
    (a, b) =>
      num(a.order) - num(b.order) ||
      num(a.createdAt) - num(b.createdAt) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** The ids of the notes that have a card in `deckId` (a note's cards are all in one deck). */
export function noteIdsInDeck(cards: readonly Pick<Card, 'noteId' | 'deckId'>[], deckId: Id | null): Set<Id> {
  const out = new Set<Id>();
  if (!deckId) return out;
  for (const c of cards) if (c.deckId === deckId) out.add(c.noteId);
  return out;
}

/**
 * The deck a new card goes to when the caller gives none ("else last used
 * deck", spec §2.2 and §7 #50 — never simply the oldest deck):
 *   1. the deck of the newest note made in the app (source 'manual');
 *   2. else the deck of the newest rating (reviewLog);
 *   3. else the first deck in list order that is not paused;
 *   4. else the first deck; null when there is no deck.
 */
export function lastUsedDeckId(state: {
  decks: readonly Deck[];
  notes: readonly Pick<Note, 'id' | 'createdAt' | 'source'>[];
  cards: readonly Pick<Card, 'noteId' | 'deckId'>[];
  reviewLog: readonly Pick<ReviewLogEntry, 'deckId'>[];
}): Id | null {
  const exists = new Set(state.decks.map((d) => d.id));
  let newest: { id: Id; at: number } | null = null;
  for (const note of state.notes) {
    if (note.source?.kind !== 'manual') continue;
    const at = Number.isFinite(note.createdAt) ? note.createdAt : 0;
    if (!newest || at >= newest.at) newest = { id: note.id, at };
  }
  if (newest) {
    const id = newest.id;
    const card = state.cards.find((c) => c.noteId === id && exists.has(c.deckId));
    if (card) return card.deckId;
  }
  for (let i = state.reviewLog.length - 1; i >= 0; i--) {
    const deckId = state.reviewLog[i].deckId;
    if (exists.has(deckId)) return deckId;
  }
  const sorted = sortDecks(state.decks);
  return (sorted.find((d) => d.active) ?? sorted[0])?.id ?? null;
}

/* ============================================================ 5. duplicates */

/**
 * The duplicate-check key of a field value: plain text (cloze answers kept,
 * tags and sounds removed), folded (case and accents ignored). '' = nothing
 * to compare.
 *
 *   duplicateKey('<b>Comer</b>') === duplicateKey('comer') === 'comer'
 */
export function duplicateKey(raw: string): string {
  return foldText(plainText(raw ?? ''));
}

/**
 * The notes of one card type in one deck, by the duplicate key of their sort
 * field. Built once per deck and type, so the check while typing is a lookup.
 */
export function duplicateIndex(
  notes: readonly Pick<Note, 'id' | 'typeId' | 'fields'>[],
  noteIds: ReadonlySet<Id>,
  type: Pick<NoteType, 'id' | 'sortField'>,
): Map<string, Id[]> {
  const out = new Map<string, Id[]>();
  for (const note of notes) {
    if (note.typeId !== type.id || !noteIds.has(note.id)) continue;
    const key = duplicateKey(note.fields[type.sortField] ?? '');
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push(note.id);
    else out.set(key, [note.id]);
  }
  return out;
}

/** The id of another note with the same key (never `selfId`), or null. */
export function findDuplicate(index: ReadonlyMap<string, readonly Id[]>, raw: string, selfId?: Id | null): Id | null {
  const key = duplicateKey(raw);
  if (!key) return null;
  return index.get(key)?.find((id) => id !== selfId) ?? null;
}

/**
 * Does the editor look for a same-deck duplicate now? Always for a new
 * card. For an edit: when the sort field changed, OR when the edit MOVES the
 * note to another deck — that deck may already have the same item (spec
 * §8.10: same folded sort field, same card type, same deck; W3-6 hardening).
 * The index to look in is the one of the deck chosen NOW (`duplicateIndex`).
 *
 *   checksDuplicate({ editing: true, deckMoved: true, sortText: 'comer', startSortText: 'comer' }) → true
 */
export function checksDuplicate(edit: {
  editing: boolean;
  deckMoved: boolean;
  sortText: string;
  startSortText: string;
}): boolean {
  return !edit.editing || edit.deckMoved || edit.sortText !== edit.startSortText;
}

/* ================================================================= 6. icons */

/** Code points that join the code point before them into one glyph. */
function joinsPrevious(cp: number): boolean {
  return (
    cp === 0xfe0f || // variation selector-16 (emoji style)
    cp === 0xfe0e || // variation selector-15 (text style)
    cp === 0x20e3 || // combining keycap: 1️⃣
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // skin tones
    (cp >= 0xe0020 && cp <= 0xe007f) || // tag characters (the flag of Scotland …)
    (cp >= 0x0300 && cp <= 0x036f) // combining accents
  );
}

const ZWJ = 0x200d; // zero-width joiner: 👨‍👩‍👧 is three emoji joined into one
const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff; // two of them = a flag

/**
 * The first glyph of a text (trimmed), for the deck icon. One glyph can be
 * several code points: a flag (2 regional letters), a skin tone, a family
 * joined with ZWJ, a keycap. '' when the text is empty.
 *
 *   firstGlyph('🇩🇪 German') → '🇩🇪'     firstGlyph('👍🏽👍') → '👍🏽'     firstGlyph('ab') → 'a'
 */
export function firstGlyph(text: string): string {
  const cps = Array.from((text ?? '').trim());
  if (cps.length === 0) return '';
  const cp = (k: number) => cps[k].codePointAt(0) ?? 0;
  let end = 1;
  if (isRegionalIndicator(cp(0)) && cps.length > 1 && isRegionalIndicator(cp(1))) end = 2;
  for (;;) {
    while (end < cps.length && joinsPrevious(cp(end))) end += 1;
    if (end + 1 < cps.length && cp(end) === ZWJ) {
      end += 2;
      continue;
    }
    break;
  }
  return cps.slice(0, end).join('');
}
