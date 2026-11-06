/**
 * German term helpers (spec §9.2, `de.ts`). They read the ARTICLE of a German
 * noun ("die Abfahrt") from the text itself. Nothing is stored: the data
 * model has no gender column, so these helpers work for any German deck.
 *
 *   splitGermanArticle('die Abfahrt')         → { article: 'die', rest: 'Abfahrt', gender: 'f' }
 *   splitGermanArticle('der/die Angestellte') → { article: null, rest: 'Angestellte', gender: null }
 *   splitGermanArticle('Ufer')                → { article: null, rest: 'Ufer', gender: null }
 *   splitGermanArticle('die Eltern (Pl.)')    → { article: 'die', rest: 'Eltern', gender: 'pl' }
 *   splitGermanArticle('das Internet (Sg.)')  → { article: 'das', rest: 'Internet', gender: 'n' }
 *   germanSortKey('die Abfahrt')              → 'abfahrt'   (A–Z by the word, not the article)
 *   isArticleQuizCard('das Haus')             → true        (singular der/die/das noun)
 *
 * Used by: gender colours (TermText), the Library A–Z sort, the Typing mode
 * hint "remember the article", and Articles practice.
 *
 * Rules:
 *   - The article is matched without case ("Die Abfahrt" works) and is
 *     returned in lower case.
 *   - The word after the article must start with a CAPITAL letter, because
 *     German nouns always do. So phrases like "das heißt" or "die beiden" are
 *     NOT read as article + noun (no wrong gender colour).
 *   - Two articles ("der/die Angestellte") → article null: the gender is not
 *     one value. The rest is still the word, so A–Z sorts it under A.
 *   - A trailing "(Pl.)", "(pl)", "(Plural)" or "(nur Pl.)" marks a plural:
 *     gender 'pl'. It is left out of `rest`.
 *   - A trailing "(Sg.)", "(sg)", "(Singular)" or "(nur Sg.)" marks a word
 *     used only in the singular ("das Internet (Sg.)" in the real German
 *     deck). It is also left out of `rest`; the gender stays the article's.
 *     So A–Z and the Articles practice see the bare word "Internet".
 *
 * Pure: no React, no I/O. Hermes-safe (no lookbehind, no `normalize`).
 */
import { foldText } from '../text';

export type GermanArticle = 'der' | 'die' | 'das';

/** m = der (masculine), f = die (feminine), n = das (neuter), pl = plural. */
export type GermanGender = 'm' | 'f' | 'n' | 'pl';

export interface GermanTermParts {
  /** The singular article, lower case, or null (no article, or "der/die"). */
  article: GermanArticle | null;
  /** The term without its article and without a plural / singular marker, trimmed. */
  rest: string;
  /** The gender the article (or a plural marker) shows, or null. */
  gender: GermanGender | null;
}

/** Where the article sits inside the ORIGINAL text, for gender colours. */
export interface GermanArticleSpan {
  /** Index of the article's first letter. */
  start: number;
  /** Index just after the article. */
  end: number;
  gender: GermanGender;
}

const GENDER_OF: Record<GermanArticle, GermanGender> = { der: 'm', die: 'f', das: 'n' };

/*
 * The markers are tested on the LAST "(…)" of the text only, and they are
 * anchored at both ends (^ … $). WHY: an unanchored /\s*\(…$/ on the whole
 * text tries every start position inside a long run of spaces, which is
 * O(n²) — 40,000 spaces took 2.6 s and froze the JS thread. A raw CSV field
 * or a <pre> term can have such a run.
 */

/** A plural marker, the whole "(…)": "(Pl.)", "(pl)", "(Plural)", "(nur Pl.)". */
const PLURAL_MARK = /^\(\s*(?:nur\s+)?pl(?:ural)?\.?\s*\)$/i;

/** A singular-only marker, the whole "(…)": "(Sg.)", "(sg)", "(Sing.)", "(Singular)", "(nur Sg.)". Gender unchanged. */
const SINGULAR_MARK = /^\(\s*(?:nur\s+)?(?:sg|sing(?:ular)?)\.?\s*\)$/i;

/** One white-space character (the same set as \s in a regex). Tested on ONE character, so it is O(1). */
const SPACE = /\s/;

/** The index after the last character that is not white space (a backward loop, linear). */
function endWithoutSpaces(s: string, end: number): number {
  let i = end;
  while (i > 0 && SPACE.test(s.charAt(i - 1))) i--;
  return i;
}

/**
 * A trailing "(Pl.)" / "(Sg.)" marker of `body` (already trimmed at the end):
 * which kind, and where the text before it (and its spaces) ends. Null when
 * the text does not end with a marker. Linear: only the last "(…)" is tested.
 */
function trailingMarker(body: string): { plural: boolean; cut: number } | null {
  if (!body.endsWith(')')) return null;
  const open = body.lastIndexOf('(');
  if (open === -1) return null;
  const tail = body.slice(open);
  const plural = PLURAL_MARK.test(tail);
  if (!plural && !SINGULAR_MARK.test(tail)) return null;
  return { plural, cut: endWithoutSpaces(body, open) };
}

/** One leading article and the space after it: "die ". */
const ONE_ARTICLE = /^(der|die|das)\s+/i;

/** Two or more leading articles joined by "/": "der/die ", "der / die / das ". */
const MANY_ARTICLES = /^(?:der|die|das)(?:\s*\/\s*(?:der|die|das))+\s+/i;

/** True when the first character of `s` is an upper-case letter (any alphabet). */
function startsUpper(s: string): boolean {
  const ch = s.charAt(0);
  return ch !== '' && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** Everything the two public functions need, in one pass. */
function parse(term: string): GermanTermParts & { span: GermanArticleSpan | null } {
  // Linear time on any input (see the markers above): no regex runs over a long run of spaces.
  const lead = term.length - term.replace(/^\s+/, '').length;
  let body = term.slice(lead, Math.max(lead, endWithoutSpaces(term, term.length)));
  const marker = trailingMarker(body);
  const plural = marker?.plural === true;
  if (marker) body = body.slice(0, marker.cut);

  const many = MANY_ARTICLES.exec(body);
  if (many && startsUpper(body.slice(many[0].length))) {
    return {
      article: null,
      rest: body.slice(many[0].length).trim(),
      gender: plural ? 'pl' : null,
      span: null,
    };
  }

  const one = ONE_ARTICLE.exec(body);
  if (one && startsUpper(body.slice(one[0].length))) {
    const article = one[1].toLowerCase() as GermanArticle;
    const gender: GermanGender = plural ? 'pl' : GENDER_OF[article];
    return {
      article,
      rest: body.slice(one[0].length).trim(),
      gender,
      span: { start: lead, end: lead + one[1].length, gender },
    };
  }

  return { article: null, rest: body.trim(), gender: plural ? 'pl' : null, span: null };
}

/** Split a German term into its article, the word, and the gender. See the file header. */
export function splitGermanArticle(term: string): GermanTermParts {
  const { article, rest, gender } = parse(term ?? '');
  return { article, rest, gender };
}

/**
 * Where the single article is in `term` (for colouring it), or null when
 * there is none. The text itself is never changed: the article stays visible,
 * so colour is never the only signal.
 *
 *   germanArticleSpan('die Abfahrt') → { start: 0, end: 3, gender: 'f' }
 */
export function germanArticleSpan(term: string): GermanArticleSpan | null {
  return parse(term ?? '').span;
}

/**
 * The A–Z key of a German term: the word without its article, folded
 * (lower case, no accents). So "die Abfahrt" sorts under A, not under D.
 *
 *   germanSortKey('die Abfahrt') → 'abfahrt'
 *   germanSortKey('der Ärger')   → 'arger'
 */
export function germanSortKey(term: string): string {
  return foldText(parse(term ?? '').rest);
}

/**
 * True when the term is a singular noun with exactly one article
 * (der/die/das), so the Articles practice can ask "der, die or das?".
 * Plurals and "der/die" terms are left out.
 */
export function isArticleQuizCard(term: string): boolean {
  const parts = parse(term ?? '');
  return parts.article !== null && parts.gender !== 'pl' && parts.rest !== '';
}
