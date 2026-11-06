/**
 * Text contrast of the UI kit in BOTH themes (spec §8.12, WCAG 2.1 AA 1.4.3:
 * at least 4.5:1 for text under 18.66 pt bold). Final review 2026-11 found:
 *   - Evening "Study {n}" (white on the bright pine): 2.93:1;
 *   - the amber "reward" button and the Today tab badge (white on amber):
 *     2.71:1 on Paper, 2.30:1 on Evening;
 *   - Paper ink3 (most 12–13 pt secondary lines, inactive tab labels):
 *     3.26:1 on paper;
 *   - a Btn's small `sub` line at opacity 0.75: under 4.5:1 on every fill
 *     (it is drawn in the full text colour now, smaller and lighter in weight).
 * The colours come from the code itself (btnColors, holdButtonColors, the
 * palette), never copied here, so a new value is checked too.
 *
 * Also: a Btn label may take 2 lines (`lines={2}`), for "Choose what to
 * learn · 12 not started" in a card on a 360-dp phone.
 *
 * Wave 5g: the well behind a card's picture (`imageWell`) is light in both
 * themes, so black line art on a transparent picture can be seen in Evening
 * (on the dark paperSunk well it read at 1.1:1).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { dark, light, type Palette } from '../../theme/tokens';
import { btnColors, type BtnKind } from './buttons';
import { holdButtonColors } from './HoldButton';
import { Btn } from './index';

jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

/* --------------------------------------------------------------- the WCAG maths */

/** '#RRGGBB' → [r, g, b] (0–255). */
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** The WCAG 2.1 contrast ratio of two opaque colours (1 to 21). */
function contrast(x: string, y: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = rgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal-size text. */
const AA = 4.5;

const THEMES: [string, Palette][] = [
  ['Paper (light)', light],
  ['Evening (dark)', dark],
];

describe('the maths (a known pair)', () => {
  test('black on white is 21:1; the old Evening "Study {n}" was 2.93:1', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FBF8F2', '#2BA391')).toBeCloseTo(2.93, 2);
  });
});

describe.each(THEMES)('%s: every text colour reads at least 4.5:1', (_, c) => {
  // The kinds with a fill of their own (`danger` = red text on its pale red tint); `ghost`
  // is checked below.
  const FILLED: BtnKind[] = ['primary', 'reward', 'danger', 'dangerSolid', 'secondary', 'quiet'];

  test.each(FILLED)('Btn %s: the label (and its `sub` line, the same colour) on the fill', (kind) => {
    const k = btnColors(c)[kind];
    expect(contrast(k.fg, k.bg)).toBeGreaterThanOrEqual(AA);
  });

  test('Btn ghost: pine text on the page and on a card', () => {
    const k = btnColors(c).ghost;
    expect(contrast(k.fg, c.paper)).toBeGreaterThanOrEqual(AA);
    expect(contrast(k.fg, c.card)).toBeGreaterThanOrEqual(AA);
  });

  test('HoldButton: "Hold to restore" (pine) and "Erase everything" (red)', () => {
    for (const kind of ['primary', 'dangerSolid'] as const) {
      const { fg, bg } = holdButtonColors(c, kind);
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA);
      // The same colours as the Btn of that kind: one look.
      expect({ fg, bg }).toEqual({ fg: btnColors(c)[kind].fg, bg: btnColors(c)[kind].bg });
    }
  });

  test('text on a fill: pine (active chip, primary), amber (tab badge), red', () => {
    expect(contrast(c.inkOnColor, c.pine)).toBeGreaterThanOrEqual(AA);
    expect(contrast(c.inkOnAmber, c.amber)).toBeGreaterThanOrEqual(AA);
    expect(contrast(c.inkOnDanger, c.danger)).toBeGreaterThanOrEqual(AA);
  });

  test('ink, ink2 and ink3 on the page, a panel, a card and a sunk well (ink3: inactive tab labels too)', () => {
    for (const fg of [c.ink, c.ink2, c.ink3]) {
      for (const bg of [c.paper, c.surface, c.card, c.paperSunk]) {
        expect([fg, bg, Number(contrast(fg, bg).toFixed(2)) >= AA]).toEqual([fg, bg, true]);
      }
    }
    // ink3 is still the lightest of the three (a hierarchy, not one grey).
    expect(contrast(c.ink3, c.paper)).toBeLessThan(contrast(c.ink2, c.paper));
  });

  test('a card picture\'s well (imageWell): black line art reads on it', () => {
    // Many imported pictures are black drawings on a transparent background.
    expect(contrast('#000000', c.imageWell)).toBeGreaterThanOrEqual(AA);
    // The well is LIGHT in both themes: black reads better on it than white.
    expect(contrast('#000000', c.imageWell)).toBeGreaterThan(contrast('#FFFFFF', c.imageWell));
  });
});

describe('the picture well (wave 5g, the Evening image problem of the final device pass)', () => {
  test('Paper: nothing changes, the well is still paperSunk', () => {
    expect(light.imageWell).toBe(light.paperSunk);
  });

  test('Evening: the old dark well hid black lines (1.1:1); the new well is light', () => {
    expect(contrast('#000000', dark.paperSunk)).toBeLessThan(1.2);
    expect(dark.imageWell).not.toBe(dark.paperSunk);
    expect(contrast('#000000', dark.imageWell)).toBeGreaterThanOrEqual(15);
    // Light against the dark card it sits on, so the picture's edge is clear.
    expect(contrast(dark.imageWell, dark.card)).toBeGreaterThanOrEqual(AA);
  });
});

/* --------------------------------------------------------------- the Btn draws these colours */

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

/** The style of the Text that shows `text`. */
function textStyle(r: ReactTestRenderer, text: string) {
  const node = r.root.findAll((n) => n.type === Text && n.props.children === text)[0];
  return { style: StyleSheet.flatten(node.props.style), lines: node.props.numberOfLines as number | undefined };
}

describe('Btn draws its kind\'s colours, and may wrap to 2 lines', () => {
  test('a reward button: the text-on-amber colour, its sub line too, with no fading opacity (the mock theme is Paper)', () => {
    const r = render(
      React.createElement(Btn, { kind: 'reward', sub: '9,105 words', onPress: () => undefined }, 'Starter decks'),
    );
    expect(textStyle(r, 'Starter decks').style.color).toBe(light.inkOnAmber);
    const sub = textStyle(r, '9,105 words').style;
    expect(sub.color).toBe(light.inkOnAmber);
    expect(sub.opacity ?? 1).toBe(1);
  });

  test('one line by default; `lines={2}` lets a long label wrap, centred', () => {
    const one = render(React.createElement(Btn, { onPress: () => undefined }, 'Study 30'));
    expect(textStyle(one, 'Study 30').lines).toBe(1);
    act(() => one.unmount());
    renderer = null;
    const two = render(React.createElement(Btn, { lines: 2, onPress: () => undefined }, 'Choose what to learn · 12 not started'));
    const label = textStyle(two, 'Choose what to learn · 12 not started');
    expect(label.lines).toBe(2);
    expect(label.style).toMatchObject({ flexShrink: 1, textAlign: 'center' });
  });
});
