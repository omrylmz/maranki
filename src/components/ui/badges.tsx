/**
 * Badges & chips: card-state dots/badges, filter chips, the streak chip with
 * freeze count, the deck icon square, and the deck-provenance tile/tag (curated
 * vs imported).
 */
import React from 'react';
import { Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';

import { CardState } from '@/domain/types';
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

/** Deck identity square — the icon emoji is data, not iconography. */
export function IconSq({ icon, size = 38 }: { icon: string; size?: number }) {
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
      <Text style={{ fontSize: size * 0.5 }}>{icon}</Text>
    </View>
  );
}

/* ----------------------------------------------------------- deck provenance */
// Single source of truth for "curated vs imported", shown on every deck surface
// (Home, Study, peek). Driven by deck.builtin, NOT the icon emoji: imports can
// carry any emoji, so the emoji can't signal origin. The map carries
// the entire role — glyph, label, and the fg/bg color KEYS — so DeckTag and
// DeckTile resolve identical visuals via useColors() and can't drift apart.
// Curated reads pine (the brand); imported reads info-blue. Glyphs: leaf
// (evergreen → curated) and download (echoes the import action → imported).

const PROVENANCE = {
  curated: { glyph: 'leaf', label: 'Curated', fg: 'pine', bg: 'pineTint' },
  imported: { glyph: 'download', label: 'Imported', fg: 'info', bg: 'infoTint' },
} as const;

/**
 * DeckTag — the explicit half: a glyph + label chip (e.g. leaf + "Curated").
 * Glyph, label, and color all come from PROVENANCE so the chip can't desync.
 * Its counterpart <DeckTile> is the text-free corner seal.
 */
export function DeckTag({ builtin }: { builtin: boolean }) {
  const c = useColors();
  const p = builtin ? PROVENANCE.curated : PROVENANCE.imported;
  const fg = c[p.fg];
  const bg = c[p.bg];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        backgroundColor: bg,
        paddingVertical: 2.5,
        paddingHorizontal: 7,
        borderRadius: 999,
        alignSelf: 'flex-start',
      }}
    >
      <Ion name={p.glyph} size={9.5} color={fg} />
      <Text style={[font('sans', 800), { fontSize: 10.5, color: fg, letterSpacing: 0.2 }]}>
        {p.label}
      </Text>
    </View>
  );
}

/**
 * Deck identity tile = icon square + a provenance seal in the corner. The seal
 * is the glanceable half (no text needed). `ring` should match the surface
 * BEHIND the tile so the seal reads as a sticker — paper on list rows (default),
 * surface inside a sheet.
 */
export function DeckTile({
  icon,
  builtin,
  size = 38,
  ring,
  seal = true,
}: {
  icon: string;
  builtin: boolean;
  size?: number;
  ring?: string;
  seal?: boolean;
}) {
  const c = useColors();
  const d = Math.max(15, Math.round(size * 0.44));
  const p = builtin ? PROVENANCE.curated : PROVENANCE.imported;
  const fg = c[p.fg];
  const bg = c[p.bg];
  return (
    <View style={{ width: size, height: size }}>
      <IconSq icon={icon} size={size} />
      {seal && (
        <View
          style={{
            position: 'absolute',
            right: -3,
            bottom: -3,
            width: d,
            height: d,
            borderRadius: 999,
            backgroundColor: bg,
            borderWidth: 2,
            borderColor: ring ?? c.paper,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ion name={p.glyph} size={Math.round(d * 0.56)} color={fg} />
        </View>
      )}
    </View>
  );
}
