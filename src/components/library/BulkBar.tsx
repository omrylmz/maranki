/**
 * BulkBar — the Library's select-mode action bar (spec §8.3, §7 #19, unit W4-2):
 *
 *   [♡ Favorite] [⚑ Flag] [⏸ Suspend] [Practice 12] [More]
 *
 * Every button has a TEXT label (they were icons only before). The three
 * markers are REAL toggles (libraryState bulkToggles): when every selected
 * card is a favorite the button says "Unfavorite" and takes it away; when
 * some or none are, it says "Favorite" and sets it on all. A toggle whose
 * marker is on for every card is drawn active.
 *
 * "Practice {n}" is a practice session of the selected cards (it never
 * changes the schedule); it is hidden when n is 0. "More" opens the
 * BulkMoreSheet. With nothing selected, every button is disabled.
 *
 * The bar floats above the tab bar. When the app's snackbar is showing (the
 * Undo of the last bulk change), the bar moves up, so both stay usable.
 *
 * Colours (spec §8.12, §8.13): only theme tokens, so both themes work
 * (`bulkBarColors`). The bar is the "inverse" surface: dark on Paper, light
 * on Evening. The Practice button's text is the bar colour on the accent
 * (about 9:1 on Paper, 5.4:1 on Evening — a fixed brown was 2.1:1 on the
 * Evening teal). An active toggle has a stronger tint AND an outline in the
 * text colour, so "on" can be seen in both themes (a white tint could not be
 * seen on the light Evening bar).
 *
 * Disabled (nothing selected — the bar the learner sees first, right after
 * "Select"; walkthrough L2): the button keeps its idle tint and its label is
 * the text colour at 70 % (`disabledText`). That is weaker than an enabled
 * label, so it looks "off", but it still reads ≥ 4.5:1 (about 5.2:1 on
 * Evening, 7:1 on Paper). The old way, the whole button at opacity 0.45, was
 * only 2.6:1 on Evening.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { A11Y_HIDDEN, Ion } from '@/components/ui';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, type Palette } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { type BulkToggle, LIBRARY_COPY } from './libraryState';

/** How far the bar moves up while a snackbar shows (a snackbar is about 48 pt high). */
const SNACK_SPACE = 58;

/**
 * How small a button label may get to fit its button (of 11 pt: 8.25 pt).
 * On a 360-dp phone a toggle has about 49 pt for its label: "Unfavorite"
 * (52 pt), "Unsuspend" (55 pt), and at 1.3× font size "Favorite" (54 pt) and
 * "Suspend" (55 pt) need up to about 0.86 of the size (final review 2026-11).
 */
export const BAR_LABEL_MIN_SCALE = 0.75;

/** The colours of the bar, from the theme tokens (libraryState.test.ts checks the contrast in both themes). */
export interface BulkBarColors {
  /** The bar itself. */
  bar: string;
  /** Text and icons of the toggles and "More". */
  text: string;
  /** "Practice {n}": its background and its text. */
  accentBg: string;
  accentText: string;
  /** A toggle that is off, and one that is on (every selected card has the marker). */
  idleBg: string;
  activeBg: string;
  /** The outline of an active toggle (an idle one has a clear outline of the same width). */
  activeBorder: string;
  /** Text and icon of a disabled button (nothing selected), drawn on the idle tint. */
  disabledText: string;
}

/**
 * The bar's colours for one palette. A tint is the text colour with an alpha
 * suffix ('14' = 8 %, '3D' = 24 %, 'B3' = 70 %), the same way other screens
 * tint a token (`c.danger + '4D'`); the tokens are 6-digit hex colours.
 */
export function bulkBarColors(c: Pick<Palette, 'inverseSurface' | 'inverseText' | 'inverseAccent'>): BulkBarColors {
  return {
    bar: c.inverseSurface,
    text: c.inverseText,
    accentBg: c.inverseAccent,
    accentText: c.inverseSurface,
    idleBg: `${c.inverseText}14`,
    activeBg: `${c.inverseText}3D`,
    activeBorder: c.inverseText,
    disabledText: `${c.inverseText}B3`,
  };
}

interface BulkBarProps {
  toggles: readonly BulkToggle[];
  onToggle: (toggle: BulkToggle) => void;
  /** The length of the practice session of the selection. */
  practiceCount: number;
  onPractice: () => void;
  onMore: () => void;
  /** Nothing is selected. */
  disabled: boolean;
  /** Distance from the bottom of the screen (above the tab bar). */
  bottom: number;
}

export function BulkBar({ toggles, onToggle, practiceCount, onPractice, onMore, disabled, bottom }: BulkBarProps) {
  const c = useColors();
  const colors = bulkBarColors(c);
  const { snack } = useSnackbar();
  return (
    <View
      style={[
        {
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: bottom + (snack ? SNACK_SPACE : 0),
          zIndex: 55,
          backgroundColor: colors.bar,
          borderRadius: 16,
          paddingVertical: 8,
          paddingHorizontal: 8,
          flexDirection: 'row',
          alignItems: 'stretch',
          gap: 6,
        },
        c.shadow.lg,
      ]}
    >
      {toggles.map((t) => (
        <BarButton
          key={t.key}
          icon={t.icon}
          label={t.label}
          active={t.allOn}
          disabled={disabled}
          colors={colors}
          onPress={() => onToggle(t)}
        />
      ))}
      {practiceCount > 0 ? (
        <BarButton
          icon="barbell-outline"
          label={`Practice ${practiceCount.toLocaleString('en-US')}`}
          hint="Doesn’t change your schedule."
          accent
          disabled={disabled}
          colors={colors}
          onPress={onPractice}
        />
      ) : null}
      <BarButton icon="ellipsis-horizontal" label={LIBRARY_COPY.more} disabled={disabled} colors={colors} onPress={onMore} />
    </View>
  );
}

interface BarButtonProps {
  icon: string;
  label: string;
  onPress: () => void;
  colors: BulkBarColors;
  active?: boolean;
  accent?: boolean;
  disabled?: boolean;
  hint?: string;
}

function BarButton({ icon, label, onPress, colors, active, accent, disabled, hint }: BarButtonProps) {
  // Disabled: the idle look with a weaker label (never an opacity: it would
  // fade the label below 4.5:1 on Evening — walkthrough L2).
  const fg = disabled ? colors.disabledText : accent ? colors.accentText : colors.text;
  const bg = disabled ? colors.idleBg : accent ? colors.accentBg : active ? colors.activeBg : colors.idleBg;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      style={({ pressed }) => ({
        flex: accent ? 1.3 : 1,
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        borderRadius: 10,
        paddingHorizontal: 2,
        // The same border width on every button, so turning a toggle on never moves the others.
        borderWidth: 1.5,
        borderColor: active && !accent && !disabled ? colors.activeBorder : 'transparent',
        backgroundColor: bg,
        transform: [{ scale: pressed && !disabled ? 0.96 : 1 }],
      })}
    >
      <View {...A11Y_HIDDEN}>
        <Ion name={icon} size={16} color={fg} />
      </View>
      {/* A label wider than its button ("Unfavorite" is 52 pt in about 49 pt on a 360-dp phone)
          shrinks a little to fit, never to "Unfavo…" (BAR_LABEL_MIN_SCALE). */}
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={BAR_LABEL_MIN_SCALE}
        maxFontSizeMultiplier={1.3}
        style={[font('sans', 700), { fontSize: 11, color: fg }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
