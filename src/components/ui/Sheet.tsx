/**
 * Bottom sheet — the design's universal modal idiom (peek, create, streak,
 * exit-confirm, per-card actions). Scrim fade + 280ms ease-out slide-up,
 * drag handle, optional serif title. Transparency is for overlays only.
 *
 * Reduce Motion (spec §8.12): the panel does not slide; it fades in and out
 * with the scrim (useReduceMotion).
 *
 * Accessibility: the title is a "header"; the panel is a modal view, so
 * VoiceOver stays inside it and its "escape" gesture (two-finger Z) closes
 * the sheet; the scrim is a "Close" button; the drag handle is decoration.
 * Android's back button closes it (Modal onRequestClose) — but with the
 * keyboard open (a sheet with a text field: "Save list", rename) the FIRST
 * Back press closes only the keyboard. Android sends Back to the Modal, not
 * to BackHandler, so the Modal asks the app-wide keyboard guard itself
 * (src/platform/keyboardBack.ts backPressClosesKeyboard, final device pass
 * K1-1): the keyboard can close itself on that press before the app hears
 * it, and without the guard the same press also closed the sheet.
 *
 * Keyboard: the body is a ScrollView with keyboardShouldPersistTaps
 * "handled". So with the keyboard open, a tap on a button in the sheet
 * ("Save list") presses the button at once; before, the first tap only
 * closed the keyboard (walkthrough M3). A tap on an empty part of the sheet
 * still closes the keyboard.
 */
import React, { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { backPressClosesKeyboard } from '@/platform/keyboardBack';
import { useReduceMotion } from '@/store/useReduceMotion';
import { dur, font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { A11Y_HIDDEN } from './buttons';

/** The scrim's screen-reader label. */
export const SHEET_CLOSE_LABEL = 'Close';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  /** Max height as a fraction of the window (mock: 78%). */
  maxHFrac?: number;
  /** Fires AFTER the dismiss animation finishes — for resetting inner state
   *  (e.g. a drill-down level) without flashing it mid-slide-out. */
  onClosed?: () => void;
  /**
   * Drawn ON the panel, outside the scrolling content, so it stays in view
   * at every scroll position (for example the sheet's own snackbar). Its
   * box fills the panel from its top edge down to 16 pt above the bottom
   * safe area (like the screen's SnackbarHost); place it with absolute
   * insets (`top: 0` = the highest place, `bottom: 0` = the lowest place).
   * Touches pass through its empty parts to the content.
   */
  overlay?: React.ReactNode;
}

export function Sheet({ open, onClose, children, title, maxHFrac = 0.78, onClosed, overlay }: SheetProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const reduced = useReduceMotion();
  const [visible, setVisible] = useState(open);
  const [slide] = useState(() => new Animated.Value(0)); // 0 hidden → 1 shown

  // adjust-state-during-render: opening must mount the modal this frame
  if (open && !visible) setVisible(true);

  useEffect(() => {
    if (open) {
      Animated.timing(slide, {
        toValue: 1,
        // A fade (Reduce Motion) is short; the slide keeps the design's 280 ms.
        duration: reduced ? dur.normal : 280,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
        useNativeDriver: true,
      }).start();
    } else if (visible) {
      Animated.timing(slide, {
        toValue: 0,
        duration: dur.fast,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setVisible(false);
          onClosed?.();
        }
      });
    }
  }, [open, visible, slide, onClosed, reduced]);

  if (!visible) return null;

  // Android's Back: the keyboard first (only the keyboard closes), then the sheet.
  const onBack = () => {
    if (!backPressClosesKeyboard()) onClose();
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onBack}>
      <Animated.View style={{ flex: 1, backgroundColor: c.scrim, opacity: slide }}>
        <Pressable
          style={{ flex: 1 }}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={SHEET_CLOSE_LABEL}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: c.surface,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingTop: 10,
            paddingHorizontal: 20,
            paddingBottom: 34 + insets.bottom,
            maxHeight: winH * maxHFrac,
            // Reduce Motion: no slide, the panel fades with the scrim.
            opacity: reduced ? slide : 1,
            transform: [
              {
                translateY: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: reduced ? [0, 0] : [winH * 0.5, 0],
                }),
              },
            ],
          },
          c.shadow.lg,
        ]}
      >
        <View
          {...A11Y_HIDDEN}
          style={{
            width: 36,
            height: 4,
            backgroundColor: c.hairlineStrong,
            borderRadius: 999,
            alignSelf: 'center',
            marginBottom: 14,
          }}
        />
        {title ? (
          <Text
            accessibilityRole="header"
            style={[font('serif', 600), { fontSize: 22, color: c.ink, marginBottom: 12 }]}
          >
            {title}
          </Text>
        ) : null}
        <ScrollView bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
        {overlay ? (
          <View
            pointerEvents="box-none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: insets.bottom + 16 }}
          >
            {overlay}
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  );
}
