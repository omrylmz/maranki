/**
 * Choose a deck (spec §2.3 "DeckPickerSheet"): the card editor's Deck field,
 * and later the Library's bulk "Move to deck…" (wave 4).
 *
 *   <DeckField deck={deck} onPress={() => setPicking(true)} />
 *   <DeckPickerSheet open={picking} onClose={…} decks={state.decks}
 *                    selectedId={deckId} cardCounts={counts} onPick={setDeckId} />
 *
 * The sheet only SHOWS decks and reports the choice; it never writes the
 * store. Decks are listed in deck order (`order`). A paused deck is listed
 * too (a card can live in a paused deck) and says "Paused".
 */
import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Ion, Overline, Row, Sheet } from '@/components/ui';
import { sortDecks } from '@/domain/fieldText';
import type { Deck, Id } from '@/domain/model';
import { plural } from '@/domain/text';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface DeckPickerSheetProps {
  open: boolean;
  onClose: () => void;
  decks: readonly Deck[];
  /** The deck shown with a check mark. */
  selectedId?: Id | null;
  /** Called with the chosen deck; the sheet then closes itself. */
  onPick: (deckId: Id) => void;
  /** Default "Choose a deck". */
  title?: string;
  /** deckId → number of cards, shown under each name. */
  cardCounts?: ReadonlyMap<Id, number>;
}

export function DeckPickerSheet({
  open,
  onClose,
  decks,
  selectedId,
  onPick,
  title = 'Choose a deck',
  cardCounts,
}: DeckPickerSheetProps) {
  const c = useColors();
  const sorted = useMemo(() => sortDecks(decks), [decks]);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {sorted.length === 0 ? (
        <Text style={[font('sans', 400), { fontSize: 14, color: c.ink3, paddingVertical: 12 }]}>
          No decks yet.
        </Text>
      ) : (
        sorted.map((deck, i) => {
          const on = deck.id === selectedId;
          const count = cardCounts?.get(deck.id);
          const sub = [count !== undefined ? plural(count, 'card') : null, deck.active ? null : 'Paused']
            .filter(Boolean)
            .join(' · ');
          return (
            <Row
              key={deck.id}
              last={i === sorted.length - 1}
              padV={12}
              onPress={() => {
                onPick(deck.id);
                onClose();
              }}
            >
              <Text style={{ fontSize: 22, width: 30, textAlign: 'center' }}>{deck.icon}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>
                  {deck.name}
                </Text>
                {sub ? (
                  <Text numberOfLines={1} style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>
                    {sub}
                  </Text>
                ) : null}
              </View>
              {on ? <Ion name="checkmark" size={19} color={c.pine} /> : null}
            </Row>
          );
        })
      )}
    </Sheet>
  );
}

/**
 * The editor row that opens the sheet: "DECK  [ 🇪🇸 Spanish verbs ▾ ]".
 * `deck` null → "Choose a deck".
 */
export function DeckField({
  label = 'Deck',
  deck,
  onPress,
}: {
  label?: string;
  deck: Pick<Deck, 'icon' | 'name' | 'active'> | null;
  onPress: () => void;
}) {
  const c = useColors();
  const name = deck ? deck.name : 'Choose a deck';
  return (
    <View style={{ marginBottom: 16 }}>
      <Overline style={{ marginBottom: 7 }}>{label}</Overline>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${name}. Change`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.hairlineStrong,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 11,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        })}
      >
        {deck ? <Text style={{ fontSize: 18 }}>{deck.icon}</Text> : null}
        <Text numberOfLines={1} style={[font('sans', 700), { flex: 1, fontSize: 15, color: deck ? c.ink : c.ink3 }]}>
          {name}
        </Text>
        {deck && !deck.active ? (
          <Text style={[font('sans', 600), { fontSize: 12, color: c.ink3 }]}>Paused</Text>
        ) : null}
        <Ion name="chevron-down" size={16} color={c.ink3} />
      </Pressable>
    </View>
  );
}
