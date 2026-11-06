/**
 * Choose what to learn (`/triage?q=`, spec §8.5, unit W4-3): sort the Not
 * started cards of a scope into Learn / I know it / Later.
 *
 *   ×   Choose what to learn                                  34 / 520
 *       German · Level: A2
 *   [ Where do you start? ]            (once, before the first choice, when the scope has levels)
 *   ┌──────────────────────────────────────────┐
 *   │                die Reise                  │   ← front AND back together (choosing, not testing)
 *   │                the trip                   │
 *   │   GRAMMAR -n   EXAMPLE Die Reise war…     │
 *   └──────────────────────────────────────────┘
 *        [ I know it ]     [ Later ]     [ Learn ]
 *   12 to learn · 20 known · 2 later                     Undo
 *   Learn all 486 left  ·  Mark all 486 known
 *
 * When an item has two directions, the counter and the bulk buttons name
 * their unit: "34 / 520 items", "Learn all 486 items left" (triageLogic.ts
 * `positionLabel`, `bulkLabels`; walkthrough M6). The counter draws its unit
 * in small type UNDER the numbers and is at most 30 % of the screen wide
 * (`positionParts`, wave 5c): on one line, "1,234 / 8,970 items" cut the
 * title to "Choose what to…" on a 360 pt phone. The title line under it
 * names the chips like the Library does (searchParse chipsOf, walkthrough M8).
 *
 * Route params:
 *   q     the scope (a Query as JSON). Only its Not started cards are used.
 *   sort  optional SortSpec as JSON: the Library's current sort. Default: deck order.
 *   from  'deck' when the deck page opened it ("Back to deck" goes back).
 *   placed '1' when the deck page's "Where do you start?" opened it: the
 *         question was answered, so the "Where do you start?" button is not
 *         offered again (spec §8.5: once, while nothing was chosen yet).
 *   label optional title under "Choose what to learn" (default: the scope's chips).
 *
 * The run is built ONCE, when the screen opens (in a useState initializer,
 * like the session's queue), and works per ITEM: each choice applies to every
 * Not started card of the note in an enabled direction (triageLogic.ts). The
 * screen calls the store's commands: "Learn" → learn (joins the queue in deck
 * order), "I know it" → markKnown, "Later" writes nothing. Undo takes back the
 * last choice (`undoManualEdit`). It is shown only while the store can still
 * take that choice back (triageLogic.ts `canUndoLast`): an edit too big for
 * the undo log ("Learn all" over 20,000 cards) or pushed out by 50 newer edits
 * has no Undo, so the run never goes back while the cards stay changed.
 *
 * Swipe right = Learn, swipe left = I know it (react-native-gesture-handler);
 * the word shows on the card edge while swiping. The buttons always work, for
 * people who cannot swipe (spec §8.12). A haptic tick per choice (§6.9).
 *
 * The screen brings its own GestureHandlerRootView: gesture-handler needs one
 * above every GestureDetector, and a full-screen modal is its own view tree.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Animated, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { easierNotes, placementDone, placementGroups, sessionRoute, triageLookupOf } from '@/components/deck/deckPageLogic';
import { type PlacementChoice, PlacementSheet } from '@/components/deck/PlacementSheet';
import {
  againLater,
  bulkLabels,
  canUndoLast,
  cardIdsOf,
  choose,
  chooseAll,
  currentItem,
  doneCopy,
  hasChosen,
  isDone,
  leftItems,
  newPerDayOf,
  place,
  positionParts,
  runLine,
  startRun,
  stepSnack,
  TRIAGE_COPY,
  type TriageChoice,
  triageItems,
  undoStep,
} from '@/components/deck/triageLogic';
import { isUndoableEdit, undoManualEditAndReport } from '@/components/study/rescheduleLogic';
import { Btn, CardBox, FacetBadge, FieldRows, SnackbarHost, StackBar, TermText } from '@/components/ui';
import { blocksAfterHeadline } from '@/domain/face';
import { deriveFacets } from '@/domain/facets';
import type { DataStateV3, Query, SortSpec } from '@/domain/model';
import { parseQueryParam, sanitizeQuery } from '@/domain/query';
import { cardLookupOf, matchCtxOf, scopePool, sortScopeCards } from '@/domain/scope';
import { buildSearchCtx, chipsOf } from '@/domain/searchParse';
import { haptics } from '@/platform/haptics';
import { useFaces } from '@/store/faces';
import { useEngine, useLibraryIndex, useReady, useStateV3 } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { useReduceMotion } from '@/store/useReduceMotion';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** How far (pt) a swipe must go before it counts as a choice. */
const SWIPE_AT = 96;
/**
 * The widest the bar's counter may be: this part of the screen width (108 pt
 * on a 360 pt phone). The title "Choose what to learn" (about 162 pt) then
 * keeps its room: 360 − 80 pt (padding, × button, gaps) − 108 = 172 pt.
 */
const COUNTER_MAX_FRAC = 0.3;
const SORT_KEYS: readonly SortSpec['by'][] = ['source', 'due', 'az', 'newest', 'hardest', 'field'];

const settingsOf = (s: DataStateV3) => s.settings;
const decksOf = (s: DataStateV3) => s.decks;
const manualLogOf = (s: DataStateV3) => s.manualLog;

/** The `sort` route param (a SortSpec as JSON), or null when missing or broken. */
function parseSortParam(param: unknown): SortSpec | null {
  const raw = Array.isArray(param) ? param[0] : param;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value = JSON.parse(raw) as Partial<SortSpec> | null;
    if (!value || typeof value !== 'object' || !SORT_KEYS.includes(value.by as SortSpec['by'])) return null;
    const out: SortSpec = { by: value.by as SortSpec['by'] };
    if (typeof value.field === 'string') out.field = value.field;
    if (value.dir === 'asc' || value.dir === 'desc') out.dir = value.dir;
    return out;
  } catch {
    return null;
  }
}

/** The scope without its status group: what "Study now" studies after the run. */
function withoutLife(q: Query): Query {
  const n: Query = { ...sanitizeQuery(q) };
  delete n.life;
  return sanitizeQuery(n);
}

export default function TriageScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const engine = useEngine();
  const actions = engine.actions;
  const { show } = useSnackbar();
  const reduced = useReduceMotion();
  const { width: winW } = useWindowDimensions();
  const params = useLocalSearchParams<{ q?: string; sort?: string; from?: string; placed?: string; label?: string }>();
  const settings = useStateV3(settingsOf);
  const decks = useStateV3(decksOf);
  // The store's undo log: Undo is shown only while it still holds the last step's edit.
  const manualLog = useStateV3(manualLogOf);
  const index = useLibraryIndex();
  const faceOf = useFaces();

  // The run is built ONCE, from the library as it is when the screen opens
  // (the clock may be read here: a useState initializer, like the session's queue).
  const [start] = useState(() => {
    const q = parseQueryParam(params.q);
    const sort = parseSortParam(params.sort) ?? { by: 'source' };
    const state = engine.store.getState();
    const ctx = matchCtxOf(state, Date.now());
    const pool = sortScopeCards(scopePool(state, q, ctx, 'browse'), sort, state, ctx);
    const items = triageItems(pool, triageLookupOf(state, ctx));
    // "Where do you start?": the level-like groups of the cards being chosen.
    const facets = items.length > 0 ? deriveFacets(state.cards, q, {}, ctx) : [];
    const groups = items.length > 0 ? placementGroups(pool, facets, ctx.index) : [];
    // The chips named like the Library names them (searchParse chipsOf with the
    // whole library as its scope, like libraryState chipScopeFor): the same
    // field and direction group names as the Library's chip row (walkthrough M8).
    const scopeQ = withoutLife(q);
    const chipScope = scopeQ.directions ? buildSearchCtx(state.cards, ctx) : undefined;
    const chips = chipsOf(scopeQ, ctx, chipScope)
      .map((chip) => (chip.id === 'decks' ? chip.label.replace(/^Deck: /, '') : chip.label))
      .join(' · ');
    const deckIds = [...new Set(items.map((i) => i.deckId))];
    return { q, items, groups, chips, deckIds, run: startRun(items) };
  });
  const [run, setRun] = useState(start.run);
  const [placing, setPlacing] = useState(false);
  const [dx] = useState(() => new Animated.Value(0));

  const studyQ = useMemo(() => withoutLife(start.q), [start.q]);
  const ready = useReady(studyQ);

  const item = currentItem(run);
  const cardSel = useMemo(() => {
    const id = item?.shownCardId ?? null;
    return (s: DataStateV3) => (id ? (cardLookupOf(s.cards).cardById.get(id) ?? null) : null);
  }, [item?.shownCardId]);
  const card = useStateV3(cardSel);
  const face = card ? faceOf(card) : null;
  const deckOfCard = card ? decks.find((d) => d.id === card.deckId) : undefined;

  const title = params.label || start.chips;
  const fromDeck = params.from === 'deck';
  // "Where do you start?" is offered once: not when the deck page asked it already,
  // and not after the first choice of this run.
  const offerPlacement = !placementDone(params.placed) && !hasChosen(run) && start.groups.length > 0;
  const oneDeck = start.deckIds.length === 1 ? start.deckIds[0] : null;
  const runDecks = decks.filter((d) => start.deckIds.includes(d.id));
  const perDay = newPerDayOf(runDecks, settings.srs.dailyNewLimit);
  const random = runDecks.length === 1 && runDecks[0].options.newOrder === 'random';

  /* ---------------------------------------------------------- handlers */

  const later = (message: string) => setTimeout(() => show(message), 0);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const backToDeck = () => {
    if (fromDeck || !oneDeck) close();
    else router.replace({ pathname: '/deck/[id]', params: { id: oneDeck } });
  };

  const springBack = () => {
    if (reduced) dx.setValue(0);
    else Animated.spring(dx, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
  };

  const decide = (choice: TriageChoice) => {
    const current = currentItem(run);
    if (!current) return;
    let editId: string | null = null;
    if (choice === 'learn') editId = actions.learn(current.cardIds);
    else if (choice === 'known') editId = actions.markKnown(current.cardIds);
    haptics('tick', settings.hapticsEnabled);
    dx.setValue(0);
    setRun(choose(run, choice, editId));
  };

  const undo = () => {
    // Read the log NOW (an event handler): the run goes back only when the
    // store can take the edit back too. Else nothing changes, and we say so.
    const log = engine.store.getState().manualLog;
    if (!canUndoLast(run, (id) => isUndoableEdit(log, id))) {
      if (run.history.length > 0) show(TRIAGE_COPY.undoGone);
      return;
    }
    const back = undoStep(run);
    if (!back) return;
    if (back.editId) undoManualEditAndReport(actions.undoManualEdit, back.editId, later);
    dx.setValue(0);
    setRun(back.run);
  };

  const bulk = (kind: 'learnAll' | 'knownAll') => {
    const left = leftItems(run);
    const ids = cardIdsOf(left);
    if (ids.length === 0) return;
    const editId = kind === 'learnAll' ? actions.learn(ids) : actions.markKnown(ids);
    haptics('tick', settings.hapticsEnabled);
    setRun(chooseAll(run, kind, editId));
    // "12 cards (6 items) added to your queue": the 6 of "Learn all 6 items left" is in it.
    show(stepSnack(kind, ids.length, left.length));
  };

  const applyPlacement = (choice: PlacementChoice) => {
    setPlacing(false);
    if (choice.fromRank <= 0) return;
    const noteIds = easierNotes(run.queue, choice.group, choice.fromRank, index);
    const level = choice.group.values[choice.fromRank]?.label ?? '';
    if (noteIds.length === 0) {
      show(`Nothing below ${level} here`);
      return;
    }
    let editId: string | null = null;
    const items = noteIds.map((id) => run.items.get(id)).filter((i): i is NonNullable<typeof i> => i !== undefined);
    if (choice.below === 'known') editId = actions.markKnown(cardIdsOf(items));
    setRun(place(run, noteIds, choice.below, editId));
    show(
      choice.below === 'known'
        ? stepSnack('place', cardIdsOf(items).length, items.length)
        : `Starting at ${level} — easier ones stay Not started`,
    );
  };

  // Swipe right = Learn, swipe left = I know it. Runs on the JS thread (RN Animated + state).
  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-12, 12])
    .failOffsetY([-18, 18])
    .onUpdate((e) => dx.setValue(e.translationX))
    .onEnd((e) => {
      if (e.translationX > SWIPE_AT) decide('learn');
      else if (e.translationX < -SWIPE_AT) decide('known');
      else springBack();
    });

  /* ---------------------------------------------------------- render */

  const done = isDone(run);
  const position = positionParts(run);
  const bulkText = bulkLabels(run);
  const line = runLine(run);
  const canUndo = canUndoLast(run, (id) => isUndoableEdit(manualLog, id));
  const learnOpacity = dx.interpolate({ inputRange: [0, SWIPE_AT], outputRange: [0, 1], extrapolate: 'clamp' });
  const knowOpacity = dx.interpolate({ inputRange: [-SWIPE_AT, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const rotate = dx.interpolate({ inputRange: [-300, 0, 300], outputRange: ['-6deg', '0deg', '6deg'] });

  const headline = face?.prompt[0];
  const headlineText = face ? face.promptPlain : '';
  const answerText = face ? face.answerPlain : '';
  const details = face ? [...face.prompt.slice(1), ...blocksAfterHeadline(face.answer)] : [];

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar
        title={TRIAGE_COPY.title}
        sub={title || undefined}
        backIcon="close"
        onBack={close}
        right={
          start.items.length > 0 ? (
            // The counter: the numbers, and the unit UNDER them (triageLogic
            // positionParts). So it is only as wide as "1,234 / 8,970", and at
            // most COUNTER_MAX_FRAC of the bar (the numbers shrink to fit): the
            // title keeps its room on a 360 pt phone.
            <View
              accessible
              accessibilityLabel={position.a11y}
              style={{ alignItems: 'flex-end', maxWidth: Math.round(winW * COUNTER_MAX_FRAC) }}
            >
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.6}
                style={[font('mono', 500), tnum, { fontSize: 12.5, color: c.ink3 }]}
              >
                {position.count}
              </Text>
              {position.unit !== null ? (
                <Text numberOfLines={1} style={[font('sans', 600), { fontSize: 11, color: c.ink3 }]}>
                  {position.unit}
                </Text>
              ) : null}
            </View>
          ) : null
        }
      />

      {start.items.length === 0 ? (
        /* ---------------- nothing to choose at all */
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text accessibilityRole="header" style={[font('serif', 600), { fontSize: 21, color: c.ink, textAlign: 'center', marginBottom: 18 }]}>
            {TRIAGE_COPY.empty}
          </Text>
          <Btn onPress={backToDeck} style={{ alignSelf: 'center' }}>
            {oneDeck ? TRIAGE_COPY.backToDeck : TRIAGE_COPY.backLabel}
          </Btn>
        </View>
      ) : done ? (
        /* ---------------- the end of the run */
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: insets.bottom + 24 }}>
          {(() => {
            const copy = doneCopy(run, { perDay, random });
            return (
              <View style={{ alignItems: 'center' }}>
                <Text
                  accessibilityRole="header"
                  style={[font('serif', 600), tnum, { fontSize: 22, lineHeight: 28, color: c.ink, textAlign: 'center' }]}
                >
                  {copy.title}
                </Text>
                {copy.lines.map((l) => (
                  <Text key={l} style={[font('sans', 400), tnum, { fontSize: 14, lineHeight: 20, color: c.ink2, textAlign: 'center', marginTop: 6 }]}>
                    {l}
                  </Text>
                ))}
              </View>
            );
          })()}
          <View style={{ gap: 10, marginTop: 26 }}>
            {ready.total > 0 ? (
              <Btn
                full
                size="lg"
                icon="play"
                onPress={() => router.replace(sessionRoute({ kind: 'scheduled', q: studyQ, label: title || TRIAGE_COPY.title }))}
              >
                {TRIAGE_COPY.studyNow}
              </Btn>
            ) : null}
            {run.later.length > 0 ? (
              <Btn full kind="secondary" onPress={() => setRun(againLater(run))}>
                {TRIAGE_COPY.againLater}
              </Btn>
            ) : null}
            <Btn full kind={ready.total > 0 ? 'secondary' : 'primary'} onPress={backToDeck}>
              {oneDeck ? TRIAGE_COPY.backToDeck : TRIAGE_COPY.backLabel}
            </Btn>
            {canUndo ? (
              <Btn kind="ghost" size="sm" style={{ alignSelf: 'center' }} onPress={undo} label="Undo the last choice">
                {TRIAGE_COPY.undo}
              </Btn>
            ) : null}
          </View>
        </View>
      ) : (
        /* ---------------- the run */
        <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + 14 }}>
          {offerPlacement ? (
            <Btn kind="secondary" size="sm" icon="flag-outline" style={{ alignSelf: 'center', marginBottom: 10 }} onPress={() => setPlacing(true)}>
              {TRIAGE_COPY.placement}
            </Btn>
          ) : null}

          <View style={{ flex: 1, justifyContent: 'center' }}>
            <GestureDetector gesture={pan}>
              <Animated.View style={{ transform: [{ translateX: dx }, { rotate }] }}>
                <CardBox pad={22} label={`${headlineText}. ${answerText}`}>
                  {/* The swipe words: Learn on the left edge (swiping right), I know it on the right. */}
                  <Animated.Text
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[font('sans', 800), { position: 'absolute', top: 12, left: 14, fontSize: 13, color: c.pine, opacity: learnOpacity }]}
                  >
                    {TRIAGE_COPY.swipeLearn.toUpperCase()}
                  </Animated.Text>
                  <Animated.Text
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[font('sans', 800), { position: 'absolute', top: 12, right: 14, fontSize: 13, color: c.amber, opacity: knowOpacity }]}
                  >
                    {TRIAGE_COPY.swipeKnow.toUpperCase()}
                  </Animated.Text>

                  {face && face.badges.length > 0 ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 12, marginTop: 8 }}>
                      {face.badges.map((b) => (
                        <FacetBadge key={b.field} value={b.plain} label={b.label} />
                      ))}
                    </View>
                  ) : null}
                  {headline && headline.role === 'term' ? (
                    <TermText
                      text={headlineText || '—'}
                      lang={headline.lang}
                      genderColors={deckOfCard?.genderColors !== false}
                      style={[font('serif', 600), { fontSize: 32, lineHeight: 38, color: c.ink, textAlign: 'center', marginTop: 14 }]}
                    />
                  ) : (
                    <Text style={[font('serif', 600), { fontSize: 30, lineHeight: 36, color: c.ink, textAlign: 'center', marginTop: 14 }]}>
                      {headlineText || '—'}
                    </Text>
                  )}
                  <Text style={[font('serif', 400), { fontSize: 19, lineHeight: 25, color: c.ink2, textAlign: 'center', marginTop: 8 }]}>
                    {answerText}
                  </Text>
                  {details.length > 0 ? (
                    <View style={{ marginTop: 14 }}>
                      <FieldRows blocks={details} variant="compact" />
                    </View>
                  ) : null}
                </CardBox>
              </Animated.View>
            </GestureDetector>
          </View>

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <Btn full kind="secondary" icon="checkmark-done" style={{ flex: 1 }} onPress={() => decide('known')}>
              {TRIAGE_COPY.know}
            </Btn>
            <Btn full kind="quiet" style={{ flex: 0.8 }} onPress={() => decide('later')}>
              {TRIAGE_COPY.later}
            </Btn>
            <Btn full icon="add" style={{ flex: 1 }} onPress={() => decide('learn')}>
              {TRIAGE_COPY.learn}
            </Btn>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, minHeight: 28 }}>
            <Text style={[font('sans', 600), tnum, { flex: 1, fontSize: 13, color: c.ink3 }]}>{line}</Text>
            {canUndo ? (
              <Pressable onPress={undo} hitSlop={14} accessibilityRole="button" accessibilityLabel="Undo the last choice">
                <Text style={[font('sans', 700), { fontSize: 13.5, color: c.pine }]}>{TRIAGE_COPY.undo}</Text>
              </Pressable>
            ) : null}
          </View>

          {bulkText ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 10 }}>
              <Btn kind="ghost" size="sm" onPress={() => bulk('learnAll')}>
                {bulkText.learn}
              </Btn>
              <Btn kind="ghost" size="sm" onPress={() => bulk('knownAll')}>
                {bulkText.known}
              </Btn>
            </View>
          ) : null}
        </View>
      )}

      <PlacementSheet open={placing} onClose={() => setPlacing(false)} groups={start.groups} onApply={applyPlacement} />
      <SnackbarHost aboveTabBar={false} />
    </GestureHandlerRootView>
  );
}
