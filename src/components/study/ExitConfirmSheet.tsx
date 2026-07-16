/**
 * ExitConfirmSheet — confirms leaving mid-session, reassuring that the reviewed
 * cards are already saved (partial sessions still count).
 */
import React from 'react';
import { Text, View } from 'react-native';

import { Btn, Sheet } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface ExitConfirmSheetProps {
  open: boolean;
  reviewed: number;
  onKeep: () => void;
  onEnd: () => void;
}

export function ExitConfirmSheet({ open, reviewed, onKeep, onEnd }: ExitConfirmSheetProps) {
  const c = useColors();
  return (
    <Sheet open={open} onClose={onKeep} title="End this session?">
      <Text
        style={[font('sans', 400), { fontSize: 14.5, lineHeight: 22, color: c.ink2, marginBottom: 18 }]}
      >
        The {reviewed} {reviewed === 1 ? 'card' : 'cards'} you reviewed will be saved.
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn kind="secondary" full style={{ flex: 1 }} onPress={onKeep}>
          Keep studying
        </Btn>
        <Btn full style={{ flex: 1 }} onPress={onEnd}>
          End session
        </Btn>
      </View>
    </Sheet>
  );
}
