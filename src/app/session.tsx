/**
 * Study session — the sacred loop (spec §6, unit W4-4).
 *
 *   /session?kind=&q=&sel=&mode=&sort=&label=
 *     kind   scheduled (Study) · ahead (Study ahead) · practice (never changes the schedule)
 *     q      the scope, a Query as JSON ({} = all decks)
 *     sel    a selection token ("Practice the {n} you missed"); card ids are never in a URL
 *     mode   flash · type · mc · mix · article (Articles: Practice only); default = Settings
 *     sort   the practice order (JSON SortSpec, or 'hardest')
 *     label  what is studied ("German · Level B1")
 *
 * Chrome-minimal: thin ink progress line, the card centred with the queue
 * visible as a stack beneath it, and a rating zone of stable height.
 *
 * How it works (every rule is a pure, tested function in
 * src/components/study/sessionLogic.ts; this file holds React state and calls):
 *   - The queue is built ONCE, in the useState initializer (where the clock
 *     may be read): `startSession` → scope.ts `buildSessionQueue`, the same
 *     function that counts every "Study N" button, so the button number is
 *     the session length. The per-card mode plans (Typing target, Quiz
 *     choices, Articles question) are fixed there too, seeded by the card id
 *     and the session day, so render stays pure (React Compiler).
 *   - Every mode ends with the same 4 rating buttons; a mode only SUGGESTS a
 *     rating (an outline). Articles has no rating buttons: it is Practice
 *     only and writes nothing; "Next" counts right as Good, wrong as Again.
 *   - A rating calls `actions.rateCard` and uses the card it RETURNS: as the
 *     "Again" copy re-queued at idx + 3 (M10) and as the session's
 *     `finalCard` (M6). Practice (`kind: 'practice'`) writes nothing (H3).
 *   - After every rating the in-flight marker is saved (`trackSession`, with
 *     the session's start day as `studyDay` and its mode), so an app kill
 *     banks the session once on the next boot (M5), with its mode in the
 *     record (wave 5h).
 *   - Undo pops the session's own snapshot stack and, for a rating that was
 *     written, `undoLastReview` (reviewLog only — manual edits never break it).
 *   - Leaving early (✕ or Android's Back → "End session"; any other way out
 *     is caught by `beforeRemove`) banks the partial session once (the exit
 *     sheet of a Practice says "Your practice is kept (3 cards). Your
 *     schedule does not change.", sessionLogic exitSavedLine), and the
 *     screen you land on shows "Session saved · 3 cards · +12 XP" on the
 *     GLOBAL snackbar (M10). When a global message with an Undo is on screen
 *     then (the card editor's "“Wort” deleted · Undo"), "Session saved" is
 *     shown AFTER it, so that Undo is never replaced (sessionLogic
 *     earlyExitSnackDelay, wave 5d). There is no swipe to leave: the route is a
 *     'fullScreenModal' with `gestureEnabled: false` (src/app/_layout.tsx).
 *   - `committedRef` = this session is banked (or left with nothing to
 *     bank). Every way to bank or leave (finish, exitNow, leaveAllDone,
 *     beforeRemove) and every rating or undo checks it FIRST and does
 *     nothing once it is set. WHY: the screen stays mounted for a moment
 *     after it banked (the fade to Complete, the slide back), and a double
 *     tap or a second Back in that moment banked the same reviews twice:
 *     double XP and two session records (M5 "payout once").
 *   - Android's hardware Back (sessionLogic backPressAction, H1): only while
 *     the session is the FOCUSED screen (under the card editor it is not:
 *     the editor's Back is the navigator's). With the keyboard open it ONLY
 *     closes the keyboard (the typed answer stays); after at least one
 *     rating it opens the same "End this session?" sheet as ✕; with nothing
 *     rated it leaves. The `beforeRemove` partial commit stays as the safety
 *     net for any other way out. The keyboard's short grace window is timed
 *     on a clock that never goes back (steadyTime), and a keyboard the
 *     session closed itself ("Check") never opens it (review round 2). The
 *     window explains ONE Back press only (the press that closed the
 *     keyboard): it is used up by that press, so a second Back press right
 *     after it is a real Back and asks "End this session?" (wave 5c).
 *     Since the final device pass (K1-1) every OTHER screen has the same
 *     keyboard rule, through the app-wide guard (src/platform/keyboardBack.ts,
 *     installed in _layout.tsx). The session keeps its own rule (it also
 *     checks that it is the focused screen), so it adds its listener with
 *     `addKeyboardAwareBackListener` (the guard does not run the rule a
 *     second time) and tells the guard what it did (markKeyboardBackPress,
 *     markAppClosesKeyboard): a press the session took for the keyboard is
 *     used up for the navigator under it too. The rules and the constants
 *     are the guard's (sessionLogic re-exports them): one source of truth.
 *   - `ratingLock` ignores a second tap before the next card is on screen.
 *     The same for an answer: the FIRST reveal, "Check", quiz choice or
 *     article decides; a second tap in the same frame changes nothing
 *     (`answer` → sessionLogic `answerRun`, inside the state update).
 *   - "Study ahead · {n}" on the empty queue carries the label only when it
 *     names the scope (sessionLogic followUpLabel), never a label that names
 *     the practice ("Your hardest cards") or a selection.
 *   - More: Edit card · Reschedule… · Bury · Flag/Unflag (the STORE copy) ·
 *     Suspend · Switch mode · Card info (before the reveal it shows the
 *     question only, never the answer: CardSheet `hideAnswer`, wave 5h;
 *     Articles: the bare word). Reschedule, Bury and Suspend take the
 *     card out of this session, with an Undo that puts it back at the same
 *     place (each one is a ManualEdit; Bury had no Undo before the final review).
 *     When that was the LAST card (or a deleted card), the screen
 *     stays in "All done here" (EmptyQueue.tsx AllDoneHere, M1): the message,
 *     its Undo (on screen, never timed out) and "Finish session" (or "Back"
 *     when nothing was rated). So a late tap on Undo never hits the next screen.
 *     After "Edit card" the new text shows at once (faces are read live);
 *     a card whose note was deleted there leaves the queue ("Card deleted",
 *     the session's own message, with no Undo). When that was the last
 *     card, it is "All done here" too, with no Undo of its own. In both
 *     cases the card editor's GLOBAL snackbar "“Wort” deleted · Undo" stays
 *     on screen (the session mounts a SnackbarHost), and the session never
 *     sends a GLOBAL message that would replace it (review round 2; also
 *     not "Session saved" when the learner ends the session early, see
 *     above). When the learner taps THAT Undo, the note comes back in the
 *     store, and the session puts its cards back too (`deleted`,
 *     sessionLogic restoreDeleted, wave 5c): the card is on screen again,
 *     the same as after the Undo of a Suspend, also in the middle of a
 *     session. A card that comes back (this Undo, or the Undo of a Suspend
 *     or a Reschedule) is planned in the CURRENT mode, also after a "Switch
 *     mode" while it was out (wave 5d). The session's Undo of a rating made
 *     while the card was out keeps it (sessionLogic undoRun, review round 2).
 *   - The rating buttons show the next interval of each rating
 *     (ratingPredictions). A Known card is a Check: Good / Easy keep it Known
 *     ("Known", nothing is scheduled); Hard / Again restart it in Learning.
 *   - Read aloud speaks the headline of the visible side in the field's
 *     language (speechOf + speak(text, lang)); "Speak the question
 *     automatically" speaks each new question. Haptics follow Settings.
 */
import { type Href, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardSheet } from '@/components/sheets/CardSheet';
import { ArticleButtons, ArticleNext, ArticleResult } from '@/components/study/ArticleQuiz';
import { CardActionsSheet } from '@/components/study/CardActionsSheet';
import { AllDoneHere, EmptyQueue } from '@/components/study/EmptyQueue';
import { ExitConfirmSheet } from '@/components/study/ExitConfirmSheet';
import { HintBar, HintText } from '@/components/study/HintBar';
import { MilestoneToast } from '@/components/study/MilestoneToast';
import { ModeSheet } from '@/components/study/ModeSheet';
import { QuizChoices } from '@/components/study/QuizChoices';
import { RatingButtons } from '@/components/study/RatingButtons';
import { RescheduleSheet } from '@/components/study/RescheduleSheet';
import { canReschedule, isUndoableEdit, rescheduleSnack, undoManualEditAndReport } from '@/components/study/rescheduleLogic';
import { SessionHeader } from '@/components/study/SessionHeader';
import {
  type Answer,
  answerRun,
  articleChipShown,
  articleRating,
  articleRight,
  backPressAction,
  blockedIn,
  type CardUi,
  cardName,
  completeHref,
  currentCard,
  currentPlan,
  currentUi,
  dropMissing,
  earlyExitSnack,
  earlyExitSnackDelay,
  FALLBACK_COPY,
  followUpLabel,
  hintSourceFor,
  initialRun,
  isExhausted,
  keyboardHideOpensGrace,
  leaveOutcome,
  markerOf,
  moreSheetTitle,
  nextHint,
  parseSessionRoute,
  patchUi,
  plansFor,
  type QueueCard,
  rateRun,
  rateSnack,
  ratingPredictions,
  remainingCards,
  replanRun,
  restoreDeleted,
  restoreToRun,
  routeKey,
  type RouteParams,
  routeWrites,
  type RunState,
  type SeenSnack,
  sessionHref,
  sessionQueueTime,
  sessionScreen,
  sessionStepLabel,
  shownHint,
  showHintButton,
  startSession,
  suggestedRating,
  switchModeRun,
  undoRun,
} from '@/components/study/sessionLogic';
import { StudyCard } from '@/components/study/StudyCard';
import { TypingAnswer } from '@/components/study/TypingAnswer';
import { RiseIn, SnackbarHost, SnackbarView } from '@/components/ui';
import { checkTyped } from '@/domain/answerCheck';
import { speechOf, type SpokenText } from '@/domain/face';
import type { GermanArticle } from '@/domain/lang';
import type { Card, DataStateV3, Id, StudyMode } from '@/domain/model';
import { articleCards, MODE_LABELS } from '@/domain/modes';
import { cardLookupOf, decksById, matchCtxOf, type ScopeState } from '@/domain/scope';
import { missingVoiceNotice, speak, stopSpeaking } from '@/domain/speech';
import { stepLabel } from '@/domain/srs';
import { dayKeyOf, type Rating } from '@/domain/types';
import { haptics } from '@/platform/haptics';
import {
  addKeyboardAwareBackListener,
  markAppClosesKeyboard,
  markKeyboardBackPress,
  steadyTime,
} from '@/platform/keyboardBack';
import { useData } from '@/store/DataContext';
import { useFaces } from '@/store/faces';
import { getSelection, putSelection } from '@/store/selectionRegistry';
import { memoOnInputs, useEngine, useStateV3 } from '@/store/selectors';
import { useSnackbar, useSnackDuration } from '@/store/SnackbarContext';
import { useNow } from '@/store/useNow';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** What a snackbar's Undo takes back: the last rating, or a manual edit (and the card it took out). */
type SnackUndo = { type: 'rating' } | { type: 'edit'; editId: string; card?: QueueCard };

interface Snack {
  text: string;
  undo?: SnackUndo;
}

/** The session's message when a card left because its note was deleted (in the card editor, or elsewhere). */
const CARD_DELETED_COPY = 'Card deleted';

/** The sheet open on top of the session (one at a time). */
type SheetName = 'more' | 'reschedule' | 'mode' | 'info';

/** A More row that opens something only after the More sheet has slid out. */
type Pending = 'edit' | 'reschedule' | 'mode' | 'info';

/* Stable selectors (module level, so the store hook keeps them). */
const settingsOf = (s: DataStateV3) => s.settings;
const cardsOf = (s: DataStateV3) => s.cards;
const decksOf = (s: DataStateV3) => s.decks;
/**
 * What the mode plans read (sessionLogic plansFor): the scope state, the
 * SAME object while its parts stay the same. Destructured: the face guard
 * (face.test.ts) forbids a direct property read of the notes in screens.
 */
const planStateOf = memoOnInputs(
  ({ cards, notes, noteTypes, decks, lists, person, settings }: DataStateV3): readonly unknown[] => [
    cards,
    notes,
    noteTypes,
    decks,
    lists,
    person,
    settings,
  ],
  ({ cards, notes, noteTypes, decks, lists, person, settings }: DataStateV3): ScopeState => ({
    cards,
    notes,
    noteTypes,
    decks,
    lists,
    person,
    settings,
  }),
);

/** "Rating undone" text. */
const UNDONE_COPY = 'Rating undone — card restored';

/**
 * The time of a tap or a commit. Event handlers and navigation listeners
 * only: it reads the clock (React Compiler forbids Date.now() in render).
 */
function pressTime(): number {
  return Date.now();
}

/** The time since `at` on the steady clock (keyboardBack.ts steadyTime; Infinity when it never happened). */
function msSince(at: number | null): number {
  return at === null ? Infinity : steadyTime() - at;
}

export default function SessionScreen() {
  const params = useLocalSearchParams() as RouteParams;
  // A new set of params (a replace to the same route) is a NEW session: the key remounts it.
  return <SessionBody key={routeKey(params)} params={params} />;
}

function SessionBody({ params }: { params: RouteParams }) {
  const c = useColors();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const engine = useEngine();
  const { actions } = useData();
  // `globalSnack` = the GLOBAL message on screen now (for example the card editor's "“Wort” deleted · Undo").
  const { show, snack: globalSnack } = useSnackbar();
  // The same time rule as the global snackbar (walkthrough M5): an Undo stays 6 s (15 s with a screen reader).
  const durationFor = useSnackDuration();
  const faceOf = useFaces();
  const settings = useStateV3(settingsOf);
  const cards = useStateV3(cardsOf);
  const decks = useStateV3(decksOf);
  // The store state the mode plans read: a card that comes back is planned in the mode now on.
  const planState = useStateV3(planStateOf);

  // The time the Study buttons counted with (the ONE shared clock, useNow).
  const countedAt = useNow();
  // Build the session ONCE from the live store, then own it locally (spec §6.1).
  const [start] = useState(() => {
    const startedAt = Date.now();
    const route = parseSessionRoute(params);
    const state = engine.store.getState();
    const dayKey = dayKeyOf(startedAt);
    const selIds = route.sel ? getSelection(route.sel) : null;
    // The queue is built at the buttons' time while it is fresh: "Study N" opens exactly N cards (final review).
    const queueAt = sessionQueueTime(countedAt, startedAt);
    const session = startSession(route, state, matchCtxOf(state, queueAt), dayKey, selIds);
    // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes in screens.
    const { notes, noteTypes } = state;
    return { ...session, startedAt, dayKey, library: { notes, noteTypes } };
  });
  const [run, setRun] = useState<RunState>(() => initialRun(start.queue, start.plans));
  const [mode, setMode] = useState<StudyMode>(start.mode);
  const [snack, setSnack] = useState<Snack | null>(null);
  // The message (and Undo) of the action that took the LAST card out: the "All done here" state (M1).
  const [lastLeave, setLastLeave] = useState<Snack | null>(null);
  // The queue cards that left because their note was deleted: the card editor's Undo can bring them back.
  const [deleted, setDeleted] = useState<readonly QueueCard[]>([]);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [areaHeight, setAreaHeight] = useState(0);

  const ratingLock = useRef(false); // re-entrancy guard against double taps
  const answeredRef = useRef<CardUi | null>(null); // the answer state that was already answered (see `answer`)
  const committedRef = useRef(false); // true once this session has been banked
  const pendingRef = useRef<Pending | null>(null);
  const planLibRef = useRef(start.library); // the notes the plans were made from
  const keyboardHidAt = useRef<number | null>(null); // when the session's keyboard last went away (Android's Back, H1)
  const selfDismissAt = useRef<number | null>(null); // when the session last closed the keyboard ITSELF ("Check", Back)
  // The GLOBAL message on screen, and when it appeared (steady clock): "Session saved" waits for its Undo (bankEarly).
  const globalSeen = useRef<SeenSnack | null>(null);
  // The screen-reader focus targets of the mode's result on the answer side (StudyCard
  // `answerExtraFocus`, wave 5h): the first line of the typing result, the picked quiz choice.
  const typedFocus = useRef<Text>(null);
  const pickFocus = useRef<View>(null);

  // Remember when a new GLOBAL message appears (a ref only, nothing is drawn from it).
  useEffect(() => {
    globalSeen.current = globalSnack ? { withAction: globalSnack.onAction !== undefined, at: steadyTime() } : null;
  }, [globalSnack]);

  /** The plans of cards that come back, in the mode now on (wave 5d: a mode switch while they were out). */
  const replanBack = (back: readonly QueueCard[]) => plansFor(back, mode, start.kind, start.dayKey, planState);

  const { cardById } = cardLookupOf(cards);
  // A card whose note was deleted (More › Edit card › Delete) left the
  // session, and the card editor's Undo ("“Wort” deleted · Undo") brought the
  // note back: its cards are studied again, on screen at once, like the Undo
  // of a Suspend (wave 5c, M1; review round 1: also in the MIDDLE of a
  // session, not only for the last card). Adjust-state-during-render: the
  // session reads the store's cards, so it renders again when the Undo
  // lands, and this runs once (the cards that came back leave `deleted`).
  // A card that comes back is planned in the CURRENT mode (`replanBack`,
  // wave 5d): a "Switch mode" while it was out did not plan it.
  const comeBack = deleted.length > 0 ? restoreDeleted(run, deleted, (id) => cardById.has(id), replanBack) : null;
  if (comeBack) {
    setRun(comeBack);
    setDeleted(deleted.filter((q) => !cardById.has(q.id)));
    // The session's own "Card deleted" is not true any more.
    if (snack?.text === CARD_DELETED_COPY) setSnack(null);
    // "All done here" ends: the session goes on. A message with an Undo (a
    // Suspend of the last card meanwhile) moves to the snackbar, so that Undo stays.
    if (lastLeave) {
      setLastLeave(null);
      if (lastLeave.undo) setSnack(lastLeave);
    }
  }

  const card = currentCard(run);
  const ui = currentUi(run);
  const plan = currentPlan(run);
  const cardKey = ui.key;
  const writes = routeWrites(start.kind);
  // The STORE copy of the card on screen: the queue copy goes stale after a flag (spec §6.5).
  const live = card ? (cardById.get(card.id) ?? card) : undefined;
  const face = card ? faceOf(card) : null;
  const deck = card ? decksById(decks).get(card.deckId) : undefined;
  const genderColors = deck?.genderColors !== false;
  // From the STORE copy (the one rateCard rates); a Known card is a Check: Good / Easy say "Known".
  const pred = live ? ratingPredictions(live, settings.srs, writes) : null;
  // Practice shows no learning-step pill: it changes no step (H3).
  const step = card ? sessionStepLabel(start.kind, stepLabel(card, settings.srs)) : null;
  const hintSource = face ? hintSourceFor(face, plan) : null;
  const suggested = suggestedRating(plan, ui);
  const article = plan.mode === 'article' ? plan.article : null;

  /** The marker / record values that are the same for every commit of this session. */
  const meta = () => ({
    kind: start.kind,
    label: start.label,
    durationSec: Math.round((pressTime() - start.startedAt) / 1000),
    // The day the session's reviews belong to: its START day (studyDay attribution).
    studyDay: dayKeyOf(start.startedAt),
    // The mode now (after "Switch mode", the new one). In the marker too (wave 5h), so a
    // session banked by the boot reconcile after a kill keeps its mode in the record.
    mode,
  });

  // Release the double-tap lock whenever another card is on screen.
  useEffect(() => {
    ratingLock.current = false;
  }, [cardKey]);

  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), durationFor(!!snack.undo));
    return () => clearTimeout(t);
  }, [snack, durationFor]);

  useEffect(() => {
    if (!milestone) return;
    const t = setTimeout(() => setMilestone(null), 1600);
    return () => clearTimeout(t);
  }, [milestone]);

  // Stop speaking when the session closes.
  useEffect(() => () => stopSpeaking(), []);

  /* ——— read aloud (spec §6.8) ——— */

  /** What 🔊 speaks now: the headline of the visible side (Articles: the bare word, then the whole term). */
  const spokenNow = (): SpokenText | null => {
    if (!face) return null;
    if (article) {
      const text = ui.article ? `${article.article} ${article.word}` : article.word;
      return article.lang ? { text, lang: article.lang } : { text };
    }
    return speechOf(face, ui.revealed ? 'answer' : 'prompt');
  };

  const sayNow = () => {
    const spoken = spokenNow();
    if (!spoken) return;
    speak(spoken.text, spoken.lang);
    void missingVoiceNotice(spoken.lang).then((message) => {
      if (message) setSnack({ text: message });
    });
  };

  // "Speak the question automatically": speak each new question once (a side effect, not a setState).
  const question: SpokenText | null = !face
    ? null
    : article
      ? { text: article.word, lang: article.lang }
      : speechOf(face, 'prompt');
  const autoText = settings.autoReadAloud && question ? question.text : '';
  const autoLang = question?.lang;
  useEffect(() => {
    if (!autoText) return;
    speak(autoText, autoLang);
    let alive = true;
    void missingVoiceNotice(autoLang).then((message) => {
      if (alive && message) setSnack({ text: message });
    });
    return () => {
      alive = false;
    };
  }, [cardKey, autoText, autoLang]);

  /* ——— banking the session ——— */

  /**
   * The session is over: bank it (M5: payout and marker clear in one state)
   * and show Complete. Once only: a session that is already banked is never
   * banked again (see committedRef in the header).
   */
  const finish = (final: RunState, reviewed: number, finalCard?: Card) => {
    if (committedRef.current) return;
    committedRef.current = true; // finalized here — block the partial commit on removal
    setDeleted([]); // banked: a deleted card that comes back later is not this session's any more
    stopSpeaking();
    actions.completeSession({
      ...meta(),
      counts: final.counts,
      total: reviewed,
      bestRun: final.bestRun,
      fastAnswers: final.fastAnswers,
      finalCard,
    });
    haptics('complete', settings.hapticsEnabled);
    const missedToken = final.missed.length > 0 ? putSelection(final.missed) : null;
    router.replace(completeHref(start.scope, missedToken) as Href);
  };

  /**
   * Bank the rated part of a session that ends early, and say so on the
   * screen you land on: "Session saved · 3 cards · +12 XP" (the GLOBAL
   * snackbar, which stays over the next screen; M10). No Complete screen:
   * the early exit is by design. Call it only when at least one card was rated.
   *
   * The global channel shows ONE message: a new one replaces the old one. So
   * when a global message with an Undo is on screen (the card editor's
   * "“Wort” deleted · Undo", shown a moment ago), "Session saved" WAITS until
   * that Undo's time is over (sessionLogic earlyExitSnackDelay, wave 5d):
   * the Undo is never lost. The timer outlives this screen on purpose (the
   * message is for the screen you land on).
   */
  const bankEarly = () => {
    const payout = actions.completeSession({
      ...meta(),
      counts: run.counts,
      total: run.idx,
      bestRun: run.bestRun,
      fastAnswers: run.fastAnswers,
    });
    actions.clearLastCompletion();
    const saved = earlyExitSnack(payout.total, payout.xpTotal);
    const wait = earlyExitSnackDelay(globalSeen.current, steadyTime(), durationFor(true));
    if (wait > 0) setTimeout(() => show(saved), wait);
    else show(saved);
  };

  // Bank a partial session on ANY exit the explicit close does not cover: a
  // navigation from OUTSIDE the session (for example a tap on a reminder,
  // which opens Today: _layout.tsx ReminderTapRouter). There is no swipe to
  // leave (the route has
  // `gestureEnabled: false`), and Android's Back asks first (see the
  // hardware Back below). Per-rating schedule writes are already saved; this
  // saves the XP / streak / record of what was reviewed.
  // committedRef stops a double commit when finish() / exitNow() already banked it (M5).
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', () => {
      if (committedRef.current || run.idx === 0) return;
      committedRef.current = true;
      bankEarly();
    });
    return unsub;
  });

  /**
   * ✕ → "End session" (or ✕ with nothing rated): partial sessions still
   * count (the exit sheet promises it). Once only: a second tap must not bank
   * again, and must not go back a second time (that would close the screen
   * under the session too).
   */
  const exitNow = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setDeleted([]); // the same as finish()
    stopSpeaking();
    if (run.idx > 0) bankEarly();
    router.back();
  };

  /* ——— the card leaves the session (bury, suspend, reschedule) ——— */

  /**
   * Run the Undo of a manual edit; when it reverted the card, put the card
   * back into the session, planned in the mode now on (wave 5d).
   */
  const undoEdit = (editId: string, back?: QueueCard) => {
    const result = undoManualEditAndReport(actions.undoManualEdit, editId, (text) =>
      setTimeout(() => setSnack({ text }), 0),
    );
    if (back && result.reverted > 0) {
      const plans = plansFor([back], mode, start.kind, start.dayKey, engine.store.getState());
      setRun((r) => restoreToRun(r, back, () => plans));
    }
    return result;
  };

  /**
   * The card on screen leaves the session. Cards are left: the session goes
   * on, and its snackbar shows the message with its Undo. It was the LAST
   * card: the screen stays in "All done here" with the message and its Undo
   * on screen (sessionLogic leaveOutcome, M1). Nothing is banked yet: that
   * happens on "Finish session" (or on any other way out, beforeRemove).
   */
  const leaveSession = (cardId: Id, message: Snack) => {
    const out = leaveOutcome(run, cardId);
    setRun(out.next);
    if (out.end === 'stay') {
      setSnack({ text: message.text, undo: message.undo });
      return;
    }
    setSnack(null);
    setLastLeave(message);
  };

  /** "Undo" in "All done here": the card comes back, and the session goes on with it (not after it was banked). */
  const undoLastLeave = () => {
    const undo = lastLeave?.undo;
    if (committedRef.current || !lastLeave || undo?.type !== 'edit') return;
    const result = undoEdit(undo.editId, undo.card);
    // Not put back (for example studied since): the Undo is used up, the message stays.
    setLastLeave(undo.card && result.reverted > 0 ? null : { text: lastLeave.text });
  };

  /**
   * "Finish session" in "All done here": bank the rated cards and show
   * Complete; "Back" when nothing was rated. Once only (a double tap, or
   * Back during the fade to Complete): finish() and exitNow() check
   * committedRef. The message stays on screen while the screen fades out;
   * its Undo goes.
   */
  const leaveAllDone = () => {
    if (committedRef.current) return;
    setLastLeave(lastLeave ? { text: lastLeave.text } : null);
    if (run.idx > 0) finish(run, run.idx);
    else exitNow(); // nothing rated: nothing to bank, only go back
  };

  // Android's hardware Back (H1, sessionLogic backPressAction). A sheet that
  // is open handles Back itself (its Modal), so this runs only on the session.
  // The session stays mounted under the card editor, and Android asks this
  // listener BEFORE the navigator's own one: so it must check that the
  // session is the focused screen ('pass' when not), else the editor's Back
  // opened "End this session?" over the editor (review round 1).
  // The listener is NOT wrapped by the app-wide keyboard guard
  // (addKeyboardAwareBackListener): the session runs the same rule itself,
  // with its focus check, and tells the guard what it did (K1-1).
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      // Only the session's own keyboard (not the card editor's on top of it),
      // and not a hide the session asked for itself (sessionLogic keyboardHideOpensGrace).
      const focused = navigation.isFocused();
      const opens = keyboardHideOpensGrace({ focused, msSinceSelfDismiss: msSince(selfDismissAt.current) });
      // The NEWEST hide decides: a window of an older hide never stays open after it.
      keyboardHidAt.current = opens ? steadyTime() : null;
      // A close the session asked for explains ONE hide only: the next hide is timed again.
      if (focused) selfDismissAt.current = null;
    });
    return () => sub.remove();
  }, [navigation]);
  useEffect(() => {
    const sub = addKeyboardAwareBackListener(BackHandler, () => {
      const keyboardVisible = Keyboard.isVisible();
      const action = backPressAction({
        focused: navigation.isFocused(),
        committed: committedRef.current,
        keyboardVisible,
        msSinceKeyboardHid: msSince(keyboardHidAt.current),
        rated: run.idx,
        allDone: sessionScreen(run) === 'allDone',
      });
      switch (action) {
        case 'pass':
          // Not the session's Back (another screen is on top, or it is banked): the navigator handles it.
          return false;
        case 'keyboard':
          // Only the keyboard closes: the typed answer and the session stay.
          // When it is still open, the session closes it itself: that hide
          // never swallows the NEXT Back press (keyboardHideOpensGrace).
          // When it closed by itself (the grace window), this press was the
          // one that closed it: the window is used up, so the NEXT press is a
          // real Back (wave 5c: two quick presses swallowed both).
          if (keyboardVisible) selfDismissAt.current = steadyTime();
          else keyboardHidAt.current = null;
          // The same for the app-wide guard: the navigator under the session must not take this press again.
          markKeyboardBackPress(keyboardVisible);
          Keyboard.dismiss();
          return true;
        case 'allDone':
          leaveAllDone();
          return true;
        case 'confirm':
          setConfirmExit(true);
          return true;
        case 'leave':
          // Nothing was rated: the navigator goes back (beforeRemove has nothing to bank).
          return false;
      }
    });
    return () => sub.remove();
  });

  // After the card editor: drop the cards whose note was deleted there, and
  // plan the cards still to come again with the new text (spec §6.5).
  useEffect(() => {
    return navigation.addListener('focus', () => {
      // Banked already: nothing to plan, and never a second finish().
      if (committedRef.current) return;
      // No card on screen ("All done here", or a session that opened empty):
      // nothing to plan; "All done here" waits for the learner's choice (M1).
      // (A deleted card that came back meanwhile is put back by render,
      // `comeBack`: the session renders on every store change, focused or not.)
      if (sessionScreen(run) !== 'card') return;
      const state = engine.store.getState();
      const { cardById: byId } = cardLookupOf(state.cards);
      const dropped = dropMissing(run, (id) => byId.has(id));
      const next = replanRun(dropped.next, state, planLibRef.current, mode, start.kind, start.dayKey);
      const { notes, noteTypes } = state;
      planLibRef.current = { notes, noteTypes };
      if (next === run) return;
      setRun(next);
      // The queue cards it took out are kept: when the editor's Undo brings
      // the note back, they are put back (`comeBack` above, wave 5c).
      if (dropped.dropped > 0) setDeleted((d) => [...d, ...remainingCards(run).filter((q) => !byId.has(q.id))]);
      if (isExhausted(next)) {
        // The LAST card's note was deleted (only a deleted card empties the
        // queue here): "All done here", the same as a last card that left by
        // Suspend (M1). Nothing is banked yet ("Finish session", Back or
        // beforeRemove do that), and NO show(): the card editor's GLOBAL
        // "“Wort” deleted · Undo" is on screen, and a new message would
        // replace it and take its Undo away (review round 2).
        setSnack(null);
        setLastLeave({ text: CARD_DELETED_COPY });
        return;
      }
      if (dropped.dropped > 0) setSnack({ text: CARD_DELETED_COPY });
    });
  });

  /* ——— answering ——— */

  /**
   * Record the answer of the card on screen, once. Two guards, because two
   * taps can arrive before React draws again (two fingers, Enter + "Check"):
   *   - `answeredRef` remembers the answer state this render already
   *     answered, so the second tap of the same frame is ignored at once (no
   *     second haptic);
   *   - `answerRun` runs INSIDE the state update and keeps the first answer,
   *     so the state can never take the second one (the first tap decides).
   */
  const answer = (given: Answer) => {
    if (!card || ui.revealed || answeredRef.current === ui) return;
    answeredRef.current = ui;
    haptics('tick', settings.hapticsEnabled);
    const at = pressTime();
    setRun((r) => answerRun(r, cardKey, given, at));
  };

  const reveal = (hintStep?: number) => answer(hintStep !== undefined ? { kind: 'reveal', hintStep } : { kind: 'reveal' });

  const checkTyping = (typed: string) => {
    if (!plan.typing) return;
    // TypingAnswer has just closed the keyboard: that hide is not a Back press
    // (keyboardHideOpensGrace). Keyboard.isVisible() stays true until the hide
    // event, so it says whether a hide will come (none when it was closed already).
    if (Keyboard.isVisible()) selfDismissAt.current = steadyTime();
    // The app-wide guard too (K1-1): its window must not take the next Back press either.
    // (TypingAnswer's Keyboard.dismiss() already told it, through the guard's
    // wrapper; marking twice changes nothing, and this stays right if the
    // keyboard is ever closed another way.)
    markAppClosesKeyboard();
    answer({ kind: 'check', result: checkTyped(typed, plan.typing) });
  };

  const pickChoice = (index: number) => {
    if (!plan.quiz) return;
    answer({ kind: 'pick', index });
  };

  const pickArticle = (choice: GermanArticle) => {
    if (!article) return;
    answer({ kind: 'article', choice });
  };

  const onHint = () => {
    if (!hintSource || ui.revealed) return;
    const next = nextHint(hintSource, ui.hintStep);
    // The last tap shows the answer; a used hint is never a fast answer and outlines Hard.
    if (next.reveal) reveal(Math.max(ui.hintStep, 1));
    else setRun((r) => patchUi(r, { hintStep: next.step }));
  };

  /* ——— rating ——— */

  const rate = (rating: Rating) => {
    if (!card || !face || !ui.revealed) return;
    if (ratingLock.current) return; // ignore a second tap before the next card mounts
    // Banked already (the screen is on its way out): a rating now would save a
    // new in-flight marker, and the next boot would bank those reviews AGAIN (M5).
    if (committedRef.current) return;
    ratingLock.current = true;
    const at = pressTime();
    const rated = actions.rateCard(card.id, rating, {
      kind: start.kind,
      ...(ui.revealedAt > 0 ? { durationMs: at - ui.revealedAt } : {}),
    });
    if (!rated) {
      // The card is gone (its note was deleted): it leaves the session, nothing is counted.
      // When its note comes back (an Undo), it is put back (`comeBack`).
      ratingLock.current = false;
      setDeleted((d) => [...d, ...remainingCards(run).filter((q) => q.id === card.id)]);
      leaveSession(card.id, { text: CARD_DELETED_COPY });
      return;
    }
    haptics(rating === 'again' ? 'again' : 'rate', settings.hapticsEnabled);
    const outcome = rateRun(run, { rating, rated, wrote: writes, now: at });
    if (outcome.milestone) setMilestone(outcome.milestone);
    setSnack({ text: rateSnack(rating, pred ? pred[rating] : null, cardName(face)), undo: { type: 'rating' } });
    setRun(outcome.next);
    if (outcome.finished) {
      // The rated card is the true end state for the mastery achievements (M6). Practice changed nothing.
      finish(outcome.next, outcome.reviewed, writes ? rated : undefined);
      return;
    }
    // Save the progress so far, so an app kill does not drop its XP / streak / record (M5).
    actions.trackSession(markerOf(outcome.next, meta(), outcome.reviewed));
  };

  const undo = () => {
    if (committedRef.current) return; // banked: its reviews are in the session record now
    const state = engine.store.getState();
    const out = undoRun(run, blockedIn(cardLookupOf(state.cards).cardById, run.left, pressTime()));
    if (!out) return;
    if (out.snapshot.wrote) actions.undoLastReview();
    setRun(out.next);
    // Keep the crash-recovery marker in step, so the boot reconcile can never bank undone reviews.
    actions.trackSession(out.next.idx === 0 ? null : markerOf(out.next, meta(), out.next.idx));
    setSnack({ text: UNDONE_COPY });
  };

  /* ——— More ——— */

  const choose = (pending: Pending) => {
    pendingRef.current = pending;
    setSheet(null);
  };

  /** The More sheet has slid out: now open what was chosen (never two native modals animating at once). */
  const afterMoreClosed = () => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    if (pending === 'edit') {
      if (card) router.push({ pathname: '/card-editor', params: { noteId: card.noteId } });
      return;
    }
    setSheet(pending);
  };

  // A ManualEdit like Suspend: its Undo un-buries the card and puts it back (it had no Undo).
  const bury = () => {
    setSheet(null);
    if (!card || !face) return;
    const editId = actions.bury([card.id]);
    const undoable = isUndoableEdit(engine.store.getState().manualLog, editId);
    leaveSession(card.id, {
      text: `${cardName(face)} buried until tomorrow`,
      undo: undoable ? { type: 'edit', editId, card } : undefined,
    });
  };

  const toggleFlag = () => {
    setSheet(null);
    if (!card || !face || !live) return;
    const on = !live.flagged;
    const editId = actions.setFlags([card.id], { flagged: on });
    const undoable = isUndoableEdit(engine.store.getState().manualLog, editId);
    setSnack({
      text: `${cardName(face)} ${on ? 'flagged' : 'unflagged'}`,
      undo: undoable ? { type: 'edit', editId } : undefined,
    });
  };

  const suspend = () => {
    setSheet(null);
    if (!card) return;
    const editId = actions.setFlags([card.id], { suspended: true });
    const undoable = isUndoableEdit(engine.store.getState().manualLog, editId);
    leaveSession(card.id, { text: 'Suspended', undo: undoable ? { type: 'edit', editId, card } : undefined });
  };

  const onRescheduled = ({ editId, dueMs }: { editId: string; dueMs: number }) => {
    if (!card) return;
    const undoable = isUndoableEdit(engine.store.getState().manualLog, editId);
    leaveSession(card.id, {
      text: rescheduleSnack(dueMs, pressTime()),
      undo: undoable ? { type: 'edit', editId, card } : undefined,
    });
  };

  /** Switch mode: the cards still to come get plans in the new mode (this session only). */
  const switchTo = (next: StudyMode) => {
    const plans = plansFor(remainingCards(run), next, start.kind, start.dayKey, engine.store.getState());
    setMode(next);
    setRun(switchModeRun(run, plans));
  };

  const snackAction = (u: SnackUndo) => {
    setSnack(null);
    if (u.type === 'rating') undo();
    else undoEdit(u.editId, u.card);
  };

  /* ——— the last card left: "All done here", its Undo stays on screen (M1) ——— */
  if (sessionScreen(run) === 'allDone') {
    const undoable = lastLeave?.undo?.type === 'edit';
    return (
      <View style={{ flex: 1, backgroundColor: c.paper }}>
        <AllDoneHere
          message={lastLeave?.text ?? ''}
          rated={run.idx}
          onUndo={undoable ? undoLastLeave : undefined}
          onFinish={leaveAllDone}
        />
        {snack ? <SnackbarView text={snack.text} bottom={insets.bottom + 24} /> : null}
        <SnackbarHost aboveTabBar={false} />
      </View>
    );
  }

  /* ——— empty queue ——— */
  if (!card || !face) {
    return (
      <EmptyQueue
        q={start.scope}
        kind={start.kind}
        expired={start.expired}
        onBack={() => router.back()}
        onStart={(kind) => {
          // Only a label that names the scope is carried ("German", "German · Level: B1"); a
          // practice or a selection label ("Your hardest cards", "Missed cards") is not: then
          // the new session names itself.
          const selection = start.params !== null && 'sel' in start.params;
          const label = followUpLabel({ kind: start.kind, label: start.label, scope: start.scope, selection });
          router.replace(sessionHref({ kind, q: start.scope, label }) as Href);
        }}
      />
    );
  }

  const showHint = showHintButton(settings.hintsEnabled, plan, ui);
  const hint = hintSource ? shownHint(hintSource, ui.hintStep) : null;
  const right = articleRight(plan, ui);
  const maxCard = areaHeight > 0 ? Math.max(200, areaHeight - 34) : undefined;
  // The Articles chip stays while the session IS in Articles or STARTED in it (also with fewer than 4 nouns left).
  const articleOffer =
    sheet === 'mode' &&
    articleChipShown(start.kind, mode, articleCards(remainingCards(run), faceOf, 0).length, start.mode);

  const questionExtra = (
    <>
      {plan.fallback ? (
        <Text style={[font('sans', 400, true), { fontSize: 12.5, color: c.ink3, marginTop: 14, textAlign: 'center' }]}>
          {FALLBACK_COPY[plan.fallback]}
        </Text>
      ) : null}
      {plan.mode === 'type' && plan.typing ? <TypingAnswer result={null} onCheck={checkTyping} /> : null}
      {plan.mode === 'mc' && plan.quiz ? <QuizChoices quiz={plan.quiz} pick={ui.pick} onPick={pickChoice} /> : null}
      <HintText hint={hint} />
    </>
  );
  const answerExtra = (
    <>
      {plan.mode === 'type' && ui.check ? (
        <TypingAnswer result={ui.check} onCheck={checkTyping} focusRef={typedFocus} />
      ) : null}
      {plan.mode === 'mc' && plan.quiz && ui.pick !== null ? (
        <QuizChoices quiz={plan.quiz} pick={ui.pick} onPick={pickChoice} focusRef={pickFocus} />
      ) : null}
    </>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* ——— header ——— */}
      <SessionHeader
        idx={run.idx}
        total={run.queue.length}
        canUndo={run.history.length > 0}
        practice={!writes}
        onClose={() => (run.idx > 0 ? setConfirmExit(true) : exitNow())}
        onUndo={undo}
        onMore={() => setSheet('more')}
      />

      {/* ——— the card ——— */}
      <View
        style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 12 }}
        onLayout={(e) => setAreaHeight(e.nativeEvent.layout.height)}
      >
        {milestone ? <MilestoneToast n={milestone} /> : null}
        <StudyCard
          key={cardKey}
          face={face}
          deckId={card.deckId}
          revealed={ui.revealed}
          step={step}
          requeued={card.requeued}
          hintUsed={ui.hintStep > 0}
          canSpeak={settings.readAloudEnabled}
          genderColors={genderColors}
          onReveal={plan.mode === 'flash' ? () => reveal() : undefined}
          onSpeak={sayNow}
          maxHeight={maxCard}
          promptOverride={
            article ? (
              <Text style={[font('serif', 600), { fontSize: 42, lineHeight: 46, color: c.ink, textAlign: 'center' }]}>
                {article.word}
              </Text>
            ) : undefined
          }
          promptLabel={article ? article.word : undefined}
          questionExtra={questionExtra}
          answerExtra={answerExtra}
          answerExtraFocus={plan.mode === 'mc' ? pickFocus : typedFocus}
          answerOverride={
            article && ui.article ? (
              <ArticleResult question={article} pick={ui.article} genderColors={genderColors} />
            ) : undefined
          }
        />
      </View>

      {/* ——— rating zone (stable height) ——— */}
      <View style={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 26, minHeight: 96 + insets.bottom }}>
        {article ? (
          right === null ? (
            <ArticleButtons onPick={pickArticle} />
          ) : (
            <RiseIn duration={200}>
              <ArticleNext onNext={() => rate(articleRating(right))} />
            </RiseIn>
          )
        ) : ui.revealed ? (
          <RiseIn duration={200}>
            <RatingButtons pred={pred} suggested={suggested} onRate={rate} />
          </RiseIn>
        ) : plan.mode === 'mc' ? (
          <View style={{ height: 62, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>Pick the right answer</Text>
          </View>
        ) : (
          <HintBar showHint={showHint} step={ui.hintStep} onHint={onHint} tapToReveal={plan.mode === 'flash'} />
        )}
      </View>

      {snack ? (
        <SnackbarView
          text={snack.text}
          onAction={snack.undo ? () => snackAction(snack.undo!) : undefined}
          bottom={insets.bottom + 96}
        />
      ) : null}
      {/* The GLOBAL channel (useSnackbar): the card editor's messages as the
          learner comes back ("“Wort” deleted · Undo"), and "Session saved ·
          3 cards · +12 XP" as the session closes early. This full-screen
          modal covers the root host, so it mounts its own (like the editors). */}
      <SnackbarHost aboveTabBar={false} />

      {/* ——— sheets ——— */}
      <CardActionsSheet
        // Never the answer before the reveal: Articles' bare word, a dictation card's "This card".
        title={moreSheetTitle(face, article)}
        flagged={!!live?.flagged}
        canReschedule={live ? canReschedule(live) : false}
        modeLabel={MODE_LABELS[mode]}
        open={sheet === 'more'}
        onClose={() => setSheet(null)}
        onClosed={afterMoreClosed}
        onEdit={() => choose('edit')}
        onReschedule={() => choose('reschedule')}
        onBury={bury}
        onFlag={toggleFlag}
        onSuspend={suspend}
        onSwitchMode={() => choose('mode')}
        onInfo={() => choose('info')}
      />
      <RescheduleSheet
        cardIds={[card.id]}
        open={sheet === 'reschedule'}
        onClose={() => setSheet(null)}
        onDone={onRescheduled}
      />
      <ModeSheet
        open={sheet === 'mode'}
        onClose={() => setSheet(null)}
        current={mode}
        onPickMode={switchTo}
        showArticle={articleOffer}
      />
      {/* Card info: before the reveal it shows the question only, never the answer (wave 5h). */}
      <CardSheet
        cardId={card.id}
        open={sheet === 'info'}
        onClose={() => setSheet(null)}
        readOnly
        hideAnswer={!ui.revealed}
        question={article ? { text: article.word, lang: article.lang } : undefined}
      />
      <ExitConfirmSheet
        open={confirmExit}
        reviewed={run.idx}
        practice={!writes}
        onKeep={() => setConfirmExit(false)}
        onEnd={() => {
          setConfirmExit(false);
          exitNow();
        }}
      />
    </KeyboardAvoidingView>
  );
}
