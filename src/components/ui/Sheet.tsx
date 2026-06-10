/**
 * Bottom sheet — the design's universal modal idiom (peek, create, streak,
 * exit-confirm, per-card actions). Scrim fade + 280ms ease-out slide-up,
 * drag handle, optional serif title. Transparency is for overlays only.
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

import { dur, font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  /** Max height as a fraction of the window (mock: 78%). */
  maxHFrac?: number;
}

export function Sheet({ open, onClose, children, title, maxHFrac = 0.78 }: SheetProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const [visible, setVisible] = useState(open);
  const [slide] = useState(() => new Animated.Value(0)); // 0 hidden → 1 shown

  // adjust-state-during-render: opening must mount the modal this frame
  if (open && !visible) setVisible(true);

  useEffect(() => {
    if (open) {
      Animated.timing(slide, {
        toValue: 1,
        duration: 280,
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
        if (finished) setVisible(false);
      });
    }
  }, [open, visible, slide]);

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Animated.View style={{ flex: 1, backgroundColor: c.scrim, opacity: slide }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
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
            transform: [
              {
                translateY: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [winH * 0.5, 0],
                }),
              },
            ],
          },
          c.shadow.lg,
        ]}
      >
        <View
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
          <Text style={[font('serif', 600), { fontSize: 22, color: c.ink, marginBottom: 12 }]}>
            {title}
          </Text>
        ) : null}
        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}
