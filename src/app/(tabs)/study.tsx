/**
 * Study — the launchpad (B1). One place to *do*: an aggregate "study now"
 * command, then every studiable object — decks and collections — as a row
 * with an honest due count and a one-tap study action. Paused decks sit in
 * a disclosure (Resume is real: updateDeck({active: true})). The universal
 * peek sheet replaces hidden long-presses; the FAB opens the create menu.
 */
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AddDeckSheet } from '@/components/sheets/AddDeckSheet';
import { PeekSheet, PeekTarget } from '@/components/sheets/PeekSheet';
import {
  Btn,
  CardBox,
  DeckTag,
  DeckTile,
  FAB,
  IconBtn,
  Ion,
  Page,
  Row,
  ScreenHead,
  SectionHead,
} from '@/components/ui';
import { collectionStats, computeReady, deckStats } from '@/domain/queue';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, TABBAR_HEIGHT, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export default function StudyScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, actions } = useData();
  const { show } = useSnackbar();

  const [showPaused, setShowPaused] = useState(false);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const now = useNow();
  const dayDone = normalizedDayDone(state.person, now);
  const active = state.decks.filter((d) => d.active);
  const paused = state.decks.filter((d) => !d.active);
  const noDecks = state.decks.length === 0;

  const ready = useMemo(() => {
    const activeIds = new Set(active.map((d) => d.id));
    return computeReady(
      state.cards.filter((card) => activeIds.has(card.deckId)),
      state.settings.srs,
      dayDone,
      now,
    );
  }, [state.cards, active, state.settings.srs, dayDone, now]);

  const startAll = () =>
    router.push({ pathname: '/session', params: { kind: 'scheduled', label: 'All decks' } });

  return (
    <>
      <Page>
        <ScreenHead
          title="Study"
          sub="Pick what to review — or just start."
          right={
            <IconBtn
              icon="cloud-download-outline"
              size={36}
              iconSize={18}
              border
              onPress={() => router.push('/import')}
            />
          }
        />

        {/* aggregate command */}
        {!noDecks && (
        <CardBox
          onPress={startAll}
          style={{
            marginTop: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            paddingVertical: 16,
            paddingHorizontal: 18,
          }}
        >
          <View
            style={[
              {
                width: 46,
                height: 46,
                borderRadius: 999,
                backgroundColor: c.pine,
                alignItems: 'center',
                justifyContent: 'center',
              },
              c.shadow.sm,
            ]}
          >
            <Ion name="play" size={20} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 800), { fontSize: 16, color: c.ink }]}>Study now</Text>
            <Text style={[font('sans', 400), tnum, { fontSize: 13, color: c.ink2 }]}>
              {ready.total} ready across {active.length} decks
              {ready.total > 0 ? ` · ~${ready.mins} min` : ''}
            </Text>
          </View>
          <Ion name="chevron-forward" size={17} color={c.ink3} />
        </CardBox>
        )}

        {/* decks */}
        <SectionHead>Decks</SectionHead>
        <View>
          {noDecks && (
            <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16 }}>
              <Ion name="albums-outline" size={34} color={c.ink3} />
              <Text
                style={[
                  font('serif', 600),
                  { fontSize: 18, color: c.ink, marginTop: 12, marginBottom: 4, textAlign: 'center' },
                ]}
              >
                No decks yet
              </Text>
              <Text
                style={[
                  font('sans', 400),
                  { fontSize: 13, color: c.ink3, marginBottom: 16, textAlign: 'center', lineHeight: 19 },
                ]}
              >
                Add a curated deck by language, create your own, or import from a file.
              </Text>
              <Btn icon="add" onPress={() => setCreateOpen(true)}>
                Add a deck
              </Btn>
            </View>
          )}
          {active.map((d, i) => {
            const s = deckStats(state.cards, d.id, state.settings.srs, dayDone, now);
            return (
              <Row
                key={d.id}
                onPress={() => setPeek({ kind: 'deck', deck: d })}
                padV={14}
                last={i === active.length - 1 && !paused.length}
              >
                <DeckTile flag={d.flag} size={36} builtin={d.builtin} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    <Text
                      numberOfLines={1}
                      style={[font('sans', 700), { fontSize: 15, color: c.ink, flexShrink: 1 }]}
                    >
                      {d.name}
                    </Text>
                    <DeckTag builtin={d.builtin} />
                  </View>
                  <Text
                    style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}
                  >
                    {s.total.toLocaleString('en-US')} cards
                    {s.due > 0 ? ` · ${s.due} due` : ' · caught up'}
                  </Text>
                </View>
                {s.due > 0 ? (
                  <Btn
                    size="sm"
                    onPress={() =>
                      router.push({
                        pathname: '/session',
                        params: { kind: 'deck', deckId: d.id, label: d.name },
                      })
                    }
                  >
                    Study {s.due}
                  </Btn>
                ) : (
                  <Ion name="checkmark-circle" size={19} color={c.success} style={{ opacity: 0.65 }} />
                )}
              </Row>
            );
          })}

          {paused.length > 0 && (
            <View>
              <Pressable
                onPress={() => setShowPaused(!showPaused)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingVertical: 13,
                }}
              >
                <Ion name={showPaused ? 'chevron-down' : 'chevron-forward'} size={14} color={c.ink3} />
                <Text style={[font('sans', 700), { fontSize: 13.5, color: c.ink3 }]}>
                  Paused ({paused.length})
                </Text>
              </Pressable>
              {showPaused &&
                paused.map((d, i) => {
                  const s = deckStats(state.cards, d.id, state.settings.srs, dayDone, now);
                  return (
                    <Row
                      key={d.id}
                      onPress={() => setPeek({ kind: 'deck', deck: d })}
                      padV={12}
                      last={i === paused.length - 1}
                      style={{ opacity: 0.75 }}
                    >
                      <DeckTile flag={d.flag} size={34} builtin={d.builtin} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                          <Text
                            numberOfLines={1}
                            style={[font('sans', 700), { fontSize: 14.5, color: c.ink2, flexShrink: 1 }]}
                          >
                            {d.name}
                          </Text>
                          <DeckTag builtin={d.builtin} />
                        </View>
                        <Text style={[font('sans', 400), tnum, { fontSize: 12, color: c.ink3 }]}>
                          {s.total.toLocaleString('en-US')} cards
                        </Text>
                      </View>
                      <Btn
                        size="sm"
                        kind="secondary"
                        onPress={() => {
                          actions.updateDeck(d.id, { active: true });
                          show(`${d.name} resumed — its cards rejoin your queue`);
                        }}
                      >
                        Resume
                      </Btn>
                    </Row>
                  );
                })}
            </View>
          )}
        </View>

        {/* collections */}
        <SectionHead actionLabel="+ New" onAction={() => setCreateOpen(true)}>
          Collections
        </SectionHead>
        <View>
          {state.collections.map((col, i) => {
            const s = collectionStats(state.cards, col, now);
            return (
              <Row
                key={col.id}
                onPress={() => setPeek({ kind: 'collection', collection: col })}
                padV={13}
                last={i === state.collections.length - 1}
              >
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
                  <Ion name={col.icon} size={17} color={c.pine} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>{col.name}</Text>
                  <Text
                    style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}
                  >
                    {s.count} cards · {s.due} due
                  </Text>
                </View>
                {s.due > 0 ? (
                  <Btn
                    size="sm"
                    kind="secondary"
                    onPress={() =>
                      router.push({
                        pathname: '/session',
                        params: { kind: 'collection', collectionId: col.id, label: col.name },
                      })
                    }
                  >
                    Study {s.due}
                  </Btn>
                ) : (
                  <Ion name="checkmark-circle" size={19} color={c.success} style={{ opacity: 0.65 }} />
                )}
              </Row>
            );
          })}
        </View>
      </Page>

      <FAB onPress={() => setCreateOpen(true)} bottom={TABBAR_HEIGHT + insets.bottom + 18} />
      <PeekSheet target={peek} onClose={() => setPeek(null)} />
      <AddDeckSheet open={createOpen} onClose={() => setCreateOpen(false)} scope="all" />
    </>
  );
}
