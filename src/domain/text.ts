/**
 * Small, pure text helpers shared by search, import and the screens
 * (spec §4.4 "Folding", §8.11 copy sweep).
 *
 *   foldText("Über Straße") → "uber strasse"   (search that ignores case and accents)
 *   plural(1, 'deck')       → "1 deck"
 *   plural(1240, 'card')    → "1,240 cards"
 *   oneLine("a\n  b ")      → "a b"
 *
 * Constraints: no React, no I/O. Hermes-safe: no `String.prototype.normalize`
 * (Hermes builds without full ICU do not have it) and no `replaceAll`.
 * Linear time: every helper scans its input once.
 */

/**
 * Accented Latin letters → plain ASCII letters. Only LOWER-case keys:
 * foldText lower-cases first, so 'Ü' becomes 'ü' and then 'u'.
 * Covers Latin-1 Supplement and Latin Extended-A (German, Spanish, French,
 * Italian, Portuguese, Polish, Czech, Turkish, Nordic …).
 */
const FOLD: Record<string, string> = {};

/** Add one entry per character of `chars`, all folding to `to`. */
function addFold(chars: string, to: string): void {
  for (const ch of chars) FOLD[ch] = to;
}

addFold('àáâãäåāăąǎ', 'a');
addFold('æ', 'ae');
addFold('çćĉċč', 'c');
addFold('ďđð', 'd');
addFold('èéêëēĕėęě', 'e');
addFold('ĝğġģ', 'g');
addFold('ĥħ', 'h');
addFold('ìíîïĩīĭįıǐ', 'i');
addFold('ĳ', 'ij');
addFold('ĵ', 'j');
addFold('ķ', 'k');
addFold('ĺļľŀł', 'l');
addFold('ñńņňŉ', 'n');
addFold('òóôõöøōŏőǒ', 'o');
addFold('œ', 'oe');
addFold('ŕŗř', 'r');
addFold('śŝşšș', 's');
addFold('ß', 'ss');
addFold('ţťŧț', 't');
addFold('þ', 'th');
addFold('ùúûüũūŭůűųǔ', 'u');
addFold('ŵ', 'w');
addFold('ýÿŷ', 'y');
addFold('źżž', 'z');

/**
 * Every character that is not plain ASCII (code unit U+0080 or higher). The
 * replace callback runs only for these, so ASCII text (most of it) costs
 * almost nothing. A character outside the BMP (an emoji) is two code units;
 * each one has no entry and is returned unchanged.
 */
const NON_ASCII = /[\u0080-\uFFFF]/g;

/** Unicode "combining" accent marks (U+0300–U+036F), used by decomposed text. */
const COMBINING_MARK = /[\u0300-\u036F]/;

/**
 * Fold text for search and comparison: lower case, and accents removed.
 *
 *   foldText('Über Straße') → 'uber strasse'
 *   foldText('Árbol')       → 'arbol'
 *   foldText('Привет')      → 'привет'   (non-Latin letters are only lower-cased)
 *
 * It also handles DECOMPOSED text (a letter followed by a separate accent
 * mark, as macOS and some Anki decks store it): the accent mark is dropped,
 * so 'u' + U+0308 folds to 'u' like 'ü' does.
 *
 * Moved here from importFile.ts (its old `foldAscii`), so search, import
 * and later the library index all fold text the same way.
 */
export function foldText(s: string): string {
  if (!s) return '';
  return s.toLowerCase().replace(NON_ASCII, (ch) => {
    const folded = FOLD[ch];
    if (folded !== undefined) return folded;
    return COMBINING_MARK.test(ch) ? '' : ch;
  });
}

/**
 * The count and the right word form, for UI copy.
 *
 *   plural(0, 'card')                 → '0 cards'
 *   plural(1, 'card')                 → '1 card'
 *   plural(1240, 'card')              → '1,240 cards'
 *   plural(2, 'child', 'children')    → '2 children'
 *
 * `many` defaults to `one + 's'`. Only exactly 1 uses the singular (English
 * rule). The number gets thousands separators ('en-US'), like the rest of the app.
 */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * Text on one line: every run of white space (spaces, tabs, line breaks)
 * becomes one space, and the ends are trimmed. For rows, snackbars and
 * screen-reader labels.
 *
 *   oneLine('ich bin\ndu bist ') → 'ich bin du bist'
 */
export function oneLine(s: string): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim();
}
