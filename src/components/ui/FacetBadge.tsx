/**
 * FacetBadge — a short field value as a small pill: "B1" on a card, a
 * Library row or a FacetBars row (spec §6.2, §8.3, §8.13).
 *
 * Colour rule (spec §8.13): the CEFR tokens (`c.cefr.A1 … C2`) were dead
 * code; they become live HERE. When the value belongs to an ordinal filter
 * group whose values look like CEFR levels, the pill uses the colour of its
 * RANK (ordinal.ts): A1 = 1 … C2 = 6. A sub-level keeps its level's colour
 * (A1.1, A1+ → A1; Pre-A1 → A1). Every other value is the kit's neutral
 * `Pill` (the same look as every other Pill on the row).
 *
 *   <FacetBadge value="B1" label="Level" />                 → B1 colours (detected from the value)
 *   <FacetBadge value="B1" label="Level" kind="cefr" />     → B1 colours (the group is CEFR)
 *   <FacetBadge value="B1" label="Room" kind={null} />      → neutral (the group is not ordinal)
 *   <FacetBadge value="noun" label="Type" />                → neutral
 *
 * `kind` is the group's ordinal kind (`Facet.ordinal`). Pass it when you
 * know it: a "B1" in a group of room numbers is not a level. Leave it out
 * (undefined) when you only have the value, for example a card badge: then
 * the value alone decides.
 *
 * Accessibility: the pill reads "Level: B1" (the label, then the value).
 */
import React from 'react';
import { StyleProp, Text, View, ViewStyle } from 'react-native';

import { detectOrdinal, type OrdinalKind } from '@/domain/ordinal';
import { font, type Palette, type StatePair, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Pill } from './badges';

/** The six CEFR levels, by rank (rank 1 = A1). */
export const CEFR_KEYS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

export type CefrKey = (typeof CEFR_KEYS)[number];

/**
 * Which CEFR colour a value gets, or null for a neutral pill.
 *
 *   cefrKeyOf('B1')                → 'B1'
 *   cefrKeyOf('a2.1')              → 'A2'   (sub-level → its level)
 *   cefrKeyOf('Pre-A1')            → 'A1'   (below A1 → the A1 colour)
 *   cefrKeyOf('B1', 'cefr')        → 'B1'
 *   cefrKeyOf('B1', null)          → null   (the group is not ordinal)
 *   cefrKeyOf('N5', 'jlpt')        → null   (another ordinal kind)
 *   cefrKeyOf('noun')              → null
 */
export function cefrKeyOf(value: string, kind?: OrdinalKind | null): CefrKey | null {
  if (kind !== undefined && kind !== 'cefr') return null;
  const ordinal = detectOrdinal([value ?? '']);
  if (!ordinal || ordinal.kind !== 'cefr') return null;
  const rank = ordinal.rank(value);
  if (!Number.isFinite(rank)) return null;
  const level = Math.min(CEFR_KEYS.length, Math.max(1, Math.floor(rank)));
  return CEFR_KEYS[level - 1];
}

/** The fg / tint colours of a badge value (see cefrKeyOf); neutral = ink2 on paperSunk. */
export function facetBadgeColors(c: Palette, value: string, kind?: OrdinalKind | null): StatePair {
  const key = cefrKeyOf(value, kind);
  return key ? c.cefr[key] : { fg: c.ink2, tint: c.paperSunk };
}

/** The screen-reader text of a badge: "Level: B1", or the value alone. */
export function facetBadgeLabel(value: string, label?: string): string {
  return label ? `${label}: ${value}` : value;
}

interface FacetBadgeProps {
  /** The value shown, e.g. "B1". */
  value: string;
  /** The field or group label, e.g. "Level" (screen reader only). */
  label?: string;
  /** The group's ordinal kind (Facet.ordinal). undefined = decide from the value. */
  kind?: OrdinalKind | null;
  /**
   * Font size of a CEFR badge; the design's level badge is 11.5. A neutral
   * value is a plain Pill and keeps the Pill's size.
   */
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function FacetBadge({ value, label, kind, size = 11.5, style }: FacetBadgeProps) {
  const c = useColors();
  const level = cefrKeyOf(value, kind);
  const a11yLabel = facetBadgeLabel(value, label);
  // A value that is not a CEFR level is the kit's neutral Pill (spec §8.13),
  // so it looks exactly like the Pills next to it (a tag, "next in 3d").
  if (!level) {
    return (
      <Pill label={a11yLabel} style={style}>
        {value}
      </Pill>
    );
  }
  // A CEFR level is the design's LevelBadge (design/ui_kits/app-v2/ui.jsx):
  // its CEFR colours, weight 800, 11.5 pt by default, 3 × 8 padding.
  const pair = c.cefr[level];
  return (
    <View
      style={[
        {
          backgroundColor: pair.tint,
          paddingVertical: 3,
          paddingHorizontal: 8,
          borderRadius: 999,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        // On the Text, not the View: inside a pressable row the row reads it
        // ("…, Level: B1, …") instead of making the badge a second stop.
        accessibilityLabel={a11yLabel}
        style={[font('sans', 800), tnum, { fontSize: size, color: pair.fg, letterSpacing: size * 0.01 }]}
      >
        {value}
      </Text>
    </View>
  );
}
