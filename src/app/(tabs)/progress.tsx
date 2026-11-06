/**
 * Progress — see how you are doing (spec §2.1, §8.8, unit W4-6). It
 * replaces the old Stats tab (`stats.tsx`).
 *
 *   Progress                                        ⤓  ("Export study history")
 *   Level 7 · Scholar  ·  12-day streak · best 30  ·  312 mastered · 1,530 known
 *   TODAY            Reviews 12 / 30 goal · New 4 / 10 goal · 9 min
 *   NEXT 7 DAYS      ▂ ▅ ▃ ▇ ▂ ▁ ▃
 *   ACTIVITY         (5 weeks | 35 weeks) + heatmap
 *   BY DECK          → deck page
 *   GERMAN · BY LEVEL → Library with Deck + Level chips
 *   ACHIEVEMENTS     12 / 24
 *   ALL TIME
 *
 * READ-ONLY: there is no Start or Review button here (spec §7 #26, #64).
 * Today has the one "Study {n}" button. A row here opens the deck page or
 * the Library, nothing else.
 *
 * Where the numbers come from (every one from the store, spec §4.6):
 *   - deck rows and the mastered / known totals: useDeckStatsMap() (ONE
 *     pass over the cards, scope.ts deckStatsMap);
 *   - BY {GROUP}: progressLogic.ts groupBlocks (one pass, memoized on the
 *     cards, notes, card types and decks);
 *   - NEXT 7 DAYS: src/domain/forecast.ts (memoized the same way);
 *   - TODAY, ACTIVITY, ALL TIME: the person's day tally and the sessions;
 *   - the level name: the generic names, or the content pack's
 *     `levelNames` (spec §9.4) through `levelNames(activePack.levelNames)`.
 * Known is never counted as mastered (life.ts isMastered).
 *
 * The ⤓ button is real: the sessions CSV + the review CSV, zipped into one
 * file, then the share sheet (progressLogic.ts exportStudyHistory).
 *
 * Device fixes (2026-10-24 emulator run): every count uses plural() ("1
 * card", never "1 cards"); the "5 weeks | 35 weeks" switch sits on its own
 * full-width line under the ACTIVITY heading, so it can never run past the
 * right edge of the screen. A solid strip under the status bar
 * (StatusBarStrip, device pass 2026-11-02 F1-6) keeps the page from
 * scrolling under the clock.
 */
import { type Href, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { DeckMastery } from '@/components/progress/DeckMastery';
import { FacetMastery } from '@/components/progress/FacetMastery';
import { ForecastBars } from '@/components/progress/ForecastBars';
import { InfoButton } from '@/components/sheets/InfoButton';
import {
  achievementsCount,
  allTimeRows,
  deckHref,
  deckMasteryRows,
  deviceHistoryIO,
  EXPORT_HISTORY_LABEL,
  exportStudyHistory,
  forecastReader,
  GOAL_BAR_TONE,
  goalBar,
  groupBlocksReader,
  type GroupRow,
  type HeatRange,
  HEAT_RANGES,
  heatmap,
  historyExportMessage,
  isHeatRange,
  levelText,
  libraryHref,
  libraryTotals,
  masteryText,
  PROGRESS_EMPTY,
  shortDate,
  streakText,
  todaySummary,
} from '@/components/progress/progressLogic';
import {
  A11Y_HIDDEN,
  Bar,
  Btn,
  CardBox,
  IconBtn,
  Ion,
  Page,
  Pill,
  Ring,
  Row,
  ScreenHead,
  SectionHead,
  SegCtrl,
} from '@/components/ui';
import { StatusBarStrip } from '@/components/ui/layout';
import { forecastTotal } from '@/domain/forecast';
import { levelInfo, levelNames } from '@/domain/gamification';
import { plural } from '@/domain/text';
import { dayKeyOf } from '@/domain/types';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { useAchievements, useDeckStatsMap, useStateV3 } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';
import { activePack } from '@/variants';

/** The level names of this build: the generic ones, or the content pack's (spec §9.4). */
const LEVEL_NAMES_OF_BUILD = levelNames(activePack.levelNames);

/** One heatmap cell (level 0–4). Decoration: the grid's label says the numbers. */
function HeatCell({ level }: { level: number }) {
  const c = useColors();
  // softTint steps from the mock: 18% / 38% / 65% / solid
  const fills = ['transparent', c.pine + '2E', c.pine + '61', c.pine + 'A6', c.pine];
  return (
    <View
      style={{
        flex: 1,
        aspectRatio: 1,
        borderRadius: 5,
        backgroundColor: fills[Math.min(4, Math.max(0, level))],
        borderWidth: level === 0 ? 1 : 0,
        borderColor: c.hairlineSoft,
      }}
    />
  );
}

/** "Mar 5" for an achievement's unlock time. */
function unlockDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ProgressScreen() {
  const c = useColors();
  const router = useRouter();
  const { state } = useData();
  const { show } = useSnackbar();
  const now = useNow();
  const today = dayKeyOf(now);

  const stats = useDeckStatsMap();
  const achievements = useAchievements();
  // Each screen keeps its own memoized readers (they remember their last result).
  const [blocksReader] = useState(groupBlocksReader);
  const blocks = useStateV3(blocksReader);
  const daysReader = useMemo(() => forecastReader(now), [now]);
  const forecast = useStateV3(daysReader);

  const [range, setRange] = useState<HeatRange>('5w');
  // True while the history files are written and shared (no double taps).
  const [exporting, setExporting] = useState(false);

  const person = state.person;
  const level = levelInfo(person.xp, LEVEL_NAMES_OF_BUILD);
  const totals = libraryTotals(stats);
  const todayInfo = todaySummary(normalizedDayDone(person, now), person, state.sessions, today);
  // React Compiler memoizes these two on their inputs.
  const heat = heatmap(state.sessions, today, range);
  const deckRows = deckMasteryRows(state.decks, stats);
  const noSessions = state.sessions.length === 0;
  const dueSoon = forecastTotal(forecast);

  // "Export study history": the share sheet is the answer; a message only when
  // there is no session yet, the history could not be read, or sharing failed.
  const exportHistory = async () => {
    if (exporting) return;
    setExporting(true);
    const outcome = await exportStudyHistory(state, Date.now(), deviceHistoryIO());
    setExporting(false);
    const message = historyExportMessage(outcome);
    if (message) show(message);
  };

  // The deck page is a route of another unit of this wave: a plain string, cast to Href.
  const openDeck = (deckId: string) => router.push(deckHref(deckId) as Href);
  // The Library tab with the row's chips and a fresh nonce (spec §4.6); the
  // nonce reads the clock, so it is made here, in the press handler.
  const openLibrary = (row: GroupRow) => router.navigate(libraryHref(row.query, String(Date.now())) as Href);

  return (
    <>
      <Page>
        <ScreenHead
          title="Progress"
          right={
            <IconBtn
              icon="download-outline"
              size={36}
              iconSize={17}
              border
              label={EXPORT_HISTORY_LABEL}
              disabled={exporting}
              onPress={() => void exportHistory()}
            />
          }
        />

        {noSessions ? (
          <CardBox style={{ marginTop: 14, gap: 14 }}>
            <Text style={[font('serif', 600), { fontSize: 19, lineHeight: 25, color: c.ink }]}>{PROGRESS_EMPTY.title}</Text>
            <Btn size="sm" onPress={() => router.navigate('/')}>
              {PROGRESS_EMPTY.action}
            </Btn>
          </CardBox>
        ) : (
          <>
            {/* hero: level, streak, mastered / known */}
            <CardBox style={{ marginTop: 14, paddingVertical: 14, gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <Ring value={level.pct} size={48} stroke={4.5} color={c.amber} label={`${level.pct} percent to level ${level.level + 1}`}>
                  <Text style={[font('sans', 800), tnum, { fontSize: 16, color: c.ink }]}>{level.level}</Text>
                </Ring>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={[font('sans', 800), { fontSize: 15.5, color: c.ink }]}>
                    {levelText(level)}
                  </Text>
                  <Text numberOfLines={1} style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                    {level.toNext.toLocaleString('en-US')} XP to level {level.level + 1}
                  </Text>
                </View>
                <Pill mono fg={c.amberDeep} bg={c.amberTint}>
                  {person.xp.toLocaleString('en-US')} XP
                </Pill>
              </View>
              <View style={{ height: 1, backgroundColor: c.hairlineSoft }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View {...A11Y_HIDDEN}>
                  <Ion name="flame" size={16} color={c.amber} />
                </View>
                <Text style={[font('sans', 700), tnum, { flexShrink: 1, fontSize: 14, color: c.ink }]}>
                  {streakText(person.streak, person.bestStreak)}
                </Text>
                <InfoButton term="Streak" />
                <View style={{ flex: 1 }} />
                <View {...A11Y_HIDDEN}>
                  <Ion name="snow" size={12} color={c.info} />
                </View>
                <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                  {plural(person.freezes, 'freeze')}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View {...A11Y_HIDDEN}>
                  <Ion name="checkmark-circle" size={16} color={c.pine} />
                </View>
                <Text style={[font('sans', 700), tnum, { flexShrink: 1, fontSize: 14, color: c.ink }]}>
                  {masteryText(totals.mastered, totals.known)}
                </Text>
                <InfoButton term="Mastered" />
                <View style={{ flex: 1 }} />
                <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                  of {plural(totals.cards, 'card')}
                </Text>
              </View>
            </CardBox>

            {/* today */}
            <SectionHead>Today</SectionHead>
            <Text style={[font('sans', 400), tnum, { fontSize: 14, lineHeight: 20, color: c.ink2 }]}>{todayInfo.line}</Text>
            {todayInfo.goals
              .filter((goal) => goal.goal > 0)
              .map((goal) => {
                const bar = goalBar(goal);
                return (
                  <View key={goal.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 9 }}>
                    <Text {...A11Y_HIDDEN} style={[font('sans', 600), { width: 58, fontSize: 12, color: c.ink3 }]}>
                      {goal.label}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Bar value={bar.pct} color={c[GOAL_BAR_TONE[goal.label]]} label={bar.label} />
                    </View>
                  </View>
                );
              })}
          </>
        )}

        {/* next 7 days: shown whenever cards come back (imported progress counts too) */}
        {dueSoon > 0 && (
          <>
            <SectionHead
              action={
                <Text style={[font('mono', 400), tnum, { fontSize: 12, color: c.ink3 }]}>{plural(dueSoon, 'card')}</Text>
              }
            >
              Next 7 days
            </SectionHead>
            <ForecastBars days={forecast} />
          </>
        )}

        {/* activity */}
        {!noSessions && (
          <>
            <SectionHead>Activity</SectionHead>
            {/* Its own full-width line: next to the heading the switch ran past the screen edge. */}
            <View style={{ alignSelf: 'stretch', marginBottom: 4 }}>
              <SegCtrl
                size="sm"
                label="Activity range"
                options={HEAT_RANGES}
                value={range}
                onChange={(id) => {
                  if (isHeatRange(id)) setRange(id);
                }}
              />
            </View>
            <View accessible accessibilityLabel={heat.label} style={{ paddingTop: 10, paddingBottom: 6, gap: 5 }}>
              {Array.from({ length: 5 }, (_, row) => (
                <View key={row} style={{ flexDirection: 'row', gap: 5 }}>
                  {heat.cells.slice(row * 7, row * 7 + 7).map((level, i) => (
                    <HeatCell key={i} level={level} />
                  ))}
                </View>
              ))}
            </View>
            <View {...A11Y_HIDDEN} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>{shortDate(heat.from)}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
                <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>less</Text>
                {[0, 1, 2, 3, 4].map((v) => (
                  <View
                    key={v}
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 3,
                      backgroundColor: [c.paperSunk, c.pine + '2E', c.pine + '61', c.pine + 'A6', c.pine][v],
                    }}
                  />
                ))}
                <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>more</Text>
              </View>
              <Text style={[font('sans', 400), { fontSize: 11.5, color: c.ink3 }]}>today</Text>
            </View>
          </>
        )}

        {/* by deck, then one "{deck} · by {group}" block per ordinal filter group */}
        <DeckMastery rows={deckRows} onOpenDeck={openDeck} />
        {blocks.map((block) => (
          <FacetMastery key={block.key} block={block} onOpenRow={openLibrary} />
        ))}

        {!noSessions && (
          <>
            {/* achievements wall */}
            <SectionHead
              action={
                <Text style={[font('mono', 400), tnum, { fontSize: 12, color: c.ink3 }]}>{achievementsCount(achievements)}</Text>
              }
            >
              Achievements
            </SectionHead>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingTop: 10, paddingBottom: 4, rowGap: 14 }}>
              {achievements.map((a) => (
                <View
                  key={a.def.id}
                  accessible
                  accessibilityLabel={`${a.def.name}: ${a.def.desc}. ${a.unlocked ? 'Unlocked' : `${a.prog} of ${a.def.goal}`}`}
                  style={{ width: '25%', alignItems: 'center', paddingHorizontal: 4 }}
                >
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
                    <Ion name={a.unlocked ? a.def.icon : 'lock-closed'} size={21} color={a.unlocked ? '#fff' : c.ink3} />
                  </View>
                  <Text
                    numberOfLines={2}
                    style={[
                      font('sans', 700),
                      { fontSize: 11, lineHeight: 14, color: a.unlocked ? c.ink : c.ink3, textAlign: 'center', minHeight: 28 },
                    ]}
                  >
                    {a.def.name}
                  </Text>
                  <Text style={[font('mono', 400), tnum, { fontSize: 10, color: c.ink3, marginTop: 1 }]}>
                    {a.unlocked && a.unlockedAt ? unlockDate(a.unlockedAt) : `${a.prog}/${a.def.goal}`}
                  </Text>
                </View>
              ))}
            </View>

            {/* all-time ledger */}
            <SectionHead>All time</SectionHead>
            <View>
              {allTimeRows(state.sessions).map(([label, value], i, rows) => (
                <Row key={label} padV={11} last={i === rows.length - 1}>
                  <Text style={[font('sans', 400), { flex: 1, fontSize: 14, color: c.ink2 }]}>{label}</Text>
                  <Text style={[font('mono', 400), tnum, { fontSize: 13.5, color: c.ink }]}>{value}</Text>
                </Row>
              ))}
            </View>
          </>
        )}
      </Page>
      {/* After the page, so it is drawn on top: the page scrolls under it, not under the clock. */}
      <StatusBarStrip />
    </>
  );
}
