/**
 * Word-shape + language helpers. inferLang stops every import from being forced
 * to German (H6); splitArticle de-emphasises articles across languages.
 */
import { describe, expect, test } from '@jest/globals';

import { inferLang, langCode, splitArticle } from './words';

describe('inferLang', () => {
  test('detects Spanish / French from a deck or file name', () => {
    expect(inferLang(['Spanish A1 Vocabulary'])).toBe('Spanish');
    expect(inferLang(['Vocabulaire Français'])).toBe('French');
    expect(inferLang(['español básico.csv'])).toBe('Spanish');
  });

  test('defaults to German when no language signal is present', () => {
    expect(inferLang(['Kitchen verbs'])).toBe('German');
    expect(inferLang([''])).toBe('German');
  });

  test('infers from foreign field/header labels when the name has no hint (H6)', () => {
    // A French deck whose NAME ("Leçon 1") carries no language word, but whose
    // column headers / Anki fields do.
    expect(inferLang(['Leçon 1', 'Mot', 'Traduction'])).toBe('French');
    // A Spanish deck — accented labels are folded before matching.
    expect(inferLang(['Lección 3', 'Palabra', 'Traducción', 'Ejemplo'])).toBe('Spanish');
    expect(inferLang(['Vokabeln', 'Wort', 'Übersetzung'])).toBe('German');
  });

  test('an explicit language name still outranks a field label', () => {
    expect(inferLang(['Spanish Basics', 'Mot', 'Traduction'])).toBe('Spanish');
  });

  test('a short label token never matches inside an unrelated word (H6)', () => {
    // "mot" is the French label for "word" but must not fire inside "Emotions".
    expect(inferLang(['Emotions vocabulary'])).toBe('German');
    expect(inferLang(['Remote work terms'])).toBe('German');
  });

  test('pairs with langCode to yield the TTS code', () => {
    expect(langCode(inferLang(['Spanish Basics']))).toBe('es');
    expect(langCode(inferLang(['French Basics']))).toBe('fr');
  });
});

describe('splitArticle', () => {
  test('splits German and Spanish articles, leaves bare words alone', () => {
    expect(splitArticle('die Stunde')).toEqual({ article: 'die', base: 'Stunde' });
    expect(splitArticle('el gato')).toEqual({ article: 'el', base: 'gato' });
    expect(splitArticle('verstehen')).toEqual({ article: null, base: 'verstehen' });
  });
});
