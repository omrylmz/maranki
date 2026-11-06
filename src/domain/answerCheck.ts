/**
 * Typing mode: is the typed answer right? (spec §6.3 "Typing").
 *
 * The learner sees the question, types the answer and taps "Check".
 * `checkAnswer(input, expected, { lang })` compares the two and says (the
 * session calls it through `checkTyped(input, target)`, see rule 6):
 *
 *   'exact'  the same answer             → suggests Good
 *   'close'  almost (a typo, accents)    → suggests Hard
 *   'wrong'  something else              → suggests Again
 *
 * A mode only SUGGESTS a rating (decision D8): the session outlines that
 * button, and the learner still taps one of the 4 rating buttons. So this
 * file never changes the schedule.
 *
 * The rules, in order:
 *   1. Both texts are cleaned: spaces at the ends removed, every run of
 *      spaces made one space, and punctuation at the ends dropped
 *      ("Hello!" = "hello", "¿Qué?" = "que"). A "." or "," that STARTS a
 *      number is its decimal point, so it stays: ".5" is 0.5, never "5".
 *   2. Case never matters ("Haus" = "haus"), and ß = ss ("Strasse" = "Straße":
 *      Swiss German and capital letters write ß as "ss", so it is a spelling
 *      variant, not a wrong letter).
 *   3. The expected text may hold ALTERNATIVES split by , ; or / — any one
 *      of them counts ("to go, to walk" accepts "to walk"). The whole text
 *      counts too. A "," or "/" with a digit on both sides is part of a
 *      NUMBER, not a split: "1,000", "3/4" and "24/7" stay whole, so "1" or
 *      "3" is never the answer. A "/" between two digits WITH spaces around
 *      it can mean one value or a list; the text around it decides
 *      (spacedOneValue). One value: two one-digit numbers ("1 / 2" stays
 *      whole, never "1" or "2"; "6 / 8", a time signature), a fraction in
 *      lowest terms ("24 / 7"), a mixed number ("2 2 / 4") and a date
 *      ("3 / 10 / 2024"). A LIST splits, as any other slash: "10 / 20 / 30"
 *      accepts "10", "0.5 / 1/2" accepts "1/2", "6:45 / 7:30" (two clock
 *      times) accepts "6:45", "20 / 30" (not in lowest terms) accepts "20",
 *      and "1939 / 1945" (big numbers) accepts "1945". In both cases the
 *      spaces around a slash between two digits are formatting: "1/2" =
 *      "1 / 2", "6/8" = "6 / 8".
 *      A leading part in brackets is optional (see formsOf):
 *      "(to) go" accepts "go" and "to go", "(sich) freuen" accepts "freuen",
 *      "(die) Eltern (Pl.)" accepts "Eltern", and "(der/die) Angestellte"
 *      accepts "Angestellte", "der Angestellte" and "die Angestellte". A
 *      note in brackets at the END is optional too (wave 5d): "gehen (ging /
 *      gegangen)" accepts "gehen", "Haus (n / pl)" accepts "Haus" (only a
 *      note of words: "x (mod 5)" keeps its one form). A separator INSIDE
 *      brackets, wherever they are, never splits the answer (cutAt): "Haus
 *      (n / pl)" is never "Haus (n" or "pl)".
 *      A plural-suffix note of a word list is not
 *      an answer: "die Abfahrt, -en" accepts "die Abfahrt", never "-en".
 *      `answerAlternatives(expected, { lang })` lists them; hints.ts and
 *      distractors.ts use the same list.
 *   4. Only the ACCENTS differ ("uber" for "über") → 'close'.
 *   5. A small typo → 'close': an edit distance of at most 1 for answers of up
 *      to 6 letters, at most 2 for longer ones. "Edit distance" = how many
 *      letters you must add, remove, change, or swap with the next letter to
 *      turn one text into the other ("Abfhart" → "Abfahrt" is 1 swap). A typo
 *      can never be the whole answer (a 1-letter answer has no typo). ß (and
 *      æ, œ) is ONE letter here, both for the limit and for the distance,
 *      although rule 2 compares it as "ss": "Straße" has 6 letters, so one
 *      wrong or missing letter is close ("Strae", "Strabe", "Strase") and
 *      two are wrong ("Stase"). The learner may also write ß as "ss" and
 *      still make one typo ("Strasee" is close): the distance is the
 *      smaller one of the two spellings.
 *      NUMBERS are never a typo: a different digit is a different value,
 *      not a spelling mistake. When the typed text or the answer has a
 *      digit, their numbers must be the same (numberShape), else the answer
 *      is 'wrong':
 *        - the same digits and minus signs: "1944" for "1945", "42" for
 *          "24", "3" for "-3", "x=3" for "x=-3", "0.76" for "0.75" and
 *          "O(1)" for "O(n)" are wrong;
 *        - a FRACTION is one value: its bar ("/" between two numbers,
 *          "1/2", "3/4"), and where it starts and ends, must be in the same
 *          place in both texts. "12" for "1/2", "1.2" for "1/2", "1/2" for
 *          "12" and "11/2" for "1 1/2" are wrong, never a typo. A chain of
 *          bars ("3/10/2024", a date) is not a fraction:
 *          its slashes cut the digits like any other separator;
 *        - the decimal point in the same place: "75" for "7.5", "31.4"
 *          for "3.14" and "5" for ".5" are wrong. A "." or "," followed by
 *          exactly 3 digits is a thousands separator, not a decimal point
 *          ("1,000" = "1.000" = "1000"), and "." and "," are the same
 *          decimal point ("0,75" = "0.75"). A decimal point where the other
 *          text also cuts its digits (a space, ":", "/") is formatting too:
 *          "12.30" for "12:30", "(2,3)" for "(2, 3)".
 *        - a zero that does not change the value is formatting too: a zero
 *          at the START of a whole number ("9:00" for "09:00", "7.5.1945"
 *          for "07.05.1945") and a zero at the END of a decimal part
 *          ("10.5" for "10.50", "9.80" for "9.8"). "0750" for "0,750" stays
 *          wrong: there the zero is in front of a decimal part (0.750).
 *          A German day and month with an ordinal dot ("3.10." = 3 October)
 *          is a DATE, not a decimal number: the zero of the month 10 counts,
 *          so "3.1." (3 January) for "3.10." is wrong, and "3.10." for
 *          "03.10." is formatting. Only a day 1–31 and a month 1–12 are a
 *          date ("3.50." is a decimal number before a full stop), and the
 *          learner never has to type the last dot ("3.10" for "3.10." is
 *          exact).
 *          A padding zero AND another time separator are formatting too
 *          ("um 9.30 Uhr" for "um 09:30 Uhr"). But removing a zero never
 *          joins or moves numbers: "90" for "9:00", "95" or "9.5" for
 *          "9:05" and "15" for "1:05" are wrong (the zero of the minutes
 *          counts).
 *      A digit written as superscript, subscript or full-width is that digit
 *      ("CO2" for "CO₂", "m2" for "m²"), and "–" (en dash), "−" and the
 *      other minus forms are a minus sign ("-3" for "–3"): a phone keyboard
 *      cannot type most of them. A dash between two letters or digits is
 *      not a sign ("B-52", "3-4"). A pure formatting difference keeps the
 *      same numbers, so the typo rule still decides: "1000" for "1,000",
 *      "CO2" for "CO₂", "-3" for "–3" and "9:00" for "09:00" are 'close'.
 *   6. German term targets (the field's language is German): a MISSING
 *      leading article → 'close', and the result names the article, so the
 *      screen can say "Almost — remember the article: **die** Abfahrt".
 *      A WRONG article on the right noun ("der Abfahrt" for "die Abfahrt",
 *      "das Hund" for "der Hund") → 'wrong' (Again), for nouns of any
 *      length: the gender is what a German learner must learn, so it is
 *      never "almost". (Rule 5 alone would call "der Abfahrt" a 2-letter
 *      typo.) This also holds when the field lists the plural: "die Hund"
 *      for "der Hund, die Hunde" is wrong, although it is only 1 letter away
 *      from "die Hunde" (a typo match on another form never beats a wrong
 *      article; see RANK). The result's `expected` is the right form
 *      ("die Abfahrt", "der Hund"), and its diff marks the article. A
 *      trailing "(Pl.)" / "(Sg.)" marker never has to be typed. The article
 *      rules need a TERM field (spec §9.2): `checkTyped(input, target)`
 *      passes `term` from the target's role.
 *   6b. English answers (the field's language is English): a MISSING leading
 *      "to", "the", "a" or "an" → 'close', like the German article, and the
 *      result names the word, so the screen can say "Almost — remember the
 *      “to”: **to** sleep" ("sleep" for "to sleep / the sleep"). Only for a
 *      word or a short phrase: a term or a meaning field, never an example
 *      sentence (`checkTyped` passes `word` from the target's role). A
 *      DIFFERENT little word is not a gender mistake in English, so the
 *      typo rule decides it as usual.
 *   7. German answers (the field's language is German, any role):
 *      "der/die Angestellte, -n" means "der Angestellte" OR "die
 *      Angestellte", and a part that is only an article is never an answer
 *      ("die" in "Abfahrt, die"). So "der" alone is never right, a hint
 *      never blanks only the articles, and a quiz never thinks two "der/die"
 *      nouns are the same answer.
 *
 * Typing is only offered for SHORT answers: `isTypeable(target)` is false for
 * an answer over 60 characters or with line breaks, and the card falls back
 * to Flashcards ("Long answer — flip instead").
 *
 * The result also carries a letter DIFF (which typed letters were right,
 * wrong, extra or missing), so the screen can underline them in
 * `c.success` / `c.danger`.
 *
 * Pure: no React, no I/O. Hermes-safe: no `String.prototype.normalize`, no
 * look-behind, no Unicode property escapes.
 */
import { primary, splitGermanArticle, type GermanArticle } from './lang';
import type { CardFace, FieldBlock, FieldRole, NoteType } from './model';
import { foldText } from './text';
import type { Rating } from './types';

/* ------------------------------------------------------------------ copy */

/** The fallback line when an answer is too long to type (spec §6.3). */
export const LONG_ANSWER_COPY = 'Long answer — flip instead';

/**
 * The start of the "missing article" line (spec §6.3). The screen adds the
 * article in bold and the word: "Almost — remember the article: **die** Abfahrt".
 */
export const ARTICLE_HINT_COPY = 'Almost — remember the article:';

/**
 * The start of the "missing to" line (rule 6b): "to" is not an article, so
 * it has its own words. The screen adds "**to** sleep".
 */
export const TO_HINT_COPY = 'Almost — remember the “to”:';

/**
 * The start of the line for a missing little word (reason 'article'):
 *
 *   leadHintCopy('die') → 'Almost — remember the article:'
 *   leadHintCopy('the') → 'Almost — remember the article:'
 *   leadHintCopy('to')  → 'Almost — remember the “to”:'
 */
export function leadHintCopy(lead: LeadWord): string {
  return lead === 'to' ? TO_HINT_COPY : ARTICLE_HINT_COPY;
}

/** Answers longer than this (in characters) are not typed: the card is flipped instead. */
export const TYPING_MAX_CHARS = 60;

/* ----------------------------------------------------------------- types */

export type AnswerVerdict = 'exact' | 'close' | 'wrong';

/**
 * The little word in front of a word that a learner may forget (rules 6
 * and 6b): a German article, or English "to", "the", "a", "an".
 */
export type LeadWord = GermanArticle | 'to' | 'the' | 'a' | 'an';

/**
 * Why an answer is 'close':
 *   accents  only the accents differ ("uber" for "über");
 *   article  only the little word in front is missing: a German article
 *            ("Abfahrt" for "die Abfahrt"; a WRONG article is 'wrong', rule 6)
 *            or English "to", "the", "a", "an" ("sleep" for "to sleep", rule 6b);
 *   typo     a small edit distance (rule 5).
 * 'exact' and 'wrong' have no reason (null).
 */
export type CloseReason = 'accents' | 'article' | 'typo';

/**
 * One piece of the letter diff, read from left to right:
 *   same     typed right                      (typed === expected text, maybe other case)
 *   change   typed, but the answer has other letters here
 *   extra    typed, but the answer has nothing here
 *   missing  not typed, the answer has these letters here
 */
export interface DiffPart {
  op: 'same' | 'change' | 'extra' | 'missing';
  /** What the learner typed in this piece ('' for 'missing'). */
  typed: string;
  /** What the answer has in this piece ('' for 'extra'). */
  expected: string;
}

export interface AnswerResult {
  verdict: AnswerVerdict;
  /** The rating the mode suggests: exact → good, close → hard, wrong → again. */
  suggested: Rating;
  /** Why it is 'close', else null. */
  reason: CloseReason | null;
  /**
   * The expected answer the input was compared with, cleaned (the best
   * alternative). For a missing article it is the full form: "die Abfahrt".
   */
  expected: string;
  /**
   * Reason 'article' only: the little word to remember (a German article, or
   * English "to" / "the" / "a" / "an") and the word after it, else null.
   */
  article: { article: LeadWord; word: string } | null;
  /** The letter diff between the typed text and `expected`. */
  diff: DiffPart[];
}

/** Options of checkAnswer. */
export interface CheckOptions {
  /** BCP-47 language of the expected answer ('de-DE'), as FieldBlock.lang. */
  lang?: string | null;
  /**
   * False when the target field is NOT a term (for example an example
   * sentence). The German "missing article" rule only applies to terms.
   * Default true. The session uses `checkTyped`, which sets it from the
   * field's role, so it never forgets it.
   */
  term?: boolean;
  /**
   * False when the target is NOT a word or a short phrase (for example an
   * example sentence). The English "missing to / the / a" rule (6b) only
   * applies to words. Default true. `checkTyped` sets it from the field's
   * role: 'term' and 'meaning' are words.
   */
  word?: boolean;
}

/* -------------------------------------------------------------- cleaning */

/** Punctuation that is dropped at the two ends of an answer. */
const END_PUNCT = new Set(Array.from('.,!?;:…¿¡"“”„«»。！？、'));

/** One white-space character (the same set as \s in a regex). Tested on ONE character, so it is O(1). */
const SPACE = /\s/;

/**
 * True when the character at `i` is dropped at the START of an answer: a
 * space or end punctuation, but NOT a "." or "," with a digit right after
 * it. That one is the decimal point of a number (".5" = 0.5); dropping it
 * would turn ".5" into "5", a different value (rule 5).
 */
function droppedAtStart(s: string, i: number): boolean {
  const ch = s.charAt(i);
  if (SPACE.test(ch)) return true;
  if (!END_PUNCT.has(ch)) return false;
  return !((ch === '.' || ch === ',') && digitOf(s.charAt(i + 1)) !== '');
}

/**
 * Where the cleaned text of `text` starts and ends (see cleanAnswer): `s` is
 * the text with every run of white space made one space, and the cleaned
 * text is `s.slice(start, end)`.
 */
function cleanBounds(text: string): { s: string; start: number; end: number } {
  const s = (text ?? '').replace(/\s+/g, ' ');
  let start = 0;
  let end = s.length;
  while (start < end && droppedAtStart(s, start)) start++;
  while (end > start && (SPACE.test(s.charAt(end - 1)) || END_PUNCT.has(s.charAt(end - 1)))) end--;
  return { s, start, end };
}

/**
 * A typed or expected text, cleaned for comparison and display: every run of
 * white space becomes one space, and spaces and punctuation at the two ends
 * are dropped. Case and accents stay. A number that starts with its decimal
 * point keeps it (".5" stays ".5"); a full stop at the END is still dropped
 * ("1945." → "1945").
 *
 *   cleanAnswer('  Hello,   world! ') → 'Hello, world'
 *   cleanAnswer('¿Qué tal?')          → 'Qué tal'
 *   cleanAnswer('.5')                 → '.5'
 */
export function cleanAnswer(text: string): string {
  const { s, start, end } = cleanBounds(text);
  return s.slice(start, end);
}

/**
 * cleanAnswer, but a "." right after the LAST digit stays. Only the number
 * rule (rule 5) reads this text: in German, "3.10." is a date (3 October,
 * written with an ordinal dot) and "3.10" is a decimal number (3.1).
 * cleanAnswer drops that dot like the full stop of a sentence, so the number
 * rule could not tell the two apart. Every other comparison still uses
 * cleanAnswer, so a learner never has to type that dot ("3.10" for "3.10."
 * is exact).
 *
 *   numberText('am 3.10.') → 'am 3.10.'
 *   numberText('1945.')    → '1945.'
 *   numberText('Hallo.')   → 'Hallo'
 */
function numberText(text: string): string {
  const { s, start, end } = cleanBounds(text);
  const dotAfterDigit = end > start && s.charAt(end) === '.' && digitOf(s.charAt(end - 1)) !== '';
  return s.slice(start, dotAfterDigit ? end + 1 : end);
}

/**
 * The "/" at `i` with a digit on both sides, maybe with spaces between
 * ("1/2", "1 / 2", "6 / 8", "10 / 20"). Returns where the digits are
 * (`before` = the index of the digit before the slash, `after` = the index
 * of the digit after it), or null.
 *
 * It does NOT say what the slash means (one value or a list): the spaces
 * around such a slash are always formatting (tightFractions: "6/8" =
 * "6 / 8"), and only cutAt asks numberSlash whether it splits alternatives.
 * WHY two questions (wave 5c, review round 1): when the context rule of
 * numberSlash also decided the formatting, "6 / 8" for "6/8" and "4/4" for
 * "4 / 4" were 'wrong', because their spaces counted again.
 *
 *   slashBetweenDigits('1 / 2', 2)  → { before: 0, after: 4 }
 *   slashBetweenDigits('he/she', 2) → null
 */
function slashBetweenDigits(text: string, i: number): { before: number; after: number } | null {
  if (text.charAt(i) !== '/') return null;
  let before = i - 1;
  while (before >= 0 && SPACE.test(text.charAt(before))) before--;
  let after = i + 1;
  while (after < text.length && SPACE.test(text.charAt(after))) after++;
  if (before < 0 || digitOf(text.charAt(before)) === '' || digitOf(text.charAt(after)) === '') return null;
  return { before, after };
}

/**
 * True when the "/" at `i` is part of a NUMBER, so it never splits
 * alternatives (rule 3):
 *   - TIGHT, a digit right on both sides ("1/2", "24/7", "3/10/2024"):
 *     always (a chain of bars is a date, see fractionBars).
 *   - SPACED, a digit on both sides with spaces between ("1 / 2"): the
 *     spaces make it look like a list ("10 / 20 / 30" = 10 or 20 or 30), so
 *     only when the text around it makes ONE value (spacedOneValue).
 *     Otherwise it splits alternatives, as before wave 5b.
 *
 *   numberSlash('3/4', 1)          → true
 *   numberSlash('1 / 2', 2)        → true    (one half)
 *   numberSlash('10 / 20 / 30', 3) → false   (a list)
 *   numberSlash('he / she', 3)     → false   (no digits)
 */
function numberSlash(text: string, i: number): boolean {
  const bar = slashBetweenDigits(text, i);
  if (!bar) return false;
  const tight = bar.before === i - 1 && bar.after === i + 1;
  return tight || spacedOneValue(text, bar.before, bar.after);
}

/** The most digits a number next to a spaced slash may have (more: it is read as a list, never as one value). */
const SPACED_FRACTION_DIGITS = 9;

/** From this many digits on, two numbers around a spaced slash are a list: "1939 / 1945" (two years), never a fraction. */
const LIST_NUMBER_DIGITS = 3;

/**
 * How many more numbers of a chain of slashes are read on EACH side of the
 * slash. 2 is enough to tell the chains apart: 3 numbers in all can be a
 * date ("3 / 10 / 2024"), 4 or more are always a list.
 */
const CHAIN_LOOK = 2;

/** The greatest common divisor of two whole numbers (Euclid): gcd(20, 30) = 10, gcd(1, 2) = 1. */
function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const rest = x % y;
    x = y;
    y = rest;
  }
  return x;
}

/**
 * The number that ENDS at the digit `end`, read backwards: its digits and
 * the index of its first digit. At most SPACED_FRACTION_DIGITS + 1 digits
 * are read (a longer number is a list anyway), so the scan stays short.
 *
 *   numberBefore('10 / 20', 1) → { first: 0, digits: '10' }
 */
function numberBefore(text: string, end: number): { first: number; digits: string } {
  let first = end;
  let digits = digitOf(text.charAt(end));
  while (first > 0 && digits.length <= SPACED_FRACTION_DIGITS && digitOf(text.charAt(first - 1)) !== '') {
    first--;
    digits = digitOf(text.charAt(first)) + digits;
  }
  return { first, digits };
}

/** The number that STARTS at the digit `start`: its digits and the index of its last digit (see numberBefore). */
function numberAfter(text: string, start: number): { last: number; digits: string } {
  let last = start;
  let digits = digitOf(text.charAt(start));
  while (digits.length <= SPACED_FRACTION_DIGITS && digitOf(text.charAt(last + 1)) !== '') {
    last++;
    digits += digitOf(text.charAt(last));
  }
  return { last, digits };
}

/** True when a "." or "," comes right before the number that starts at `first`: it is a decimal number ("0.5", ".5", "1,5"). */
function decimalBefore(text: string, first: number): boolean {
  const ch = text.charAt(first - 1);
  return ch === '.' || ch === ',';
}

/** True when a "." or "," and a digit come right after the number that ends at `last`: a decimal part ("2,5"). */
function decimalAfter(text: string, last: number): boolean {
  const ch = text.charAt(last + 1);
  return (ch === '.' || ch === ',') && digitOf(text.charAt(last + 2)) !== '';
}

/**
 * True when a digit and a ":" come right before the number that starts at
 * `first`: it is the second half of a clock time or a ratio (the "45" of
 * "6:45", the "9" of "16:9"). A ":" after a word ("Note:1") is not one.
 */
function timeBefore(text: string, first: number): boolean {
  return text.charAt(first - 1) === ':' && digitOf(text.charAt(first - 2)) !== '';
}

/** True when a ":" and a digit come right after the number that ends at `last`: the first half of a clock time or a ratio (the "7" of "7:30", the "4" of "4:3"). */
function timeAfter(text: string, last: number): boolean {
  return text.charAt(last + 1) === ':' && digitOf(text.charAt(last + 2)) !== '';
}

/** What chainSide found on one side of a spaced slash. */
interface ChainSide {
  /** The numbers joined to the slash's own number by more "/" on this side, in text order (at most CHAIN_LOOK). */
  numbers: string[];
  /** A "/" with no number on its other side ("one / 1 / 2"): the slash is in a list of words and numbers. */
  open: boolean;
  /** One of `numbers` is a decimal number. */
  decimal: boolean;
  /** Left side only: a whole number and a space right before the numerator, with no "/" between: a mixed number ("2 2 / 4"). */
  whole: boolean;
}

/**
 * Look at one side of a spaced slash for a CHAIN of slashes ("1 / 2 / 3",
 * "1/2 / 3/4"): `dir` -1 looks left of `edge` (the first digit of the
 * numerator), +1 looks right of `edge` (the last digit of the denominator).
 * Each step skips spaces, takes a "/", skips spaces and reads the number
 * there. It stops after CHAIN_LOOK numbers, so it is short on any text.
 *
 *   chainSide('1 / 2 / 3', 4, +1)  → { numbers: ['3'], open: false, … }
 *   chainSide('one / 1 / 2', 6, -1) → { numbers: [], open: true, … }
 *   chainSide('2 2 / 4', 2, -1)     → { numbers: [], whole: true, … }
 */
function chainSide(text: string, edge: number, dir: -1 | 1): ChainSide {
  const side: ChainSide = { numbers: [], open: false, decimal: false, whole: false };
  let at = edge; // the outer digit of the last number read
  while (side.numbers.length < CHAIN_LOOK) {
    let k = at + dir;
    while (k >= 0 && k < text.length && SPACE.test(text.charAt(k))) k += dir;
    if (text.charAt(k) !== '/') {
      // No slash: a number after a space, right before the numerator, is the whole part of a mixed number.
      side.whole = dir < 0 && side.numbers.length === 0 && k < at - 1 && digitOf(text.charAt(k)) !== '';
      return side;
    }
    let j = k + dir;
    while (j >= 0 && j < text.length && SPACE.test(text.charAt(j))) j += dir;
    if (digitOf(text.charAt(j)) === '') {
      side.open = true;
      return side;
    }
    if (dir < 0) {
      const n = numberBefore(text, j);
      if (decimalBefore(text, n.first)) side.decimal = true;
      side.numbers.unshift(n.digits);
      at = n.first;
    } else {
      const n = numberAfter(text, j);
      if (decimalAfter(text, n.last)) side.decimal = true;
      side.numbers.push(n.digits);
      at = n.last;
    }
  }
  return side;
}

/**
 * True when 3 numbers of a chain of slashes are a DATE: a day and a month
 * (either order, 1–2 digits each, see isDayMonth) and a year of 4 digits.
 *
 *   isSlashDate(['3', '10', '2024'])  → true    (3 October, or March 10)
 *   isSlashDate(['1', '2', '3'])      → false
 */
function isSlashDate(chain: readonly string[]): boolean {
  if (chain.length !== 3 || chain[2].length !== 4) return false;
  return isDayMonth(chain[0], chain[1]) || isDayMonth(chain[1], chain[0]);
}

/**
 * True when a SPACED "/" between the digit at `before` and the digit at
 * `after` joins ONE value, so it never splits alternatives. A spaced slash
 * between two numbers can mean "one half" ("1 / 2 cup") or "one OR two" (a
 * list of alternatives, "10 / 20 / 30"). The text around it decides (wave
 * 5c, the R1 regression: a spaced list was read as one value, so "10" for
 * "10 / 20 / 30" was 'wrong'). The rules, in order:
 *   1. A DECIMAL number next to the slash: a list ("0.5 / 1/2", "1 / 2,5").
 *      The same for a CLOCK TIME or a RATIO next to the slash ("6:45 /
 *      7:30", "16:9 / 4:3"): a ":" between two digits is never part of a
 *      fraction. WHY (wave 5c, review round 2): the digits next to the
 *      slash of "6:45 / 7:30" are only "45" and "7", in lowest terms, so
 *      without this rule the two times were ONE value and "6:45" was
 *      'wrong'. (It split only by chance: "8:30 / 9:30" because 30 and 9
 *      have the common factor 3.)
 *   2. A CHAIN of slashes, more numbers joined by "/": a list ("1 / 2 / 3",
 *      "1/2 / 3/4"), also with a word on the other side of a "/" ("one / 1
 *      / 2"). Only a DATE of exactly 3 numbers is one value ("3 / 10 /
 *      2024", isSlashDate), the same as the tight "3/10/2024".
 *   3. Two numbers of 3 digits or more: a list. Nobody writes a fraction
 *      like that, but years and other big numbers are listed like that
 *      ("1939 / 1945", "110 / 112").
 *   4. A MIXED number, a whole number and a space before the numerator:
 *      one value, whatever the fraction is ("2 2 / 4", "1 1 / 2").
 *   5. Two numbers of ONE digit each: one value ("1 / 2", "2 / 4", "6 / 8").
 *      WHY (wave 5c, review round 2): with the lowest-terms test of rule 6,
 *      a time signature "6 / 8" or "4 / 4" was a list, so "8" alone was
 *      'exact' on a music card. Small numbers are not listed like that.
 *   6. Otherwise, one fraction only when it is in lowest terms (the two
 *      numbers have no common factor): "3 / 10", "24 / 7" and "1 / 100" are
 *      fractions; "20 / 30" and "12 / 24" are lists, because nobody writes
 *      2/3 as "20 / 30".
 * With no such context, "1 / 2" stays one value (wave 5b R1): "1" alone is
 * never its answer. A list still compares as a whole too: the spaces around
 * its slashes are formatting ("6/8" for "6 / 8" is exact, see
 * slashBetweenDigits). Short on any text: it reads at most CHAIN_LOOK more
 * numbers on each side, of at most SPACED_FRACTION_DIGITS + 1 digits.
 */
function spacedOneValue(text: string, before: number, after: number): boolean {
  // The numerator ends at `before`, the denominator starts at `after`.
  const top = numberBefore(text, before);
  const bottom = numberAfter(text, after);
  if (top.digits.length > SPACED_FRACTION_DIGITS || bottom.digits.length > SPACED_FRACTION_DIGITS) return false;
  // 1. A decimal number, a clock time or a ratio next to the slash.
  if (decimalBefore(text, top.first) || decimalAfter(text, bottom.last)) return false;
  if (timeBefore(text, top.first) || timeAfter(text, bottom.last)) return false;
  // 2. A chain of slashes: one value only as a date of 3 numbers.
  const left = chainSide(text, top.first, -1);
  const right = chainSide(text, bottom.last, 1);
  if (left.open || right.open) return false;
  if (left.numbers.length + right.numbers.length > 0) {
    const chain = [...left.numbers, top.digits, bottom.digits, ...right.numbers];
    return !left.decimal && !right.decimal && isSlashDate(chain);
  }
  // 3. Two big numbers: a list.
  if (top.digits.length >= LIST_NUMBER_DIGITS && bottom.digits.length >= LIST_NUMBER_DIGITS) return false;
  // 4. A mixed number.
  if (left.whole) return true;
  // 5. Two one-digit numbers ("6 / 8", a time signature).
  if (top.digits.length === 1 && bottom.digits.length === 1) return true;
  // 6. Lowest terms.
  return gcd(Number(top.digits), Number(bottom.digits)) === 1;
}

/**
 * The text with no spaces around a "/" between two digits ("1 / 2" →
 * "1/2", "6 / 8" → "6/8"). Those spaces are formatting, whatever the slash
 * means (one value or a list: see slashBetweenDigits), so the comparison
 * keys (caseKey, letterUnits) and the number rule read the tight form. The
 * text that is SHOWN keeps its spaces. Linear: each run of spaces is looked
 * at only by the slashes next to it.
 *
 *   tightFractions('1 / 2 cup')    → '1/2 cup'
 *   tightFractions('10 / 20 / 30') → '10/20/30'   (a list: cutAt still splits it)
 *   tightFractions('he / she')     → 'he / she'   (no digits)
 */
function tightFractions(text: string): string {
  if (!text.includes('/')) return text;
  const out: string[] = [];
  let skipUntil = -1; // the spaces after a bar, up to its second digit, are left out
  for (let i = 0; i < text.length; i++) {
    const bar = slashBetweenDigits(text, i);
    if (bar) {
      // The spaces between the first digit and the bar were already written: take them back.
      for (let k = bar.before + 1; k < i; k++) out.pop();
      out.push('/');
      skipUntil = bar.after;
      continue;
    }
    if (i < skipUntil) continue;
    out.push(text.charAt(i));
  }
  return out.join('');
}

/*
 * Combining accent marks (U+0300 …) after a letter, as some decks store them
 * ("u" + U+0308 instead of "ü"; macOS writes text like this). A phone keyboard
 * always types the one-character form. Without `normalize` (Hermes), the pairs
 * below are joined into the one-character form, so both spellings compare equal.
 * The table lists lower-case letters; an upper-case letter gets the upper-case form.
 */
const COMPOSE: Record<string, [string, string]> = {
  '̀': ['aeiou', 'àèìòù'], // grave
  '́': ['aeiouycnszlr', 'áéíóúýćńśźĺŕ'], // acute
  '̂': ['aeiou', 'âêîôû'], // circumflex
  '̃': ['ano', 'ãñõ'], // tilde
  '̆': ['ag', 'ăğ'], // breve
  '̇': ['ze', 'żė'], // dot above
  '̈': ['aeiouy', 'äëïöüÿ'], // diaeresis (umlaut)
  '̊': ['au', 'åů'], // ring
  '̋': ['ou', 'őű'], // double acute
  '̌': ['csznrdte', 'čšžňřďťě'], // caron
  '̧': ['cs', 'çş'], // cedilla
  '̨': ['ae', 'ąę'], // ogonek
};

/**
 * Join a letter and a following combining mark into one character, where the
 * table knows the pair: ['u', U+0308] → ['ü'], ['U', U+0308] → ['Ü'].
 */
function composeMarks(chars: string[]): string[] {
  const out: string[] = [];
  for (const ch of chars) {
    const pair = COMPOSE[ch];
    const prev = out.length > 0 ? out[out.length - 1] : '';
    const lower = prev.toLowerCase();
    const at = pair && prev.length === 1 ? pair[0].indexOf(lower) : -1;
    if (at >= 0) {
      const composed = pair[1].charAt(at);
      out[out.length - 1] = prev === lower ? composed : composed.toUpperCase();
    } else {
      out.push(ch);
    }
  }
  return out;
}

/**
 * The text as a list of comparable characters: lower case, combining marks
 * joined, ß as "s" + "s", no spaces around a fraction bar (tightFractions).
 * Accents are KEPT ('ü' stays 'ü').
 */
function caseChars(text: string): string[] {
  const chars = composeMarks(Array.from(tightFractions(text).toLowerCase()));
  const out: string[] = [];
  for (const ch of chars) {
    if (ch === 'ß') out.push('s', 's');
    else out.push(ch);
  }
  return out;
}

/** The comparison key that keeps accents: "Straße" → "strasse", "Über" → "über". */
function caseKey(text: string): string {
  return caseChars(cleanAnswer(text)).join('');
}

/**
 * The comparison key that also drops accents (foldText): "Über" → "uber".
 * Two answers with the same key are the same answer for the quiz
 * (distractors.ts uses it: "never the same folded text").
 *
 *   answerKey('Die Stunde.') → 'die stunde'
 */
export function answerKey(text: string): string {
  return foldText(caseKey(text));
}

/**
 * The letters of an answer AS SHOWN, without its spaces (for the typo
 * threshold, rule 5). Counted on the shown text, not on the comparison key:
 * the key writes ß as "ss" (and a deck's "u" + U+0308 as two characters),
 * so "Straße" would count 7 letters there instead of 6.
 *
 *   letterCount('Straße') → 6
 *   letterCount('to go')  → 4
 */
function letterCount(text: string): number {
  return composeMarks(Array.from(cleanAnswer(text))).filter((ch) => ch !== ' ').length;
}

/**
 * The text as a list of LETTERS for the typo distance (rule 5): lower case,
 * accents dropped (foldText), but every letter as ONE item, also a letter
 * that folds to two ("ß" → "ss", "æ" → "ae"). So a wrong or missing ß costs
 * 1 edit, like any other letter. Spaces stay (one item each), except the
 * spaces around a fraction bar (tightFractions).
 *
 *   letterUnits('Straße') → ['s', 't', 'r', 'a', 'ss', 'e']
 *   letterUnits('Über')   → ['u', 'b', 'e', 'r']
 */
function letterUnits(text: string): string[] {
  const out: string[] = [];
  for (const ch of composeMarks(Array.from(tightFractions(cleanAnswer(text)).toLowerCase()))) {
    const folded = foldText(ch);
    // A combining mark that composeMarks could not join folds to nothing, as in foldText.
    if (folded !== '') out.push(folded);
  }
  return out;
}

/* ---------------------------------------------------------- alternatives */

/** The separators of alternatives inside one answer (spec §6.3): , ; / */
const ALT_SEPARATORS = ',;/';

/** The separators of a list of answers, without "/" (germanAlternatives splits at "/" later). */
const LIST_SEPARATORS = ',;';

/** Only "/", for the second split of germanAlternatives. */
const SLASH = '/';

/**
 * A plural-suffix note of a word list: "-en" in "die Abfahrt, -en", "¨-er"
 * in "das Haus, ¨-er", "-" in "der Lehrer, -", "-(e)s" in "der Tisch, -(e)s, -e".
 * It starts with a dash (- or –) or an umlaut mark (¨) and has no digit.
 * It is a note about the word, not an answer. A negative number ("-3" in
 * "-3, 2") has a digit, so it stays an answer.
 */
const SUFFIX_NOTE = /^[-–¨][^0-9]*$/;

/** True for a digit 0–9. */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * `text` cut at every character of `separators`, except a "," or "/" with a
 * digit on BOTH sides: that one is part of a number ("1,000", "1,5", "3/4",
 * "24/7"), not a separator. A "," that starts the text before a digit is a
 * decimal comma (",5" = 0,5), not a separator either. "1, 2" has a space
 * after the comma, so it is a list. A "/" between two digits with spaces
 * around it splits only when the text makes a list there (see numberSlash
 * and spacedOneValue): "1 / 2" is one fraction, so "1" alone is never its
 * answer, and "3 / 10 / 2024" is one date; "10 / 20 / 30" and "1939 / 1945"
 * split.
 *
 * A separator INSIDE brackets never cuts, wherever the brackets are:
 * "(der/die) Angestellte" and "(he/she) goes" are one answer each, with an
 * optional leading part (optionalLeadForms), and "Haus (n / pl)" and "gehen
 * (ging / gegangen)" are one answer each, with an optional trailing part
 * (optionalTailForms). WHY: a cut at that "/" made broken parts — "(der" and
 * "die) Angestellte" (wave 5c, review round 2), and "Haus (n" and "pl)"
 * (wave 5d): the screen showed a broken part as the expected answer, and
 * "gehen" for "gehen (ging / gegangen)" was 'wrong'. Only a real PAIR of
 * brackets counts (insideBrackets): a "(" with no ")" after it protects
 * nothing.
 *
 * A manual scan, because Hermes has no look-behind. Linear (see
 * insideBrackets). The pieces are not cleaned.
 *
 *   cutAt('to go, to walk', ',;/')        → ['to go', ' to walk']
 *   cutAt('3/4', ',;/')                   → ['3/4']
 *   cutAt('1 / 2', ',;/')                 → ['1 / 2']
 *   cutAt('0.5 / 1/2', ',;/')             → ['0.5 ', ' 1/2']
 *   cutAt(',5', ',;/')                    → [',5']
 *   cutAt('(he/she) goes, (it) is', ',;/') → ['(he/she) goes', ' (it) is']
 *   cutAt('Haus (n / pl), Heim', ',;/')    → ['Haus (n / pl)', ' Heim']
 */
function cutAt(text: string, separators: string): string[] {
  const pieces: string[] = [];
  const inside = insideBrackets(text);
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if ((inside !== null && inside[i]) || !separators.includes(ch)) continue;
    const inNumber =
      (ch === ',' && i > 0 && isDigit(text.charAt(i - 1)) && isDigit(text.charAt(i + 1))) || numberSlash(text, i);
    // ",5" = 0,5: a comma that STARTS the text before a digit is a decimal comma (cleanAnswer keeps it).
    const startsNumber = ch === ',' && i === 0 && isDigit(text.charAt(1));
    if (inNumber || startsNumber) continue;
    pieces.push(text.slice(start, i));
    start = i + 1;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/**
 * For each character of `text`: true when it is INSIDE a pair of brackets
 * "( … )" (also in a pair inside another pair). null when the text has no
 * "(" at all (the common case: nothing to protect). A "(" with no ")" after
 * it, and a ")" with no "(" before it, make no pair.
 *
 * Linear: one pass finds the pairs (a stack of the open brackets) and marks
 * where each one starts and ends; a second pass adds those marks up.
 *
 *   insideBrackets('Haus (n / pl)') → true only for 'n / pl'
 *   insideBrackets('Haus (n / pl')  → all false (no pair)
 */
function insideBrackets(text: string): boolean[] | null {
  if (text.indexOf('(') < 0) return null;
  const n = text.length;
  const change = new Array<number>(n + 1).fill(0);
  const open: number[] = [];
  for (let i = 0; i < n; i++) {
    const ch = text.charAt(i);
    if (ch === '(') open.push(i);
    else if (ch === ')' && open.length > 0) {
      const from = open.pop()!;
      change[from + 1] += 1; // inside from the character after "("…
      change[i] -= 1; // …up to the ")" (the brackets themselves are outside)
    }
  }
  const inside = new Array<boolean>(n).fill(false);
  let depth = 0;
  for (let i = 0; i < n; i++) {
    depth += change[i];
    inside[i] = depth > 0;
  }
  return inside;
}

/**
 * How the alternatives are cleaned: `cleanAnswer` for the list that is shown
 * and compared, `numberText` for the number rule (it keeps the ordinal dot
 * of "3.10."). The two give the SAME list in the same order: they differ
 * only by a "." after a final digit, and every repeat is found by caseKey,
 * which drops that dot (see uniqueAnswers).
 */
type Cleaner = (text: string) => string;

/**
 * The parts of `text` split at `separators` (see cutAt), cleaned, without
 * empty parts and without plural-suffix notes (SUFFIX_NOTE). [] when `text`
 * has no separator. When EVERY part is such a note ("-ing, -ed", a grammar
 * card), they are the answer, so all of them are kept.
 *
 *   partsOf('die Abfahrt, -en', ',;') → ['die Abfahrt']
 *   partsOf('-ing, -ed', ',;')        → ['-ing', '-ed']
 *   partsOf('1,000', ',;/')           → []   (a number, no separator)
 */
function partsOf(text: string, separators: string, clean: Cleaner): string[] {
  const pieces = cutAt(text, separators);
  if (pieces.length < 2) return [];
  const parts = pieces.map(clean).filter((part) => part !== '');
  const words = parts.filter((part) => !SUFFIX_NOTE.test(part));
  return words.length > 0 ? words : parts;
}

/**
 * Texts → cleaned, without empty texts and without repeats, in the same
 * order. A repeat = the same caseKey (no case, and cleanAnswer's ends, so
 * "3.10." and "3.10" are one answer whatever `clean` is).
 */
function uniqueAnswers(texts: readonly string[], clean: Cleaner): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const cleaned = clean(text);
    const key = caseKey(cleaned);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/**
 * Two or more articles joined by "/" before a German noun: "der/die Angestellte".
 * Group 1 = the articles, group 2 = the noun.
 */
const MANY_ARTICLES = /^((?:der|die|das)(?:\s*\/\s*(?:der|die|das))+)\s+(\S.*)$/i;

/** A part that is only an article: "die" in "Abfahrt, die". */
const ONLY_ARTICLE = /^(?:der|die|das)$/i;

/**
 * The alternatives of a German answer. "der/die Angestellte" means "der
 * Angestellte" OR "die Angestellte": splitting it at "/" would give a bare
 * "der". So the text is split in two steps:
 *   1. at , and ; (without plural-suffix notes, see partsOf);
 *   2. a part with two or more articles ("der/die Angestellte") gives one
 *      form per article; any other part is split at "/" as usual.
 * A part that is only an article ("die" in "Abfahrt, die") is dropped, unless
 * every part is one ("der, die, das" is the answer of a grammar card).
 * The whole text is always the first form.
 *
 *   germanAlternatives('der/die Angestellte, -n')
 *     → ['der/die Angestellte, -n', 'der Angestellte', 'die Angestellte']
 *   germanAlternatives('die Abfahrt, -en') → ['die Abfahrt, -en', 'die Abfahrt']
 *   germanAlternatives('Abfahrt, die')     → ['Abfahrt, die', 'Abfahrt']
 */
function germanAlternatives(whole: string, clean: Cleaner): string[] {
  const parts: string[] = [];
  const lists = partsOf(whole, LIST_SEPARATORS, clean);
  for (const part of lists.length > 0 ? lists : [whole]) {
    const many = MANY_ARTICLES.exec(part);
    if (many) {
      const word = many[2].trim();
      for (const article of many[1].split('/')) parts.push(`${article.trim()} ${word}`);
      continue;
    }
    const split = partsOf(part, SLASH, clean);
    parts.push(...(split.length > 0 ? split : [part]));
  }
  const words = parts.filter((part) => !ONLY_ARTICLE.test(part));
  return uniqueAnswers([whole, ...(words.length > 0 ? words : parts)], clean);
}

/** The alternatives of `expected`, each cleaned by `clean` (see answerAlternatives and Cleaner). */
function alternativesOf(expected: string, lang: string | null | undefined, clean: Cleaner): string[] {
  const whole = clean(expected);
  if (primary(lang) === 'de') return germanAlternatives(whole, clean);
  return uniqueAnswers([whole, ...partsOf(whole, ALT_SEPARATORS, clean)], clean);
}

/**
 * Every accepted form of an expected answer, cleaned, without repeats: the
 * whole text first, then each part split by , ; or / (a number such as
 * "1,000" or "3/4" is not split, see cutAt). A plural-suffix note ("-en") is
 * not a part (see partsOf).
 *
 * `lang` is the answer field's language (FieldBlock.lang). German answers
 * follow germanAlternatives: "der/die X" gives "der X" and "die X", and a
 * bare article is never a part. The German rules need the language, because
 * language knowledge is keyed by the field's language (spec §9.1).
 *
 *   answerAlternatives('to go, to walk')   → ['to go, to walk', 'to go', 'to walk']
 *   answerAlternatives('die Abfahrt, -en') → ['die Abfahrt, -en', 'die Abfahrt']
 *   answerAlternatives('Haus')             → ['Haus']
 *   answerAlternatives('der/die Angestellte', { lang: 'de-DE' })
 *     → ['der/die Angestellte', 'der Angestellte', 'die Angestellte']
 *   answerAlternatives('Haus (n / pl)')   → ['Haus (n / pl)']   (never split inside brackets)
 */
export function answerAlternatives(expected: string, opts: Pick<CheckOptions, 'lang'> = {}): string[] {
  return alternativesOf(expected, opts.lang, cleanAnswer);
}

/* --------------------------------------------------------- edit distance */

/** The longest text (in characters) that is aligned letter by letter. Longer texts only compare equal or not. */
const MAX_ALIGN = 200;

/** One step of the alignment, from the end of both texts back to the start. */
type Step = { op: DiffPart['op']; typed: string; expected: string };

/**
 * Edit distance with swaps ("optimal string alignment": add, remove, change
 * a letter, or swap two letters next to each other — each costs 1) and the
 * letter diff that goes with it. `a` = typed, `b` = expected, both as
 * comparable characters (see caseChars or the folded form).
 *
 *   align(['a','b','f','h','a','r','t'], ['a','b','f','a','h','r','t']) → distance 1 (one swap)
 *
 * Time and memory: (|a| + 1) × (|b| + 1) cells; both are at most MAX_ALIGN.
 */
function align(a: string[], b: string[], same: (x: string, y: string) => boolean): { dist: number; steps: Step[] } {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const d = new Array<number>((n + 1) * w);
  for (let i = 0; i <= n; i++) d[i * w] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = same(a[i - 1], b[j - 1]) ? 0 : 1;
      let best = Math.min(d[(i - 1) * w + j] + 1, d[i * w + j - 1] + 1, d[(i - 1) * w + j - 1] + cost);
      if (i > 1 && j > 1 && same(a[i - 1], b[j - 2]) && same(a[i - 2], b[j - 1])) {
        best = Math.min(best, d[(i - 2) * w + j - 2] + 1);
      }
      d[i * w + j] = best;
    }
  }

  // Walk back from the end and write down the step taken at each cell.
  const steps: Step[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = d[i * w + j];
    if (i > 0 && j > 0 && same(a[i - 1], b[j - 1]) && here === d[(i - 1) * w + j - 1]) {
      steps.push({ op: 'same', typed: a[i - 1], expected: b[j - 1] });
      i--;
      j--;
    } else if (
      i > 1 &&
      j > 1 &&
      same(a[i - 1], b[j - 2]) &&
      same(a[i - 2], b[j - 1]) &&
      here === d[(i - 2) * w + j - 2] + 1
    ) {
      steps.push({ op: 'change', typed: a[i - 2] + a[i - 1], expected: b[j - 2] + b[j - 1] });
      i -= 2;
      j -= 2;
    } else if (i > 0 && j > 0 && here === d[(i - 1) * w + j - 1] + 1) {
      steps.push({ op: 'change', typed: a[i - 1], expected: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && here === d[(i - 1) * w + j] + 1) {
      steps.push({ op: 'extra', typed: a[i - 1], expected: '' });
      i--;
    } else {
      steps.push({ op: 'missing', typed: '', expected: b[j - 1] });
      j--;
    }
  }
  steps.reverse();
  return { dist: d[n * w + m], steps };
}

/** Steps → diff parts: neighbours with the same op are joined into one piece. */
function joinSteps(steps: Step[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const step of steps) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last && last.op === step.op) {
      last.typed += step.typed;
      last.expected += step.expected;
    } else {
      out.push({ op: step.op, typed: step.typed, expected: step.expected });
    }
  }
  return out;
}

/** Edit distance of two lists of items; Infinity when a list is too long to align. */
function itemDistance(x: string[], y: string[]): number {
  if (x.length > MAX_ALIGN || y.length > MAX_ALIGN) return Infinity;
  return align(x, y, (p, q) => p === q).dist;
}

/** Edit distance of two keys (folded); Infinity when a text is too long to align. */
function keyDistance(a: string, b: string): number {
  if (a === b) return 0;
  return itemDistance(Array.from(a), Array.from(b));
}

/**
 * The typo distance of rule 5: the smaller of
 *   - the distance of the keys (ß written "ss": "Strasee" for "Straße" is 1), and
 *   - the distance of the letters (ß is one letter: "Strae" for "Straße" is 1).
 * Each one is a real way to spell the answer (rule 2), so the learner gets
 * the spelling that is closer to what they typed.
 */
function typoDistance(inputKey: string, inputUnits: string[], form: Form): number {
  const byKey = keyDistance(inputKey, form.key);
  if (byKey <= 1) return byKey; // the letters can never be closer than 1 (the keys differ)
  return Math.min(byKey, itemDistance(inputUnits, form.units));
}

/** The largest edit distance that is still 'close' for an expected answer, as shown (rule 5). */
function typoLimit(expectedText: string): number {
  const letters = letterCount(expectedText);
  // A typo can never be the whole answer: one letter has no typo.
  return Math.min(letters <= 6 ? 1 : 2, Math.max(0, letters - 1));
}

/* ---------------------------------------------------------- number rule */

/*
 * Digits that a deck may write in another form: superscript (m², x³),
 * subscript (CO₂, H₂O) and full-width (１２, from a Japanese or Chinese
 * keyboard). A phone keyboard cannot type the first two, so the learner
 * types the plain digit. For the number rule (rule 5) each one IS that digit.
 * A table, because Hermes has no `normalize`.
 */
const DIGIT_FORMS: Record<string, string> = {};
for (const forms of ['⁰¹²³⁴⁵⁶⁷⁸⁹', '₀₁₂₃₄₅₆₇₈₉', '０１２３４５６７８９']) {
  Array.from(forms).forEach((ch, value) => {
    DIGIT_FORMS[ch] = String(value);
  });
}

/**
 * The ASCII digit that one character stands for, or '' when it is not a
 * digit. Works on ONE character (charAt), so '' (past the end) is no digit.
 *
 *   digitOf('7') → '7'    digitOf('²') → '2'    digitOf('₂') → '2'    digitOf('x') → ''
 */
function digitOf(ch: string): string {
  if (isDigit(ch)) return ch;
  return DIGIT_FORMS[ch] ?? '';
}

/**
 * The minus signs that can start a negative number: "-", "−" (U+2212), the
 * dashes that decks use for it ("–" en dash U+2013, "‒" figure dash U+2012),
 * the full-width "－" (U+FF0D), and superscript and subscript minus ("⁻", "₋").
 * The learner types "-" for any of them.
 */
const MINUS = new Set(Array.from('-−–‒－⁻₋'));

/** True for "." or ",": the characters that can be a decimal point or a thousands separator. */
function isPoint(ch: string): boolean {
  return ch === '.' || ch === ',';
}

/** True for a letter with upper and lower case, or a digit: a dash between two of them is formatting ("B-52", "3-4"). */
function letterOrDigit(ch: string): boolean {
  return digitOf(ch) !== '' || ch.toLowerCase() !== ch.toUpperCase();
}

/**
 * True when the minus sign at `i` starts a negative number: a digit comes
 * next (or ".5" / ",5"), and the character BEFORE it is not a letter or a
 * digit — the start of the text, a space, "=", "(", "," and so on.
 *
 *   'x=-3'  → the "-" is a sign       'b-52' → not a sign (after a letter)
 *   'f(-1)' → the "-" is a sign       '3-4'  → not a sign (a range)
 */
function startsNegative(key: string, i: number): boolean {
  const next = key.charAt(i + 1);
  const number = digitOf(next) !== '' || (isPoint(next) && digitOf(key.charAt(i + 2)) !== '');
  return number && (i === 0 || !letterOrDigit(key.charAt(i - 1)));
}

/**
 * The numbers of a text in one shape that the number rule compares (rule 5).
 * Positions are lengths of `digits`: "at 1" means "after the first character
 * of `digits`".
 */
interface NumberShape {
  /**
   * Every digit (as ASCII 0–9) and every minus sign that starts a number
   * (see startsNegative), in order. Everything else is left out.
   */
  digits: string;
  /**
   * Where a point or comma sits that is NOT a thousands separator: a
   * decimal point ("7.5" → [1]), or a dot of a date ("7.5.1945" → [1, 2]).
   * The other text must cut its digits there too (sameShape).
   */
  points: number[];
  /**
   * Every place where the digits are cut: a new number starts, or a "." or
   * "," sits between two digits (also after the "0" of a ".5"). `points` is
   * a part of it.
   */
  cuts: Set<number>;
  /**
   * Every FRACTION of the text (see fractionBars), in order. A fraction is
   * one value, so the other text must have the same fractions in exactly the
   * same places: "12" (no bar) and "1.2" (a point, no bar) are not "1/2".
   */
  fractions: Fraction[];
}

/**
 * One fraction in a NumberShape, as three places in `digits`: where its
 * numerator starts, where its bar sits, and where its denominator ends.
 *
 *   "1/2"    → { start: 0, bar: 1, end: 2 }
 *   "1 1/2"  → { start: 1, bar: 2, end: 3 }   (one and a half: the numerator is the second "1")
 *   "11/2"   → { start: 0, bar: 2, end: 3 }   (eleven halves)
 *
 * WHY all three (review round 1): "11/2" and "1 1/2" both have the digits
 * "112" and a bar at 2. The space before the numerator is only a cut, and a
 * cut alone is formatting (like the space in "1 000"). So with the bar alone,
 * "11/2" (5.5) for "1 1/2" (1.5) was a typo. The start and the end of the
 * fraction keep those values apart: a fraction is compared as a whole.
 */
interface Fraction {
  start: number;
  bar: number;
  end: number;
}

/**
 * The numbers of a text in the THREE shapes of the number rule (rule 5). Two
 * texts have the same numbers when one of the three shapes is the same
 * (sameNumbers):
 *   asWritten  every digit as it is written: "1,000" = "1000", "12.30" = "12:30".
 *              Compared with sameShape: a point may sit where the other
 *              text cuts its digits (a ":" or a space).
 *   unpadded   as written, but a number that STARTS (see addUnpadded) loses
 *              the zeros in front of its first digit group: "09:30" → "9"
 *              and "30", so "9.30" = "09:30" (another separator AND a
 *              padding zero). Compared with sameShape too. The minutes of
 *              a time keep their zeros ("9:05" → "9" and "05"), so "9.5"
 *              (9.5) is never "9:05".
 *   byValue    the zeros that do not change a value are left out: a zero
 *              at the START of a whole number ("09:00" = "9:00", "07.05.1945"
 *              = "7.5.1945") and a zero at the END of a decimal part ("10.50"
 *              = "10.5", "2.0" = "2"). Compared with exactShape: the digits
 *              must be cut in exactly the same places. WHY: without the
 *              zeros, "9:05" is the digits "9" and "5", the same digits as
 *              "9.5" or "95"; only the places of the cuts and points keep
 *              those values apart. A day.month DATE ("3.10.", see
 *              readNumber) has no decimal part: its month keeps the zero at
 *              its end ("3.10." = 3, 10 ≠ "3.1." = 3, 1).
 * Each shape alone keeps a different value apart ("1944" ≠ "1945",
 * "75" ≠ "7.5", "0,750" ≠ "0750", "9.5" ≠ "9:05", "3.1." ≠ "3.10."), so all
 * three together do too.
 *
 * NOTE: a two-part number WITHOUT an ordinal dot is read as a decimal
 * number, so "3.1" for "3.10" (a version, a section) is the same value and
 * the typo rule decides. Nothing in the text says it is not a decimal number.
 */
interface Numbers {
  asWritten: NumberShape;
  unpadded: NumberShape;
  byValue: NumberShape;
}

/** An empty shape. */
function emptyShape(): NumberShape {
  return { digits: '', points: [], cuts: new Set(), fractions: [] };
}

/** How a digit group is joined to the group before it: a thousands separator, or any other point. */
type Join = 'thousands' | 'point';

/** A whole number without the zeros at its start; one "0" stays when it is only zeros ("0750" → "750", "00" → "0"). */
function withoutLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * Add one number to the AS-WRITTEN shape: every digit group, with a cut
 * before each group after the first, and a point where the join is not a
 * thousands separator.
 */
function addAsWritten(shape: NumberShape, groups: readonly string[], joins: readonly Join[]): void {
  shape.cuts.add(shape.digits.length);
  groups.forEach((group, g) => {
    if (g > 0) {
      shape.cuts.add(shape.digits.length);
      if (joins[g - 1] === 'point') shape.points.push(shape.digits.length);
    }
    shape.digits += group;
  });
}

/**
 * Add one number to the UNPADDED shape (see Numbers): the as-written shape,
 * but the first digit group loses its leading zeros when the number STARTS
 * here ("09.30" → "9" and "30"; "00" → "0").
 *
 * `continues` = the number comes right after ONE separator that follows a
 * digit: the minutes in "9:05", the day in "1/05", the "05" in "9 05". Such a
 * number goes on with the number before it, so it keeps its zeros. WHY: with
 * "05" made "5", "9:05" and "1/05" would have the digits of "9.5" and "1.5",
 * and sameShape lets a point sit on the other text's cut, so a different
 * value would be 'close'.
 *
 *   "um 09:30 uhr" → "9" + "30" = "930"      "9.30" → "930" (a point at 1)
 *   "9:05"         → "9" + "05" = "905"      "9.5"  → "95"
 */
function addUnpadded(shape: NumberShape, groups: readonly string[], joins: readonly Join[], continues: boolean): void {
  const first = continues ? groups[0] : withoutLeadingZeros(groups[0]);
  addAsWritten(shape, [first, ...groups.slice(1)], joins);
}

/**
 * Add one number to the BY-VALUE shape (see Numbers). The thousands groups
 * are joined into whole parts first ("1,000.50" → "1000" and "50"). Then:
 *   - exactly ONE point left: it is a decimal point. The whole part loses its
 *     leading zeros, the decimal part its trailing zeros; with nothing left
 *     after the point, the point goes too ("10.50" → 10.5, "2.0" → 2);
 *   - two or more points, or a day and a month (`date`, see isDayMonth): a
 *     date or a version ("07.05.1945", "3.10."). Each part is a whole number
 *     and loses its leading zeros (7, 5, 1945); the dots stay points, so the
 *     other text must cut there too. WHY `date`: the zero of the month 10 is
 *     not a decimal zero. "3.10." is 3 October and "3.1." is 3 January.
 */
function addByValue(shape: NumberShape, groups: readonly string[], joins: readonly Join[], date: boolean): void {
  const parts: string[] = [groups[0]];
  for (let g = 1; g < groups.length; g++) {
    if (joins[g - 1] === 'thousands') parts[parts.length - 1] += groups[g];
    else parts.push(groups[g]);
  }
  const decimal = parts.length === 2 && !date;
  shape.cuts.add(shape.digits.length);
  parts.forEach((part, k) => {
    const digits = decimal && k === 1 ? part.replace(/0+$/, '') : withoutLeadingZeros(part);
    if (k > 0) {
      if (digits === '') return; // "10.0": nothing after the point, so no point
      shape.cuts.add(shape.digits.length);
      shape.points.push(shape.digits.length);
    }
    shape.digits += digits;
  });
}

/**
 * True when two digit groups can be a day and a month: 1–2 digits each, a
 * day from 1 to 31 and a month from 1 to 12 ("3" and "10", "03" and "05").
 * "3.50." is no date (there is no month 50): it is a decimal number at the
 * end of a sentence.
 */
function isDayMonth(day: string, month: string): boolean {
  const d = Number(day);
  const m = Number(month);
  return day.length <= 2 && month.length <= 2 && d >= 1 && d <= 31 && m >= 1 && m <= 12;
}

/**
 * Read the number at `start` (its first digit) into the three shapes: digit
 * groups, joined by single "." or "," characters with a digit on both sides
 * ("1,000.5" is ONE number). `leadingPoint` = the number was written ".5":
 * it is read as "0.5", so ".5" and "0.5" have the same shape. Returns the
 * index after the number.
 *
 * A German DATE: two groups joined by "." with one more "." right after
 * them ("3.10.", the ordinal dot of a day and a month), where the groups can
 * be a day and a month (isDayMonth). Its two parts are whole numbers, not a
 * decimal number (see addByValue). The key must still hold that last dot:
 * numberText keeps it at the end of the text.
 *
 * Each "." or "," is a decimal point (or a date dot), unless it is a
 * THOUSANDS separator ("1,000", "1.000.000"):
 *   - exactly 3 digits follow it;
 *   - the first one: the group before it has 1–3 digits and does not start
 *     with "0" (nobody writes 750 as "0,750", so "0,750" is a decimal);
 *   - a later one: the same character as the one before, and that one is a
 *     thousands separator too. So in "12,345.678" the "." is the decimal
 *     point: a number never mixes two kinds of thousands separator.
 * NOTE: "3.142" counts as a thousands separator too (it could be either),
 * so "3142" for "3.142" is still decided by the typo rule.
 */
function readNumber(key: string, start: number, leadingPoint: boolean, numbers: Numbers): number {
  // ".5" is read as the groups "0" and "5" joined by a point.
  const groups: string[] = leadingPoint ? ['0'] : [];
  const seps: string[] = leadingPoint ? ['.'] : [];
  let i = start;
  for (;;) {
    let group = '';
    for (let d = digitOf(key.charAt(i)); d !== ''; d = digitOf(key.charAt(i))) {
      group += d;
      i++;
    }
    groups.push(group);
    const sep = key.charAt(i);
    if (!isPoint(sep) || digitOf(key.charAt(i + 1)) === '') break;
    seps.push(sep); // the "." or "," between two digit groups
    i++;
  }
  const joins: Join[] = [];
  let thousands = false; // the separator before the current group is a thousands separator
  for (let g = 1; g < groups.length; g++) {
    const before = groups[g - 1];
    thousands =
      !leadingPoint &&
      groups[g].length === 3 &&
      (g === 1 ? before.length <= 3 && before.charAt(0) !== '0' : thousands && seps[g - 1] === seps[g - 2]);
    joins.push(thousands ? 'thousands' : 'point');
  }
  // The character before `start` is never a digit (it would be part of this
  // number). A digit right before THAT one: this number goes on with the
  // number before it ("9:05", "1/05"), see addUnpadded.
  const continues = !leadingPoint && start >= 2 && digitOf(key.charAt(start - 2)) !== '';
  // The loop stopped at a "." with no digit after it: an ordinal dot ("3.10." = 3 October).
  const date =
    key.charAt(i) === '.' && !leadingPoint && groups.length === 2 && seps[0] === '.' && isDayMonth(groups[0], groups[1]);
  addAsWritten(numbers.asWritten, groups, joins);
  addUnpadded(numbers.unpadded, groups, joins, continues);
  addByValue(numbers.byValue, groups, joins, date);
  return i;
}

/** True for a character that can be inside one number: a digit, or a "." or "," between digits. */
function inNumberChar(ch: string): boolean {
  return digitOf(ch) !== '' || isPoint(ch);
}

/**
 * The indexes of the FRACTION bars of a key: a "/" with a digit right before
 * and right after it (the key is tight, see tightFractions), between two
 * numbers that are not joined to a third one by another "/". So "1/2" and
 * "3/4 cup" have a bar, and "3/10/2024" (a date) has none: its slashes only
 * cut the digits, as before.
 *
 *   fractionBars('1/2')        → {1}
 *   fractionBars('1.5/2')      → {3}
 *   fractionBars('3/10/2024')  → {}
 *   fractionBars('km/h')       → {}
 */
function fractionBars(key: string): Set<number> {
  const bars = new Set<number>();
  for (let i = 1; i < key.length - 1; i++) {
    if (key.charAt(i) !== '/' || digitOf(key.charAt(i - 1)) === '' || digitOf(key.charAt(i + 1)) === '') continue;
    let first = i - 1; // the first character of the number before the bar
    while (first > 0 && inNumberChar(key.charAt(first - 1))) first--;
    let last = i + 1; // the last character of the number after the bar
    while (last < key.length - 1 && inNumberChar(key.charAt(last + 1))) last++;
    const chainBefore = first >= 2 && key.charAt(first - 1) === '/' && digitOf(key.charAt(first - 2)) !== '';
    const chainAfter = key.charAt(last + 1) === '/' && digitOf(key.charAt(last + 2)) !== '';
    if (!chainBefore && !chainAfter) bars.add(i);
  }
  return bars;
}

/**
 * The numbers of a key, in the three shapes (see Numbers). One pass over the key.
 *
 *   numberShape('1,000')     → digits '1000',   points []     (a thousands separator)
 *   numberShape('7.5')       → digits '75',     points [1]
 *   numberShape('0,75')      → digits '075',    points [1]    (a decimal comma)
 *   numberShape('.5')        → digits '05',     points [1]    (the same as "0.5")
 *   numberShape('x = -3')    → digits '-3'
 *   numberShape('b-52')      → digits '52'                    (a dash inside a name is not a sign)
 *   numberShape('co₂')       → digits '2'                     (a subscript digit is a digit)
 *   numberShape('o(n)')      → digits ''
 *   numberShape('09:00')     → as written '0900', unpadded '900', by value '90'
 *   numberShape('10.50')     → as written '1050' [2], unpadded '1050' [2], by value '105' [2]
 *   numberShape('3.10.')     → by value '310' [1]                (a date: 3 October)
 *   numberShape('1/2')       → digits '12', fractions [0, 1, 2]  (a fraction: start, bar, end)
 *   numberShape('1 1/2')     → digits '112', fractions [1, 2, 3] (a mixed number)
 */
function numberShape(key: string): Numbers {
  const numbers: Numbers = { asWritten: emptyShape(), unpadded: emptyShape(), byValue: emptyShape() };
  const shapes = [numbers.asWritten, numbers.unpadded, numbers.byValue];
  const bars = fractionBars(key);
  // Where the LAST number read starts, in each shape: the numerator of a bar that comes next.
  let lastStart = [0, 0, 0];
  // A bar was read: the next number is its denominator, and its end closes the fraction.
  let openFraction = false;
  /** Read the number at `start` (see readNumber), and keep the places a fraction needs. */
  const read = (start: number, leadingPoint: boolean): number => {
    lastStart = shapes.map((shape) => shape.digits.length);
    const next = readNumber(key, start, leadingPoint, numbers);
    if (openFraction) {
      for (const shape of shapes) shape.fractions[shape.fractions.length - 1].end = shape.digits.length;
      openFraction = false;
    }
    return next;
  };
  let i = 0;
  while (i < key.length) {
    const ch = key.charAt(i);
    if (bars.has(i)) {
      // A fraction bar: its numerator is the number just read (a digit is
      // right before the bar), and a digit comes right after it (fractionBars).
      shapes.forEach((shape, k) => {
        const bar = shape.digits.length;
        shape.fractions.push({ start: lastStart[k], bar, end: bar });
      });
      openFraction = true;
      i++;
    } else if (digitOf(ch) !== '') {
      i = read(i, false);
    } else if (isPoint(ch) && digitOf(key.charAt(i + 1)) !== '' && (i === 0 || !letterOrDigit(key.charAt(i - 1)))) {
      // ".5" (also "-.5", "x=.5"): a number that starts with its decimal point.
      i = read(i + 1, true);
    } else {
      if (MINUS.has(ch) && startsNegative(key, i)) {
        numbers.asWritten.digits += '-';
        numbers.unpadded.digits += '-';
        numbers.byValue.digits += '-';
      }
      i++;
    }
  }
  return numbers;
}

/**
 * The numbers of a text for the number rule (rule 5): numberShape of its
 * folded key, read from numberText, so the ordinal dot at the end of
 * "3.10." is still there.
 *
 *   numbersOf('Am 3.10.') → by value '310' (a date)    numbersOf('3.10') → by value '31' (3.1)
 */
function numbersOf(text: string): Numbers {
  return numberShape(foldText(caseChars(numberText(text)).join('')));
}

/**
 * True when two lists of fractions are the same: each fraction starts, has
 * its bar and ends in the same places, in the same order (see Fraction).
 */
function sameFractions(a: readonly Fraction[], b: readonly Fraction[]): boolean {
  return a.length === b.length && a.every((f, k) => f.start === b[k].start && f.bar === b[k].bar && f.end === b[k].end);
}

/**
 * True when two shapes hold the same numbers:
 *   - the same digits and minus signs, in the same order ("1944" ≠ "1945",
 *     "3" ≠ "-3", "1000" = "1,000" = "1.000");
 *   - a point of one text sits where the other text also cuts its digits
 *     ("0,75" = "0.75", "(2,3)" = "(2, 3)", "12.30" = "12:30"). A point that
 *     moved or is missing is a different value: "75" ≠ "7.5", "31.4" ≠ "3.14";
 *   - the same fractions in exactly the same places: "12" ≠ "1/2" ≠ "1.2",
 *     and "11/2" ≠ "1 1/2" (see Fraction).
 */
function sameShape(a: NumberShape, b: NumberShape): boolean {
  if (a.digits !== b.digits || !sameFractions(a.fractions, b.fractions)) return false;
  return a.points.every((p) => b.cuts.has(p)) && b.points.every((p) => a.cuts.has(p));
}

/**
 * True when two shapes are EXACTLY the same: the same digits, the points in
 * the same places, and the digits cut in the same places. The by-value shape
 * needs this (see Numbers): "9:05" by value is "9" and "5" cut at 1, which
 * is not "9.5" (a point at 1) and not "95" (no cut).
 */
function exactShape(a: NumberShape, b: NumberShape): boolean {
  if (a.digits !== b.digits || a.points.length !== b.points.length || a.cuts.size !== b.cuts.size) return false;
  if (!sameFractions(a.fractions, b.fractions)) return false;
  return a.points.every((p, k) => p === b.points[k]) && Array.from(a.cuts).every((c) => b.cuts.has(c));
}

/**
 * True when two texts hold the same numbers (rule 5), so only their
 * formatting can differ: the same as written, the same without padding
 * zeros, or exactly the same by value (see Numbers). "1,000" = "1000",
 * "09:00" = "9:00", "9.30" = "09:30", "10.50" = "10.5" and "07.05.1945" =
 * "7.5.1945"; but "1944" ≠ "1945", "75" ≠ "7.5", "0750" ≠ "0,750", "90" ≠
 * "9:00" and "9.5" ≠ "9:05".
 */
function sameNumbers(a: Numbers, b: Numbers): boolean {
  return sameShape(a.asWritten, b.asWritten) || sameShape(a.unpadded, b.unpadded) || exactShape(a.byValue, b.byValue);
}

/** A typed answer that starts with a German article: group 1 = the article, group 2 = the rest (folded key). */
const TYPED_ARTICLE = /^(der|die|das) (\S.*)$/;

/**
 * The letter diff between the typed text and the expected text, both as
 * shown (cleaned; case and accents kept). Letters compare without case;
 * an accent difference is a 'change'. Too long to align → one 'change' piece.
 */
export function letterDiff(typed: string, expected: string): DiffPart[] {
  const a = composeMarks(Array.from(cleanAnswer(typed)));
  const b = composeMarks(Array.from(cleanAnswer(expected)));
  if (a.length === 0 && b.length === 0) return [];
  if (a.length > MAX_ALIGN || b.length > MAX_ALIGN) {
    return [{ op: 'change', typed: a.join(''), expected: b.join('') }];
  }
  // One character against one character: only the case may differ.
  const same = (x: string, y: string) => x === y || x.toLowerCase() === y.toLowerCase();
  return joinSteps(align(a, b, same).steps);
}

/* ------------------------------------------- little words: articles, "to" */

/**
 * English: a little word in front of a word list entry (rule 6b): "to sleep",
 * "the sleep", "a dog", "an apple". Group 1 = the little word, group 2 = the
 * rest. Read on a cleaned text (single spaces), so it is linear.
 */
const ENGLISH_LEAD = /^(to|the|an|a) (\S.*)$/i;

/**
 * Which "missing little word" rule a check uses (see leadRuleOf):
 *   german   rule 6: a missing article is close, a WRONG article is wrong;
 *   english  rule 6b: a missing "to" / "the" / "a" / "an" is close;
 *   null     no such rule.
 */
type LeadRule = 'german' | 'english' | null;

/**
 * The rule for a field language and role. German: only for terms (spec
 * §9.2). English: for words and short phrases (a term or a meaning), never
 * for an example sentence. Any other language: none.
 *
 *   leadRuleOf('de-DE', { term: true })  → 'german'
 *   leadRuleOf('en-US', { word: true })  → 'english'
 *   leadRuleOf(undefined, {})            → null   (the language is unknown)
 */
function leadRuleOf(lang: string | null | undefined, opts: Pick<CheckOptions, 'term' | 'word'>): LeadRule {
  const language = primary(lang);
  if (language === 'de') return opts.term !== false ? 'german' : null;
  if (language === 'en') return opts.word !== false ? 'english' : null;
  return null;
}

/** The little word of one form and the word after it (see Form.lead). */
interface Lead {
  article: LeadWord;
  word: string;
  /** answerKey of `word`: a typed answer with this key only forgot the little word. */
  wordKey: string;
  /** True for a German article: a WRONG article on the right noun is 'wrong' (rule 6). */
  strict: boolean;
}

/**
 * The little word in front of one form (cleaned), by the rule. German:
 * splitGermanArticle (one singular article before a capitalised noun).
 * English: "to", "the", "a" or "an" and a space.
 *
 *   leadOf('die Abfahrt', 'german') → { article: 'die', word: 'Abfahrt', strict: true, … }
 *   leadOf('To sleep', 'english')   → { article: 'to', word: 'sleep', strict: false, … }
 *   leadOf('sleep', 'english')      → null
 */
function leadOf(text: string, rule: LeadRule): Lead | null {
  if (rule === 'german') {
    const parts = splitGermanArticle(text);
    if (!parts.article || !parts.rest) return null;
    return { article: parts.article, word: parts.rest, wordKey: answerKey(parts.rest), strict: true };
  }
  if (rule === 'english') {
    const m = ENGLISH_LEAD.exec(text);
    if (!m) return null;
    return { article: m[1].toLowerCase() as LeadWord, word: m[2], wordKey: answerKey(m[2]), strict: false };
  }
  return null;
}

/**
 * An optional part in brackets at the START of an answer, then a space and
 * the rest: "(to) go", "(the) news", "(sich) freuen", "(der/die) Angestellte". Group 1 = the part in
 * the brackets, group 2 = the rest. Read on a cleaned text (single spaces).
 * The part is at most 24 characters, so the scan stays short.
 */
const OPTIONAL_LEAD = /^\(([^()]{1,24})\) (\S.*)$/;

/** Characters an optional leading part may hold besides letters: a space, an apostrophe, a dot, a dash ("(sb.)", "(o')"). */
const OPTIONAL_LEAD_MARKS = new Set(Array.from(" '’.-"));

/** True for a letter with upper and lower case ("a", "ß", "é"); a digit or a sign is none. */
function isCasedLetter(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

/**
 * The other forms of an answer that starts with an OPTIONAL part in
 * brackets (wave 5c, walkthrough L5): many word lists write the little word
 * that may be left out in brackets, "(to) sleep", "(the) news". The brackets
 * say it is optional, so the word alone is the same answer ('exact'), and so
 * is the part written without brackets. [] when the answer has no such part.
 *
 * Only WORDS in the brackets (letters, spaces, an apostrophe, a dot or a
 * dash): "(2+3) x 4" or "(1) 5" are maths or numbering, not an optional word,
 * so they keep their one form.
 *
 * The brackets may hold a CHOICE of words split by "/": "(der/die)
 * Angestellte", "(he/she) goes". Then each word gives its own form, and the
 * whole choice without brackets is a form too (wave 5c, review round 2: the
 * "/" split the answer into "(der" and "die) Angestellte", so "Angestellte"
 * was 'wrong'). Each word of the choice must have a letter.
 *
 *   optionalLeadForms('(to) go')       → ['go', 'to go']
 *   optionalLeadForms('(sich) freuen') → ['freuen', 'sich freuen']
 *   optionalLeadForms('(der/die) Angestellte')
 *     → ['Angestellte', 'der Angestellte', 'die Angestellte', 'der/die Angestellte']
 *   optionalLeadForms('(2+3) x 4')     → []
 *   optionalLeadForms('to go')         → []
 */
function optionalLeadForms(text: string): string[] {
  const m = OPTIONAL_LEAD.exec(text);
  if (!m) return [];
  const rest = m[2];
  const part = m[1].trim();
  const words = part.split('/').map((word) => word.trim());
  const isWord = (word: string) => {
    const chars = Array.from(word);
    return chars.some(isCasedLetter) && chars.every((ch) => isCasedLetter(ch) || OPTIONAL_LEAD_MARKS.has(ch));
  };
  if (!words.every(isWord)) return [];
  if (words.length === 1) return [rest, `${part} ${rest}`];
  return [rest, ...words.map((word) => `${word} ${rest}`), `${part} ${rest}`];
}

/**
 * An optional part in brackets at the END of an answer, after a space:
 * "gehen (ging / gegangen)", "Haus (n / pl)", "helfen (+ Dat.)". Group 1 =
 * the answer before it, group 2 = the part in the brackets. Read on a
 * cleaned text (single spaces). The part is at most 40 characters and has
 * no brackets of its own, so the scan stays short.
 */
const OPTIONAL_TAIL = /^(\S.*) \(([^()]{1,40})\)$/;

/** Characters an optional trailing part may hold besides letters: a space, an apostrophe, a dot, a dash, "/", ",", ";", "+" and "&". */
const OPTIONAL_TAIL_MARKS = new Set(Array.from(" '’.-/,;+&"));

/**
 * The answer without an OPTIONAL part in brackets at its end (wave 5d, F1a):
 * word lists add a note in brackets after the word — the past forms of a
 * verb ("gehen (ging / gegangen)"), the gender and plural ("Haus (n / pl)"),
 * the case a verb takes ("helfen (+ Dat.)"), a meaning note ("bank (river)").
 * The note helps the reader; the learner does not have to type it. So the
 * word alone is the same answer ('exact'). [] when the answer has no such
 * part.
 *
 * Only a note of WORDS (letters and the marks of OPTIONAL_TAIL_MARKS): a
 * part with a digit or another sign ("x (mod 5)", "1945 (1946)", "a (= b)")
 * is maths or a number, so it keeps its one form. Before the brackets there
 * must be a word with a letter.
 *
 *   optionalTailForms('gehen (ging / gegangen)') → ['gehen']
 *   optionalTailForms('(to) go (fast)')          → ['(to) go']   (the lead rule then gives "go", "to go")
 *   optionalTailForms('x (mod 5)')               → []
 *   optionalTailForms('Haus')                    → []
 */
function optionalTailForms(text: string): string[] {
  const m = OPTIONAL_TAIL.exec(text);
  if (!m) return [];
  const head = m[1].trim();
  const chars = Array.from(m[2]);
  const isNote = chars.some(isCasedLetter) && chars.every((ch) => isCasedLetter(ch) || OPTIONAL_TAIL_MARKS.has(ch));
  if (!isNote || !Array.from(head).some(isCasedLetter)) return [];
  return [head];
}

/** One accepted form of the expected answer, with what the little-word rules need. */
interface Form {
  /** The form as shown (cleaned). */
  text: string;
  key: string;
  caseKey: string;
  /** The letters of `text` for the typo distance (letterUnits: ß is one letter). */
  units: string[];
  /** The numbers of the form in the three shapes (Numbers, numbersOf), for the number rule (rule 5). */
  numbers: Numbers;
  /** The little word in front of this form and the word after it (rules 6 and 6b), else null. */
  lead: Lead | null;
}

/**
 * The forms to compare with: every alternative (answerAlternatives with the
 * language), each with its little word (`rule`, see leadOf). With the German
 * rule also "article + word" without a (Pl.) marker. An alternative with an
 * optional part in brackets at its start ("(to) go") also gives the word
 * alone and the part without brackets ("go", "to go": optionalLeadForms;
 * a choice "(der/die)" gives one form per word),
 * each with its own little word, so "die Hund" for "(der) Hund" is still a
 * wrong article. With the German rule, the word alone also loses its (Pl.)
 * marker ("Eltern" for "(die) Eltern (Pl.)"). An alternative with a note in
 * brackets at its END also gives the answer without it ("gehen" for "gehen
 * (ging / gegangen)": optionalTailForms, wave 5d). These forms are only
 * compared with: the list that hints and quizzes read (answerAlternatives)
 * stays as it is.
 */
function formsOf(expected: string, lang: string | null | undefined, rule: LeadRule): Form[] {
  const forms: Form[] = [];
  const seen = new Set<string>();
  // `numbersFrom` = the same form as read by numberText (it may end with the ordinal dot of a date).
  const push = (text: string, lead: Lead | null, numbersFrom: string = text) => {
    const k = caseKey(text);
    if (k === '' || seen.has(k)) return;
    seen.add(k);
    forms.push({ text, key: foldText(k), caseKey: k, units: letterUnits(text), numbers: numbersOf(numbersFrom), lead });
  };
  /**
   * One form as written (`dotted` = read by numberText), with its little word and its
   * marker-free form. `optional` = the form comes from optionalLeadForms ("Eltern (Pl.)"
   * from "(die) Eltern (Pl.)").
   */
  const add = (dotted: string, optional: boolean) => {
    const alt = cleanAnswer(dotted);
    const lead = leadOf(alt, rule);
    // "die Eltern (Pl.)" also accepts "die Eltern": the marker is not part of the word.
    // The form WITHOUT the marker comes first. WHY: a typed "Eltern" matches both forms
    // equally well, and the first one wins; with the marker first, the diff would ask
    // for " (Pl.)" as missing letters, although the marker never has to be typed.
    // (Only German drops a marker: for English, `free` is `alt` itself.)
    if (lead) {
      const free = `${lead.article} ${lead.word}`;
      // Same text (no marker): push only `alt`, so "Die Abfahrt" keeps its own case.
      if (caseKey(free) !== caseKey(alt)) push(free, lead);
    } else if (optional && rule === 'german') {
      // "(die) Eltern (Pl.)" gives "Eltern (Pl.)", a form with NO article: the brackets made
      // the article optional. So "Eltern" without the marker is the same answer ('exact'),
      // as "Hund" is for "(der) Hund" (wave 5c, review round 1: it was close, "remember the
      // article"). "der Eltern" is still a wrong article: it matches the form "die Eltern".
      const bare = splitGermanArticle(alt).rest;
      if (bare !== '' && caseKey(bare) !== caseKey(alt)) push(bare, null);
    }
    push(alt, lead, dotted);
  };
  // The same list as answerAlternatives, but each form still ends with its ordinal dot ("3.10.").
  for (const dotted of alternativesOf(expected, lang, numberText)) {
    add(dotted, false);
    // "(to) go" also accepts "go" and "to go": the part in brackets is optional (wave 5c, L5).
    for (const optional of optionalLeadForms(dotted)) add(optional, true);
    // "gehen (ging / gegangen)" also accepts "gehen": a note in brackets at the end is
    // optional too (wave 5d). The answer without it may start with an optional part itself.
    for (const head of optionalTailForms(dotted)) {
      add(head, false);
      for (const optional of optionalLeadForms(head)) add(optional, true);
    }
  }
  return forms;
}

/* ----------------------------------------------------------------- check */

/**
 * How good a match is: lower is better. The best match over all forms
 * decides the verdict:
 *   exact, accents, article  → as their names say;
 *   wrongArticle             → 'wrong' (rule 6). It ranks ABOVE 'typo', so a
 *                              typo match on ANOTHER form never turns a wrong
 *                              article into 'close': "die Hund" for "der Hund,
 *                              die Hunde" is 1 edit from the plural "die
 *                              Hunde", but the learner typed the singular with
 *                              the wrong gender. Only an exact, accents or
 *                              missing-article match on another form beats it;
 *   typo                     → 'close';
 *   wrong                    → 'wrong'.
 */
const RANK = { exact: 0, accents: 1, article: 2, wrongArticle: 3, typo: 4, wrong: 5 } as const;
type MatchKind = keyof typeof RANK;

/** The verdict of each kind of match (see RANK). */
const VERDICT: Record<MatchKind, AnswerVerdict> = {
  exact: 'exact',
  accents: 'close',
  article: 'close',
  wrongArticle: 'wrong',
  typo: 'close',
  wrong: 'wrong',
};

const SUGGESTED: Record<AnswerVerdict, Rating> = { exact: 'good', close: 'hard', wrong: 'again' };

/** The typed text in the shapes that matchForm compares. */
interface Typed {
  /** caseKey of the typed text: lower case, accents kept, ß as "ss". */
  caseKey: string;
  /** The folded key (answerKey): lower case, no accents, single spaces. */
  key: string;
  /** letterUnits of the typed text (ß is one letter), for the typo distance. */
  units: string[];
  /** The numbers of the typed text in the three shapes (Numbers, numbersOf), for the number rule (rule 5). */
  numbers: Numbers;
}

/** Compare the typed text with one form. */
function matchForm(input: Typed, form: Form): { kind: MatchKind; dist: number } {
  const { caseKey: inputCase, key: inputKey } = input;
  if (inputCase === form.caseKey) return { kind: 'exact', dist: 0 };
  if (inputKey === form.key) return { kind: 'accents', dist: 0 };
  if (form.lead) {
    // "Abfahrt" for "die Abfahrt" (spec §6.3), "sleep" for "to sleep" (rule 6b):
    // only the little word in front is missing → close.
    if (inputKey === form.lead.wordKey) return { kind: 'article', dist: 0 };
    // "der Abfahrt" for "die Abfahrt": the right noun with the WRONG article →
    // wrong (rule 6, German only). Without this, the typo rule calls it 2 small edits.
    const typed = form.lead.strict ? TYPED_ARTICLE.exec(inputKey) : null;
    if (typed && typed[1] !== form.lead.article && typed[2] === form.lead.wordKey) {
      return { kind: 'wrongArticle', dist: keyDistance(inputKey, form.key) };
    }
  }
  const dist = typoDistance(inputKey, input.units, form);
  // A different number is a different value, never a typo (rule 5): "1944" for "1945", "75" for "7.5".
  if (!sameNumbers(input.numbers, form.numbers)) return { kind: 'wrong', dist };
  return dist <= typoLimit(form.text) ? { kind: 'typo', dist } : { kind: 'wrong', dist };
}

/**
 * Check a typed answer against the expected answer (spec §6.3 Typing). See
 * the file header for the rules.
 *
 *   checkAnswer('Haus', 'das Haus', { lang: 'de-DE' })
 *     → { verdict: 'close', suggested: 'hard', reason: 'article',
 *         expected: 'das Haus', article: { article: 'das', word: 'Haus' }, diff: … }
 *   checkAnswer('sleep', 'to sleep', { lang: 'en-US' })
 *     → close, reason 'article', article: { article: 'to', word: 'sleep' }
 *   checkAnswer('uber', 'über')      → close (accents)
 *   checkAnswer('to walk', 'to go, to walk') → exact
 *   checkAnswer('', 'Haus')          → wrong
 */
export function checkAnswer(input: string, expected: string, opts: CheckOptions = {}): AnswerResult {
  // The German alternatives (rule 7) apply to any German field; the missing-article rule (6) only to
  // terms, the English "to / the / a" rule (6b) only to words (leadRuleOf).
  const typed = cleanAnswer(input);
  const forms = formsOf(expected, opts.lang, leadRuleOf(opts.lang, opts));
  const fallback = cleanAnswer(expected);
  if (typed === '' || forms.length === 0) {
    return { verdict: 'wrong', suggested: 'again', reason: null, expected: fallback, article: null, diff: letterDiff(typed, fallback) };
  }

  const inputCase = caseKey(typed);
  const inputKey = foldText(inputCase);
  const shapes: Typed = { caseKey: inputCase, key: inputKey, units: letterUnits(typed), numbers: numbersOf(input) };
  let best = forms[0];
  let bestMatch = matchForm(shapes, best);
  for (let k = 1; k < forms.length && bestMatch.kind !== 'exact'; k++) {
    const match = matchForm(shapes, forms[k]);
    if (RANK[match.kind] < RANK[bestMatch.kind] || (match.kind === bestMatch.kind && match.dist < bestMatch.dist)) {
      best = forms[k];
      bestMatch = match;
    }
  }

  const verdict = VERDICT[bestMatch.kind];
  // A 'close' match is one of the three CloseReason kinds (see VERDICT).
  const reason: CloseReason | null = verdict === 'close' ? (bestMatch.kind as CloseReason) : null;
  return {
    verdict,
    suggested: SUGGESTED[verdict],
    reason,
    expected: best.text,
    article: reason === 'article' && best.lead ? { article: best.lead.article, word: best.lead.word } : null,
    diff: verdict === 'exact' ? [{ op: 'same', typed, expected: best.text }] : letterDiff(typed, best.text),
  };
}

/* ---------------------------------------------------------------- target */

/** What the learner types for one card, and how to check it. */
export interface TypingTarget {
  /** The expected answer as one line (FieldBlock.plain). '' = nothing to type (an image, an empty field). */
  text: string;
  /** Its language (FieldBlock.lang), for the German article rule. */
  lang?: string;
  /**
   * The role of its field. `checkTyped` applies the German missing-article
   * rule only to 'term' (spec §9.2). null = unknown, so not a term.
   */
  role: FieldRole | null;
  /** True when the field has line breaks (a conjugation table): it is never typed. */
  multiline: boolean;
}

/** A block → its typing target. */
function targetOf(block: FieldBlock): TypingTarget {
  const target: TypingTarget = { text: block.plain, role: block.role, multiline: block.lines.length > 1 };
  if (block.lang) target.lang = block.lang;
  return target;
}

/**
 * What to type for a card (spec §6.3): the template's typing field
 * (`TemplateDef.typeField`, from Anki's {{type:Field}}) if the face has it,
 * else the answer headline (the first answer block). A cloze card types the
 * text of its deletion(s) ("Paris"), which is `face.answerPlain`.
 *
 *   typingTarget(face, germanVocab, 0) → { text: 'die Stunde', lang: 'de-DE', role: 'term', multiline: false }
 *
 * null when the face has no answer at all. The speaker block of a dictation
 * question (render.ts) holds the typing field too: its `plain` is the word.
 */
export function typingTarget(
  face: CardFace,
  type?: Pick<NoteType, 'kind' | 'templates'> | null,
  ord: number = 0,
): TypingTarget | null {
  const head = face.answer[0];
  if (type?.kind === 'cloze') {
    const target: TypingTarget = { text: face.answerPlain, role: head?.role ?? null, multiline: false };
    if (head?.lang) target.lang = head.lang;
    return target;
  }
  const template = type?.templates.find((t) => t.ord === ord);
  const field = template?.typeField;
  if (field !== undefined) {
    const block = face.answer.find((b) => b.field === field) ?? face.prompt.find((b) => b.field === field);
    if (block) return targetOf(block);
  }
  return head ? targetOf(head) : null;
}

/**
 * True when a target can be typed (spec §6.3): it has text, it is one line,
 * and it is at most 60 characters long. Otherwise the card is flipped
 * ("Long answer — flip instead").
 */
export function isTypeable(target: TypingTarget | null | undefined): boolean {
  if (!target || target.multiline) return false;
  const text = cleanAnswer(target.text);
  return text !== '' && Array.from(text).length <= TYPING_MAX_CHARS;
}

/**
 * Check what the learner typed against a typing target: the call the
 * session makes after "Check". It is checkAnswer with the target's language,
 * and with `term` and `word` read from the field's role. So the German
 * "missing article" rule applies only to a field with the role 'term' (spec
 * §9.2), never to a German meaning or example field; the English "missing
 * to / the / a" rule (6b) applies to a 'term' or a 'meaning' field (a word),
 * never to an example sentence.
 *
 *   checkTyped('Stunde', { text: 'die Stunde', lang: 'de-DE', role: 'term', multiline: false })
 *     → close (reason 'article')
 *   checkTyped('Stunde', { text: 'die Stunde', lang: 'de-DE', role: 'meaning', multiline: false })
 *     → wrong
 *   checkTyped('sleep', { text: 'to sleep / the sleep', lang: 'en-US', role: 'meaning', multiline: false })
 *     → close (reason 'article', "to")
 */
export function checkTyped(input: string, target: TypingTarget): AnswerResult {
  const role = target.role;
  return checkAnswer(input, target.text, { lang: target.lang, term: role === 'term', word: role === 'term' || role === 'meaning' });
}
