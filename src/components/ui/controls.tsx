/**
 * Controls: segmented control, toggle, stepper, labelled field.
 *
 * Accessibility (spec §8.12):
 *   SegCtrl  the control is a "radiogroup" named by `label` (REQUIRED, like
 *            IconBtn's: TypeScript finds every SegCtrl without a name); each
 *            option is a "radio" with `checked` (Android: a RadioButton, so
 *            TalkBack says "radio button, checked"; the old "tab" role was a
 *            plain View on Android — device pass 2026-11-02, F1-4). A hitSlop
 *            makes each option a 44 pt touch target.
 *   Toggle   a "switch" with `checked`; `label` names it ("Automatic backups").
 *   Stepper  one "adjustable" element: swipe up / down (VoiceOver) or the
 *            volume keys (TalkBack) step the value; `valueLabel` says it in
 *            words ("10 new cards per day").
 *   Field    the text box is labelled with the field label.
 * Reduce Motion: the Toggle knob jumps instead of sliding.
 */
import React, { useEffect, useState } from 'react';
import {
  AccessibilityActionEvent,
  Animated,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { useReduceMotion } from '@/store/useReduceMotion';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { A11Y_HIDDEN, squareSlop } from './buttons';
import { Ion } from './Ion';
import { Overline } from './layout';

export interface SegOption {
  id: string;
  label: string;
  icon?: string;
}

interface SegCtrlProps {
  options: SegOption[];
  value: string;
  onChange: (id: string) => void;
  size?: 'sm' | 'md';
  /**
   * Screen-reader name of the whole control, e.g. "Status" or "Default mode".
   * Required (spec §8.12, E9 "every control has a spoken label"): without it
   * TalkBack reads the radio buttons but never says which choice they make.
   */
  label: string;
}

/**
 * The text line of an option is at least 16 pt high at the normal font size
 * (a HankenGrotesk line is 1.303 × the font size: 12.5 pt → 16.3 pt,
 * 13.5 pt → 17.6 pt). The phone's font scale makes it taller (about 32 pt at
 * the largest size, 2.0). Used to size the touch target of SegCtrl options.
 */
const SEG_TEXT_MIN_HEIGHT = 16;

/**
 * The vertical padding and the top / bottom hitSlop of one SegCtrl option,
 * at the phone's font scale (default 1, the normal size). The option is at
 * least 2 × padV + 16 × fontScale pt high; the slop above and below brings
 * the touch target to 44 pt (spec §8.12). A larger font makes the option
 * taller, so it needs less slop:
 *
 *   segOptionSpace('sm')      → { padV: 6, slopV: 8 }   (12 + 16 + 2 × 8 = 44)
 *   segOptionSpace('md')      → { padV: 8, slopV: 6 }   (16 + 16 + 2 × 6 = 44)
 *   segOptionSpace('sm', 1.3) → { padV: 6, slopV: 6 }   (12 + 20.8 + 2 × 6 = 44.8)
 *   segOptionSpace('sm', 2)   → { padV: 6, slopV: 3 }   (12 + 32 = 44 already: the smallest slop)
 *
 * The slop is never less than 3 pt: the frame of the control around the
 * option is always part of its target. (squareSlop works on one side of a
 * box; here that side is the height. The width needs no slop: an option
 * fills its share of the row.) A font scale that is not a real number
 * (NaN, 0) counts as 1.
 */
export function segOptionSpace(size: 'sm' | 'md', fontScale = 1): { padV: number; slopV: number } {
  const padV = size === 'sm' ? 6 : 8;
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return { padV, slopV: squareSlop(2 * padV + SEG_TEXT_MIN_HEIGHT * scale, 3) };
}

/**
 * The space between two rows of options when the control wraps (a large
 * font size, a narrow phone, many options): 2 × the vertical slop.
 *
 * WHY: a slop reaches OUTSIDE its option, and Android looks for the touched
 * view from the LAST child to the first (TouchTargetHelper.kt), so a row-2
 * option is checked first. With a small gap, the top slop of "Mixed" (row 2)
 * reached into "Flashcards" (row 1): a tap on the bottom edge of
 * "Flashcards" chose "Mixed". With a gap of 2 × slop, the bottom slop of
 * row 1 and the top slop of row 2 each fill one half of the gap: no slop
 * ever covers another option, and every option keeps its full 44 pt
 * target. A one-row control has no gap, so it looks as before.
 *
 *   segRowGap(8) → 16   (sm at the normal font size)
 *   segRowGap(3) → 6    (sm at the largest font size)
 */
export function segRowGap(slopV: number): number {
  return 2 * slopV;
}

/**
 * The smallest width of one SegCtrl option, as a share of the control:
 * a little LESS than an even share, so the options of one row always fit
 * (n × 24.5% stays under 100% even with rounding):
 *
 *   segMinWidth(2) → '49.5%'
 *   segMinWidth(4) → '24.5%'
 *
 * How the options are laid out (a wrapping row, no label is ever cut):
 *   - an option is as wide as its label needs, and never narrower than
 *     segMinWidth. When every label fits in its even share (the normal
 *     font size), every option has the SAME width, as before;
 *   - a label that needs more room makes its option wider;
 *   - when the options do not fit in one row (the largest font size:
 *     "Flashcards · Typing · Quiz · Mixed"), the row wraps onto a second
 *     row. The options of each row share its width.
 */
export function segMinWidth(count: number): `${number}%` {
  const n = Math.max(1, Math.floor(count));
  return `${Math.round((100 / n - 0.5) * 100) / 100}%`;
}

/**
 * The corner radius of the SegCtrl frame. A one-row control at the normal
 * font size is at most 40 pt high, so 20 makes it a full pill (as before).
 * A taller or two-row control (a large font size) gets rounded corners,
 * not half-circle ends that would cut into its options.
 */
const SEG_RADIUS = 20;

export function SegCtrl({ options, value, onChange, size = 'md', label }: SegCtrlProps) {
  const c = useColors();
  // The phone's font size, read on every render: a larger text needs less slop (segOptionSpace).
  const { fontScale } = useWindowDimensions();
  const { padV, slopV } = segOptionSpace(size, fontScale);
  const minWidth = segMinWidth(options.length);
  return (
    <View
      // One group with the control's name ("Default mode"); each option is one choice of it.
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        // Used only when the options wrap: no slop reaches into the row above or below (segRowGap).
        rowGap: segRowGap(slopV),
        backgroundColor: c.paperSunk,
        borderRadius: SEG_RADIUS,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const on = value === o.id;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ checked: on }}
            // The option is shorter than 44 pt: the slop makes up the rest.
            hitSlop={{ top: slopV, bottom: slopV }}
            style={[
              {
                // As wide as the label needs, at least an even share (segMinWidth),
                // and never wider than the control (then the label wraps inside).
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: 'auto',
                minWidth,
                maxWidth: '100%',
                paddingVertical: padV,
                paddingHorizontal: size === 'sm' ? 10 : 12,
                borderRadius: 999,
                backgroundColor: on ? c.card : 'transparent',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
              },
              on ? c.shadow.sm : null,
            ]}
          >
            {o.icon ? <Ion name={o.icon} size={14} color={on ? c.ink : c.ink3} /> : null}
            {/* No numberOfLines: a label is never cut ("Flash.." at the largest font size). */}
            <Text
              style={[
                font('sans', 700),
                {
                  fontSize: size === 'sm' ? 12.5 : 13.5,
                  color: on ? c.ink : c.ink3,
                  flexShrink: 1,
                  textAlign: 'center',
                },
              ]}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface ToggleProps {
  on: boolean;
  onChange: (v: boolean) => void;
  /**
   * Screen-reader name, e.g. "Automatic backups" (the row title next to the
   * switch). Required (spec §8.12, E9 "every control has a spoken label"):
   * the switch has no text of its own, so without it TalkBack says only
   * "Switch, on".
   */
  label: string;
  disabled?: boolean;
}

export function Toggle({ on, onChange, label, disabled }: ToggleProps) {
  const c = useColors();
  const reduced = useReduceMotion();
  const [anim] = useState(() => new Animated.Value(on ? 1 : 0));
  useEffect(() => {
    if (reduced) {
      anim.stopAnimation();
      anim.setValue(on ? 1 : 0);
      return;
    }
    Animated.timing(anim, { toValue: on ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [on, anim, reduced]);
  return (
    <Pressable
      onPress={disabled ? undefined : () => onChange(!on)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, disabled: !!disabled }}
      // 28 pt high: 8 pt above and below make the target 44 pt.
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      style={{
        width: 46,
        height: 28,
        borderRadius: 999,
        backgroundColor: on ? c.pine : c.hairlineStrong,
        justifyContent: 'center',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          left: anim.interpolate({ inputRange: [0, 1], outputRange: [3, 21] }),
          width: 22,
          height: 22,
          borderRadius: 999,
          backgroundColor: '#fff',
          shadowColor: '#000',
          shadowOpacity: 0.25,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 1 },
          elevation: 2,
        }}
      />
    </Pressable>
  );
}

/**
 * The value after one step, kept inside [min, max]:
 *   stepValue(10, +1, 0, 999) → 11
 *   stepValue(998, +5, 0, 999) → 999
 *
 * A step never moves the value the other way. A stored value can already be
 * outside the range (old saved data, or a max that depends on another
 * setting). Then a step outward changes nothing, the same rule as the
 * disabled + and − buttons; a step inward goes into the range:
 *   stepValue(1000, +1, 0, 999) → 1000   (not 999: "increase" never lowers it)
 *   stepValue(1000, -1, 0, 999) → 999
 */
export function stepValue(value: number, delta: number, min: number, max: number): number {
  if (delta > 0 && value >= max) return value;
  if (delta < 0 && value <= min) return value;
  return Math.min(max, Math.max(min, value + delta));
}

interface StepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  fmt?: (v: number) => string;
  /** Screen-reader name, e.g. "New cards per day". */
  label?: string;
  /** The value in words for a screen reader, e.g. (v) => `${v} new cards per day`. Default: fmt or the number. */
  valueLabel?: (v: number) => string;
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
  fmt,
  label,
  valueLabel,
}: StepperProps) {
  const c = useColors();
  const change = (delta: number) => {
    const next = stepValue(value, delta, min, max);
    if (next !== value) onChange(next);
  };
  const onAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'increment') change(step);
    else if (event.nativeEvent.actionName === 'decrement') change(-step);
  };
  const shown = fmt ? fmt(value) : String(value);
  const btn = (icon: string, delta: number, disabled: boolean) => (
    <Pressable
      onPress={() => !disabled && change(delta)}
      disabled={disabled}
      // The buttons are part of the one adjustable element (see below).
      {...A11Y_HIDDEN}
      hitSlop={squareSlop(30)}
      style={{
        width: 30,
        height: 30,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: c.hairlineStrong,
        backgroundColor: c.card,
        opacity: disabled ? 0.35 : 1,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ion name={icon} size={15} color={c.ink2} />
    </Pressable>
  );
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: valueLabel ? valueLabel(value) : shown }}
      accessibilityActions={[
        { name: 'increment', label: 'Increase' },
        { name: 'decrement', label: 'Decrease' },
      ]}
      onAccessibilityAction={onAction}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      {btn('remove', -step, value <= min)}
      <Text
        style={[
          font('mono', 500),
          tnum,
          { fontSize: 14.5, color: c.ink, minWidth: 34, textAlign: 'center' },
        ]}
      >
        {shown}
      </Text>
      {btn('add', step, value >= max)}
    </View>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
  autoFocus?: boolean;
  hint?: string;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  multiline,
  autoFocus,
  hint,
}: FieldProps) {
  const c = useColors();
  return (
    <View style={{ marginBottom: 16 }}>
      <Overline style={{ marginBottom: 7 }}>{label}</Overline>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.ink3}
        autoFocus={autoFocus}
        multiline={multiline}
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[
          mono ? font('mono', 400) : font('sans', 400),
          {
            backgroundColor: c.card,
            borderWidth: 1,
            borderColor: c.hairlineStrong,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15.5,
            color: c.ink,
            lineHeight: 22,
            minHeight: multiline ? 64 : undefined,
            textAlignVertical: multiline ? 'top' : 'center',
          },
        ]}
      />
      {hint ? (
        <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginTop: 5 }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
