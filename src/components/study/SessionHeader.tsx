/**
 * SessionHeader — the chrome-minimal top bar: close, the "n / total" counter,
 * undo, more, and the thin ink progress line beneath.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bar, IconBtn } from '@/components/ui';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface SessionHeaderProps {
  idx: number;
  total: number;
  canUndo: boolean;
  onClose: () => void;
  onUndo: () => void;
  onMore: () => void;
}

export function SessionHeader({ idx, total, canUndo, onClose, onUndo, onMore }: SessionHeaderProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <IconBtn icon="close" size={36} iconSize={20} color={c.ink2} onPress={onClose} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={[font('mono', 400), tnum, { fontSize: 13.5, color: c.ink2 }]}>
            {idx + 1} <Text style={{ color: c.ink3 }}>/ {total}</Text>
          </Text>
        </View>
        <IconBtn
          icon="arrow-undo"
          size={36}
          iconSize={18}
          disabled={!canUndo}
          onPress={onUndo}
          color={c.ink2}
        />
        <IconBtn
          icon="ellipsis-horizontal"
          size={36}
          iconSize={18}
          onPress={onMore}
          color={c.ink2}
        />
      </View>
      <View style={{ marginTop: 8, marginHorizontal: 2 }}>
        <Bar value={(idx / total) * 100} h={3} />
      </View>
    </View>
  );
}
