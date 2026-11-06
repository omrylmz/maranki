/**
 * Ordinal value sort (spec §4.3): every kind of the table, the "all values
 * must match" rule, the kind order (numeric before natural), and the stable
 * rank scale a badge can rely on.
 */
import { describe, expect, it } from '@jest/globals';

import { compareLabels, detectOrdinal, sortByOrdinalOrCount } from './ordinal';

/** The labels sorted the way a facet sorts them (counts all equal). */
function sorted(labels: string[]): string[] {
  const ordinal = detectOrdinal(labels);
  return sortByOrdinalOrCount(
    labels.map((label) => ({ label, count: 1 })),
    ordinal,
  ).map((v) => v.label);
}

describe('detectOrdinal — kinds', () => {
  it('CEFR levels: A1 < A1.1 < A2 < B1 < B2 < C1 < C2', () => {
    expect(detectOrdinal(['B1', 'A1', 'C2'])?.kind).toBe('cefr');
    expect(sorted(['C2', 'B1', 'A2', 'A1.1', 'C1', 'A1', 'B2'])).toEqual(['A1', 'A1.1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  });

  it('CEFR accepts lower case, "+" and "pre-"', () => {
    expect(detectOrdinal(['a1', 'b2+', 'pre-A1', 'PreA1'])?.kind).toBe('cefr');
    expect(sorted(['A2', 'A1+', 'pre-A1', 'A1'])).toEqual(['pre-A1', 'A1', 'A1+', 'A2']);
  });

  it('CEFR ranks are a stable scale: A1 = 1 … C2 = 6', () => {
    const { rank } = detectOrdinal(['A1'])!;
    expect(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rank('A1.1')).toBeCloseTo(1.1);
    expect(rank('pre-A1')).toBe(0.5);
    // A value that is not CEFR sorts last.
    expect(rank('noun')).toBe(Number.POSITIVE_INFINITY);
  });

  it('JLPT: N5 < N4 < N3 < N2 < N1', () => {
    expect(detectOrdinal(['N1', 'n5'])?.kind).toBe('jlpt');
    expect(sorted(['N1', 'N3', 'N5', 'N2', 'N4'])).toEqual(['N5', 'N4', 'N3', 'N2', 'N1']);
  });

  it('HSK: HSK1 < … < HSK9, with or without a space', () => {
    expect(detectOrdinal(['HSK 2', 'hsk1'])?.kind).toBe('hsk');
    expect(sorted(['HSK 9', 'HSK2', 'HSK 1'])).toEqual(['HSK 1', 'HSK2', 'HSK 9']);
  });

  it('numeric: every value is a number', () => {
    expect(detectOrdinal(['10', '2', '1.5', '-3'])?.kind).toBe('numeric');
    expect(sorted(['10', '2', '1.5', '-3'])).toEqual(['-3', '1.5', '2', '10']);
  });

  it('natural: a shared prefix and a number at the end ("Unit 2" < "Unit 12")', () => {
    expect(detectOrdinal(['Unit 12', 'Unit 2', 'unit 3'])?.kind).toBe('natural');
    expect(sorted(['Lesson 12', 'Lesson 2', 'Lesson 1'])).toEqual(['Lesson 1', 'Lesson 2', 'Lesson 12']);
  });
});

describe('detectOrdinal — when it says no', () => {
  it('every value must match: one stray value → no ordinal', () => {
    expect(detectOrdinal(['A1', 'A2', 'noun'])).toBeNull();
    expect(detectOrdinal(['1', '2', 'x'])).toBeNull();
  });

  it('natural needs the SAME prefix', () => {
    expect(detectOrdinal(['Unit 1', 'Lesson 2'])).toBeNull();
  });

  it('plain words and an empty list → null', () => {
    expect(detectOrdinal(['noun', 'verb', 'adjective'])).toBeNull();
    expect(detectOrdinal([])).toBeNull();
  });

  it('kinds are tried in table order: digits are numeric, not natural', () => {
    expect(detectOrdinal(['1', '2'])?.kind).toBe('numeric');
  });

  it('an empty label is not a number', () => {
    expect(detectOrdinal(['', '1'])).toBeNull();
  });
});

describe('sortByOrdinalOrCount', () => {
  it('without an ordinal: count descending, then label', () => {
    const items = [
      { label: 'verb', count: 3 },
      { label: 'noun', count: 9 },
      { label: 'adjective', count: 3 },
    ];
    expect(sortByOrdinalOrCount(items, null).map((v) => v.label)).toEqual(['noun', 'adjective', 'verb']);
  });

  it('with an ordinal: rank wins over count', () => {
    const items = [
      { label: 'B1', count: 1 },
      { label: 'A1', count: 2 },
      { label: 'A2', count: 500 },
    ];
    expect(sortByOrdinalOrCount(items, detectOrdinal(['B1', 'A1', 'A2'])).map((v) => v.label)).toEqual([
      'A1',
      'A2',
      'B1',
    ]);
  });
});

describe('compareLabels', () => {
  it('ignores case and accents first, then is exact (stable on every device)', () => {
    expect(['Zebra', 'äpfel', 'Apfel'].sort(compareLabels)).toEqual(['Apfel', 'äpfel', 'Zebra']);
    expect(compareLabels('a', 'a')).toBe(0);
  });
});
