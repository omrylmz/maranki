/**
 * RatingButtons — the 4-button Again/Hard/Good/Easy scale, each showing its
 * predicted next interval (computed live from SM-2 by predictAll).
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { Predictions } from '@/domain/srs';
import { Rating } from '@/domain/types';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

function RatingBtn({
  label,
  interval,
  fg,
  tint,
  onPress,
}: {
  label: string;
  interval: string;
  fg: string;
  tint: string;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        gap: 3,
        backgroundColor: tint,
        borderWidth: 1,
        borderColor: fg + '47', // ≈28% — softTint(color, 28) in the mock
        borderRadius: 14,
        paddingTop: 12,
        paddingBottom: 10,
        paddingHorizontal: 4,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Text style={[font('sans', 800), { fontSize: 14.5, color: fg }]}>{label}</Text>
      <Text style={[font('mono', 400), { fontSize: 11.5, color: c.ink3 }]}>{interval}</Text>
    </Pressable>
  );
}

interface RatingButtonsProps {
  pred: Predictions;
  onRate: (r: Rating) => void;
}

export function RatingButtons({ pred, onRate }: RatingButtonsProps) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 9 }}>
      <RatingBtn
        label="Again"
        interval={pred.again}
        fg={c.rate.again.fg}
        tint={c.rate.again.tint}
        onPress={() => onRate('again')}
      />
      <RatingBtn
        label="Hard"
        interval={pred.hard}
        fg={c.rate.hard.fg}
        tint={c.rate.hard.tint}
        onPress={() => onRate('hard')}
      />
      <RatingBtn
        label="Good"
        interval={pred.good}
        fg={c.rate.good.fg}
        tint={c.rate.good.tint}
        onPress={() => onRate('good')}
      />
      <RatingBtn
        label="Easy"
        interval={pred.easy}
        fg={c.rate.easy.fg}
        tint={c.rate.easy.tint}
        onPress={() => onRate('easy')}
      />
    </View>
  );
}
