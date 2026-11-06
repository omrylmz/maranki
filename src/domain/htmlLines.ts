/**
 * Safe HTML → lines (spec §6.2 "Safe HTML subset"). Note fields keep Anki's
 * RAW HTML. This file turns it into plain data that a screen can draw with
 * normal <Text> and <Image> components: lines of "inlines".
 *
 *   htmlToLines('ich <b>bin</b><br>du bist')
 *     → [[{t:'text', text:'ich '}, {t:'text', text:'bin', b:true}],
 *        [{t:'text', text:'du bist'}]]
 *
 * WHY: no WebView and nothing executable. Only a small, known subset of HTML
 * survives; everything else becomes plain text. A conjugation table
 * "ich bin<br>du bist<br>…" now shows as real lines.
 *
 * The subset:
 *   - New line: <br> always starts a new line. Block tags (div, p, li, tr,
 *     ul, ol, table, h1–h6, hr …) start a new line when the current line
 *     already has something (so "a<div>b</div>" and "<div>a</div><div>b</div>"
 *     both give two lines, like a browser shows them).
 *   - Styles: b/strong → b, i/em → i, u/ins → u, sub, sup.
 *   - <img src="x.png"> → an image inline (the screen loads it from the deck's media folder).
 *   - [sound:x.mp3] → a sound inline (audio is not played yet; the screen shows a quiet token).
 *   - <li> gets "• " (or "1. " inside <ol>); table cells are kept apart by a space.
 *   - Entities (&amp; &auml; &#228; …) are decoded.
 *   - <script> and <style> are removed WITH their content (also when written
 *     "<script/>": like a browser, the "/" does not end them); comments are removed.
 *   - <pre> keeps its line breaks and spaces (code in a Coding deck).
 *   - EVERY other tag is dropped and its text is kept.
 *
 * White space: inside HTML, runs of spaces and line breaks become one space
 * (as in a browser), except inside <pre>. A field with NO real tag is plain
 * text (a note typed in the app, a migrated v2 card, a plain CSV value):
 * there, a line break "\n" is a real new line. A real tag is '<' + a letter
 * (or ! / ?) + no '<' and no '>' + '>', the same rule the scanner uses, so
 * a plain "if i<n:" does not switch a field to HTML.
 *
 * Linear time (spec: "same rule as stripHtml"): one left-to-right scan. Every
 * search for '>', '<', ']' or '[' remembers where it stopped, so a field full
 * of '<' with no '>' is still read in one pass (200k '<' in a few ms).
 *
 * Pure: no React, no I/O. Hermes-safe: no lookbehind, no `normalize`,
 * no `replaceAll`.
 */
import { stripHtml } from './anki';
import type { Inline } from './model';
import { oneLine } from './text';

/* -------------------------------------------------------------- tables */

type StyleKey = 'b' | 'i' | 'u' | 'sub' | 'sup';

/** The text kind of Inline. */
type TextInline = Extract<Inline, { t: 'text' }>;

/** Tag name → the style it switches on. */
const STYLE_OF_TAG: Record<string, StyleKey> = {
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  u: 'u',
  ins: 'u',
  sub: 'sub',
  sup: 'sup',
};

/** Tags that start a new line (when the current line has something), open or closed. */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
]);

/** Tags removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set(['script', 'style']);

/**
 * Named entities that anki.ts does not decode (it knows the common German,
 * Spanish and French letters). These appear in real decks: the Coding
 * Patterns deck uses &times; &sum; &sup2;.
 */
const MORE_ENTITIES: Record<string, string> = {
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  sum: '∑',
  prod: '∏',
  radic: '√',
  infin: '∞',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  equiv: '≡',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  deg: '°',
  micro: 'µ',
  middot: '·',
  bull: '•',
  sect: '§',
  para: '¶',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  bdquo: '„',
  sbquo: '‚',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  lArr: '⇐',
  rArr: '⇒',
  hArr: '⇔',
  forall: '∀',
  exist: '∃',
  isin: '∈',
  notin: '∉',
  empty: '∅',
  cap: '∩',
  cup: '∪',
  and: '∧',
  or: '∨',
  not: '¬',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
  aacute: 'á',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ',
  ccedil: 'ç',
  Ccedil: 'Ç',
  acirc: 'â',
  ecirc: 'ê',
  icirc: 'î',
  ocirc: 'ô',
  ucirc: 'û',
  euml: 'ë',
  iuml: 'ï',
  ugrave: 'ù',
  oelig: 'œ',
  aelig: 'æ',
  shy: '',
  zwj: '‍',
  zwnj: '‌',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
};

/** Code units used by the scanner. */
const LT = 60; // <
const GT = 62; // >
const AMP = 38; // &
const LBRACKET = 91; // [
const SLASH = 47; // /
const BANG = 33; // !
const QUESTION = 63; // ?
const SEMICOLON = 59; // ;
const HASH = 35; // #

/**
 * A field with a real tag (or a comment) is HTML; without one it is plain
 * text (see the file header). Linear: [^<>]* stops at the next '<', so each
 * part of the text is read about once.
 */
const HTML_TAG = /<!--|<[a-z!/?][^<>]*>/i;

/** Code units used by the attribute reader. */
const EQUALS = 61; // =
const DQUOTE = 34; // "
const SQUOTE = 39; // '

/* ------------------------------------------------------------ entities */

/** Small cache: real fields repeat the same few entities many times. */
const entityCache = new Map<string, string>();
const ENTITY_CACHE_MAX = 512;

/**
 * Decode ONE entity token like '&auml;' or '&#228;'.
 *
 * It reuses anki.ts: `stripHtml` decodes anki.ts's named entities
 * (NAMED_ENTITIES, not exported) and every numeric entity. stripHtml also
 * trims white space, so a white-space entity (&nbsp; &#32;) comes back as ''
 * → it becomes one space here. An entity anki.ts does not know comes back
 * unchanged → MORE_ENTITIES, else the token stays as written (like a browser).
 * MORE_ENTITIES is read by OWN key only: the name comes from the field text,
 * and "&constructor;" must not find Object's built-in function (the card
 * would crash: a function is not text).
 */
function decodeEntity(token: string): string {
  const hit = entityCache.get(token);
  if (hit !== undefined) return hit;
  let out = stripHtml(token);
  if (out === '') out = ' ';
  else if (out === token) {
    const name = token.slice(1, -1);
    out = Object.prototype.hasOwnProperty.call(MORE_ENTITIES, name) ? MORE_ENTITIES[name] : token;
  }
  if (entityCache.size < ENTITY_CACHE_MAX) entityCache.set(token, out);
  return out;
}

/** True for 0-9, A-Z, a-z. */
function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** True for A-Z, a-z. */
function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** True for the HTML white-space characters: space, tab, \n, \f, \r. */
function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

/**
 * The raw value of the `src` attribute in a tag body like
 * 'img alt="a src=x.png" src="real.png" /', or '' when there is none.
 *
 * WHY a small reader and not one regex: the attributes are read IN ORDER and
 * a quoted value is skipped as a whole. So text inside another attribute's
 * value (alt="a src=evil.png") is never read as the src. Like a browser, the
 * first `src` wins. Linear: the position only moves forward.
 */
function readSrc(body: string): string {
  const n = body.length;
  let k = 0;
  while (k < n && isAlnum(body.charCodeAt(k))) k++; // the tag name
  while (k < n) {
    // Attributes are separated by white space or '/'.
    while (k < n && (isSpace(body.charCodeAt(k)) || body.charCodeAt(k) === SLASH)) k++;
    if (k >= n) break;
    // The name: up to white space, '/' or '='. (An '=' as the FIRST character belongs to
    // the name, as in a browser; this also makes sure the position always moves on.)
    const nameStart = k;
    while (k < n) {
      const c = body.charCodeAt(k);
      if (isSpace(c) || c === SLASH || (c === EQUALS && k > nameStart)) break;
      k++;
    }
    const name = body.slice(nameStart, k).toLowerCase();
    // An optional "= value": in double quotes, single quotes, or none (up to white space).
    let j = k;
    while (j < n && isSpace(body.charCodeAt(j))) j++;
    let value: string | null = null;
    if (j < n && body.charCodeAt(j) === EQUALS) {
      j++;
      while (j < n && isSpace(body.charCodeAt(j))) j++;
      const q = body.charCodeAt(j);
      if (q === DQUOTE || q === SQUOTE) {
        const close = body.indexOf(q === DQUOTE ? '"' : "'", j + 1);
        // An unclosed quote: the value is broken, so it is not used.
        value = close === -1 ? null : body.slice(j + 1, close);
        k = close === -1 ? n : close + 1;
      } else {
        const start = j;
        while (j < n && !isSpace(body.charCodeAt(j))) j++;
        value = body.slice(start, j);
        k = j;
      }
    }
    if (name === 'src') return value ?? '';
  }
  return '';
}

/**
 * The end (index after ';') of an entity that starts at `i` (s[i] === '&'),
 * or -1 when there is none. Looks at most 34 characters ahead, so it costs
 * O(1) per '&'.
 */
function entityEnd(s: string, i: number): number {
  const max = Math.min(s.length, i + 34);
  let j = i + 1;
  if (j < max && s.charCodeAt(j) === HASH) {
    j++;
    const x = s.charCodeAt(j);
    if (x === 120 || x === 88) j++; // x or X
  }
  const bodyStart = j;
  while (j < max && isAlnum(s.charCodeAt(j))) j++;
  if (j === bodyStart || j >= max || s.charCodeAt(j) !== SEMICOLON) return -1;
  return j + 1;
}

/**
 * Decode every entity in a text exactly as the card does (decodeEntity:
 * anki.ts's names, MORE_ENTITIES and numeric entities; an unknown name stays
 * as written; a white-space entity becomes one space). Used for image and
 * sound names here, and by libraryIndex `plainText` (search text, filter
 * values, the duplicate key), so search finds what the card shows:
 *
 *   decodeHtmlEntities('2 &times; 3 &rarr; &auml;rger') → '2 × 3 → ärger'
 */
export function decodeHtmlEntities(s: string): string {
  return decodeAll(s);
}

/** Decode every entity in a short string (an image name). */
function decodeAll(s: string): string {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let last = 0;
  let i = s.indexOf('&');
  while (i !== -1) {
    const end = entityEnd(s, i);
    if (end !== -1) {
      out += s.slice(last, i) + decodeEntity(s.slice(i, end));
      last = end;
      i = s.indexOf('&', end);
    } else {
      i = s.indexOf('&', i + 1);
    }
  }
  return out + s.slice(last);
}

/* -------------------------------------------------------- linear search */

/**
 * "Where is the next `ch` at or after `at`?" with memory. Calls must use
 * positions that never go back (the scanner only moves forward). Then each
 * part of the text is searched at most once: linear time in total.
 */
function finder(s: string, ch: string): (at: number) => number {
  let pos = -1;
  let none = false;
  return (at: number) => {
    if (none) return -1;
    if (pos >= at) return pos;
    pos = s.indexOf(ch, at);
    if (pos === -1) none = true;
    return pos;
  };
}

/**
 * Find the closing tag "</name" (any case) at or after `from`, or -1.
 * Like a browser, the name must END there: the next character is '>', '/',
 * white space or the end of the text. So "</scriptfoo>" or "</styles>" does
 * NOT end a <script> / <style> block (its text stays hidden).
 */
function findClosing(s: string, name: string, from: number): number {
  let i = s.indexOf('</', from);
  while (i !== -1) {
    const after = i + 2 + name.length;
    if (s.slice(i + 2, after).toLowerCase() === name) {
      const c = s.charCodeAt(after);
      if (after >= s.length || c === GT || c === SLASH || isSpace(c)) return i;
    }
    i = s.indexOf('</', i + 2);
  }
  return -1;
}

/* ------------------------------------------------------- line builder */

/** Collects inlines into lines, with the current styles and white-space rules. */
class LineBuilder {
  private readonly out: Inline[][] = [];
  private line: Inline[] = [];
  /** The current line has visible text, an image or a sound. */
  private hasContent = false;
  /** The last thing added ends in a space (true at a line start, so leading spaces are dropped). */
  private endsWithSpace = true;
  private readonly styles: Record<StyleKey, number> = { b: 0, i: 0, u: 0, sub: 0, sup: 0 };
  /** One entry per open <ul>/<ol>: numbered or not, and the last number used. */
  private readonly lists: { ordered: boolean; n: number }[] = [];
  /** How many <pre> are open. Inside one, line breaks and spaces are kept as written. */
  private pre = 0;

  constructor(private readonly plain: boolean) {}

  /** Raw text from the field (between tags). */
  text(raw: string): void {
    if (raw === '') return;
    if (!this.plain && this.pre === 0) {
      this.add(raw);
      return;
    }
    // Plain text, or text inside <pre>: every line break is a new line.
    let start = 0;
    for (let k = 0; k < raw.length; k++) {
      const c = raw.charCodeAt(k);
      if (c === 10 || c === 13) {
        this.add(raw.slice(start, k));
        if (c === 13 && raw.charCodeAt(k + 1) === 10) k++;
        this.hardBreak();
        start = k + 1;
      }
    }
    this.add(raw.slice(start));
  }

  /** Decoded text that must not be split into lines (an entity). */
  literal(text: string): void {
    this.add(text);
  }

  /**
   * Add text, merged into the last inline when the style is the same. White
   * space is collapsed to one space, except inside <pre> (kept as written, so
   * the indentation of code stays).
   */
  private add(raw: string, styled = true): void {
    const keep = this.pre > 0;
    let t = keep ? raw : raw.replace(/[ \t\n\r\f]+/g, ' ');
    if (!keep && this.endsWithSpace && t.charCodeAt(0) === 32) t = t.slice(1);
    if (t === '') return;
    this.endsWithSpace = t.charCodeAt(t.length - 1) === 32;
    // Only spaces (or tabs) is not content: an empty line stays [].
    if (/[^ \t]/.test(t)) this.hasContent = true;

    const item: TextInline = { t: 'text', text: t };
    if (styled) {
      if (this.styles.b > 0) item.b = true;
      if (this.styles.i > 0) item.i = true;
      if (this.styles.u > 0) item.u = true;
      if (this.styles.sub > 0) item.sub = true;
      if (this.styles.sup > 0) item.sup = true;
    }
    const last = this.line[this.line.length - 1];
    if (
      last &&
      last.t === 'text' &&
      last.b === item.b &&
      last.i === item.i &&
      last.u === item.u &&
      last.sub === item.sub &&
      last.sup === item.sup
    ) {
      last.text += t;
    } else {
      this.line.push(item);
    }
  }

  /** An image or a sound. */
  media(item: Inline): void {
    this.line.push(item);
    this.hasContent = true;
    this.endsWithSpace = false;
  }

  /** <br>: always a new line (an empty line stays as []). */
  hardBreak(): void {
    this.endLine();
  }

  /** A block tag: a new line only when the current line has something. */
  softBreak(): void {
    if (this.hasContent) this.endLine();
  }

  style(key: StyleKey, on: boolean): void {
    if (on) this.styles[key]++;
    else if (this.styles[key] > 0) this.styles[key]--;
  }

  openList(ordered: boolean): void {
    this.lists.push({ ordered, n: 0 });
  }

  closeList(): void {
    this.lists.pop();
  }

  /** <pre> opens (true) or closes (false). A stray </pre> is ignored. */
  preformatted(open: boolean): void {
    if (open) this.pre++;
    else if (this.pre > 0) this.pre--;
  }

  /** <li>: a new line that starts with "• " (or "1. " inside <ol>). */
  listItem(): void {
    this.softBreak();
    const list = this.lists[this.lists.length - 1];
    if (list?.ordered) {
      list.n += 1;
      this.add(`${list.n}. `, false);
    } else {
      this.add('• ', false);
    }
  }

  /** <td>/<th>: keep cells apart by one space. */
  cell(): void {
    if (this.hasContent && !this.endsWithSpace) this.add(' ', false);
  }

  /** Push the current line: trailing spaces and tabs are trimmed (a loop, not a regex: linear). */
  private endLine(): void {
    const last = this.line[this.line.length - 1];
    if (last && last.t === 'text') {
      let end = last.text.length;
      while (end > 0 && (last.text.charCodeAt(end - 1) === 32 || last.text.charCodeAt(end - 1) === 9)) end--;
      if (end < last.text.length) {
        last.text = last.text.slice(0, end);
        if (last.text === '') this.line.pop();
      }
    }
    this.out.push(this.hasContent ? this.line : []);
    this.line = [];
    this.hasContent = false;
    this.endsWithSpace = true;
  }

  /** The lines, without empty lines at the start or end, and never two empty lines in a row. */
  finish(): Inline[][] {
    if (this.hasContent) this.endLine();
    const lines: Inline[][] = [];
    for (const line of this.out) {
      const empty = line.length === 0;
      if (empty && (lines.length === 0 || lines[lines.length - 1].length === 0)) continue;
      lines.push(line);
    }
    while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
    return lines;
  }
}

/* -------------------------------------------------------------- tags */

/** What the scanner found at a '<'. */
type TagHit =
  | { kind: 'tag'; name: string; closing: boolean; selfClosing: boolean; body: string; end: number }
  | { kind: 'skip'; end: number };

/** Apply one tag to the builder. Returns where scanning goes on. */
function applyTag(
  b: LineBuilder,
  html: string,
  tag: Extract<TagHit, { kind: 'tag' }>,
  findGt: (at: number) => number,
): number {
  const { name, closing, selfClosing } = tag;

  if (!closing && DROP_WITH_CONTENT.has(name)) {
    // <script>/<style>: skip to after its closing tag; unclosed → the rest is dropped.
    // "<script/>" is NOT closed: a browser ignores the "/" on these tags, so the
    // text after it is still script (it must not show as card text).
    const close = findClosing(html, name, tag.end);
    if (close === -1) return html.length;
    const gt = findGt(close);
    return gt === -1 ? html.length : gt + 1;
  }

  if (name === 'br') {
    b.hardBreak();
    return tag.end;
  }
  if (name === 'img') {
    if (!closing) {
      const src = decodeAll(readSrc(tag.body).trim());
      if (src !== '') b.media({ t: 'img', src });
    }
    return tag.end;
  }
  const style = STYLE_OF_TAG[name];
  if (style) {
    if (!selfClosing) b.style(style, !closing);
    return tag.end;
  }
  if (name === 'td' || name === 'th') {
    if (!closing) b.cell();
    return tag.end;
  }
  if (BLOCK_TAGS.has(name)) {
    if (name === 'li' && !closing) {
      b.listItem();
      return tag.end;
    }
    b.softBreak();
    if ((name === 'ul' || name === 'ol') && !selfClosing) {
      if (closing) b.closeList();
      else b.openList(name === 'ol');
    }
    if (name === 'pre' && !selfClosing) {
      b.preformatted(!closing);
      // Like a browser: one line break right after "<pre>" is not shown.
      if (!closing && html.charCodeAt(tag.end) === 13 && html.charCodeAt(tag.end + 1) === 10) return tag.end + 2;
      if (!closing && (html.charCodeAt(tag.end) === 10 || html.charCodeAt(tag.end) === 13)) return tag.end + 1;
    }
    return tag.end;
  }
  // Every other tag (span, a, font, code …): dropped, its text is kept.
  return tag.end;
}

/* --------------------------------------------------------------- API */

/**
 * Anki field HTML → lines of inlines (the safe subset in the file header).
 * '' (or only white space / only tags) → [].
 */
export function htmlToLines(html: string): Inline[][] {
  if (!html) return [];
  const n = html.length;
  const b = new LineBuilder(!HTML_TAG.test(html));
  const findGt = finder(html, '>');
  const findLt = finder(html, '<');
  const findRb = finder(html, ']');
  const findLb = finder(html, '[');

  /** Read a tag at `i` (html[i] === '<'), or null when this '<' is just a character. */
  const readTag = (i: number): TagHit | null => {
    const c1 = html.charCodeAt(i + 1);
    if (c1 === BANG && html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      return { kind: 'skip', end: close === -1 ? n : close + 3 };
    }
    if (!(c1 === SLASH || c1 === BANG || c1 === QUESTION || isLetter(c1))) return null;
    // A tag is '<' + no '<' and no '>' + '>' (the same rule as stripHtml).
    const gt = findGt(i + 1);
    if (gt === -1) return null;
    const lt = findLt(i + 1);
    if (lt !== -1 && lt < gt) return null;
    if (c1 === BANG || c1 === QUESTION) return { kind: 'skip', end: gt + 1 }; // <!doctype>, <?xml?>
    const body = html.slice(i + 1, gt);
    const closing = c1 === SLASH;
    let k = closing ? 1 : 0;
    const nameStart = k;
    while (k < body.length && isAlnum(body.charCodeAt(k))) k++;
    return {
      kind: 'tag',
      name: body.slice(nameStart, k).toLowerCase(),
      closing,
      selfClosing: body.charCodeAt(body.length - 1) === SLASH,
      body,
      end: gt + 1,
    };
  };

  /** Read "[sound:name]" at `i`, or null. */
  const readSound = (i: number): { src: string; end: number } | null => {
    if (html.slice(i, i + 7).toLowerCase() !== '[sound:') return null;
    const rb = findRb(i + 1);
    if (rb === -1) return null;
    const lb = findLb(i + 1);
    if (lb !== -1 && lb < rb) return null;
    const src = decodeAll(html.slice(i + 7, rb).trim());
    return src === '' ? null : { src, end: rb + 1 };
  };

  let i = 0;
  let runStart = 0; // start of the plain text not yet given to the builder
  while (i < n) {
    const c = html.charCodeAt(i);
    if (c === LT) {
      const tag = readTag(i);
      if (tag) {
        b.text(html.slice(runStart, i));
        i = tag.kind === 'skip' ? tag.end : applyTag(b, html, tag, findGt);
        runStart = i;
        continue;
      }
    } else if (c === AMP) {
      const end = entityEnd(html, i);
      if (end !== -1) {
        b.text(html.slice(runStart, i));
        b.literal(decodeEntity(html.slice(i, end)));
        i = end;
        runStart = i;
        continue;
      }
    } else if (c === LBRACKET) {
      const sound = readSound(i);
      if (sound) {
        b.text(html.slice(runStart, i));
        b.media({ t: 'sound', src: sound.src });
        i = sound.end;
        runStart = i;
        continue;
      }
    }
    i++;
  }
  b.text(html.slice(runStart, n));
  return b.finish();
}

/**
 * Lines → one plain line (for rows, snackbars, read-aloud, a11y): the text of
 * every line joined by a space; images and sounds left out.
 *
 *   linesToPlain(htmlToLines('ich bin<br>du bist')) → 'ich bin du bist'
 */
export function linesToPlain(lines: readonly (readonly Inline[])[]): string {
  return oneLine(
    lines.map((line) => line.map((part) => (part.t === 'text' ? part.text : ' ')).join('')).join(' '),
  );
}

/**
 * True when the text has at least one real tag (or a comment), so
 * htmlToLines reads it as HTML (a "\n" is then a space). False = plain text
 * (a "\n" is a new line): hasHtmlTags('if i<n:') → false.
 */
export function hasHtmlTags(text: string): boolean {
  return HTML_TAG.test(text ?? '');
}

/** Anki field HTML → one plain line. Same as linesToPlain(htmlToLines(html)). */
export function htmlToPlain(html: string): string {
  return linesToPlain(htmlToLines(html));
}
