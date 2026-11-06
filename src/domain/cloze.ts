/**
 * Anki cloze deletions — the ONE cloze parser of the app (spec §3.4
 * `Card.ord` "cloze: cloze number − 1", §6.2 "Cloze"). The note model reads
 * {{c1::…}} only through this file:
 *   - renderFace (render.ts) draws card k with deletion k hidden;
 *   - addNote / editNote (noteOps.ts) make one card per cloze number;
 *   - suggestMapping (roles.ts) counts the directions of an import.
 * WHY one parser: when two places read the markup differently, a card can be
 * made for a number that its face cannot hide (a blank or wrong question).
 *
 * NOT YET moved to this file (other owners), so they can still read some
 * markup differently:
 *   - libraryIndex.ts `plainText` (search text and filter values) has its own
 *     small reader: it ends a deletion at the first "}}" and does not read
 *     {{c1,2::…}}. Its fix is to call `unwrapCloze` (below) instead;
 *   - anki.ts (today's importer, v2 cards) has its own regex; W3-5 rewires it.
 *
 * The syntax:
 *   {{c1::Paris}}            deletion 1, answer "Paris"
 *   {{c1::Paris::city}}      with a hint: card 1 asks "[city]"
 *   {{c1,2::Paris}}          ONE deletion that belongs to cards 1 AND 2
 *   {{c1::a {{c2::b}} c}}    nested: card 1 hides "a b c", card 2 hides only "b"
 *   {{c0::x}}                0 is not a card number: no card; every card shows "x"
 *
 * Rules (the same as Anki where Anki defines them):
 *   - A deletion starts with "{{c", one or more numbers joined by "," (no
 *     spaces), and "::". The next "}}" closes the innermost open deletion.
 *   - A card number is 1 … 65,535 (Anki keeps it in 16 bits). A bigger
 *     number is dropped; markup with no number left ({{c99999::x}}) is plain
 *     text. 0 gives no card, but {{c0::x}} is still read as a deletion, so
 *     its markup is not shown: every card shows its answer as plain text.
 *   - Hints work like Anki's parser (rslib cloze.rs): each text piece that
 *     belongs to the deletion itself (not the text of a nested deletion) is
 *     cut at its first "::". The part after it is the hint, and it is not
 *     shown. When several pieces have a "::", the LAST one gives the hint:
 *       {{c1::a {{c2::b}}::hint}}   → hint "hint"
 *       {{c1::a::h {{c2::b}}}}      → hint "h " (card 1 asks "[h ]"; card 2 shows "a[…]")
 *       {{c1::a::b::c}}             → hint "b::c" (only the FIRST "::" cuts)
 *   - A deletion that is never closed is NOT a deletion: its text stays as
 *     written ("{{c3::open"). A "}}" with no open deletion is text too.
 *   - At most MAX_CLOZE_DEPTH deletions inside each other. A deeper "{{c1::"
 *     is text. Real notes nest 2 or 3 deep; the limit keeps the recursion small.
 *
 * Linear time: one left-to-right scan. Every search for "{{c" or "}}" starts
 * where the last one stopped, so 50,000 "{{c1::" with no "}}" take a few ms.
 * Repeated card numbers in one opener are removed with a Set (not a list
 * search), so "{{c1,2,…,65535::x}}" is linear too.
 *
 * Pure: no React, no I/O. Hermes-safe (no lookbehind, no `normalize`).
 */
import { hasHtmlTags } from './htmlLines';

/** Plain text between deletions. */
export interface ClozeText {
  t: 'text';
  text: string;
}

/** One deletion {{cN::…}}. */
export interface ClozeDeletion {
  t: 'cloze';
  /** The card numbers this deletion belongs to (valid numbers only, ascending, no repeats). Empty for {{c0::…}}. */
  nums: number[];
  /** What the deletion hides: text and nested deletions, without the hint. */
  nodes: ClozeNode[];
  /** The hint after "::", if there is one. */
  hint?: string;
}

/** A piece of a parsed cloze text. */
export type ClozeNode = ClozeText | ClozeDeletion;

/** The biggest card number (Anki stores it in 16 bits). */
export const MAX_CLOZE_NUMBER = 65_535;

/** The deepest nesting that is read as deletions; deeper markup is text. */
export const MAX_CLOZE_DEPTH = 32;

/* ------------------------------------------------------------- scanning */

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; raw: string; nums: number[] }
  | { kind: 'close' };

const OPEN = '{{c';
const CLOSE = '}}';

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/**
 * Read the start of a deletion at `at` (where "{{c" is). Returns the index
 * just after "::" and the card numbers, or null when it is not a deletion
 * ("{{cat}}", "{{c::x}}", "{{c1, 2::x}}", "{{c99999::x}}").
 *
 * Like Anki: a number above MAX_CLOZE_NUMBER is dropped, and when NO number
 * is left the markup is plain text. 0 is a number (so {{c0::x}} IS a
 * deletion), but it belongs to no card.
 */
function readOpener(text: string, at: number): { end: number; nums: number[] } | null {
  let j = at + OPEN.length;
  // A Set, so a repeat check costs O(1): with a list, k numbers would cost O(k²).
  const seen = new Set<number>();
  let anyNumber = false;
  for (;;) {
    const start = j;
    let value = 0;
    while (j < text.length && isDigit(text.charCodeAt(j))) {
      // Stop counting above the limit (the digits are still read): no huge or imprecise numbers.
      if (value <= MAX_CLOZE_NUMBER) value = value * 10 + (text.charCodeAt(j) - 48);
      j++;
    }
    if (j === start) return null; // no digit here
    if (value <= MAX_CLOZE_NUMBER) {
      anyNumber = true;
      if (value >= 1) seen.add(value);
    }
    if (text.charCodeAt(j) !== 44) break; // ','
    j++;
  }
  if (!anyNumber || !text.startsWith('::', j)) return null;
  const nums = Array.from(seen).sort((a, b) => a - b);
  return { end: j + 2, nums };
}

/** Split the text into plain text, deletion starts and "}}" tokens, in one pass. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0; // start of the text that is not in a token yet
  let at = 0; // the scan position; it only moves forward
  let open = text.indexOf(OPEN);
  let close = text.indexOf(CLOSE);
  const pushText = (end: number) => {
    if (end > last) tokens.push({ kind: 'text', text: text.slice(last, end) });
  };
  while (open !== -1 || close !== -1) {
    if (close !== -1 && (open === -1 || close < open)) {
      pushText(close);
      tokens.push({ kind: 'close' });
      at = last = close + CLOSE.length;
    } else {
      const opener = readOpener(text, open);
      if (opener) {
        pushText(open);
        tokens.push({ kind: 'open', raw: text.slice(open, opener.end), nums: opener.nums });
        at = last = opener.end;
      } else {
        at = open + 1; // "{{cat}}": plain text, look further
      }
    }
    // Search again only when a position is behind the scan (each part of the text is searched once).
    if (open !== -1 && open < at) open = text.indexOf(OPEN, at);
    if (close !== -1 && close < at) close = text.indexOf(CLOSE, at);
  }
  pushText(text.length);
  return tokens;
}

/** Add text to a node list, joined to a text node that is already last. */
function addText(list: ClozeNode[], text: string): void {
  if (text === '') return;
  const tail = list[list.length - 1];
  if (tail && tail.t === 'text') tail.text += text;
  else list.push({ t: 'text', text });
}

/**
 * Add a text piece that belongs to `deletion` itself (Anki's hint rule):
 * the piece is cut at its first "::"; the part before it is shown, the part
 * after it becomes the hint. A later piece with "::" replaces an earlier
 * hint, so the LAST one wins.
 *
 *   "Paris::city" → text "Paris", hint "city"
 */
function addDeletionText(deletion: ClozeDeletion, text: string): void {
  const sep = text.indexOf('::');
  if (sep === -1) {
    addText(deletion.nodes, text);
    return;
  }
  addText(deletion.nodes, text.slice(0, sep));
  deletion.hint = text.slice(sep + 2);
}

/**
 * Parse a field's text into text and deletions (see the rules in the file
 * header). Joining the pieces back gives the same text without the cloze
 * markup.
 *
 *   parseCloze('{{c1::Paris}} is nice')
 *     → [{ t: 'cloze', nums: [1], nodes: [{ t: 'text', text: 'Paris' }] }, { t: 'text', text: ' is nice' }]
 */
export function parseCloze(text: string): ClozeNode[] {
  const source = typeof text === 'string' ? text : '';
  if (source.indexOf(OPEN) === -1) return source === '' ? [] : [{ t: 'text', text: source }];
  const tokens = tokenize(source);

  // 1. Which "{{cN::" and "}}" belong together: the innermost open deletion
  //    closes first. Starts that never close (and "}}" with nothing open) are text.
  const paired = new Array<boolean>(tokens.length).fill(false);
  const stack: number[] = [];
  tokens.forEach((token, i) => {
    if (token.kind === 'open') {
      if (stack.length < MAX_CLOZE_DEPTH) stack.push(i);
    } else if (token.kind === 'close') {
      const start = stack.pop();
      if (start !== undefined) {
        paired[start] = true;
        paired[i] = true;
      }
    }
  });

  // 2. Build the pieces. Paired tokens are well nested, so a stack follows them.
  //    Only a real text token inside a deletion can hold its hint; markup that
  //    became text (an unpaired start or "}}") is added as it is.
  const root: ClozeNode[] = [];
  const open: { deletion: ClozeDeletion; parent: ClozeNode[] }[] = [];
  let current = root;
  tokens.forEach((token, i) => {
    if (token.kind === 'text') {
      const inside = open[open.length - 1];
      if (inside) addDeletionText(inside.deletion, token.text);
      else addText(current, token.text);
    } else if (token.kind === 'open') {
      if (!paired[i]) {
        addText(current, token.raw);
        return;
      }
      const deletion: ClozeDeletion = { t: 'cloze', nums: token.nums, nodes: [] };
      open.push({ deletion, parent: current });
      current = deletion.nodes;
    } else if (!paired[i]) {
      addText(current, CLOSE);
    } else {
      const frame = open.pop() as { deletion: ClozeDeletion; parent: ClozeNode[] };
      frame.parent.push(frame.deletion);
      current = frame.parent;
    }
  });
  return root;
}

/* ------------------------------------------------------------ reading */

/** The text of some pieces with every deletion shown as its answer (hints left out). */
function answerText(nodes: readonly ClozeNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.t === 'text') out.push(node.text);
    else answerText(node.nodes, out);
  }
}

/** True when the text has at least one (closed) deletion, also one without a card number ({{c0::…}}). */
export function hasCloze(text: string): boolean {
  return parseCloze(text).some((node) => node.t === 'cloze');
}

/**
 * The card numbers in a text, distinct and ascending. A card type of kind
 * 'cloze' has one card per number (ord = number − 1).
 *
 *   clozeNumbers('{{c2::b}} {{c1::a}} {{c2::c}}') → [1, 2]
 *   clozeNumbers('{{c1,3::Paris}}')               → [1, 3]
 *   clozeNumbers('{{c0::x}} {{c1::y}}')            → [1]
 */
export function clozeNumbers(text: string): number[] {
  const seen = new Set<number>();
  const visit = (nodes: readonly ClozeNode[]) => {
    for (const node of nodes) {
      if (node.t !== 'cloze') continue;
      for (const n of node.nums) seen.add(n);
      visit(node.nodes);
    }
  };
  visit(parseCloze(text));
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * The text with every deletion replaced by its answer (hints left out), for
 * search and filter values:
 *
 *   unwrapCloze('{{c1::Berlin::capital}} is in {{c2,3::Germany}}') → 'Berlin is in Germany'
 */
export function unwrapCloze(text: string): string {
  const out: string[] = [];
  answerText(parseCloze(text), out);
  return out.join('');
}

/** One side of card `k`, as raw HTML pieces. */
function renderSide(nodes: readonly ClozeNode[], k: number, side: 'prompt' | 'answer', out: string[]): void {
  for (const node of nodes) {
    if (node.t === 'text') {
      out.push(node.text);
    } else if (!node.nums.includes(k)) {
      // Another card's deletion: shown as its text (a deletion of card k inside it still counts).
      renderSide(node.nodes, k, side, out);
    } else if (side === 'prompt') {
      out.push(`<b>[${node.hint ?? '…'}]</b>`);
    } else {
      out.push('<b>');
      renderSide(node.nodes, k, side, out);
      out.push('</b>');
    }
  }
}

/**
 * One side of cloze card `k` (raw HTML, ready for htmlToLines):
 *   'prompt' → each deletion of card k becomes a bold "[…]" (or "[hint]");
 *              every other deletion shows its answer;
 *   'answer' → each deletion of card k shows its answer in bold; the others show their answer.
 *
 *   clozeSide('{{c1::Paris}} is in {{c2::France::country}}', 2, 'prompt')
 *     → 'Paris is in <b>[country]</b>'
 *
 * Plain text (no tag) keeps its line breaks: they become <br> before the
 * bold tags are added (with a tag, htmlToLines would read "\n" as a space).
 */
export function clozeSide(text: string, k: number, side: 'prompt' | 'answer'): string {
  const raw = typeof text === 'string' ? text : '';
  const html = hasHtmlTags(raw) ? raw : raw.replace(/\r\n|\r|\n/g, '<br>');
  const out: string[] = [];
  renderSide(parseCloze(html), k, side, out);
  return out.join('');
}

/**
 * The raw answers of card `k`'s deletions, in text order:
 *
 *   clozeAnswers('{{c1::a}} {{c1::b}}', 1)    → ['a', 'b']
 *   clozeAnswers('{{c1::a {{c2::b}} c}}', 1)  → ['a b c']
 *   clozeAnswers('{{c1::a {{c2::b}} c}}', 2)  → ['b']
 */
export function clozeAnswers(text: string, k: number): string[] {
  const out: string[] = [];
  const visit = (nodes: readonly ClozeNode[]) => {
    for (const node of nodes) {
      if (node.t !== 'cloze') continue;
      if (node.nums.includes(k)) {
        const parts: string[] = [];
        answerText(node.nodes, parts);
        out.push(parts.join(''));
      } else {
        visit(node.nodes);
      }
    }
  };
  visit(parseCloze(text));
  return out;
}
