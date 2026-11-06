/**
 * LibraryRow — one card in the Library list (spec §8.3, unit W4-2):
 *
 *   die Reise                                   B1     ← FacetBadge of the first ordinal group
 *   the trip                                           (or the interval, "6d")
 *   ● Review · next 4d · German → English     ♥ ⚑ ⏸   ← status word, direction, markers
 *
 *   - The status is a dot AND a word (colour is never the only signal,
 *     spec §8.12); the dot is hidden from screen readers.
 *   - "next 4d" (libraryState rowStatus) comes from the ONE due rule of the
 *     app (src/utils/dateFormatting.ts, wave 5i): the CardSheet of the same
 *     card says the same number in words ("next in 4 days"). Before, the row
 *     rounded the time left and the sheet counted calendar days, so one card
 *     read "next 4d" here and "next in 3 days" in its sheet.
 *   - Markers: ♥ favorite, ⚑ flagged (device finding: the flag state was
 *     invisible in rows), ⏸ suspended; "Deck paused" for a card of a paused
 *     deck (spec §11 E14 "the paused dot").
 *   - The direction ("German → English") shows only when the shown cards
 *     have 2+ directions (the screen passes `dirLabel` only then). Its text
 *     follows the Direction filter group (libraryState directionLabeler):
 *     the languages when the card type knows them, else the group's role
 *     label ("Back → Front") when the group names directions by role, else
 *     the template name.
 *   - Every text is ONE line with "…" at the end, so a long text never breaks
 *     the fixed row height. The height is fixed (`height`, libraryState
 *     rowHeight) so the list can use getItemLayout; the texts stop growing
 *     at ROW_FONT_CAP times the normal size.
 *   - In select mode a tap selects; the row is a checkbox for a screen reader.
 *
 * The row is memoized (React.memo) and takes only stable values (the card
 * object, the shared lookups, `now`), so the list re-draws only the rows
 * whose card or selection changed.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { A11Y_HIDDEN, FacetBadge, Ion, StateDot } from '@/components/ui';
import type { FaceOf } from '@/domain/face';
import type { LibraryIndex } from '@/domain/libraryIndex';
import type { Card, Deck, Id } from '@/domain/model';
import { formatIntervalDays } from '@/domain/srs';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { type OrdinalField, ROW_FONT_CAP, rowBadge, rowStatus } from './libraryState';

interface LibraryRowProps {
  card: Card;
  faceOf: FaceOf;
  index: LibraryIndex;
  decks: ReadonlyMap<Id, Deck>;
  /** The ordinal filter groups of the library (the badge uses the first one the card has). */
  fields: readonly OrdinalField[];
  /** The direction label maker, or null when the shown cards have one direction. */
  dirLabel: ((card: Card) => string) | null;
  now: number;
  height: number;
  selecting: boolean;
  selected: boolean;
  onPress: (cardId: string) => void;
}

/** The texts of a row (also what a screen reader says). */
export interface RowTexts {
  prompt: string;
  answer: string;
  status: string;
  badge: string | null;
  direction: string | null;
  paused: boolean;
  markers: string[];
}

/** What a screen reader says for a row: every text and marker, in order. */
export function rowA11yLabel(t: RowTexts): string {
  const parts = [t.prompt || 'Empty card', t.answer, t.status];
  if (t.badge) parts.push(t.badge);
  if (t.direction) parts.push(t.direction);
  if (t.paused) parts.push('Deck paused');
  parts.push(...t.markers);
  return parts.filter((p) => p !== '').join(', ');
}

function LibraryRowBase(props: LibraryRowProps) {
  const { card, faceOf, index, decks, fields, dirLabel, now, height, selecting, selected, onPress } = props;
  const c = useColors();
  const face = faceOf(card);
  const status = rowStatus(card, now);
  const badge = rowBadge(card, index, fields);
  const graduated = card.reps > 0 && card.stepIndex === null && card.knownAt == null && card.intervalDays > 0;
  const interval = !badge && graduated ? formatIntervalDays(card.intervalDays) : null;
  const direction = dirLabel ? dirLabel(card) : null;
  const paused = decks.get(card.deckId)?.active === false;
  const markers = [card.fav ? 'Favorite' : '', card.flagged ? 'Flagged' : '', card.suspended ? 'Suspended' : ''].filter(Boolean);
  const detail = [status.text, direction, paused ? 'Deck paused' : null].filter(Boolean).join(' · ');
  const label = rowA11yLabel({
    prompt: face.promptPlain,
    answer: face.answerPlain,
    status: status.text,
    badge: badge ? `${badge.label}: ${badge.value}` : interval ? `interval ${interval}` : null,
    direction,
    paused,
    markers,
  });

  return (
    <Pressable
      onPress={() => onPress(card.id)}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={label}
      accessibilityHint={selecting ? undefined : 'Opens the card'}
      style={({ pressed }) => ({
        height,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        overflow: 'hidden',
        borderBottomWidth: 1,
        borderBottomColor: c.hairlineSoft,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {selecting ? (
        <View
          {...A11Y_HIDDEN}
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            borderWidth: selected ? 0 : 1.5,
            borderColor: c.hairlineStrong,
            backgroundColor: selected ? c.pine : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selected ? <Ion name="checkmark" size={14} color="#fff" /> : null}
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={ROW_FONT_CAP}
            style={[font('serif', 600), { flex: 1, fontSize: 17.5, color: c.ink }]}
          >
            {face.promptPlain || '—'}
          </Text>
          {badge ? (
            <FacetBadge value={badge.value} label={badge.label} kind={badge.kind} />
          ) : interval ? (
            <Text maxFontSizeMultiplier={ROW_FONT_CAP} style={[font('mono', 400), tnum, { fontSize: 11.5, color: c.ink3 }]}>
              {interval}
            </Text>
          ) : null}
        </View>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={ROW_FONT_CAP}
          style={[font('sans', 400), { fontSize: 13, color: c.ink2 }]}
        >
          {face.answerPlain || ' '}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <StateDot state={status.key} />
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={ROW_FONT_CAP}
            style={[font('sans', 500), { flex: 1, fontSize: 12, color: c.ink3 }]}
          >
            {detail}
          </Text>
          <View {...A11Y_HIDDEN} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {card.fav ? <Ion name="heart" size={13} color={c.danger} /> : null}
            {card.flagged ? <Ion name="flag" size={13} color={c.amber} /> : null}
            {card.suspended ? <Ion name="pause-circle" size={13} color={c.ink3} /> : null}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export const LibraryRow = React.memo(LibraryRowBase);
