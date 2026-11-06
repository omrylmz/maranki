/**
 * Ordinal value sort (spec §4.3 "Ordinal sort"). The ONLY domain knowledge of
 * the facet engine, and it is VALUE-based, never field-name-based: a field
 * called anything at all sorts A1 < A2 < B1 when its values look like CEFR
 * levels.
 *
 *   detectOrdinal(['B1', 'A1', 'C2'])        → kind 'cefr'    (A1 < B1 < C2)
 *   detectOrdinal(['N3', 'N5'])              → kind 'jlpt'    (N5 < N3)
 *   detectOrdinal(['HSK 2', 'HSK1'])         → kind 'hsk'     (HSK1 < HSK 2)
 *   detectOrdinal(['10', '2', '1.5'])        → kind 'numeric' (1.5 < 2 < 10)
 *   detectOrdinal(['Unit 12', 'Unit 2'])     → kind 'natural' (Unit 2 < Unit 12)
 *   detectOrdinal(['noun', 'verb'])          → null           (count order instead)
 *
 * A kind is chosen only when EVERY value matches it. The kinds are tried in
 * the order of the table (cefr, jlpt, hsk, numeric, natural), so ['1', '2']
 * is numeric, not natural.
 *
 * `rank(v)` is a number on the kind's own scale, so it is stable whatever
 * other values exist (a badge can colour B1 the same way in every deck):
 *   cefr    A1 = 1, A2 = 2, B1 = 3, B2 = 4, C1 = 5, C2 = 6;
 *           A1.1 = 1.1 (a sub-level), A1+ = 1.05, Pre-A1 = 0.5
 *   jlpt    N5 = 1 … N1 = 5
 *   hsk     HSK1 = 1 … HSK9 = 9
 *   numeric the number itself
 *   natural the number at the end ("Unit 12" → 12)
 * A value that does not fit the kind gets +Infinity, so it sorts last.
 *
 * Pure: no React, no I/O.
 */
import { foldText } from './text';

export type OrdinalKind = 'cefr' | 'jlpt' | 'hsk' | 'numeric' | 'natural';

/** The result of `detectOrdinal`: the kind and the rank function of that kind. */
export interface Ordinal {
  kind: OrdinalKind;
  rank(v: string): number;
}

/* ----------------------------------------------------------------- kinds */

/** "A1", "b2", "A1.1", "B2+", "pre-A1", "PreA1" (spec table). Groups: pre, letter, digit, sub, plus. */
const CEFR = /^(pre-?)?([abc])([12])(?:\.(\d))?(\+)?$/i;
/** "N5" … "N1". */
const JLPT = /^n([1-5])$/i;
/** "HSK1" … "HSK9", with or without one space. */
const HSK = /^hsk\s?([1-9])$/i;
/** A label that ends in a whole number: "Unit 12" → prefix "Unit ", number "12". */
const ENDS_IN_NUMBER = /^(.*?)(\d+)$/;

function cefrRank(v: string): number {
  const m = CEFR.exec(v.trim());
  if (!m) return Number.POSITIVE_INFINITY;
  const [, pre, letter, digit, sub, plus] = m;
  // A1 = 1, A2 = 2, B1 = 3, B2 = 4, C1 = 5, C2 = 6.
  let rank = ('abc'.indexOf(letter.toLowerCase()) * 2) + Number(digit);
  if (sub !== undefined) rank += Number(sub) / 10; // A1.1 = 1.1 … A1.9 = 1.9 (still below A2)
  if (plus !== undefined) rank += 0.05; // A1+ just above A1
  if (pre !== undefined) rank -= 0.5; // Pre-A1 = 0.5 (below A1)
  return rank;
}

function jlptRank(v: string): number {
  const m = JLPT.exec(v.trim());
  // N5 is the easiest level, so it ranks first: N5 = 1 … N1 = 5.
  return m ? 6 - Number(m[1]) : Number.POSITIVE_INFINITY;
}

function hskRank(v: string): number {
  const m = HSK.exec(v.trim());
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** The number of a numeric label, or NaN. An empty label is not a number (Number('') is 0). */
function asNumber(v: string): number {
  const t = v.trim();
  return t === '' ? Number.NaN : Number(t);
}

function numericRank(v: string): number {
  const n = asNumber(v);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** The folded, trimmed text before the final number, or null when the label does not end in a number. */
function naturalPrefix(v: string): string | null {
  const m = ENDS_IN_NUMBER.exec(v.trim());
  return m ? foldText(m[1]).trim() : null;
}

function naturalRank(v: string): number {
  const m = ENDS_IN_NUMBER.exec(v.trim());
  return m ? Number(m[2]) : Number.POSITIVE_INFINITY;
}

/* ------------------------------------------------------------- detection */

/**
 * Which ordinal kind fits ALL the labels, or null. An empty list → null.
 * Labels are trimmed; case does not matter.
 */
export function detectOrdinal(labels: readonly string[]): Ordinal | null {
  if (labels.length === 0) return null;
  const all = (re: RegExp) => labels.every((l) => re.test(l.trim()));

  if (all(CEFR)) return { kind: 'cefr', rank: cefrRank };
  if (all(JLPT)) return { kind: 'jlpt', rank: jlptRank };
  if (all(HSK)) return { kind: 'hsk', rank: hskRank };
  if (labels.every((l) => Number.isFinite(asNumber(l)))) return { kind: 'numeric', rank: numericRank };

  // Natural: every label ends in a number and they all share the same
  // (non-empty) text before it — "Unit 2", "Unit 12".
  const first = naturalPrefix(labels[0]);
  if (first !== null && first !== '' && labels.every((l) => naturalPrefix(l) === first)) {
    return { kind: 'natural', rank: naturalRank };
  }
  return null;
}

/* --------------------------------------------------------------- sorting */

/**
 * Compare two labels for display: folded first (so "apple" and "Apple" sit
 * together), then by the exact text (so the order is always the same).
 * Code-point order, not the phone's locale: the same on every device and in tests.
 */
export function compareLabels(a: string, b: string): number {
  const fa = foldText(a);
  const fb = foldText(b);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Sort facet values in place and return them (spec §4.3):
 *   - with an ordinal kind → by rank, then by label;
 *   - without one → by count (largest first), then by label.
 */
export function sortByOrdinalOrCount<T extends { label: string; count: number }>(
  items: T[],
  ordinal: Ordinal | null,
): T[] {
  if (ordinal) {
    return items.sort((a, b) => {
      const ra = ordinal.rank(a.label);
      const rb = ordinal.rank(b.label);
      if (ra !== rb) return ra < rb ? -1 : 1;
      return compareLabels(a.label, b.label);
    });
  }
  return items.sort((a, b) => b.count - a.count || compareLabels(a.label, b.label));
}
