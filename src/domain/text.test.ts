/**
 * Pins the shared text helpers (spec §4.4 folding, §8.11 plural copy).
 * foldText is the ONE folding rule for search, import header detection and
 * (later) the library index, so its cases are pinned here.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { foldText, oneLine, plural } from './text';

describe('foldText', () => {
  it('lower-cases and removes German accents (spec example)', () => {
    expect(foldText('Über Straße')).toBe('uber strasse');
  });

  it('folds upper-case accented letters, not only lower-case ones', () => {
    expect(foldText('ÄÖÜ')).toBe('aou');
    expect(foldText('ÉCOLE')).toBe('ecole');
    expect(foldText('ÑANDÚ')).toBe('nandu');
  });

  it('folds the letters of other Latin languages', () => {
    expect(foldText('árbol café niño')).toBe('arbol cafe nino');
    expect(foldText('garçon œuvre')).toBe('garcon oeuvre');
    expect(foldText('Łódź Kraków')).toBe('lodz krakow');
    expect(foldText('ılık şarkı ğ')).toBe('ilik sarki g');
    expect(foldText('smørrebrød æble')).toBe('smorrebrod aeble');
  });

  it('folds decomposed text (letter + separate accent mark) like composed text', () => {
    const decomposed = 'Über Straße'; // 'U' + combining diaeresis
    expect(foldText(decomposed)).toBe('uber strasse');
    expect(foldText('café')).toBe('cafe');
  });

  it('keeps ASCII punctuation, digits and spaces as they are', () => {
    expect(foldText('Tag: B1, "die Stunde"!')).toBe('tag: b1, "die stunde"!');
    expect(foldText('German::Verbs::B1')).toBe('german::verbs::b1');
  });

  it('only lower-cases non-Latin scripts and keeps emoji', () => {
    expect(foldText('Привет')).toBe('привет');
    expect(foldText('日本語')).toBe('日本語');
    expect(foldText('🗂️ Deck')).toBe('🗂️ deck');
  });

  it('returns an empty string for empty input', () => {
    expect(foldText('')).toBe('');
  });

  it('a folded string folds to itself (idempotent)', () => {
    const once = foldText('Ärger über Größe, ÆØÅ');
    expect(foldText(once)).toBe(once);
  });

  describe('Hermes safety', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('works when String.prototype.normalize is missing', () => {
      // Hermes builds without full ICU have no normalize(); foldText must not need it.
      const normalize = jest.spyOn(String.prototype, 'normalize').mockImplementation(() => {
        throw new Error('normalize is not available');
      });
      expect(foldText('Über Straße')).toBe('uber strasse');
      expect(normalize).not.toHaveBeenCalled();
    });
  });

  it('is fast on long text (linear scan)', () => {
    const long = 'Größe über Straße '.repeat(20_000); // 360k characters
    const start = Date.now();
    const folded = foldText(long);
    expect(Date.now() - start).toBeLessThan(500);
    expect(folded.startsWith('grosse uber strasse ')).toBe(true);
  });
});

describe('plural', () => {
  it('uses the singular only for exactly 1', () => {
    expect(plural(0, 'card')).toBe('0 cards');
    expect(plural(1, 'card')).toBe('1 card');
    expect(plural(2, 'deck')).toBe('2 decks');
  });

  it('adds thousands separators', () => {
    expect(plural(1240, 'card')).toBe('1,240 cards');
  });

  it('takes an irregular plural form', () => {
    expect(plural(1, 'child', 'children')).toBe('1 child');
    expect(plural(3, 'child', 'children')).toBe('3 children');
  });

  it('fixes the "1 decks" copy (spec §8.11)', () => {
    expect(`${plural(5, 'card')} ready across ${plural(1, 'deck')}`).toBe(
      '5 cards ready across 1 deck',
    );
  });
});

describe('oneLine', () => {
  it('joins lines and collapses white space', () => {
    expect(oneLine('ich bin\ndu bist')).toBe('ich bin du bist');
    expect(oneLine('  a \t b\r\n\r\nc  ')).toBe('a b c');
  });

  it('returns an empty string for empty input', () => {
    expect(oneLine('')).toBe('');
  });
});
