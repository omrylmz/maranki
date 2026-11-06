/**
 * DeckMastery — Progress "BY DECK" (spec §8.8, unit W4-6): one mastery bar
 * per deck. A tap opens the deck page.
 *
 *   BY DECK
 *   🇩🇪 German                                                 ›
 *      ▓▓▓▓▓▓▒▒▒░░░░░░░░░
 *      21% mastered · 1,240 cards
 *
 * The bar stacks mastered | review | learning | new | not started | known
 * (SegBar). "{p}% mastered" counts Mastered cards only: Known is never
 * counted as mastered (spec §8.8; the rule lives in FacetBars.tsx). A
 * paused deck is listed too, with "· Paused": its progress is real.
 *
 * Accessibility: each row is one button whose label says the deck and its
 * numbers ("German: 21% mastered · 1,240 cards"); the hint says where it goes.
 */
import React from 'react';
import { Text, View } from 'react-native';

import { A11Y_HIDDEN, Ion, Row, SectionHead, SegBar } from '@/components/ui';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { type DeckMasteryRow, deckRowLabel, deckRowLine } from './progressLogic';

interface DeckMasteryProps {
  rows: readonly DeckMasteryRow[];
  /** Open the deck page of this deck. */
  onOpenDeck: (deckId: string) => void;
}

export function DeckMastery({ rows, onOpenDeck }: DeckMasteryProps) {
  const c = useColors();
  if (rows.length === 0) return null;
  return (
    <View>
      <SectionHead>By deck</SectionHead>
      {rows.map((row, i) => (
        <Row
          key={row.value}
          padV={11}
          last={i === rows.length - 1}
          onPress={() => onOpenDeck(row.value)}
          label={deckRowLabel(row)}
          hint="Opens the deck page"
        >
          <Text {...A11Y_HIDDEN} style={{ fontSize: 17, width: 24, textAlign: 'center' }}>
            {row.icon}
          </Text>
          <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
            <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 14, color: c.ink }]}>
              {row.label}
            </Text>
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
            <Text numberOfLines={1} style={[font('sans', 400), tnum, { fontSize: 12, color: c.ink3 }]}>
              {deckRowLine(row)}
            </Text>
          </View>
          <View {...A11Y_HIDDEN}>
            <Ion name="chevron-forward" size={16} color={c.ink3} />
          </View>
        </Row>
      ))}
    </View>
  );
}
