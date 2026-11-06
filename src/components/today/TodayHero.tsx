/**
 * The top of Today (spec §8.1, §8.11, unit W4-1): the one "study everything"
 * control, or the empty / caught-up state that replaces it.
 *
 *   ┌──────────────── UP FIRST ────────────────┐
 *   │               die Abfahrt                 │   ← the first card of the planned queue
 *   │     12 due · 8 learning · 10 new · 2 checks │      tap = start; long press = CardSheet
 *   └───────────────────────────────────────────┘
 *   [ ▶  Study 30 ]                                   ← the ONLY "study everything" control
 *   Reviews ▓▓▓▓░░ 12 / 30 goal    New ▓▓░░ 4 / 10 goal   (GoalBars; a goal of 0 hides its bar)
 *
 * The number on "Study {n}" is readyFor({}).total (useReady), and the button
 * opens the scheduled session over the SAME scope `{}`, so the session has
 * exactly n cards (spec §4.6). "Up first" is the first card of that same
 * queue (todayLogic.ts upFirstReader → scope.ts buildSessionQueue).
 *
 * The other states (todayLogic.ts `todayMode`), each with real buttons only:
 *   noDecks        "Start with a deck" · Import a file · Find on AnkiWeb · Make my own deck
 *                  (a content pack with starter decks adds "Starter decks" on top: it opens
 *                  the AddSheet's starter decks, todayLogic.ts packChoiceFor)
 *   allPaused      "All your decks are paused." · Show paused decks
 *   pausedCardsOnly "Your cards are in paused decks." / "Your other decks have no cards yet."
 *                  · Add a card · Show paused decks
 *   noCards        "Your decks have no cards yet." · Add a card · Import a file
 *   notStartedOnly "Nothing is in your queue yet." · Choose what to learn
 *   caughtUp       "You're all caught up." · Study ahead · {n} / Practice · {n} /
 *                  Choose what to learn · {n} not started — each only when n > 0
 *                  (none of them reads a paused deck: its cards leave Today)
 *
 * The counts of the caught-up buttons are computed only while that card is
 * on screen (its own component), with the functions that build those
 * sessions (useSessionLength), so every number is the session. "Choose what
 * to learn · {n}" is the number of triage ITEMS the screen already counted
 * for `todayMode` (`notStarted`, todayLogic.ts notStartedItemCount): one
 * number for the state and the button, the same as triage shows.
 *
 * The caught-up buttons may wrap to a second line (`lines={2}`): "Choose
 * what to learn · 12 not started" is wider than the card on a 360-dp phone.
 *
 * The "Study {n}" button breathes softly (todayLogic.ts STUDY_PULSE) — but
 * only a FEW times (wave 5i): twice when Today comes into view and when its
 * number changes, then it rests. Never while Today is not the screen in front
 * (another tab, or a session on top: `useIsFocused`), never with Reduce Motion
 * (spec §8.12). WHY: the endless pulse kept the phone drawing frames on an
 * idle Today (release re-measure: 105–193 frames per 5 s, 13–17 % CPU) and
 * slowed the Library warm-up about 5×. See `startStudyPulse`.
 */
import { type Href, useIsFocused, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';

import { CardSheet } from '@/components/sheets/CardSheet';
import { A11Y_HIDDEN, Bar, Btn, CardBox, Ion, Overline } from '@/components/ui';
import { useLargeText } from '@/components/ui/layout';
import type { Id, ReadyCounts } from '@/domain/model';
import { useFaces } from '@/store/faces';
import { useReduceMotion } from '@/store/useReduceMotion';
import { useSessionLength, useStateV3 } from '@/store/selectors';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  ALL_DECKS_LABEL,
  ALL_SCOPE,
  breakdownLine,
  caughtUpActions,
  type GoalBar,
  NOT_STARTED_SCOPE,
  PRACTICE_SCOPE,
  pulseOn,
  sessionRoute,
  STUDY_PULSE,
  studyLabel,
  TODAY_COPY,
  type TodayMode,
  triageRoute,
  upFirstReader,
} from './todayLogic';

interface TodayHeroProps {
  mode: TodayMode;
  ready: ReadyCounts;
  /** The triage items of "Choose what to learn" (todayLogic.ts notStartedItemCount): the caught-up button's number. */
  notStarted: number;
  /** "Show paused decks" (the allPaused and pausedCardsOnly states): opens the Paused group below. */
  onShowPaused: () => void;
  /** The deck "Add a card" goes into (the noCards and pausedCardsOnly states): the first active deck. */
  firstDeckId: Id | null;
  /** The content pack's "Starter decks" button on the no-decks card (todayLogic.ts packChoiceFor), or null. */
  packChoice: { title: string; sub: string } | null;
  /** Opens the AddSheet (its "Starter decks" part lists the pack's decks). */
  onOpenAdd: () => void;
}

export function TodayHero({ mode, ready, notStarted, onShowPaused, firstDeckId, packChoice, onOpenAdd }: TodayHeroProps) {
  const router = useRouter();
  // "Add a card" (noCards, pausedCardsOnly): the card editor, into the first active deck.
  const addCard = () => router.push({ pathname: '/card-editor', params: firstDeckId ? { deckId: firstDeckId } : {} });

  switch (mode) {
    case 'study':
      return <StudyHero ready={ready} />;
    case 'caughtUp':
      return <CaughtUpCard notStarted={notStarted} />;
    case 'notStartedOnly':
      return (
        <EmptyCard icon="hourglass-outline" title={TODAY_COPY.notStartedTitle}>
          <Btn icon="layers-outline" onPress={() => router.push(triageRoute(NOT_STARTED_SCOPE) as unknown as Href)}>
            {TODAY_COPY.chooseWhat}
          </Btn>
        </EmptyCard>
      );
    case 'allPaused':
      return (
        <EmptyCard icon="pause-circle-outline" title={TODAY_COPY.allPausedTitle}>
          <Btn kind="secondary" onPress={onShowPaused}>
            {TODAY_COPY.showPaused}
          </Btn>
        </EmptyCard>
      );
    case 'pausedCardsOnly':
      return (
        <EmptyCard icon="pause-circle-outline" title={TODAY_COPY.pausedCardsTitle} sub={TODAY_COPY.pausedCardsSub}>
          <Btn icon="add" onPress={addCard}>
            {TODAY_COPY.addCard}
          </Btn>
          <Btn kind="secondary" onPress={onShowPaused}>
            {TODAY_COPY.showPaused}
          </Btn>
        </EmptyCard>
      );
    case 'noCards':
      return (
        <EmptyCard icon="albums-outline" title={TODAY_COPY.noCardsTitle} sub={TODAY_COPY.noCardsSub}>
          <Btn icon="add" onPress={addCard}>
            {TODAY_COPY.addCard}
          </Btn>
          <Btn kind="secondary" onPress={() => router.push({ pathname: '/import', params: { source: 'file' } })}>
            {TODAY_COPY.importFile}
          </Btn>
        </EmptyCard>
      );
    case 'noDecks':
      return (
        <EmptyCard icon="sparkles" title={TODAY_COPY.noDecksTitle} sub={TODAY_COPY.noDecksSub}>
          {packChoice && (
            <Btn icon="leaf-outline" kind="reward" sub={packChoice.sub} onPress={onOpenAdd}>
              {packChoice.title}
            </Btn>
          )}
          <Btn
            icon="document-attach-outline"
            kind={packChoice ? 'secondary' : 'primary'}
            onPress={() => router.push({ pathname: '/import', params: { source: 'file' } })}
          >
            {TODAY_COPY.importFile}
          </Btn>
          <Btn
            kind="secondary"
            icon="cloud-download-outline"
            onPress={() => router.push({ pathname: '/import', params: { source: 'ankiweb' } })}
          >
            {TODAY_COPY.findAnkiWeb}
          </Btn>
          <Btn kind="ghost" icon="create-outline" onPress={() => router.push('/deck-editor')}>
            {TODAY_COPY.makeDeck}
          </Btn>
        </EmptyCard>
      );
  }
}

/* ------------------------------------------------------------------ study */

/**
 * Start the Study button's pulse on `value` (0 = rest, 1 = the biggest):
 * STUDY_PULSE.times breaths, then it ENDS by itself (wave 5i; before, it was
 * an endless loop). Returns a function that stops it at once and puts the
 * button back at rest (the effect's cleanup). `onEnd(finished)` is called
 * once when the breaths are over (`true`) or it was stopped (`false`).
 *
 *   useEffect(() => (pulseOn({ focused, reduced, total }) ? startStudyPulse(pulse) : undefined), [...]);
 *
 * Animated.loop with `iterations` counts the breaths. Each half breath runs
 * on the native driver; the loop starts the next breath from JavaScript
 * (a loop of a sequence cannot run as one native loop), so the JS thread
 * wakes only 2 × `times` times in all.
 */
export function startStudyPulse(value: Animated.Value, onEnd?: (finished: boolean) => void): () => void {
  const half = { duration: STUDY_PULSE.halfMs, easing: Easing.inOut(Easing.ease), useNativeDriver: true };
  const breaths = Animated.loop(
    Animated.sequence([Animated.timing(value, { ...half, toValue: 1 }), Animated.timing(value, { ...half, toValue: 0 })]),
    { iterations: STUDY_PULSE.times },
  );
  breaths.start(({ finished }) => onEnd?.(finished));
  return () => {
    breaths.stop();
    value.setValue(0);
  };
}

/** "Up first" + "Study {n}": the one "study everything" control. */
function StudyHero({ ready }: { ready: ReadyCounts }) {
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const faceOf = useFaces();
  const reduced = useReduceMotion();
  // Today is the screen in front (not another tab, no session on top): only then may the button pulse.
  const focused = useIsFocused();
  const selector = useMemo(() => upFirstReader(now), [now]);
  const first = useStateV3(selector);
  const [peekId, setPeekId] = useState<Id | null>(null);

  const start = () => router.push(sessionRoute('scheduled', ALL_SCOPE, ALL_DECKS_LABEL) as unknown as Href);
  const breakdown = breakdownLine(ready);
  const prompt = first ? faceOf(first).promptPlain : '';

  // A soft breathing pulse on the button (design: pulseSoft 3.2 s), a FEW breaths only (wave 5i):
  // when Today comes into view, and again when the number changes; then it rests. None while
  // Today is not in front, none with Reduce Motion (spec §8.12). See startStudyPulse.
  const [pulse] = useState(() => new Animated.Value(0));
  const total = ready.total;
  useEffect(() => {
    if (!pulseOn({ focused, reduced, total })) return undefined;
    return startStudyPulse(pulse);
  }, [pulse, focused, reduced, total]);

  return (
    <View style={{ marginTop: 24 }}>
      {first && (
        <Pressable
          onPress={start}
          onLongPress={() => setPeekId(first.id)}
          accessibilityRole="button"
          accessibilityLabel={`Up first: ${prompt}. ${breakdown}`}
          accessibilityHint="Starts the session"
          accessibilityActions={[{ name: 'longpress', label: 'Card details' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'longpress') setPeekId(first.id);
          }}
          style={{ paddingTop: 10 }}
        >
          {/* stack edges (decoration) */}
          <View
            {...A11Y_HIDDEN}
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
            {...A11Y_HIDDEN}
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
            <Overline style={{ letterSpacing: 11 * 0.11, textAlign: 'center' }}>Up first</Overline>
            <Text
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              style={[
                font('serif', 600),
                {
                  fontSize: 36,
                  lineHeight: 38,
                  letterSpacing: -0.54,
                  color: c.ink,
                  textAlign: 'center',
                  marginTop: 18,
                  marginBottom: 22,
                },
              ]}
            >
              {prompt}
            </Text>
            {breakdown !== '' && (
              <Text
                style={[
                  font('sans', 500),
                  tnum,
                  {
                    fontSize: 13,
                    color: c.ink2,
                    textAlign: 'center',
                    paddingTop: 14,
                    borderTopWidth: 1,
                    borderTopColor: c.hairlineSoft,
                  },
                ]}
              >
                {breakdown}
              </Text>
            )}
          </View>
        </Pressable>
      )}
      <Animated.View
        style={{
          marginTop: 14,
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, STUDY_PULSE.scale] }) }],
        }}
      >
        <Btn full size="lg" icon="play" onPress={start}>
          {studyLabel(ready.total)}
        </Btn>
      </Animated.View>
      <CardSheet cardId={peekId} open={peekId !== null} onClose={() => setPeekId(null)} />
    </View>
  );
}

/* ------------------------------------------------------------------ caught up */

/** "You're all caught up." with the ways to keep going that have cards (spec §8.1). */
function CaughtUpCard({ notStarted }: { notStarted: number }) {
  const router = useRouter();
  const ahead = useSessionLength({ kind: 'ahead', q: ALL_SCOPE });
  const practice = useSessionLength({ kind: 'practice', q: PRACTICE_SCOPE });
  const buttons = caughtUpActions({ ahead, practice, notStarted });

  const press = (key: (typeof buttons)[number]['key']) => {
    if (key === 'ahead') router.push(sessionRoute('ahead', ALL_SCOPE, 'Study ahead') as unknown as Href);
    else if (key === 'practice') router.push(sessionRoute('practice', PRACTICE_SCOPE, 'Practice') as unknown as Href);
    // Triage route (unit W4-3).
    else router.push(triageRoute(NOT_STARTED_SCOPE) as unknown as Href);
  };

  return (
    <EmptyCard
      icon="checkmark-circle"
      iconTint="success"
      title={TODAY_COPY.caughtUpTitle}
      sub={buttons.length > 0 ? TODAY_COPY.caughtUpSub : TODAY_COPY.caughtUpSubAlone}
    >
      {buttons.map((b, i) => (
        <Btn key={b.key} kind={i === 0 ? 'primary' : 'secondary'} lines={2} onPress={() => press(b.key)}>
          {b.label}
        </Btn>
      ))}
    </EmptyCard>
  );
}

/* ------------------------------------------------------------------ parts */

/** A centred card with an icon, a serif title, an optional line and its buttons (stacked). */
function EmptyCard({
  icon,
  iconTint = 'pine',
  title,
  sub,
  children,
}: {
  icon: string;
  iconTint?: 'pine' | 'success';
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  const c = useColors();
  const fg = iconTint === 'success' ? c.success : c.pine;
  const bg = iconTint === 'success' ? c.successTint : c.pineTint;
  return (
    <CardBox style={{ marginTop: 24, padding: 22, alignItems: 'center' }}>
      <View
        {...A11Y_HIDDEN}
        style={{
          width: 56,
          height: 56,
          borderRadius: 999,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        }}
      >
        <Ion name={icon} size={26} color={fg} />
      </View>
      <Text
        accessibilityRole="header"
        style={[font('serif', 600), { fontSize: 22, color: c.ink, textAlign: 'center' }]}
      >
        {title}
      </Text>
      {sub ? (
        <Text
          style={[
            font('sans', 400),
            { fontSize: 13.5, color: c.ink2, marginTop: 4, textAlign: 'center', maxWidth: 300, lineHeight: 20 },
          ]}
        >
          {sub}
        </Text>
      ) : null}
      {children ? <View style={{ gap: 10, marginTop: 16, alignSelf: 'stretch', alignItems: 'center' }}>{children}</View> : null}
    </CardBox>
  );
}

/**
 * The daily goal bars (todayLogic.ts goalBars): one per goal that is not 0.
 *
 * The goal NUMBERS are never cut (device pass 2026-11-02, F1-1: "Reviews
 * 10 /…" at the largest font size):
 *   - normal font size: the two bars side by side, the SAME width each
 *     (flex: 1), as before;
 *   - large font size (useLargeText): one bar under the other, each the full
 *     width;
 *   - in both: when the label and the numbers do not fit on one line (a
 *     large font size, or "Reviews 120 / 300 goal" in half of a 360 dp
 *     phone), the numbers go on the line under the label.
 *
 * Side by side, the two bars are always on the SAME line (release pass
 * 2026-11-02, C1-4): when only one label wraps onto 2 lines, its bar used to
 * sit lower than the other. Now both columns are as tall as the taller one
 * (the row stretches them, `alignItems: 'stretch'`), and the label part
 * grows (`flexGrow: 1`), so each bar sits at the bottom of its column. The
 * labels keep the same top line.
 */
export function GoalBars({ bars }: { bars: readonly GoalBar[] }) {
  const c = useColors();
  const large = useLargeText();
  if (bars.length === 0) return null;
  return (
    <View style={{ flexDirection: large ? 'column' : 'row', alignItems: 'stretch', gap: large ? 14 : 18, paddingTop: 20 }}>
      {bars.map((bar) => (
        <View
          key={bar.key}
          // Normal size: an equal share of the row. Large: the full width (its own line).
          style={large ? { width: '100%' } : { flex: 1 }}
          accessible
          accessibilityLabel={bar.a11y}
        >
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              // The wrapped lines stay at the top; the extra height (the other label wrapped) goes
              // under them, so the bar below lines up with the other bar.
              alignContent: 'flex-start',
              flexGrow: 1,
              marginBottom: 7,
              columnGap: 6,
            }}
          >
            <Text style={[font('sans', 700), { fontSize: 13, color: c.ink2 }]}>{bar.label}</Text>
            {/* No numberOfLines: "10 / 30 goal" wraps under the label instead of "10 /…". */}
            <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3, flexShrink: 1 }]}>{bar.text}</Text>
          </View>
          <Bar value={bar.pct} color={bar.key === 'reviews' ? c.pine : c.amber} />
        </View>
      ))}
    </View>
  );
}
