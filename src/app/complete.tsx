/**
 * Session complete — the payout, then momentum (A2 + C1).
 * Everything renders at once with a staggered rise; "Done for today" is
 * always one tap away. XP itemizes and counts up, the level bar fills,
 * a real achievement pops when one unlocked — then the keep-going hub
 * (study ahead / hardest / cram) replaces the dead end.
 *
 * Mockup-ism deliberately NOT copied (WIRING.md §6): no demo-number
 * fallback — opening without a result redirects home.
 */
import { Redirect, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Bar,
  Btn,
  CardBox,
  Ion,
  Overline,
  RiseIn,
  Row,
  SectionHead,
} from '@/components/ui';
import { completionTier } from '@/domain/gamification';
import { activeCardPool, buildQueue } from '@/domain/queue';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

function StatTile({ value, label, accent }: { value: string; label: string; accent?: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 4 }}>
      <Text
        style={[
          font('sans', 800),
          tnum,
          { fontSize: 26, letterSpacing: -0.52, color: accent ?? c.ink },
        ]}
      >
        {value}
      </Text>
      <Text style={[font('sans', 700), { fontSize: 12, color: c.ink3, marginTop: 2 }]}>
        {label}
      </Text>
    </View>
  );
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${`${s}`.padStart(2, '0')}`;
}

export default function CompleteScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, actions, lastCompletion: payout } = useData();

  const [xpShown, setXpShown] = useState(0);
  const [barPct, setBarPct] = useState(payout?.levelBefore.pct ?? 0);

  useEffect(() => {
    if (!payout) return;
    let n = 0;
    const tick = Math.max(1, Math.ceil(payout.xpTotal / 24));
    const t = setInterval(() => {
      n += tick;
      if (n >= payout.xpTotal) {
        n = payout.xpTotal;
        clearInterval(t);
      }
      setXpShown(n);
    }, 40);
    const bar = setTimeout(() => setBarPct(payout.levelAfter.pct), 350);
    return () => {
      clearInterval(t);
      clearTimeout(bar);
    };
  }, [payout]);

  const nowTick = useNow();
  const hub = useMemo(() => {
    const now = nowTick;
    // Count what each "keep going" tap would ACTUALLY open: the same active pool
    // and the same buildQueue (cap 20) session.tsx runs for a deckId-less
    // ahead/hardest session. Re-deriving the filters by hand is how the numbers
    // drifted from the sessions they launch (M14).
    const pool = activeCardPool(state.cards, state.decks);
    const opts = { now, settings: state.settings.srs, done: normalizedDayDone(state.person, now) };
    return {
      aheadCount: buildQueue(pool, { kind: 'ahead', ...opts }).length,
      hardestCount: buildQueue(pool, { kind: 'hardest', ...opts }).length,
    };
  }, [state.cards, state.decks, state.settings.srs, state.person, nowTick]);

  if (!payout) return <Redirect href="/(tabs)" />;

  const [tierTitle, tierSub] = completionTier(payout.accuracy);
  const levelUp = payout.levelAfter.level > payout.levelBefore.level;

  const seg = (n: number, color: string) =>
    n > 0 ? <View style={{ flex: n / payout.total, backgroundColor: color }} /> : null;

  const again = (kind: string, label: string) => {
    actions.clearLastCompletion();
    router.replace({ pathname: '/session', params: { kind, label } });
  };
  const done = () => {
    actions.clearLastCompletion();
    router.replace('/(tabs)');
  };

  const breakdown: [string, number, string][] = [
    ['Again', payout.counts.again, c.rate.again.fg],
    ['Hard', payout.counts.hard, c.rate.hard.fg],
    ['Good', payout.counts.good, c.rate.good.fg],
    ['Easy', payout.counts.easy, c.rate.easy.fg],
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.paper }}
      contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: insets.bottom + 30 }}
      showsVerticalScrollIndicator={false}
    >
      <RiseIn duration={350}>
        <View style={{ paddingTop: insets.top + 18, alignItems: 'center' }}>
          <View
            style={{
              width: 54,
              height: 54,
              borderRadius: 999,
              backgroundColor: c.pineTint,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 14,
            }}
          >
            <Ion name="checkmark" size={28} color={c.pine} />
          </View>
          <Overline>Session complete · {payout.label}</Overline>
          <Text
            style={[
              font('serif', 600),
              {
                fontSize: 30,
                lineHeight: 33,
                letterSpacing: -0.6,
                color: c.ink,
                marginTop: 10,
                marginBottom: 6,
                textAlign: 'center',
              },
            ]}
          >
            {tierTitle}
          </Text>
          <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, textAlign: 'center' }]}>
            {tierSub}
          </Text>
        </View>
      </RiseIn>

      {/* headline tiles */}
      <RiseIn duration={400} delay={50}>
        <CardBox style={{ marginTop: 22, paddingVertical: 4, paddingHorizontal: 8, flexDirection: 'row' }} pad={0}>
          <StatTile value={`${payout.total}`} label="Cards" />
          <View style={{ width: 1, backgroundColor: c.hairlineSoft, marginVertical: 14 }} />
          <StatTile value={`${payout.accuracy}%`} label="Accuracy" accent={c.pine} />
          <View style={{ width: 1, backgroundColor: c.hairlineSoft, marginVertical: 14 }} />
          <StatTile value={fmtDuration(payout.durationSec)} label="Time" />
        </CardBox>
      </RiseIn>

      {/* rating breakdown (A3) */}
      <RiseIn duration={400} delay={100}>
        <View style={{ marginTop: 18 }}>
          <View
            style={{
              flexDirection: 'row',
              height: 6,
              borderRadius: 999,
              overflow: 'hidden',
              gap: 1,
              backgroundColor: c.paperSunk,
            }}
          >
            {seg(payout.counts.again, c.rate.again.fg)}
            {seg(payout.counts.hard, c.rate.hard.fg)}
            {seg(payout.counts.good, c.rate.good.fg)}
            {seg(payout.counts.easy, c.rate.easy.fg)}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
            {breakdown.map(([label, n, color]) => (
              <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: color }} />
                <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3 }]}>
                  {label}{' '}
                  <Text style={[font('sans', 700), tnum, { color: c.ink2 }]}>{n}</Text>
                </Text>
              </View>
            ))}
          </View>
          {payout.counts.again > 0 && (
            <Text
              style={[
                font('serif', 400, true),
                { fontSize: 14, color: c.ink2, marginTop: 10, textAlign: 'center' },
              ]}
            >
              {payout.counts.again} {payout.counts.again === 1 ? 'lapse' : 'lapses'} —{' '}
              {payout.counts.again === 1 ? 'it' : 'they'}’ll come back soon.
            </Text>
          )}
        </View>
      </RiseIn>

      {/* XP payout (C1) */}
      <RiseIn duration={400} delay={150}>
        <CardBox style={{ marginTop: 18 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}
          >
            <Overline>Experience</Overline>
            <Text style={[font('sans', 800), tnum, { fontSize: 20, color: c.amberDeep }]}>
              +{xpShown} XP
            </Text>
          </View>
          {payout.xpItems.map((it, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                paddingVertical: 7,
                borderBottomWidth: i < payout.xpItems.length - 1 ? 1 : 0,
                borderBottomColor: c.hairlineSoft,
              }}
            >
              <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2 }]}>{it.label}</Text>
              <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                +{it.xp}
              </Text>
            </View>
          ))}
          <View style={{ marginTop: 14 }}>
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 }}
            >
              <Text style={[font('sans', 700), { fontSize: 13, color: c.ink }]}>
                Level {payout.levelAfter.level} · {payout.levelAfter.name}
                {levelUp ? '  — level up!' : ''}
              </Text>
              <Text style={[font('mono', 400), tnum, { fontSize: 12, color: c.ink3 }]}>
                {payout.levelAfter.toNext} XP to level {payout.levelAfter.level + 1}
              </Text>
            </View>
            <Bar value={barPct} color={c.amber} h={6} />
          </View>
        </CardBox>
      </RiseIn>

      {/* achievement unlocks — every one earned this session, freeze credited
          to the achievement that actually granted it */}
      {payout.newAchievements.map((a, i) => (
        <RiseIn key={a.id} kind="pop" duration={400} delay={500 + i * 120}>
          <View
            style={{
              marginTop: i === 0 ? 14 : 10,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 13,
              backgroundColor: c.amberTint,
              borderRadius: 16,
              paddingVertical: 13,
              paddingHorizontal: 16,
            }}
          >
            <View
              style={{
                width: 42,
                height: 42,
                borderRadius: 12,
                backgroundColor: c.amber,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ion name={a.icon} size={21} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[font('sans', 800), { fontSize: 14.5, color: c.ink }]}>
                Achievement — {a.name}
              </Text>
              <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink2 }]}>
                {a.desc}
                {a.grantsFreeze && payout.freezeEarned ? ' · +1 streak freeze earned' : ''}
              </Text>
            </View>
          </View>
        </RiseIn>
      ))}

      {/* keep going hub (A2) */}
      <SectionHead>Keep going</SectionHead>
      <View>
        <Row onPress={() => again('ahead', 'Study ahead')} padV={13}>
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              backgroundColor: c.pineTint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ion name="play-forward" size={16} color={c.pine} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>Study ahead</Text>
            <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
              {hub.aheadCount} cards up next · an extra pass
            </Text>
          </View>
          <Ion name="chevron-forward" size={16} color={c.ink3} />
        </Row>
        <Row onPress={() => again('hardest', 'Hardest cards')} padV={13}>
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              backgroundColor: c.dangerTint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ion name="flame" size={16} color={c.danger} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>Review hardest</Text>
            <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
              {hub.hardestCount} lowest-ease cards across decks
            </Text>
          </View>
          <Ion name="chevron-forward" size={16} color={c.ink3} />
        </Row>
        <Row onPress={() => again('cram', 'Cram')} padV={13} last>
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              backgroundColor: c.infoTint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ion name="shuffle" size={16} color={c.info} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>Cram</Text>
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>
              Free practice — never changes your schedule
            </Text>
          </View>
          <Ion name="chevron-forward" size={16} color={c.ink3} />
        </Row>
      </View>

      <View style={{ marginTop: 20 }}>
        <Btn full size="lg" onPress={done}>
          Done for today
        </Btn>
      </View>
    </ScrollView>
  );
}
