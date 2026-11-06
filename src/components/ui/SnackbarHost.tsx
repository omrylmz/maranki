/**
 * Snackbar — inverse surface (ink-on-paper flips per theme), honey/pine
 * accent for the action. `SnackbarView` is the pure visual; `SnackbarHost`
 * renders the global channel. Full-screen overlays (session, editors,
 * import) mount their own host because native modals cover the root one.
 *
 * Where it sits: `bottom` (the screens: above the tab bar or the bottom
 * edge) or `top` (a sheet's panel, CardSheet: at the top of the panel, so
 * it never covers the sheet's last rows, like "Delete card…" — walkthrough
 * M5). How long it stays is decided by the channel (SnackbarContext
 * `snackDurationMs`: an Undo stays at least 5 s, longer with a screen
 * reader).
 *
 * Accessibility: the bar is a polite live region (TalkBack reads a new
 * message without moving the focus) and its action is a button with its
 * own label ("Undo").
 */
import React, { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSnackbar } from '@/store/SnackbarContext';
import { font, TABBAR_HEIGHT } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Ion } from './Ion';

interface SnackbarViewProps {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Distance from the bottom of the parent. Used when `top` is not given. */
  bottom?: number;
  /** Distance from the top of the parent: the bar sits at the top (a sheet's panel). Wins over `bottom`. */
  top?: number;
}

export function SnackbarView({ text, actionLabel, onAction, bottom = 0, top }: SnackbarViewProps) {
  const c = useColors();
  const [rise] = useState(() => new Animated.Value(0));

  useEffect(() => {
    rise.setValue(0);
    Animated.timing(rise, {
      toValue: 1,
      duration: 240,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    }).start();
  }, [text, rise]);

  const atTop = top !== undefined;
  return (
    <Animated.View
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        ...(atTop ? { top } : { bottom }),
        zIndex: 70,
        opacity: rise,
        // It slides in from the edge it sits at: up from below, or down from above.
        transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [atTop ? -10 : 10, 0] }) }],
      }}
    >
      <View
        style={[
          {
            backgroundColor: c.inverseSurface,
            borderRadius: 12,
            paddingVertical: 12,
            paddingLeft: 16,
            paddingRight: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          },
          c.shadow.lg,
        ]}
      >
        <Text style={[font('sans', 400), { flex: 1, fontSize: 13.5, color: c.inverseText }]}>
          {text}
        </Text>
        {onAction ? (
          <Pressable
            onPress={onAction}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={actionLabel ?? 'Undo'}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
          >
            <Ion name="arrow-undo" size={14} color={c.inverseAccent} />
            <Text style={[font('sans', 800), { fontSize: 13.5, color: c.inverseAccent }]}>
              {actionLabel ?? 'Undo'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

export function SnackbarHost({ aboveTabBar = true }: { aboveTabBar?: boolean }) {
  const { snack, dismiss } = useSnackbar();
  const insets = useSafeAreaInsets();
  if (!snack) return null;
  const bottom = aboveTabBar ? TABBAR_HEIGHT + insets.bottom + 12 : insets.bottom + 16;
  return (
    <SnackbarView
      text={snack.text}
      actionLabel={snack.actionLabel}
      onAction={
        snack.onAction
          ? () => {
              snack.onAction?.();
              dismiss();
            }
          : undefined
      }
      bottom={bottom}
    />
  );
}
