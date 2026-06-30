/**
 * Progress (Stats) — progression that drives action (C1 + C5).
 * Level + XP ribbon, streak & mastery heroes, actionable launchers
 * (due → study, weak cards → a real "hardest" session), an honest activity
 * heatmap from session history, mastery by CEFR level, the achievements
 * wall, and the quiet all-time ledger. Every number derives from the store.
 */
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import {
  Bar,
  Btn,
  CardBox,
  IconBtn,
  Ion,
  LevelBadge,
  Overline,
  Page,
  Ring,
  Row,
  ScreenHead,
  SectionHead,
  SegCtrl,
  Pill,
} from '@/components/ui';
import { levelInfo } from '@/domain/gamification';
import { activeCardPool, buildQueue, computeReady } from '@/domain/queue';
import { addDays, CefrLevel, dayKeyOf, isDue } from '@/domain/types';
import { normalizedDayDone, useAchievements, useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

const LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function HeatCell({ v }: { v: number }) {
  const c = useColors();
  // softTint steps from the mock: 18% / 38% / 65% / solid
  const fills = ['transparent', c.pine + '2E', c.pine + '61', c.pine + 'A6', c.pine];
  return (
    <View
      style={{
        flex: 1,
        aspectRatio: 1,
        borderRadius: 5,
        backgroundColor: fills[Math.min(4, v)],
        borderWidth: v === 0 ? 1 : 0,
        borderColor: c.hairlineSoft,
      }}
    />
  );
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "YYYY-MM-DD" → "Mar 5", parsed in LOCAL time so DST can't shift the day (L4). */
function fmtDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function StatsScreen() {
  const c = useColors();
  const router = useRouter();
  const { state } = useData();
  const { show } = useSnackbar();
  const achievements = useAchievements();
  const [range, setRange] = useState('5w');

  const now = useNow();
  const today = dayKeyOf(now);
  const dayDone = normalizedDayDone(state.person, now);
  const level = levelInfo(state.person.xp);
  const noCards = state.cards.length === 0;

  const derived = useMemo(() => {
    const graduated = state.cards.filter((x) => x.reps > 0 && x.stepIndex === null);
    const mastered = graduated.filter((x) => x.intervalDays >= 21).length;
    const totalCards = state.cards.length;
    const masteryPct = totalCards ? Math.round((mastered / totalCards) * 100) : 0;

    const pool = activeCardPool(state.cards, state.decks);
    const ready = computeReady(pool, state.settings.srs, dayDone, now);
    // True overdue urgency (uncapped, review + learning), matching the deck rows'
    // "N due"; the Start button stays limit-aware via ready.total (M4 consistency).
    const dueNow = pool.filter((x) => isDue(x, now)).length;
    // The "weak cards" number must equal the Review session it launches: the
    // same active pool and the same buildQueue('hardest') (cap 20) reviewWeak
    // opens. Counting all cards by a hand-rolled ease threshold over-reported a
    // backlog the 20-card session never showed (L3).
    const weak = buildQueue(pool, {
      kind: 'hardest',
      now,
      settings: state.settings.srs,
      done: dayDone,
    }).length;

    // retention over the last 10 sessions
    const recent = state.sessions.slice(-10);
    const rTotal = recent.reduce((s, x) => s + x.total, 0);
    const rCorrect = recent.reduce((s, x) => s + (x.total - x.counts.again), 0);
    // null = no reviews yet, so the UI can say so instead of a misleading 100%
    const retention = rTotal ? Math.round((rCorrect / rTotal) * 100) : null;

    // reviews per day for the heatmap
    const perDay = new Map<string, number>();
    state.sessions.forEach((s) => perDay.set(s.dayKey, (perDay.get(s.dayKey) ?? 0) + s.total));
    const bucket = (n: number) => (n === 0 ? 0 : n < 10 ? 1 : n < 20 ? 2 : n < 30 ? 3 : 4);

    const heat5w: number[] = [];
    for (let back = 34; back >= 0; back--) {
      heat5w.push(bucket(perDay.get(addDays(today, -back)) ?? 0));
    }
    const heatYear: number[] = [];
    for (let week = 34; week >= 0; week--) {
      let sum = 0;
      for (let d = 0; d < 7; d++) sum += perDay.get(addDays(today, -(week * 7 + d))) ?? 0;
      heatYear.push(bucket(Math.round(sum / 7)));
    }

    // last-7-day strip
    const strip: ('s' | 'f' | 'm' | 't')[] = [];
    const frozen = new Set(state.person.freezeUsedDays);
    for (let back = 6; back >= 0; back--) {
      const key = addDays(today, -back);
      if (back === 0) strip.push('t');
      else if (frozen.has(key)) strip.push('f');
      else if (perDay.has(key)) strip.push('s');
      else strip.push('m');
    }

    // mastery by CEFR level (only levels present)
    const byLevel = LEVELS.map((l) => {
      // null-level (imported) cards never equal a CEFR level, so they're intentionally excluded
      const pool = state.cards.filter((x) => x.level === l);
      const m = pool.filter((x) => x.reps > 0 && x.stepIndex === null && x.intervalDays >= 21).length;
      return { level: l, count: pool.length, pct: pool.length ? Math.round((m / pool.length) * 100) : 0 };
    }).filter((x) => x.count > 0);

    const totalReviews = state.sessions.reduce((s, x) => s + x.total, 0);
    const daysActive = new Set(state.sessions.map((x) => x.dayKey)).size;

    return {
      mastered,
      totalCards,
      masteryPct,
      ready,
      dueNow,
      weak,
      retention,
      heat5w,
      heatYear,
      strip,
      byLevel,
      totalReviews,
      daysActive,
    };
  }, [state, dayDone, now, today]);

  const startSession = () =>
    router.push({ pathname: '/session', params: { kind: 'scheduled', label: 'All decks' } });
  const reviewWeak = () =>
    router.push({ pathname: '/session', params: { kind: 'hardest', label: 'Hardest cards' } });

  const heat = range === 'y' ? derived.heatYear : derived.heat5w;
  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  return (
    <Page>
      <ScreenHead
        title="Progress"
        sub="Level, habit, and mastery — all in one place."
        right={
          <IconBtn
            icon="download-outline"
            size={36}
            iconSize={17}
            border
            onPress={() => show('Exported study history (CSV)')}
          />
        }
      />

      {/* level ribbon */}
      <CardBox
        style={{
          marginTop: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          paddingVertical: 14,
          paddingHorizontal: 16,
        }}
      >
        <Ring value={level.pct} size={52} stroke={4.5} color={c.amber}>
          <Text style={[font('sans', 800), tnum, { fontSize: 17, color: c.ink }]}>
            {level.level}
          </Text>
        </Ring>
        <View style={{ flex: 1 }}>
          <Text style={[font('sans', 800), { fontSize: 15.5, color: c.ink }]}>
            Level {level.level} · {level.name}
          </Text>
          <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
            {level.toNext} XP to level {level.level + 1}
          </Text>
        </View>
        <Pill mono fg={c.amberDeep} bg={c.amberTint}>
          {state.person.xp.toLocaleString('en-US')} XP
        </Pill>
      </CardBox>

      {/* heroes: streak + mastery */}
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
        <CardBox style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ion name="flame" size={16} color={c.amber} />
            <Overline>Streak</Overline>
          </View>
          <View
            style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 8, marginBottom: 2 }}
          >
            <Text style={[font('sans', 800), tnum, { fontSize: 34, letterSpacing: -1, color: c.ink }]}>
              {state.person.streak}
            </Text>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>days</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Text style={[font('sans', 400), tnum, { fontSize: 12, color: c.ink3 }]}>
              best {state.person.bestStreak} ·{' '}
            </Text>
            <Ion name="snow" size={10} color={c.info} />
            <Text style={[font('sans', 400), tnum, { fontSize: 12, color: c.ink3 }]}>
              {state.person.freezes} freezes
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 3, marginTop: 11 }}>
            {derived.strip.map((d, i) => (
              <View
                key={i}
                style={{
                  flex: 1,
                  height: 5,
                  borderRadius: 99,
                  backgroundColor:
                    d === 's' || d === 't' ? c.amber : d === 'f' ? c.info : c.paperSunk,
                }}
              />
            ))}
          </View>
        </CardBox>
        <CardBox style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ion name="checkmark-circle" size={16} color={c.pine} />
            <Overline>Mastered</Overline>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <Ring value={derived.masteryPct} size={56} stroke={5}>
              <Text style={[font('sans', 800), tnum, { fontSize: 14.5, color: c.ink }]}>
                {derived.masteryPct}%
              </Text>
            </Ring>
            <Text style={[font('sans', 400), tnum, { fontSize: 12, lineHeight: 18, color: c.ink3 }]}>
              {derived.mastered}
              {'\n'}of {derived.totalCards.toLocaleString('en-US')}
            </Text>
          </View>
        </CardBox>
      </View>

      {/* actionable metrics (C5) — only meaningful once there are cards */}
      {!noCards && (
        <>
          <SectionHead>Today</SectionHead>
          <Row onPress={startSession} padV={13}>
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
              <Ion name="time-outline" size={17} color={c.pine} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[font('sans', 700), tnum, { fontSize: 14.5, color: c.ink }]}>
                {derived.dueNow} cards due
              </Text>
              <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                {dayDone.reviews + dayDone.neww} studied so far today
              </Text>
            </View>
            <Btn size="sm" onPress={startSession}>
              Start
            </Btn>
          </Row>
          <Row onPress={reviewWeak} padV={13} last>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                backgroundColor: c.warningTint,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ion name="trending-down" size={17} color={c.warning} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[font('sans', 700), tnum, { fontSize: 14.5, color: c.ink }]}>
                {derived.retention == null ? 'No reviews yet' : `Retention at ${derived.retention}%`}
              </Text>
              <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                {derived.weak} weak cards could use a review
              </Text>
            </View>
            <Btn size="sm" kind="secondary" onPress={reviewWeak}>
              Review
            </Btn>
          </Row>
        </>
      )}

      {/* activity */}
      <SectionHead
        action={
          <SegCtrl
            size="sm"
            options={[
              { id: '5w', label: '5 weeks' },
              { id: 'y', label: '35 weeks' },
            ]}
            value={range}
            onChange={setRange}
          />
        }
      >
        Activity
      </SectionHead>
      <View style={{ paddingTop: 10, paddingBottom: 6, gap: 5 }}>
        {Array.from({ length: 5 }, (_, row) => (
          <View key={row} style={{ flexDirection: 'row', gap: 5 }}>
            {heat.slice(row * 7, row * 7 + 7).map((v, i) => (
              <HeatCell key={i} v={v} />
            ))}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>
          {fmtDayKey(addDays(today, -(range === 'y' ? 34 * 7 : 34)))}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>less</Text>
          {[0, 1, 2, 3, 4].map((v) => (
            <View
              key={v}
              style={{
                width: 9,
                height: 9,
                borderRadius: 3,
                backgroundColor:
                  v === 0 ? c.paperSunk : [c.paperSunk, c.pine + '2E', c.pine + '61', c.pine + 'A6', c.pine][v],
              }}
            />
          ))}
          <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>more</Text>
        </View>
        <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>today</Text>
      </View>

      {/* by level */}
      {derived.byLevel.length > 0 && (
        <>
          <SectionHead>By level</SectionHead>
          <View style={{ gap: 11, paddingTop: 8, paddingBottom: 2 }}>
            {derived.byLevel.map(({ level: l, pct }) => (
              <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <LevelBadge level={l} />
                <View style={{ flex: 1 }}>
                  <Bar value={pct} color={c.cefr[l].fg} />
                </View>
                <Text
                  style={[
                    font('mono', 400),
                    tnum,
                    { fontSize: 12, color: c.ink3, width: 34, textAlign: 'right' },
                  ]}
                >
                  {pct}%
                </Text>
              </View>
            ))}
          </View>
        </>
      )}

      {/* achievements wall */}
      <SectionHead
        action={
          <Text style={[font('mono', 400), tnum, { fontSize: 12, color: c.ink3 }]}>
            {unlockedCount}/{achievements.length}
          </Text>
        }
      >
        Achievements
      </SectionHead>
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', paddingTop: 10, paddingBottom: 4, rowGap: 14 }}
      >
        {achievements.map((a) => (
          <View key={a.def.id} style={{ width: '25%', alignItems: 'center', paddingHorizontal: 4 }}>
            <View
              style={[
                {
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  marginBottom: 7,
                  backgroundColor: a.unlocked ? c.amber : c.paperSunk,
                  borderWidth: a.unlocked ? 0 : 1,
                  borderColor: c.hairlineStrong,
                  borderStyle: a.unlocked ? 'solid' : 'dashed',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                a.unlocked ? c.shadow.sm : null,
              ]}
            >
              <Ion
                name={a.unlocked ? a.def.icon : 'lock-closed'}
                size={21}
                color={a.unlocked ? '#fff' : c.ink3}
              />
            </View>
            <Text
              numberOfLines={2}
              style={[
                font('sans', 700),
                {
                  fontSize: 11,
                  lineHeight: 14,
                  color: a.unlocked ? c.ink : c.ink3,
                  textAlign: 'center',
                  minHeight: 28,
                },
              ]}
            >
              {a.def.name}
            </Text>
            <Text style={[font('mono', 400), tnum, { fontSize: 10, color: c.ink3, marginTop: 1 }]}>
              {a.unlocked && a.unlockedAt ? fmtDate(a.unlockedAt) : `${a.prog}/${a.def.goal}`}
            </Text>
          </View>
        ))}
      </View>

      {/* all-time ledger */}
      <SectionHead>All time</SectionHead>
      <View>
        {(
          [
            ['Total reviews', derived.totalReviews.toLocaleString('en-US')],
            ['Sessions', `${state.sessions.length}`],
            [
              'Average per session',
              state.sessions.length
                ? `${Math.round(derived.totalReviews / state.sessions.length)} cards`
                : '—',
            ],
            ['Days active', `${derived.daysActive}`],
          ] as [string, string][]
        ).map(([label, n], i, arr) => (
          <Row key={label} padV={11} last={i === arr.length - 1}>
            <Text style={[font('sans', 400), { flex: 1, fontSize: 14, color: c.ink2 }]}>
              {label}
            </Text>
            <Text style={[font('mono', 400), tnum, { fontSize: 13.5, color: c.ink }]}>{n}</Text>
          </Row>
        ))}
      </View>
    </Page>
  );
}
