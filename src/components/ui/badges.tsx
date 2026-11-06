/**
 * Badges & chips: card-status dots/badges, filter chips, the streak chip with
 * freeze count, the deck icon square, and the deck-provenance tile/tag
 * ("Imported", "Starter deck", "Your deck").
 *
 * Status keys (spec §8.13): the six statuses of `life()` (src/domain/life.ts)
 * plus 'due' (a filter, drawn like a status in a few rows):
 *   notStarted  ink3 outline dot on paperSunk, glyph 'ellipse-outline'
 *   new … due   the existing `state` tokens
 *   known       mastered.fg, glyph 'checkmark-done'
 * The status is never shown by colour only: rows say the status word, and
 * StateDot is hidden from screen readers (spec §8.12).
 *
 * Badges are NOT separate screen-reader stops: they sit inside rows that
 * are one pressable element, and that element reads their text. So a badge
 * only hides its glyph (A11Y_HIDDEN) and lets its words be read.
 */
import React, { useState } from 'react';
import { Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';

import type { LifeKey, SourceKind } from '@/domain/model';
import { font, type Palette, type StatePair, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { A11Y_HIDDEN, childText } from './buttons';
import { Ion } from './Ion';

/** A status a badge can show: the six lifecycle statuses, plus 'due'. */
export type StatusKey = LifeKey | 'due';

/** Canonical status glyphs (ui.jsx STATE_ICON, + notStarted / known of spec §8.13). */
export const STATE_ICON: Record<StatusKey, string> = {
  notStarted: 'ellipse-outline',
  new: 'sparkles',
  learning: 'school',
  review: 'repeat',
  mastered: 'checkmark-circle',
  known: 'checkmark-done',
  due: 'time',
};

/**
 * The fg / tint colours of a status. The two v3 statuses have no `state`
 * token of their own (spec §8.13): Not started is neutral (ink2 text on
 * paperSunk, so the text stays readable), Known uses the mastered pair.
 */
export function statusColors(c: Palette, state: StatusKey): StatePair {
  if (state === 'notStarted') return { fg: c.ink2, tint: c.paperSunk };
  if (state === 'known') return c.state.mastered;
  return c.state[state] ?? c.state.new;
}

export function StateDot({ state, size = 7 }: { state: StatusKey; size?: number }) {
  const c = useColors();
  // Not started: an outline dot (ink3 ring on paperSunk), so it reads "empty".
  const outline = state === 'notStarted';
  return (
    <View
      {...A11Y_HIDDEN}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        backgroundColor: outline ? c.paperSunk : statusColors(c, state).fg,
        borderWidth: outline ? 1 : 0,
        borderColor: outline ? c.ink3 : undefined,
      }}
    />
  );
}

export function StateBadge({
  state,
  label,
  icon,
}: {
  state: StatusKey;
  label: string;
  icon?: string | false;
}) {
  const c = useColors();
  const pair = statusColors(c, state);
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
      {/* The glyph is decoration: the status word says it (never colour only). */}
      {icon !== false && (
        <View {...A11Y_HIDDEN}>
          <Ion name={icon || STATE_ICON[state]} size={13} color={pair.fg} />
        </View>
      )}
      <Text style={[font('sans', 700), { fontSize: 12, color: pair.fg }]}>{label}</Text>
    </View>
  );
}

/* --------------------------------------------------------------- chips */

/** The screen-reader label of a chip's × (spec §8.12, exact copy). */
export function removeFilterLabel(label: string): string {
  return `Remove filter ${label}`;
}

/**
 * How far a chip's touch area reaches above and below the chip. A chip is
 * about 33 pt high; 6 pt more on each side makes the target 44 pt or more.
 */
const CHIP_SLOP = 6;

interface ChipProps {
  active?: boolean;
  icon?: string;
  children: React.ReactNode;
  onPress?: () => void;
  dismiss?: boolean;
  onDismiss?: () => void;
  /** Screen-reader label. Default: the chip text. Also used in "Remove filter {label}". */
  label?: string;
}

/**
 * A chip: a choice (active = selected) or an applied filter with a × to
 * remove it. The chip and its × are TWO targets, each with its own label
 * (spec §8.12), so a screen reader can reach "Remove filter Level: B1".
 * A chip WITHOUT `onPress` (a filter chip you can only remove) says its label
 * as plain text: it is not called a button, and only the × is one (W3-7
 * hardening: "Deck: German, button, selected" did nothing on a double tap).
 *
 * Layout: the visible pill is a background layer; the two Pressables sit on
 * it and are 6 pt taller above and below (the negative margin keeps the
 * layout size of the pill). So both touch targets are ≥ 44 pt high, and a
 * tap on the label never hits the ×.
 */
export function Chip({ active, icon, children, onPress, dismiss, onDismiss, label }: ChipProps) {
  const c = useColors();
  const [pressed, setPressed] = useState(false);
  // An active chip is pine: its text is inkOnColor (white was 2.9:1 on the Evening pine).
  const fg = active ? c.inkOnColor : c.ink2;
  const text = label ?? childText(children);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'stretch',
        marginVertical: -CHIP_SLOP,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      }}
    >
      {/* the visible pill, behind both targets (they cover it, so it gets no touch) */}
      <View
        {...A11Y_HIDDEN}
        style={{
          position: 'absolute',
          top: CHIP_SLOP,
          bottom: CHIP_SLOP,
          left: 0,
          right: 0,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: active ? c.pine : c.hairlineStrong,
          backgroundColor: active ? c.pine : 'transparent',
        }}
      />
      <Pressable
        onPress={onPress}
        // No onPress (a dismiss-only filter chip): the label is plain text —
        // no "button" for a screen reader, and no press animation.
        onPressIn={onPress ? () => setPressed(true) : undefined}
        onPressOut={onPress ? () => setPressed(false) : undefined}
        accessibilityRole={onPress ? 'button' : 'text'}
        accessibilityLabel={text}
        accessibilityState={onPress ? { selected: !!active } : undefined}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          // 7 pt padding + 1 pt border of the pill + the slop.
          paddingVertical: 8 + CHIP_SLOP,
          paddingLeft: 14,
          paddingRight: dismiss ? 0 : 14,
        }}
      >
        {icon ? <Ion name={icon} size={14} color={fg} /> : null}
        <Text style={[font('sans', 700), { fontSize: 13.5, color: fg }]}>{children}</Text>
      </Pressable>
      {dismiss ? (
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={text !== undefined ? removeFilterLabel(text) : 'Remove filter'}
          // Only to the right: a slop to the left would cover the label.
          hitSlop={{ right: 10 }}
          style={{
            justifyContent: 'center',
            paddingVertical: 8 + CHIP_SLOP,
            paddingLeft: 6,
            paddingRight: 14,
          }}
        >
          <Ion name="close" size={13} color={fg} />
        </Pressable>
      ) : null}
    </View>
  );
}

interface PillProps {
  children: React.ReactNode;
  fg?: string;
  bg?: string;
  mono?: boolean;
  style?: StyleProp<ViewStyle>;
  /**
   * Screen-reader text, when the pill should say more than it shows:
   * `<Pill label="Level: B1">B1</Pill>`. Default: the shown text. It sits on
   * the Text, so a pressable row around the pill still reads it as part of
   * the row (no second stop).
   */
  label?: string;
}

export function Pill({ children, fg, bg, mono, style, label }: PillProps) {
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
        accessibilityLabel={label}
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

/** The streak chip's screen-reader label: "12-day streak, 2 freezes". */
export function streakLabel(days: number, freezes = 0): string {
  const streak = `${days.toLocaleString('en-US')}-day streak`;
  if (freezes <= 0) return streak;
  return `${streak}, ${freezes} ${freezes === 1 ? 'freeze' : 'freezes'}`;
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
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={streakLabel(days, freezes)}
      // About 32 pt high: 6 pt above and below make the target 44 pt.
      hitSlop={{ top: 6, bottom: 6 }}
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
// Single source of truth for where a deck came from, shown on every deck
// surface. Driven by `deck.source` (v3, spec §8.13), NOT the icon emoji:
// imports can carry any emoji, so the emoji can't signal origin. The map
// carries the entire role — glyph, label, and the fg/bg color KEYS — so
// DeckTag and DeckTile resolve identical visuals via useColors() and can't
// drift apart. Starter decks read pine (the brand, leaf = evergreen);
// imported decks read info-blue (download echoes the import action); your
// own decks are neutral (a pencil: you made it).

/** The three provenance labels a deck can carry. */
export type Provenance = 'starter' | 'imported' | 'own';

const PROVENANCE = {
  starter: { glyph: 'leaf', label: 'Starter deck', fg: 'pine', bg: 'pineTint' },
  imported: { glyph: 'download', label: 'Imported', fg: 'info', bg: 'infoTint' },
  own: { glyph: 'pencil', label: 'Your deck', fg: 'ink2', bg: 'paperSunk' },
} as const satisfies Record<Provenance, { glyph: string; label: string; fg: keyof Palette; bg: keyof Palette }>;

/** The UI word of each provenance (spec §7 #46, §8.13). */
export const PROVENANCE_LABEL: Readonly<Record<Provenance, string>> = Object.freeze({
  starter: PROVENANCE.starter.label,
  imported: PROVENANCE.imported.label,
  own: PROVENANCE.own.label,
});

/**
 * Which label a deck gets, from its `Deck.source` only (spec §7 #46: the old
 * `Deck.builtin` flag is dead and is never read here):
 *
 *   'pack'                     → 'starter'   ("Starter deck")
 *   'apkg' | 'ankiweb' | 'csv' → 'imported'  ("Imported")
 *   'manual'                   → 'own'       ("Your deck")
 *   'migrated' | 'backup'      → 'own'       ("Your deck": a deck from an older
 *                                             version or a backup is yours)
 *   no source (damaged data)   → null        (no tag)
 */
export function deckProvenance(source?: SourceKind | null): Provenance | null {
  switch (source) {
    case 'pack':
      return 'starter';
    case 'apkg':
    case 'ankiweb':
    case 'csv':
      return 'imported';
    case 'manual':
    case 'migrated':
    case 'backup':
      return 'own';
    default:
      return null;
  }
}

interface ProvenanceProps {
  /** Where the deck came from (`Deck.source`). */
  source?: SourceKind | null;
}

/**
 * DeckTag — the explicit half: a glyph + label chip (e.g. leaf + "Starter
 * deck"). Glyph, label, and color all come from PROVENANCE so the chip
 * can't desync. Its counterpart <DeckTile> is the text-free corner seal.
 */
export function DeckTag({ source }: ProvenanceProps) {
  const c = useColors();
  const kind = deckProvenance(source);
  if (!kind) return null;
  const p = PROVENANCE[kind];
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
      <View {...A11Y_HIDDEN}>
        <Ion name={p.glyph} size={9.5} color={fg} />
      </View>
      <Text style={[font('sans', 800), { fontSize: 10.5, color: fg, letterSpacing: 0.2 }]}>
        {p.label}
      </Text>
    </View>
  );
}

/**
 * Deck identity tile = icon square + a provenance seal in the corner. The seal
 * is the glanceable half (no text needed). Only decks that came from
 * somewhere else get a seal (starter, imported): your own deck shows a bare
 * icon. `ring` should match the surface BEHIND the tile so the seal reads as
 * a sticker — paper on list rows (default), surface inside a sheet.
 */
export function DeckTile({
  icon,
  source,
  size = 38,
  ring,
  seal = true,
}: ProvenanceProps & {
  icon: string;
  size?: number;
  ring?: string;
  seal?: boolean;
}) {
  const c = useColors();
  const d = Math.max(15, Math.round(size * 0.44));
  const kind = deckProvenance(source);
  const showSeal = seal && (kind === 'starter' || kind === 'imported');
  const p = PROVENANCE[kind ?? 'starter'];
  const fg = c[p.fg];
  const bg = c[p.bg];
  return (
    <View style={{ width: size, height: size }}>
      <IconSq icon={icon} size={size} />
      {/* The seal is decorative: DeckTag (or the row text) says the same in words. */}
      {showSeal && (
        <View
          {...A11Y_HIDDEN}
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
