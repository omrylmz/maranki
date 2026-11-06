/**
 * Tests for the UI kit v2 (W3-7, spec §8.12 accessibility, §8.13 atoms).
 *
 * Four parts:
 *   1. the PURE helpers the components are built on (labels, colours,
 *      shares, provenance, CEFR rank → colour, gender pieces …);
 *   2. the components themselves, rendered with react-test-renderer: roles,
 *      states and labels a screen reader gets, what a tap calls, and
 *      Reduce Motion (RiseIn renders at once, Sheet fades instead of sliding);
 *   3. W5-2 lock-in: `label` is REQUIRED on IconBtn and FAB (a type-level
 *      check that tsc runs), and every IconBtn / FAB in src/app and
 *      src/components passes a label that is not empty (a source scan);
 *   4. wave 5e F1, the largest font size (device pass 2026-11-02): the texts
 *      the device showed cut ("Flash..", "Speak the question a..", "German —
 *      E…", "Reviews 10 /…", "0% mastere…", "Practi…") are not limited to one
 *      line, the rows that hold them wrap, a wrapping SegCtrl keeps its touch
 *      targets apart, and the status bar strip (where the screens put it).
 *      Each layout is checked at BOTH font sizes (1 and 2).
 *
 * Module mocks (`jest.mock` below):
 *   - ThemeContext → useColors() returns the light palette (no provider,
 *     no kv-store file);
 *   - safe-area-context → zero insets (Sheet, StackBar), or the top inset a
 *     StatusBarStrip test sets in `mockInsets`;
 *   - @expo/vector-icons → icons render nothing (no async font load);
 *   - expo-router, the CardSheet and the ListActionsSheet → nothing (part 4
 *     draws Today's deck rows, list rows and goal bars, which import them);
 *   - expo-image → a plain 'ExpoImage' element (the ImageViewer's picture).
 * The font size: React Native's jest mock says fontScale 2 (the largest
 * Android size). A test that needs another size sets it with `setFontScale`
 * (Dimensions.set) and puts the start value back afterwards.
 * AccessibilityInfo is React Native's own jest mock; each Reduce Motion test
 * sets what `isReduceMotionEnabled()` answers.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { AccessibilityInfo, Dimensions, Modal, Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';

import { LIFE_KEYS } from '../../domain/life';
import type { Deck, FieldBlock, ReadyCounts, SourceKind } from '../../domain/model';
import type { DeckSummary } from '../../domain/scope';
import { subscribeReduceMotion } from '../../store/useReduceMotion';
import { makeDeckV3 } from '../../test/factoriesV3';
import { font, light } from '../../theme/tokens';
import { DeckRows, todayNameLines } from '../today/DeckRows';
import { ListRowView } from '../today/ListRows';
import { GoalBars } from '../today/TodayHero';
import { goalBars, type ListRowModel } from '../today/todayLogic';
import { segMinWidth, segRowGap } from './controls';
import { BAR_MIN_WIDTH } from './FacetBars';
import { CLOSE_IMAGE_LABEL, containSize, ImageViewer, OPEN_IMAGE_HINT } from './ImageViewer';
import {
  ADD_FILTER_COPY,
  backButtonLabel,
  Bar,
  Btn,
  cefrKeyOf,
  childText,
  Chip,
  clampPercent,
  DeckTag,
  DeckTile,
  deckProvenance,
  FAB,
  FacetBadge,
  facetBadgeColors,
  facetBadgeLabel,
  facetBarLabel,
  facetBarLine,
  facetBarMoreLabel,
  FacetBars,
  facetBarStatus,
  fieldRowLabel,
  FieldRows,
  FilterChipsRow,
  genderColors,
  HoldButton,
  IconBtn,
  inlineStyle,
  masteredPercent,
  MIN_TOUCH,
  Pill,
  PROVENANCE_LABEL,
  removeFilterLabel,
  ResultActions,
  RiseIn,
  roleText,
  rowTotal,
  SegBar,
  SegCtrl,
  segOptionSpace,
  segShares,
  Sheet,
  SHEET_CLOSE_LABEL,
  shownResultActions,
  squareSlop,
  STATE_ICON,
  StateBadge,
  StateDot,
  statusColors,
  Stepper,
  stepValue,
  streakLabel,
  TermText,
  termSegments,
  Toggle,
  visibleBlocks,
} from './index';
import {
  buttonPairLayout,
  isLargeText,
  LARGE_TEXT_SCALE,
  ListRow,
  Overline,
  StatusBarStrip,
  useLargeText,
} from './layout';

jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));

// Zero insets, except where a test sets a top inset (StatusBarStrip).
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

// The real icon loads its font later and sets state outside act(); icons
// draw nothing a screen reader needs, so they render nothing here.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// Today's deck rows, list rows and goal bars are drawn here only for their
// layout at each font size (section 4): the router does nothing, and the
// sheets (which need the store) are not loaded.
jest.mock('expo-router', () => ({ useRouter: () => ({ push: () => undefined, navigate: () => undefined }) }));
jest.mock('../sheets/CardSheet', () => ({ CardSheet: () => null }));
jest.mock('../sheets/ListActionsSheet', () => ({ ListActionsSheet: () => null }));
// The full-screen ImageViewer draws an expo-image picture: a plain element here (its props are checked).
jest.mock('expo-image', () => ({
  Image: function Image(props: Record<string, unknown>) {
    return jest.requireActual<typeof import('react')>('react').createElement('ExpoImage', props);
  },
}));

const h = React.createElement;

/* --------------------------------------------------------------- helpers */

/** The window and screen sizes React Native's jest mock starts with (fontScale 2). */
const START_DIMENSIONS = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };

/**
 * Draw the next renders at this font scale (1 = the normal size, 2 = the
 * largest). Inside act(): a component on screen hears the change and draws again.
 */
function setFontScale(fontScale: number): void {
  act(() => {
    Dimensions.set({
      window: { ...START_DIMENSIONS.window, fontScale },
      screen: { ...START_DIMENSIONS.screen, fontScale },
    });
  });
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.useRealTimers();
});

/** Render an element (inside act) and return the renderer. */
function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

/** Every host element (View / Text …) with this accessibility role. */
function byRole(r: ReactTestRenderer, role: string): ReactTestInstance[] {
  return r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === role);
}

/** The one host element with this accessibility label. */
function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance {
  const found = r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
  if (found.length !== 1) throw new Error(`expected one element labelled "${label}", found ${found.length}`);
  return found[0];
}

/**
 * The Pressable (the component, not its host view) with this accessibility
 * label: the outermost non-host element that has the label and an `onPress`
 * prop (the prop may be undefined, for a disabled button).
 */
function pressableByLabel(r: ReactTestRenderer, label: string): ReactTestInstance {
  const found = r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props,
  );
  if (found.length === 0) throw new Error(`no pressable labelled "${label}"`);
  return found[0];
}

/** Every string drawn by a Text, joined (nested Texts included). */
function allText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => (typeof t.props.children === 'string' ? t.props.children : ''))
    .join('|');
}

/** The style of a host element as one flat object. */
function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return (style as Record<string, unknown>) ?? {};
}

/** Make the next OS read of Reduce Motion answer `value`, and wait for it. */
async function setReduceMotion(value: boolean): Promise<void> {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(value);
  const stop = subscribeReduceMotion(() => undefined);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  stop();
}

/** A FieldBlock with plain text lines. */
function block(field: number, label: string, role: FieldBlock['role'], text: string): FieldBlock {
  return {
    field,
    label,
    role,
    lines: text === '' ? [] : text.split('\n').map((line) => [{ t: 'text' as const, text: line }]),
    plain: text.replace(/\n/g, ' '),
  };
}

/* =============================================================== 1. pure */

describe('a11y helpers (buttons.tsx)', () => {
  test('childText reads plain text children, and gives up on elements', () => {
    expect(childText('Restore')).toBe('Restore');
    expect(childText(30)).toBe('30');
    expect(childText(['Study ', 30])).toBe('Study 30');
    expect(childText(['Study ', null, false, 30])).toBe('Study 30');
    expect(childText(h(Text, null, 'x'))).toBeUndefined();
    expect(childText(['a', h(Text, null, 'x')])).toBeUndefined();
    expect(childText(null)).toBeUndefined();
    expect(childText([])).toBeUndefined();
    expect(childText('')).toBeUndefined();
    expect(childText(['', 'Save'])).toBe('Save');
    expect(childText([['Choose (', 12], ')'])).toBe('Choose (12)');
  });

  test('squareSlop makes every button size a touch target of at least 44 pt', () => {
    expect(MIN_TOUCH).toBe(44);
    expect(squareSlop(38)).toBe(6); // the old fixed slop is kept as the minimum
    expect(squareSlop(28)).toBe(8);
    expect(squareSlop(54)).toBe(6);
    for (let size = 10; size <= 60; size++) {
      expect(size + 2 * squareSlop(size)).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });

  test('backButtonLabel: "Close" for the × icon, "Back" otherwise', () => {
    expect(backButtonLabel('close')).toBe('Close');
    expect(backButtonLabel('close-outline')).toBe('Close');
    expect(backButtonLabel('chevron-back')).toBe('Back');
  });

  test('stepValue keeps the value inside [min, max]', () => {
    expect(stepValue(10, 1, 0, 999)).toBe(11);
    expect(stepValue(998, 5, 0, 999)).toBe(999);
    expect(stepValue(2, -5, 0, 999)).toBe(0);
  });

  test('stepValue never moves against the asked direction (a stored value outside the range)', () => {
    // Above max: "increase" changes nothing (it never lowers the value) …
    expect(stepValue(1000, 1, 0, 999)).toBe(1000);
    // … and "decrease" goes into the range.
    expect(stepValue(1000, -1, 0, 999)).toBe(999);
    // Below min: the same, the other way round.
    expect(stepValue(-3, -1, 0, 999)).toBe(-3);
    expect(stepValue(-3, 1, 0, 999)).toBe(0);
    // At the ends: nothing to do.
    expect(stepValue(999, 1, 0, 999)).toBe(999);
    expect(stepValue(0, -1, 0, 999)).toBe(0);
  });

  test('segOptionSpace: each SegCtrl option is a touch target of at least 44 pt', () => {
    expect(segOptionSpace('sm')).toEqual({ padV: 6, slopV: 8 });
    expect(segOptionSpace('md')).toEqual({ padV: 8, slopV: 6 });
    // With the real line of HankenGrotesk (1.303 × the font size) and the
    // smallest bound (16 pt) for the text line.
    for (const [size, fontSize] of [['sm', 12.5], ['md', 13.5]] as const) {
      const { padV, slopV } = segOptionSpace(size);
      expect(2 * slopV + 2 * padV + 16).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(2 * slopV + 2 * padV + 1.303 * fontSize).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });

  test('segOptionSpace at a larger font: less slop, still a 44 pt target; never under 3 pt', () => {
    expect(segOptionSpace('sm', 1)).toEqual({ padV: 6, slopV: 8 });
    expect(segOptionSpace('sm', 1.3)).toEqual({ padV: 6, slopV: 6 });
    expect(segOptionSpace('md', 1.3)).toEqual({ padV: 8, slopV: 4 });
    expect(segOptionSpace('sm', 2)).toEqual({ padV: 6, slopV: 3 });
    expect(segOptionSpace('md', 2)).toEqual({ padV: 8, slopV: 3 });
    // A smaller font ("Small", 0.85) needs MORE slop.
    expect(segOptionSpace('sm', 0.85).slopV).toBeGreaterThan(8);
    // Not a real scale: the normal size.
    expect(segOptionSpace('sm', Number.NaN)).toEqual(segOptionSpace('sm'));
    expect(segOptionSpace('md', 0)).toEqual(segOptionSpace('md'));
    for (const size of ['sm', 'md'] as const) {
      for (const scale of [0.85, 1, 1.15, 1.3, 1.5, 1.8, 2]) {
        const { padV, slopV } = segOptionSpace(size, scale);
        expect(2 * slopV + 2 * padV + 16 * scale).toBeGreaterThanOrEqual(MIN_TOUCH);
        expect(slopV).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('segRowGap: two rows of options are 2 × slop apart, so no slop covers an option of the other row', () => {
    expect(segRowGap(8)).toBe(16);
    expect(segRowGap(3)).toBe(6);
    for (const size of ['sm', 'md'] as const) {
      for (const scale of [1, 1.3, 2]) {
        const { slopV } = segOptionSpace(size, scale);
        // The bottom slop of row 1 + the top slop of row 2 fit in the gap.
        expect(segRowGap(slopV)).toBeGreaterThanOrEqual(slopV + slopV);
      }
    }
  });
});

describe('status keys (spec §8.13)', () => {
  test('STATE_ICON has every status, with the two new glyphs', () => {
    expect(STATE_ICON.notStarted).toBe('ellipse-outline');
    expect(STATE_ICON.known).toBe('checkmark-done');
    for (const key of [...LIFE_KEYS, 'due' as const]) expect(typeof STATE_ICON[key]).toBe('string');
    // The old glyphs are unchanged.
    expect(STATE_ICON).toMatchObject({
      new: 'sparkles',
      learning: 'school',
      review: 'repeat',
      mastered: 'checkmark-circle',
      due: 'time',
    });
  });

  test('statusColors: Known uses the mastered pair, Not started is neutral, the rest their own token', () => {
    expect(statusColors(light, 'known')).toEqual(light.state.mastered);
    expect(statusColors(light, 'notStarted')).toEqual({ fg: light.ink2, tint: light.paperSunk });
    expect(statusColors(light, 'review')).toEqual(light.state.review);
    expect(statusColors(light, 'due')).toEqual(light.state.due);
  });
});

describe('chips and labels', () => {
  test('the × label is exact copy (spec §8.12)', () => {
    expect(removeFilterLabel('Level: B1, B2')).toBe('Remove filter Level: B1, B2');
    expect(ADD_FILTER_COPY).toEqual({ text: 'Filter', label: 'Add a filter' });
  });

  test('streakLabel says the streak and the freezes in words', () => {
    expect(streakLabel(12)).toBe('12-day streak');
    expect(streakLabel(12, 1)).toBe('12-day streak, 1 freeze');
    expect(streakLabel(1200, 2)).toBe('1,200-day streak, 2 freezes');
  });
});

describe('deck provenance (spec §7 #46, §8.13)', () => {
  test('Deck.source alone decides the label (W5-3: the dead builtin flag is not read)', () => {
    const cases: [SourceKind | undefined, string | null][] = [
      ['pack', 'starter'],
      ['apkg', 'imported'],
      ['ankiweb', 'imported'],
      ['csv', 'imported'],
      ['manual', 'own'],
      ['migrated', 'own'], // a deck from an older version is yours
      ['backup', 'own'],
      [undefined, null], // damaged data: no tag
    ];
    for (const [source, expected] of cases) {
      expect([source, deckProvenance(source)]).toEqual([source, expected]);
    }
  });

  test('the three labels are exact copy', () => {
    expect(PROVENANCE_LABEL).toEqual({ starter: 'Starter deck', imported: 'Imported', own: 'Your deck' });
  });
});

describe('FacetBadge colours (CEFR tokens by rank)', () => {
  test('cefrKeyOf maps CEFR-like values to a level by rank', () => {
    expect(cefrKeyOf('A1')).toBe('A1');
    expect(cefrKeyOf('b2')).toBe('B2');
    expect(cefrKeyOf('C2')).toBe('C2');
    expect(cefrKeyOf('A2.1')).toBe('A2'); // a sub-level keeps its level's colour
    expect(cefrKeyOf('B2+')).toBe('B2');
    expect(cefrKeyOf('Pre-A1')).toBe('A1'); // below A1 → the A1 colour
    expect(cefrKeyOf('B1', 'cefr')).toBe('B1');
  });

  test('a non-CEFR group or value is neutral', () => {
    expect(cefrKeyOf('B1', null)).toBeNull(); // the group is not ordinal
    expect(cefrKeyOf('N5', 'jlpt')).toBeNull();
    expect(cefrKeyOf('B1', 'natural')).toBeNull();
    expect(cefrKeyOf('noun')).toBeNull();
    expect(cefrKeyOf('')).toBeNull();
    expect(cefrKeyOf('D1')).toBeNull();
  });

  test('facetBadgeColors uses c.cefr[level], else ink2 on paperSunk', () => {
    expect(facetBadgeColors(light, 'B1')).toEqual(light.cefr.B1);
    expect(facetBadgeColors(light, 'C1', 'cefr')).toEqual(light.cefr.C1);
    expect(facetBadgeColors(light, 'verb')).toEqual({ fg: light.ink2, tint: light.paperSunk });
    expect(facetBadgeLabel('B1', 'Level')).toBe('Level: B1');
    expect(facetBadgeLabel('B1')).toBe('B1');
  });
});

describe('TermText pieces (gender colours, spec §9.2)', () => {
  test('a German term gets its article as a coloured piece', () => {
    expect(termSegments('die Abfahrt', 'de-DE')).toEqual([{ text: 'die', gender: 'f' }, { text: ' Abfahrt' }]);
    expect(termSegments('der Tag', 'de')).toEqual([{ text: 'der', gender: 'm' }, { text: ' Tag' }]);
    expect(termSegments('das Haus', 'German')).toEqual([{ text: 'das', gender: 'n' }, { text: ' Haus' }]);
    expect(termSegments('die Eltern (Pl.)', 'de-DE')[0]).toEqual({ text: 'die', gender: 'pl' });
  });

  test('no decoration when the deck turned it off, or the language is not German', () => {
    expect(termSegments('die Abfahrt', 'de-DE', false)).toEqual([{ text: 'die Abfahrt' }]);
    expect(termSegments('the hour', 'en-US')).toEqual([{ text: 'the hour' }]);
    expect(termSegments('die Abfahrt', undefined)).toEqual([{ text: 'die Abfahrt' }]);
    expect(termSegments('', 'de-DE')).toEqual([]);
  });

  test('the pieces always join back to the input (the article is never hidden)', () => {
    for (const t of ['die Abfahrt', '  Die Reise ', 'der/die Angestellte', 'das heißt', 'die Eltern (Pl.)', 'Ufer']) {
      expect(termSegments(t, 'de-DE').map((s) => s.text).join('')).toBe(t);
    }
  });

  test('gender colours: der info, die danger, das success, plural ink3', () => {
    expect(genderColors(light, 'm')).toEqual({ fg: light.info, tint: light.infoTint });
    expect(genderColors(light, 'f')).toEqual({ fg: light.danger, tint: light.dangerTint });
    expect(genderColors(light, 'n')).toEqual({ fg: light.success, tint: light.successTint });
    expect(genderColors(light, 'pl')).toEqual({ fg: light.ink3, tint: light.paperSunk });
  });
});

describe('SegBar shares', () => {
  test('segments in drawing order, the empty rest last', () => {
    expect(segShares({ mastered: 1, neww: 3 })).toEqual({
      parts: [
        { key: 'mastered', share: 0.25 },
        { key: 'neww', share: 0.75 },
      ],
      rest: 0,
    });
    expect(segShares({ known: 1, mastered: 1, review: 1, notStarted: 1 }).parts.map((p) => p.key)).toEqual([
      'mastered',
      'review',
      'notStarted',
      'known',
    ]);
    expect(segShares({ mastered: 1 }, 4)).toEqual({ parts: [{ key: 'mastered', share: 0.25 }], rest: 0.75 });
    // Nothing to stack: the whole bar is the empty track.
    expect(segShares({})).toEqual({ parts: [], rest: 1 });
    expect(segShares({ mastered: -3 })).toEqual({ parts: [], rest: 1 });
  });

  test('clampPercent', () => {
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('FacetBars numbers (spec §8.8: Known is never mastered)', () => {
  const b1 = { value: 'b1', label: 'B1', mastered: 130, review: 400, learning: 50, neww: 544, notStarted: 500 };

  test('total, percent rounded down, status words and the line', () => {
    expect(rowTotal(b1)).toBe(1624);
    expect(masteredPercent(b1)).toBe(8); // 130 / 1624 = 8.0 %
    expect(facetBarStatus(b1)).toBe('8% mastered');
    expect(facetBarLine(b1)).toBe('8% mastered · 1,624 cards');
    expect(facetBarLabel('Level', b1)).toBe('Level B1: 8 percent mastered, 1,624 cards');
    expect(facetBarMoreLabel('Level', b1)).toBe('Actions for Level B1');
  });

  test('never 100% while one card is not mastered; an explicit total wins', () => {
    expect(masteredPercent({ value: 'x', label: 'x', mastered: 999, review: 1 })).toBe(99);
    expect(masteredPercent({ value: 'x', label: 'x', mastered: 1, total: 4 })).toBe(25);
    expect(masteredPercent({ value: 'x', label: 'x' })).toBe(0);
  });

  test('Known cards are not counted as mastered; all Known says "Known"', () => {
    const half = { value: 'a2', label: 'A2', known: 10, review: 10 };
    expect(masteredPercent(half)).toBe(0);
    expect(facetBarStatus(half)).toBe('0% mastered');
    const a1 = { value: 'a1', label: 'A1', known: 1530 };
    expect(facetBarStatus(a1)).toBe('Known');
    expect(facetBarLabel('Level', a1)).toBe('Level A1: Known, 1,530 cards');
    expect(facetBarLine({ value: 'z', label: 'Z' })).toBe('0% mastered · 0 cards');
  });
});

describe('FieldRows helpers (spec §6.2)', () => {
  test('role styles', () => {
    expect(roleText('example')).toEqual({ family: 'serif', weight: 400, italic: true, size: 16.5, color: 'ink2' });
    expect(roleText('exampleMeaning')).toMatchObject({ family: 'sans', size: 13, color: 'ink3' });
    expect(roleText('pronunciation')).toMatchObject({ family: 'mono', size: 14, color: 'ink2' });
    expect(roleText('detail')).toMatchObject({ family: 'sans', size: 14.5, color: 'ink' });
    expect(roleText('term')).toMatchObject({ family: 'serif', color: 'ink' });
  });

  test('inline styles switch the font family (a custom font has no fontWeight)', () => {
    const detail = roleText('detail');
    expect(inlineStyle({ t: 'text', text: 'x' }, detail)).toEqual(font('sans', 400));
    expect(inlineStyle({ t: 'text', text: 'x', b: true }, detail)).toEqual(font('sans', 700));
    expect(inlineStyle({ t: 'text', text: 'x', i: true }, roleText('example'))).toEqual(font('serif', 400, true));
    expect(inlineStyle({ t: 'text', text: 'x', u: true }, detail)).toMatchObject({ textDecorationLine: 'underline' });
    expect(inlineStyle({ t: 'text', text: '2', sup: true }, detail).fontSize).toBeLessThan(detail.size);
  });

  test('italic sans and mono text is slanted by fontStyle (they have no italic font); the serif is not', () => {
    const italic = { t: 'text' as const, text: 'ist gewesen', i: true };
    // sans roles: detail, meaning, exampleMeaning, badge
    for (const role of ['detail', 'meaning', 'exampleMeaning', 'badge'] as const) {
      expect(inlineStyle(italic, roleText(role))).toMatchObject({ fontStyle: 'italic' });
    }
    expect(inlineStyle(italic, roleText('detail'))).toEqual({ ...font('sans', 400), fontStyle: 'italic' });
    expect(inlineStyle({ ...italic, b: true }, roleText('detail'))).toEqual({ ...font('sans', 700), fontStyle: 'italic' });
    expect(inlineStyle(italic, roleText('pronunciation'))).toEqual({ ...font('mono', 400), fontStyle: 'italic' });
    // The serif has italic files: no second slant.
    expect(inlineStyle(italic, roleText('term'))).toEqual(font('serif', 500, true));
    expect(inlineStyle(italic, roleText('example')).fontStyle).toBeUndefined();
    // Upright text stays upright.
    expect(inlineStyle({ t: 'text', text: 'x' }, roleText('detail')).fontStyle).toBeUndefined();
  });

  test('hidden and empty fields are skipped; an image-only field only when images are drawn', () => {
    const img: FieldBlock = { field: 3, label: 'Picture', role: 'detail', lines: [[{ t: 'img', src: 'a.png' }]], plain: '' };
    const blocks = [
      block(0, 'Grammar', 'detail', '-n'),
      block(1, 'Secret', 'hidden', 'x'),
      { ...block(2, 'Empty', 'detail', ''), plain: '  ' },
      img,
    ];
    expect(visibleBlocks(blocks).map((b) => b.label)).toEqual(['Grammar']);
    expect(visibleBlocks(blocks, true).map((b) => b.label)).toEqual(['Grammar', 'Picture']);
    expect(fieldRowLabel(block(0, 'Example', 'example', 'Die Reise war lang.'))).toBe('Example: Die Reise war lang.');
  });
});

describe('ResultActions', () => {
  test('hidden actions are left out; the first shown is primary', () => {
    const noop = () => undefined;
    const shown = shownResultActions([
      { key: 'study', label: 'Study 0', onPress: noop, hidden: true },
      { key: 'practice', label: 'Practice 30', onPress: noop },
      { key: 'choose', label: 'Choose (1,585)', onPress: noop },
      { key: 'save', label: 'Save as list', onPress: noop, kind: 'ghost' },
    ]);
    expect(shown.map((a) => [a.key, a.kind])).toEqual([
      ['practice', 'primary'],
      ['choose', 'secondary'],
      ['save', 'ghost'],
    ]);
  });
});

/* ========================================================= 2. components */

describe('buttons (spec §8.12)', () => {
  test('IconBtn: role button, its label, disabled state, and a ≥ 44 pt target', () => {
    const onPress = jest.fn();
    const r = render(h(IconBtn, { icon: 'add', label: 'Add a deck, card, list or import', size: 28, onPress }));
    const btn = byLabel(r, 'Add a deck, card, list or import');
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityState).toEqual({ disabled: false });
    expect(28 + 2 * (btn.props.hitSlop as number)).toBeGreaterThanOrEqual(44);
    act(() => pressableByLabel(r, 'Add a deck, card, list or import').props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);

    act(() => r.update(h(IconBtn, { icon: 'add', label: 'Add', disabled: true, onPress })));
    expect(byLabel(r, 'Add').props.accessibilityState).toEqual({ disabled: true });
    expect(pressableByLabel(r, 'Add').props.onPress).toBeUndefined();
  });

  test('FAB: role button and its label', () => {
    const r = render(h(FAB, { onPress: () => undefined, bottom: 20, label: 'Add a card' }));
    expect(byLabel(r, 'Add a card').props.accessibilityRole).toBe('button');
  });

  test('label is REQUIRED on IconBtn and FAB (W5-2): TypeScript rejects an icon button without a name', () => {
    // These two lines compile ONLY because TypeScript finds an error on each
    // (a missing `label`). If `label` ever becomes optional again, each
    // "expect an error" comment below has no error to expect, and
    // `npm run verify` (tsc) fails. So this pins "every icon button has a name".
    // @ts-expect-error — an IconBtn needs `label`: a screen reader has no other name for it.
    const iconWithoutLabel = h(IconBtn, { icon: 'add', onPress: () => undefined });
    // @ts-expect-error — a FAB needs `label` too: it shows only an icon.
    const fabWithoutLabel = h(FAB, { onPress: () => undefined, bottom: 20 });
    expect(iconWithoutLabel.props).not.toHaveProperty('label');
    expect(fabWithoutLabel.props).not.toHaveProperty('label');
  });

  test('label is REQUIRED on Toggle: a switch has no text of its own, so TalkBack would say only "Switch, on"', () => {
    // Same lock as above: this line compiles only while `label` is required.
    // @ts-expect-error — a Toggle needs `label` (the row title next to it).
    const switchWithoutLabel = h(Toggle, { on: true, onChange: () => undefined });
    expect(switchWithoutLabel.props).not.toHaveProperty('label');
  });

  test('label is REQUIRED on SegCtrl (wave 5e F1-4): TalkBack must say which choice the radio buttons make', () => {
    // Same lock as above: this line compiles only while `label` is required.
    // Without a name the group is an unnamed "radio group" ("AnkiWeb / From a file / Backup").
    // @ts-expect-error — a SegCtrl needs `label` (the name of the choice, e.g. "Import from").
    const segWithoutLabel = h(SegCtrl, { value: 'a', onChange: () => undefined, options: [{ id: 'a', label: 'A' }] });
    expect(segWithoutLabel.props).not.toHaveProperty('label');
  });

  test('Btn reads its text (and sub); an explicit label wins; the icon is hidden', () => {
    const r = render(h(Btn, { icon: 'play', onPress: () => undefined, children: ['Study ', 30] }));
    const btn = byLabel(r, 'Study 30');
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityState).toEqual({ disabled: false });
    const hidden = r.root.findAll((n) => n.type === View && n.props.importantForAccessibility === 'no-hide-descendants');
    expect(hidden).toHaveLength(1);

    act(() => r.update(h(Btn, { sub: 'about 12 min', children: 'Study 30' })));
    expect(byLabel(r, 'Study 30, about 12 min')).toBeTruthy();
    act(() => r.update(h(Btn, { label: 'Practice 30 cards', disabled: true, children: 'Practice 30' })));
    expect(byLabel(r, 'Practice 30 cards').props.accessibilityState).toEqual({ disabled: true });
  });

  test('HoldButton (moved into the kit): button, hold hint and the longpress action', () => {
    const onConfirm = jest.fn();
    const r = render(h(HoldButton, { onConfirm, children: 'Hold to restore' }));
    const btn = byLabel(r, 'Hold to restore');
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityHint).toBe('Press and hold for one second.');
    act(() => btn.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('Chip: two targets, each with its own label (spec §8.12)', () => {
  test('the chip is a button with selected; its × removes the filter', () => {
    const onPress = jest.fn();
    const onDismiss = jest.fn();
    const r = render(h(Chip, { active: true, dismiss: true, onPress, onDismiss, children: 'Level: B1, B2' }));
    const chip = byLabel(r, 'Level: B1, B2');
    expect(chip.props.accessibilityRole).toBe('button');
    expect(chip.props.accessibilityState).toEqual({ selected: true });
    const x = byLabel(r, 'Remove filter Level: B1, B2');
    expect(x.props.accessibilityRole).toBe('button');

    act(() => pressableByLabel(r, 'Remove filter Level: B1, B2').props.onPress());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    act(() => pressableByLabel(r, 'Level: B1, B2').props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('a choice chip without × has one target; not selected when inactive', () => {
    const r = render(h(Chip, { onPress: () => undefined, children: 'Due' }));
    expect(byRole(r, 'button')).toHaveLength(1);
    expect(byLabel(r, 'Due').props.accessibilityState).toEqual({ selected: false });
  });

  test('the touch target is at least 44 pt high, while the pill keeps its size', () => {
    const r = render(h(Chip, { dismiss: true, onDismiss: () => undefined, children: 'Deck: German' }));
    const wrapper = flat(r.root.findAll((n) => n.type === View)[0].props.style);
    const target = flat(pressableByLabel(r, 'Deck: German').props.style);
    const pill = flat(r.root.findAll((n) => n.type === View)[1].props.style);
    const slop = -(wrapper.marginVertical as number);
    expect(slop).toBe(6);
    expect(pill).toMatchObject({ position: 'absolute', top: slop, bottom: slop });
    // Text of 13.5 pt is at least 16 pt high: 2 × padding + 16 ≥ 44.
    expect(2 * (target.paddingVertical as number) + 16).toBeGreaterThanOrEqual(44);
  });

  test('FilterChipsRow: one dismissible chip per filter, then "+ Filter"', () => {
    const removeDeck = jest.fn();
    const onAdd = jest.fn();
    const r = render(
      h(FilterChipsRow, {
        chips: [
          { key: 'deck', label: 'Deck: German', onRemove: removeDeck },
          { key: 'life', label: 'Not started', onRemove: () => undefined },
        ],
        onAdd,
      }),
    );
    expect(byLabel(r, 'Remove filter Deck: German')).toBeTruthy();
    expect(byLabel(r, 'Remove filter Not started')).toBeTruthy();
    act(() => pressableByLabel(r, 'Remove filter Deck: German').props.onPress());
    expect(removeDeck).toHaveBeenCalledTimes(1);
    act(() => pressableByLabel(r, 'Add a filter').props.onPress());
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(allText(r)).toContain('Filter');
  });
});

describe('controls (spec §8.12)', () => {
  test('Toggle is a switch with checked, and its label', () => {
    const onChange = jest.fn();
    const r = render(h(Toggle, { on: true, onChange, label: 'Automatic backups' }));
    const sw = byLabel(r, 'Automatic backups');
    expect(sw.props.accessibilityRole).toBe('switch');
    expect(sw.props.accessibilityState).toEqual({ checked: true, disabled: false });
    act(() => pressableByLabel(r, 'Automatic backups').props.onPress());
    expect(onChange).toHaveBeenCalledWith(false);

    act(() => r.update(h(Toggle, { on: false, onChange, label: 'Automatic backups', disabled: true })));
    expect(byLabel(r, 'Automatic backups').props.accessibilityState).toEqual({ checked: false, disabled: true });
    expect(pressableByLabel(r, 'Automatic backups').props.onPress).toBeUndefined();
  });

  test('Stepper is one adjustable element with a spoken value and increment / decrement', () => {
    const onChange = jest.fn();
    const r = render(
      h(Stepper, {
        value: 10,
        onChange,
        max: 11,
        label: 'New cards per day',
        valueLabel: (v: number) => `${v} new cards per day`,
      }),
    );
    const st = byLabel(r, 'New cards per day');
    expect(st.props.accessibilityRole).toBe('adjustable');
    expect(st.props.accessibilityValue).toEqual({ text: '10 new cards per day' });
    expect(st.props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual(['increment', 'decrement']);
    act(() => st.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    expect(onChange).toHaveBeenLastCalledWith(11);
    act(() => st.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
    expect(onChange).toHaveBeenLastCalledWith(9);

    // At the max, "increment" changes nothing.
    onChange.mockClear();
    act(() => r.update(h(Stepper, { value: 11, onChange, max: 11, label: 'New cards per day' })));
    act(() => byLabel(r, 'New cards per day').props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    expect(onChange).not.toHaveBeenCalled();
    expect(byLabel(r, 'New cards per day').props.accessibilityValue).toEqual({ text: '11' });
  });

  test('Stepper: "increment" never lowers a stored value above max; "decrement" never raises one below min', () => {
    const onChange = jest.fn();
    const r = render(h(Stepper, { value: 1000, onChange, max: 999, label: 'New cards per day' }));
    const action = (actionName: string) =>
      act(() => byLabel(r, 'New cards per day').props.onAccessibilityAction({ nativeEvent: { actionName } }));
    action('increment');
    expect(onChange).not.toHaveBeenCalled();
    action('decrement');
    expect(onChange).toHaveBeenLastCalledWith(999);

    onChange.mockClear();
    act(() => r.update(h(Stepper, { value: -3, onChange, min: 0, label: 'New cards per day' })));
    action('decrement');
    expect(onChange).not.toHaveBeenCalled();
    action('increment');
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  // Wave 5e F1-4 (device pass 2026-11-02): the options were "tab"s with `selected`, which
  // Android shows as a plain View ("class View with no role"). Now: a labelled radio group
  // of radio buttons with `checked` (Android: RadioButton, "radio button, checked").
  test('SegCtrl: a labelled radio group of radio buttons, the chosen one checked', () => {
    const onChange = jest.fn();
    const r = render(
      h(SegCtrl, {
        label: 'Status',
        value: 'queue',
        onChange,
        options: [
          { id: 'notStarted', label: 'Not started' },
          { id: 'queue', label: 'In queue' },
          { id: 'known', label: 'Known' },
        ],
      }),
    );
    expect(byLabel(r, 'Status').props.accessibilityRole).toBe('radiogroup');
    const radios = byRole(r, 'radio');
    expect(radios.map((t) => [t.props.accessibilityLabel, t.props.accessibilityState])).toEqual([
      ['Not started', { checked: false }],
      ['In queue', { checked: true }],
      ['Known', { checked: false }],
    ]);
    // No option is a "tab" any more (that role is a plain View on Android).
    expect(byRole(r, 'tab')).toHaveLength(0);
    expect(byRole(r, 'tablist')).toHaveLength(0);
    act(() => pressableByLabel(r, 'Known').props.onPress());
    expect(onChange).toHaveBeenCalledWith('known');
  });

  test('SegCtrl: every option is a touch target of at least 44 pt, in both sizes, at every font size', () => {
    const options = [
      { id: 'notStarted', label: 'Not started' },
      { id: 'known', label: 'Known' },
    ];
    const props = { label: 'Status', value: 'known', onChange: () => undefined, options };
    // Wave 5e F1 (review round 1): the slop now follows the font size (a larger text makes
    // the option taller, so it needs less slop: segOptionSpace). At 1 this is the same check
    // as before; 1.3 and 2 are new.
    try {
      for (const fontScale of [1, 1.3, 2]) {
        setFontScale(fontScale);
        const r = render(h(SegCtrl, { ...props, size: 'sm' }));
        for (const size of ['sm', 'md'] as const) {
          act(() => r.update(h(SegCtrl, { ...props, size })));
          for (const o of options) {
            const tab = pressableByLabel(r, o.label);
            const slop = tab.props.hitSlop as { top: number; bottom: number };
            expect(slop.top).toBe(slop.bottom);
            const pad = flat(tab.props.style).paddingVertical as number;
            // Text of 12.5 pt or more is at least 16 pt high at the normal font size, 16 × the
            // font scale at another size: 2 × slop + 2 × padding + 16 × scale ≥ 44.
            expect(2 * slop.top + 2 * pad + 16 * fontScale).toBeGreaterThanOrEqual(MIN_TOUCH);
          }
        }
        act(() => r.unmount());
        renderer = null;
      }
    } finally {
      setFontScale(START_DIMENSIONS.window.fontScale);
    }
  });
});

describe('badges', () => {
  test('StateDot is hidden from screen readers; Not started is an outline dot', () => {
    const r = render(h(StateDot, { state: 'notStarted' }));
    const dot = r.root.findByType(View);
    expect(dot.props.accessibilityElementsHidden).toBe(true);
    expect(dot.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(flat(dot.props.style)).toMatchObject({ backgroundColor: light.paperSunk, borderWidth: 1, borderColor: light.ink3 });
    act(() => r.update(h(StateDot, { state: 'known' })));
    expect(flat(r.root.findByType(View).props.style)).toMatchObject({ backgroundColor: light.state.mastered.fg });
  });

  test('StateBadge: its status word is read, its glyph is hidden', () => {
    const r = render(h(StateBadge, { state: 'known', label: 'Known' }));
    expect(allText(r)).toBe('Known');
    const hidden = r.root.findAll((n) => n.type === View && n.props.importantForAccessibility === 'no-hide-descendants');
    expect(hidden).toHaveLength(1);
  });

  test('DeckTag shows the source label; no source, no tag', () => {
    const r = render(h(DeckTag, { source: 'apkg' }));
    expect(allText(r)).toContain('Imported');
    act(() => r.update(h(DeckTag, { source: 'pack' })));
    expect(allText(r)).toContain('Starter deck');
    act(() => r.update(h(DeckTag, { source: 'manual' })));
    expect(allText(r)).toContain('Your deck');
    act(() => r.update(h(DeckTag, { source: 'migrated' })));
    expect(allText(r)).toContain('Your deck');
    act(() => r.update(h(DeckTag, {})));
    expect(r.toJSON()).toBeNull();
  });

  test('DeckTile: a seal for starter and imported decks, none for your own', () => {
    const seals = (r: ReactTestRenderer) =>
      r.root.findAll((n) => n.type === View && n.props.importantForAccessibility === 'no-hide-descendants');
    const r = render(h(DeckTile, { icon: '🇩🇪', source: 'ankiweb' }));
    expect(seals(r)).toHaveLength(1);
    act(() => r.update(h(DeckTile, { icon: '🇩🇪', source: 'manual' })));
    expect(seals(r)).toHaveLength(0);
    act(() => r.update(h(DeckTile, { icon: '🇩🇪', source: 'pack' })));
    expect(seals(r)).toHaveLength(1);
    act(() => r.update(h(DeckTile, { icon: '🇩🇪', source: 'migrated' })));
    expect(seals(r)).toHaveLength(0);
  });

  test('FacetBadge draws B1 in the CEFR B1 colours and reads "Level: B1"', () => {
    const r = render(h(FacetBadge, { value: 'B1', label: 'Level' }));
    const pill = () => r.root.findAllByType(View)[0];
    expect(flat(pill().props.style).backgroundColor).toBe(light.cefr.B1.tint);
    expect(flat(r.root.findByType(Text).props.style).color).toBe(light.cefr.B1.fg);
    expect(r.root.findByType(Text).props.accessibilityLabel).toBe('Level: B1');
    act(() => r.update(h(FacetBadge, { value: 'B1', label: 'Room', kind: null })));
    expect(flat(pill().props.style).backgroundColor).toBe(light.paperSunk);
    expect(r.root.findByType(Text).props.accessibilityLabel).toBe('Room: B1');
  });

  test('a neutral FacetBadge is the kit Pill (spec §8.13): the same tree, the label kept', () => {
    const r = render(h(FacetBadge, { value: 'noun', label: 'Type' }));
    const badge = r.toJSON();
    act(() => r.update(h(Pill, { label: 'Type: noun', children: 'noun' })));
    expect(r.toJSON()).toEqual(badge);
    expect(r.root.findByType(Text).props.accessibilityLabel).toBe('Type: noun');
    // Without a label a Pill reads its own text.
    act(() => r.update(h(Pill, { children: 'noun' })));
    expect(r.root.findByType(Text).props.accessibilityLabel).toBeUndefined();
  });
});

describe('TermText', () => {
  const nested = (r: ReactTestRenderer) => r.root.findAllByType(Text).filter((t) => t !== r.root.findAllByType(Text)[0]);

  test('the article is drawn in its gender colour, the rest stays as styled', () => {
    const r = render(h(TermText, { text: 'die Abfahrt', lang: 'de-DE' }));
    const parts = nested(r);
    expect(parts).toHaveLength(1);
    expect(parts[0].props.children).toBe('die');
    expect(parts[0].props.style).toEqual({ color: light.danger, backgroundColor: undefined });
    expect(r.root.findAllByType(Text)[0].props.children).toEqual([expect.anything(), ' Abfahrt']);
  });

  test('tint puts the gender tint behind the article; colours off = plain text', () => {
    const r = render(h(TermText, { text: 'der Tag', lang: 'de-DE', tint: true }));
    expect(nested(r)[0].props.style).toEqual({ color: light.info, backgroundColor: light.infoTint });
    act(() => r.update(h(TermText, { text: 'der Tag', lang: 'de-DE', genderColors: false })));
    expect(nested(r)).toHaveLength(0);
    expect(allText(r)).toBe('');
    expect(r.root.findByType(Text).props.children).toEqual(['der Tag']);
  });
});

describe('FieldRows', () => {
  test('one element per shown field, read "Label: value"; hidden fields are skipped', () => {
    const r = render(
      h(FieldRows, {
        blocks: [
          block(0, 'Grammar', 'detail', '-n'),
          block(1, 'Example', 'example', 'Die Reise war lang.'),
          block(2, 'Secret', 'hidden', 'never shown'),
          block(3, 'Level', 'badge', 'B1'),
        ],
      }),
    );
    for (const label of ['Grammar: -n', 'Example: Die Reise war lang.', 'Level: B1']) {
      expect(byLabel(r, label).props.accessible).toBe(true);
    }
    expect(allText(r)).not.toContain('never shown');
  });

  test('inline bold is a bold font; each line of a field is its own line', () => {
    const conj: FieldBlock = {
      field: 0,
      label: 'Conjugation',
      role: 'detail',
      lines: [
        [{ t: 'text', text: 'ich ' }, { t: 'text', text: 'bin', b: true }],
        [{ t: 'text', text: 'du bist' }],
      ],
      plain: 'ich bin du bist',
    };
    const r = render(h(FieldRows, { blocks: [conj], variant: 'stacked' }));
    const bold = r.root.findAllByType(Text).find((t) => t.props.children === 'bin');
    expect(bold?.props.style).toEqual(font('sans', 700));
    expect(allText(r)).toContain('du bist');
  });

  test('inline italic in a sans field is drawn slanted', () => {
    const perfekt: FieldBlock = {
      field: 0,
      label: 'Perfekt',
      role: 'detail',
      lines: [[{ t: 'text', text: 'Perfekt: ' }, { t: 'text', text: 'ist gewesen', i: true }]],
      plain: 'Perfekt: ist gewesen',
    };
    const r = render(h(FieldRows, { blocks: [perfekt] }));
    const texts = r.root.findAllByType(Text);
    expect(texts.find((t) => t.props.children === 'ist gewesen')?.props.style).toMatchObject({ fontStyle: 'italic' });
    expect(texts.find((t) => t.props.children === 'Perfekt: ')?.props.style.fontStyle).toBeUndefined();
  });

  test('images are drawn by the caller only', () => {
    const pic: FieldBlock = { field: 0, label: 'Picture', role: 'detail', lines: [[{ t: 'img', src: 'a.png' }]], plain: '' };
    const r = render(h(FieldRows, { blocks: [pic] }));
    expect(r.toJSON()).toBeNull();
    const renderImage = jest.fn((src: string, key: string) => h(Text, { key }, `img:${src}`));
    act(() => r.update(h(FieldRows, { blocks: [pic], renderImage })));
    expect(renderImage).toHaveBeenCalledWith('a.png', '0:0');
    expect(allText(r)).toContain('img:a.png');
  });
});

describe('FacetBars', () => {
  test('rows read their summary; the ⋯ is its own labelled button', () => {
    const onPressRow = jest.fn();
    const onMoreRow = jest.fn();
    const rows = [
      { value: 'a1', label: 'A1', known: 1530 },
      { value: 'b1', label: 'B1', mastered: 130, review: 400, learning: 50, neww: 544, notStarted: 500 },
    ];
    const r = render(h(FacetBars, { group: 'Level', kind: 'cefr', rows, onPressRow, onMoreRow }));
    expect(allText(r)).toContain('By level');
    expect(allText(r)).toContain('8% mastered · 1,624 cards');
    const b1 = byLabel(r, 'Level B1: 8 percent mastered, 1,624 cards');
    expect(b1.props.accessibilityRole).toBe('button');
    act(() => pressableByLabel(r, 'Level B1: 8 percent mastered, 1,624 cards').props.onPress());
    expect(onPressRow).toHaveBeenCalledWith(rows[1]);
    act(() => pressableByLabel(r, 'Actions for Level A1').props.onPress());
    expect(onMoreRow).toHaveBeenCalledWith(rows[0]);
  });

  test('without a row action the summary is not a button', () => {
    const r = render(h(FacetBars, { group: 'Level', rows: [{ value: 'a1', label: 'A1', known: 3 }] }));
    const row = byLabel(r, 'Level A1: Known, 3 cards');
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(byRole(r, 'button')).toHaveLength(0);
  });
});

describe('ResultActions component', () => {
  test('one small button per shown action', () => {
    const study = jest.fn();
    const r = render(
      h(ResultActions, {
        actions: [
          { key: 'study', label: 'Study 34', onPress: study },
          { key: 'choose', label: 'Choose (0)', onPress: () => undefined, hidden: true },
          { key: 'practice', label: 'Practice 30', onPress: () => undefined, hint: 'Doesn’t change your schedule.' },
        ],
      }),
    );
    expect(byRole(r, 'button').map((b) => b.props.accessibilityLabel)).toEqual(['Study 34', 'Practice 30']);
    expect(byLabel(r, 'Practice 30').props.accessibilityHint).toBe('Doesn’t change your schedule.');
    act(() => pressableByLabel(r, 'Study 34').props.onPress());
    expect(study).toHaveBeenCalledTimes(1);
  });
});

describe('charts (summary labels)', () => {
  test('with a label a chart is one element; without one it is hidden decoration', () => {
    const r = render(h(SegBar, { mastered: 1, neww: 3, label: 'Level B1: 25 percent mastered' }));
    expect(byLabel(r, 'Level B1: 25 percent mastered').props.accessible).toBe(true);
    act(() => r.update(h(SegBar, { mastered: 1, neww: 3 })));
    expect(r.root.findAllByType(View)[0].props.importantForAccessibility).toBe('no-hide-descendants');
  });

  test('Bar with a label is a progressbar with its value', () => {
    const r = render(h(Bar, { value: 40, label: 'Reviews: 12 of 30 goal' }));
    const bar = byLabel(r, 'Reviews: 12 of 30 goal');
    expect(bar.props.accessibilityRole).toBe('progressbar');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 40 });
  });
});

// Wave 5i: the full-screen picture moved out of StudyCard.tsx into the kit, so the CardSheet
// opens the same one (the study card and CardSheet tests open it from their pictures).
describe('ImageViewer: one picture full screen (shared by the study card and the CardSheet)', () => {
  test('hidden without a picture; shown with one, on the opaque paperSunk backdrop and the light image well', () => {
    const onClose = jest.fn<() => void>();
    const r = render(h(ImageViewer, { uri: null, onClose }));
    expect(r.root.findByType(Modal).props.visible).toBe(false);
    act(() => r.update(h(ImageViewer, { uri: 'file:///media/d1/trip.png', onClose })));
    const modal = r.root.findByType(Modal);
    expect(modal.props).toMatchObject({ visible: true, transparent: true, animationType: 'fade' });
    // The backdrop is the full-screen "Close image" button, opaque (K1-4: no card picture shows through).
    const backdrop = r.root.find(
      (n) => typeof n.type === 'string' && n.props.accessibilityLabel === CLOSE_IMAGE_LABEL && flat(n.props.style).flex === 1,
    );
    expect(flat(backdrop.props.style).backgroundColor).toBe(light.paperSunk);
    // The picture, and its well once its shape is known (a 1:1 picture in a 300 × 600 space).
    const image = r.root.find((n) => n.type === ('ExpoImage' as unknown));
    expect(image.props.source).toEqual({ uri: 'file:///media/d1/trip.png' });
    const area = r.root.find((n) => typeof n.type === 'string' && typeof n.props.onLayout === 'function');
    act(() => area.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 600 } } }));
    act(() => image.props.onLoad({ source: { width: 500, height: 500 } }));
    // (In Paper the well and the backdrop have the same colour: the well is the box with a size.)
    const wells = r.root
      .findAll((n) => typeof n.type === 'string' && flat(n.props.style).backgroundColor === light.imageWell)
      .map((n) => flat(n.props.style))
      .filter((style) => typeof style.width === 'number');
    expect(wells).toEqual([expect.objectContaining({ width: 300, height: 300 })]);
  });

  test('a tap on the backdrop, the ✕ button and Android\'s Back each close it', () => {
    const onClose = jest.fn<() => void>();
    const r = render(h(ImageViewer, { uri: 'file:///media/d1/trip.png', onClose }));
    const close = r.root.findAll((n) => typeof n.type !== 'string' && n.props.label === CLOSE_IMAGE_LABEL && n.props.icon === 'close');
    expect(close).toHaveLength(1);
    expect(close[0].props.color).toBe(light.ink);
    act(() => close[0].props.onPress());
    act(() => pressableByLabel(r, CLOSE_IMAGE_LABEL).props.onPress());
    act(() => r.root.findByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(OPEN_IMAGE_HINT).toBe('Shows the image full screen');
  });

  test('containSize: the picture\'s own shape, as big as fits the box; null while unknown', () => {
    expect(containSize({ width: 300, height: 600 }, 1)).toEqual({ width: 300, height: 300 });
    expect(containSize({ width: 300, height: 100 }, 1)).toEqual({ width: 100, height: 100 });
    expect(containSize({ width: 300, height: 600 }, null)).toBeNull();
  });
});

/* ====================================================== Reduce Motion */

describe('Reduce Motion (spec §8.12)', () => {
  afterEach(async () => {
    await setReduceMotion(false);
  });

  /** The opacity of RiseIn's Animated.View (its host View). */
  function riseOpacity(r: ReactTestRenderer): unknown {
    return flat(r.root.findAllByType(View)[0].props.style).opacity;
  }

  test('RiseIn starts hidden and animates when motion is allowed', async () => {
    await setReduceMotion(false);
    jest.useFakeTimers();
    const r = render(h(RiseIn, null, h(Text, null, 'hello')));
    expect(riseOpacity(r)).toBe(0);
  });

  test('RiseIn renders at once with Reduce Motion on', async () => {
    await setReduceMotion(true);
    jest.useFakeTimers();
    const r = render(h(RiseIn, null, h(Text, null, 'hello')));
    expect(riseOpacity(r)).toBe(1);
  });

  /** translateY and opacity of the sheet panel (the modal view). */
  function panel(r: ReactTestRenderer): { translateY: number; opacity: unknown } {
    const view = r.root.find((n) => typeof n.type === 'string' && n.props.accessibilityViewIsModal === true);
    const style = flat(view.props.style);
    const transform = style.transform as { translateY: number }[];
    return { translateY: transform[0].translateY, opacity: style.opacity };
  }

  test('Sheet slides up when motion is allowed', async () => {
    await setReduceMotion(false);
    jest.useFakeTimers();
    const r = render(h(Sheet, { open: true, onClose: () => undefined, title: 'Add', children: h(Text, null, 'body') }));
    const p = panel(r);
    expect(p.translateY).toBeGreaterThan(0); // starts below, slides to 0
    expect(p.opacity).toBe(1);
  });

  test('Sheet fades instead of sliding with Reduce Motion on', async () => {
    await setReduceMotion(true);
    jest.useFakeTimers();
    const r = render(h(Sheet, { open: true, onClose: () => undefined, title: 'Add', children: h(Text, null, 'body') }));
    const p = panel(r);
    expect(p.translateY).toBe(0); // no slide
    expect(p.opacity).toBe(0); // fades in from 0
  });

  test('Sheet: header title, a "Close" scrim, escape closes', async () => {
    const onClose = jest.fn();
    jest.useFakeTimers();
    const r = render(h(Sheet, { open: true, onClose, title: 'Add', children: h(Text, null, 'body') }));
    const title = byRole(r, 'header');
    expect(title).toHaveLength(1);
    expect(title[0].props.children).toBe('Add');
    expect(SHEET_CLOSE_LABEL).toBe('Close');
    act(() => pressableByLabel(r, 'Close').props.onPress());
    const modal = r.root.find((n) => typeof n.type === 'string' && n.props.accessibilityViewIsModal === true);
    act(() => modal.props.onAccessibilityEscape());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

/* ============================================== 3. every icon button has a name */

/** Every .tsx file (not a test) under `dir`. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * The text of a JSX attribute when it is a fixed string (`label="Back"`,
 * label={'Back'}, label={`Back`}), else null (a variable or an expression).
 */
function fixedText(value: ts.JsxAttributeValue | undefined): string | null {
  if (!value) return null;
  if (ts.isStringLiteral(value)) return value.text;
  const e = ts.isJsxExpression(value) ? value.expression : undefined;
  if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
  return null;
}

// SegCtrl joined in wave 5e F1-4 (review round 1): its `label` names the radio group.
describe('every IconBtn, FAB, Toggle and SegCtrl in the app has a real name (W5-2, spec §8.12, emulator E9)', () => {
  test('TypeScript makes `label` present; no call site passes an empty one', () => {
    const SRC = path.resolve(__dirname, '..', '..');
    const files = [...tsxFiles(path.join(SRC, 'app')), ...tsxFiles(path.join(SRC, 'components'))];
    const bad: string[] = [];
    let seen = 0;
    let segCtrls = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: ts.Node): void => {
        if (
          (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
          /^(IconBtn|FAB|Toggle|SegCtrl)$/.test(n.tagName.getText(sf))
        ) {
          seen += 1;
          if (n.tagName.getText(sf) === 'SegCtrl') segCtrls += 1;
          const props = n.attributes.properties;
          const label = props.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'label');
          const spread = props.some((p) => ts.isJsxSpreadAttribute(p));
          const fixed = fixedText(label?.initializer);
          if ((!label && !spread) || (fixed !== null && fixed.trim() === '')) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            bad.push(`${path.relative(SRC, file)}:${line}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    // The scan really found the app's icon buttons and segmented controls (a wrong path would pass with 0).
    expect(seen).toBeGreaterThan(10);
    expect(segCtrls).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
});

describe('Ion: an icon is never read by a screen reader', () => {
  test('the glyph is hidden from TalkBack (and so from a row’s composed label) and from VoiceOver', () => {
    const { Ion } = jest.requireActual<typeof import('./Ion')>('./Ion');
    let r: ReactTestRenderer | null = null;
    act(() => {
      r = TestRenderer.create(React.createElement(Ion, { name: 'search', size: 16 }));
    });
    // The vector-icons component Ion renders (not Ion itself).
    const icon = r!.root.find((n) => n.type !== Ion && typeof n.type !== 'string' && n.props.name === 'search');
    expect(icon.props.accessible).toBe(false);
    expect(icon.props.importantForAccessibility).toBe('no');
    expect(icon.props.accessibilityElementsHidden).toBe(true);
    act(() => r!.unmount());
  });
});

/* ================================= 4. the largest font size (wave 5e F1) */

/** Every Text (host) whose own string is `text`. */
function textsOf(r: ReactTestRenderer, text: string): ReactTestInstance[] {
  return r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text);
}

/** The one Text (host) that draws `text`. */
function textOf(r: ReactTestRenderer, text: string): ReactTestInstance {
  const found = textsOf(r, text);
  if (found.length !== 1) throw new Error(`expected one Text "${text}", found ${found.length}`);
  return found[0];
}

/** True when the Text may take more than one line (no numberOfLines, or 2 and more). */
function wraps(t: ReactTestInstance): boolean {
  const n = t.props.numberOfLines as number | undefined;
  return n === undefined || n === 0 || n > 1;
}

/** The nearest host View above `node` (its parent row or column). */
function hostParent(node: ReactTestInstance): ReactTestInstance {
  let p = node.parent;
  while (p && (p.type as unknown) !== 'View') p = p.parent;
  if (!p) throw new Error('no host View above');
  return p;
}

/** A Pressable's style as one flat object (a style function is called "not pressed"). */
function pressableStyle(node: ReactTestInstance): Record<string, unknown> {
  const style = node.props.style as unknown;
  return flat(typeof style === 'function' ? style({ pressed: false }) : style);
}

describe('largest font size (wave 5e F1): what says the font size is large', () => {
  afterEach(() => {
    setFontScale(START_DIMENSIONS.window.fontScale);
  });

  test('isLargeText: Android "Larger" (1.3) and up; not the default or "Large"', () => {
    expect(LARGE_TEXT_SCALE).toBe(1.3);
    expect(isLargeText(0.85)).toBe(false);
    expect(isLargeText(1)).toBe(false);
    expect(isLargeText(1.15)).toBe(false);
    expect(isLargeText(1.3)).toBe(true);
    expect(isLargeText(1.5)).toBe(true);
    expect(isLargeText(2)).toBe(true);
    // Not a real scale: the default size.
    expect(isLargeText(Number.NaN)).toBe(false);
    expect(isLargeText(0)).toBe(false);
  });

  test('useLargeText reads the font scale of the window', () => {
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useLargeText());
      return null;
    };
    setFontScale(2);
    const first = render(h(Probe));
    act(() => first.unmount());
    renderer = null;
    setFontScale(1);
    render(h(Probe));
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});

describe('largest font size (wave 5e F1-3): ListRow wraps; the Overline can', () => {
  test('a ListRow title and sub are never limited to one line ("Speak the question a..")', () => {
    const r = render(
      h(ListRow, {
        icon: 'mic-outline',
        title: 'Speak the question automatically',
        sub: 'Reads each card aloud when it appears',
        onPress: () => undefined,
      }),
    );
    expect(wraps(textOf(r, 'Speak the question automatically'))).toBe(true);
    expect(wraps(textOf(r, 'Reads each card aloud when it appears'))).toBe(true);
    // Still one button that reads its texts.
    expect(byRole(r, 'button')).toHaveLength(1);
  });

  test('Overline: one line by default; `lines` lets Today’s date take two', () => {
    const r = render(h(Overline, { children: 'Saturday 24 October' }));
    expect(textOf(r, 'Saturday 24 October').props.numberOfLines).toBe(1);
    act(() => r.update(h(Overline, { lines: 2, children: 'Saturday 24 October' })));
    expect(textOf(r, 'Saturday 24 October').props.numberOfLines).toBe(2);
  });
});

describe('largest font size (wave 5e F1-4): SegCtrl labels are never cut', () => {
  const MODES = [
    { id: 'flashcards', label: 'Flashcards' },
    { id: 'typing', label: 'Typing' },
    { id: 'quiz', label: 'Quiz' },
    { id: 'mixed', label: 'Mixed' },
  ];

  test('segMinWidth: a little less than an even share, so the options of one row always fit', () => {
    expect(segMinWidth(2)).toBe('49.5%');
    expect(segMinWidth(3)).toBe('32.83%');
    expect(segMinWidth(4)).toBe('24.5%');
    expect(segMinWidth(1)).toBe('99.5%');
    expect(segMinWidth(0)).toBe('99.5%'); // never a division by 0
    for (let n = 1; n <= 8; n++) expect(n * parseFloat(segMinWidth(n))).toBeLessThan(100);
  });

  test('the labels are not limited to one line ("Flash.."), and the control wraps onto a second row', () => {
    for (const size of ['sm', 'md'] as const) {
      const r = render(h(SegCtrl, { label: 'Default mode', size, value: 'quiz', onChange: () => undefined, options: MODES }));
      for (const o of MODES) expect(wraps(textOf(r, o.label))).toBe(true);
      expect(flat(byLabel(r, 'Default mode').props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
      // Each option: as wide as its label needs, at least an even share, never wider than the control.
      for (const o of MODES) {
        expect(flat(pressableByLabel(r, o.label).props.style)).toMatchObject({
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 'auto',
          minWidth: segMinWidth(MODES.length),
          maxWidth: '100%',
        });
      }
      act(() => r.unmount());
      renderer = null;
    }
  });

  test('at the normal font size a one-row control is still a full pill', () => {
    // The frame's corner radius is at least half the height of one row
    // (3 + the option's padding + one text line + 3), so its ends stay round.
    for (const [size, fontSize] of [['sm', 12.5], ['md', 13.5]] as const) {
      const r = render(h(SegCtrl, { label: 'Range', size, value: 'quiz', onChange: () => undefined, options: MODES }));
      const radius = flat(byLabel(r, 'Range').props.style).borderRadius as number;
      const rowHeight = 2 * 3 + 2 * segOptionSpace(size).padV + 1.303 * fontSize;
      expect(radius).toBeGreaterThanOrEqual(rowHeight / 2);
      act(() => r.unmount());
      renderer = null;
    }
  });

  // Review round 1: with `rowGap: 2`, the top slop of "Mixed" (row 2, which Android checks
  // first) reached 6 pt into "Flashcards · Typing · Quiz" (row 1): a tap on their bottom
  // edge changed the Default mode to Mixed.
  test('a wrapping control: the rows are far enough apart that no slop covers an option of the other row', () => {
    try {
      for (const fontScale of [1, 2]) {
        setFontScale(fontScale);
        for (const size of ['sm', 'md'] as const) {
          const r = render(h(SegCtrl, { label: 'Default mode', size, value: 'quiz', onChange: () => undefined, options: MODES }));
          const gap = flat(byLabel(r, 'Default mode').props.style).rowGap as number;
          for (const o of MODES) {
            const slop = pressableByLabel(r, o.label).props.hitSlop as { top: number; bottom: number };
            // The bottom slop of an option above + the top slop of an option below fit in the gap.
            expect(gap).toBeGreaterThanOrEqual(slop.top + slop.bottom);
            expect(slop).toEqual({ top: segOptionSpace(size, fontScale).slopV, bottom: segOptionSpace(size, fontScale).slopV });
          }
          act(() => r.unmount());
          renderer = null;
        }
      }
    } finally {
      setFontScale(START_DIMENSIONS.window.fontScale);
    }
  });
});

describe('largest font size (wave 5e F1-5): FacetBars lines wrap', () => {
  test('"0% mastered · 64 cards" is not limited to one line; the bar part wraps under a long badge', () => {
    const rows = [{ value: 'dp', label: 'Dynamic Programming', neww: 64 }];
    const r = render(h(FacetBars, { group: 'Section', rows, onPressRow: () => undefined, onMoreRow: () => undefined }));
    const line = textOf(r, '0% mastered · 64 cards');
    expect(wraps(line)).toBe(true);
    // The bar part (the line's column) is at least BAR_MIN_WIDTH, in a row that wraps.
    expect(BAR_MIN_WIDTH).toBe('50%');
    expect(flat(hostParent(line).props.style)).toMatchObject({ flexGrow: 1, flexBasis: 0, minWidth: BAR_MIN_WIDTH });
    const row = pressableByLabel(r, 'Section Dynamic Programming: 0 percent mastered, 64 cards');
    expect(pressableStyle(row)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
  });
});

describe('largest font size (wave 5e F1-6): StatusBarStrip', () => {
  afterEach(() => {
    mockInsets.top = 0;
  });

  test('a solid strip of the page colour, as high as the status bar; it takes the touches; a screen reader skips it', () => {
    mockInsets.top = 24;
    const r = render(h(StatusBarStrip));
    const strip = r.root.findByType(View);
    expect(flat(strip.props.style)).toMatchObject({
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 24,
      backgroundColor: light.paper,
    });
    // Review round 1: it TAKES the touches in its area (pointerEvents 'auto', the default),
    // so a tap there never reaches a row that has scrolled under it and cannot be seen.
    const pointerEvents = [flat(strip.props.style).pointerEvents, strip.props.pointerEvents];
    for (const value of pointerEvents) expect(value === undefined || value === 'auto').toBe(true);
    expect(strip.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(strip.props.accessibilityElementsHidden).toBe(true);
  });

  test('no top inset (no status bar over the app): nothing is drawn', () => {
    mockInsets.top = 0;
    const r = render(h(StatusBarStrip));
    expect(r.toJSON()).toBeNull();
  });
});

describe('largest font size (wave 5e F1-1): Today’s goal numbers are never cut', () => {
  afterEach(() => {
    setFontScale(START_DIMENSIONS.window.fontScale);
  });

  const bars = goalBars({ reviews: 120, neww: 10 }, { goalReviews: 300, goalNew: 20 });

  /** The numbers are never limited to one line; they go under the label when the two do not fit. */
  const expectNumbersWrap = (r: ReactTestRenderer) => {
    for (const text of ['120 / 300 goal', '10 / 20 goal']) {
      expect(wraps(textOf(r, text))).toBe(true);
      expect(flat(hostParent(textOf(r, text)).props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    }
  };

  // Review round 1: with flexBasis 'auto' each bar was as wide as its own text, so the two bars
  // had different lengths, and on a 360 dp phone they stacked at the NORMAL font size.
  test('normal font size: the two bars side by side, the same width each (flex: 1)', () => {
    setFontScale(1);
    const r = render(h(GoalBars, { bars }));
    const reviews = byLabel(r, 'Reviews: 120 of 300 goal');
    const neww = byLabel(r, 'New: 10 of 20 goal');
    expect(flat(hostParent(reviews).props.style)).toMatchObject({ flexDirection: 'row' });
    expect(flat(hostParent(reviews).props.style).flexWrap).toBeUndefined();
    expect(flat(reviews.props.style)).toEqual({ flex: 1 });
    expect(flat(neww.props.style)).toEqual({ flex: 1 });
    expectNumbersWrap(r);
  });

  test('large font size: one bar under the other, each the full width', () => {
    setFontScale(2);
    const r = render(h(GoalBars, { bars }));
    const reviews = byLabel(r, 'Reviews: 120 of 300 goal');
    expect(flat(hostParent(reviews).props.style)).toMatchObject({ flexDirection: 'column' });
    expect(flat(reviews.props.style)).toEqual({ width: '100%' });
    expect(flat(byLabel(r, 'New: 10 of 20 goal').props.style)).toEqual({ width: '100%' });
    expectNumbersWrap(r);
  });
});

describe('largest font size (wave 5e F1-2): Today’s deck names wrap', () => {
  afterEach(() => {
    setFontScale(START_DIMENSIONS.window.fontScale);
  });

  const ready = (total: number): ReadyCounts => ({
    total,
    learning: 0,
    due: 0,
    checks: 0,
    neww: total,
    mins: 1,
    capped: false,
    uncappedTotal: total,
  });
  const summary = (total: number): DeckSummary => ({
    total,
    life: { notStarted: 0, new: total, learning: 0, review: 0, mastered: 0, known: 0 },
    dueNow: 0,
    ready: ready(total),
  });
  const everyday: Deck = makeDeckV3({ id: 'd-everyday', name: 'German — Everyday', icon: '🇩🇪' });
  const conversation: Deck = makeDeckV3({ id: 'd-conv', name: 'German — Conversation', icon: '🇩🇪' });
  const stats = new Map([
    [everyday.id, summary(39)],
    [conversation.id, summary(21)],
  ]);
  const draw = () =>
    render(
      h(DeckRows, {
        active: [everyday, conversation],
        paused: [],
        stats,
        hero: ready(50),
        showPaused: false,
        onTogglePaused: () => undefined,
      }),
    );

  test('todayNameLines: 2 lines, 3 at a large font size', () => {
    expect(todayNameLines(false)).toBe(2);
    expect(todayNameLines(true)).toBe(3);
  });

  test('normal font size: the name may take 2 lines; the pill is next to it', () => {
    setFontScale(1);
    const r = draw();
    for (const name of ['German — Everyday', 'German — Conversation']) {
      expect(textOf(r, name).props.numberOfLines).toBe(2);
    }
    expect(wraps(textOf(r, '39 new'))).toBe(true);
    // The row (name) and the pill sit side by side.
    const pill = pressableByLabel(r, 'Study 39 from German — Everyday');
    expect(flat(hostParent(pill).props.style)).toMatchObject({ flexDirection: 'row' });
  });

  test('largest font size: the name may take 3 lines; the pill moves under it', () => {
    setFontScale(2);
    const r = draw();
    for (const name of ['German — Everyday', 'German — Conversation']) {
      expect(textOf(r, name).props.numberOfLines).toBe(3);
    }
    const pill = pressableByLabel(r, 'Study 21 from German — Conversation');
    expect(flat(hostParent(pill).props.style)).toMatchObject({ flexDirection: 'column' });
    // Still two separate targets: the row and the pill.
    expect(byLabel(r, 'German — Conversation, 21 new').props.accessibilityRole).toBe('button');
    expect(byLabel(r, 'Study 21 from German — Conversation').props.accessibilityRole).toBe('button');
  });
});

describe('largest font size (wave 5e F1-2): Today’s list names wrap', () => {
  afterEach(() => {
    setFontScale(START_DIMENSIONS.window.fontScale);
  });

  const NAME = 'B1 verbs — irregular past forms';
  const row: ListRowModel = {
    list: { id: 'l-verbs', name: NAME, icon: '⭐', query: {}, createdAt: 0, updatedAt: 0 },
    builtin: false,
    pref: { pinned: true, hidden: false, order: 0 },
    count: 64,
    stats: { count: 64, due: 6, ready: 6 },
  };
  const draw = () =>
    render(h(ListRowView, { row, onOpen: () => undefined, onStudy: () => undefined, onMenu: () => undefined, last: true }));

  test('normal font size: the name may take 2 lines; the pill and "⋯" sit next to it', () => {
    setFontScale(1);
    const r = draw();
    expect(textOf(r, NAME).props.numberOfLines).toBe(2);
    expect(wraps(textOf(r, '64 cards · 6 due'))).toBe(true);
    const pill = pressableByLabel(r, `Study 6 from ${NAME}`);
    const menu = pressableByLabel(r, `Actions for ${NAME}`);
    // One row: the name, the pill and the "⋯" button side by side.
    expect(hostParent(pill)).toBe(hostParent(menu));
    expect(flat(hostParent(pill).props.style)).toMatchObject({ flexDirection: 'row' });
  });

  test('largest font size: the name may take 3 lines; the pill moves under it, "⋯" stays in the row', () => {
    setFontScale(2);
    const r = draw();
    expect(textOf(r, NAME).props.numberOfLines).toBe(3);
    expect(wraps(textOf(r, '64 cards · 6 due'))).toBe(true);
    const pill = pressableByLabel(r, `Study 6 from ${NAME}`);
    const menu = pressableByLabel(r, `Actions for ${NAME}`);
    // The pill is a child of the outer column, under the row that holds the name and "⋯".
    expect(hostParent(pill)).not.toBe(hostParent(menu));
    expect(hostParent(hostParent(menu))).toBe(hostParent(pill));
    expect(flat(hostParent(pill).props.style).flexDirection).toBeUndefined();
    // Still three separate targets: the row, the pill and "⋯".
    expect(byLabel(r, `${NAME}, 64 cards · 6 due`).props.accessibilityRole).toBe('button');
    expect(byLabel(r, `Study 6 from ${NAME}`).props.accessibilityRole).toBe('button');
    expect(byLabel(r, `Actions for ${NAME}`).props.accessibilityRole).toBe('button');
  });
});

describe('largest font size (wave 5e F1-5): the deck page’s "Study {n}" and "Practice"', () => {
  test('buttonPairLayout at a large font size: one under the other, each the full width', () => {
    expect(buttonPairLayout(true)).toEqual({
      row: { flexDirection: 'column', gap: 10 },
      first: undefined,
      second: undefined,
    });
  });

  // Review round 1: below 1.3 the buttons stayed side by side at a fixed 1.6 : 1, so at 1.15 on a
  // 360 dp phone "Practice" (71 pt) got 67 pt and broke inside the word ("Practic" / "e").
  test('buttonPairLayout otherwise: a wrapping row; each button as wide as its label, at least its share', () => {
    const pair = buttonPairLayout(false);
    expect(pair.row).toEqual({ flexDirection: 'row', flexWrap: 'wrap', gap: 10 });
    expect(pair.first).toMatchObject({ flexGrow: 1.6, flexShrink: 1, flexBasis: 'auto', maxWidth: '100%' });
    expect(pair.second).toMatchObject({ flexGrow: 1, flexShrink: 1, flexBasis: 'auto', maxWidth: '100%' });
    const first = parseFloat(String(pair.first?.minWidth));
    const second = parseFloat(String(pair.second?.minWidth));
    // The two shares and the 10 pt gap fit in the narrowest row (a 320 dp phone: 280 pt), so two
    // short labels still sit side by side, about 1.6 : 1 as before …
    expect(first + second + (10 / 280) * 100).toBeLessThan(100);
    expect(first / second).toBeCloseTo(1.6, 1);
    // … and a button alone on its line takes the whole line (it grows; it never passes the edge).
    expect(pair.first?.flexGrow).toBeGreaterThan(0);
    expect(pair.second?.flexGrow).toBeGreaterThan(0);
  });

  test('a full Btn takes the pair style (the style comes last, so it wins over the base)', () => {
    const pair = buttonPairLayout(false);
    const r = render(h(Btn, { full: true, size: 'lg', lines: 2, style: pair.second, onPress: () => undefined, children: 'Practice' }));
    expect(pressableStyle(pressableByLabel(r, 'Practice'))).toMatchObject({ ...pair.second, alignSelf: 'stretch' });
    // The label may take 2 lines (a long "Study 12,345" alone on a small phone), never "…" on one.
    expect(textOf(r, 'Practice').props.numberOfLines).toBe(2);
  });
});

/* ------------------------------------------------ 4b. where the screens put things (source scans) */

/** The tag name of a JSX element (`<Page>…</Page>` or `<Page />`), else null. */
function jsxTagName(n: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isJsxElement(n)) return n.openingElement.tagName.getText(sf);
  if (ts.isJsxSelfClosingElement(n)) return n.tagName.getText(sf);
  return null;
}

/** Every JSX element (with children or self-closing) of a file whose tag is `tag`. */
function jsxElementsNamed(sf: ts.SourceFile, tag: string): (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  const out: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && jsxTagName(n, sf) === tag) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The text of a JSX attribute's `{expression}` (e.g. "studyPair.first"), else null. */
function attrExpression(n: ts.JsxElement | ts.JsxSelfClosingElement, name: string, sf: ts.SourceFile): string | null {
  const attrs = ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes;
  const attr = attrs.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
  const value = attr?.initializer;
  return value && ts.isJsxExpression(value) && value.expression ? value.expression.getText(sf) : null;
}

/** Parse one source file of src/ (path relative to src/). */
function sourceOf(rel: string): ts.SourceFile {
  const file = path.resolve(__dirname, '..', '..', rel);
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe('the status bar strip is drawn ON TOP of each screen’s scrolling view (wave 5e F1-6)', () => {
  // The views that scroll: the kit's Page, a ScrollView, the Library's FlatList.
  const SCROLLERS = new Set(['Page', 'ScrollView', 'FlatList']);
  const SCREENS = [
    'app/(tabs)/index.tsx',
    'app/(tabs)/library.tsx',
    'app/(tabs)/progress.tsx',
    'app/(tabs)/settings/index.tsx',
    'app/deck/[id].tsx',
  ];

  test.each(SCREENS)('%s: one <StatusBarStrip />, a sibling AFTER the scroll view (not inside it)', (rel) => {
    const sf = sourceOf(rel);
    const strips = jsxElementsNamed(sf, 'StatusBarStrip');
    expect(strips).toHaveLength(1);
    const strip = strips[0];
    // Not inside the scroll view: there it would scroll away with the content.
    for (let p: ts.Node | undefined = strip.parent; p; p = p.parent) {
      expect(SCROLLERS.has(jsxTagName(p, sf) ?? '')).toBe(false);
    }
    // A later sibling is drawn on top: the scroll view must come BEFORE the strip.
    const parent = strip.parent;
    if (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) throw new Error(`${rel}: the strip is not a JSX child`);
    const siblings = [...parent.children];
    const before = siblings.slice(0, siblings.indexOf(strip)).map((s) => jsxTagName(s, sf));
    expect(before.some((tag) => tag !== null && SCROLLERS.has(tag))).toBe(true);
  });
});

describe('the deck page lays out "Study {n}" and "Practice" with buttonPairLayout (wave 5e F1-5)', () => {
  test('the row and both buttons take the pair styles; the pair follows the font size', () => {
    const sf = sourceOf('app/deck/[id].tsx');
    expect(sf.getFullText()).toMatch(/const studyPair = buttonPairLayout\(large\);/);
    const rows = jsxElementsNamed(sf, 'View').filter((v) => attrExpression(v, 'style', sf) === 'studyPair.row');
    expect(rows).toHaveLength(1);
    // The two buttons inside that row: "Study {n}" (first) and "Practice" (second).
    const btnStyles: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && jsxTagName(n, sf) === 'Btn') {
        btnStyles.push(attrExpression(n, 'style', sf) ?? '');
      }
      ts.forEachChild(n, visit);
    };
    visit(rows[0]);
    expect(btnStyles).toEqual(['studyPair.first', 'studyPair.second']);
  });
});
