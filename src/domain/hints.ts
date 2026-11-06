/**
 * Hints: show PART of the answer before the learner reveals it (spec §6.4).
 *
 * "💡 Hint" under the card can be tapped up to 3 times:
 *
 *   tap 1  an example sentence with the answer blanked, when one contains it:
 *            answer "gehe", example "Ich gehe nach Hause." → "Ich ____ nach Hause."
 *          else the first letter of each word and a length mask:
 *            answer "go home" → "g_ · h___"
 *   tap 2  half of the letters:          "go home" → "g_ · h_m_"
 *   tap 3  reveal (the same as tapping the card)
 *
 * The screen hides the hint button when Settings › Hints is off, in Quiz and
 * after reveal. A used hint shows a small "hint" pill, outlines Hard
 * (modes.ts `suggestRating`), and the answer is never a "fast answer". That
 * is the session's job; this file only builds the hint text.
 *
 * Details:
 *   - The example must contain the answer as WHOLE words, compared folded
 *     (no case, no accents): "an" never blanks the "an" inside "kann". Every
 *     place it appears is blanked, and the rest of the sentence keeps its
 *     own case and accents.
 *   - What "whole word" means depends on the script:
 *       · Scripts that write NO spaces between words (Chinese, Japanese,
 *         Thai, Lao, Khmer, Myanmar, Tibetan) match INSIDE the sentence:
 *         "毎日パンを食べる。" → "毎日パンを____。".
 *       · Arabic and Hebrew put spaces between words, but join a few small
 *         words to the FRONT of the next one (the article "ال" in "الكتاب",
 *         "and" = "و", "in" = "ב"). So the answer must END at a word end,
 *         and before it there may be only one of those known prefixes:
 *         "قرأت الكتاب." → "قرأت ال____.", but "كتب" in "المكتبة" (the
 *         library) is a different word and is never blanked.
 *       · Korean puts its small words (particles) at the END of the word
 *         ("책을" = book + object particle): the answer must START at a word
 *         start, and Korean letters may follow it.
 *       · Every other script (with case, like Latin, Greek and Cyrillic, or
 *         without, like Hindi): whole words only.
 *   - The answer needs at least 2 characters that a mask would hide (one
 *     letter would blank too much), and something besides punctuation must
 *     be left after blanking.
 *   - The answer's alternatives ("to go, to walk") are tried too, the
 *     longest first. They are the alternatives of Typing mode
 *     (answerCheck.ts `answerAlternatives`, with the answer's language), so a
 *     German "der/die Angestellte" is tried as "der Angestellte" and "die
 *     Angestellte", never as a bare "der". For a German noun the bare word is
 *     tried after the whole term ("die Stunde" → "Stunde"), so "Eine Stunde
 *     hat …" → "Eine ____ hat …".
 *   - Only examples on the ANSWER side are used: an example on the question
 *     side is already visible.
 *   - Masks hide letters and digits only; spaces between words become " · "
 *     and punctuation stays ("don't" → "d__'_").
 *
 * Pure: no React, no I/O. Hermes-safe: no Unicode property escapes.
 */
import { answerAlternatives, cleanAnswer } from './answerCheck';
import { primary, splitGermanArticle } from './lang';
import type { CardFace } from './model';
import { foldText } from './text';

/** How many taps the hint button has; the last one reveals the card. */
export const HINT_STEPS = 3;

/** What a blanked word shows. */
export const BLANK = '____';

/** What a hidden letter shows in a mask. */
export const MASK_CHAR = '_';

/** Between two words of a mask: "g_ · h___". */
export const WORD_GAP = ' · ';

/** The hint after a tap. */
export type Hint =
  /** Tap 1: an example sentence with the answer blanked. */
  | { step: 1; kind: 'example'; text: string }
  /** Tap 1 (no example) or tap 2: the answer with some letters hidden. */
  | { step: 1 | 2; kind: 'letters'; text: string }
  /** Tap 3: show the answer (the screen reveals the card). */
  | { step: 3; kind: 'reveal' };

/** What the hints of one card are made from. */
export interface HintSource {
  /** The answer to hint at, one line. */
  answer: string;
  /** Example sentences of the answer side (one line each), in order. */
  examples: string[];
  /** The answer's language (BCP-47), for the German noun rule. */
  lang?: string;
}

/**
 * The hint source of a card face: the answer is `face.answerPlain` (for a
 * cloze card that is the deletion's text, "Paris"), the examples are the
 * non-empty 'example' blocks of the answer side. In Typing mode the session
 * passes the typing target instead (`answer`, `lang`), so the hint is about
 * what must be typed.
 */
export function hintSourceOf(face: CardFace, answer?: string, lang?: string): HintSource {
  const examples = face.answer.filter((b) => b.role === 'example' && b.plain.trim() !== '').map((b) => b.plain);
  const source: HintSource = { answer: answer ?? face.answerPlain, examples };
  const language = lang ?? face.answer[0]?.lang;
  if (language) source.lang = language;
  return source;
}

/* --------------------------------------------------------------- letters */

/**
 * Characters that a mask never hides (besides white space): punctuation,
 * also the full-width punctuation of Chinese and Japanese ("。、！？「」"),
 * the Arabic comma, semicolon and question mark and the Urdu full stop
 * ("،؛؟۔"), the Hebrew word joiner and verse end ("־׃"), the Hindi full
 * stops ("।॥") and the Ethiopic word space and punctuation ("፡።፣").
 */
const KEEP = new Set(
  Array.from(
    '.,!?;:…¿¡"“”„«»()[]{}<>\'’‘-–—/·&+=*%$#@~|\\' + '。、・！？：；，．（）「」『』【】〜' + '،؛؟۔' + '־׃' + '।॥' + '፡።፣',
  ),
);

/** One white-space character (the same set as \s in a regex). Tested on ONE character, so it is O(1). */
const SPACE = /\s/;

/** True for a character a mask hides: anything but white space and punctuation. */
function maskable(ch: string): boolean {
  return !SPACE.test(ch) && !KEEP.has(ch);
}

/**
 * The answer with letters hidden, word by word ("words" are split at white
 * space and joined with " · "):
 *   'first'  only the first letter of each word stays:   "die Stunde" → "d__ · S_____"
 *   'half'   every other letter stays (half, rounded up): "die Stunde" → "d_e · S_u_d_"
 * Punctuation is never hidden: "don't" → 'first' "d__'_".
 */
export function letterMask(answer: string, level: 'first' | 'half'): string {
  const words = cleanAnswer(answer).split(' ').filter((w) => w !== '');
  return words
    .map((word) => {
      let k = 0; // index among the maskable characters of this word
      let out = '';
      for (const ch of Array.from(word)) {
        if (!maskable(ch)) {
          out += ch;
          continue;
        }
        const show = level === 'first' ? k === 0 : k % 2 === 0;
        out += show ? ch : MASK_CHAR;
        k++;
      }
      return out;
    })
    .join(WORD_GAP);
}

/* --------------------------------------------------------------- example */

/** True for a letter that has upper and lower case (Latin, Greek, Cyrillic …), or a digit 0–9. */
function wordChar(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || ch.toLowerCase() !== ch.toUpperCase();
}

/** True when the code point of `ch` is in one of `ranges` ([first, last] pairs). */
function inRanges(ch: string, ranges: readonly (readonly [number, number])[]): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return ranges.some(([first, last]) => code >= first && code <= last);
}

/** Hebrew (with its presentation forms). */
const HEBREW: readonly (readonly [number, number])[] = [
  [0x0590, 0x05ff],
  [0xfb1d, 0xfb4f],
];

/** Arabic (with its supplements and presentation forms). */
const ARABIC: readonly (readonly [number, number])[] = [
  [0x0600, 0x06ff], // Arabic
  [0x0750, 0x077f], // Arabic Supplement
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb50, 0xfdff], // Arabic presentation forms A
  [0xfe70, 0xfeff], // Arabic presentation forms B
];

/** Korean (Hangul syllables and letters). */
const HANGUL: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3130, 0x318f], // Hangul compatibility Jamo
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7ff], // Hangul syllables, Jamo Extended-B
];

/**
 * Other scripts without case that DO put spaces between words: Syriac,
 * Thaana, N'Ko, the scripts of India and Sri Lanka (Devanagari … Sinhala),
 * Georgian, Ethiopic.
 */
const OTHER_SPACED: readonly (readonly [number, number])[] = [
  [0x0700, 0x074f], // Syriac
  [0x0780, 0x07ff], // Thaana, N'Ko
  [0x0900, 0x0dff], // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala
  [0x10a0, 0x10ff], // Georgian
  [0x1200, 0x139f], // Ethiopic
];

/** The known small words that Arabic writes joined to the FRONT of a word: "و" (and), "ف", "ب" (with), "ك" (like), "ل" (for), "ال" (the), and their pairs ("وال", "بال", "لل" …). */
const ARABIC_PREFIX = /^[وف]?(?:[بك]?ال|لل|[بكل])?$/;

/** The same for Hebrew: "ו" (and), then "ה" (the), "ב" (in), "כ" (like) or "ל" (to). Not "מ" or "ש": they also start many words of their own ("מספר" = number). */
const HEBREW_PREFIX = /^ו?[הבכל]?$/;

/**
 * The longest prefix that ARABIC_PREFIX or HEBREW_PREFIX can match, in
 * characters: 4, for Arabic "و" or "ف" + "بال" or "كال" ("وبال" = and with
 * the). Hebrew prefixes are at most 2 ("וה").
 */
const MAX_PREFIX = 4;

/**
 * True for a letter of a script that puts spaces between words but has no
 * case (Arabic, Hebrew, Korean, Hindi …): such a letter next to the answer
 * means the answer stands inside a longer word. The punctuation of those
 * scripts ("،" "؟" "।" …) is in KEEP, so it is never a letter.
 */
function spacedLetter(ch: string): boolean {
  if (!maskable(ch)) return false;
  return inRanges(ch, ARABIC) || inRanges(ch, HEBREW) || inRanges(ch, HANGUL) || inRanges(ch, OTHER_SPACED);
}

/** True for a letter of any script with spaces between words (with case or without), or a digit. */
function letterOfWord(ch: string): boolean {
  return wordChar(ch) || spacedLetter(ch);
}

/**
 * May a match of the needle start at `at`? `first` is the needle's first
 * character. Yes at a word start. Inside a word, only for scripts without
 * spaces (see the file header), and for Arabic and Hebrew after a known
 * prefix that itself starts the word ("ال" in "الكتاب").
 */
function startOk(chars: readonly string[], at: number, first: string): boolean {
  const before = at > 0 ? chars[at - 1] : ' ';
  if (!letterOfWord(before)) return true; // a word start, or a letter of a script without spaces
  const prefixRule = inRanges(first, ARABIC) ? ARABIC_PREFIX : inRanges(first, HEBREW) ? HEBREW_PREFIX : null;
  if (prefixRule === null || wordChar(before)) return false;
  // Walk back to the start of the word: more than MAX_PREFIX letters are no prefix.
  let start = at;
  while (start > 0 && letterOfWord(chars[start - 1])) {
    if (at - start >= MAX_PREFIX) return false;
    start--;
  }
  return prefixRule.test(chars.slice(start, at).join(''));
}

/**
 * May a match of the needle end just before `end`? `last` is the needle's
 * last character. Yes at a word end. Inside a word, only for scripts
 * without spaces, and for Korean, whose particles follow the word ("책을").
 */
function endOk(chars: readonly string[], end: number, last: string): boolean {
  const after = end < chars.length ? chars[end] : ' ';
  if (!letterOfWord(after)) return true;
  return inRanges(last, HANGUL) && inRanges(after, HANGUL);
}

/**
 * The folded text of `text` and, for each folded character, the index of
 * the original character it came from (folding can change the length:
 * "ß" → "ss").
 */
function foldWithMap(text: string): { folded: string; from: number[]; chars: string[] } {
  const chars = Array.from(text);
  let folded = '';
  const from: number[] = [];
  chars.forEach((ch, i) => {
    const f = foldText(ch);
    for (const part of Array.from(f)) {
      folded += part;
      from.push(i);
    }
  });
  return { folded, from, chars };
}

/**
 * The example with every whole-word place of `needle` replaced by "____", or
 * null when the needle is not in it. Compared folded; the rest keeps its own
 * text.
 *
 *   blankIn('Ich gehe nach Hause.', 'gehe') → 'Ich ____ nach Hause.'
 */
function blankIn(example: string, needle: string): string | null {
  const key = foldText(cleanAnswer(needle));
  // "a" would blank too much. Counted with the mask's own test, so the
  // letters of every script count ("食べる" has 3), not only letters with case.
  if (Array.from(key).filter(maskable).length < 2) return null;
  const { folded, from, chars } = foldWithMap(example);
  const foldedChars = Array.from(folded);
  // indexOf works on UTF-16 units; the map is per character, so search the character array.
  const keyChars = Array.from(key);
  const hits: [number, number][] = [];
  for (let at = 0; at + keyChars.length <= foldedChars.length; at++) {
    let ok = true;
    for (let k = 0; k < keyChars.length && ok; k++) ok = foldedChars[at + k] === keyChars[k];
    if (!ok) continue;
    // Whole words only, with the rules of the answer's script (see the file header).
    if (!startOk(foldedChars, at, keyChars[0]) || !endOk(foldedChars, at + keyChars.length, keyChars[keyChars.length - 1])) continue;
    let end = from[at + keyChars.length - 1];
    // A combining accent mark after the last letter folds to nothing: blank it with its letter.
    while (end + 1 < chars.length && foldText(chars[end + 1]) === '') end++;
    hits.push([from[at], end]);
    at += keyChars.length - 1;
  }
  if (hits.length === 0) return null;
  let out = '';
  let next = 0;
  for (const [start, end] of hits) {
    out += chars.slice(next, start).join('') + BLANK;
    next = end + 1;
  }
  out += chars.slice(next).join('');
  // A sentence that was only the answer is no hint: nothing but punctuation
  // would be left to read. (The mask's test again: "毎日" is something to read.)
  return Array.from(out.split(BLANK).join('')).some(maskable) ? out : null;
}

/**
 * The words to look for in an example, best first: the whole answer, its
 * alternatives (longest first), and for a German noun the bare word.
 *
 * The alternatives are the ones of checkAnswer, WITH the answer's language
 * (answerAlternatives). WHY: a German "der/die Angestellte" gives "der
 * Angestellte" and "die Angestellte", never a bare "der". With "der" as a
 * needle, the hint would blank every article and show the noun, which is
 * the answer.
 *
 *   needlesOf({ answer: 'der/die Angestellte', lang: 'de-DE', … })
 *     → ['der/die Angestellte', 'der Angestellte', 'die Angestellte', 'Angestellte']
 */
function needlesOf(source: HintSource): string[] {
  const alts = answerAlternatives(source.answer, { lang: source.lang });
  const [whole, ...parts] = alts;
  const out = whole === undefined ? [] : [whole, ...parts.sort((a, b) => b.length - a.length)];
  if (primary(source.lang) === 'de') {
    for (const text of [...out]) {
      const { article, rest } = splitGermanArticle(text);
      if (article && rest && !out.includes(rest)) out.push(rest);
    }
  }
  return out;
}

/**
 * The first example with the answer blanked (see the file header), or null
 * when no example contains it.
 *
 *   blankExample({ answer: 'gehe', examples: ['Ich gehe nach Hause.'] }) → 'Ich ____ nach Hause.'
 */
export function blankExample(source: HintSource): string | null {
  const needles = needlesOf(source);
  for (const needle of needles) {
    for (const example of source.examples) {
      const blanked = blankIn(example, needle);
      if (blanked !== null) return blanked;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ steps */

/**
 * The hint after `step` taps (1, 2 or 3; spec §6.4). Step 0 (or less) → null:
 * no hint yet. Step 3 or more → reveal. An answer with no letters to hide
 * (an image) goes straight to reveal.
 *
 *   hintAt({ answer: 'go home', examples: [] }, 1) → { step: 1, kind: 'letters', text: 'g_ · h___' }
 *   hintAt({ answer: 'go home', examples: [] }, 2) → { step: 2, kind: 'letters', text: 'g_ · h_m_' }
 *   hintAt(source, 3)                              → { step: 3, kind: 'reveal' }
 */
export function hintAt(source: HintSource, step: number): Hint | null {
  if (!(step >= 1)) return null;
  if (step >= HINT_STEPS || !Array.from(cleanAnswer(source.answer)).some(maskable)) {
    return { step: 3, kind: 'reveal' };
  }
  if (step === 1) {
    const example = blankExample(source);
    if (example !== null) return { step: 1, kind: 'example', text: example };
    return { step: 1, kind: 'letters', text: letterMask(source.answer, 'first') };
  }
  return { step: 2, kind: 'letters', text: letterMask(source.answer, 'half') };
}
