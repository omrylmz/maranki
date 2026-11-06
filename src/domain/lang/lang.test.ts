/**
 * Language helpers (spec §9.2, unit W2-3): BCP-47 tags, German articles and
 * the per-language term helpers.
 */
import { describe, expect, it } from '@jest/globals';

import { ankiFixture } from '../../test/factories';
import {
  COMMON_LANGS,
  germanArticleSpan,
  germanSortKey,
  isArticleQuizCard,
  langLabel,
  mergeLangs,
  normalizeLang,
  primary,
  splitGermanArticle,
  termHelpers,
} from './index';

describe('normalizeLang', () => {
  it.each([
    ['de_DE', 'de-DE'], // Anki {{tts de_DE:Word}}
    ['de', 'de-DE'], // a bare language gets its usual region
    ['German', 'de-DE'],
    ['german', 'de-DE'],
    ['Deutsch', 'de-DE'],
    ['  es_ES ', 'es-ES'],
    ['DE-de', 'de-DE'],
    ['en_us', 'en-US'],
    ['en', 'en-US'],
    ['Español', 'es-ES'],
    ['Français', 'fr-FR'],
    ['English (UK)', 'en-GB'],
    ['Portuguese (Portugal)', 'pt-PT'],
    ['deu', 'de-DE'], // ISO 639-2 code
    ['eng', 'en-US'],
    ['no', 'nb-NO'], // Norwegian → Bokmål, as phones name the voice
    ['iw', 'he-IL'], // the old Hebrew code
    ['zh-hant-tw', 'zh-Hant-TW'], // script Title case, region upper case
    ['es-419', 'es-419'],
    ['xx-YY', 'xx-YY'], // well-formed but unknown: kept as it is
    ['xx', 'xx'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeLang(input)).toBe(expected);
  });

  it.each([[''], ['   '], ['Klingon'], ['12'], [null], [undefined]])('%j → null', (input) => {
    expect(normalizeLang(input)).toBeNull();
  });

  it('is idempotent', () => {
    for (const tag of [...COMMON_LANGS, 'zh-Hant-TW', 'es-419']) {
      expect(normalizeLang(normalizeLang(tag))).toBe(normalizeLang(tag));
    }
  });
});

describe('primary and langLabel', () => {
  it('primary is the lower-case language part', () => {
    expect(primary('de-DE')).toBe('de');
    expect(primary('de_AT')).toBe('de');
    expect(primary('German')).toBe('de');
    expect(primary('EN-gb')).toBe('en');
    expect(primary('')).toBe('');
    expect(primary(undefined)).toBe('');
  });

  it.each([
    ['de-DE', 'German'],
    ['de_DE', 'German'],
    ['en-US', 'English'],
    ['en-GB', 'English (UK)'],
    ['pt-PT', 'Portuguese (Portugal)'],
    ['es-MX', 'Spanish (Mexico)'],
    ['en-NZ', 'English (NZ)'], // a region without a name shows its code
    ['zh-Hant-TW', 'Chinese (Traditional, Taiwan)'],
    ['xx-YY', 'xx-YY'],
  ])('langLabel(%j) → %j', (tag, label) => {
    expect(langLabel(tag)).toBe(label);
  });

  it('every label reads back to its tag (pickers can store the label safely)', () => {
    for (const tag of COMMON_LANGS) expect(normalizeLang(langLabel(tag))).toBe(tag);
  });
});

describe('COMMON_LANGS and mergeLangs', () => {
  it('COMMON_LANGS holds clean, unique tags with a known language', () => {
    expect(new Set(COMMON_LANGS).size).toBe(COMMON_LANGS.length);
    for (const tag of COMMON_LANGS) {
      expect(normalizeLang(tag)).toBe(tag);
      expect(langLabel(tag)).not.toBe(tag);
    }
  });

  it('merges the static list with phone voices: normalized, unique, sorted by label', () => {
    const voices = ['de_DE', 'de-DE', 'en-AU', 'not a language', 'ja-JP'];
    const merged = mergeLangs(['de-DE', 'en-US'], voices);
    expect(merged).toEqual(['en-US', 'en-AU', 'de-DE', 'ja-JP']);
    expect(merged.map(langLabel)).toEqual(['English', 'English (Australia)', 'German', 'Japanese']);
  });
});

describe('splitGermanArticle', () => {
  it.each([
    ['die Abfahrt', { article: 'die', rest: 'Abfahrt', gender: 'f' }],
    ['der Tisch', { article: 'der', rest: 'Tisch', gender: 'm' }],
    ['das Ufer', { article: 'das', rest: 'Ufer', gender: 'n' }],
    ['Die Abfahrt', { article: 'die', rest: 'Abfahrt', gender: 'f' }], // the article ignores case
    ['  der   Mensch  ', { article: 'der', rest: 'Mensch', gender: 'm' }],
    ['der/die Angestellte', { article: null, rest: 'Angestellte', gender: null }],
    ['der / die Verwandte', { article: null, rest: 'Verwandte', gender: null }],
    ['Ufer', { article: null, rest: 'Ufer', gender: null }],
    ['die Eltern (Pl.)', { article: 'die', rest: 'Eltern', gender: 'pl' }],
    ['die Leute (pl)', { article: 'die', rest: 'Leute', gender: 'pl' }],
    ['Ferien (Plural)', { article: null, rest: 'Ferien', gender: 'pl' }],
    ['die Kosten (nur Pl.)', { article: 'die', rest: 'Kosten', gender: 'pl' }],
    // A singular-only marker is left out of the word; the gender stays the article's.
    ['das Internet (Sg.)', { article: 'das', rest: 'Internet', gender: 'n' }],
    ['der Reis (sg)', { article: 'der', rest: 'Reis', gender: 'm' }],
    ['die Milch (nur Sg.)', { article: 'die', rest: 'Milch', gender: 'f' }],
    ['Obst (Singular)', { article: null, rest: 'Obst', gender: null }],
    ['das Bad', { article: 'das', rest: 'Bad', gender: 'n' }],
    ['die Lampe', { article: 'die', rest: 'Lampe', gender: 'f' }],
    ['das Übel', { article: 'das', rest: 'Übel', gender: 'n' }], // capital umlaut
  ])('%j', (term, expected) => {
    expect(splitGermanArticle(term)).toEqual(expected);
  });

  it.each([
    ['das heißt'], // a phrase: no noun after the article
    ['die beiden'],
    ['dass'],
    ['die'],
    ['diese Woche'],
  ])('%j has no article (German nouns start with a capital letter)', (term) => {
    expect(splitGermanArticle(term).article).toBeNull();
  });

  it('empty text gives empty parts', () => {
    expect(splitGermanArticle('')).toEqual({ article: null, rest: '', gender: null });
    expect(splitGermanArticle('   ')).toEqual({ article: null, rest: '', gender: null });
  });

  it.each([
    // White space around the marker (and inside it) does not matter.
    ['die Eltern   (Pl.)   ', { article: 'die', rest: 'Eltern', gender: 'pl' }],
    ['die Eltern(Pl.)', { article: 'die', rest: 'Eltern', gender: 'pl' }],
    ['die Kosten ( nur  Pl. )', { article: 'die', rest: 'Kosten', gender: 'pl' }],
    ['das Internet\t(Sg.)\n', { article: 'das', rest: 'Internet', gender: 'n' }],
    // Only the LAST "(…)" can be a marker; other brackets stay in the word.
    ['die Bank (Geld) (Pl.)', { article: 'die', rest: 'Bank (Geld)', gender: 'pl' }],
    ['die Bank (Geld)', { article: 'die', rest: 'Bank (Geld)', gender: 'f' }],
    ['die Leute (Pl.) x', { article: 'die', rest: 'Leute (Pl.) x', gender: 'f' }],
    ['die Leute ((Pl.))', { article: 'die', rest: 'Leute ((Pl.))', gender: 'f' }],
  ])('marker %j', (term, expected) => {
    expect(splitGermanArticle(term)).toEqual(expected);
  });

  describe('linear time (a long run of spaces can never freeze the app)', () => {
    const time = (fn: () => void): number => {
      const start = Date.now();
      fn();
      return Date.now() - start;
    };
    const spaces = ' '.repeat(40_000);

    it.each([
      ['spaces inside the term', `die Abfahrt${spaces}x`],
      ['spaces before a marker', `die Eltern${spaces}(Pl.)`],
      ['spaces inside a marker', `die Eltern (${spaces}pl${spaces})`],
      ['spaces inside brackets that are no marker', `die Eltern (${spaces}x)`],
      ['spaces at both ends', `${spaces}die Abfahrt${spaces}`],
      ['many "("', `die Abfahrt ${'('.repeat(40_000)})`],
      ['spaces after an article (no noun)', `der${spaces}`],
    ])('%s in < 100 ms (split, span, quiz and decorate)', (_label, input) => {
      splitGermanArticle('die Abfahrt'); // warm up
      expect(time(() => splitGermanArticle(input))).toBeLessThan(100);
      expect(time(() => germanArticleSpan(input))).toBeLessThan(100);
      expect(time(() => isArticleQuizCard(input))).toBeLessThan(100);
      expect(time(() => termHelpers('de-DE').decorate(input))).toBeLessThan(100);
    });

    it('the results on such input are still right', () => {
      expect(splitGermanArticle(`die Abfahrt${spaces}x`)).toEqual({ article: 'die', rest: `Abfahrt${spaces}x`, gender: 'f' });
      expect(splitGermanArticle(`die Eltern${spaces}(Pl.)`)).toEqual({ article: 'die', rest: 'Eltern', gender: 'pl' });
      expect(germanArticleSpan(`${spaces}die Abfahrt`)).toEqual({ start: 40_000, end: 40_003, gender: 'f' });
    });
  });

  it('finds the article on the German Vocabulary fixture words', () => {
    const fx = ankiFixture('german_vocabulary');
    const words = fx.notes.map((n) => n.flds.split('\x1f')[0]);
    const nouns = words.filter((w) => splitGermanArticle(w).article !== null);
    expect(nouns.length).toBeGreaterThan(5);
    expect(splitGermanArticle('der Mensch')).toEqual({ article: 'der', rest: 'Mensch', gender: 'm' });
    for (const w of words) {
      const parts = splitGermanArticle(w);
      // A word with an article always has a rest that starts with a capital letter.
      if (parts.article) expect(parts.rest.charAt(0)).toBe(parts.rest.charAt(0).toUpperCase());
      // No "(Sg.)" / "(Pl.)" marker is left in the bare word (A–Z key, Articles practice).
      expect(parts.rest).not.toMatch(/\((?:nur\s+)?(?:sg|pl)/i);
    }
    // The singular-only words of the deck's FIRST version ("(Sg.)" in the word):
    // version 2 has none, but a learner who added version 1 still has them.
    const v1Words = ankiFixture('german_vocabulary_v1').notes.map((n) => n.flds.split('\x1f')[0]);
    expect(v1Words).toEqual(expect.arrayContaining(['das Internet (Sg.)', 'der Reis (Sg.)']));
    for (const w of v1Words) expect(splitGermanArticle(w).rest).not.toMatch(/\((?:nur\s+)?(?:sg|pl)/i);
    expect(splitGermanArticle('das Internet (Sg.)')).toEqual({ article: 'das', rest: 'Internet', gender: 'n' });
    expect(germanSortKey('der Reis (Sg.)')).toBe('reis');
    expect(isArticleQuizCard('das Internet (Sg.)')).toBe(true);
  });
});

describe('germanSortKey and isArticleQuizCard', () => {
  it('sorts by the word, not the article, and folds accents', () => {
    expect(germanSortKey('die Abfahrt')).toBe('abfahrt');
    expect(germanSortKey('der Ärger')).toBe('arger');
    expect(germanSortKey('der/die Angestellte')).toBe('angestellte');
    expect(germanSortKey('Ufer')).toBe('ufer');
    const sorted = ['die Zeit', 'das Auto', 'der Ärger', 'die Brücke'].sort((a, b) =>
      germanSortKey(a) < germanSortKey(b) ? -1 : 1,
    );
    expect(sorted).toEqual(['der Ärger', 'das Auto', 'die Brücke', 'die Zeit']);
  });

  it('only singular der/die/das nouns are article-quiz cards', () => {
    expect(isArticleQuizCard('die Abfahrt')).toBe(true);
    expect(isArticleQuizCard('das Haus')).toBe(true);
    expect(isArticleQuizCard('die Eltern (Pl.)')).toBe(false);
    expect(isArticleQuizCard('der/die Angestellte')).toBe(false);
    expect(isArticleQuizCard('Ufer')).toBe(false);
    expect(isArticleQuizCard('das heißt')).toBe(false);
  });

  it('germanArticleSpan points at the article in the original text', () => {
    expect(germanArticleSpan('die Abfahrt')).toEqual({ start: 0, end: 3, gender: 'f' });
    expect(germanArticleSpan('  Das Haus')).toEqual({ start: 2, end: 5, gender: 'n' });
    expect(germanArticleSpan('Ufer')).toBeNull();
  });
});

describe('termHelpers', () => {
  it('gives German helpers for any German tag, plain helpers otherwise', () => {
    expect(termHelpers('de-DE')).toBe(termHelpers('de_AT'));
    expect(termHelpers('German').articleQuiz).toBe(true);
    expect(termHelpers('en-US').articleQuiz).toBe(false);
    expect(termHelpers(undefined)).toBe(termHelpers('es-ES'));
  });

  it('German decorate marks the article with its gender and keeps every character', () => {
    const de = termHelpers('de-DE');
    expect(de.decorate('die Abfahrt')).toEqual([{ text: 'die', gender: 'f' }, { text: ' Abfahrt' }]);
    expect(de.decorate('die Eltern (Pl.)')).toEqual([
      { text: 'die', gender: 'pl' },
      { text: ' Eltern (Pl.)' },
    ]);
    expect(de.decorate(' der Tisch')).toEqual([
      { text: ' ' },
      { text: 'der', gender: 'm' },
      { text: ' Tisch' },
    ]);
    expect(de.decorate('der/die Angestellte')).toEqual([{ text: 'der/die Angestellte' }]);
    expect(de.decorate('')).toEqual([]);
    for (const term of ['die Abfahrt', 'Ufer', 'das heißt', '  das Bad  ', 'die Leute (pl)']) {
      expect(de.decorate(term).map((s) => s.text).join('')).toBe(term);
    }
  });

  it('German sortKey ignores the article; plain sortKey only folds', () => {
    expect(termHelpers('de-DE').sortKey('die Abfahrt')).toBe('abfahrt');
    expect(termHelpers('en-US').sortKey('The Hour')).toBe('the hour');
    expect(termHelpers('es-ES').sortKey('  el  Número ')).toBe('el numero');
  });

  it('plain decorate returns the term as one piece', () => {
    expect(termHelpers('en-US').decorate('die Abfahrt')).toEqual([{ text: 'die Abfahrt' }]);
  });
});
