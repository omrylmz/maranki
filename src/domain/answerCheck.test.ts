/**
 * Typing mode: checkAnswer and the typing target (spec §6.3, unit W4-4 / A3).
 *
 * Pinned here: umlauts and accents, ß/ss, case, alternatives (, ; /) without
 * plural-suffix notes ("-en") and without splitting a number ("1,000", "3/4"),
 * German alternatives ("der/die X", never a bare article), the missing German
 * article → close and a WRONG article → wrong (also next to a plural
 * form), only for term fields (checkTyped), the typo thresholds (≤ 1 up to
 * 6 letters, ≤ 2 above; ß is one letter), numbers (a different digit, sign
 * or decimal point is never a typo; ², ₂ and – are a digit and a minus;
 * a padding zero is formatting; "3.10." is a day.month date, not 3.1;
 * a fraction "1/2" or "1 / 2" is one value, and so is "6 / 8", but a spaced
 * LIST of numbers "10 / 20 / 30" or of clock times "6:45 / 7:30" still
 * splits), the missing English "to", "the", "a", "an" → close (rule 6b,
 * words only), an optional part in brackets ("(to) go" accepts "go",
 * "(der/die) Angestellte" accepts "Angestellte"), the long-answer fallback,
 * and the letter diff.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW } from '../test/clock';
import { makeNoteV3 } from '../test/factoriesV3';
import {
  ARTICLE_HINT_COPY,
  answerAlternatives,
  answerKey,
  checkAnswer,
  checkTyped,
  cleanAnswer,
  isTypeable,
  leadHintCopy,
  letterDiff,
  LONG_ANSWER_COPY,
  TO_HINT_COPY,
  TYPING_MAX_CHARS,
  typingTarget,
  type TypingTarget,
} from './answerCheck';
import { BUILTIN_TYPE_IDS, builtinType } from './builtinTypes';
import type { NoteType } from './model';
import { renderFace } from './render';

const DE = { lang: 'de-DE' };

describe('cleanAnswer and answerKey', () => {
  it('trims, collapses spaces and drops punctuation at the ends', () => {
    expect(cleanAnswer('  Hello,   world! ')).toBe('Hello, world');
    expect(cleanAnswer('¿Qué tal?')).toBe('Qué tal');
    expect(cleanAnswer('„Hallo“')).toBe('Hallo');
    expect(cleanAnswer('...')).toBe('');
    expect(cleanAnswer("don't")).toBe("don't"); // an apostrophe inside a word stays
  });

  it('answerKey folds case, accents and ß', () => {
    expect(answerKey('Die Stunde.')).toBe('die stunde');
    expect(answerKey('Über')).toBe('uber');
    expect(answerKey('Straße')).toBe('strasse');
  });
});

describe('checkAnswer: case, spaces and punctuation', () => {
  it.each([
    ['haus', 'Haus'],
    ['HAUS', 'Haus'],
    ['  die   Stunde ', 'die Stunde'],
    ['the hour', 'The hour.'],
    ['que tal', '¿Que tal?'],
  ])('%j for %j is exact', (input, expected) => {
    const r = checkAnswer(input, expected);
    expect(r.verdict).toBe('exact');
    expect(r.suggested).toBe('good');
    expect(r.reason).toBeNull();
  });

  it('an empty answer is wrong', () => {
    const r = checkAnswer('   ', 'Haus');
    expect(r.verdict).toBe('wrong');
    expect(r.suggested).toBe('again');
    expect(r.expected).toBe('Haus');
  });
});

describe('checkAnswer: umlauts and accents', () => {
  it('"uber" for "über" is close (accents only) → Hard', () => {
    const r = checkAnswer('uber', 'über');
    expect(r).toMatchObject({ verdict: 'close', suggested: 'hard', reason: 'accents', expected: 'über' });
  });

  it('the right umlaut is exact, in any case', () => {
    expect(checkAnswer('über', 'über').verdict).toBe('exact');
    expect(checkAnswer('ÜBER', 'über').verdict).toBe('exact');
  });

  it('Spanish and French accents count the same way', () => {
    expect(checkAnswer('arbol', 'árbol').reason).toBe('accents');
    expect(checkAnswer('árbol', 'árbol').verdict).toBe('exact');
    expect(checkAnswer('ecole', "l'école").verdict).not.toBe('exact');
  });

  it('a deck that stores DECOMPOSED accents (u + U+0308) matches the one-character ü exactly', () => {
    const decomposed = 'über';
    expect(checkAnswer('über', decomposed).verdict).toBe('exact');
    expect(checkAnswer('Über', 'Über').verdict).toBe('exact');
    expect(checkAnswer('uber', decomposed).reason).toBe('accents');
  });
});

describe('checkAnswer: ß and ss', () => {
  it('ß and ss are the same spelling (Swiss German, capital letters): exact both ways', () => {
    expect(checkAnswer('Strasse', 'Straße').verdict).toBe('exact');
    expect(checkAnswer('Straße', 'Strasse').verdict).toBe('exact');
    expect(checkAnswer('STRASSE', 'Straße').verdict).toBe('exact');
  });

  it('a typo next to ß is still a typo', () => {
    // 'strase' vs 'strasse': one letter missing → close.
    expect(checkAnswer('Strase', 'Straße')).toMatchObject({ verdict: 'close', reason: 'typo' });
  });

  // Adapted in W4-7 review round 1: "Strane" was listed here as a 2-edit
  // case, but it is ONE wrong letter (n for ß) in a 6-letter word, so spec
  // §6.3 makes it close (see the next test). "Stane" (r missing AND n for ß)
  // is the 2-edit case in its place.
  it('ß is ONE letter for the typo limit: "Straße" has 6 letters, so 2 edits are wrong', () => {
    // The comparison key spells ß as "ss" (7 characters); the limit counts the 6 shown letters.
    expect(checkAnswer('Stase', 'Straße')).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    expect(checkAnswer('Stane', 'Straße').verdict).toBe('wrong');
    // The same word written with "ss" has 7 letters: 2 edits are still close there.
    expect(checkAnswer('Stase', 'Strasse').verdict).toBe('close');
    // A decomposed umlaut (u + U+0308) is one letter too: "Tür" has 3 letters.
    expect(checkAnswer('Tor', 'Tür').verdict).toBe('close'); // 1 edit
    expect(checkAnswer('Tox', 'Tür').verdict).toBe('wrong'); // 2 edits on 3 letters
  });

  it('ß is ONE letter for the distance too: one missing or wrong ß is a 1-letter typo (spec §6.3)', () => {
    // Before this fix the distance spelled ß as "ss", so a missing ß cost 2 edits → wrong.
    for (const input of ['Strae', 'Strabe', 'Strase', 'Strane']) {
      expect(checkAnswer(input, 'Straße')).toMatchObject({ verdict: 'close', reason: 'typo', suggested: 'hard' });
    }
    expect(checkAnswer('heien', 'heißen')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('heisen', 'heißen')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // Two letters wrong are still wrong.
    expect(checkAnswer('Stase', 'Straße').verdict).toBe('wrong');
    expect(checkAnswer('hein', 'heißen').verdict).toBe('wrong');
    // ß written as "ss" (rule 2) plus ONE typo is still one typo.
    expect(checkAnswer('Strasee', 'Straße')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // The same for the other letters that compare as two (æ → "ae"): "æble" has 4 letters.
    expect(checkAnswer('ble', 'æble')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('aeble', 'æble')).toMatchObject({ verdict: 'close', reason: 'accents' }); // as before
  });
});

describe('checkAnswer: numbers are never a typo', () => {
  it.each([
    ['1944', '1945'], // a wrong year
    ['1954', '1945'], // two digits swapped
    ['12', '13'],
    ['42', '24'],
    ['3', '-3'], // the sign is part of the value
    ['-3', '3'],
    ['3/5', '3/4'],
    ['0.76', '0.75'],
    ['O(1)', 'O(n)'], // a complexity class
    ['O(n)', 'O(1)'],
    ['1,001', '1,000'],
    // A minus sign after "=", "(" or "," starts a number too (W4-7 review round 1).
    ['x=3', 'x=-3'],
    ['x=-3', 'x=3'],
    ['f(1)', 'f(-1)'],
    ['(2,3)', '(2,-3)'],
    ['.5', '-.5'],
    ['3', '−3'], // the real minus sign U+2212
  ])('%j for %j is wrong → Again', (input, expected) => {
    expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
  });

  it('a pure formatting difference keeps the same digits: the typo rule still decides', () => {
    expect(checkAnswer('1000', '1,000')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('0,75', '0.75')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('B52', 'B-52')).toMatchObject({ verdict: 'close', reason: 'typo' }); // a dash inside a name is no minus sign
    expect(checkAnswer('34', '3-4')).toMatchObject({ verdict: 'close', reason: 'typo' }); // a dash between digits is a range, no sign
    expect(checkAnswer('f(-1)', 'f(-1)').verdict).toBe('exact');
    expect(checkAnswer('in 1945', 'in 1945.')).toMatchObject({ verdict: 'exact' });
    // A typo in the WORDS next to the number is still a typo.
    expect(checkAnswer('in 1954', 'in 1945').verdict).toBe('wrong');
    expect(checkAnswer('im 1945', 'in 1945')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // No digits on either side: nothing changes.
    expect(checkAnswer('Abfart', 'Abfahrt').verdict).toBe('close');
  });

  it('an alternative with the right number still matches', () => {
    expect(checkAnswer('1945', '1944, 1945').verdict).toBe('exact');
    expect(checkAnswer('1946', '1944; 1945').verdict).toBe('wrong');
  });

  // W4-7 review round 2: the number rule counted only ASCII 0-9 as digits, so
  // the digit the learner typed was part of the number and the "₂" of the
  // answer was not: "CO2" for "CO₂" was 'wrong' (it was 'close' before).
  it('a superscript, subscript or full-width digit IS that digit: the typo rule decides again', () => {
    for (const [input, expected] of [
      ['CO2', 'CO₂'],
      ['H2O', 'H₂O'],
      ['m2', 'm²'],
      ['x2', 'x²'],
      ['E = mc2', 'E = mc²'],
    ]) {
      expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'close', reason: 'typo', suggested: 'hard' });
    }
    expect(checkAnswer('CO₂', 'CO₂').verdict).toBe('exact');
    // Another digit is still another value.
    expect(checkAnswer('m3', 'm²')).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
    expect(checkAnswer('CO3', 'CO₂').verdict).toBe('wrong');
    expect(checkAnswer('x3', 'x²').verdict).toBe('wrong');
    // Full-width digits too: 1 edit on 2 letters, but a different value.
    expect(checkAnswer('１３', '１２').verdict).toBe('wrong');
  });

  it('an en dash, a figure dash or a full-width minus before a number is a minus sign', () => {
    // The right value, typed with the keyboard's "-": the typo rule decides.
    expect(checkAnswer('-3', '–3')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('−3', '–3').verdict).toBe('close');
    expect(checkAnswer('–3', '–3').verdict).toBe('exact');
    // The sign is missing: a different value (the file header: "3" for "-3" is wrong).
    for (const expected of ['–3', '‒3', '－3', 'x = –3']) {
      const input = expected.replace(/[–‒－]/, '');
      expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    }
    // A dash between two digits is still a range, not a sign.
    expect(checkAnswer('34', '3–4')).toMatchObject({ verdict: 'close', reason: 'typo' });
  });

  // W4-7 review round 2: the number rule dropped every "." and ",", so a
  // decimal point in another place gave the same digits and only 1 edit.
  it.each([
    ['75', '7.5'],
    ['7.5', '75'],
    ['1.5', '15'],
    ['31.4', '3.14'], // a digit and the point swapped: 1 edit, but 10 times the value
    ['31,4', '3,14'],
    ['7,5', '75'],
    ['0750', '0,750'], // "0," never starts a thousands group: this is a decimal
    ['12345678', '12,345.678'],
    ['x=5', 'x=.5'],
  ])('%j for %j: the decimal point moved or is missing → wrong', (input, expected) => {
    expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
  });

  it('a thousands separator, a decimal comma and a cut between numbers are formatting: the typo rule decides', () => {
    for (const [input, expected] of [
      ['1000', '1,000'],
      ['1000', '1.000'], // a German thousands point
      ['1.000', '1,000'],
      ['1000000', '1,000,000'],
      ['0,75', '0.75'],
      ['0.750', '0,750'],
      ['1.000,5', '1,000.5'],
      ['12345.678', '12,345.678'],
      ['x=0.5', 'x=.5'], // ".5" is "0.5"
      ['(2,3)', '(2, 3)'], // two numbers: the comma also cuts them
      ['12.30', '12:30'], // a time
      ['24.12.2023', '24/12/2023'], // a date
    ]) {
      expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'close', reason: 'typo', suggested: 'hard' });
    }
  });

  // W5-5a: the digit strings were compared exactly, so a zero that only pads a
  // number made a right answer 'wrong' (it was 'close' before W4-7). A padding
  // zero does not change the value: the typo rule decides again.
  it.each([
    ['9:00', '09:00'], // a time
    ['um 9:00 Uhr', 'um 09:00 Uhr'],
    ['9 Uhr', '09 Uhr'],
    ['7.5.1945', '07.05.1945'], // a German date
    ['07.05.1945', '7.5.1945'],
    ['10.50', '10.5'], // a zero at the end of a decimal part
    ['10.5', '10.50'],
    ['0.50', '0.5'],
    ['2.5', '2.50'],
    ['9.8', '9.80'],
    ['9.8 m/s²', '9.80 m/s²'],
    ['3,5 €', '3,50 €'],
  ])('%j for %j: a padding zero is formatting → close (Hard)', (input, expected) => {
    expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'close', reason: 'typo', suggested: 'hard' });
  });

  it('a different VALUE stays wrong, also next to the padding-zero rule', () => {
    for (const [input, expected] of [
      ['1944', '1945'],
      ['75', '7.5'],
      ['0750', '0,750'], // 750 is not 0.750
      ['3', '-3'],
      ['9:05', '9:50'], // the zero is at the END of a whole number: it counts
      ['3.5', '3.05'], // a zero at the START of a decimal part counts
      ['10', '1.0'],
      ['7.5.1946', '07.05.1945'],
      // W5-5a review round 1: the by-value shape left out the zero of the
      // minutes, so "9:05" had the digits of "95" and "9.5", and these were
      // 'close' (Hard). Each one is only 2 edits on a longer text, so the
      // NUMBER rule must say wrong here, not the typo limit.
      ['um 90 Uhr', 'um 9:00 Uhr'],
      ['Zug um 95', 'Zug um 9:05'],
      ['Zug um 105', 'Zug um 10:05'],
      ['Kickoff at 15 pm', 'Kickoff at 1:05 pm'],
      ['Abfahrt um 9.5 Uhr', 'Abfahrt um 9:05 Uhr'],
      ['score 21', 'score 2:01'],
      ['ratio 1.5 here', 'ratio 1:05 here'],
      // The same for a space or "/" between the two parts: the "05" keeps its zero.
      ['Zug um 9 05', 'Zug um 9.5'],
      ['Zug um 9.5', 'Zug um 9 05'],
      ['am 1/05 um', 'am 1.5 um'],
    ]) {
      expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
    }
    // The typo limit still applies: a formatting difference of more letters than the limit is wrong.
    expect(checkAnswer('10', '10.00').verdict).toBe('wrong');
  });

  // W5-5a review round 1: a padding zero AND a dot for the ":" of a time
  // (how many German learners write a time) were 'wrong', although each
  // difference alone is 'close'. Both together are formatting too. (They are
  // 2 edits, so the text must have more than 6 letters: a bare "9.30" for
  // "09:30" is over the typo limit of spec §6.3.)
  it.each([
    ['um 9.30 Uhr', 'um 09:30 Uhr'],
    ['um 9.00 Uhr', 'um 09:00 Uhr'],
    ['um 9.05 Uhr', 'um 09:05 Uhr'],
    ['um 09.30 Uhr', 'um 9:30 Uhr'],
  ])('%j for %j: a padding zero and another time separator → close (Hard)', (input, expected) => {
    expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'close', reason: 'typo', suggested: 'hard' });
  });

  it('a padding zero and another time separator never make a different value close', () => {
    for (const [input, expected] of [
      ['um 9.5 Uhr', 'um 09:05 Uhr'], // 9.5 is not 9:05
      ['um 90 Uhr', 'um 09:00 Uhr'], // 90 is not 9:00
      ['um 9.50 Uhr', 'um 09:05 Uhr'],
    ]) {
      expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
    }
  });

  // W5-5a review round 2: the by-value shape read EVERY two-part number as a
  // decimal number and dropped the zeros at the end of its second part. But a
  // German day and month are written with an ordinal dot: "3.10." = 3 October.
  // So "3.1." (3 January) for "3.10." was 1 edit with the same numbers:
  // 'close' (Hard), although it is a different day.
  it.each([
    ['3.1.', '3.10.'],
    ['am 3.1. gefeiert', 'am 3.10. gefeiert'],
    ['31.1.', '31.10.'],
    ['1.10.', '1.1.'],
    ['3.1', '3.10.'], // no ordinal dot typed: "3.1" is a decimal number, not 3 October
    ['Feiertag: 3.1.', 'Feiertag: 3.10.'],
    ['1.1.1990', '1.10.1990'], // a three-part date was already right
  ])('%j for %j: a day.month date with another month → wrong', (input, expected) => {
    expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
  });

  it('a day.month date keeps its padding-zero rule: the typo rule decides', () => {
    expect(checkAnswer('3.10.', '03.10.')).toMatchObject({ verdict: 'close', reason: 'typo', suggested: 'hard' });
    expect(checkAnswer('03.10.', '3.10.')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('am 3.10. gefeiert', 'am 03.10. gefeiert')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('am 1.5. frei', 'am 1.05. frei')).toMatchObject({ verdict: 'close', reason: 'typo' }); // 1 May
    // The full stop at the end is still never needed.
    expect(checkAnswer('3.10', '3.10.').verdict).toBe('exact');
    expect(checkAnswer('3.10.', '3.10.').verdict).toBe('exact');
    expect(checkAnswer('3.10.', '3.10').verdict).toBe('exact');
    // The public alternatives do not change: the full stop at the end is dropped as before.
    expect(answerAlternatives('3.10., 9.11.')).toEqual(['3.10., 9.11', '3.10', '9.11']);
    expect(cleanAnswer('3.10.')).toBe('3.10');
  });

  it('a date in an alternative or in a German field is still a date', () => {
    expect(checkAnswer('9.11', '3.10., 9.11.').verdict).toBe('exact');
    expect(checkAnswer('3.1.', '3.10., 9.11.')).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    expect(checkAnswer('9.1.', '3.10.; 9.11.')).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    // The German alternatives (rule 7) and the article rule (6) read the same date.
    const de = { lang: 'de-DE' };
    expect(checkAnswer('am 3.1.', 'am 3.10.', de)).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    expect(checkAnswer('der 3.1.', 'der 3.10.', de)).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    expect(checkAnswer('der 03.10.', 'der 3.10.', de)).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('am 3.10', 'am 3.10.', de).verdict).toBe('exact');
  });

  it('only a day and a month are a date: a decimal number before a full stop keeps its zero rule', () => {
    // 50 or 80 is no month, so these are decimal numbers at the end of a sentence.
    expect(checkAnswer('It costs 3.5.', 'It costs 3.50.')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('g = 9.8.', 'g = 9.80.')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // A decimal comma is never a date ("3,10" = 3.1).
    expect(checkAnswer('Es kostet 3,1.', 'Es kostet 3,10.')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // Without an ordinal dot, a two-part number is a decimal number, as before.
    expect(checkAnswer('10.5', '10.50')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('9.8', '9.80')).toMatchObject({ verdict: 'close', reason: 'typo' });
  });

  // W5-5a: cleanAnswer dropped the "." of ".5" as end punctuation, so "5" for ".5" was 'exact'.
  it('a number that starts with its decimal point keeps it: "5" for ".5" is wrong, never exact', () => {
    expect(cleanAnswer('.5')).toBe('.5');
    expect(cleanAnswer(',5')).toBe(',5');
    expect(cleanAnswer('1945.')).toBe('1945'); // a full stop at the end still goes
    expect(cleanAnswer('. Hallo')).toBe('Hallo');
    expect(checkAnswer('5', '.5')).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    expect(checkAnswer('25', '.25').verdict).toBe('wrong');
    // ",5" is one number (0,5): the comma is not a separator of alternatives, so "5" is not one.
    expect(answerAlternatives(',5')).toEqual([',5']);
    expect(checkAnswer('5', ',5').verdict).toBe('wrong');
    expect(checkAnswer('0,5', ',5')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('0.5', '.5')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('.5', '.5').verdict).toBe('exact');
    expect(checkAnswer('.5', '0.5')).toMatchObject({ verdict: 'close', reason: 'typo' });
  });

  // Wave 5b (R1): removing the fraction bar still graded 'close' ("12" for
  // "1/2" is one missing letter), and "1 / 2" with spaces was split into the
  // alternatives "1" and "2", so "1" was EXACT. A fraction is one value.
  it.each([
    ['12', '1/2'], // the bar removed
    ['1/2', '12'], // a bar added
    ['1.2', '1/2'], // a decimal point is not a fraction bar
    ['1,2', '1/2'],
    ['1 2', '1/2'],
    ['1', '1 / 2'], // one part of a spaced fraction is not the answer
    ['2', '1 / 2'],
    ['12', '1 / 2'],
    ['34 cup', '3/4 cup'],
    ['2/1', '1/2'], // other digits
    // Review round 1: the same digits and the same bar, but another value.
    ['11/2', '1 1/2'], // eleven halves (5.5) for one and a half (1.5)
    ['1 1/2', '11/2'],
    ['21/2', '2 1/2'],
    ['1/23', '1/2 3'], // the denominator is "23", not "2" and then "3"
  ])('a fraction is one value: %j for %j is wrong → Again', (input, expected) => {
    expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
  });

  it('a fraction is compared as a whole; the spaces around its bar are formatting', () => {
    expect(answerAlternatives('1 / 2')).toEqual(['1 / 2']);
    expect(answerAlternatives('1 / 2, 0.5')).toEqual(['1 / 2, 0.5', '1 / 2', '0.5']);
    expect(checkAnswer('1/2', '1 / 2').verdict).toBe('exact');
    expect(checkAnswer('1 / 2', '1/2').verdict).toBe('exact');
    expect(checkAnswer('1 /2', '1/2').verdict).toBe('exact');
    expect(checkAnswer('3/4 cup', '3 / 4 cup').verdict).toBe('exact');
    expect(checkAnswer('0.5', '1 / 2, 0.5').verdict).toBe('exact');
    // A typo in the words next to a fraction is still a typo.
    expect(checkAnswer('3/4 cop', '3/4 cup')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // A padding zero inside a fraction is formatting, as before.
    expect(checkAnswer('1/5', '1/05')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // A mixed number: the spaces around its bar are formatting, and so is the
    // way its whole part is set apart (a space or a dash). Only "11/2" is wrong (above).
    expect(checkAnswer('1 1/2', '1 1 / 2').verdict).toBe('exact');
    expect(checkAnswer('1-1/2', '1 1/2')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('1 1/2 cups', '1 1/2 cup')).toMatchObject({ verdict: 'close', reason: 'typo' });
    // A slash that is not between two digits still splits alternatives.
    expect(checkAnswer('she', 'he / she').verdict).toBe('exact');
    // A chain of slashes is a date, not a fraction: its separators are formatting, as before.
    expect(checkAnswer('3.10.2024', '3/10/2024')).toMatchObject({ verdict: 'close', reason: 'typo' });
  });

  // Wave 5c (the R1 regression): the R1 fix read EVERY spaced "/" between two
  // numbers as a fraction bar, so a LIST of numbers became one value: "10"
  // for "10 / 20 / 30" and "1/2" for "0.5 / 1/2" were 'wrong' (Again). A
  // spaced slash between two numbers can mean "one half" or "one OR two":
  // the text around it decides.
  it('a spaced "/" in a LIST of numbers splits alternatives again (the R1 regression)', () => {
    expect(answerAlternatives('0.5 / 1/2')).toEqual(['0.5 / 1/2', '0.5', '1/2']);
    expect(answerAlternatives('1/2 / 3/4')).toEqual(['1/2 / 3/4', '1/2', '3/4']);
    expect(answerAlternatives('1 / 2 / 3')).toEqual(['1 / 2 / 3', '1', '2', '3']);
    expect(answerAlternatives('20 / 30')).toEqual(['20 / 30', '20', '30']);
    for (const [input, expected] of [
      ['1/2', '0.5 / 1/2'], // a decimal number on one side: two values
      ['0.5', '0.5 / 1/2'],
      ['3/4', '1/2 / 3/4'], // another "/" joined to a number: two fractions
      ['1/2', '1/2 / 3/4'],
      ['1', '1 / 2 / 3'], // a chain of slashes: a list
      ['10', '10 / 20 / 30'],
      ['30', '10 / 20 / 30'],
      ['1', 'one / 1 / 2'],
      ['20', '20 / 30'], // not in lowest terms: nobody writes 2/3 as "20 / 30"
      ['12', '12 / 24'],
      ['2,5', '1 / 2,5'], // a decimal comma after the bar
    ]) {
      expect([input, expected, checkAnswer(input, expected).verdict]).toEqual([input, expected, 'exact']);
    }
    // A fraction in the list is still one value: never its parts.
    expect(checkAnswer('2', '0.5 / 1/2').verdict).toBe('wrong');
    expect(checkAnswer('1', '1/2 / 3/4').verdict).toBe('wrong');
  });

  it('one simple fraction stays one value, with or without spaces (R1 kept)', () => {
    for (const expected of ['1 / 2', '3 / 4 cup', '24 / 7', '1 1 / 2', '-1 / 2', '1 / 2, 0.5']) {
      expect(answerAlternatives(expected)[0]).toBe(expected);
      expect(answerAlternatives(expected)).not.toContain('1');
      expect(answerAlternatives(expected)).not.toContain('2');
    }
    expect(checkAnswer('1', '1 / 2').verdict).toBe('wrong');
    expect(checkAnswer('2', '1 / 2').verdict).toBe('wrong');
    expect(checkAnswer('3', '3 / 4 cup').verdict).toBe('wrong');
    expect(checkAnswer('24', '24 / 7').verdict).toBe('wrong');
    expect(checkAnswer('1/2', '1 / 2').verdict).toBe('exact');
    expect(checkAnswer('-1/2', '-1 / 2').verdict).toBe('exact');
    // A mixed number: "1 1 / 2" (one and a half) is never "11/2" (eleven halves), and the other way round.
    expect(checkAnswer('1 1/2', '1 1 / 2').verdict).toBe('exact');
    expect(checkAnswer('11/2', '1 1 / 2').verdict).toBe('wrong');
    expect(checkAnswer('1 1/2', '11 / 2').verdict).toBe('wrong');
    expect(checkAnswer('11/2', '11 / 2').verdict).toBe('exact');
  });

  // Wave 5c, review round 1: the context rule (one value or a list) also
  // decided whether the spaces around the slash are formatting. So a
  // fraction that is not in lowest terms, or a chain, typed with other
  // spaces was 'wrong' (Again): "6 / 8" for a music deck's "6/8".
  it('the spaces around a "/" between two digits are formatting, for ANY fraction and for a list', () => {
    for (const [input, expected] of [
      ['6 / 8', '6/8'], // a time signature
      ['6/8', '6 / 8'],
      ['2 / 4', '2/4'],
      ['2/4', '2 / 4'],
      ['4 / 4', '4/4'],
      ['4/4', '4 / 4'],
      ['10 / 20', '10/20'],
      ['2 2/4', '2 2 / 4'], // a mixed number
      ['1/2/3', '1 / 2 / 3'], // a chain
      ['3/10/2024', '3 / 10 / 2024'], // a date
      ['10/20/30', '10 / 20 / 30'],
    ]) {
      expect([input, expected, checkAnswer(input, expected).verdict]).toEqual([input, expected, 'exact']);
    }
    // A list still accepts each of its parts. (Review round 2: "6 / 8" and
    // "4 / 4" are one value now, see the one-digit test below.)
    expect(answerAlternatives('10 / 20')).toEqual(['10 / 20', '10', '20']);
    expect(checkAnswer('20', '10 / 20').verdict).toBe('exact');
  });

  // Wave 5c, review round 1: lowest terms alone made "1939 / 1945" (two
  // years) one fraction, so "1945" was 'wrong'.
  it('two numbers of 3 digits or more around a spaced "/" are a list; small numbers stay one fraction', () => {
    expect(answerAlternatives('1939 / 1945')).toEqual(['1939 / 1945', '1939', '1945']);
    expect(checkAnswer('1945', '1939 / 1945').verdict).toBe('exact');
    expect(checkAnswer('1989', '1989 / 1990').verdict).toBe('exact');
    expect(checkAnswer('112', '110 / 112').verdict).toBe('exact'); // the emergency numbers
    // Small numbers, or only ONE big number: still one fraction.
    expect(checkAnswer('3', '3 / 4 cup').verdict).toBe('wrong');
    expect(checkAnswer('24', '24 / 7').verdict).toBe('wrong');
    expect(checkAnswer('1', '1 / 100').verdict).toBe('wrong');
    expect(answerAlternatives('1 / 100')).toEqual(['1 / 100']);
  });

  // Wave 5c, review round 1: every spaced chain was a list, and the lowest-
  // terms test split a mixed number. So "3" for "3 / 10 / 2024" (a date)
  // and "4" for "2 2 / 4" were 'exact'.
  it('a spaced date of 3 numbers and a mixed number are one value', () => {
    expect(answerAlternatives('3 / 10 / 2024')).toEqual(['3 / 10 / 2024']);
    expect(answerAlternatives('12 / 25 / 1999')).toEqual(['12 / 25 / 1999']); // month first
    expect(checkAnswer('3', '3 / 10 / 2024').verdict).toBe('wrong');
    expect(checkAnswer('2024', '3 / 10 / 2024').verdict).toBe('wrong');
    expect(checkAnswer('3/10/2024', '3 / 10 / 2024').verdict).toBe('exact');
    // Not a date: a list as before (no year of 4 digits, no day and month, or 4 numbers).
    expect(answerAlternatives('5 / 10 / 15')).toEqual(['5 / 10 / 15', '5', '10', '15']);
    expect(answerAlternatives('40 / 50 / 2024')).toEqual(['40 / 50 / 2024', '40', '50', '2024']);
    expect(answerAlternatives('3 / 10 / 2024 / 2025')).toEqual(['3 / 10 / 2024 / 2025', '3', '10', '2024', '2025']);
    // A mixed number: one value, also when its fraction is not in lowest terms.
    expect(answerAlternatives('2 2 / 4')).toEqual(['2 2 / 4']);
    expect(checkAnswer('4', '2 2 / 4').verdict).toBe('wrong');
    expect(checkAnswer('2 2', '2 2 / 4').verdict).toBe('wrong');
    expect(checkAnswer('2 2/4', '2 2 / 4').verdict).toBe('exact');
    expect(checkAnswer('22/4', '2 2 / 4').verdict).toBe('wrong'); // twenty-two quarters
    // Without the whole part, two one-digit numbers are one value too (review round 2).
    expect(answerAlternatives('2 / 4')).toEqual(['2 / 4']);
  });

  // Wave 5c, review round 2: rule 1 looked only for a "." or "," next to the
  // spaced slash. The digits next to the slash of "6:45 / 7:30" are "45" and
  // "7" (in lowest terms), so the two clock times were ONE value, and "6:45"
  // was 'wrong' (Again). "8:30 / 9:30" split only by chance (30 and 9 share
  // the factor 3).
  it('a spaced "/" between two clock times or two ratios is a list', () => {
    expect(answerAlternatives('6:45 / 7:30')).toEqual(['6:45 / 7:30', '6:45', '7:30']);
    for (const [input, expected] of [
      ['6:45', '6:45 / 7:30'], // the train leaves at 6:45 or at 7:30
      ['7:30', '6:45 / 7:30'],
      ['7:45', '7:45 / 8:15'],
      ['13:45', '12:30 / 13:45'],
      ['11:15', '10:15 / 11:15'],
      ['8:30', '8:30 / 9:30'], // split before by chance: still split
      ['16:9', '16:9 / 4:3'], // two ratios
      ['4:3', '16:9 / 4:3'],
      ['3:2', '2:1 / 3:2'],
      ['6:45/7:30', '6:45 / 7:30'], // the spaces around the slash are formatting
    ]) {
      expect([input, expected, checkAnswer(input, expected).verdict]).toEqual([input, expected, 'exact']);
    }
    // A part of a clock time is still not an answer.
    expect(checkAnswer('45', '6:45 / 7:30').verdict).toBe('wrong');
    expect(checkAnswer('6:54', '6:45 / 7:30').verdict).toBe('wrong');
    // A ":" after a WORD is not a clock time: "Note:1 / 2" keeps its one fraction.
    expect(answerAlternatives('Note:1 / 2')).toEqual(['Note:1 / 2']);
  });

  // Wave 5c, review round 2: the lowest-terms test split every spaced pair
  // that is not reduced, also two one-digit numbers. So on a music card
  // "Time signature of a jig? → 6 / 8", the typed "8" was 'exact' (Good).
  it('two one-digit numbers around a spaced "/" are one value ("6 / 8", a time signature)', () => {
    for (const expected of ['6 / 8', '2 / 4', '4 / 4', '3 / 6', '1 / 2']) {
      expect(answerAlternatives(expected)).toEqual([expected]);
    }
    expect(checkAnswer('8', '6 / 8').verdict).toBe('wrong');
    expect(checkAnswer('6', '6 / 8').verdict).toBe('wrong');
    expect(checkAnswer('4', '2 / 4').verdict).toBe('wrong');
    expect(checkAnswer('4', '4 / 4').verdict).toBe('wrong');
    expect(answerAlternatives('6 / 8-Takt')).toEqual(['6 / 8-Takt']);
    // The whole value, with or without spaces, is still right.
    expect(checkAnswer('6/8', '6 / 8').verdict).toBe('exact');
    expect(checkAnswer('6 / 8', '6 / 8').verdict).toBe('exact');
    // Bigger numbers keep the lowest-terms test: "20 / 30" and "12 / 24" are lists, "24 / 7" is one value.
    expect(answerAlternatives('20 / 30')).toEqual(['20 / 30', '20', '30']);
    expect(answerAlternatives('12 / 24')).toEqual(['12 / 24', '12', '24']);
    expect(answerAlternatives('24 / 7')).toEqual(['24 / 7']);
    // A chain of one-digit numbers is still a list.
    expect(answerAlternatives('1 / 2 / 3')).toEqual(['1 / 2 / 3', '1', '2', '3']);
  });
});

describe('checkAnswer: alternatives', () => {
  it.each([
    ['to go', 'to go, to walk'],
    ['to walk', 'to go, to walk'],
    ['walk', 'go; walk'],
    ['she', 'he/she'],
    ['1,000', '1,000'], // the whole text counts too
  ])('%j for %j is exact', (input, expected) => {
    expect(checkAnswer(input, expected).verdict).toBe('exact');
  });

  it('`expected` is the alternative that matched', () => {
    expect(checkAnswer('to wlak', 'to go, to walk')).toMatchObject({ verdict: 'close', expected: 'to walk' });
  });

  it('answerAlternatives lists the whole text first, then the parts, without repeats', () => {
    expect(answerAlternatives('to go, to walk')).toEqual(['to go, to walk', 'to go', 'to walk']);
    expect(answerAlternatives('Haus')).toEqual(['Haus']);
    expect(answerAlternatives('a; a ; A')).toEqual(['a; a ; A', 'a']);
    expect(answerAlternatives('  ')).toEqual([]);
  });

  it('a plural-suffix note ("-en", "¨-er", "-") is not an alternative', () => {
    expect(answerAlternatives('die Abfahrt, -en')).toEqual(['die Abfahrt, -en', 'die Abfahrt']);
    expect(answerAlternatives('das Haus, ¨-er')).toEqual(['das Haus, ¨-er', 'das Haus']);
    expect(answerAlternatives('der Lehrer, -')).toEqual(['der Lehrer, -', 'der Lehrer']);
    expect(answerAlternatives('der Tisch, -(e)s, -e')).toEqual(['der Tisch, -(e)s, -e', 'der Tisch']);
    // So typing only the suffix is wrong, and the word itself is exact.
    expect(checkAnswer('-en', 'die Abfahrt, -en', DE).verdict).toBe('wrong');
    expect(checkAnswer('-en', 'die Abfahrt, -en').verdict).toBe('wrong');
    expect(checkAnswer('die Abfahrt', 'die Abfahrt, -en', DE).verdict).toBe('exact');
  });

  it('a number is never split: one piece of "1,000" or "3/4" is not the answer', () => {
    // A "," or "/" with a digit on both sides belongs to the number.
    expect(answerAlternatives('1,000')).toEqual(['1,000']);
    expect(answerAlternatives('3/4')).toEqual(['3/4']);
    expect(answerAlternatives('24/7')).toEqual(['24/7']);
    expect(answerAlternatives('1,5 Liter')).toEqual(['1,5 Liter']); // a German decimal comma
    for (const [input, expected] of [
      ['1', '1,000'],
      ['000', '1,000'],
      ['3', '3/4'],
      ['4', '3/4'],
      ['24', '24/7'],
      ['7', '24/7'],
    ]) {
      expect(checkAnswer(input, expected)).toMatchObject({ verdict: 'wrong', suggested: 'again' });
    }
    // The whole number is exact.
    expect(checkAnswer('1,000', '1,000').verdict).toBe('exact');
    expect(checkAnswer('3/4', '3/4').verdict).toBe('exact');
    // A comma or slash with a space or a letter next to it still splits.
    expect(answerAlternatives('1, 2')).toEqual(['1, 2', '1', '2']);
    expect(answerAlternatives('3/4, 0.75')).toEqual(['3/4, 0.75', '3/4', '0.75']);
    expect(checkAnswer('0.75', '3/4, 0.75').verdict).toBe('exact');
    expect(checkAnswer('she', 'he/she').verdict).toBe('exact');
  });

  it('a negative number and an all-suffix answer stay alternatives', () => {
    // "-3" has a digit: it is an answer (a maths card), not a suffix note.
    expect(answerAlternatives('-3, 2')).toEqual(['-3, 2', '-3', '2']);
    expect(checkAnswer('-3', '-3, 2').verdict).toBe('exact');
    // Every part is a suffix (a grammar card): then they ARE the answer.
    expect(answerAlternatives('-ing, -ed')).toEqual(['-ing, -ed', '-ing', '-ed']);
    expect(checkAnswer('-ed', '-ing, -ed').verdict).toBe('exact');
  });

  // Wave 5d (F1a, an old behaviour): a "/" inside brackets at the END split the answer into broken
  // parts — answerAlternatives('Haus (n / pl)') gave ['Haus (n / pl)', 'Haus (n', 'pl)'] — and
  // "gehen" for "gehen (ging / gegangen)" was 'wrong'.
  it('a separator inside brackets never splits, wherever the brackets are', () => {
    expect(answerAlternatives('Haus (n / pl)')).toEqual(['Haus (n / pl)']);
    expect(answerAlternatives('Haus (n / pl)', DE)).toEqual(['Haus (n / pl)']);
    expect(answerAlternatives('gehen (ging / gegangen)', DE)).toEqual(['gehen (ging / gegangen)']);
    expect(answerAlternatives('to run (fast/slow)')).toEqual(['to run (fast/slow)']);
    expect(answerAlternatives('to run (fast, slow) quickly')).toEqual(['to run (fast, slow) quickly']);
    // A separator OUTSIDE the brackets still splits, and each part keeps its brackets whole.
    expect(answerAlternatives('Haus (n / pl), Heim')).toEqual(['Haus (n / pl), Heim', 'Haus (n / pl)', 'Heim']);
    expect(answerAlternatives('go (went/gone); walk (walked)')).toEqual(['go (went/gone); walk (walked)', 'go (went/gone)', 'walk (walked)']);
    // Brackets inside brackets, and a lone "(" that makes no pair (it protects nothing: the old split).
    expect(answerAlternatives('a (b (c/d) e)')).toEqual(['a (b (c/d) e)']);
    expect(answerAlternatives('Haus (n / pl')).toEqual(['Haus (n / pl', 'Haus (n', 'pl']);
    expect(answerAlternatives('he/she) goes')).toEqual(['he/she) goes', 'he', 'she) goes']);
    // No broken part is ever shown as the expected answer.
    for (const typed of ['Haus (n', 'pl)', 'gehen (ging', 'gegangen)']) {
      for (const expected of ['Haus (n / pl)', 'gehen (ging / gegangen)']) {
        expect(checkAnswer(typed, expected, DE).expected).not.toMatch(/^[^(]*\)|\([^)]*$/);
      }
    }
  });

  it('a note of words in brackets at the END is optional: "gehen" is exact for "gehen (ging / gegangen)"', () => {
    expect(checkAnswer('gehen', 'gehen (ging / gegangen)', DE)).toMatchObject({ verdict: 'exact', expected: 'gehen' });
    expect(checkAnswer('gehen (ging / gegangen)', 'gehen (ging / gegangen)', DE).verdict).toBe('exact');
    expect(checkAnswer('Haus', 'Haus (n / pl)').verdict).toBe('exact');
    expect(checkAnswer('helfen', 'helfen (+ Dat.)', DE).verdict).toBe('exact');
    expect(checkAnswer('bank', 'bank (river)').verdict).toBe('exact');
    // A typo of the word is still 'close', against the word (not against the whole note).
    expect(checkAnswer('gehn', 'gehen (ging / gegangen)', DE)).toMatchObject({ verdict: 'close', reason: 'typo', expected: 'gehen' });
    // Another word is still wrong.
    expect(checkAnswer('ging', 'gehen (ging / gegangen)', DE).verdict).toBe('wrong');
    expect(checkAnswer('gegangen', 'gehen (ging / gegangen)', DE).verdict).toBe('wrong');
    // The German article rules still hold on the word without its note.
    expect(checkAnswer('Hund', 'der Hund (Pl. die Hunde)', { lang: 'de-DE', term: true })).toMatchObject({
      verdict: 'close',
      reason: 'article',
      expected: 'der Hund',
    });
    expect(checkAnswer('die Hund', 'der Hund (Pl. die Hunde)', { lang: 'de-DE', term: true }).verdict).toBe('wrong');
    // Both optional parts together: "(to) go (went / gone)" accepts "go", "to go" and "(to) go".
    for (const typed of ['go', 'to go', '(to) go']) {
      expect(checkAnswer(typed, '(to) go (went / gone)', { lang: 'en-US' }).verdict).toBe('exact');
    }
    // An alternative with a note: each part of the list keeps its own optional note.
    expect(checkAnswer('Heim', 'Haus (n / pl), Heim (n)').verdict).toBe('exact');
    expect(checkAnswer('Haus', 'Haus (n / pl), Heim (n)').verdict).toBe('exact');
  });

  it('a part in brackets with a digit or a sign is NOT a note: maths and numbers keep their one form', () => {
    expect(checkAnswer('x', 'x (mod 5)').verdict).toBe('wrong');
    expect(checkAnswer('1945', '1945 (1946)').verdict).toBe('wrong');
    expect(checkAnswer('a', 'a (= b)').verdict).toBe('wrong');
    // No space before the bracket: part of the word ("O(n)", "f(x)"), never a note.
    expect(checkAnswer('O', 'O(n)').verdict).toBe('wrong');
    expect(checkAnswer('f', 'f(x)').verdict).toBe('wrong');
    // Only a note: nothing before the brackets to type.
    expect(checkAnswer('', '(n / pl)').verdict).toBe('wrong');
  });
});

describe('checkAnswer: typo thresholds', () => {
  it('up to 6 letters: one edit is close, two are wrong', () => {
    expect(checkAnswer('Stunda', 'Stunde')).toMatchObject({ verdict: 'close', reason: 'typo' }); // 6 letters
    expect(checkAnswer('Stndea', 'Stunde').verdict).toBe('wrong'); // 2 edits
    expect(checkAnswer('Hau', 'Haus').verdict).toBe('close');
  });

  it('above 6 letters: two edits are close, three are wrong', () => {
    expect(checkAnswer('Abfart', 'Abfahrt').verdict).toBe('close'); // 7 letters, 1 edit
    expect(checkAnswer('Abfrt', 'Abfahrt').verdict).toBe('close'); // 2 edits
    expect(checkAnswer('Abrt', 'Abfahrt').verdict).toBe('wrong'); // 3 edits
  });

  it('spaces do not count as letters for the threshold', () => {
    // "to go" has 4 letters (≤ 6): 2 edits are too many.
    expect(checkAnswer('ta ga', 'to go').verdict).toBe('wrong');
    expect(checkAnswer('ta go', 'to go').verdict).toBe('close');
  });

  it('two letters swapped are ONE edit', () => {
    expect(checkAnswer('Abfhart', 'Abfahrt')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('dei', 'die').verdict).toBe('close');
  });

  it('a typo can never be the whole answer', () => {
    expect(checkAnswer('b', 'a').verdict).toBe('wrong');
    expect(checkAnswer('zi', 'zu').verdict).toBe('close');
  });

  it('a different word is wrong → Again', () => {
    expect(checkAnswer('Katze', 'Hund')).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
  });
});

describe('checkAnswer: German articles', () => {
  it('a missing article is close, and names the article', () => {
    const r = checkAnswer('Abfahrt', 'die Abfahrt', DE);
    expect(r).toMatchObject({
      verdict: 'close',
      suggested: 'hard',
      reason: 'article',
      expected: 'die Abfahrt',
      article: { article: 'die', word: 'Abfahrt' },
    });
    expect(ARTICLE_HINT_COPY).toBe('Almost — remember the article:');
  });

  it('works without case and with a typed lower-case noun', () => {
    expect(checkAnswer('abfahrt', 'Die Abfahrt', DE).reason).toBe('article');
  });

  // Adapted in W4-7 (lead decision): a wrong article on a LONG noun was a
  // 2-letter typo ('close', Hard). The gender is the point of the exercise,
  // so a wrong article is now 'wrong' (Again) for nouns of any length.
  it('a WRONG article is wrong (Again) for nouns of any length; a missing one stays close', () => {
    // Short nouns (the typo rule already said wrong).
    expect(checkAnswer('der Uhr', 'die Uhr', DE)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null, article: null });
    expect(checkAnswer('die Ei', 'das Ei', DE).verdict).toBe('wrong');
    expect(checkAnswer('die Tag', 'der Tag', DE).verdict).toBe('wrong');
    // Long nouns: 2 letters differ, which the typo rule alone calls 'close'.
    for (const [input, expected] of [
      ['der Abfahrt', 'die Abfahrt'],
      ['das Hund', 'der Hund'],
      ['der Haus', 'das Haus'],
      ['der Kartoffel', 'die Kartoffel'],
      ['DAS Kartoffel', 'Die Kartoffel'], // in any case
    ]) {
      expect(checkAnswer(input, expected, DE)).toMatchObject({ verdict: 'wrong', suggested: 'again', reason: null });
    }
    // The result shows the right form, and the diff marks the article.
    const r = checkAnswer('der Haus', 'das Haus', DE);
    expect(r.expected).toBe('das Haus');
    expect(r.diff.filter((p) => p.op !== 'same').map((p) => p.expected).join('')).toBe('as');
    // A missing article is still 'close', with the article line (spec §6.3).
    expect(checkAnswer('Haus', 'das Haus', DE)).toMatchObject({ verdict: 'close', reason: 'article', article: { article: 'das', word: 'Haus' } });
    // The right article is exact; a typo in the article ("dre") is a typo, not another article.
    expect(checkAnswer('das Haus', 'das Haus', DE).verdict).toBe('exact');
    expect(checkAnswer('dre Hund', 'der Hund', DE)).toMatchObject({ verdict: 'close', reason: 'typo' });
    // A plural marker: "der Eltern" for "die Eltern (Pl.)" is a wrong article too.
    expect(checkAnswer('der Eltern', 'die Eltern (Pl.)', DE).verdict).toBe('wrong');
    // "der/die Angestellte": either article is right, "das" is wrong.
    expect(checkAnswer('das Angestellte', 'der/die Angestellte', DE).verdict).toBe('wrong');
  });

  // W4-7 review round 2: the wrong-article rule only judged the ONE form it
  // compared, and a typo match on the plural form ranked better, so "die
  // Hund" for "der Hund, die Hunde" was close (Hard), compared with "die Hunde".
  it('a WRONG article stays wrong when the field also lists the plural', () => {
    const term = { lang: 'de-DE', term: true };
    for (const [input, expected, right] of [
      ['die Hund', 'der Hund, die Hunde', 'der Hund'],
      ['die Tag', 'der Tag, die Tage', 'der Tag'],
      ['die Kind', 'das Kind, die Kinder', 'das Kind'],
      ['die Jahr', 'das Jahr, die Jahre', 'das Jahr'],
    ]) {
      expect(checkAnswer(input, expected, term)).toMatchObject({
        verdict: 'wrong',
        suggested: 'again',
        reason: null,
        expected: right, // the result shows the singular with the right article
        article: null,
      });
    }
    // The plural and the singular, each with its own article, are exact.
    expect(checkAnswer('die Hunde', 'der Hund, die Hunde', term).verdict).toBe('exact');
    expect(checkAnswer('der Hund', 'der Hund, die Hunde', term).verdict).toBe('exact');
    // A typo in the plural (right article) is still a typo.
    expect(checkAnswer('die Hunte', 'der Hund, die Hunde', term)).toMatchObject({
      verdict: 'close',
      reason: 'typo',
      expected: 'die Hunde',
    });
    // A missing article on another form still beats the wrong article: close, with the hint.
    expect(checkAnswer('Hund', 'der Hund, die Hunde', term)).toMatchObject({
      verdict: 'close',
      reason: 'article',
      article: { article: 'der', word: 'Hund' },
    });
    // The session's call (checkTyped) gives the same result.
    const target: TypingTarget = { text: 'der Hund, die Hunde', lang: 'de-DE', role: 'term', multiline: false };
    expect(checkTyped('die Hund', target)).toMatchObject({ verdict: 'wrong', suggested: 'again' });
  });

  it('the wrong-article rule is a German TERM rule: no language, or not a term → the typo rule decides', () => {
    expect(checkAnswer('der Uhr', 'die Uhr').verdict).toBe('wrong'); // 2 edits on 6 letters
    expect(checkAnswer('der Abfahrt', 'die Abfahrt')).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('der Abfahrt', 'die Abfahrt', { lang: 'de-DE', term: false })).toMatchObject({ verdict: 'close', reason: 'typo' });
    const meaning: TypingTarget = { text: 'die Abfahrt', lang: 'de-DE', role: 'meaning', multiline: false };
    expect(checkTyped('der Abfahrt', meaning).verdict).toBe('close');
    const term: TypingTarget = { ...meaning, role: 'term' };
    expect(checkTyped('der Abfahrt', term)).toMatchObject({ verdict: 'wrong', suggested: 'again' });
  });

  it('the right article is exact', () => {
    expect(checkAnswer('die abfahrt', 'die Abfahrt', DE).verdict).toBe('exact');
  });

  it('only for German, and only for terms', () => {
    expect(checkAnswer('Abfahrt', 'die Abfahrt').verdict).toBe('wrong'); // no language
    expect(checkAnswer('Abfahrt', 'die Abfahrt', { lang: 'en-US' }).verdict).toBe('wrong');
    expect(checkAnswer('Abfahrt', 'die Abfahrt', { lang: 'de-DE', term: false }).verdict).toBe('wrong');
    expect(checkAnswer('Abfahrt', 'die Abfahrt', { lang: 'German' }).reason).toBe('article');
  });

  it('a "(Pl.)" marker never has to be typed', () => {
    expect(checkAnswer('die Eltern', 'die Eltern (Pl.)', DE).verdict).toBe('exact');
    expect(checkAnswer('Eltern', 'die Eltern (Pl.)', DE)).toMatchObject({
      reason: 'article',
      article: { article: 'die', word: 'Eltern' },
    });
  });

  it('a missing article on a "(Pl.)" term asks only for the article, never for the marker', () => {
    // The diff never marks " (Pl.)" as letters still to type.
    const r = checkAnswer('Eltern', 'die Eltern (Pl.)', DE);
    expect(r).toMatchObject({ verdict: 'close', reason: 'article', expected: 'die Eltern' });
    expect(r.diff).toEqual([
      { op: 'missing', typed: '', expected: 'die ' },
      { op: 'same', typed: 'Eltern', expected: 'Eltern' },
    ]);
    // The same for a "(Sg.)" marker.
    expect(checkAnswer('Internet', 'das Internet (Sg.)', DE)).toMatchObject({ reason: 'article', expected: 'das Internet' });
    // Typing the marker too is still exact.
    expect(checkAnswer('die Eltern (Pl.)', 'die Eltern (Pl.)', DE).verdict).toBe('exact');
    // Without a marker, the answer keeps its own case: "Die Abfahrt", not "die Abfahrt".
    expect(checkAnswer('Abfahrt', 'Die Abfahrt', DE).expected).toBe('Die Abfahrt');
  });

  it('"der/die Angestellte" accepts either article, never a bare "der"', () => {
    expect(checkAnswer('die Angestellte', 'der/die Angestellte', DE).verdict).toBe('exact');
    expect(checkAnswer('der Angestellte', 'der/die Angestellte', DE).verdict).toBe('exact');
    expect(checkAnswer('der', 'der/die Angestellte', DE).verdict).toBe('wrong');
    expect(checkAnswer('Angestellte', 'der/die Angestellte', DE).reason).toBe('article');
  });

  it('"der/die Angestellte, -n" (word-list notation) is split at , before the articles', () => {
    const expected = 'der/die Angestellte, -n';
    expect(checkAnswer('der Angestellte', expected, DE)).toMatchObject({ verdict: 'exact', expected: 'der Angestellte' });
    expect(checkAnswer('die Angestellte', expected, DE)).toMatchObject({ verdict: 'exact', expected: 'die Angestellte' });
    expect(checkAnswer('Angestellte', expected, DE)).toMatchObject({
      verdict: 'close',
      suggested: 'hard',
      reason: 'article',
      article: { article: 'der', word: 'Angestellte' },
    });
    expect(checkAnswer('der', expected, DE).verdict).toBe('wrong');
    expect(checkAnswer('-n', expected, DE).verdict).toBe('wrong');
    // The whole text still counts.
    expect(checkAnswer('der/die Angestellte, -n', expected, DE).verdict).toBe('exact');
  });

  it('answerAlternatives with the German language: "der/die X" gives both forms, never a bare article', () => {
    expect(answerAlternatives('der/die Angestellte', DE)).toEqual([
      'der/die Angestellte',
      'der Angestellte',
      'die Angestellte',
    ]);
    expect(answerAlternatives('der/die Angestellte, -n', DE)).toEqual([
      'der/die Angestellte, -n',
      'der Angestellte',
      'die Angestellte',
    ]);
    // An article written after the word is a note about the word, not an answer.
    expect(answerAlternatives('Abfahrt, die', DE)).toEqual(['Abfahrt, die', 'Abfahrt']);
    expect(checkAnswer('die', 'Abfahrt, die', DE).verdict).toBe('wrong');
    expect(checkAnswer('Abfahrt', 'Abfahrt, die', DE).verdict).toBe('exact');
    // Only articles (a grammar card): then they ARE the answer.
    expect(answerAlternatives('der, die, das', DE)).toEqual(['der, die, das', 'der', 'die', 'das']);
    // Without a language, the German rules do not apply (spec §9.1: keyed by the field's language).
    expect(answerAlternatives('der/die Angestellte')).toEqual(['der/die Angestellte', 'der', 'die Angestellte']);
  });

  it('the German alternatives apply to every German field, the missing-article rule only to terms', () => {
    const meaning = { lang: 'de-DE', term: false };
    expect(checkAnswer('der', 'der/die Angestellte', meaning).verdict).toBe('wrong');
    expect(checkAnswer('die Angestellte', 'der/die Angestellte', meaning).verdict).toBe('exact');
    expect(checkAnswer('Angestellte', 'der/die Angestellte', meaning).verdict).toBe('wrong');
  });

  it('German alternatives split at , ; and / like any other answer', () => {
    expect(checkAnswer('die Ausfahrt', 'die Abfahrt; die Ausfahrt', DE).verdict).toBe('exact');
    expect(checkAnswer('das Auto', 'der Wagen/das Auto', DE).verdict).toBe('exact');
    expect(checkAnswer('Auto', 'der Wagen/das Auto, -s', DE)).toMatchObject({ verdict: 'close', reason: 'article' });
  });

  it('two mistakes (no article and a typo) are wrong', () => {
    expect(checkAnswer('Abfart', 'die Abfahrt', DE).verdict).toBe('wrong');
  });

  it('a missing umlaut on the bare noun is still an article hint (close)', () => {
    expect(checkAnswer('Arger', 'der Ärger', DE)).toMatchObject({ verdict: 'close', reason: 'article' });
  });
});

// Wave 5b (L5): "sleep" for "to sleep / the sleep" was "Not quite" (3 edits).
// A missing English "to", "the", "a" or "an" is close, like the German article.
describe('checkAnswer: English little words (rule 6b)', () => {
  const EN = { lang: 'en-US' };

  it('a missing "to", "the", "a" or "an" is close, and names the word', () => {
    expect(checkAnswer('sleep', 'to sleep / the sleep', EN)).toMatchObject({
      verdict: 'close',
      suggested: 'hard',
      reason: 'article',
      expected: 'to sleep',
      article: { article: 'to', word: 'sleep' },
    });
    expect(checkAnswer('hour', 'the hour', EN)).toMatchObject({ verdict: 'close', article: { article: 'the', word: 'hour' } });
    expect(checkAnswer('dog', 'a dog', EN)).toMatchObject({ verdict: 'close', article: { article: 'a', word: 'dog' } });
    expect(checkAnswer('apple', 'an apple', EN)).toMatchObject({ verdict: 'close', article: { article: 'an', word: 'apple' } });
    // Case and the field's own case do not matter; the little word is named in lower case.
    expect(checkAnswer('Go Out', 'To go out', EN)).toMatchObject({ verdict: 'close', article: { article: 'to', word: 'go out' } });
  });

  it('the right form is exact; a typo AND a missing word is wrong (like German)', () => {
    expect(checkAnswer('to sleep', 'to sleep / the sleep', EN).verdict).toBe('exact');
    expect(checkAnswer('the sleep', 'to sleep / the sleep', EN).verdict).toBe('exact');
    expect(checkAnswer('slep', 'to sleep', EN).verdict).toBe('wrong');
    // A different little word is no gender mistake: the typo rule decides, as before.
    expect(checkAnswer('a hour', 'the hour', EN).verdict).toBe(checkAnswer('a hour', 'the hour').verdict);
  });

  it('only for English words: no language, another language or an example sentence → no rule', () => {
    expect(checkAnswer('sleep', 'to sleep').verdict).toBe('wrong'); // the language is unknown
    expect(checkAnswer('sleep', 'to sleep', { lang: 'fr-FR' }).verdict).toBe('wrong');
    expect(checkAnswer('sleep', 'to sleep', { ...EN, word: false }).verdict).toBe('wrong');
    // "to" alone, or a word that only starts with the letters ("tomato", "anchor"), is no little word.
    expect(checkAnswer('mato', 'tomato', EN).verdict).toBe('wrong');
    expect(checkAnswer('chor', 'anchor', EN).verdict).toBe('wrong');
  });

  // Wave 5c (L5): many word lists write the little word that may be left
  // out in BRACKETS: "(to) go", "(the) news". Only the plain form worked:
  // "go" for "(to) go" was "Not quite" (Again).
  it('an optional leading part in brackets is optional: "(to) go" accepts "go" and "to go"', () => {
    expect(checkAnswer('go', '(to) go', EN)).toMatchObject({ verdict: 'exact', suggested: 'good', reason: null });
    expect(checkAnswer('to go', '(to) go', EN).verdict).toBe('exact');
    expect(checkAnswer('(to) go', '(to) go', EN).verdict).toBe('exact');
    expect(checkAnswer('news', '(the) news', EN).verdict).toBe('exact');
    expect(checkAnswer('Sleep', '(to) sleep, (to) rest', EN).verdict).toBe('exact');
    expect(checkAnswer('rest', '(to) sleep, (to) rest', EN).verdict).toBe('exact');
    // The brackets say it in any language, also when the language is unknown.
    expect(checkAnswer('freuen', '(sich) freuen', DE).verdict).toBe('exact');
    expect(checkAnswer('go', '(to) go').verdict).toBe('exact');
    expect(checkTyped('go', { text: '(to) go', lang: 'en-US', role: 'example', multiline: false }).verdict).toBe('exact');
    // A typo in the word is still a typo; another word is still wrong.
    expect(checkAnswer('slep', '(to) sleep', EN)).toMatchObject({ verdict: 'close', reason: 'typo' });
    expect(checkAnswer('eat', '(to) go', EN).verdict).toBe('wrong');
    // German: the article in brackets is optional, but a WRONG article is still wrong (rule 6).
    expect(checkAnswer('Hund', '(der) Hund', DE).verdict).toBe('exact');
    expect(checkAnswer('der Hund', '(der) Hund', DE).verdict).toBe('exact');
    expect(checkAnswer('die Hund', '(der) Hund', DE).verdict).toBe('wrong');
  });

  // Wave 5c, review round 1: the word alone ("Eltern (Pl.)") kept its plural
  // marker, so a typed "Eltern" matched only "die Eltern" and was 'close'
  // ("remember the article"), although the brackets make the article optional.
  it('"(die) Eltern (Pl.)": the bare word is exact, like "Hund" for "(der) Hund"', () => {
    expect(checkAnswer('Eltern', '(die) Eltern (Pl.)', DE)).toMatchObject({ verdict: 'exact', reason: null, article: null });
    expect(checkAnswer('die Eltern', '(die) Eltern (Pl.)', DE).verdict).toBe('exact');
    expect(checkAnswer('Eltern (Pl.)', '(die) Eltern (Pl.)', DE).verdict).toBe('exact');
    // A WRONG article is still wrong (rule 6), and a typo is still a typo.
    expect(checkAnswer('der Eltern', '(die) Eltern (Pl.)', DE).verdict).toBe('wrong');
    expect(checkAnswer('Eltrn', '(die) Eltern (Pl.)', DE)).toMatchObject({ verdict: 'close', reason: 'typo' });
    // The marker stays only optional for the German rule: without brackets the article is still asked for.
    expect(checkAnswer('Eltern', 'die Eltern (Pl.)', DE)).toMatchObject({ verdict: 'close', reason: 'article' });
  });

  // Wave 5c, review round 2: the "/" INSIDE the brackets split the answer,
  // into the broken parts "(der" and "die) Angestellte". So "Angestellte" was
  // 'wrong', "der Angestellte" only 'close', and the screen showed
  // "die) Angestellte" as the expected answer.
  it('a choice in the optional brackets: "(der/die) Angestellte" and "(he/she) goes"', () => {
    // German: each article of the choice, or none (the brackets make it optional).
    expect(answerAlternatives('(der/die) Angestellte', DE)).toEqual(['(der/die) Angestellte']);
    expect(checkAnswer('Angestellte', '(der/die) Angestellte', DE)).toMatchObject({ verdict: 'exact', reason: null });
    expect(checkAnswer('der Angestellte', '(der/die) Angestellte', DE).verdict).toBe('exact');
    expect(checkAnswer('die Angestellte', '(der/die) Angestellte', DE).verdict).toBe('exact');
    expect(checkAnswer('der/die Angestellte', '(der/die) Angestellte', DE).verdict).toBe('exact');
    // An article that is not in the choice is a WRONG article (rule 6), and a typo is still a typo.
    expect(checkAnswer('das Angestellte', '(der/die) Angestellte', DE).verdict).toBe('wrong');
    expect(checkAnswer('Angestelte', '(der/die) Angestellte', DE)).toMatchObject({ verdict: 'close', reason: 'typo' });
    // The expected answer on the screen is never a broken part.
    expect(checkAnswer('Hund', '(der/die) Angestellte', DE).expected).not.toContain(')');
    // A plural note after it is still not an answer.
    expect(answerAlternatives('(der/die) Angestellte, -n', DE)).toEqual(['(der/die) Angestellte, -n', '(der/die) Angestellte']);
    expect(checkAnswer('Angestellte', '(der/die) Angestellte, -n', DE).verdict).toBe('exact');
    // English: the same.
    expect(answerAlternatives('(he/she) goes')).toEqual(['(he/she) goes']);
    expect(checkAnswer('goes', '(he/she) goes', EN)).toMatchObject({ verdict: 'exact', reason: null });
    expect(checkAnswer('she goes', '(he/she) goes', EN).verdict).toBe('exact');
    expect(checkAnswer('he goes', '(he/she) goes', EN).verdict).toBe('exact');
    expect(checkAnswer('go', '(he/she) goes', EN).expected).toBe('goes');
    // A separator AFTER the brackets still splits the alternatives; one inside them never does.
    expect(answerAlternatives('(he/she) goes / (it) is')).toEqual(['(he/she) goes / (it) is', '(he/she) goes', '(it) is']);
    expect(checkAnswer('is', '(he/she) goes / (it) is', EN).verdict).toBe('exact');
    // Each piece may start with its own brackets.
    expect(answerAlternatives('(to) go, (he/she) goes')).toEqual(['(to) go, (he/she) goes', '(to) go', '(he/she) goes']);
    expect(checkAnswer('goes', '(to) go, (he/she) goes', EN).verdict).toBe('exact');
    expect(answerAlternatives('(a, b) c')).toEqual(['(a, b) c']);
    // A choice with a part that is not a word keeps its one form.
    expect(checkAnswer('x', '(a/1) x').verdict).toBe('wrong');
  });

  it('only words in the brackets: maths and numbering keep their one form', () => {
    expect(checkAnswer('x 4', '(2+3) x 4').verdict).toBe('wrong');
    expect(checkAnswer('5', '(1) 5').verdict).toBe('wrong');
    expect(checkAnswer('go', '(to)go', EN).verdict).toBe('wrong'); // no space: not a separate part
    // The list that hints and quizzes read is unchanged.
    expect(answerAlternatives('(to) go')).toEqual(['(to) go']);
  });

  it('the line under the answer: "to" is not an article, so it has its own words', () => {
    expect(TO_HINT_COPY).toBe('Almost — remember the “to”:');
    expect(leadHintCopy('to')).toBe(TO_HINT_COPY);
    expect(leadHintCopy('the')).toBe(ARTICLE_HINT_COPY);
    expect(leadHintCopy('die')).toBe(ARTICLE_HINT_COPY);
  });

  it('checkTyped: the rule follows the field role (term and meaning are words; an example is not)', () => {
    const target = (role: TypingTarget['role']): TypingTarget => ({ text: 'to sleep / the sleep', lang: 'en-US', role, multiline: false });
    expect(checkTyped('sleep', target('meaning'))).toMatchObject({ verdict: 'close', reason: 'article', article: { article: 'to' } });
    expect(checkTyped('sleep', target('term'))).toMatchObject({ verdict: 'close', reason: 'article' });
    for (const role of ['example', 'exampleMeaning', null] as const) {
      expect(checkTyped('sleep', target(role))).toMatchObject({ verdict: 'wrong', article: null });
    }
    // The German rules are unchanged: an English term never gets the German wrong-article rule.
    expect(checkTyped('die sleep', target('term')).verdict).not.toBe('exact');
  });
});

describe('letter diff', () => {
  it('marks a missing letter', () => {
    expect(checkAnswer('Abfart', 'Abfahrt').diff).toEqual([
      { op: 'same', typed: 'Abfa', expected: 'Abfa' },
      { op: 'missing', typed: '', expected: 'h' },
      { op: 'same', typed: 'rt', expected: 'rt' },
    ]);
  });

  it('marks an extra letter, a changed letter and a swap', () => {
    expect(letterDiff('Hxause', 'Hause')).toEqual([
      { op: 'same', typed: 'H', expected: 'H' },
      { op: 'extra', typed: 'x', expected: '' },
      { op: 'same', typed: 'ause', expected: 'ause' },
    ]);
    expect(letterDiff('uber', 'über')).toEqual([
      { op: 'change', typed: 'u', expected: 'ü' },
      { op: 'same', typed: 'ber', expected: 'ber' },
    ]);
    expect(letterDiff('Abfhart', 'Abfahrt')).toEqual([
      { op: 'same', typed: 'Abf', expected: 'Abf' },
      { op: 'change', typed: 'ha', expected: 'ah' },
      { op: 'same', typed: 'rt', expected: 'rt' },
    ]);
  });

  it('a missing article shows as missing letters of the full form', () => {
    expect(checkAnswer('Abfahrt', 'die Abfahrt', DE).diff).toEqual([
      { op: 'missing', typed: '', expected: 'die ' },
      { op: 'same', typed: 'Abfahrt', expected: 'Abfahrt' },
    ]);
  });

  it('case differences are "same"; an exact answer is one "same" piece', () => {
    expect(letterDiff('HAUS', 'Haus')).toEqual([{ op: 'same', typed: 'HAUS', expected: 'Haus' }]);
    expect(checkAnswer('Strasse', 'Straße').diff).toEqual([{ op: 'same', typed: 'Strasse', expected: 'Straße' }]);
  });

  it('the diff pieces put back together give the typed text and the expected text', () => {
    const r = checkAnswer('Abfhrtt', 'die Abfahrt');
    expect(r.diff.map((p) => p.typed).join('')).toBe('Abfhrtt');
    expect(r.diff.map((p) => p.expected).join('')).toBe(r.expected);
  });

  it('a very long text is not aligned letter by letter', () => {
    const long = 'a'.repeat(500);
    expect(letterDiff(long, 'b')).toEqual([{ op: 'change', typed: long, expected: 'b' }]);
    expect(checkAnswer(long, 'a'.repeat(499) + 'b').verdict).toBe('wrong');
  });
});

describe('long answers fall back to Flashcards', () => {
  const target = (text: string, multiline = false) => ({ text, role: 'meaning' as const, multiline });

  it('at most 60 characters, one line, some text', () => {
    expect(TYPING_MAX_CHARS).toBe(60);
    expect(isTypeable(target('x'.repeat(60)))).toBe(true);
    expect(isTypeable(target('x'.repeat(61)))).toBe(false);
    expect(isTypeable(target('ich bin du bist', true))).toBe(false);
    expect(isTypeable(target(''))).toBe(false);
    expect(isTypeable(target(' ?! '))).toBe(false);
    expect(isTypeable(null)).toBe(false);
    expect(LONG_ANSWER_COPY).toBe('Long answer — flip instead');
  });
});

describe('typingTarget', () => {
  it('is the answer headline by default (Basic: Back)', () => {
    const type = builtinType('basic', FIXED_NOW);
    const note = makeNoteV3({ typeId: type.id, fields: ['die Stunde', 'the hour', 'Eine Stunde.', ''] });
    expect(typingTarget(renderFace(note, type, 0), type, 0)).toEqual({
      text: 'the hour',
      role: 'meaning',
      multiline: false,
    });
  });

  it('has the field language and the line breaks of the field', () => {
    const type = builtinType('legacyVocabDe', FIXED_NOW);
    const note = makeNoteV3({
      typeId: type.id,
      fields: ['sein', 'to be<br>ich bin', '', '', '', '', '', '', '', ''],
    });
    const t = typingTarget(renderFace(note, type, 0), type, 0);
    expect(t).toMatchObject({ lang: 'en-US', role: 'meaning', multiline: true });
    expect(isTypeable(t)).toBe(false);
  });

  it("is the template's typing field when it has one ({{type:Field}})", () => {
    const base = builtinType('basicReverse', FIXED_NOW);
    // The reverse direction types the German word (field 0), not the first answer block.
    const type: NoteType = {
      ...base,
      id: 'nt-typed',
      fields: base.fields.map((f, i) => (i === 0 ? { ...f, lang: 'de-DE' } : f)),
      templates: [base.templates[0], { ...base.templates[1], answer: [2, 0, 3], typeField: 0 }],
    };
    const note = makeNoteV3({ typeId: type.id, fields: ['die Stunde', 'the hour', 'Eine Stunde.', ''] });
    const t = typingTarget(renderFace(note, type, 1), type, 1);
    expect(t).toEqual({ text: 'die Stunde', lang: 'de-DE', role: 'term', multiline: false });
  });

  it('a dictation card types the word of its speaker block', () => {
    const type: NoteType = {
      ...builtinType('basic', FIXED_NOW),
      id: 'nt-dictation',
      fields: [
        { name: 'Word', role: 'term', facet: 'off', lang: 'de-DE' },
        { name: 'Meaning', role: 'meaning', facet: 'off' },
      ],
      templates: [{ ord: 0, name: 'Listen', prompt: [], answer: [1], typeField: 0 }],
    };
    const note = makeNoteV3({ typeId: type.id, fields: ['die Stunde', 'the hour'] });
    expect(typingTarget(renderFace(note, type, 0), type, 0)).toMatchObject({ text: 'die Stunde', lang: 'de-DE' });
  });

  it('a cloze card types the text of its deletion', () => {
    const type = builtinType('cloze', FIXED_NOW);
    const note = makeNoteV3({ typeId: BUILTIN_TYPE_IDS.cloze, fields: ['The capital is {{c1::Paris}}.', ''] });
    expect(typingTarget(renderFace(note, type, 0), type, 0)).toMatchObject({ text: 'Paris', multiline: false });
  });

  it('null when the face has no answer block', () => {
    const type = builtinType('basic', FIXED_NOW);
    const note = makeNoteV3({ typeId: type.id, fields: ['front only', '', '', ''] });
    expect(typingTarget(renderFace(note, type, 0), type, 0)).toBeNull();
  });
});

describe('checkTyped: the article rule follows the field role (spec §9.2)', () => {
  const target = (role: TypingTarget['role']): TypingTarget => ({ text: 'die Stunde', lang: 'de-DE', role, multiline: false });

  it('a German TERM target: a missing article is close', () => {
    expect(checkTyped('Stunde', target('term'))).toMatchObject({
      verdict: 'close',
      reason: 'article',
      article: { article: 'die', word: 'Stunde' },
    });
    expect(checkTyped('die Stunde', target('term')).verdict).toBe('exact');
  });

  it('a German meaning, example or unknown field: no article rule', () => {
    for (const role of ['meaning', 'example', null] as const) {
      expect(checkTyped('Stunde', target(role))).toMatchObject({ verdict: 'wrong', reason: null, article: null });
      expect(checkTyped('die Stunde', target(role)).verdict).toBe('exact');
    }
  });

  it('a Basic card whose Back is German (deck meaning language de-DE) types its meaning without the article rule', () => {
    const type = builtinType('basic', FIXED_NOW);
    const note = makeNoteV3({ typeId: type.id, fields: ['the hour', 'die Stunde', '', ''] });
    const face = renderFace(note, type, 0, { language: 'en-US', meaningLanguage: 'de-DE' });
    const t = typingTarget(face, type, 0)!;
    expect(t).toEqual({ text: 'die Stunde', lang: 'de-DE', role: 'meaning', multiline: false });
    expect(checkTyped('Stunde', t).verdict).toBe('wrong');
    expect(checkTyped('die Stunde', t).verdict).toBe('exact');
  });

  it('a German term target from a typing field ({{type:Field}}) keeps the article rule', () => {
    const base = builtinType('basicReverse', FIXED_NOW);
    const type: NoteType = {
      ...base,
      id: 'nt-typed-de',
      fields: base.fields.map((f, i) => (i === 0 ? { ...f, lang: 'de-DE' } : f)),
      templates: [base.templates[0], { ...base.templates[1], typeField: 0 }],
    };
    const note = makeNoteV3({ typeId: type.id, fields: ['die Stunde', 'the hour', '', ''] });
    const t = typingTarget(renderFace(note, type, 1), type, 1)!;
    expect(t.role).toBe('term');
    expect(checkTyped('Stunde', t).reason).toBe('article');
  });
});
