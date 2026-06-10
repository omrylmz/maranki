/**
 * Card peek — the universal card detail sheet. Audio (real TTS), example,
 * state/level/interval badges, quick state toggles (real writes), and the
 * pronunciation-practice entry (stub per WIRING.md §3 — C4 backend).
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  Btn,
  IconBtn,
  Ion,
  LevelBadge,
  Pill,
  Sheet,
  StateBadge,
} from '@/components/ui';
import { speakWord } from '@/domain/speech';
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

export function CardPeek({ card, onClose }: CardPeekProps) {
  const c = useColors();
  const router = useRouter();
  const { actions } = useData();
  const { show } = useSnackbar();
  const now = useNow();

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
    <Sheet open onClose={onClose}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              font('serif', 600),
              { fontSize: 28, lineHeight: 31, letterSpacing: -0.42, color: c.ink },
            ]}
          >
            {card.word}
          </Text>
          {card.ipa ? (
            <Text
              numberOfLines={1}
              style={[font('mono', 400), { fontSize: 13, color: c.ink3, marginTop: 5 }]}
            >
              {card.ipa}
            </Text>
          ) : null}
        </View>
        <IconBtn
          icon="volume-high-outline"
          size={38}
          iconSize={19}
          color={c.pine}
          bg={c.pineTint}
          onPress={() => speakWord(card.word, card.lang)}
        />
      </View>

      <Text style={[font('sans', 700), { fontSize: 17, color: c.ink, marginTop: 12, marginBottom: 2 }]}>
        {card.tr}
      </Text>
      {card.ex ? (
        <View style={{ marginTop: 10 }}>
          <Text style={[font('serif', 400, true), { fontSize: 15.5, lineHeight: 22, color: c.ink2 }]}>
            {card.ex}
          </Text>
          {card.exTr ? (
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}>
              {card.exTr}
            </Text>
          ) : null}
        </View>
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
        <LevelBadge level={card.level} />
        <Pill>{card.type}</Pill>
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
          show(`${card.base} moved back to learning`);
          onClose();
        })}
        {quick('Learned', 'checkmark-circle-outline', card.intervalDays >= MASTERED_INTERVAL_DAYS, () => {
          actions.updateCard(card.id, {
            stepIndex: null,
            reps: Math.max(card.reps, 1),
            intervalDays: Math.max(card.intervalDays, MASTERED_INTERVAL_DAYS),
            due: now + MASTERED_INTERVAL_DAYS * 86_400_000,
          });
          show(`${card.base} marked learned`);
          onClose();
        })}
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn
          kind="secondary"
          full
          style={{ flex: 1 }}
          icon="mic-outline"
          onPress={() => show('Pronunciation practice — record & compare')}
        >
          Say it
        </Btn>
        <Btn
          full
          style={{ flex: 1 }}
          icon="pencil"
          onPress={() => {
            onClose();
            router.push({ pathname: '/card-editor', params: { cardId: card.id } });
          }}
        >
          Edit card
        </Btn>
      </View>
    </Sheet>
  );
}
