/**
 * Home — the daily ritual page (D1/D3/D4).
 * One stateful "Today" command: the actual first card of today's queue sits
 * on the page as a card-stack invitation; tapping it (or Start review) goes
 * straight into the session. Honest breakdown, daily-goal ledger, streak
 * chip with visible freezes, launchable deck rows, time-aware greeting.
 */
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PeekSheet, PeekTarget } from '@/components/sheets/PeekSheet';
import { StreakSheet } from '@/components/sheets/StreakSheet';
import {
  Bar,
  Btn,
  FlagSq,
  IconBtn,
  Ion,
  LevelBadge,
  Overline,
  Page,
  Row,
  SectionHead,
  SegBar,
  StreakChip,
} from '@/components/ui';
import { buildQueue, computeReady, deckStats } from '@/domain/queue';
import { dayKeyOf } from '@/domain/types';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors, useTheme } from '@/theme/ThemeContext';

function greeting(now: Date, isNew: boolean): string {
  if (isNew) return 'Welcome to Maranki!';
  const h = now.getHours();
  if (h < 12) return 'Good morning.';
  if (h < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function dateOverline(now: Date): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const month = now.toLocaleDateString('en-US', { month: 'long' });
  return `${weekday} · ${month} ${now.getDate()}`;
}

export default function HomeScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { resolved, setOverride } = useTheme();
  const { state } = useData();

  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const [streakOpen, setStreakOpen] = useState(false);

  const now = useNow();
  const dayDone = normalizedDayDone(state.person, now);

  const activeDecks = useMemo(() => state.decks.filter((d) => d.active), [state.decks]);
  const pausedCount = state.decks.length - activeDecks.length;
  const activeCards = useMemo(() => {
    const activeIds = new Set(activeDecks.map((d) => d.id));
    return state.cards.filter((card) => activeIds.has(card.deckId));
  }, [state.cards, activeDecks]);

  const ready = useMemo(
    () => computeReady(activeCards, state.settings.srs, dayDone, now),
    [activeCards, state.settings.srs, dayDone, now],
  );
  const first = useMemo(
    () =>
      buildQueue(activeCards, {
        kind: 'scheduled',
        now,
        settings: state.settings.srs,
        done: dayDone,
      })[0],
    [activeCards, state.settings.srs, dayDone, now],
  );

  const startSession = () =>
    router.push({ pathname: '/session', params: { kind: 'scheduled', label: 'All decks' } });
  const startDeck = (deckId: string, label: string) =>
    router.push({ pathname: '/session', params: { kind: 'deck', deckId, label } });

  // soft breathing pulse on the primary command (design: pulseSoft 3.2s)
  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const dateNow = new Date(now);
  const isBrandNew = state.sessions.length === 0;
  const goalMet = dayDone.reviews >= state.person.goalReviews;
  const studiedToday = state.person.lastStudyDay === dayKeyOf(now) && dayDone.reviews > 0;

  return (
    <>
      <Page>
        {/* ——— header ——— */}
        <View style={{ paddingTop: insets.top + 16 }}>
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Overline>{dateOverline(dateNow)}</Overline>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <IconBtn
                icon={resolved === 'dark' ? 'sunny-outline' : 'moon-outline'}
                onPress={() => setOverride(resolved === 'dark' ? 'light' : 'dark')}
                size={34}
                iconSize={17}
                border
              />
              <StreakChip
                days={state.person.streak}
                freezes={state.person.freezes}
                onPress={() => setStreakOpen(true)}
              />
            </View>
          </View>
          <Text
            style={[
              font('serif', 600),
              { fontSize: 34, lineHeight: 36, letterSpacing: -0.68, color: c.ink, marginTop: 10 },
            ]}
          >
            {greeting(dateNow, isBrandNew)}
          </Text>
          <Text style={[font('sans', 400), tnum, { fontSize: 15, color: c.ink2, marginTop: 7 }]}>
            {ready.total > 0
              ? `${ready.total} cards ready · about ${ready.mins} min`
              : 'You’re all caught up. Come back tomorrow — or study ahead.'}
          </Text>
        </View>

        {/* ——— the invitation: card stack with today's first word ——— */}
        {first ? (
          <View style={{ marginTop: 24 }}>
            <Pressable onPress={startSession} style={{ paddingTop: 10 }}>
              {/* stack edges */}
              <View
                style={{
                  position: 'absolute',
                  left: 18,
                  right: 18,
                  top: 0,
                  height: 40,
                  backgroundColor: c.card,
                  borderWidth: 1,
                  borderColor: c.hairline,
                  borderRadius: 16,
                  transform: [{ rotate: '-1.2deg' }],
                  opacity: 0.6,
                }}
              />
              <View
                style={{
                  position: 'absolute',
                  left: 9,
                  right: 9,
                  top: 5,
                  height: 40,
                  backgroundColor: c.card,
                  borderWidth: 1,
                  borderColor: c.hairline,
                  borderRadius: 16,
                  transform: [{ rotate: '0.7deg' }],
                  opacity: 0.85,
                }}
              />
              {/* top card = first word of the queue */}
              <View
                style={[
                  {
                    backgroundColor: c.card,
                    borderWidth: 1,
                    borderColor: c.hairline,
                    borderRadius: 18,
                    paddingTop: 20,
                    paddingHorizontal: 22,
                    paddingBottom: 18,
                  },
                  c.shadow.card,
                ]}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <Overline style={{ letterSpacing: 11 * 0.11 }}>Up first</Overline>
                  <LevelBadge level={first.level} />
                </View>
                <Text
                  style={[
                    font('serif', 600),
                    {
                      fontSize: 36,
                      lineHeight: 38,
                      letterSpacing: -0.54,
                      color: c.ink,
                      textAlign: 'center',
                      marginTop: 18,
                      marginBottom: 4,
                    },
                  ]}
                >
                  {first.word}
                </Text>
                {first.ipa ? (
                  <Text
                    numberOfLines={1}
                    style={[
                      font('mono', 400),
                      { fontSize: 13, color: c.ink3, textAlign: 'center', marginBottom: 18 },
                    ]}
                  >
                    {first.ipa}
                  </Text>
                ) : (
                  <View style={{ marginBottom: 18 }} />
                )}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: 18,
                    paddingTop: 14,
                    borderTopWidth: 1,
                    borderTopColor: c.hairlineSoft,
                  }}
                >
                  {(
                    [
                      [ready.due, 'due'],
                      [ready.neww, 'new'],
                      [ready.learning, 'learning'],
                    ] as const
                  ).map(([n, label]) => (
                    <Text
                      key={label}
                      style={[font('sans', 400), { fontSize: 13, color: c.ink2 }]}
                    >
                      <Text style={[font('sans', 700), tnum, { color: c.ink }]}>{n}</Text> {label}
                    </Text>
                  ))}
                </View>
              </View>
            </Pressable>
            <Animated.View
              style={{
                marginTop: 14,
                transform: [
                  { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.015] }) },
                ],
              }}
            >
              <Btn full size="lg" icon="play" onPress={startSession}>
                Start review
              </Btn>
            </Animated.View>
          </View>
        ) : (
          /* caught-up state — always a way forward */
          <View
            style={[
              {
                marginTop: 24,
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.hairline,
                borderRadius: 18,
                padding: 22,
                alignItems: 'center',
              },
              c.shadow.sm,
            ]}
          >
            <Ion name="checkmark-circle" size={44} color={c.success} />
            <Text
              style={[
                font('serif', 600),
                { fontSize: 22, color: c.ink, marginTop: 12, textAlign: 'center' },
              ]}
            >
              All caught up.
            </Text>
            <Text
              style={[
                font('sans', 400),
                { fontSize: 13.5, color: c.ink2, marginTop: 4, marginBottom: 16, textAlign: 'center' },
              ]}
            >
              Nothing is due right now — study ahead if you’re keen.
            </Text>
            <Btn
              kind="secondary"
              icon="play-forward"
              onPress={() =>
                router.push({
                  pathname: '/session',
                  params: { kind: 'ahead', label: 'Study ahead' },
                })
              }
            >
              Study ahead
            </Btn>
          </View>
        )}

        {/* ——— today's ledger: goal + habit status ——— */}
        <SectionHead>Daily goal</SectionHead>
        <View style={{ flexDirection: 'row', gap: 18, paddingTop: 10, paddingBottom: 4 }}>
          <View style={{ flex: 1 }}>
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 }}
            >
              <Text style={[font('sans', 700), { fontSize: 13, color: c.ink2 }]}>Reviews</Text>
              <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                {dayDone.reviews}/{state.person.goalReviews}
              </Text>
            </View>
            <Bar value={(dayDone.reviews / state.person.goalReviews) * 100} color={c.pine} />
          </View>
          <View style={{ flex: 1 }}>
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 }}
            >
              <Text style={[font('sans', 700), { fontSize: 13, color: c.ink2 }]}>New cards</Text>
              <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                {dayDone.neww}/{state.person.goalNew}
              </Text>
            </View>
            <Bar value={(dayDone.neww / state.person.goalNew) * 100} color={c.amber} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10 }}>
          <Ion
            name={studiedToday ? 'shield-checkmark' : 'shield-outline'}
            size={15}
            color={studiedToday ? c.success : c.warning}
          />
          <Text style={[font('sans', 400), { fontSize: 13, color: c.ink2 }]}>
            {goalMet
              ? 'Daily goal complete! More tomorrow.'
              : studiedToday
                ? 'Streak safe today — keep going to hit your goal.'
                : 'Study today to keep your streak alive.'}
          </Text>
        </View>

        {/* ——— decks ledger ——— */}
        <SectionHead actionLabel="Manage" onAction={() => router.push('/(tabs)/study')}>
          Your decks
        </SectionHead>
        <View>
          {activeDecks.map((d, i) => {
            const s = deckStats(state.cards, d.id, state.settings.srs, dayDone, now);
            return (
              <Row
                key={d.id}
                onPress={() => setPeek({ kind: 'deck', deck: d })}
                last={i === activeDecks.length - 1}
                padV={15}
              >
                <FlagSq flag={d.flag} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    numberOfLines={1}
                    style={[font('sans', 700), { fontSize: 15.5, color: c.ink }]}
                  >
                    {d.name}
                  </Text>
                  <Text
                    style={[
                      font('sans', 400),
                      tnum,
                      { fontSize: 12.5, color: c.ink3, marginTop: 2, marginBottom: 8 },
                    ]}
                  >
                    {s.total.toLocaleString('en-US')} cards ·{' '}
                    {s.total ? Math.round((s.mastered / s.total) * 100) : 0}% mastered
                  </Text>
                  <SegBar
                    mastered={s.mastered}
                    learning={s.learning}
                    neww={s.neww}
                    total={s.total}
                  />
                </View>
                {s.due > 0 ? (
                  <Pressable
                    onPress={() => startDeck(d.id, d.name)}
                    style={({ pressed }) => ({
                      alignItems: 'center',
                      gap: 1,
                      backgroundColor: c.pineTint,
                      borderRadius: 12,
                      paddingVertical: 8,
                      paddingHorizontal: 13,
                      transform: [{ scale: pressed ? 0.95 : 1 }],
                    })}
                  >
                    <Text style={[font('sans', 800), tnum, { fontSize: 16, color: c.pine }]}>
                      {s.due}
                    </Text>
                    <Text
                      style={[
                        font('sans', 700),
                        {
                          fontSize: 10,
                          color: c.pine,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        },
                      ]}
                    >
                      due
                    </Text>
                  </Pressable>
                ) : (
                  <Ion name="checkmark-circle" size={20} color={c.success} style={{ opacity: 0.7 }} />
                )}
              </Row>
            );
          })}
        </View>
        {pausedCount > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 12 }}>
            <Ion name="information-circle-outline" size={14} color={c.ink3} />
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>
              {pausedCount} {pausedCount === 1 ? 'deck' : 'decks'} paused — find{' '}
              {pausedCount === 1 ? 'it' : 'them'} under Study.
            </Text>
          </View>
        )}
      </Page>

      <PeekSheet target={peek} onClose={() => setPeek(null)} />
      <StreakSheet open={streakOpen} onClose={() => setStreakOpen(false)} />
    </>
  );
}
