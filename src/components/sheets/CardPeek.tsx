/**
 * Card peek — the universal card detail sheet. Front/back, example, state and
 * interval badges, and quick state toggles (real writes).
 */
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Btn, Ion, Pill, Sheet, StateBadge } from '@/components/ui';
import { formatIntervalDays } from '@/domain/srs';
import { Card, displayState, MASTERED_INTERVAL_DAYS } from '@/domain/types';
import { useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface CardPeekProps {
  card: Card | null;
  onClose: () => void;
}

export function CardPeek({ card: cardProp, onClose }: CardPeekProps) {
  const c = useColors();
  const router = useRouter();
  const { actions } = useData();
  const { show } = useSnackbar();
  const now = useNow();

  // Retain the card through Sheet's slide-out so the peek animates closed
  // instead of vanishing when the parent nulls it (L22). `open` follows the live
  // prop; the retained `card` is cleared only once the exit animation ends.
  const [card, setCard] = useState<Card | null>(cardProp);
  if (cardProp && cardProp !== card) setCard(cardProp);
  const open = cardProp != null;

  if (!card) return null;
  const state = displayState(card, now);

  const quick = (label: string, icon: string, active: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        gap: 4,
        backgroundColor: active ? c.pineTint : c.paperSunk,
        borderRadius: 12,
        paddingVertical: 11,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Ion name={icon} size={18} color={active ? c.pine : c.ink2} />
      <Text style={[font('sans', 700), { fontSize: 11.5, color: active ? c.pine : c.ink2 }]}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <Sheet open={open} onClose={onClose} onClosed={() => setCard(null)}>
      <Text
        style={[
          font('serif', 600),
          { fontSize: 28, lineHeight: 31, letterSpacing: -0.42, color: c.ink },
        ]}
      >
        {card.front}
      </Text>

      <Text style={[font('sans', 700), { fontSize: 17, color: c.ink, marginTop: 12, marginBottom: 2 }]}>
        {card.back}
      </Text>
      {card.example ? (
        <View style={{ marginTop: 10 }}>
          <Text style={[font('serif', 400, true), { fontSize: 15.5, lineHeight: 22, color: c.ink2 }]}>
            {card.example}
          </Text>
        </View>
      ) : null}
      {card.notes ? (
        <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 8, lineHeight: 18 }]}>
          {card.notes}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
          marginTop: 14,
          marginBottom: 4,
          flexWrap: 'wrap',
        }}
      >
        <StateBadge state={state} label={state} />
        {card.tags?.map((t) => <Pill key={t}>{t}</Pill>)}
        {card.intervalDays > 0 && card.stepIndex === null ? (
          <Pill mono>next in {formatIntervalDays(card.intervalDays)}</Pill>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginVertical: 16 }}>
        {quick('Favorite', card.fav ? 'heart' : 'heart-outline', !!card.fav, () => {
          actions.setCardProps([card.id], { fav: !card.fav });
          show(card.fav ? 'Removed from favorites' : 'Added to favorites');
          onClose();
        })}
        {quick('Learning', 'school-outline', card.stepIndex !== null, () => {
          actions.updateCard(card.id, { stepIndex: 0, intervalDays: 0, due: now });
          show(`${card.front} moved back to learning`);
          onClose();
        })}
        {quick('Learned', 'checkmark-circle-outline', card.intervalDays >= MASTERED_INTERVAL_DAYS, () => {
          actions.updateCard(card.id, {
            stepIndex: null,
            reps: Math.max(card.reps, 1),
            intervalDays: Math.max(card.intervalDays, MASTERED_INTERVAL_DAYS),
            due: now + MASTERED_INTERVAL_DAYS * 86_400_000,
          });
          show(`${card.front} marked learned`);
          onClose();
        })}
      </View>

      <Btn
        full
        icon="pencil"
        onPress={() => {
          onClose();
          router.push({ pathname: '/card-editor', params: { cardId: card.id } });
        }}
      >
        Edit card
      </Btn>
    </Sheet>
  );
}
