/**
 * FacetMastery — one Progress "{DECK} · BY {GROUP}" block (spec §8.8,
 * unit W4-6): the mastery of each value of a deck's ordinal filter group.
 * A row opens the Library with the chips Deck + that value.
 *
 *   GERMAN · BY LEVEL
 *   (A1)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
 *         Known · 1,530 cards
 *   (A2)  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░
 *         62% mastered · 1,624 cards
 *
 * The blocks come from progressLogic.ts `groupBlocks` (the group is found
 * from the data: Level, a numbered section …, never from a language). The
 * rows are drawn by the kit's FacetBars (the same rows as the deck page),
 * so "{p}% mastered" never counts Known cards.
 *
 * The heading is drawn here, not by FacetBars, because it names the deck
 * too. It is one line: a long deck name is cut with "…", so the heading
 * never runs past the edge of the screen.
 */
import React from 'react';
import { View } from 'react-native';

import { FacetBars, Overline } from '@/components/ui';

import { type GroupBlock, groupHeading, type GroupRow } from './progressLogic';

interface FacetMasteryProps {
  block: GroupBlock;
  /** Open the Library with this row's chips (row.query). */
  onOpenRow: (row: GroupRow) => void;
}

export function FacetMastery({ block, onOpenRow }: FacetMasteryProps) {
  return (
    <View>
      <View style={{ flexDirection: 'row', marginTop: 26, marginBottom: 6 }}>
        <Overline header style={{ flexShrink: 1 }}>
          {groupHeading(block)}
        </Overline>
      </View>
      <FacetBars
        group={block.group}
        kind={block.kind}
        rows={block.rows}
        heading={false}
        onPressRow={(pressed) => {
          // FacetBars gives back the row it drew; find the full row (with its query) by value.
          const row = block.rows.find((r) => r.value === pressed.value);
          if (row) onOpenRow(row);
        }}
      />
    </View>
  );
}
