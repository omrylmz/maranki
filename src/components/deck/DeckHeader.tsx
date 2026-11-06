/**
 * DeckHeader — the top of the deck page (spec §8.2):
 *
 *   ‹                                                         ⋯
 *   🇩🇪  German                                       (Imported)
 *   15,960 cards · 15 sections · Imported from German_Complete.apkg
 *   [SegBar: mastered | review | learning | new | not started | known]
 *   Mastered 312 · Review 900 · Learning 48 · New 4,200 · Not started 8,970 · Known 1,530
 *
 * The line under the name names the file a deck from a file came from, when
 * its real name is known (walkthrough L15): from its sourceKey, else from its
 * items (`noteFile`), else "Imported" (deckPageLogic.ts `deckSourceLine`). A
 * name the import screen made up (the picker gave none) is never shown as a
 * file name. When items of the deck came from other files too (a newer
 * version imported into it), they follow the deck's own file: "Imported from
 * German_Vocabulary_v1.apkg and German_Vocabulary_v4.apkg" (`otherFiles`,
 * wave 5g).
 *
 * The back button and the ⋯ menu button are icon buttons with labels
 * ("Back", "Deck actions", spec §8.12). The bar has a summary label for a
 * screen reader. A paused deck shows one quiet line under the legend.
 *
 * Every text comes from deckPageLogic.ts; this file only draws it.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeckTag, DeckTile, IconBtn, Ion, SegBar } from '@/components/ui';
import type { Deck, LifeKey } from '@/domain/model';
import { plural } from '@/domain/text';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { DECK_COPY, deckSourceLine, deckSubLine, lifeLegend, segCountsOf, type OtherSourceFiles } from './deckPageLogic';

interface DeckHeaderProps {
  deck: Deck;
  /** Every card of the deck. */
  total: number;
  /** The number of sections (subdecks). */
  sections: number;
  /** Cards per status. */
  counts: Readonly<Record<LifeKey, number>>;
  /**
   * The file the deck's items came from (deckPageLogic.ts `noteSourceFile`),
   * for a deck whose sourceKey names no real file (an old 'file:msf:96' key,
   * or a nameless key with a made-up name); else null.
   */
  noteFile?: string | null;
  /**
   * The other files the deck's items came from (deckPageLogic.ts
   * `otherSourceFiles`), named after the deck's own file: "Imported from
   * German_Vocabulary_v1.apkg and German_Vocabulary_v4.apkg"; null = none.
   */
  otherFiles?: OtherSourceFiles | null;
  onBack: () => void;
  onMenu: () => void;
}

/**
 * The screen-reader summary of the status bar: "German: 312 mastered of
 * 15,960 cards" — "of 1 card" for one (plural()).
 */
export function barLabel(name: string, counts: Readonly<Record<LifeKey, number>>, total: number): string {
  const mastered = (counts.mastered ?? 0).toLocaleString('en-US');
  return `${name}: ${mastered} mastered of ${plural(total, 'card')}`;
}

export function DeckHeader({ deck, total, sections, counts, noteFile = null, otherFiles = null, onBack, onMenu }: DeckHeaderProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const sub = deckSubLine(total, sections, deckSourceLine(deck, noteFile, otherFiles));
  const legend = lifeLegend(counts);
  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: insets.top + 6,
          paddingBottom: 4,
        }}
      >
        <IconBtn icon="chevron-back" label="Back" color={c.ink} onPress={onBack} />
        <IconBtn icon="ellipsis-horizontal" label="Deck actions" color={c.ink} onPress={onMenu} />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 }}>
        <DeckTile icon={deck.icon} source={deck.source} size={52} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            accessibilityRole="header"
            style={[font('serif', 600), { fontSize: 28, lineHeight: 32, letterSpacing: -0.5, color: c.ink }]}
          >
            {deck.name}
          </Text>
          <View style={{ flexDirection: 'row', marginTop: 4 }}>
            <DeckTag source={deck.source} />
          </View>
        </View>
      </View>

      <Text style={[font('sans', 400), tnum, { fontSize: 13.5, lineHeight: 19, color: c.ink2, marginTop: 10 }]}>
        {sub}
      </Text>

      {total > 0 ? (
        <View style={{ marginTop: 12 }}>
          <SegBar h={6} total={total} label={barLabel(deck.name, counts, total)} {...segCountsOf(counts)} />
          {legend ? (
            <Text style={[font('sans', 400), tnum, { fontSize: 12, lineHeight: 17, color: c.ink3, marginTop: 7 }]}>
              {legend}
            </Text>
          ) : null}
        </View>
      ) : null}

      {!deck.active ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
          <Ion name="pause-circle-outline" size={15} color={c.ink3} />
          <Text style={[font('sans', 600), { flex: 1, fontSize: 12.5, color: c.ink3 }]}>{DECK_COPY.pausedBanner}</Text>
        </View>
      ) : null}
    </View>
  );
}
