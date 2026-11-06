/**
 * Session complete — the payout, then momentum (spec §6.7, §6.10, unit W4-4).
 *
 *   /complete?q=&missed=
 *     q       the session's scope (a Query as JSON; {} = all decks), for "Keep going"
 *     missed  the selection token of the cards rated "Again" (card ids are never in a URL)
 *
 * Everything renders at once with a staggered rise. The summary: the accuracy
 * tier, the headline tiles (cards · accuracy · time), the rating bar, the
 * line about the missed cards ("2 cards missed — they'll come back soon.",
 * Study only; never "lapse", which is only a forgotten REVIEW card, wave 5g),
 * the streak, the XP lines counting up, the level bar, and every achievement
 * this session unlocked.
 *
 * "Keep going" — each row is hidden when its count is 0, and each count is
 * the length of the session it opens (sessionLogic keepGoingCounts, the same
 * scope.ts functions that build the queue):
 *   - missed cards: Settings › Retry missed ON → a highlighted box first:
 *     "You missed {n} cards. Practice them now?" · "Practice {n}" · "Not now";
 *     OFF → the row "Practice the {n} you missed". Practice writes nothing.
 *   - "Study ahead · {n}"             reviews not due yet (changes the schedule)
 *   - "Practice your hardest · {n}"   the practice cards of the scope, hardest first
 *                                     (ease ascending, then lapses; 'Doesn’t change your schedule.')
 *   - "Choose what to learn · {n} not started"   → triage over the same scope. {n}
 *                                     counts ITEMS, like triage's counter ("0 / 6
 *                                     items"): "· 6 not started" for 6 items of
 *                                     two directions (walkthrough M6: it counted
 *                                     cards, "· 12"). The copy is the spec's: no
 *                                     unit word.
 *     After a session over ALL decks (Today's hero, "Study ahead", "Practice"),
 *     these two rows use Today's own scopes (sessionLogic keepGoingScopes): a
 *     paused deck's cards (and a suspended Not started card) stay out, as on Today.
 *   - "Done"                          → back to the ONE tab navigator, on Today
 *                                     (backToToday: `router.dismissTo`, never a
 *                                     second `(tabs)` route on top of the first)
 * "Review hardest" and "Cram" are gone: they opened the same cards with
 * different side effects (spec §7 #25).
 *
 * "Study ahead" carries the session's label only when it names the scope
 * (after Study, Study ahead, or a Library or deck-page Practice); after
 * "Your hardest cards", "Missed cards" or Today's "Practice" the new session
 * names itself by its real scope (sessionLogic followUpLabel, sessionLabel):
 * the deck, the list or "All decks" — never "Filtered cards" for a scope
 * that only leaves out paused decks (wave-5b R8). The overline names what
 * was studied: a selection says its size ("Session complete · Practice · 1
 * card" after "Practice this card", never the card's text; L17). The level
 * line uses the level names of this build (a content pack may rename them),
 * like Progress.
 *
 * No demo-number fallback: opening without a result redirects to Today.
 */
import { type Href, Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  completeLevelLine,
  followUpLabel,
  HARDEST_LABEL,
  hardestParams,
  type KeepGoingCounts,
  keepGoingCounts,
  type KeepGoingRow,
  keepGoingRows,
  keepGoingScopes,
  MISSED_LABEL,
  missedLine,
  parseCompleteParams,
  type RouteParams,
  sessionHref,
} from '@/components/study/sessionLogic';
import { backToToday } from '@/components/today/backToToday';
import { A11Y_HIDDEN, Bar, Btn, CardBox, Ion, Overline, RiseIn, Row, SectionHead, SnackbarHost } from '@/components/ui';
import { completionTier, levelNames } from '@/domain/gamification';
import type { DataStateV3, Id } from '@/domain/model';
import { parseQueryParam, serializeQuery } from '@/domain/query';
import { matchCtxOf } from '@/domain/scope';
import { plural } from '@/domain/text';
import { useData } from '@/store/DataContext';
import { writesSchedule } from '@/store/reducer';
import { getSelection } from '@/store/selectionRegistry';
import { memoOnInputs, useStateV3 } from '@/store/selectors';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';
import { activePack } from '@/variants';

/**
 * The level names of this build: the generic ones, or the content pack's
 * (spec §9.4) — the same names as Progress shows. The payout's own
 * `levelAfter.name` is the generic name (the store never reads the pack).
 */
const LEVEL_NAMES_OF_BUILD = levelNames(activePack.levelNames);

function StatTile({ value, label, accent }: { value: string; label: string; accent?: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 4 }}>
      <Text style={[font('sans', 800), tnum, { fontSize: 26, letterSpacing: -0.52, color: accent ?? c.ink }]}>
        {value}
      </Text>
      <Text style={[font('sans', 700), { fontSize: 12, color: c.ink3, marginTop: 2 }]}>{label}</Text>
    </View>
  );
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${`${s}`.padStart(2, '0')}`;
}

/** The icon of each "Keep going" row. */
const ROW_ICONS: Record<KeepGoingRow['key'], { icon: string; tone: 'pine' | 'danger' | 'info' | 'amber' }> = {
  retry: { icon: 'refresh', tone: 'amber' },
  ahead: { icon: 'play-forward', tone: 'pine' },
  hardest: { icon: 'flame', tone: 'danger' },
  choose: { icon: 'albums-outline', tone: 'info' },
};

/** True when two count sets are equal (the selector then keeps the same object). */
function sameCounts(a: KeepGoingCounts, b: KeepGoingCounts): boolean {
  return a.retry === b.retry && a.ahead === b.ahead && a.hardest === b.hardest && a.notStarted === b.notStarted;
}

/**
 * The selector of the "Keep going" numbers for a scope and the missed cards:
 * computed again only when the cards, library, decks, lists, tallies or
 * settings change, and the SAME object while the numbers stay equal.
 */
function keepGoingReader(scopeKey: string, missedKey: string, now: number): (state: DataStateV3) => KeepGoingCounts {
  const scope = parseQueryParam(scopeKey);
  const missed = JSON.parse(missedKey) as Id[];
  let last: KeepGoingCounts | null = null;
  return memoOnInputs(
    // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes in screens.
    ({ cards, notes, noteTypes, decks, lists, person, settings }: DataStateV3) => [
      cards,
      notes,
      noteTypes,
      decks,
      lists,
      person?.dayDone,
      settings,
    ],
    (s) => {
      const next = keepGoingCounts(s, scope, missed, matchCtxOf(s, now));
      if (last !== null && sameCounts(last, next)) return last;
      last = next;
      return next;
    },
  );
}

const retryMissedOf = (s: DataStateV3) => s.settings.retryMissed === true;

export default function CompleteScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams() as RouteParams;
  const { actions, lastCompletion: payout } = useData();
  const retryMissed = useStateV3(retryMissedOf);
  const now = useNow();

  // The scope and the missed cards, read once (the selection lives in memory, not in the URL).
  const [ctx] = useState(() => {
    const { scope, missed } = parseCompleteParams(params);
    return { scope, missed, missedIds: missed ? (getSelection(missed) ?? []) : [] };
  });
  const [retryDismissed, setRetryDismissed] = useState(false);
  const scopeKey = serializeQuery(ctx.scope);
  const missedKey = JSON.stringify(ctx.missedIds);
  const selector = useMemo(() => keepGoingReader(scopeKey, missedKey, now), [scopeKey, missedKey, now]);
  const counts = useStateV3(selector);

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

  if (!payout) return <Redirect href="/(tabs)" />;

  const [tierTitle, tierSub] = completionTier(payout.accuracy);
  const levelUp = payout.levelAfter.level > payout.levelBefore.level;
  // "1 card missed — it'll come back soon." (Study only): the missed CARDS, each once (sessionLogic missedLine).
  const missedText = missedLine(payout.counts.again, ctx.missedIds.length, writesSchedule(payout.kind));
  const keepGoing = keepGoingRows(counts, {
    retryMissed,
    retryDismissed,
    missedCount: ctx.missedIds.length,
  });

  const seg = (n: number, color: string) =>
    n > 0 ? <View style={{ flex: n / payout.total, backgroundColor: color }} /> : null;

  /** Leave Complete for another screen; the payout is cleared after the navigation. */
  const go = (href: Href) => {
    router.replace(href);
    actions.clearLastCompletion();
  };

  /**
   * "Done": back to the ONE tab navigator under Complete, on Today
   * (backToToday). `go('/(tabs)')` put a SECOND tab navigator on the root
   * stack, and the old one stayed mounted under it after every session.
   */
  const done = () => {
    backToToday(router);
    actions.clearLastCompletion();
  };

  const open = (key: KeepGoingRow['key']) => {
    switch (key) {
      case 'retry':
        if (ctx.missed) go(sessionHref({ kind: 'practice', sel: ctx.missed, label: MISSED_LABEL }) as Href);
        return;
      case 'ahead': {
        // The old label only when it names the scope ("German", "German · Level: B1"). After
        // "Your hardest cards", a selection or over all decks, the new session names itself.
        const label = followUpLabel({ kind: payout.kind, label: payout.label, scope: ctx.scope });
        go(sessionHref({ kind: 'ahead', q: ctx.scope, label }) as Href);
        return;
      }
      case 'hardest': {
        // The same session as the row's count (keepGoingCounts uses hardestParams of the
        // same keepGoingScopes too: over all decks, without a paused deck, like Today).
        const { q, sort } = hardestParams(keepGoingScopes(ctx.scope).practice);
        go(sessionHref({ kind: 'practice', q, sort, label: HARDEST_LABEL }) as Href);
        return;
      }
      case 'choose':
        // The same scope as the row's count (keepGoingScopes): over all decks, Today's NOT_STARTED_SCOPE.
        go(`/triage?q=${encodeURIComponent(serializeQuery(keepGoingScopes(ctx.scope).choose))}`);
        return;
    }
  };

  const breakdown: [string, number, string][] = [
    ['Again', payout.counts.again, c.rate.again.fg],
    ['Hard', payout.counts.hard, c.rate.hard.fg],
    ['Good', payout.counts.good, c.rate.good.fg],
    ['Easy', payout.counts.easy, c.rate.easy.fg],
  ];

  const tones = {
    pine: { fg: c.pine, bg: c.pineTint },
    danger: { fg: c.danger, bg: c.dangerTint },
    info: { fg: c.info, bg: c.infoTint },
    amber: { fg: c.amberDeep, bg: c.amberTint },
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.paper }}
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        <RiseIn duration={350}>
          <View style={{ paddingTop: insets.top + 18, alignItems: 'center' }}>
            <View
              {...A11Y_HIDDEN}
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
              accessibilityRole="header"
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
            <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, textAlign: 'center' }]}>{tierSub}</Text>
          </View>
        </RiseIn>

        {/* headline tiles */}
        <RiseIn duration={400} delay={50}>
          <CardBox style={{ marginTop: 22, paddingVertical: 4, paddingHorizontal: 8, flexDirection: 'row' }} pad={0}>
            <StatTile value={`${payout.total}`} label={payout.total === 1 ? 'Card' : 'Cards'} />
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
              {...A11Y_HIDDEN}
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
                <View
                  key={label}
                  accessible
                  accessibilityLabel={`${label}: ${n}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
                >
                  <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: color }} />
                  <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3 }]}>
                    {label} <Text style={[font('sans', 700), tnum, { color: c.ink2 }]}>{n}</Text>
                  </Text>
                </View>
              ))}
            </View>
            {missedText ? (
              <Text style={[font('serif', 400, true), { fontSize: 14, color: c.ink2, marginTop: 10, textAlign: 'center' }]}>
                {missedText}
              </Text>
            ) : null}
            {payout.streakDays > 0 ? (
              <View
                accessible
                accessibilityLabel={`${plural(payout.streakDays, 'day')} in a row`}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12 }}
              >
                <Ion name="flame" size={15} color={c.amber} />
                <Text style={[font('sans', 700), tnum, { fontSize: 13.5, color: c.amberDeep }]}>
                  {plural(payout.streakDays, 'day')} in a row
                </Text>
              </View>
            ) : null}
          </View>
        </RiseIn>

        {/* XP payout (C1) */}
        <RiseIn duration={400} delay={150}>
          <CardBox style={{ marginTop: 18 }}>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}
            >
              <Overline>Experience</Overline>
              <Text
                accessibilityLabel={`${payout.xpTotal} XP`}
                style={[font('sans', 800), tnum, { fontSize: 20, color: c.amberDeep }]}
              >
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
                <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>+{it.xp}</Text>
              </View>
            ))}
            <View style={{ marginTop: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 }}>
                <Text style={[font('sans', 700), { fontSize: 13, color: c.ink }]}>
                  {completeLevelLine(payout.levelAfter.level, LEVEL_NAMES_OF_BUILD, levelUp)}
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
              accessible
              accessibilityLabel={`Achievement: ${a.name}. ${a.desc}`}
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
                <Text style={[font('sans', 800), { fontSize: 14.5, color: c.ink }]}>Achievement — {a.name}</Text>
                <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink2 }]}>
                  {a.desc}
                  {a.grantsFreeze && payout.freezeEarned ? ' · +1 streak freeze earned' : ''}
                </Text>
              </View>
            </View>
          </RiseIn>
        ))}

        {/* Retry missed (Settings › Retry missed on): the highlighted offer first */}
        {keepGoing.retryBox ? (
          <RiseIn duration={400} delay={200}>
            <CardBox style={{ marginTop: 22, backgroundColor: c.amberTint, borderColor: c.amberTint }}>
              <Text style={[font('sans', 700), { fontSize: 15, lineHeight: 21, color: c.ink }]}>
                {keepGoing.retryBox.text}
              </Text>
              <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink2, marginTop: 2 }]}>
                Doesn’t change your schedule.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <Btn kind="reward" onPress={() => open('retry')}>
                  {keepGoing.retryBox.cta}
                </Btn>
                <Btn kind="ghost" onPress={() => setRetryDismissed(true)}>
                  Not now
                </Btn>
              </View>
            </CardBox>
          </RiseIn>
        ) : null}

        {/* keep going hub (A2): only rows whose count is above 0 */}
        {keepGoing.rows.length > 0 ? (
          <>
            <SectionHead>Keep going</SectionHead>
            <View>
              {keepGoing.rows.map((row, i) => {
                const look = ROW_ICONS[row.key];
                const tone = tones[look.tone];
                return (
                  <Row
                    key={row.key}
                    onPress={() => open(row.key)}
                    padV={13}
                    last={i === keepGoing.rows.length - 1}
                    label={`${row.title}. ${row.sub}`}
                  >
                    <View
                      {...A11Y_HIDDEN}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        backgroundColor: tone.bg,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ion name={look.icon} size={16} color={tone.fg} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[font('sans', 700), tnum, { fontSize: 14.5, color: c.ink }]}>{row.title}</Text>
                      <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>{row.sub}</Text>
                    </View>
                    <View {...A11Y_HIDDEN}>
                      <Ion name="chevron-forward" size={16} color={c.ink3} />
                    </View>
                  </Row>
                );
              })}
            </View>
          </>
        ) : null}

        <View style={{ marginTop: 20 }}>
          <Btn full size="lg" onPress={done}>
            Done
          </Btn>
        </View>
      </ScrollView>
      {/* The GLOBAL snackbar (useSnackbar) can still be on screen as the session
          opens Complete: for example the card editor's "“Wort” deleted · Undo"
          when the learner deleted the last card and tapped "Finish session" at
          once. Its Undo must stay reachable here. This full-screen modal covers
          the root host, so it mounts its own, outside the ScrollView (it must not scroll). */}
      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
