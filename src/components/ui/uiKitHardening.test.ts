/**
 * Tests for the W3-7 hardening of the UI kit (spec §8.12 accessibility):
 *   - Chip: a chip WITHOUT onPress (a filter chip you can only remove) is
 *     not called a button, and does not play the press animation; only its
 *     × is a button;
 *   - Btn: the default 'md' size is about 43.5 pt high, so it gets a small
 *     top / bottom hitSlop as well (every size reaches 44 pt);
 *   - FieldRows: the 'compact' variant (text only) leaves out a field that
 *     holds only an image, and a row of an image-only field is read
 *     "Picture: image", never "Picture: " with nothing after the colon.
 *
 * Rendered with react-test-renderer, with the same module mocks as
 * uiKit.test.ts (the light palette, zero safe-area insets, icons that draw
 * nothing). A separate file, so the main kit test stays as it is.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { FieldBlock } from '../../domain/model';
import { btnSlop } from './buttons';
import { Btn, Chip, FieldRows, fieldRowLabel, FilterChipsRow, MIN_TOUCH } from './index';

jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The real icon loads its font later and sets state outside act(); icons
// draw nothing a screen reader needs, so they render nothing here.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const h = React.createElement;

/* --------------------------------------------------------------- helpers */

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
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

/** The Pressable component (not its host view) with this accessibility label. */
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

/* ------------------------------------------------------------------ Chip */

describe('Chip without onPress: the label is text, only the × is a button', () => {
  test('a dismiss-only chip gives exactly one button: "Remove filter …"', () => {
    const onDismiss = jest.fn();
    const r = render(h(Chip, { active: true, dismiss: true, onDismiss, children: 'Deck: German' }));
    const buttons = byRole(r, 'button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.accessibilityLabel).toBe('Remove filter Deck: German');
    const label = byLabel(r, 'Deck: German');
    expect(label.props.accessibilityRole).toBe('text');
    // "selected" belongs to a choice you can press; a plain label is not "selected".
    expect(label.props.accessibilityState?.selected).toBeUndefined();
    act(() => pressableByLabel(r, 'Remove filter Deck: German').props.onPress());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('no press animation without an action; a chip with onPress keeps both', () => {
    const plain = render(h(Chip, { dismiss: true, onDismiss: () => undefined, children: 'Not started' }));
    const target = pressableByLabel(plain, 'Not started');
    expect(target.props.onPressIn).toBeUndefined();
    expect(target.props.onPressOut).toBeUndefined();

    const choice = render(h(Chip, { onPress: () => undefined, children: 'Due' }));
    const due = pressableByLabel(choice, 'Due');
    expect(typeof due.props.onPressIn).toBe('function');
    expect(byLabel(choice, 'Due').props.accessibilityRole).toBe('button');
    expect(byLabel(choice, 'Due').props.accessibilityState).toEqual({ selected: false });
  });

  test('FilterChipsRow: a chip with no tap action reads as text; the × and "+ Filter" are the buttons', () => {
    const r = render(
      h(FilterChipsRow, {
        chips: [
          { key: 'deck', label: 'Deck: German', onRemove: () => undefined },
          { key: 'level', label: 'Level: B1', onPress: () => undefined, onRemove: () => undefined },
        ],
        onAdd: () => undefined,
      }),
    );
    expect(byLabel(r, 'Deck: German').props.accessibilityRole).toBe('text');
    expect(byLabel(r, 'Level: B1').props.accessibilityRole).toBe('button');
    const buttons = byRole(r, 'button').map((b) => b.props.accessibilityLabel as string);
    expect(buttons.sort()).toEqual(['Add a filter', 'Level: B1', 'Remove filter Deck: German', 'Remove filter Level: B1']);
  });
});

/* ------------------------------------------------------------------- Btn */

describe('Btn: every size is a touch target of at least 44 pt', () => {
  test('btnSlop: small 6, medium 1 (43.5 pt is just under 44), large none', () => {
    expect(btnSlop('sm')).toBe(6);
    expect(btnSlop('md')).toBe(1);
    expect(btnSlop('lg')).toBe(0);
    // Height = 2 × padding + one HankenGrotesk line (1.303 × the font size).
    const heights = { sm: 2 * 8 + 13.5 * 1.303, md: 2 * 12 + 15 * 1.303, lg: 2 * 15 + 16.5 * 1.303 };
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(heights[size] + 2 * btnSlop(size)).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
    expect(heights.md).toBeLessThan(MIN_TOUCH); // why md needs a slop at all
  });

  test('a default (medium) Btn gets the slop; a large one gets none', () => {
    const md = render(h(Btn, { onPress: () => undefined, children: 'Import' }));
    expect(pressableByLabel(md, 'Import').props.hitSlop).toEqual({ top: 1, bottom: 1 });
    const sm = render(h(Btn, { size: 'sm', onPress: () => undefined, children: 'Save' }));
    expect(pressableByLabel(sm, 'Save').props.hitSlop).toEqual({ top: 6, bottom: 6 });
    const lg = render(h(Btn, { size: 'lg', onPress: () => undefined, children: 'Study 30 now' }));
    expect(pressableByLabel(lg, 'Study 30 now').props.hitSlop).toBeUndefined();
  });
});

/* ------------------------------------------------------------- FieldRows */

describe('FieldRows: an image-only field is never an empty label', () => {
  const picture: FieldBlock = { field: 1, label: 'Picture', role: 'detail', lines: [[{ t: 'img', src: 'haus.png' }]], plain: '' };
  const meaning: FieldBlock = { field: 0, label: 'Meaning', role: 'detail', lines: [[{ t: 'text', text: 'house' }]], plain: 'house' };
  const renderImage = (src: string, key: string) => h(Text, { key }, `img:${src}`);

  test('compact draws text only, so it leaves the image-only field out (even with renderImage)', () => {
    const only = render(h(FieldRows, { blocks: [picture], variant: 'compact', renderImage }));
    expect(only.toJSON()).toBeNull();
    const both = render(h(FieldRows, { blocks: [meaning, picture], variant: 'compact', renderImage }));
    expect(allText(both)).not.toContain('Picture');
    expect(byLabel(both, 'Meaning: house').props.accessible).toBe(true);
  });

  test('side and stacked draw the image, and the row says what it shows', () => {
    for (const variant of ['side', 'stacked'] as const) {
      const r = render(h(FieldRows, { blocks: [picture], variant, renderImage }));
      expect(byLabel(r, 'Picture: image').props.accessible).toBe(true);
      expect(allText(r)).toContain('img:haus.png');
    }
  });

  test('fieldRowLabel: text first; images counted when there is no text', () => {
    expect(fieldRowLabel(meaning)).toBe('Meaning: house');
    expect(fieldRowLabel(picture)).toBe('Picture: image');
    const two: FieldBlock = { ...picture, lines: [[{ t: 'img', src: 'a.png' }], [{ t: 'img', src: 'b.png' }]] };
    expect(fieldRowLabel(two)).toBe('Picture: 2 images');
    expect(fieldRowLabel({ ...picture, label: '' })).toBe('image');
    // Nothing to say (no text, no image): just the label, no colon.
    expect(fieldRowLabel({ label: 'Notes', plain: '' })).toBe('Notes');
  });
});
