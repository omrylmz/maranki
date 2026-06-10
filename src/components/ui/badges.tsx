/**
 * Badges & chips: CEFR level pills, card-state dots/badges, filter chips,
 * the streak chip with freeze count, and the deck flag square.
 */
import React from 'react';
import { Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';

import { CardState, CefrLevel } from '@/domain/types';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Ion } from './Ion';

/** Canonical state glyphs (ui.jsx STATE_ICON). */
export const STATE_ICON: Record<CardState, string> = {
  new: 'sparkles',
  learning: 'school',
  review: 'repeat',
  mastered: 'checkmark-circle',
  due: 'time',
};

export function LevelBadge({ level, size = 11.5 }: { level: CefrLevel; size?: number }) {
  const c = useColors();
  const pair = c.cefr[level] ?? c.cefr.A1;
  return (
    <View
      style={{
        backgroundColor: pair.tint,
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 999,
      }}
    >
      <Text style={[font('sans', 800), { fontSize: size, color: pair.fg, letterSpacing: 0.1 }]}>
        {level}
      </Text>
    </View>
  );
}

export function StateDot({ state, size = 7 }: { state: CardState; size?: number }) {
  const c = useColors();
  const pair = c.state[state] ?? c.state.new;
  return (
    <View
      style={{ width: size, height: size, borderRadius: 999, backgroundColor: pair.fg }}
    />
  );
}

export function StateBadge({
  state,
  label,
  icon,
}: {
  state: CardState;
  label: string;
  icon?: string | false;
}) {
  const c = useColors();
  const pair = c.state[state] ?? c.state.new;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: pair.tint,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
      }}
    >
      {icon !== false && <Ion name={icon || STATE_ICON[state]} size={13} color={pair.fg} />}
      <Text style={[font('sans', 700), { fontSize: 12, color: pair.fg }]}>{label}</Text>
    </View>
  );
}

interface ChipProps {
  active?: boolean;
  icon?: string;
  children: React.ReactNode;
  onPress?: () => void;
  dismiss?: boolean;
  onDismiss?: () => void;
}

export function Chip({ active, icon, children, onPress, dismiss, onDismiss }: ChipProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 7,
        paddingHorizontal: 13,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? c.pine : c.hairlineStrong,
        backgroundColor: active ? c.pine : 'transparent',
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      {icon ? <Ion name={icon} size={14} color={active ? '#fff' : c.ink2} /> : null}
      <Text style={[font('sans', 700), { fontSize: 13.5, color: active ? '#fff' : c.ink2 }]}>
        {children}
      </Text>
      {dismiss ? (
        <Pressable onPress={onDismiss} hitSlop={8}>
          <Ion name="close" size={13} color={active ? '#fff' : c.ink2} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

interface PillProps {
  children: React.ReactNode;
  fg?: string;
  bg?: string;
  mono?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Pill({ children, fg, bg, mono, style }: PillProps) {
  const c = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: bg ?? c.paperSunk,
          paddingVertical: 3,
          paddingHorizontal: 9,
          borderRadius: 999,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          mono ? font('mono', 500) : font('sans', 700),
          tnum,
          { fontSize: 12, color: fg ?? c.ink2 },
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

export function StreakChip({
  days,
  freezes = 0,
  onPress,
}: {
  days: number;
  freezes?: number;
  onPress?: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: c.amberTint,
        paddingVertical: 7,
        paddingLeft: 10,
        paddingRight: 12,
        borderRadius: 999,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Ion name="flame" size={17} color={c.amber} />
      <Text style={[font('sans', 800), tnum, { fontSize: 14.5, color: c.amberDeep }]}>{days}</Text>
      {freezes > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 2 }}>
          <Ion name="snow" size={13} color={c.info} />
          <Text style={[font('sans', 700), { fontSize: 12, color: c.info }]}>{freezes}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Deck identity square — flag emoji is data, not iconography. */
export function FlagSq({ flag, size = 38 }: { flag: string; size?: number }) {
  const c = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        backgroundColor: c.paperSunk,
        borderWidth: 1,
        borderColor: c.hairlineSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.5 }}>{flag}</Text>
    </View>
  );
}
