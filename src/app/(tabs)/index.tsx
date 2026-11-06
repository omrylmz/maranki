/**
 * Today — do today's studying (spec §2.1, §8.1, unit W4-1). One Study button,
 * your decks, your lists.
 *
 *   THURSDAY 23 OCTOBER                          (🔥 12)  (+)
 *   Good evening
 *   30 cards ready · about 12 min  (?)           ← "34 ready · Study 30" when the session size cuts it
 *   UP FIRST card + [ ▶ Study 30 ]                ← TodayHero (or the empty / caught-up state)
 *   Reviews ▓▓▓░ 12 / 30 goal   New ▓░ 4 / 10 goal
 *   (one-time card: "We fixed {n} items…" or "Want a daily reminder?")
 *   YOUR DECKS                                    ← DeckRows
 *   LISTS                                         ← ListRows
 *
 * - "Study {n}" is the ONLY "study everything" control (the Study tab is
 *   gone). Its number is readyFor({}).total — the same number as the tab
 *   badge — and the session it opens has exactly that many cards.
 * - Header "+" → AddSheet (new card, deck, import, list, starter decks).
 *   The streak chip → StreakSheet. (The theme toggle moved to Settings ›
 *   Appearance, spec §2.5.)
 * - Every rule (which state shows, labels, counts, routes) is a pure
 *   function in src/components/today/todayLogic.ts (tested); this file only
 *   puts the parts together.
 * - Largest font size (device pass 2026-11-02): the date may take two lines
 *   next to the streak chip; a solid strip under the status bar
 *   (StatusBarStrip) keeps the page from scrolling under the clock (F1-6).
 */
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InfoButton } from '@/components/sheets/InfoButton';
import { AddSheet } from '@/components/sheets/AddSheet';
import { StreakSheet } from '@/components/sheets/StreakSheet';
import { DeckRows } from '@/components/today/DeckRows';
import { ListRows } from '@/components/today/ListRows';
import { OneTimeCards } from '@/components/today/OneTimeCards';
import { GoalBars, TodayHero } from '@/components/today/TodayHero';
import {
  ALL_SCOPE,
  dateOverline,
  goalBars,
  greeting,
  heroLine,
  notStartedItemsReader,
  packChoiceFor,
  splitDecks,
  TODAY_COPY,
  todayMode,
} from '@/components/today/todayLogic';
import { IconBtn, Overline, Page, StreakChip } from '@/components/ui';
import { StatusBarStrip } from '@/components/ui/layout';
import type { DataStateV3 } from '@/domain/model';
import { normalizedDayDone } from '@/store/DataContext';
import { useDeckStatsMap, useReady, useStateV3 } from '@/store/selectors';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';
import { activePack } from '@/variants';

const decksOf = (s: DataStateV3) => s.decks;
const personOf = (s: DataStateV3) => s.person;

/**
 * The content pack's button on the no-decks card (spec §8.11), only when the
 * pack has starter decks: "Starter decks" (it opens the AddSheet's starter
 * decks — todayLogic.ts packChoiceFor says why it is not the tour's "Start
 * with German").
 */
const PACK_CHOICE = packChoiceFor(activePack);

export default function TodayScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const now = useNow();

  const ready = useReady(ALL_SCOPE);
  const stats = useDeckStatsMap();
  // The ITEMS "Choose what to learn" opens in triage (the same scope and items rule as
  // triage): one number for the state below AND the caught-up button.
  const notStartedSelector = useMemo(() => notStartedItemsReader(now), [now]);
  const notStarted = useStateV3(notStartedSelector);
  const decks = useStateV3(decksOf);
  const person = useStateV3(personOf);

  const [showPaused, setShowPaused] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [streakOpen, setStreakOpen] = useState(false);

  const { active, paused } = useMemo(() => splitDecks(decks), [decks]);
  const mode = todayMode({ decks, stats, readyTotal: ready.total, notStarted });
  const bars = goalBars(normalizedDayDone(person, now), person);

  return (
    <>
      <Page>
        {/* ——— header ——— */}
        <View style={{ paddingTop: insets.top + 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {/* Two lines at the largest font size: "SATURDAY 24 OCTOBER" next to the chips. */}
            <Overline lines={2} style={{ flexShrink: 1 }}>
              {dateOverline(now)}
            </Overline>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <StreakChip days={person.streak} freezes={person.freezes} onPress={() => setStreakOpen(true)} />
              <IconBtn
                icon="add"
                size={36}
                iconSize={20}
                border
                label={TODAY_COPY.addLabel}
                onPress={() => setAddOpen(true)}
              />
            </View>
          </View>
          <Text
            accessibilityRole="header"
            style={[
              font('serif', 600),
              { fontSize: 34, lineHeight: 38, letterSpacing: -0.68, color: c.ink, marginTop: 10 },
            ]}
          >
            {greeting(now)}
          </Text>
          {mode === 'study' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7 }}>
              <Text style={[font('sans', 400), tnum, { fontSize: 15, color: c.ink2, flexShrink: 1 }]}>
                {heroLine(ready)}
              </Text>
              <InfoButton term="Ready" />
            </View>
          )}
        </View>

        <TodayHero
          mode={mode}
          ready={ready}
          notStarted={notStarted}
          onShowPaused={() => setShowPaused(true)}
          firstDeckId={active[0]?.id ?? null}
          packChoice={PACK_CHOICE}
          onOpenAdd={() => setAddOpen(true)}
        />
        {mode !== 'noDecks' && <GoalBars bars={bars} />}

        <OneTimeCards />

        <DeckRows
          active={active}
          paused={paused}
          stats={stats}
          hero={ready}
          showPaused={showPaused}
          onTogglePaused={() => setShowPaused((v) => !v)}
        />
        {mode !== 'noDecks' && <ListRows />}
      </Page>
      {/* After the page, so it is drawn on top: the page scrolls under it, not under the clock. */}
      <StatusBarStrip />

      <StreakSheet open={streakOpen} onClose={() => setStreakOpen(false)} />
      <AddSheet open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
