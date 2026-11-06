/**
 * Buttons (ui.jsx → RN). Press feedback is the design's tactile scale-down
 * to 0.97 — "like pressing a real card", never a color inversion.
 *
 * Accessibility (spec §8.12), built in here so every screen gets it:
 *   - every button has `accessibilityRole="button"` and says when it is
 *     disabled (`accessibilityState`);
 *   - `label` is what a screen reader says. Btn reads its text when there is
 *     no `label`. IconBtn and FAB show only an icon, so `label` is REQUIRED
 *     on them (wave 5, W5-2): TypeScript fails on an icon button without a
 *     name, so a new unlabelled icon button cannot be added by mistake;
 *   - small buttons get a `hitSlop`, so the touch target is at least 44 pt.
 *
 * Example:
 *   <IconBtn icon="trash-outline" label="Delete this backup" onPress={ask} />
 */
import React from 'react';
import { Insets, Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';

import { font, type Palette } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Ion } from './Ion';

/* ---------------------------------------------------------- a11y helpers */

/** The smallest touch target, in points (spec §8.12, Apple and Android guidelines). */
export const MIN_TOUCH = 44;

/**
 * The plain text inside React children, for a screen-reader label:
 *
 *   childText('Restore')            → 'Restore'
 *   childText(['Study ', 30])       → 'Study 30'     (JSX "Study {n}")
 *   childText(<Ion name="add" />)   → undefined      (not only text)
 *
 * undefined when the children hold anything but strings and numbers
 * (then React Native reads the children by itself).
 */
export function childText(children: React.ReactNode): string | undefined {
  const parts: string[] = [];
  // false = a child that is not text (an element): give up.
  const walk = (node: React.ReactNode): boolean => {
    if (node === null || node === undefined || typeof node === 'boolean') return true;
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return true;
    }
    if (Array.isArray(node)) return node.every((child) => walk(child as React.ReactNode));
    return false;
  };
  if (!walk(children)) return undefined;
  const text = parts.join('');
  return text === '' ? undefined : text;
}

/**
 * The hitSlop that makes a square button of `size` points at least
 * MIN_TOUCH points (never less than `base`, the old fixed slop):
 *
 *   squareSlop(38) → 6   (38 + 2 × 6 = 50)
 *   squareSlop(28) → 8   (28 + 2 × 8 = 44)
 */
export function squareSlop(size: number, base = 6): number {
  return Math.max(base, Math.ceil((MIN_TOUCH - size) / 2));
}

/**
 * Props that hide a decorative view (an icon, a dot, a seal) from VoiceOver
 * (iOS) and TalkBack (Android). The text next to it says the same in words.
 *
 *   <View {...A11Y_HIDDEN}><Ion name="chevron-forward" /></View>
 */
export const A11Y_HIDDEN = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/* --------------------------------------------------------------- Btn */

/** The vertical / horizontal padding and the font size of each Btn size. */
const BTN_SIZES = {
  sm: { padV: 8, padH: 15, fsz: 13.5 },
  md: { padV: 12, padH: 20, fsz: 15 },
  lg: { padV: 15, padH: 26, fsz: 16.5 },
} as const;

/** A HankenGrotesk text line is about 1.303 × its font size high (the ratio controls.tsx uses for SegCtrl). */
const LINE_RATIO = 1.303;

/**
 * The top and bottom hitSlop of a Btn (without `sub`), so its touch target
 * is at least MIN_TOUCH = 44 pt (spec §8.12). The button is 2 × padding +
 * one text line high:
 *
 *   btnSlop('sm') → 6   (16 + 17.6 = 33.6 pt; with the slop 45.6 pt)
 *   btnSlop('md') → 1   (24 + 19.5 = 43.5 pt — just under 44; with the slop 45.5 pt)
 *   btnSlop('lg') → 0   (30 + 21.5 = 51.5 pt)
 */
export function btnSlop(size: 'sm' | 'md' | 'lg'): number {
  const { padV, fsz } = BTN_SIZES[size];
  return squareSlop(2 * padV + fsz * LINE_RATIO, 0);
}

export type BtnKind =
  | 'primary'
  | 'reward'
  | 'secondary'
  | 'ghost'
  | 'quiet'
  | 'danger'
  | 'dangerSolid';

/** The fill, the text colour, the outline and the shadow of one Btn kind. */
export interface BtnColors {
  bg: string;
  fg: string;
  border?: string;
  shadow?: ViewStyle;
}

/**
 * The colours of every Btn kind, from the theme tokens. Every text colour
 * reads at least 4.5:1 on its fill in BOTH themes (WCAG AA for the 13.5 to
 * 16.5 pt labels; uiContrast.test.ts checks it): the text on a saturated
 * fill is a theme token (`inkOnColor`, `inkOnAmber`, `inkOnDanger`), never a
 * fixed white — white was 2.9:1 on the Evening pine ("Study {n}") and 2.7:1
 * / 2.3:1 on amber (final review 2026-11).
 */
export function btnColors(c: Palette): Record<BtnKind, BtnColors> {
  return {
    primary: { bg: c.pine, fg: c.inkOnColor, shadow: c.shadow.sm },
    reward: { bg: c.amber, fg: c.inkOnAmber, shadow: c.shadow.sm },
    secondary: { bg: c.card, fg: c.ink, border: c.hairlineStrong },
    ghost: { bg: 'transparent', fg: c.pine },
    quiet: { bg: c.paperSunk, fg: c.ink2 },
    danger: { bg: c.dangerTint, fg: c.danger },
    dangerSolid: { bg: c.danger, fg: c.inkOnDanger },
  };
}

interface BtnProps {
  kind?: BtnKind;
  icon?: string;
  children?: React.ReactNode;
  onPress?: () => void;
  full?: boolean;
  size?: 'sm' | 'md' | 'lg';
  sub?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Screen-reader label. Default: the button text (and `sub`). */
  label?: string;
  /** Screen-reader hint: what happens on press, when the label does not say it. */
  hint?: string;
  /**
   * How many lines the label may take (default 1, cut with "…"). 2 for a
   * label with a count that can be wider than a small phone, like "Choose
   * what to learn · 12 not started" in a card.
   */
  lines?: 1 | 2;
}

export function Btn({
  kind = 'primary',
  icon,
  children,
  onPress,
  full,
  size = 'md',
  sub,
  disabled,
  style,
  label,
  hint,
  lines = 1,
}: BtnProps) {
  const c = useColors();
  const { padV, padH, fsz } = BTN_SIZES[size];
  // A small button is about 33 pt high and a medium one 43.5 pt: the slop
  // brings both to 44 pt or more (btnSlop). A large one needs none.
  const slopV = btnSlop(size);
  const slop: Insets | undefined = slopV > 0 ? { top: slopV, bottom: slopV } : undefined;
  const text = childText(children);
  const a11yLabel = label ?? (text !== undefined && sub ? `${text}, ${sub}` : text);

  const k = btnColors(c)[kind];

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      hitSlop={slop}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          borderRadius: 999,
          paddingVertical: padV,
          paddingHorizontal: padH,
          backgroundColor: k.bg,
          borderWidth: k.border ? 1 : 0,
          borderColor: k.border,
          alignSelf: full ? 'stretch' : 'flex-start',
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
        },
        k.shadow,
        style,
      ]}
    >
      {icon ? (
        <View {...A11Y_HIDDEN}>
          <Ion name={icon} size={fsz + 3} color={k.fg} />
        </View>
      ) : null}
      {sub ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Text style={[font('sans', 700), { fontSize: fsz, color: k.fg, lineHeight: fsz * 1.2 }]}>
            {children}
          </Text>
          {/* The full text colour, smaller and lighter in weight: at opacity 0.75 it was under 4.5:1 on every fill. */}
          <Text style={[font('sans', 600), { fontSize: 12, color: k.fg }]}>{sub}</Text>
        </View>
      ) : (
        <Text
          style={[
            font('sans', 700),
            { fontSize: fsz, color: k.fg },
            // Two lines: the label wraps inside the button and stays centred.
            lines > 1 ? { flexShrink: 1, textAlign: 'center' } : null,
          ]}
          numberOfLines={lines}
        >
          {children}
        </Text>
      )}
    </Pressable>
  );
}

/* ------------------------------------------------------------ IconBtn */

interface IconBtnProps {
  icon: string;
  onPress?: (() => void) | null;
  size?: number;
  iconSize?: number;
  color?: string;
  bg?: string;
  border?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /**
   * What a screen reader says, e.g. "Add a deck, card, list or import".
   * The button shows only an icon, so this is its only name. Required
   * (spec §8.12, wave 5): say what the button does, not what the icon is.
   */
  label: string;
  /** Screen-reader hint, when the label does not say what happens. */
  hint?: string;
}

export function IconBtn({
  icon,
  onPress,
  size = 38,
  iconSize,
  color,
  bg = 'transparent',
  border,
  disabled,
  style,
  label,
  hint,
}: IconBtnProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={disabled ? undefined : (onPress ?? undefined)}
      disabled={disabled}
      hitSlop={squareSlop(size)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: 999,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: border ? 1 : 0,
          borderColor: border ? c.hairlineStrong : undefined,
          opacity: disabled ? 0.35 : 1,
          transform: [{ scale: pressed && !disabled ? 0.94 : 1 }],
        },
        style,
      ]}
    >
      <Ion name={icon} size={iconSize ?? size * 0.55} color={color ?? c.ink2} />
    </Pressable>
  );
}

/* ---------------------------------------------------------------- FAB */

interface FABProps {
  onPress: () => void;
  icon?: string;
  bottom: number;
  /** What a screen reader says, e.g. "Add a card". Required (spec §8.12, wave 5): the FAB shows only an icon. */
  label: string;
}

export function FAB({ onPress, icon = 'add', bottom, label }: FABProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          position: 'absolute',
          right: 18,
          bottom,
          width: 54,
          height: 54,
          borderRadius: 999,
          backgroundColor: c.pine,
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 45,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        },
        c.shadow.md,
      ]}
    >
      <Ion name={icon} size={26} color="#fff" />
    </Pressable>
  );
}
