/**
 * Deck editor (B9) — name/language/description, duplicate (real copy with
 * fresh progress), and the safe delete: keep / move (with a target picker) /
 * delete-all, each consequence spelled out. All writes are real.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import {
  Btn,
  Chip,
  Field,
  ListRow,
  Overline,
  Row,
  Sheet,
  SnackbarHost,
  StackBar,
} from '@/components/ui';
import { LANG_FLAGS } from '@/domain/words';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

const LANGS = ['German', 'Spanish', 'French', 'Italian', 'Other'];
type DelMode = 'move' | 'keep' | 'all';

export default function DeckEditorScreen() {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const params = useLocalSearchParams<{ deckId?: string }>();

  const deck = useMemo(
    () => state.decks.find((d) => d.id === params.deckId) ?? null,
    [state.decks, params.deckId],
  );
  const editing = !!deck;
  const cardCount = useMemo(
    () => (deck ? state.cards.filter((x) => x.deckId === deck.id).length : 0),
    [state.cards, deck],
  );
  const otherDecks = state.decks.filter((d) => d.id !== deck?.id);
  // With no other deck to move into, "move" is impossible — hide it and default
  // to "keep" so the dialog can't sit on an unsatisfiable strategy (H2).
  const canMove = otherDecks.length > 0;

  const [name, setName] = useState(deck?.name ?? '');
  const [lang, setLang] = useState<string | null>(deck?.lang ?? null);
  const [desc, setDesc] = useState(deck?.desc ?? '');
  const [delOpen, setDelOpen] = useState(false);
  const [delMode, setDelMode] = useState<DelMode>(canMove ? 'move' : 'keep');
  const [moveTarget, setMoveTarget] = useState(otherDecks[0]?.id ?? '');

  const save = () => {
    const fields = {
      name: name.trim(),
      lang: lang ?? 'Other',
      flag: LANG_FLAGS[lang ?? 'Other'] ?? '📚',
      desc: desc.trim() || undefined,
    };
    if (editing) {
      actions.updateDeck(deck.id, fields);
      show('Deck saved');
    } else {
      actions.addDeck(fields);
      show(`Deck “${name.trim()}” created`);
    }
    router.back();
  };

  const duplicate = () => {
    if (!deck) return;
    const cards = state.cards
      .filter((x) => x.deckId === deck.id)
      .map((x) => ({
        word: x.word,
        article: x.article,
        base: x.base,
        tr: x.tr,
        ipa: x.ipa,
        ex: x.ex,
        exTr: x.exTr,
        level: x.level,
        type: x.type,
        lang: x.lang,
        // fresh cards, no progress
      }));
    actions.importDeck(
      { name: `${deck.name} (copy)`, flag: deck.flag, lang: deck.lang, level: deck.level },
      cards,
    );
    show(`Copied as “${deck.name} (copy)” — fresh cards, no progress`);
  };

  const confirmDelete = () => {
    if (!deck) return;
    setDelOpen(false);
    if (delMode === 'all') {
      actions.deleteDeck(deck.id, { kind: 'delete' });
      show('Deck and cards deleted');
    } else if (delMode === 'move') {
      const target = state.decks.find((d) => d.id === moveTarget);
      actions.deleteDeck(deck.id, { kind: 'move', targetDeckId: moveTarget });
      // The reducer keeps cards in the library if the target turned out invalid;
      // the message must match what actually happened, not what was requested.
      show(
        target
          ? `Deck deleted — cards moved to ${target.name}`
          : 'Deck deleted — cards kept in your library',
      );
    } else {
      actions.deleteDeck(deck.id, { kind: 'keep' });
      show('Deck deleted — cards kept in your library');
    }
    router.back();
  };

  const allDelOptions: { id: DelMode; icon: string; t: string; s: string }[] = [
    {
      id: 'move',
      icon: 'arrow-redo-outline',
      t: 'Move cards to another deck',
      s: 'Keeps every card and its progress',
    },
    {
      id: 'keep',
      icon: 'archive-outline',
      t: 'Keep cards, remove the deck',
      s: 'Cards stay in your library, unassigned',
    },
    {
      id: 'all',
      icon: 'trash-outline',
      t: 'Delete deck and all its cards',
      s: 'Permanent — scheduling history is lost',
    },
  ];
  // hide "move" entirely when there's no other deck to move into (H2)
  const delOptions = allDelOptions.filter((o) => canMove || o.id !== 'move');

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar
        title={editing ? 'Edit deck' : 'New deck'}
        backIcon="close"
        onBack={() => router.back()}
        right={
          <Btn size="sm" disabled={!name.trim()} onPress={save}>
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
        <Field
          label="Deck name *"
          value={name}
          onChange={setName}
          placeholder="Spanish — Kitchen verbs"
          autoFocus={!editing}
        />
        <Overline style={{ marginTop: 4, marginBottom: 7 }}>Language</Overline>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 7 }}>
            {LANGS.map((l) => (
              <Chip key={l} active={lang === l} onPress={() => setLang(l)}>
                {`${LANG_FLAGS[l]} ${l}`}
              </Chip>
            ))}
          </View>
        </ScrollView>
        <Field
          label="Description"
          value={desc}
          onChange={setDesc}
          placeholder="What lives in this deck?"
          multiline
        />

        {editing && (
          <>
            <Btn kind="secondary" full icon="copy-outline" style={{ marginTop: 4 }} onPress={duplicate}>
              Duplicate deck
            </Btn>
            <View
              style={{
                borderWidth: 1,
                borderColor: c.danger + '4D',
                borderRadius: 14,
                paddingVertical: 2,
                paddingHorizontal: 14,
                backgroundColor: c.danger + '0A',
                marginTop: 18,
              }}
            >
              <ListRow
                icon="trash-outline"
                danger
                title="Delete this deck"
                sub={`${cardCount.toLocaleString('en-US')} cards — choose what happens to them`}
                last
                onPress={() => setDelOpen(true)}
              />
            </View>
          </>
        )}
      </ScrollView>

      {/* safe delete: keep / move / delete-all (B9) */}
      <Sheet open={delOpen} onClose={() => setDelOpen(false)} title={`Delete “${deck?.name}”?`}>
        <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2, marginBottom: 14 }]}>
          What should happen to its {cardCount.toLocaleString('en-US')} cards?
        </Text>
        {delOptions.map((o) => (
          <View key={o.id}>
            <Row onPress={() => setDelMode(o.id)} padV={11}>
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 99,
                  borderWidth: delMode === o.id ? 6 : 1.5,
                  borderColor:
                    delMode === o.id ? (o.id === 'all' ? c.danger : c.pine) : c.hairlineStrong,
                }}
              />
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    font('sans', 700),
                    { fontSize: 14, color: o.id === 'all' ? c.danger : c.ink },
                  ]}
                >
                  {o.t}
                </Text>
                <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>{o.s}</Text>
              </View>
            </Row>
            {o.id === 'move' && delMode === 'move' && otherDecks.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', gap: 7, paddingLeft: 32 }}>
                  {otherDecks.map((d) => (
                    <Chip key={d.id} active={moveTarget === d.id} onPress={() => setMoveTarget(d.id)}>
                      {`${d.flag} ${d.name}`}
                    </Chip>
                  ))}
                </View>
              </ScrollView>
            )}
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setDelOpen(false)}>
            Cancel
          </Btn>
          <Btn
            kind={delMode === 'all' ? 'dangerSolid' : 'primary'}
            full
            style={{ flex: 1 }}
            onPress={confirmDelete}
          >
            {delMode === 'all' ? 'Delete everything' : 'Delete deck'}
          </Btn>
        </View>
      </Sheet>

      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
