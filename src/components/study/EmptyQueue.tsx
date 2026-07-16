/**
 * EmptyQueue — the "nothing to study here" state shown when a session opens
 * with no studiable cards (all caught up).
 */
import React from 'react';
import { Text, View } from 'react-native';

import { Btn, Ion } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export function EmptyQueue({ onBack }: { onBack: () => void }) {
  const c = useColors();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.paper,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <Ion name="checkmark-circle" size={48} color={c.success} />
      <Text
        style={[
          font('serif', 600),
          { fontSize: 24, color: c.ink, marginTop: 14, textAlign: 'center' },
        ]}
      >
        Nothing to study here.
      </Text>
      <Text
        style={[
          font('sans', 400),
          { fontSize: 14, color: c.ink2, marginTop: 6, marginBottom: 20, textAlign: 'center' },
        ]}
      >
        You’re all caught up. Come back tomorrow — or study ahead.
      </Text>
      <Btn onPress={onBack}>Back</Btn>
    </View>
  );
}
