/**
 * FacetBarsBlock — the "By {group}" part of the deck page (spec §8.2):
 *
 *   BY LEVEL                                                   (one block per ordinal filter group)
 *   A1  ▓▓▓▓▓▓▓▓▓▓ Known            1,530 cards     ⋯
 *   A2  ▓▓▓▓▓▓░░░░ 62% mastered     1,624 cards     ⋯
 *   BY SECTION                                                  (tree; collapsed below level 1)
 *   Vocabulary  ▓▓▓░░░ 21% mastered · 13,690 cards              ⋯
 *     A1 …  A2 …                                                (after a tap on "Vocabulary")
 *
 * Built from the kit's FacetBars (spec §8.13). The blocks and their counts
 * come from deckPageLogic.ts `barBlocks`. What a tap does is the page's job:
 *   - a field row: Browse (the Library with Deck + Level chips);
 *   - a section row with sub-sections: open or close it (the tree starts
 *     collapsed below level 1); without sub-sections: Browse;
 *   - ⋯: the row menu (Study, Practice, Learn all, Mark all as known, Browse).
 */
import React, { useState } from 'react';
import { View } from 'react-native';

import { FacetBars, SectionHead } from '@/components/ui';

import type { BarBlock, BarRow } from './deckPageLogic';

interface FacetBarsBlockProps {
  blocks: readonly BarBlock[];
  onBrowse: (block: BarBlock, row: BarRow) => void;
  onMore: (block: BarBlock, row: BarRow) => void;
}

export function FacetBarsBlock({ blocks, onBrowse, onMore }: FacetBarsBlockProps) {
  return (
    <View>
      {blocks.map((block) =>
        block.key === 'section' ? (
          <SectionTree key={block.key} block={block} onBrowse={onBrowse} onMore={onMore} />
        ) : (
          <FacetBars
            key={block.key}
            group={block.group}
            kind={block.kind}
            rows={block.rows}
            onPressRow={(row) => onBrowse(block, row as BarRow)}
            onMoreRow={(row) => onMore(block, row as BarRow)}
          />
        ),
      )}
    </View>
  );
}

/** The section tree: level 1 rows; a tap on a row with sub-sections opens it. */
function SectionTree({
  block,
  onBrowse,
  onMore,
}: {
  block: BarBlock;
  onBrowse: (block: BarBlock, row: BarRow) => void;
  onMore: (block: BarBlock, row: BarRow) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (value: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  const level = (rows: readonly BarRow[], depth: number): React.ReactNode =>
    rows.map((row) => (
      <View key={row.value} style={{ marginLeft: depth * 18 }}>
        <FacetBars
          heading={false}
          group={block.group}
          rows={[row]}
          onPressRow={() => (row.children.length > 0 ? toggle(row.value) : onBrowse(block, row))}
          onMoreRow={() => onMore(block, row)}
        />
        {open.has(row.value) && row.children.length > 0 ? level(row.children, depth + 1) : null}
      </View>
    ));

  return (
    <View>
      <SectionHead>{`By ${block.group.toLowerCase()}`}</SectionHead>
      {level(block.rows, 0)}
    </View>
  );
}
