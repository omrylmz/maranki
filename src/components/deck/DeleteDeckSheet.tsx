/**
 * DeleteDeckSheet — "Delete deck…" from the deck page's ⋯ menu (spec §8.2,
 * §3.12 "No-orphan"). It says what happens to the cards, and offers the three
 * strategies of `deleteDeck`:
 *
 *   ( ) Move cards to another deck        Keeps every card and its progress   (Spanish) (Coding)
 *   ( ) Keep cards, remove the deck       Move cards to a new deck called 'Unfiled cards'
 *   ( ) Delete deck and all its cards     Permanent — their study progress is lost
 *   [ Cancel ]  [ Delete deck ]
 *
 * "Move" is offered only when another deck exists, "Keep" only when this is
 * not the Unfiled deck itself (H2: never a choice that cannot work). The
 * page calls the store (`onConfirm`) and leaves the page: the deck is gone.
 *
 * Each option is a radio button for a screen reader ("…, radio button,
 * checked"): the role and the state are on the row itself, so the learner
 * hears which strategy the confirm button runs.
 *
 * "Delete deck and all its cards" (with cards) cannot be undone — not even
 * by the snackbar — so its button is a 1-second HoldButton, "Hold to delete
 * everything", like every other delete that loses progress (the Library's
 * "Hold to delete", Settings' erase). Move and Keep lose nothing: one tap.
 */
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { A11Y_HIDDEN, Btn, Chip, HoldButton, Row, Sheet } from '@/components/ui';
import type { Deck, Id } from '@/domain/model';
import { plural } from '@/domain/text';
import { type DeleteStrategy, UNFILED_DECK_ID, UNFILED_DECK_NAME } from '@/store/deckOps';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { type DeleteMode, deleteOptions } from './deckPageLogic';

/** The hold button of "Delete deck and all its cards" (it says to hold, like "Hold to delete"). */
export const DELETE_EVERYTHING_HOLD = 'Hold to delete everything';

interface DeleteDeckSheetProps {
  open: boolean;
  onClose: () => void;
  deck: Pick<Deck, 'id' | 'name'>;
  cardCount: number;
  /** The other decks, in deck order (move targets). */
  otherDecks: readonly Pick<Deck, 'id' | 'name' | 'icon'>[];
  /** The existing "Unfiled cards" deck, or null (then 'keep' makes it). */
  unfiled: Pick<Deck, 'id' | 'name'> | null;
  /** Delete with this strategy. `where` = the name of the deck the cards go to ('' when they are deleted). */
  onConfirm: (strategy: DeleteStrategy, mode: DeleteMode, where: string) => void;
}

export function DeleteDeckSheet({ open, onClose, deck, cardCount, otherDecks, unfiled, onConfirm }: DeleteDeckSheetProps) {
  const c = useColors();
  const canMove = otherDecks.length > 0;
  const canKeep = deck.id !== UNFILED_DECK_ID;
  const unfiledName = unfiled?.name ?? UNFILED_DECK_NAME;
  const options = deleteOptions({ canMove, canKeep, unfiledExists: unfiled !== null, unfiledName });
  const firstMode: DeleteMode = canMove ? 'move' : canKeep ? 'keep' : 'all';
  const [mode, setMode] = useState<DeleteMode>(firstMode);
  const [target, setTarget] = useState<Id>(otherDecks[0]?.id ?? '');
  // A choice that is no longer possible (the other deck was deleted) falls back to the first one.
  const shownMode: DeleteMode = options.some((o) => o.id === mode) ? mode : firstMode;
  const shownTarget = otherDecks.some((d) => d.id === target) ? target : (otherDecks[0]?.id ?? '');
  const deletesCards = cardCount > 0 && shownMode === 'all';

  const confirm = () => {
    if (cardCount === 0 || shownMode === 'all') {
      onConfirm({ kind: 'delete' }, 'all', '');
    } else if (shownMode === 'move') {
      const name = otherDecks.find((d) => d.id === shownTarget)?.name ?? unfiledName;
      onConfirm({ kind: 'move', targetDeckId: shownTarget }, 'move', name);
    } else {
      onConfirm({ kind: 'keep' }, 'keep', unfiledName);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onClosed={() => {
        setMode(firstMode);
        setTarget(otherDecks[0]?.id ?? '');
      }}
      title={`Delete “${deck.name}”?`}
    >
      {cardCount === 0 ? (
        <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2, marginBottom: 14 }]}>This deck has no cards.</Text>
      ) : (
        <>
          <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2, marginBottom: 14 }]}>
            {`What should happen to its ${plural(cardCount, 'card')}?`}
          </Text>
          <View accessibilityRole="radiogroup">
            {options.map((o) => (
              <View key={o.id}>
                <Row
                  onPress={() => setMode(o.id)}
                  padV={11}
                  label={`${o.title}. ${o.sub}`}
                  role="radio"
                  checked={shownMode === o.id}
                >
                  {/* the drawn radio circle (the row says checked / not checked) */}
                  <View
                    {...A11Y_HIDDEN}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 99,
                      borderWidth: shownMode === o.id ? 6 : 1.5,
                      borderColor: shownMode === o.id ? (o.id === 'all' ? c.danger : c.pine) : c.hairlineStrong,
                    }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[font('sans', 700), { fontSize: 14, color: o.id === 'all' ? c.danger : c.ink }]}>{o.title}</Text>
                    <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>{o.sub}</Text>
                  </View>
                </Row>
                {o.id === 'move' && shownMode === 'move' && canMove ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', gap: 7, paddingLeft: 32 }}>
                      {otherDecks.map((d) => (
                        <Chip key={d.id} active={shownTarget === d.id} onPress={() => setTarget(d.id)}>
                          {`${d.icon} ${d.name}`}
                        </Chip>
                      ))}
                    </View>
                  </ScrollView>
                ) : null}
              </View>
            ))}
          </View>
        </>
      )}
      {deletesCards ? (
        // Nothing can bring these cards back: a hold, not a tap (the label says to hold).
        <View style={{ gap: 10, marginTop: 14 }}>
          <HoldButton kind="dangerSolid" onConfirm={confirm}>
            {DELETE_EVERYTHING_HOLD}
          </HoldButton>
          <Btn kind="secondary" full onPress={onClose}>
            Cancel
          </Btn>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={onClose}>
            Cancel
          </Btn>
          <Btn kind="primary" full style={{ flex: 1 }} onPress={confirm}>
            Delete deck
          </Btn>
        </View>
      )}
    </Sheet>
  );
}
