/**
 * HoldButton — a button that acts only after a 1-second press (spec §8.13
 * "HoldButton (1-second hold Btn)"). Used where one tap must not be enough:
 * "Hold to restore" (the Restore flow), "Hold to erase everything", and
 * from wave 4 "Delete {n} cards…" in the Library. It lives in the UI kit
 * (src/components/ui) since W3-7, so every screen can use it.
 *
 * How it works: on press-in a fill grows from left to right over `holdMs`.
 * When the fill is full, `onConfirm` runs once. Letting go earlier stops the
 * fill and it shrinks back: nothing happens. The look is the paper & ink `Btn`
 * (same shape, sizes and colours), so it needs no new visual language.
 *
 * Accessibility: role "button", a hint that says to hold, and a "longpress"
 * accessibility action, so TalkBack / VoiceOver users can confirm too.
 *
 * Example:
 *   <HoldButton kind="dangerSolid" onConfirm={erase}>Hold to erase everything</HoldButton>
 */
import React, { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';

import { font, type Palette } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { A11Y_HIDDEN, btnColors } from './buttons';
import { Ion } from './Ion';

/** How long the press must last, in ms (spec: a 1-second hold). */
export const HOLD_MS = 1000;

/**
 * The fill and text colour of a HoldButton: exactly the Btn kind of the same
 * name (buttons.tsx btnColors), so its label reads ≥ 4.5:1 in both themes
 * too (a fixed white was 2.9:1 on the Evening pine — "Hold to restore").
 */
export function holdButtonColors(c: Palette, kind: 'primary' | 'dangerSolid'): { bg: string; fg: string } {
  const k = btnColors(c)[kind];
  return { bg: k.bg, fg: k.fg };
}

interface HoldButtonProps {
  /** The label, e.g. "Hold to restore". */
  children: string;
  /** Runs once, when the hold is complete. */
  onConfirm: () => void;
  /** 'primary' (pine) or 'dangerSolid' (red). */
  kind?: 'primary' | 'dangerSolid';
  icon?: string;
  disabled?: boolean;
  holdMs?: number;
  style?: StyleProp<ViewStyle>;
}

export function HoldButton({
  children,
  onConfirm,
  kind = 'primary',
  icon,
  disabled,
  holdMs = HOLD_MS,
  style,
}: HoldButtonProps) {
  const c = useColors();
  // 0 = empty, 1 = full (the hold is complete).
  const [progress] = useState(() => new Animated.Value(0));
  const { bg, fg } = holdButtonColors(c, kind);

  // When the button goes away during a hold (for example its sheet closes),
  // stop the fill, so `onConfirm` can never run after the press is gone.
  useEffect(() => () => progress.stopAnimation(), [progress]);

  const start = () => {
    if (disabled) return;
    progress.stopAnimation();
    progress.setValue(0);
    // `width` cannot run on the native driver, so this animation runs in JS.
    // It is one second long, so that is fine.
    Animated.timing(progress, {
      toValue: 1,
      duration: holdMs,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      // finished is false when the press ended early (stopAnimation below).
      if (!finished) return;
      progress.setValue(0);
      onConfirm();
    });
  };

  const cancel = () => {
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: 150,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  };

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={children}
      accessibilityHint="Press and hold for one second."
      accessibilityState={{ disabled: !!disabled }}
      accessibilityActions={[{ name: 'longpress', label: children }]}
      onAccessibilityAction={(event) => {
        if (!disabled && event.nativeEvent.actionName === 'longpress') onConfirm();
      }}
      style={({ pressed }) => [
        {
          borderRadius: 999,
          backgroundColor: bg,
          overflow: 'hidden',
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
        },
        c.shadow.sm,
        style,
      ]}
    >
      {/* the fill: a darker layer that grows while the press lasts */}
      <Animated.View
        style={{
          // A style key, not the prop: react-native-web 0.21 warns about the prop.
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          backgroundColor: 'rgba(0,0,0,0.22)',
        }}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingVertical: 15,
          paddingHorizontal: 26,
        }}
      >
        {icon ? (
          <View {...A11Y_HIDDEN}>
            <Ion name={icon} size={19} color={fg} />
          </View>
        ) : null}
        <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 16.5, color: fg }]}>
          {children}
        </Text>
      </View>
    </Pressable>
  );
}
