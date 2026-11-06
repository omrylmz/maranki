/**
 * Language helpers (spec §9.1–9.2). The data model has NO language columns.
 * Language knowledge lives here, in small helpers keyed by the BCP-47
 * language of a field. A screen asks for the helpers of a term field's
 * language and gets German helpers for German, plain ones for anything else:
 *
 *   const h = termHelpers('de-DE');
 *   h.sortKey('die Abfahrt')  → 'abfahrt'
 *   h.decorate('die Abfahrt') → [{ text: 'die', gender: 'f' }, { text: ' Abfahrt' }]
 *   h.articleQuiz             → true
 *
 *   termHelpers('en-US').decorate('the hour') → [{ text: 'the hour' }]
 *
 * When they apply (spec §9.2): only to fields with role `term`, and only when
 * the field's resolved language (§6.8) is German. Gender colours also need
 * `deck.genderColors !== false`. Those checks belong to the caller.
 *
 * Pure: no React, no I/O.
 */
import { foldText, oneLine } from '../text';
import { primary } from './bcp47';
import { germanArticleSpan, germanSortKey, type GermanGender } from './de';

export * from './bcp47';
export * from './de';

/**
 * One piece of a decorated term. Joining every `text` gives the input back,
 * character for character, so the article is always visible.
 */
export interface Segment {
  text: string;
  /** Set only on the article piece ("die"): its gender, for the colour. */
  gender?: GermanGender;
}

export interface TermHelpers {
  /** The A–Z key of a term (folded: lower case, no accents). */
  sortKey(text: string): string;
  /** The term in pieces; the article piece carries its gender. */
  decorate(text: string): Segment[];
  /** True when this language has an Articles practice (German). */
  articleQuiz: boolean;
}

/** The term as one piece, or no piece for empty text. */
function wholeText(text: string): Segment[] {
  return text === '' ? [] : [{ text }];
}

/** Helpers for any language without special rules. */
const PLAIN: TermHelpers = Object.freeze({
  sortKey: (text: string) => foldText(oneLine(text ?? '')),
  decorate: (text: string) => wholeText(text ?? ''),
  articleQuiz: false,
});

/** German: A–Z by the word, the article coloured by gender. */
const GERMAN: TermHelpers = Object.freeze({
  sortKey: (text: string) => germanSortKey(oneLine(text ?? '')),
  decorate: (text: string): Segment[] => {
    const value = text ?? '';
    const span = germanArticleSpan(value);
    if (!span) return wholeText(value);
    const out: Segment[] = [];
    if (span.start > 0) out.push({ text: value.slice(0, span.start) });
    out.push({ text: value.slice(span.start, span.end), gender: span.gender });
    if (span.end < value.length) out.push({ text: value.slice(span.end) });
    return out;
  },
  articleQuiz: true,
});

/**
 * The term helpers for a language tag (any form normalizeLang reads:
 * 'de-DE', 'de_DE', 'German'). German helpers when the primary language is
 * 'de'; plain helpers otherwise (also when `lang` is missing). The returned
 * object is a shared constant, so it is safe in React dependency lists.
 */
export function termHelpers(lang?: string | null): TermHelpers {
  return primary(lang) === 'de' ? GERMAN : PLAIN;
}
