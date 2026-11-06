/**
 * DirectionsSheet — which directions of each card type this deck studies
 * (spec §8.2). One checkbox per template, with the deck's card count:
 *
 *   GERMAN VOCABULARY
 *   ☑ German → English · 6,845 cards
 *   ☐ English → German · 0 cards
 *
 * - Turning a direction ON → `setDirections` creates the missing cards
 *   (New, or Not started when the deck's new cards arrive as Not started
 *   or when the item's other never-studied cards are all Not started).
 * - Turning one OFF KEEPS its cards and their progress: Study simply leaves
 *   them out (eligibility), and they come back with their history when the
 *   direction is turned on again.
 * - The last direction of a card type cannot be turned off (the checkbox is
 *   disabled), so a deck never has nothing to study by accident.
 *
 * The page does the store call (`onSet`) and shows the snackbar.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { Ion, Overline, Sheet } from '@/components/ui';
import { plural } from '@/domain/text';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { type DirectionType, toggledOrds } from './deckPageLogic';

interface DirectionsSheetProps {
  open: boolean;
  onClose: () => void;
  types: readonly DirectionType[];
  /** Turn the directions `ords` of card type `typeId` on (the others off). `on` = the tapped one is now on. */
  onSet: (typeId: string, ords: number[], on: boolean) => void;
}

export function DirectionsSheet({ open, onClose, types, onSet }: DirectionsSheetProps) {
  const c = useColors();
  return (
    <Sheet open={open} onClose={onClose} title="Directions">
      <Text style={[font('sans', 400), { fontSize: 13.5, lineHeight: 19, color: c.ink2, marginBottom: 8 }]}>
        Turning a direction off keeps its cards and progress. They come back when you turn it on again.
      </Text>
      {types.map((t) => (
        <View key={t.typeId} style={{ marginTop: 12 }}>
          {types.length > 1 ? (
            <Overline header style={{ marginBottom: 4 }}>
              {t.name}
            </Overline>
          ) : null}
          {t.rows.map((row) => {
            const next = toggledOrds(t.rows, row.ord);
            const locked = next === null;
            return (
              <Pressable
                key={row.ord}
                disabled={locked}
                onPress={() => {
                  if (next) onSet(t.typeId, next, !row.on);
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: row.on, disabled: locked }}
                accessibilityLabel={`${row.label}, ${plural(row.cards, 'card')}`}
                accessibilityHint={locked ? 'The last direction cannot be turned off' : undefined}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, opacity: locked ? 0.6 : 1 }}
              >
                <Ion name={row.on ? 'checkbox' : 'square-outline'} size={22} color={row.on ? c.pine : c.ink3} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>{row.label}</Text>
                  <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>
                    {row.cards === 0 && !row.on ? 'No cards yet — turning it on makes them' : plural(row.cards, 'card')}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </Sheet>
  );
}
