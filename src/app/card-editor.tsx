/**
 * Card editor (B9) — unsaved-changes guard on back, Save disabled until valid,
 * and a guarded delete. Saves write the store for real.
 */
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import {
  Btn,
  Chip,
  Field,
  Ion,
  ListRow,
  Overline,
  Sheet,
  SnackbarHost,
  StackBar,
} from '@/components/ui';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export default function CardEditorScreen() {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const params = useLocalSearchParams<{ cardId?: string; deckId?: string }>();

  const card = useMemo(
    () => state.cards.find((x) => x.id === params.cardId) ?? null,
    [state.cards, params.cardId],
  );
  const editing = !!card;
  const activeDecks = state.decks.filter((d) => d.active);

  const [front, setFront] = useState(card?.front ?? '');
  const [back, setBack] = useState(card?.back ?? '');
  const [example, setExample] = useState(card?.example ?? '');
  const [notes, setNotes] = useState(card?.notes ?? '');
  const [tags, setTags] = useState(card?.tags?.join(', ') ?? '');
  const [deck, setDeck] = useState(card?.deckId ?? params.deckId ?? activeDecks[0]?.id ?? '');
  const [guard, setGuard] = useState(false);
  const [delConfirm, setDelConfirm] = useState(false);

  const dirty = editing
    ? front !== card.front ||
      back !== card.back ||
      example !== (card.example ?? '') ||
      notes !== (card.notes ?? '') ||
      tags !== (card.tags?.join(', ') ?? '') ||
      deck !== card.deckId
    : !!(front || back || example || notes || tags);
  const valid = front.trim().length > 0 && back.trim().length > 0 && deck.length > 0;

  // The header back button is guarded below, but Android hardware-back and the
  // iOS edge-swipe slip past it and silently discard edits. `beforeRemove`
  // intercepts EVERY exit cause; `leaving` lets the intentional exits (save,
  // delete, confirmed discard) through so the guard never blocks its own
  // navigation and traps the user (M9).
  const navigation = useNavigation();
  const leaving = useRef(false);
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!dirty || leaving.current) return;
      e.preventDefault();
      setGuard(true);
    });
    return unsub;
  }, [navigation, dirty]);

  const save = () => {
    const parsedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const fields = {
      front: front.trim(),
      back: back.trim(),
      example: example.trim() || undefined,
      notes: notes.trim() || undefined,
      tags: parsedTags.length ? parsedTags : undefined,
      deckId: deck,
    };
    if (editing) {
      actions.updateCard(card.id, fields);
      show('Card saved');
    } else {
      actions.addCard(deck, fields);
      show(`“${front.trim()}” added`);
    }
    leaving.current = true; // intentional exit — don't let the guard intercept
    router.back();
  };

  // A card needs an active deck to live in. On a blank slate there are none yet, so the
  // form would strand the user with a permanently-disabled Save — show a way
  // forward instead.
  if (!editing && activeDecks.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: c.paper }}>
        <StackBar title="New card" backIcon="close" onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Ion name="albums-outline" size={40} color={c.ink3} />
          <Text
            style={[
              font('serif', 600),
              { fontSize: 20, color: c.ink, marginTop: 14, textAlign: 'center' },
            ]}
          >
            No active deck yet
          </Text>
          <Text
            style={[
              font('sans', 400),
              {
                fontSize: 13.5,
                color: c.ink3,
                marginTop: 6,
                marginBottom: 18,
                textAlign: 'center',
                lineHeight: 20,
              },
            ]}
          >
            A card needs an active deck. Create one, or resume a paused deck under Study.
          </Text>
          <Btn icon="add" onPress={() => router.replace('/deck-editor')}>
            New deck
          </Btn>
        </View>
        <SnackbarHost />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar
        title={editing ? 'Edit card' : 'New card'}
        backIcon="close"
        onBack={() => (dirty ? setGuard(true) : router.back())}
        right={
          <Btn size="sm" disabled={!valid} onPress={save}>
            Save
          </Btn>
        }
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="Front *" value={front} onChange={setFront} placeholder="Capital of France" autoFocus={!editing} />
        <Field label="Back *" value={back} onChange={setBack} placeholder="Paris" />
        <Field
          label="Example"
          value={example}
          onChange={setExample}
          placeholder="Paris is the capital and largest city of France."
          multiline
          hint="Shown in italic on the card back."
        />
        <Field
          label="Notes"
          value={notes}
          onChange={setNotes}
          placeholder="Any extra context or a mnemonic"
          multiline
          hint="Small muted print beneath the answer."
        />
        <Field
          label="Tags"
          value={tags}
          onChange={setTags}
          placeholder="geography, europe"
          hint="Separate tags with commas — used for filtering."
        />

        <Overline style={{ marginTop: 4, marginBottom: 7 }}>Deck</Overline>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', gap: 7 }}>
            {activeDecks.map((d) => (
              <Chip key={d.id} active={deck === d.id} onPress={() => setDeck(d.id)}>
                {`${d.icon} ${d.name}`}
              </Chip>
            ))}
          </View>
        </ScrollView>

        {editing && (
          <View
            style={{
              borderWidth: 1,
              borderColor: c.danger + '4D',
              borderRadius: 14,
              paddingVertical: 2,
              paddingHorizontal: 14,
              backgroundColor: c.danger + '0A',
              marginTop: 8,
            }}
          >
            <ListRow
              icon="trash-outline"
              danger
              title="Delete this card"
              sub="Its scheduling history goes with it"
              last
              onPress={() => setDelConfirm(true)}
            />
          </View>
        )}
      </ScrollView>

      {/* unsaved-changes guard (B9) */}
      <Sheet open={guard} onClose={() => setGuard(false)} title="Discard changes?">
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
          Your edits to this card haven’t been saved.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setGuard(false)}>
            Keep editing
          </Btn>
          <Btn
            kind="danger"
            full
            style={{ flex: 1 }}
            onPress={() => {
              leaving.current = true; // confirmed discard — let this exit through
              setGuard(false);
              router.back();
            }}
          >
            Discard
          </Btn>
        </View>
      </Sheet>

      {/* guarded delete (L6) — destructive, so it confirms before removing */}
      <Sheet open={delConfirm} onClose={() => setDelConfirm(false)} title="Delete this card?">
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
          “{card?.front}” and its scheduling history will be permanently removed.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setDelConfirm(false)}>
            Cancel
          </Btn>
          <Btn
            kind="dangerSolid"
            full
            style={{ flex: 1 }}
            onPress={() => {
              if (!card) return;
              setDelConfirm(false);
              leaving.current = true; // the card is gone — don't re-prompt on the way out
              actions.deleteCard(card.id);
              show(`“${card.front}” deleted`);
              router.back();
            }}
          >
            Delete card
          </Btn>
        </View>
      </Sheet>

      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
