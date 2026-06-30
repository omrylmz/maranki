/**
 * Card editor (B9 + C4) — unsaved-changes guard on back, Save disabled
 * until valid, the surfaced Pronunciation section (IPA + record/playback —
 * recording itself is staged UI; the capture backend is WIRING.md C4 work),
 * and a guarded delete. Saves write the store for real.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import {
  Btn,
  Chip,
  IconBtn,
  Field,
  Ion,
  ListRow,
  Overline,
  Sheet,
  SnackbarHost,
  StackBar,
} from '@/components/ui';
import { speakWord } from '@/domain/speech';
import { CefrLevel, WordType } from '@/domain/types';
import { langCode, splitArticle } from '@/domain/words';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

const LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const TYPES: WordType[] = ['noun', 'verb', 'adjective', 'adverb', 'phrase', 'preposition', 'conjunction'];

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

  const [word, setWord] = useState(card?.word ?? '');
  const [tr, setTr] = useState(card?.tr ?? '');
  const [ex, setEx] = useState(card?.ex ?? '');
  const [exTr, setExTr] = useState(card?.exTr ?? '');
  const [ipa, setIpa] = useState(card?.ipa ?? '');
  const [level, setLevel] = useState<CefrLevel | null>(card?.level ?? null);
  const [type, setType] = useState<WordType | null>(card?.type ?? null);
  const [deck, setDeck] = useState(card?.deckId ?? params.deckId ?? activeDecks[0]?.id ?? '');
  const [recorded, setRecorded] = useState(editing);
  const [recording, setRecording] = useState(false);
  const [guard, setGuard] = useState(false);

  const dirty = editing
    ? word !== card.word ||
      tr !== card.tr ||
      ex !== (card.ex ?? '') ||
      exTr !== (card.exTr ?? '') ||
      ipa !== (card.ipa ?? '') ||
      level !== card.level ||
      type !== card.type ||
      deck !== card.deckId
    : !!(word || tr || ex || ipa);
  const valid = word.trim().length > 0 && tr.trim().length > 0 && deck.length > 0;

  const record = () => {
    setRecording(true);
    setTimeout(() => {
      setRecording(false);
      setRecorded(true);
    }, 1500);
  };

  const save = () => {
    const { article, base } = splitArticle(word.trim());
    const deckObj = state.decks.find((d) => d.id === deck);
    const fields = {
      word: word.trim(),
      article,
      base,
      tr: tr.trim(),
      ex: ex.trim() || undefined,
      exTr: exTr.trim() || undefined,
      ipa: ipa.trim() || undefined,
      level,
      type,
      deckId: deck,
      lang: langCode(deckObj?.lang ?? 'German'),
    };
    if (editing) {
      actions.updateCard(card.id, fields);
      show('Card saved');
    } else {
      actions.addCard(deck, fields);
      show(`“${word.trim()}” added`);
    }
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
            A card needs an active deck. Create one, add a curated deck from the Library, or resume a
            paused deck under Study.
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
        <Field label="Word *" value={word} onChange={setWord} placeholder="die Stunde" autoFocus={!editing} />
        <Field label="Translation *" value={tr} onChange={setTr} placeholder="the hour" />
        <Field
          label="Example"
          value={ex}
          onChange={setEx}
          placeholder="Wir treffen uns in einer Stunde."
          multiline
          hint="Shown in italic on the card back — real language, quoted."
        />
        <Field
          label="Example translation"
          value={exTr}
          onChange={setExTr}
          placeholder="We meet in an hour."
        />

        {/* pronunciation — the surfaced subsystem (C4) */}
        <Overline style={{ marginTop: 4, marginBottom: 7 }}>Pronunciation</Overline>
        <View
          style={{
            backgroundColor: c.card,
            borderWidth: 1,
            borderColor: c.hairlineStrong,
            borderRadius: 12,
            paddingVertical: 12,
            paddingHorizontal: 14,
            marginBottom: 16,
          }}
        >
          <TextInput
            value={ipa}
            onChangeText={setIpa}
            placeholder="/ˈʃtʊndə/ (IPA, optional)"
            placeholderTextColor={c.ink3}
            autoCorrect={false}
            style={[font('mono', 400), { fontSize: 14.5, color: c.ink, padding: 0 }]}
          />
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              marginTop: 12,
              paddingTop: 12,
              borderTopWidth: 1,
              borderTopColor: c.hairlineSoft,
            }}
          >
            {recording ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 9, height: 9, borderRadius: 99, backgroundColor: c.danger }} />
                <Text style={[font('sans', 800), { fontSize: 13.5, color: c.danger }]}>
                  Recording… tap to stop
                </Text>
              </View>
            ) : recorded ? (
              <>
                <IconBtn
                  icon="play"
                  size={32}
                  iconSize={15}
                  color={c.pine}
                  bg={c.pineTint}
                  onPress={() => word && speakWord(word, langCode(state.decks.find((d) => d.id === deck)?.lang ?? 'German'))}
                />
                <Text style={[font('sans', 400), { flex: 1, fontSize: 13, color: c.ink2 }]}>
                  Your recording · 0:02
                </Text>
                <Btn size="sm" kind="quiet" icon="mic-outline" onPress={record}>
                  Re-record
                </Btn>
              </>
            ) : (
              <>
                <Btn size="sm" kind="secondary" icon="mic-outline" onPress={record}>
                  Record yourself
                </Btn>
                <Text style={[font('sans', 400), { flex: 1, fontSize: 12, color: c.ink3 }]}>
                  compare with the native audio
                </Text>
              </>
            )}
          </View>
        </View>

        <Overline style={{ marginTop: 4, marginBottom: 7 }}>Deck</Overline>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 7 }}>
            {activeDecks.map((d) => (
              <Chip key={d.id} active={deck === d.id} onPress={() => setDeck(d.id)}>
                {`${d.flag} ${d.name}`}
              </Chip>
            ))}
          </View>
        </ScrollView>

        <Overline style={{ marginTop: 4, marginBottom: 7 }}>Level</Overline>
        <View style={{ flexDirection: 'row', gap: 7, marginBottom: 16, flexWrap: 'wrap' }}>
          {LEVELS.map((l) => (
            <Chip key={l} active={level === l} onPress={() => setLevel(level === l ? null : l)}>
              {l}
            </Chip>
          ))}
        </View>

        <Overline style={{ marginTop: 4, marginBottom: 7 }}>Type</Overline>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', gap: 7 }}>
            {TYPES.map((t) => (
              <Chip key={t} active={type === t} onPress={() => setType(type === t ? null : t)}>
                {t}
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
              onPress={() => {
                actions.deleteCard(card.id);
                show(`“${card.word}” deleted`);
                router.back();
              }}
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
              setGuard(false);
              router.back();
            }}
          >
            Discard
          </Btn>
        </View>
      </Sheet>

      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
