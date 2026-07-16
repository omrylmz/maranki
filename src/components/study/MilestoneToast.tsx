/**
 * MilestoneToast — the quiet "{n} in a row" flame that pops at each streak of
 * consecutive correct answers within a session.
 */
import React from 'react';
import { Text, View } from 'react-native';

import { Ion, RiseIn } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export function MilestoneToast({ n }: { n: number }) {
  const c = useColors();
  return (
    <View style={{ position: 'absolute', top: 6, left: 0, right: 0, alignItems: 'center', zIndex: 5 }}>
      <RiseIn kind="pop" duration={300}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: c.amberTint,
            paddingVertical: 7,
            paddingHorizontal: 14,
            borderRadius: 999,
          }}
        >
          <Ion name="flame" size={15} color={c.amber} />
          <Text style={[font('sans', 800), { fontSize: 13.5, color: c.amberDeep }]}>
            {n} in a row
          </Text>
        </View>
      </RiseIn>
    </View>
  );
}
