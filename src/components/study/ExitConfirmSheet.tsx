/**
 * ExitConfirmSheet — confirms leaving mid-session, reassuring that the reviewed
 * cards are already saved (partial sessions still count). The count uses
 * plural(): "The 1 card you reviewed will be saved."
 * A Practice session (`practice`) has its own, honest words, because it
 * changes no schedule (sessionLogic exitSavedLine, wave 5h):
 * "Your practice is kept (3 cards). Your schedule does not change."
 */
import React from 'react';
import { Text, View } from 'react-native';

import { Btn, Sheet } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { exitSavedLine } from './sessionLogic';

interface ExitConfirmSheetProps {
  open: boolean;
  reviewed: number;
  /** True for a Practice session (it changes no schedule). */
  practice?: boolean;
  onKeep: () => void;
  onEnd: () => void;
}

export function ExitConfirmSheet({ open, reviewed, practice = false, onKeep, onEnd }: ExitConfirmSheetProps) {
  const c = useColors();
  return (
    <Sheet open={open} onClose={onKeep} title="End this session?">
      <Text
        style={[font('sans', 400), { fontSize: 14.5, lineHeight: 22, color: c.ink2, marginBottom: 18 }]}
      >
        {exitSavedLine(reviewed, practice)}
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
