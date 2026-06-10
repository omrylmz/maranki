/**
 * Import hub (B6) — one destination, three sources (AnkiWeb / file / backup),
 * a shared staged flow: source → honest preview ("nothing imported yet",
 * real duplicate count) → cancellable progress → done with a "Go study"
 * forward action. Pasting an AnkiWeb URL or deck ID surfaces a direct row
 * (B6b). The import genuinely writes a deck; preserved SRS fields come
 * along. Real .apkg/CSV parsing + error states remain WIRING.md §5 work.
 */
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import {
  Btn,
  CardBox,
  Ion,
  ListRow,
  Overline,
  RiseIn,
  Ring,
  Row,
  SegCtrl,
  SnackbarHost,
  StackBar,
} from '@/components/ui';
import { SHARED_DECKS, SharedDeck, sharedDeckFromLink } from '@/domain/importSamples';
import { Deck } from '@/domain/types';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

type Stage = 'idle' | 'preview' | 'importing' | 'done';

export default function ImportScreen() {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const { show } = useSnackbar();

  const [src, setSrc] = useState('anki');
  const [stage, setStage] = useState<Stage>('idle');
  const [prog, setProg] = useState(0);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<SharedDeck | null>(null);
  const [importedDeck, setImportedDeck] = useState<Deck | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);

  const results = useMemo(
    () => SHARED_DECKS.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase())),
    [q],
  );

  /* pasted AnkiWeb URL or numeric deck ID → straight to preview (B6b) */
  const pastedId = /^(https?:\/\/|ankiweb\.|\d{6,})/i.test(q.trim());

  /* honest duplicate count: words already in the library */
  const dupes = useMemo(() => {
    if (!chosen) return 0;
    const have = new Set(state.cards.map((x) => x.word.toLowerCase()));
    return chosen.payload.filter((p) => have.has(p.word.toLowerCase())).length;
  }, [chosen, state.cards]);
  const withProgress = useMemo(
    () => (chosen ? chosen.payload.filter((p) => (p.reps ?? 0) > 0).length : 0),
    [chosen],
  );

  useEffect(() => {
    if (stage !== 'importing' || !chosen) return;
    let p = 0;
    const cards = state.cards;
    const t = setInterval(() => {
      p += 4;
      if (p < 100) {
        setProg(p);
        return;
      }
      clearInterval(t);
      setProg(100);
      // the real write — dedupe against the library, keep SRS fields
      const have = new Set(cards.map((x) => x.word.toLowerCase()));
      const fresh = chosen.payload.filter((x) => !have.has(x.word.toLowerCase()));
      const deck = actions.importDeck(
        { name: chosen.name, flag: chosen.flag, lang: chosen.lang },
        fresh,
      );
      setImportedDeck(deck);
      setImportedCount(fresh.length);
      setSkippedCount(chosen.payload.length - fresh.length);
      setStage('done');
    }, 60);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const pick = (deck: SharedDeck) => {
    setChosen(deck);
    setProg(0);
    setStage('preview');
  };

  const studyNew = () => {
    if (!importedDeck) return;
    router.replace({
      pathname: '/session',
      params: { kind: 'deck', deckId: importedDeck.id, label: importedDeck.name },
    });
  };

  const previewRows: [string, string][] = chosen
    ? [
        ['Cards', chosen.payload.length.toLocaleString('en-US')],
        ['With study progress', withProgress.toLocaleString('en-US')],
        [
          'Already in your library',
          dupes > 0 ? `${dupes} duplicates — will be skipped` : 'no duplicates',
        ],
      ]
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar
        title="Import"
        sub="Bring your own vocabulary"
        backIcon="close"
        onBack={() => router.back()}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {stage === 'idle' && (
          <>
            <SegCtrl
              value={src}
              onChange={setSrc}
              options={[
                { id: 'anki', label: 'AnkiWeb' },
                { id: 'file', label: 'From a file' },
                { id: 'backup', label: 'Backup' },
              ]}
            />

            {src === 'anki' && (
              <View style={{ marginTop: 18 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 9,
                    backgroundColor: c.card,
                    borderWidth: 1,
                    borderColor: c.hairlineStrong,
                    borderRadius: 999,
                    paddingVertical: 11,
                    paddingHorizontal: 16,
                  }}
                >
                  <Ion name="search" size={16} color={c.ink3} />
                  <TextInput
                    value={q}
                    onChangeText={setQ}
                    placeholder="Search shared decks…"
                    placeholderTextColor={c.ink3}
                    autoCorrect={false}
                    autoCapitalize="none"
                    style={[font('sans', 400), { flex: 1, fontSize: 14.5, color: c.ink, padding: 0 }]}
                  />
                </View>
                <Text
                  style={[
                    font('sans', 400),
                    { fontSize: 12.5, color: c.ink3, marginTop: 10, marginBottom: 4, marginHorizontal: 2 },
                  ]}
                >
                  {pastedId ? 'From your link' : 'Popular for German learners'}
                </Text>

                {pastedId && (
                  <Row onPress={() => pick(sharedDeckFromLink(q.trim()))} padV={13} last={results.length === 0}>
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        backgroundColor: c.pineTint,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ion name="link-outline" size={17} color={c.pine} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>
                        Import from AnkiWeb
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={[font('mono', 400), { fontSize: 12, color: c.ink3 }]}
                      >
                        {q.trim()}
                      </Text>
                    </View>
                    <Ion name="chevron-forward" size={16} color={c.ink3} />
                  </Row>
                )}

                {results.map((r, i) => (
                  <Row key={r.id} onPress={() => pick(r)} padV={13} last={i === results.length - 1}>
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        backgroundColor: c.infoTint,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ion name="albums-outline" size={17} color={c.info} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>
                        {r.name}
                      </Text>
                      <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                        {r.cards.toLocaleString('en-US')} cards · {r.cat}
                      </Text>
                    </View>
                    <Ion name="chevron-forward" size={16} color={c.ink3} />
                  </Row>
                ))}

                {results.length === 0 && !pastedId && (
                  <View style={{ alignItems: 'center', paddingVertical: 26, paddingHorizontal: 16 }}>
                    <Text style={[font('serif', 600), { fontSize: 17, color: c.ink, marginBottom: 4 }]}>
                      No shared decks match
                    </Text>
                    <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, textAlign: 'center' }]}>
                      Try another search — or paste an AnkiWeb URL / deck ID.
                    </Text>
                  </View>
                )}
                <Text
                  style={[
                    font('sans', 400),
                    { fontSize: 12.5, color: c.ink3, marginTop: 14, textAlign: 'center' },
                  ]}
                >
                  or paste an AnkiWeb URL / deck ID above
                </Text>
              </View>
            )}

            {src === 'file' && (
              <View style={{ marginTop: 18 }}>
                <Pressable
                  onPress={() => pick(SHARED_DECKS[1])}
                  style={({ pressed }) => ({
                    borderWidth: 1.5,
                    borderStyle: 'dashed',
                    borderColor: c.hairlineStrong,
                    borderRadius: 16,
                    paddingVertical: 34,
                    paddingHorizontal: 20,
                    alignItems: 'center',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ion name="document-attach-outline" size={30} color={c.ink3} />
                  <Text
                    style={[font('sans', 700), { fontSize: 15, color: c.ink, marginTop: 10, marginBottom: 4 }]}
                  >
                    Choose a file
                  </Text>
                  <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>
                    .csv or .apkg — we’ll detect which
                  </Text>
                </Pressable>
                <Text
                  style={[
                    font('sans', 400),
                    { fontSize: 12.5, lineHeight: 19, color: c.ink3, marginTop: 12 },
                  ]}
                >
                  CSV columns map to Word, Translation, Example, Level, Type, Pronunciation and
                  Tags — you’ll confirm the mapping before anything is written.
                </Text>
              </View>
            )}

            {src === 'backup' && (
              <View style={{ marginTop: 18 }}>
                <ListRow
                  icon="refresh-circle-outline"
                  title="Restore a Maranki backup"
                  sub="A .json file from Settings → Export"
                  last
                  onPress={() => show('Choose a backup file')}
                />
              </View>
            )}
          </>
        )}

        {stage === 'preview' && chosen && (
          <RiseIn duration={250}>
            <Overline style={{ marginBottom: 10 }}>Preview — nothing imported yet</Overline>
            <CardBox>
              <Text style={[font('serif', 600), { fontSize: 20, color: c.ink, marginBottom: 12 }]}>
                {chosen.name}
              </Text>
              {previewRows.map(([l, n], i, arr) => (
                <View
                  key={l}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingVertical: 8,
                    borderBottomWidth: i < arr.length - 1 ? 1 : 0,
                    borderBottomColor: c.hairlineSoft,
                  }}
                >
                  <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2 }]}>{l}</Text>
                  <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink }]}>{n}</Text>
                </View>
              ))}
            </CardBox>
            <Text
              style={[
                font('sans', 400),
                { fontSize: 12.5, color: c.ink3, marginVertical: 12, marginHorizontal: 2 },
              ]}
            >
              Anki scheduling is preserved — ease, intervals and due dates come along.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setStage('idle')}>
                Cancel
              </Btn>
              <Btn
                full
                style={{ flex: 1 }}
                icon="cloud-download-outline"
                onPress={() => setStage('importing')}
              >
                Import deck
              </Btn>
            </View>
          </RiseIn>
        )}

        {stage === 'importing' && chosen && (
          <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 10 }}>
            <Ring value={prog} size={86} stroke={6}>
              <Text style={[font('sans', 800), tnum, { fontSize: 19, color: c.ink }]}>{prog}%</Text>
            </Ring>
            <Text
              style={[font('sans', 700), { fontSize: 15.5, color: c.ink, marginTop: 18, marginBottom: 4 }]}
            >
              Importing {chosen.payload.length.toLocaleString('en-US')} cards…
            </Text>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, marginBottom: 22 }]}>
              Keeping your Anki scheduling intact.
            </Text>
            <Btn
              kind="quiet"
              onPress={() => {
                setStage('idle');
                show('Import cancelled — nothing was written');
              }}
            >
              Cancel
            </Btn>
          </View>
        )}

        {stage === 'done' && (
          <RiseIn duration={300}>
            <View style={{ alignItems: 'center', paddingVertical: 36, paddingHorizontal: 10 }}>
              <View
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: 999,
                  backgroundColor: c.pineTint,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 16,
                }}
              >
                <Ion name="checkmark" size={30} color={c.pine} />
              </View>
              <Text style={[font('serif', 600), { fontSize: 23, color: c.ink, marginBottom: 6 }]}>
                {importedCount} cards imported
              </Text>
              <Text style={[font('sans', 400), tnum, { fontSize: 13.5, color: c.ink3, marginBottom: 24 }]}>
                {skippedCount > 0 ? `${skippedCount} duplicates skipped · ` : ''}
                ready to study now
              </Text>
              <Btn full size="lg" icon="play" onPress={studyNew}>
                Study the new deck
              </Btn>
              <Pressable onPress={() => router.back()} style={{ marginTop: 16 }} hitSlop={8}>
                <Text style={[font('sans', 700), { fontSize: 14, color: c.ink2 }]}>Done</Text>
              </Pressable>
            </View>
          </RiseIn>
        )}
      </ScrollView>
      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
