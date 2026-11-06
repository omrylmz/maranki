/**
 * FacetBars — one mastery row per value of a filter group, under a "BY
 * {GROUP}" heading (spec §8.2 deck page, §8.8 Progress):
 *
 *   BY LEVEL
 *   (A1)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                 ⋯
 *         Known · 1,530 cards
 *   (A2)  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░                 ⋯
 *         62% mastered · 1,624 cards
 *
 * Built only from kit atoms (spec §8.13): SectionHead, Row, FacetBadge,
 * SegBar and IconBtn (the "Bar/SegBar + ListRow" composite of §8.13). The caller computes the counts (one pass in the
 * selectors, W3-4) and decides what a tap does:
 *   onPressRow  the row (for example the Library with Deck + Level chips);
 *   onMoreRow   the ⋯ button (the deck page's value menu: Study, Practice,
 *               Learn all, Mark all as known, Browse).
 *
 * Numbers (spec §8.8): the bar stacks mastered | review | learning | new |
 * not started | known. "{p}% mastered" counts Mastered cards only — Known
 * is never counted as mastered. The percent is rounded DOWN, so a row
 * never claims 100% while one card is not mastered. A row where every card
 * is Known says "Known".
 *
 * Accessibility: each row is one element with a summary label, for example
 * "Level B1: 8 percent mastered, 1,624 cards" (spec §8.12); the ⋯ button has
 * its own label ("Actions for Level B1").
 *
 * Large font sizes (device pass 2026-11-02, F1-5: "0% mastere…" next to a
 * long section name). The badge and the bar part WRAP: the bar part is at
 * least BAR_MIN_WIDTH of the row; when the badge leaves less room than that
 * (a long section name, a large font size), the bar and its line go on
 * their own line under the badge. The line under the bar wraps too; it is
 * never cut.
 *
 *   (Core Patterns)  ▓▓▓▓▓▓▓▓▓▓▓▓▓            ⋯     ← normal font size
 *                    0% mastered · 120 cards
 *
 *   (Dynamic Programming)                       ⋯     ← large font size
 *   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
 *   0% mastered · 64 cards
 */
import React from 'react';
import { Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';

import type { OrdinalKind } from '@/domain/ordinal';
import { plural } from '@/domain/text';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { A11Y_HIDDEN, IconBtn } from './buttons';
import { FacetBadge } from './FacetBadge';
import { Row, SectionHead } from './layout';
import { SEG_ORDER, SegBar, type SegCounts } from './viz';

/** One value of the group (one row). */
export interface FacetBarRow extends SegCounts {
  /** A stable key, usually the facet value. */
  value: string;
  /** What the badge shows, e.g. "A1". */
  label: string;
  /** Cards with this value. Default: the sum of the six counts. */
  total?: number;
}

/** The number of cards in a row. */
export function rowTotal(row: FacetBarRow): number {
  if (row.total !== undefined) return Math.max(0, row.total);
  return SEG_ORDER.reduce((n, k) => n + Math.max(0, row[k] ?? 0), 0);
}

/** Mastered cards as a whole percent, rounded down (0 when the row is empty). */
export function masteredPercent(row: FacetBarRow): number {
  const total = rowTotal(row);
  if (total === 0) return 0;
  return Math.floor((Math.max(0, row.mastered ?? 0) * 100) / total);
}

/** True when every card of a non-empty row is Known. */
export function allKnown(row: FacetBarRow): boolean {
  const total = rowTotal(row);
  return total > 0 && (row.known ?? 0) >= total;
}

/**
 * The status words under the bar:
 *   every card Known → "Known"
 *   otherwise        → "62% mastered"
 */
export function facetBarStatus(row: FacetBarRow): string {
  return allKnown(row) ? 'Known' : `${masteredPercent(row)}% mastered`;
}

/** The line under the bar: "62% mastered · 1,624 cards". */
export function facetBarLine(row: FacetBarRow): string {
  return `${facetBarStatus(row)} · ${plural(rowTotal(row), 'card')}`;
}

/**
 * The row's screen-reader summary (spec §8.12):
 *   facetBarLabel('Level', B1 row) → "Level B1: 8 percent mastered, 1,624 cards"
 *   facetBarLabel('Level', A1 row) → "Level A1: Known, 1,530 cards"
 */
export function facetBarLabel(group: string, row: FacetBarRow): string {
  const status = allKnown(row) ? 'Known' : `${masteredPercent(row)} percent mastered`;
  return `${group} ${row.label}: ${status}, ${plural(rowTotal(row), 'card')}`;
}

/** The ⋯ button's label: "Actions for Level B1". */
export function facetBarMoreLabel(group: string, row: Pick<FacetBarRow, 'label'>): string {
  return `Actions for ${group} ${row.label}`;
}

/**
 * The smallest width of the bar part of a row, as a share of the row (the
 * row without its ⋯ button). A badge that leaves less room than this pushes
 * the bar part onto its own line (see the top of the file).
 */
export const BAR_MIN_WIDTH = '50%';

interface FacetBarsProps {
  /** The group's label, e.g. "Level". The heading reads "By level" (shown in capitals). */
  group: string;
  /** The group's ordinal kind (Facet.ordinal), for the badge colours. */
  kind?: OrdinalKind | null;
  rows: readonly FacetBarRow[];
  onPressRow?: (row: FacetBarRow) => void;
  onMoreRow?: (row: FacetBarRow) => void;
  /** false = no "By {group}" heading (the caller draws its own). */
  heading?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function FacetBars({ group, kind, rows, onPressRow, onMoreRow, heading = true, style }: FacetBarsProps) {
  const c = useColors();
  if (rows.length === 0) return null;
  return (
    <View style={style}>
      {heading ? <SectionHead>{`By ${group.toLowerCase()}`}</SectionHead> : null}
      {rows.map((row, i) => (
        // The row is a plain ledger Row; the badge + bar part is ONE pressable
        // element and the ⋯ is a SIBLING, so a screen reader reaches both
        // (a button inside a pressable row could not be focused on iOS).
        <Row key={row.value} padV={11} last={i === rows.length - 1}>
          <Pressable
            // No `disabled` without onPressRow: a screen reader would say "dimmed".
            onPress={onPressRow ? () => onPressRow(row) : undefined}
            accessible
            accessibilityRole={onPressRow ? 'button' : undefined}
            accessibilityLabel={facetBarLabel(group, row)}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              // The bar part goes under the badge when the two do not fit side by side.
              flexWrap: 'wrap',
              alignItems: 'center',
              columnGap: 12,
              rowGap: 8,
              opacity: pressed && onPressRow ? 0.75 : 1,
            })}
          >
            {/* The row's label already says "Level B1": the badge is not a second stop. */}
            <View {...A11Y_HIDDEN} style={{ minWidth: 34, maxWidth: '100%', flexShrink: 1 }}>
              <FacetBadge value={row.label} label={group} kind={kind} />
            </View>
            {/* At least BAR_MIN_WIDTH wide; it takes the rest of the line, or a line of its own. */}
            <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: BAR_MIN_WIDTH, gap: 5 }}>
              <SegBar
                h={5}
                total={row.total}
                mastered={row.mastered}
                review={row.review}
                learning={row.learning}
                neww={row.neww}
                notStarted={row.notStarted}
                known={row.known}
              />
              {/* No numberOfLines: "0% mastered · 64 cards" wraps, never "0% mastere…". */}
              <Text style={[font('sans', 400), tnum, { fontSize: 12, color: c.ink3 }]}>{facetBarLine(row)}</Text>
            </View>
          </Pressable>
          {onMoreRow ? (
            <IconBtn
              icon="ellipsis-horizontal"
              size={32}
              iconSize={17}
              color={c.ink3}
              label={facetBarMoreLabel(group, row)}
              onPress={() => onMoreRow(row)}
            />
          ) : null}
        </Row>
      ))}
    </View>
  );
}
