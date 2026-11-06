/**
 * RatingButtons — the 4-button Again/Hard/Good/Easy scale. Every study mode
 * ends with these same 4 buttons (spec §6.3, decision D8).
 *
 *   [ Again ] [ Hard ] [ Good ] [ Easy ]
 *     soon      1d      ┏3d┓      6d        ← Good has the outline: the mode suggests it
 *
 * - `pred` = the predicted next interval of each rating (sessionLogic
 *   ratingPredictions), or null in Practice: Practice never changes the
 *   schedule, so there is no interval to show ("—"), and the screen reader
 *   says 'Doesn’t change your schedule.' On a Check (a Known card) Good and
 *   Easy show "Known": the card stays Known and nothing is scheduled (the
 *   screen reader says "Good. Stays Known.").
 * - `suggested` = the rating the mode suggests (Typing: exact → Good, close →
 *   Hard, wrong → Again; Quiz: right → Good, wrong → Again; a used hint →
 *   Hard). That button gets a strong outline. It is ONLY a suggestion: the
 *   learner always taps the rating.
 * - Screen reader: "Good. Next in 3 days." (spec §8.12), ", suggested" for
 *   the outlined one.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import type { Predictions } from '@/domain/srs';
import type { Rating } from '@/domain/types';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { RATING_LABELS, RATINGS, ratingA11yLabel } from './sessionLogic';

function RatingBtn({
  rating,
  interval,
  suggested,
  onPress,
}: {
  rating: Rating;
  interval: string | null;
  suggested: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const { fg, tint } = c.rate[rating];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={ratingA11yLabel(rating, interval, suggested)}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        gap: 3,
        backgroundColor: tint,
        // The suggested rating gets a strong outline; the others a soft one (≈28%).
        borderWidth: suggested ? 2 : 1,
        borderColor: suggested ? fg : fg + '47',
        borderRadius: 14,
        paddingTop: suggested ? 11 : 12,
        paddingBottom: suggested ? 9 : 10,
        paddingHorizontal: 4,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Text style={[font('sans', 800), { fontSize: 14.5, color: fg }]}>{RATING_LABELS[rating]}</Text>
      <Text style={[font('mono', 400), { fontSize: 11.5, color: c.ink3 }]}>{interval ?? '—'}</Text>
    </Pressable>
  );
}

interface RatingButtonsProps {
  /** The predicted intervals, or null in Practice (no schedule change). */
  pred: Predictions | null;
  /** The rating the mode suggests (outlined), or null. */
  suggested?: Rating | null;
  onRate: (r: Rating) => void;
}

export function RatingButtons({ pred, suggested = null, onRate }: RatingButtonsProps) {
  return (
    <View style={{ flexDirection: 'row', gap: 9 }}>
      {RATINGS.map((rating) => (
        <RatingBtn
          key={rating}
          rating={rating}
          interval={pred ? pred[rating] : null}
          suggested={suggested === rating}
          onPress={() => onRate(rating)}
        />
      ))}
    </View>
  );
}
