/**
 * The study session and the Complete screen (spec §6, unit W4-4).
 *
 * Three parts:
 *   1. the PURE rules of src/components/study/sessionLogic.ts: the route,
 *      the queue built once with buildSessionQueue (the "Study N" number IS
 *      the session length), the run state (rate, Again at idx + 3 with the
 *      card rateCard returned, undo snapshots, cards that leave the session),
 *      the suggested rating, hints, the headline size, the copy, and the
 *      Complete screen's "Keep going" rows;
 *   2. whole sessions driven through the REAL reducer (rateCard,
 *      undoLastReview, completeSession): Study, Practice of the missed cards
 *      and Articles — practice changes no schedule, no daily count and no
 *      review log (H3), and the session's `finalCard` is the rated card (M6);
 *   3. read aloud (src/domain/speech.ts) and the session components,
 *      rendered with react-test-renderer: the suggested outline, the More
 *      sheet rows, the card's own badge row, the size of a long answer, a
 *      missing image, typing, quiz and articles;
 *   4. the session SCREEN's wiring (src/app/session.tsx), rendered on an
 *      in-memory store whose actions run the real reducer: Android's Back
 *      under the card editor and just after "Check" (the keyboard's grace
 *      window takes one press only), a session that is banked only once, a
 *      card deleted in the card editor (the LAST one or one in the middle,
 *      and brought back by the editor's Undo, which a later Undo of a
 *      rating keeps), the "All done here" Undo
 *      (Suspend, Reschedule), and the
 *      "Session saved" snackbar of beforeRemove and of ✕ → "End session";
 *      wave 5h: the marker keeps the session's mode (a kill banks it with
 *      it), the Practice exit sheet's own words, Card info with no answer
 *      before the reveal (Articles: the bare word), and the screen-reader
 *      focus target of the typing result and the picked quiz choice.
 *
 * Module mocks (`jest.mock` below):
 *   - expo-speech → records speak() calls; the voice list is set per test;
 *   - ThemeContext → useColors() returns the light palette;
 *   - safe-area-context → zero insets (Sheet);
 *   - @expo/vector-icons → icons render nothing;
 *   - expo-image → a plain element (no native view);
 *   - platform/media → a file uri for every image except 'missing.png';
 *   - for the screen (part 4): expo-router (a router and a navigation whose
 *     focus the test sets, and whose 'focus' / 'beforeRemove' listeners the
 *     test fires), the store hooks (selectors, DataContext,
 *     SnackbarContext) on `mockState`, haptics (nothing), and the two
 *     sheets the screen only mounts closed (CardSheet, RescheduleSheet).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { BackHandler, Keyboard, Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import SessionScreen from '../../app/session';
import { checkTyped } from '../../domain/answerCheck';
import { BUILTIN_TYPE_IDS } from '../../domain/builtinTypes';
import { facesFor, speechOf } from '../../domain/face';
import { levelInfo, levelNames, xpForLevel } from '../../domain/gamification';
import { life } from '../../domain/life';
import type { Card, CardFace, DataStateV3, FieldBlock, Note } from '../../domain/model';
import { articleCards, type CardPlan, planCard } from '../../domain/modes';
import { fieldRecord } from '../../domain/query';
import { buildSessionQueue, decksById, libraryIndexOf, matchCtxOf, readyFor, scopePool } from '../../domain/scope';
import {
  hasVoiceFor,
  missingVoiceMessage,
  missingVoiceNotice,
  resetVoiceNoticesForTests,
  speak,
  speechOptions,
  SPEECH_RATE,
} from '../../domain/speech';
import { formatDelay, predictAll } from '../../domain/srs';
import { DAY, dayKeyOf, MIN, type Rating } from '../../domain/types';
import * as keyboardBack from '../../platform/keyboardBack';
import {
  bury,
  completeSession,
  deleteNotes,
  rateCard,
  reconcileOnBoot,
  reschedule,
  setFlags,
  trackSession,
  undoDelete,
  undoLastReview,
  undoManualEdit,
} from '../../store/reducer';
import { SNACK_ACTION_MS } from '../../store/SnackbarContext';
import { FIXED_NOW } from '../../test/clock';
import { lifeValues, makeDeckV3, makeSettingsV3, noteWithCards, stateOfV3, testCtx } from '../../test/factoriesV3';
import { light } from '../../theme/tokens';
import { triageLookupOf } from '../deck/deckPageLogic';
import { triageItems } from '../deck/triageLogic';
import { practiceQueryRoute } from '../library/libraryState';
import { NOT_STARTED_SCOPE, PRACTICE_SCOPE } from '../today/todayLogic';
import { CardSheet } from '../sheets/CardSheet';
import { SnackbarHost, SnackbarView } from '../ui';
import { ArticleButtons, ArticleResult } from './ArticleQuiz';
import { CARD_ACTIONS_COPY, CardActionsSheet } from './CardActionsSheet';
import { AllDoneHere } from './EmptyQueue';
import { ExitConfirmSheet } from './ExitConfirmSheet';
import { HintBar } from './HintBar';
import { ModeSheet } from './ModeSheet';
import { QuizChoices } from './QuizChoices';
import { RatingButtons } from './RatingButtons';
import { NOTHING_TO_RESCHEDULE, rescheduleSnack } from './rescheduleLogic';
import { RescheduleSheet } from './RescheduleSheet';
import { SessionHeader } from './SessionHeader';
import {
  ALL_DONE_COPY,
  answerQuestionLine,
  answerRun,
  articleChipShown,
  articleQueue,
  articleRating,
  articleRight,
  asSentence,
  backPressAction,
  blockedIn,
  blockHasImage,
  cardA11yLabel,
  cardName,
  moreSheetTitle,
  sessionStepLabel,
  completeHref,
  completeLevelLine,
  currentCard,
  currentPlan,
  currentUi,
  dropMissing,
  earlyExitSnack,
  earlyExitSnackDelay,
  emptyQueueActions,
  emptyQueueLine,
  exitSavedLine,
  FALLBACK_COPY,
  faceOfState,
  followUpLabel,
  freshUi,
  HARDEST_LABEL,
  HARDEST_SORT,
  hardestParams,
  headlineLineLabel,
  headlineSize,
  hintButtonLabel,
  hintSourceFor,
  initialRun,
  intervalWords,
  isExhausted,
  isFastAnswer,
  keepGoingCounts,
  keepGoingScopes,
  keepGoingRows,
  KEYBOARD_BACK_GRACE_MS,
  keyboardHideOpensGrace,
  KNOWN_INTERVAL,
  leaveOutcome,
  markerOf,
  MISSED_LABEL,
  missedLine,
  nextHint,
  NO_SCHEDULE_CHANGE,
  parseCompleteParams,
  parseKind,
  parseSessionRoute,
  parseSortParam,
  patchUi,
  plansFor,
  rateRun,
  rateSnack,
  ratingA11yLabel,
  ratingPredictions,
  remainingCards,
  removeFromRun,
  replanRun,
  requeueIndex,
  restoreDeleted,
  restoreToRun,
  routeKey,
  routeWrites,
  type RunState,
  SAVED_AFTER_UNDO_GAP_MS,
  selectionLabel,
  SELF_DISMISS_MS,
  sessionHref,
  sessionLabel,
  sessionModeOf,
  type SessionRoute,
  sessionScreen,
  shownHint,
  showHintButton,
  startSession,
  suggestedRating,
  switchModeRun,
  uiKey,
  undoRun,
  verdictText,
  withinMs,
} from './sessionLogic';
import { HEADLINE_STYLES, StudyCard } from './StudyCard';
import { diffPieceStyle, TypingAnswer, typedAnswerLabel } from './TypingAnswer';

/* ================================================================ mocks */

const mockSpeak = jest.fn<(text: string, options?: { language?: string; rate?: number }) => void>();
let mockVoices: { language: string }[] = [];
jest.mock('expo-speech', () => ({
  speak: (text: string, options?: { language?: string; rate?: number }) => mockSpeak(text, options),
  stop: () => Promise.resolve(),
  getAvailableVoicesAsync: () => Promise.resolve(mockVoices),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image', () => ({
  Image: function Image(props: Record<string, unknown>) {
    return jest.requireActual<typeof import('react')>('react').createElement('ExpoImage', props);
  },
}));
jest.mock('../../platform/media', () => ({
  mediaFileUri: (deckId: string, name: string) => (name === 'missing.png' ? null : `file:///media/${deckId}/${name}`),
}));

/* The session screen (part 4). Every factory reads its `mock…` value only
   when the screen calls it (jest.mock runs before the values below exist). */

/** The in-memory store of the screen tests: every action runs the real reducer on it. */
let mockState: DataStateV3 = stateOfV3({ decks: [] });
let mockParams: Record<string, string> = {};
/** Is the session the focused screen? false = the card editor is pushed on top of it. */
let mockFocused = true;
// Its own name: the face guard (face.test.ts) flags a read of the router's back property in src/components.
const mockGoBack = jest.fn<() => void>();
const mockRouter = {
  push: jest.fn<(href: unknown) => void>(),
  replace: jest.fn<(href: unknown) => void>(),
  back: mockGoBack,
  canGoBack: () => true,
};
/** The navigation listeners the screen added ('focus', 'beforeRemove'); the screen tests fire them. */
let mockNavListeners: { name: string; listener: () => void }[] = [];
const mockNavigation = {
  isFocused: () => mockFocused,
  addListener: (name: string, listener: () => void) => {
    const entry = { name, listener };
    mockNavListeners.push(entry);
    return () => {
      mockNavListeners = mockNavListeners.filter((e) => e !== entry);
    };
  },
};
const mockShow = jest.fn<(text: string) => void>();
/** The GLOBAL message on screen (useSnackbar().snack), e.g. the card editor's "“Wort 1” deleted · Undo". */
let mockGlobalSnack: { text: string; actionLabel?: string; onAction?: () => void } | null = null;

/** Run one reducer command on mockState (at the test clock); returns its result. */
function mockRun<I, R>(command: (s: DataStateV3, input: I, ctx: ReturnType<typeof testCtx>) => { state: DataStateV3; result: R }, input: I): R {
  const step = command(mockState, input, testCtx(FIXED_NOW));
  mockState = step.state;
  return step.result;
}

/** The session's actions (src/store/engine.ts), on mockState with the real reducer. */
const mockActions = {
  rateCard: jest.fn((cardId: string, rating: Rating, opts?: { kind?: Parameters<typeof rateCard>[1]['kind']; durationMs?: number }) =>
    mockRun(rateCard, { cardId, rating, kind: opts?.kind, durationMs: opts?.durationMs }),
  ),
  undoLastReview: jest.fn(() => mockRun(undoLastReview, undefined)),
  completeSession: jest.fn((args: Parameters<typeof completeSession>[1]) => mockRun(completeSession, args)),
  clearLastCompletion: jest.fn(),
  trackSession: jest.fn((snapshot: Parameters<typeof trackSession>[1]['snapshot']) => mockRun(trackSession, { snapshot })),
  bury: jest.fn((cardIds: string[]) => mockRun(bury, { cardIds }).edit.id),
  setFlags: jest.fn((cardIds: string[], patch: Parameters<typeof setFlags>[1]['patch']) => mockRun(setFlags, { cardIds, patch }).edit.id),
  undoManualEdit: jest.fn((editId: string) => mockRun(undoManualEdit, { editId })),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useNavigation: () => mockNavigation,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../store/selectors', () => ({
  ...jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors'),
  useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(mockState),
  useEngine: () => ({ store: { getState: () => mockState }, actions: mockActions }),
}));
jest.mock('../../store/DataContext', () => ({ useData: () => ({ actions: mockActions }) }));
jest.mock('../../store/SnackbarContext', () => ({
  ...jest.requireActual<typeof import('../../store/SnackbarContext')>('../../store/SnackbarContext'),
  useSnackbar: () => ({ show: mockShow, snack: mockGlobalSnack, dismiss: () => undefined }),
}));
jest.mock('../../platform/haptics', () => ({ haptics: () => undefined }));
// Mounted closed by the screen; their own tests live with them.
jest.mock('../sheets/CardSheet', () => ({ CardSheet: () => null }));
jest.mock('./RescheduleSheet', () => ({ RescheduleSheet: () => null }));

/* ================================================================ fixtures */

const NOW = FIXED_NOW;
const DAY_KEY = dayKeyOf(NOW);
const LEGACY_DE = BUILTIN_TYPE_IDS.legacyVocabDe;

/** A German word note in deck d1 (legacy type: 0 Word · 1 Translation · 5 Level · 6 Type). */
function deWord(de: string, en: string, card: Partial<Card> = {}, id?: string) {
  return noteWithCards({
    deckId: 'd1',
    typeId: LEGACY_DE,
    fields: [de, en, '', '', '', 'A1', 'noun', '', '', ''],
    note: id ? { id } : {},
    card,
  });
}

/** Due now (a review card due a minute ago). */
const dueReview = (): Partial<Card> => ({ ...lifeValues('review', NOW), due: NOW - MIN });
/** Learning, due now. */
const dueLearning = (): Partial<Card> => ({ ...lifeValues('learning', NOW), due: NOW - MIN });

/** A German deck: 2 due reviews, 1 due learning card, 6 new nouns, 1 not started. */
function germanState(settings: Parameters<typeof makeSettingsV3>[0] = {}): DataStateV3 {
  const groups = [
    deWord('die Stunde', 'the hour', dueReview(), 'n-stunde'),
    deWord('der Tag', 'the day', dueReview(), 'n-tag'),
    deWord('die Woche', 'the week', dueLearning(), 'n-woche'),
    deWord('das Jahr', 'the year', {}, 'n-jahr'),
    deWord('die Minute', 'the minute', {}, 'n-minute'),
    deWord('der Monat', 'the month', {}, 'n-monat'),
    deWord('das Haus', 'the house', {}, 'n-haus'),
    deWord('die Abfahrt', 'the departure', {}, 'n-abfahrt'),
    deWord('gehen', 'to go', {}, 'n-gehen'),
    deWord('der Hund', 'the dog', lifeValues('notStarted', NOW), 'n-hund'),
  ];
  return stateOfV3({
    decks: [makeDeckV3({ id: 'd1', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' })],
    groups,
    overrides: { settings: makeSettingsV3({ sessionLimit: 0, ...settings }) },
  });
}

const ctxOf = (state: DataStateV3, now = NOW) => matchCtxOf(state, now);

/** A route with defaults. */
function route(over: Partial<SessionRoute> = {}): SessionRoute {
  return { kind: 'scheduled', q: {}, sel: null, mode: 'flash', sort: null, label: null, ...over };
}

/** Start a session on a state. */
function start(state: DataStateV3, over: Partial<SessionRoute> = {}, selIds: string[] | null = null) {
  return startSession(route(over), state, ctxOf(state), DAY_KEY, selIds);
}

/** A field block for synthetic faces. */
function block(over: Partial<FieldBlock> & Pick<FieldBlock, 'plain'>): FieldBlock {
  return {
    field: 0,
    label: 'Front',
    role: 'term',
    lines: over.plain === '' ? [] : [[{ t: 'text', text: over.plain }]],
    ...over,
  };
}

/** A synthetic face. */
function face(prompt: FieldBlock[], answer: FieldBlock[], badges: FieldBlock[] = []): CardFace {
  return {
    promptPlain: prompt[0]?.plain ?? '',
    answerPlain: answer[0]?.plain ?? '',
    badges,
    prompt,
    answer,
  };
}

/* ================================================================ 1. route */

describe('route: /session?kind=&q=&sel=&mode=&sort=&label=', () => {
  it('defaults to Study over every deck, the Settings mode, the pool order', () => {
    expect(parseSessionRoute({})).toEqual({ kind: 'scheduled', q: {}, sel: null, mode: null, sort: null, label: null });
  });

  it('reads every param, and a broken one never crashes', () => {
    const r = parseSessionRoute({
      kind: 'practice',
      q: JSON.stringify({ decks: ['d1'] }),
      mode: 'mc',
      sort: '{"by":"field","field":"level","dir":"desc"}',
      label: '  German · Level B1 ',
    });
    expect(r).toEqual({
      kind: 'practice',
      q: { decks: ['d1'] },
      sel: null,
      mode: 'mc',
      sort: { by: 'field', field: 'level', dir: 'desc' },
      label: 'German · Level B1',
    });
    expect(parseSessionRoute({ q: 'not json', mode: 'quiz', sort: '{broken' })).toMatchObject({ q: {}, mode: null, sort: null });
    expect(parseSessionRoute({ kind: ['ahead', 'practice'] }).kind).toBe('ahead');
  });

  it('a selection is always Practice, and has no query', () => {
    const r = parseSessionRoute({ kind: 'scheduled', sel: 'sel-abc', q: '{"decks":["d1"]}' });
    expect(r).toMatchObject({ kind: 'practice', sel: 'sel-abc', q: {} });
  });

  // W5-5a: the v2 screens that sent deckId / collectionId / cardIds and the
  // kinds cram / hardest / deck / collection are deleted; nothing sends them.
  // That legacy path is gone: only the current route format is read.
  it('only the current kinds; the old v2 params and kinds are not read any more', () => {
    expect(parseKind('scheduled')).toBe('scheduled');
    expect(parseKind('ahead')).toBe('ahead');
    expect(parseKind('practice')).toBe('practice');
    for (const old of ['cram', 'hardest', 'deck', 'collection', undefined, 'nonsense']) expect(parseKind(old)).toBe('scheduled');
    // "Practice your hardest" is kind=practice + sort=hardest.
    expect(parseSessionRoute({ kind: 'practice', sort: 'hardest' })).toMatchObject({ kind: 'practice', sort: HARDEST_SORT });
    // The old params are ignored: no deck chip, no collection, no card ids in the route.
    const old = parseSessionRoute({ kind: 'scheduled', deckId: 'd1', collectionId: 'hard', cardIds: 'a,b' });
    expect(old).toEqual({ kind: 'scheduled', q: {}, sel: null, mode: null, sort: null, label: null });
    // So they never make a different session either.
    expect(routeKey({ kind: 'ahead', deckId: 'd1' })).toBe(routeKey({ kind: 'ahead' }));
    expect(routeKey({ cardIds: 'a' })).toBe(routeKey({ cardIds: 'b' }));
  });

  it('sort: JSON or a bare word; an unknown or incomplete sort is the pool order', () => {
    expect(parseSortParam('hardest')).toEqual({ by: 'hardest' });
    expect(parseSortParam('{"by":"az","dir":"desc"}')).toEqual({ by: 'az', dir: 'desc' });
    expect(parseSortParam('{"by":"field"}')).toBeNull(); // a field sort needs its field
    expect(parseSortParam('random')).toBeNull();
    expect(parseSortParam(undefined)).toBeNull();
  });

  it('sessionHref → parseSessionRoute gives the same session back', () => {
    const r: SessionRoute = { kind: 'ahead', q: { decks: ['d1'] }, sel: null, mode: 'type', sort: null, label: 'German' };
    const href = sessionHref(r);
    expect(href.pathname).toBe('/session');
    expect(parseSessionRoute(href.params)).toEqual(r);
    // Only the params that say something.
    expect(sessionHref({ kind: 'scheduled', q: {} }).params).toEqual({ kind: 'scheduled' });
    expect(sessionHref({ kind: 'practice', sel: 'sel-1', q: { decks: ['x'] } }).params).toEqual({ kind: 'practice', sel: 'sel-1' });
  });

  it('routeKey changes when the session params change (a new session), not for other params', () => {
    expect(routeKey({ kind: 'ahead', q: '{}' })).not.toBe(routeKey({ kind: 'practice', q: '{}' }));
    expect(routeKey({ kind: 'ahead', other: 'x' })).toBe(routeKey({ kind: 'ahead' }));
  });

  it('the Complete href carries the scope and the missed token, never card ids', () => {
    const href = completeHref({ decks: ['d1'] }, 'sel-9');
    expect(href).toEqual({ pathname: '/complete', params: { q: '{"decks":["d1"]}', missed: 'sel-9' } });
    expect(completeHref({}, null).params).toEqual({});
    expect(parseCompleteParams(href.params)).toEqual({ scope: { decks: ['d1'] }, missed: 'sel-9' });
  });
});

/* ================================================================ 2. start */

describe('start: the queue is built once, with the same function as every Study button', () => {
  it('launch count === queue length (readyFor total) for every daily-limit and session-size mix', () => {
    for (const dailyNewLimit of [0, 2, 10]) {
      for (const sessionLimit of [0, 3, 50]) {
        const state = germanState({ sessionLimit, srs: { dailyNewLimit } });
        const ready = readyFor(state, {}, ctxOf(state));
        expect(start(state).queue).toHaveLength(ready.total);
        const deckReady = readyFor(state, { decks: ['d1'] }, ctxOf(state));
        expect(start(state, { q: { decks: ['d1'] } }).queue).toHaveLength(deckReady.total);
      }
    }
  });

  it('Study: learning and due reviews first, then the new cards; a Not started card never', () => {
    const s = start(germanState());
    const lifes = s.queue.map((c) => life(c));
    expect(lifes.slice(0, 3).sort()).toEqual(['learning', 'review', 'review']);
    expect(lifes.slice(3).every((k) => k === 'new')).toBe(true);
    expect(s.queue.some((c) => c.noteId === 'n-hund')).toBe(false);
  });

  it('every kind is cut by the session size (M7)', () => {
    const state = germanState({ sessionLimit: 2 });
    expect(start(state).queue).toHaveLength(2);
    expect(start(state, { kind: 'practice' }).queue).toHaveLength(2);
  });

  it('Study ahead: reviews that are not due yet, soonest first', () => {
    const state = germanState();
    const later = deWord('der Abend', 'the evening', { ...lifeValues('review', NOW), due: NOW + 2 * DAY });
    const soon = deWord('die Nacht', 'the night', { ...lifeValues('review', NOW), due: NOW + DAY });
    // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes in src/components.
    const { notes: allNotes, cards: allCards } = state;
    const withAhead = {
      ...state,
      notes: allNotes.concat(later.note, soon.note),
      cards: allCards.concat(later.cards, soon.cards),
    };
    expect(start(withAhead, { kind: 'ahead' }).queue.map((c) => c.noteId)).toEqual([soon.note.id, later.note.id]);
  });

  it('a selection: its cards in the miss order, removed cards skipped; an unknown token is "no longer available"', () => {
    const state = germanState();
    const [a, b, c] = state.cards;
    const suspended = { ...state, cards: state.cards.map((x) => (x.id === b.id ? { ...x, suspended: true } : x)) };
    const s = start(suspended, { kind: 'practice', sel: 'sel-1' }, [c.id, b.id, a.id]);
    expect(s.expired).toBe(false);
    expect(s.queue.map((x) => x.id)).toEqual([c.id, a.id]);
    expect(s.scope).toEqual({});
    const gone = start(state, { kind: 'practice', sel: 'sel-old' }, null);
    expect(gone).toMatchObject({ expired: true, params: null, queue: [] });
  });

  it('Articles: German nouns only, one card per item, cut by the session size; Study never runs in Articles', () => {
    const state = germanState({ sessionLimit: 4 });
    const s = start(state, { kind: 'practice', mode: 'article' });
    expect(s.mode).toBe('article');
    expect(s.queue).toHaveLength(4);
    expect(s.queue.every((c) => c.noteId !== 'n-gehen')).toBe(true); // a verb has no der/die/das
    expect(s.queue.every((c) => s.plans.get(c.id)?.mode === 'article')).toBe(true);
    // The same function the deck page counts with.
    const params = { kind: 'practice' as const, q: {} };
    expect(articleQueue(params, state, ctxOf(state), faceOfState(state)).map((c) => c.id)).toEqual(s.queue.map((c) => c.id));
    // A Study session asks for Articles → the Settings mode instead.
    expect(sessionModeOf('scheduled', 'article', 'mc')).toBe('mc');
    expect(sessionModeOf('practice', 'article', 'mc')).toBe('article');
    expect(sessionModeOf('scheduled', null, 'type')).toBe('type');
  });

  it('the per-card plans are fixed at the start and deterministic (same card, same day → same quiz)', () => {
    const state = germanState();
    const a = start(state, { mode: 'mix' });
    const b = start(state, { mode: 'mix' });
    expect([...a.plans.entries()]).toEqual([...b.plans.entries()]);
    for (const card of a.queue) {
      const plan = a.plans.get(card.id)!;
      if (life(card) === 'new') expect(plan.mode).toBe('flash');
      if (life(card) === 'learning') expect(['mc', 'flash']).toContain(plan.mode);
      if (life(card) === 'review') expect(plan.mode).toBe('type');
    }
  });

  it('a list scope studies exactly the list (the built-in "Hard cards"), never every deck', () => {
    const base = germanState();
    // Two cards are Hard (studied, low ease): only they match the built-in "Hard cards" list.
    const hardIds = new Set(base.cards.filter((c) => life(c) === 'review').map((c) => c.id));
    const state = { ...base, cards: base.cards.map((c) => (hardIds.has(c.id) ? { ...c, ease: 1.8 } : c)) };
    const s = startSession(parseSessionRoute({ kind: 'scheduled', q: '{"list":"builtin:hard"}' }), state, ctxOf(state), DAY_KEY, null);
    expect(s.expired).toBe(false);
    expect(new Set(s.queue.map((c) => c.id))).toEqual(hardIds);
    expect(s.scope).toEqual({ list: 'builtin:hard' }); // "Keep going" on Complete uses the same scope
    expect(s.label).toBe('Hard cards');
  });

  it('the label: the route label, else the deck, the list, "All decks", "Selected cards"', () => {
    const state = germanState();
    expect(sessionLabel(route({ label: 'German · A1' }), state)).toBe('German · A1');
    expect(sessionLabel(route({ q: { decks: ['d1'] } }), state)).toBe('German');
    expect(sessionLabel(route({ q: { list: 'builtin:favorites' } }), state)).toBe('Favorites');
    expect(sessionLabel(route(), state)).toBe('All decks');
    expect(sessionLabel(route({ sel: 'sel-1', kind: 'practice' }), state)).toBe('Selected cards');
    expect(sessionLabel(route({ q: { tags: ['travel'] } }), state)).toBe('Filtered cards');
  });

  // Wave 5b (R8): after Today's "Practice" (scope { notFlags: ['paused'] }),
  // Complete's "Study ahead" named its session "Filtered cards".
  it('the label names the real scope: the flags that only hide cards do not make it "Filtered cards"', () => {
    const state = germanState();
    expect(sessionLabel(route({ kind: 'ahead', q: { notFlags: ['paused'] } }), state)).toBe('All decks');
    expect(sessionLabel(route({ q: { notFlags: ['paused', 'suspended', 'buried'] } }), state)).toBe('All decks');
    expect(sessionLabel(route({ q: { decks: ['d1'], notFlags: ['paused'] } }), state)).toBe('German');
    expect(sessionLabel(route({ q: { list: 'builtin:favorites', notFlags: ['suspended'] } }), state)).toBe('Favorites');
    // A flag that really narrows the cards still makes it a filter.
    expect(sessionLabel(route({ q: { notFlags: ['fav'] } }), state)).toBe('Filtered cards');
    expect(sessionLabel(route({ q: { decks: ['d1'], notFlags: ['paused', 'flagged'] } }), state)).toBe('Filtered cards');
    // The whole chain: Today's Practice → Complete → "Study ahead" (no label carried) → "All decks".
    const label = followUpLabel({ kind: 'practice', label: 'Practice', scope: { notFlags: ['paused'] } });
    expect(label).toBeUndefined();
    const ahead = parseSessionRoute(sessionHref({ kind: 'ahead', q: { notFlags: ['paused'] }, label }).params);
    expect(startSession(ahead, state, ctxOf(state), DAY_KEY, null).label).toBe('All decks');
  });

  // Wave 5b (walkthrough L17): "Practice this card" passed the card's text as
  // the label, and Complete showed "SESSION COMPLETE · OVER / ABOUT / ACROSS".
  it('a selection is named by its size: "Practice · 1 card"; "Missed cards" keeps its name', () => {
    const state = germanState();
    const one = state.cards.find((c) => life(c) === 'review')!;
    const s = start(state, { kind: 'practice', sel: 'tok', label: 'over / about / across' }, [one.id]);
    expect(s.queue).toHaveLength(1);
    expect(s.label).toBe('Practice · 1 card');
    const two = state.cards.filter((c) => life(c) === 'review').map((c) => c.id);
    expect(start(state, { kind: 'practice', sel: 'tok', label: '2 selected cards' }, two).label).toBe('Practice · 2 cards');
    expect(start(state, { kind: 'practice', sel: 'tok', label: MISSED_LABEL }, two).label).toBe(MISSED_LABEL);
    expect(selectionLabel(1)).toBe('Practice · 1 card');
    expect(selectionLabel(1200)).toBe('Practice · 1,200 cards');
    // An expired selection never runs; it keeps the route's label (or "Selected cards").
    expect(start(state, { kind: 'practice', sel: 'gone', label: 'x' }, null)).toMatchObject({ expired: true, label: 'x' });
  });

  it('routeWrites: only Practice leaves the schedule alone (H3)', () => {
    expect(routeWrites('scheduled')).toBe(true);
    expect(routeWrites('ahead')).toBe(true);
    expect(routeWrites('practice')).toBe(false);
  });
});

/* ================================================================ 3. run */

/** A run of `n` simple cards (plans = flashcards). */
function simpleRun(n: number): { run: RunState; cards: Card[] } {
  const groups = Array.from({ length: n }, (_, i) => deWord(`Wort ${i}`, `word ${i}`, dueReview(), `n-${i}`));
  const cards = groups.flatMap((g) => g.cards);
  return { run: initialRun(cards, new Map()), cards };
}

/** Reveal the card on screen at `at`. */
const revealed = (run: RunState, at = NOW) => patchUi(run, { revealed: true, revealedAt: at });

describe('run: rating, Again, undo and the marker', () => {
  it('a rating counts, moves on, and pushes one undo snapshot', () => {
    const { run, cards } = simpleRun(3);
    const out = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW + 1000 });
    expect(out.finished).toBe(false);
    expect(out.reviewed).toBe(1);
    expect(out.next.idx).toBe(1);
    expect(out.next.counts).toEqual({ again: 0, hard: 0, good: 1, easy: 0 });
    expect(out.next.run).toBe(1);
    expect(out.next.bestRun).toBe(1);
    expect(out.next.history).toHaveLength(1);
    expect(out.next.history[0]).toMatchObject({ idx: 0, wrote: true, queue: run.queue });
  });

  it('Again re-queues the RETURNED card at idx + 3 (M10), resets the run, and remembers the miss once', () => {
    const { run, cards } = simpleRun(6);
    const ratedCopy = { ...cards[0], stepIndex: 0, lapses: 9 };
    const out = rateRun(revealed(patchUi(run, {})), { rating: 'again', rated: ratedCopy, wrote: true, now: NOW });
    expect(requeueIndex(0, 6)).toBe(3);
    expect(out.next.queue).toHaveLength(7);
    expect(out.next.queue[3]).toEqual({ ...ratedCopy, requeued: true });
    expect(out.next.run).toBe(0);
    expect(out.next.missed).toEqual([cards[0].id]);
    // Missed again later: still once.
    let r = out.next;
    for (let i = 0; i < 2; i++) r = rateRun(revealed(r), { rating: 'good', rated: currentCard(r)!, wrote: true, now: NOW }).next;
    expect(currentCard(r)?.id).toBe(cards[0].id);
    r = rateRun(revealed(r), { rating: 'again', rated: currentCard(r)!, wrote: true, now: NOW }).next;
    expect(r.missed).toEqual([cards[0].id]);
    // Near the end the copy goes last.
    expect(requeueIndex(4, 5)).toBe(5);
  });

  it('the last card finishes the session; Again on the last card does not', () => {
    const { run, cards } = simpleRun(1);
    expect(rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).finished).toBe(true);
    expect(rateRun(revealed(run), { rating: 'again', rated: cards[0], wrote: true, now: NOW }).finished).toBe(false);
  });

  it('fast answers: within 3 s of the reveal and no hint; every 5th correct in a row is a milestone', () => {
    expect(isFastAnswer({ ...freshUi('k'), revealedAt: NOW }, NOW + 2999)).toBe(true);
    expect(isFastAnswer({ ...freshUi('k'), revealedAt: NOW }, NOW + 3000)).toBe(false);
    expect(isFastAnswer({ ...freshUi('k'), revealedAt: NOW, hintStep: 1 }, NOW + 100)).toBe(false);
    expect(isFastAnswer(freshUi('k'), NOW)).toBe(false);
    let { run } = simpleRun(6);
    const milestones: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      const out = rateRun(revealed(run, NOW), { rating: 'good', rated: currentCard(run)!, wrote: true, now: NOW + 500 });
      milestones.push(out.milestone);
      run = out.next;
    }
    expect(milestones).toEqual([null, null, null, null, 5, null]);
    expect(run.fastAnswers).toBe(6); // the 6th rating finished the run and still counted
  });

  it('undo gives back the queue, index, counts, run, bestRun, fastAnswers and misses, and shows the answer again', () => {
    const { run, cards } = simpleRun(4);
    let r = rateRun(revealed(run, NOW), { rating: 'good', rated: cards[0], wrote: true, now: NOW + 100 }).next;
    const before = r;
    r = rateRun(patchUi(r, { revealed: true, revealedAt: NOW, hintStep: 1 }), {
      rating: 'again',
      rated: cards[1],
      wrote: false,
      now: NOW + 100,
    }).next;
    const out = undoRun(r, () => false)!;
    expect(out.snapshot.wrote).toBe(false);
    expect(out.next.queue).toEqual(before.queue);
    expect(out.next).toMatchObject({ idx: 1, counts: before.counts, run: 1, bestRun: 1, fastAnswers: 1, missed: [] });
    expect(currentUi(out.next)).toMatchObject({ revealed: true, hintStep: 1 });
    expect(out.next.history).toHaveLength(1);
    expect(undoRun(initialRun([], new Map()), () => false)).toBeNull();
  });

  it('undo never brings back a card that left the session, but keeps the cards up to the restored one (#6)', () => {
    const { run, cards } = simpleRun(4);
    let r = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    r = removeFromRun(r, cards[2].id); // buried / suspended / rescheduled while card 1 was on screen
    expect(r.left).toEqual([cards[2].id]);
    expect(remainingCards(r).map((c) => c.id)).toEqual([cards[1].id, cards[3].id]);
    const back = undoRun(r, blockedIn(new Map(cards.map((c) => [c.id, c])), r.left, NOW))!;
    expect(back.next.queue.map((c) => c.id)).toEqual([cards[0].id, cards[1].id, cards[3].id]);
    expect(currentCard(back.next)?.id).toBe(cards[0].id);
  });

  it('blockedIn: left, missing, suspended or buried now', () => {
    const [a, b, c, d] = simpleRun(4).cards;
    const byId = new Map([
      [a.id, a],
      [b.id, { ...b, suspended: true }],
      [c.id, { ...c, buriedUntil: NOW + DAY }],
      [d.id, { ...d, buriedUntil: NOW - DAY }],
    ]);
    const blocked = blockedIn(byId, ['left-id'], NOW);
    expect([a.id, b.id, c.id, d.id, 'left-id', 'unknown'].map(blocked)).toEqual([false, true, true, false, true, true]);
  });

  it('a card that leaves the session takes every later copy with it; the snackbar Undo puts it back on screen', () => {
    const { run, cards } = simpleRun(3);
    let r = rateRun(revealed(run), { rating: 'again', rated: cards[0], wrote: true, now: NOW }).next;
    // queue: [c0, c1, c2, c0 (again)] — leaving c0 at idx 1 keeps the rated c0 at 0.
    r = { ...r, idx: 1 };
    const left = removeFromRun(r, cards[0].id);
    expect(left.queue.map((c) => c.id)).toEqual([cards[0].id, cards[1].id, cards[2].id]);
    const restored = restoreToRun(left, cards[1]);
    // c1 is still in the queue: nothing is added, the queue keeps its cards and order.
    expect(restored.queue.map((c) => c.id)).toEqual(left.queue.map((c) => c.id));
    expect(restored.queue).toHaveLength(3);
    const susp = removeFromRun(r, cards[1].id);
    const again = restoreToRun(susp, cards[1]);
    expect(currentCard(again)?.id).toBe(cards[1].id);
    expect(again.left).toEqual([]);
    const last = removeFromRun({ ...initialRun([cards[0]], new Map()) }, cards[0].id);
    expect(isExhausted(last)).toBe(true);
  });

  // Adapted in wave 5b (walkthrough M1): when the LAST card left, the session
  // ended at once ('complete' / 'back') and its message went to the global
  // snackbar, which a late tap then hit on the NEXT screen. Now the session
  // screen stays in "All done here", with the Undo on screen.
  it('leaveOutcome: the message (and its Undo) is never lost, also when the LAST card leaves', () => {
    const { run, cards } = simpleRun(3);
    // A card leaves while others are left: the session goes on, its own snackbar shows the message.
    const first = leaveOutcome(run, cards[0].id);
    expect(first.end).toBe('stay');
    expect(sessionScreen(first.next)).toBe('card');
    // 2 cards rated, the 3rd (the last) is rescheduled / suspended: "All done here", nothing banked yet.
    let r = run;
    for (const card of cards.slice(0, 2)) r = rateRun(revealed(r), { rating: 'good', rated: card, wrote: true, now: NOW }).next;
    const last = leaveOutcome(r, cards[2].id);
    expect(last.end).toBe('done');
    expect(sessionScreen(last.next)).toBe('allDone');
    expect(last.next.idx).toBe(2); // "Finish session" banks the 2 rated cards
    expect(last.next.left).toEqual([cards[2].id]);
    // Its Undo puts the card back on screen: the session goes on with it.
    const back = restoreToRun(last.next, cards[2]);
    expect(sessionScreen(back)).toBe('card');
    expect(currentCard(back)?.id).toBe(cards[2].id);
    // Nothing rated and nothing left: "All done here" too (its button says "Back").
    const only = simpleRun(1);
    const alone = leaveOutcome(only.run, only.cards[0].id);
    expect(alone.end).toBe('done');
    expect(sessionScreen(alone.next)).toBe('allDone');
    expect(alone.next.idx).toBe(0);
  });

  // Review round 1: "All done here" means "the LAST card LEFT", never "a card
  // left earlier and the last one was rated" (that one opens Complete).
  it('sessionScreen: the last card RATED after an earlier leave is never "All done here"', () => {
    const { run, cards } = simpleRun(3);
    let r = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    // Card 2 is buried while others are left: the session goes on.
    const buried = leaveOutcome(r, cards[1].id);
    expect(buried.end).toBe('stay');
    r = buried.next;
    expect(r.left).toEqual([cards[1].id]);
    // Card 3 (now the last) is rated: the session is finished, but the screen is not "All done here".
    const out = rateRun(revealed(r), { rating: 'good', rated: cards[2], wrote: true, now: NOW });
    expect(out.finished).toBe(true);
    expect(out.reviewed).toBe(2);
    expect(sessionScreen(out.next)).toBe('card');
    expect(isExhausted(out.next)).toBe(false); // the rated card stays the card on screen until Complete opens
  });

  it('sessionScreen: an empty session is the empty queue, never "All done here"', () => {
    expect(sessionScreen(initialRun([], new Map()))).toBe('empty');
    const { run } = simpleRun(2);
    expect(sessionScreen(run)).toBe('card');
    expect(ALL_DONE_COPY).toEqual({
      title: 'All done here.',
      last: 'That was the last card of this session.',
      undo: 'Undo',
      finish: 'Finish session',
      leave: 'Back',
    });
  });

  // Wave 5b (walkthrough H1): Android's Back left at once, even after ratings
  // and even when it only meant to close the typing keyboard.
  // Adapted in review round 1: the input also says whether the session is the
  // focused screen and whether it is banked (the 'pass' cases are the next test).
  it('backPressAction: the keyboard first, then the exit sheet after a rating, else leave', () => {
    const none = { focused: true, committed: false, keyboardVisible: false, msSinceKeyboardHid: Infinity, rated: 0, allDone: false };
    // The keyboard is open: Back only closes it (in any state).
    expect(backPressAction({ ...none, keyboardVisible: true })).toBe('keyboard');
    expect(backPressAction({ ...none, keyboardVisible: true, rated: 4 })).toBe('keyboard');
    // The keyboard closed itself on this very press (just before the app heard it): still only the keyboard.
    expect(backPressAction({ ...none, msSinceKeyboardHid: 80, rated: 4 })).toBe('keyboard');
    expect(backPressAction({ ...none, msSinceKeyboardHid: KEYBOARD_BACK_GRACE_MS, rated: 4 })).toBe('confirm');
    // At least one rating: the same "End this session?" sheet as ✕.
    expect(backPressAction({ ...none, rated: 1 })).toBe('confirm');
    // Nothing rated: leave (nothing to lose).
    expect(backPressAction(none)).toBe('leave');
    // "All done here": the same as its main button.
    expect(backPressAction({ ...none, allDone: true, rated: 2 })).toBe('allDone');
    expect(backPressAction({ ...none, allDone: true })).toBe('allDone');
  });

  // Review round 1: the session stays mounted under the card editor, and
  // Android asks its Back listener first. A Back IN THE EDITOR opened "End
  // this session?" over the editor, and the editor never closed.
  it('backPressAction: not the focused screen, or already banked → pass (the navigator handles Back)', () => {
    const rated = { focused: true, committed: false, keyboardVisible: false, msSinceKeyboardHid: Infinity, rated: 1, allDone: false };
    expect(backPressAction(rated)).toBe('confirm');
    // The card editor is on top of the session: its Back is never the session's.
    expect(backPressAction({ ...rated, focused: false })).toBe('pass');
    expect(backPressAction({ ...rated, focused: false, keyboardVisible: true })).toBe('pass');
    expect(backPressAction({ ...rated, focused: false, msSinceKeyboardHid: 10 })).toBe('pass');
    expect(backPressAction({ ...rated, focused: false, allDone: true })).toBe('pass');
    // Banked (finish / End session / Finish session ran): never a second exit sheet or a second bank.
    expect(backPressAction({ ...rated, committed: true })).toBe('pass');
    expect(backPressAction({ ...rated, committed: true, allDone: true })).toBe('pass');
  });

  // Review round 2: the grace window was `ms < 500` on the wall clock. After
  // the clock went back (a manual time change, a network time correction)
  // the time since the hide was NEGATIVE, so every Back press only closed
  // the keyboard, and Back could not leave the session.
  it('backPressAction: a negative time since the keyboard hid (the clock went back) is not "just now"', () => {
    const rated = { focused: true, committed: false, keyboardVisible: false, msSinceKeyboardHid: Infinity, rated: 2, allDone: false };
    expect(backPressAction({ ...rated, msSinceKeyboardHid: -1 })).toBe('confirm');
    expect(backPressAction({ ...rated, msSinceKeyboardHid: -60_000 })).toBe('confirm');
    expect(backPressAction({ ...rated, msSinceKeyboardHid: -60_000, rated: 0 })).toBe('leave');
    expect(backPressAction({ ...rated, msSinceKeyboardHid: -60_000, allDone: true })).toBe('allDone');
    // The window itself is unchanged: 0 ≤ ms < 500.
    expect(backPressAction({ ...rated, msSinceKeyboardHid: 0 })).toBe('keyboard');
    expect(backPressAction({ ...rated, msSinceKeyboardHid: KEYBOARD_BACK_GRACE_MS - 1 })).toBe('keyboard');
    // An open keyboard still closes first, whatever the clock says.
    expect(backPressAction({ ...rated, msSinceKeyboardHid: -60_000, keyboardVisible: true })).toBe('keyboard');
  });

  it('withinMs: 0 ≤ ms < window; a negative value is never inside', () => {
    expect(withinMs(0, 500)).toBe(true);
    expect(withinMs(80, 500)).toBe(true);
    expect(withinMs(500, 500)).toBe(false);
    expect(withinMs(Infinity, 500)).toBe(false);
    expect(withinMs(-1, 500)).toBe(false);
    expect(withinMs(-Infinity, 500)).toBe(false);
  });

  // Review round 2: the window also started on a hide the session asked for
  // itself (TypingAnswer's "Check" closes the keyboard), so a Back press just
  // after "Check" was ignored.
  it('keyboardHideOpensGrace: only a hide of the session’s keyboard that the session did not ask for', () => {
    // The keyboard closed by itself (a Back press, a tap elsewhere): the window starts.
    expect(keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: Infinity })).toBe(true);
    expect(keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: SELF_DISMISS_MS })).toBe(true);
    // The session closed it itself ("Check", or Back with the keyboard open) a moment ago: no window.
    expect(keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: 0 })).toBe(false);
    expect(keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: 300 })).toBe(false);
    // The clock went back since then: it is not "a moment ago".
    expect(keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: -300 })).toBe(true);
    // The card editor's keyboard (the editor is on top of the session): never the session's.
    expect(keyboardHideOpensGrace({ focused: false, msSinceSelfDismiss: Infinity })).toBe(false);
  });

  // Final device pass K1-1: every screen got the session's keyboard rule, from ONE place.
  it('the keyboard constants and rules are the app-wide guard’s (one source of truth)', () => {
    expect(KEYBOARD_BACK_GRACE_MS).toBe(keyboardBack.KEYBOARD_BACK_GRACE_MS);
    expect(SELF_DISMISS_MS).toBe(keyboardBack.SELF_DISMISS_MS);
    expect(withinMs).toBe(keyboardBack.withinMs);
    // backPressAction's 'keyboard' is the guard's 'closeKeyboard' or 'swallow', for the same inputs.
    for (const keyboardVisible of [true, false]) {
      for (const msSinceKeyboardHid of [Infinity, 0, 100, KEYBOARD_BACK_GRACE_MS - 1, KEYBOARD_BACK_GRACE_MS, 600, -5]) {
        const session = backPressAction({ focused: true, committed: false, keyboardVisible, msSinceKeyboardHid, rated: 1, allDone: false });
        const app = keyboardBack.keyboardBackAction({ keyboardVisible, msSinceKeyboardHid });
        expect([keyboardVisible, msSinceKeyboardHid, session === 'keyboard']).toEqual([keyboardVisible, msSinceKeyboardHid, app !== 'pass']);
      }
    }
    // keyboardHideOpensGrace is the guard's hideOpensGrace, plus the session's focus check.
    for (const ms of [Infinity, 0, 300, SELF_DISMISS_MS - 1, SELF_DISMISS_MS, -300]) {
      expect(keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: ms })).toBe(keyboardBack.hideOpensGrace(ms));
      expect(keyboardHideOpensGrace({ focused: false, msSinceSelfDismiss: ms })).toBe(false);
    }
  });

  it('dropMissing: a deleted note leaves the queue (not the cards already rated); same object when nothing is gone', () => {
    const { run, cards } = simpleRun(3);
    const r = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    expect(dropMissing(r, () => true).next).toBe(r);
    const out = dropMissing(r, (id) => id !== cards[0].id && id !== cards[2].id);
    expect(out.dropped).toBe(1);
    expect(out.next.queue.map((c) => c.id)).toEqual([cards[0].id, cards[1].id]);
    expect(out.next.left).toEqual([cards[2].id]);
  });

  // Wave 5c (M1): the card editor's Undo brought a deleted LAST card back in
  // the store, but "All done here" stayed and the card could not be studied.
  it('restoreDeleted: a deleted LAST card that is back in the store goes back on screen, in its old order', () => {
    const { run, cards } = simpleRun(3);
    const r = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    // Cards 2 and 3 (a note with two cards, say) were deleted in the editor: "All done here".
    const deleted = remainingCards(r);
    const gone = dropMissing(r, (id) => id === cards[0].id).next;
    expect(sessionScreen(gone)).toBe('allDone');
    // Nothing came back (yet): nothing to do.
    expect(restoreDeleted(gone, deleted, (id) => id === cards[0].id)).toBeNull();
    // The Undo brought them back: both are put back, in their old order, and leave `left`.
    const back = restoreDeleted(gone, deleted, () => true)!;
    expect(sessionScreen(back)).toBe('card');
    expect(back.idx).toBe(1);
    expect(back.queue.map((c) => c.id)).toEqual(cards.map((c) => c.id));
    expect(back.left).toEqual([]);
    expect(currentCard(back)?.id).toBe(cards[1].id);
    // Only the cards that are back: one of the two.
    const one = restoreDeleted(gone, deleted, (id) => id !== cards[2].id)!;
    expect(one.queue.map((c) => c.id)).toEqual([cards[0].id, cards[1].id]);
    expect(one.left).toEqual([cards[2].id]);
    // Never a card that did not leave the session (still in its queue), and never with no deleted cards.
    expect(restoreDeleted(r, deleted, () => true)).toBeNull();
    expect(restoreDeleted(gone, [], () => true)).toBeNull();
    // Once only: a card that is back is not in `left` any more, so a second call changes nothing.
    expect(restoreDeleted(back, deleted, () => true)).toBeNull();
  });

  // Wave 5c, review round 1: only a deleted LAST card came back. A card
  // deleted in the MIDDLE of a session stayed out after the editor's Undo.
  it('restoreDeleted: a card deleted in the middle comes back too, at the place of the card on screen', () => {
    const { run, cards } = simpleRun(3);
    const r = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    // Card 2 (on screen) was deleted in the editor: card 3 is on screen ("2 / 2").
    const deleted = remainingCards(r).filter((c) => c.id === cards[1].id);
    const gone = dropMissing(r, (id) => id !== cards[1].id).next;
    expect([sessionScreen(gone), currentCard(gone)?.id, gone.queue.length]).toEqual(['card', cards[2].id, 2]);
    expect(restoreDeleted(gone, deleted, (id) => id !== cards[1].id)).toBeNull(); // not back yet
    // The Undo brought it back: it is on screen again, card 3 comes after it ("2 / 3").
    const back = restoreDeleted(gone, deleted, () => true)!;
    expect(back.queue.map((c) => c.id)).toEqual(cards.map((c) => c.id));
    expect([back.idx, currentCard(back)?.id, back.left]).toEqual([1, cards[1].id, []]);
    // The cards already rated never move.
    expect(back.queue[0]).toBe(r.queue[0]);
  });

  // Wave 5d (F1a): a deleted card kept the plan of the mode it left in. "Switch mode" plans only
  // the cards still in the queue, so after a switch the card came back in the OLD mode.
  it('restoreDeleted / restoreToRun: a card that comes back after "Switch mode" is planned in the CURRENT mode', () => {
    const groups = [0, 1, 2].map((i) => deWord(`Wort ${i}`, `word ${i}`, dueReview(), `n-${i}`));
    const state = stateOfV3({ decks: [makeDeckV3({ id: 'd1', name: 'German', language: 'de-DE' })], groups });
    const cards = state.cards;
    const plansIn = (mode: 'flash' | 'type', of: readonly Card[]) => plansFor(of, mode, 'scheduled', DAY_KEY, state);
    let r = initialRun(cards, plansIn('flash', cards));
    r = rateRun(revealed(r), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    // Card 2 (on screen) is deleted in the card editor: it leaves the session with its flash plan.
    const deleted = remainingCards(r).filter((c) => c.id === cards[1].id);
    r = dropMissing(r, (id) => id !== cards[1].id).next;
    // More › Switch mode › Typing: only the cards still in the queue get a typing plan.
    r = switchModeRun(r, plansIn('type', remainingCards(r)));
    expect(currentPlan(r).mode).toBe('type');
    expect(r.plans.get(cards[1].id)?.mode).toBe('flash'); // the stale plan of the card that is out
    // The editor's Undo brings it back: without `replan` it is still asked in the OLD mode…
    expect(currentPlan(restoreDeleted(r, deleted, () => true)!).mode).toBe('flash');
    // …with `replan` (what the screen passes) it is planned in the mode now on.
    const back = restoreDeleted(r, deleted, () => true, (cs) => plansIn('type', cs))!;
    expect(currentCard(back)?.id).toBe(cards[1].id);
    expect(currentPlan(back)).toEqual(plansIn('type', [cards[1]]).get(cards[1].id));
    expect(currentPlan(back).mode).toBe('type');
    // The other plans stay as they were (the same objects).
    expect(back.plans.get(cards[2].id)).toBe(r.plans.get(cards[2].id));
    // The same for the Undo of a Suspend / Reschedule (restoreToRun).
    const out = leaveOutcome(back, cards[1].id).next;
    const switched = switchModeRun(out, plansIn('flash', remainingCards(out)));
    expect(currentPlan(restoreToRun(switched, cards[1])).mode).toBe('type'); // stale without replan
    const undone = restoreToRun(switched, cards[1], (cs) => plansIn('flash', cs));
    expect([currentCard(undone)?.id, currentPlan(undone).mode]).toEqual([cards[1].id, 'flash']);
  });

  // Wave 5c, review round 2: the snapshot of a rating made while a card was
  // out of the session has no such card. So an undo of that rating, after
  // the editor's Undo brought the card back, took it out again: it was in
  // neither the queue nor `left` (silently gone from the session).
  it('undo after restoreDeleted keeps the card that came back: rate → delete → rate → editor Undo → undo', () => {
    const { run, cards } = simpleRun(4);
    const [c1, c2, c3, c4] = cards.map((c) => c.id);
    const exists = (gone: Set<string>) => (id: string) => !gone.has(id);
    let r = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    // c2 (on screen) is deleted in the card editor: c3 is on screen.
    const deleted = remainingCards(r).filter((c) => c.id === c2);
    r = dropMissing(r, exists(new Set([c2]))).next;
    expect(currentCard(r)?.id).toBe(c3);
    r = rateRun(revealed(r), { rating: 'good', rated: currentCard(r)!, wrote: true, now: NOW }).next;
    // The editor's Undo: c2 is on screen again.
    r = restoreDeleted(r, deleted, () => true)!;
    expect([r.queue.map((c) => c.id), r.idx]).toEqual([[c1, c3, c2, c4], 2]);
    // Undo the rating of c3: c3 is on screen again, and c2 still comes next.
    const byId = new Map(cards.map((c) => [c.id, c]));
    const back = undoRun(r, blockedIn(byId, r.left, NOW))!;
    expect([back.next.queue.map((c) => c.id), back.next.idx, currentCard(back.next)?.id]).toEqual([[c1, c3, c2, c4], 1, c3]);
    expect(back.next.left).toEqual([]);
    // Undo again (the rating of c1): the old order, each card once.
    const first = undoRun(back.next, blockedIn(byId, back.next.left, NOW))!;
    expect([first.next.queue.map((c) => c.id), first.next.idx]).toEqual([[c1, c2, c3, c4], 0]);
    // A card that is blocked now (it left again, or it is suspended) still never comes back.
    const suspended = new Map(byId).set(c2, { ...cards[1], suspended: true });
    const blockedBack = undoRun(r, blockedIn(suspended, r.left, NOW))!;
    expect(blockedBack.next.queue.map((c) => c.id)).toEqual([c1, c3, c4]);
  });

  it('undo still takes back the "Again" copy of the card it un-rates (it has the same id)', () => {
    const { run, cards } = simpleRun(2);
    // "Again" on the LAST card: its copy comes right after it, and it is on screen now.
    let r = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    r = rateRun(revealed(r), { rating: 'again', rated: cards[1], wrote: true, now: NOW }).next;
    expect([r.queue.length, currentCard(r)?.requeued]).toEqual([3, true]);
    const back = undoRun(r, () => false)!;
    expect([back.next.queue.map((c) => c.id), back.next.idx]).toEqual([[cards[0].id, cards[1].id], 1]);
  });

  it('the answer state belongs to one card: a new card on screen starts fresh', () => {
    const { run, cards } = simpleRun(2);
    const r = patchUi(run, { hintStep: 2 });
    expect(currentUi(r).hintStep).toBe(2);
    const next = rateRun(revealed(r), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    expect(currentUi(next)).toEqual(freshUi(uiKey(cards[1], 1)));
  });

  // W5-5a: the Quiz and Typing handlers checked the state of the LAST render,
  // so two taps before the next render both passed, and the LAST one won.
  // The session now records an answer through answerRun inside its state
  // update: the FIRST answer of a card wins, a second one changes nothing.
  it('answerRun: the first answer wins; a second tap in the same frame changes nothing', () => {
    const { run, cards } = simpleRun(2);
    const key = currentUi(run).key;
    // Two Quiz taps, applied one after the other like two queued state updates.
    const first = answerRun(run, key, { kind: 'pick', index: 0 }, NOW);
    const second = answerRun(first, key, { kind: 'pick', index: 2 }, NOW + 40);
    expect(second).toBe(first);
    expect(currentUi(second)).toMatchObject({ pick: 0, revealed: true, revealedAt: NOW });
    // Typing: Enter and the "Check" button → the first result stays, revealedAt does not move.
    const right = checkTyped('die Abfahrt', { text: 'die Abfahrt', lang: 'de-DE', role: 'term', multiline: false });
    const typo = checkTyped('die Abfart', { text: 'die Abfahrt', lang: 'de-DE', role: 'term', multiline: false });
    const checked = answerRun(answerRun(run, key, { kind: 'check', result: right }, NOW), key, { kind: 'check', result: typo }, NOW + 5);
    expect(currentUi(checked)).toMatchObject({ check: right, revealedAt: NOW });
    // Articles and a plain reveal follow the same rule.
    const article = answerRun(answerRun(run, key, { kind: 'article', choice: 'die' }, NOW), key, { kind: 'article', choice: 'der' }, NOW + 5);
    expect(currentUi(article).article).toBe('die');
    const shown = answerRun(run, key, { kind: 'reveal', hintStep: 2 }, NOW);
    expect(currentUi(shown)).toMatchObject({ revealed: true, revealedAt: NOW, hintStep: 2 });
    expect(answerRun(shown, key, { kind: 'reveal' }, NOW + 9)).toBe(shown);
    // An answer for a card that is no longer on screen is ignored.
    const moved = rateRun(revealed(run), { rating: 'good', rated: cards[0], wrote: true, now: NOW }).next;
    expect(answerRun(moved, key, { kind: 'pick', index: 1 }, NOW)).toBe(moved);
    // After Switch mode the card starts fresh, so it can be answered again.
    const switched = switchModeRun(first, new Map());
    expect(currentUi(answerRun(switched, key, { kind: 'pick', index: 3 }, NOW + 50)).pick).toBe(3);
  });

  it('the marker is what a kill banks: counts, total, bestRun, fastAnswers, the start day and the mode (M5)', () => {
    const { run, cards } = simpleRun(3);
    const r = rateRun(revealed(run, NOW), { rating: 'good', rated: cards[0], wrote: true, now: NOW + 10 }).next;
    // Wave 5h (device note E7-10): the mode is in the marker, so the boot reconcile's record has it too.
    expect(markerOf(r, { kind: 'scheduled', label: 'German', durationSec: 12, studyDay: '2026-06-10', mode: 'type' }, 1)).toStrictEqual({
      kind: 'scheduled',
      label: 'German',
      counts: { again: 0, hard: 0, good: 1, easy: 0 },
      total: 1,
      bestRun: 1,
      durationSec: 12,
      fastAnswers: 1,
      studyDay: '2026-06-10',
      mode: 'type',
    });
  });

  it('Switch mode plans the cards still to come and restarts the card on screen; undo gives an old card its old plan', () => {
    const state = germanState();
    const s = start(state, { mode: 'flash' });
    let r = initialRun(s.queue, s.plans);
    r = rateRun(revealed(r), { rating: 'good', rated: s.queue[0], wrote: true, now: NOW }).next;
    r = patchUi(r, { hintStep: 1 });
    const plans = plansFor(remainingCards(r), 'type', 'scheduled', DAY_KEY, state);
    const switched = switchModeRun(r, plans);
    expect(currentUi(switched).hintStep).toBe(0);
    expect(switched.plans.get(s.queue[0].id)?.mode).toBe('flash'); // already rated: unchanged
    expect(currentPlan(switched).mode).toBe('type'); // a review with a short answer
    const back = undoRun(switched, () => false)!;
    expect(currentPlan(back.next).mode).toBe('flash');
  });

  it('after the card editor: new text → the cards still to come are planned again', () => {
    const state = germanState();
    const s = start(state, { mode: 'type', kind: 'practice' });
    const r = initialRun(s.queue, s.plans);
    const { notes, noteTypes } = state;
    const lib = { notes, noteTypes };
    expect(replanRun(r, state, lib, 'type', 'practice', DAY_KEY)).toBe(r); // nothing changed
    const card = currentCard(r)!;
    const edited: DataStateV3 = {
      ...state,
      notes: notes.map((n: Note) =>
        n.id === card.noteId ? { ...n, fields: n.fields.map((f, i) => (i === 1 ? 'a new answer' : f)) } : n,
      ),
    };
    const next = replanRun(patchUi(r, { hintStep: 1 }), edited, lib, 'type', 'practice', DAY_KEY);
    expect(currentPlan(next).typing?.text).toBe('a new answer');
    expect(currentUi(next).hintStep).toBe(0);
  });
});

/* ================================================================ 4. card */

describe('card: suggestion, hints, Articles', () => {
  const typePlan = (text: string, lang = 'de-DE') =>
    ({ mode: 'type', fallback: null, typing: { text, lang, role: 'term', multiline: false }, quiz: null, article: null }) as const;

  it('Typing: exact → Good, close → Hard, wrong → Again; nothing before the answer is shown', () => {
    const plan = typePlan('die Abfahrt');
    const ui = (typed: string) => ({ ...freshUi('k'), revealed: true, check: checkTyped(typed, plan.typing) });
    expect(suggestedRating(plan, ui('die Abfahrt'))).toBe('good');
    expect(suggestedRating(plan, ui('Abfahrt'))).toBe('hard'); // the article is missing
    expect(suggestedRating(plan, ui('der Zug'))).toBe('again');
    expect(suggestedRating(plan, { ...ui('die Abfahrt'), revealed: false })).toBeNull();
    // A used hint outlines Hard, unless the answer was wrong.
    expect(suggestedRating(plan, { ...ui('die Abfahrt'), hintStep: 1 })).toBe('hard');
    expect(suggestedRating(plan, { ...ui('xyz'), hintStep: 1 })).toBe('again');
  });

  it('Quiz: right → Good, wrong → Again; Flashcards: no suggestion unless a hint was used', () => {
    const quiz: CardPlan = { mode: 'mc', fallback: null, typing: null, quiz: { choices: ['a', 'b', 'c', 'd'], answerIndex: 2 }, article: null };
    expect(suggestedRating(quiz, { ...freshUi('k'), revealed: true, pick: 2 })).toBe('good');
    expect(suggestedRating(quiz, { ...freshUi('k'), revealed: true, pick: 0 })).toBe('again');
    const flash = { mode: 'flash', fallback: null, typing: null, quiz: null, article: null } as const;
    expect(suggestedRating(flash, { ...freshUi('k'), revealed: true })).toBeNull();
    expect(suggestedRating(flash, { ...freshUi('k'), revealed: true, hintStep: 2 })).toBe('hard');
  });

  it('the hint button: hidden when Hints is off, in Quiz and Articles, after reveal; Hint → More hint → Show answer', () => {
    const flash = { mode: 'flash', fallback: null, typing: null, quiz: null, article: null } as const;
    const mc = { ...flash, mode: 'mc' } as const;
    const article = { ...flash, mode: 'article' } as const;
    expect(showHintButton(true, flash, freshUi('k'))).toBe(true);
    expect(showHintButton(false, flash, freshUi('k'))).toBe(false);
    expect(showHintButton(true, mc, freshUi('k'))).toBe(false);
    expect(showHintButton(true, article, freshUi('k'))).toBe(false);
    expect(showHintButton(true, flash, { ...freshUi('k'), revealed: true })).toBe(false);
    expect([0, 1, 2].map(hintButtonLabel)).toEqual(['Hint', 'More hint', 'Show answer']);
  });

  it('hint steps: an example with the answer blanked, then half the letters, then reveal', () => {
    const f = face(
      [block({ plain: 'gehen (ich)' })],
      [block({ plain: 'gehe', role: 'meaning', field: 1 }), block({ plain: 'Ich gehe nach Hause.', role: 'example', field: 2 })],
    );
    const flash = { mode: 'flash', fallback: null, typing: null, quiz: null, article: null } as const;
    const source = hintSourceFor(f, flash);
    expect(shownHint(source, 0)).toBeNull();
    const one = nextHint(source, 0);
    expect(one).toMatchObject({ step: 1, reveal: false, hint: { kind: 'example', text: 'Ich ____ nach Hause.' } });
    const two = nextHint(source, one.step);
    expect(two).toMatchObject({ step: 2, reveal: false, hint: { kind: 'letters' } });
    expect(shownHint(source, 2)?.kind).toBe('letters');
    expect(nextHint(source, two.step).reveal).toBe(true);
    // Typing hints are about the text to type.
    const typing = typePlan('die Stunde');
    expect(hintSourceFor(f, typing).answer).toBe('die Stunde');
  });

  it('Articles: right → Good, wrong → Again (practice writes nothing either way)', () => {
    const plan = { mode: 'article', fallback: null, typing: null, quiz: null, article: { article: 'die', word: 'Abfahrt', gender: 'f' } } as const;
    expect(articleRight(plan, freshUi('k'))).toBeNull();
    expect(articleRight(plan, { ...freshUi('k'), article: 'die' })).toBe(true);
    expect(articleRight(plan, { ...freshUi('k'), article: 'der' })).toBe(false);
    expect(articleRating(true)).toBe('good');
    expect(articleRating(false)).toBe('again');
  });

  // W5-5a: the chip was offered only while 4+ nouns were left, so an Articles
  // practice with 3 nouns left showed no active chip, and after "Flashcards"
  // the learner could not switch back.
  it('Switch mode: the Articles chip stays while the session is in Articles; else 4+ nouns in Practice', () => {
    expect(articleChipShown('practice', 'article', 3, 'article')).toBe(true);
    expect(articleChipShown('practice', 'article', 0, 'article')).toBe(true);
    expect(articleChipShown('practice', 'flash', 3, 'flash')).toBe(false);
    expect(articleChipShown('practice', 'flash', 4, 'flash')).toBe(true);
    // Never in a session that writes the schedule (Articles has no rating buttons).
    expect(articleChipShown('scheduled', 'flash', 40, 'flash')).toBe(false);
    expect(articleChipShown('ahead', 'article', 40, 'article')).toBe(false);
  });

  // W5-5a review round 2: "Practice articles · 6" after 3 ratings has 3 nouns
  // left. More › Switch mode › Flashcards hid the Articles chip (3 < 4), so the
  // learner could not switch back to the mode the session started in.
  it('Switch mode: a session that STARTED in Articles can always switch back while nouns are left', () => {
    expect(articleChipShown('practice', 'flash', 3, 'article')).toBe(true);
    expect(articleChipShown('practice', 'type', 1, 'article')).toBe(true);
    // No noun left: Articles has nothing to ask.
    expect(articleChipShown('practice', 'flash', 0, 'article')).toBe(false);
    // Still Practice only.
    expect(articleChipShown('scheduled', 'flash', 3, 'article')).toBe(false);
  });

  it('a fallback card says why it is a flashcard', () => {
    expect(FALLBACK_COPY.long).toBe('Long answer — flip instead');
    const state = germanState();
    const long = deWord('lang', 'x'.repeat(70));
    const { notes: allNotes, noteTypes } = state;
    const lib = libraryIndexOf({ notes: allNotes.concat(long.note), noteTypes });
    const plan = planCard(long.cards[0], {
      mode: 'type',
      kind: 'scheduled',
      dayKey: DAY_KEY,
      faceOf: facesFor(lib, decksById(state.decks)),
      library: lib,
    });
    expect(plan.fallback).toBe('long');
  });
});

describe('card: the headline size (device findings)', () => {
  it('short → big serif; 40–120 characters or a few lines → medium; longer or 4+ lines → long, never bold', () => {
    expect(headlineSize(block({ plain: 'die Stunde' }))).toBe('big');
    expect(headlineSize(block({ plain: 'x'.repeat(60) }))).toBe('medium');
    expect(headlineSize(block({ plain: 'a\nb', lines: [[{ t: 'text', text: 'a' }], [{ t: 'text', text: 'b' }]] }))).toBe('medium');
    expect(headlineSize(block({ plain: 'x'.repeat(121) }))).toBe('long');
    const four = [1, 2, 3, 4].map((n) => [{ t: 'text' as const, text: `ich ${n}` }]);
    expect(headlineSize(block({ plain: 'ich 1 ich 2 ich 3 ich 4', lines: four }))).toBe('long');
    expect(headlineSize(undefined)).toBe('big');
    // A long answer is sans 16 at normal weight; the big sizes are only for short text.
    expect(HEADLINE_STYLES.answer.long.base).toMatchObject({ family: 'sans', weight: 400, size: 16 });
    expect(HEADLINE_STYLES.prompt.long.base).toMatchObject({ family: 'sans', weight: 400, size: 20 });
    expect(HEADLINE_STYLES.answer.big.base.size).toBe(31);
    expect(HEADLINE_STYLES.prompt.big.base.size).toBe(42);
  });
});

describe('copy and screen-reader texts', () => {
  const f = face(
    [block({ plain: 'die Stunde' })],
    [
      block({ plain: 'the hour', role: 'meaning', field: 1, label: 'Translation' }),
      block({ plain: 'Die Stunde ist um.', role: 'example', field: 2, label: 'Example' }),
      block({ plain: 'secret', role: 'hidden', field: 3, label: 'Base' }),
    ],
  );

  it('the card: "Card. {question}. Double tap to reveal." and the answer side field by field (spec §8.12)', () => {
    expect(cardA11yLabel(f, false)).toBe('Card. die Stunde. Double tap to reveal.');
    expect(cardA11yLabel(f, false, false)).toBe('Card. die Stunde.');
    // Articles draws the bare word: the label says that word, never the article to choose.
    expect(cardA11yLabel(f, false, false, 'Stunde')).toBe('Card. Stunde.');
    expect(cardA11yLabel(f, true)).toBe('die Stunde. the hour. Example: Die Stunde ist um.');
    const dictation = face([block({ plain: 'die Stunde', lines: [[{ t: 'text', text: '🔊' }]] })], [block({ plain: 'die Stunde' })]);
    expect(cardA11yLabel(dictation, false)).toBe('Card. Read aloud. Double tap to reveal.');
    expect(cardName(dictation)).toBe('This card'); // never gives the hidden word away
    expect(cardName(f)).toBe('die Stunde');
  });

  it('the "More" sheet title never shows the answer before the reveal (final device pass)', () => {
    // Articles asks "? Stunde": the title is the bare word, not "die Stunde".
    expect(moreSheetTitle(f, { word: 'Stunde' })).toBe('Stunde');
    // A dictation card shows only 🔊: its title must not name the word it reads.
    const dictation = face([block({ plain: 'die Stunde', lines: [[{ t: 'text', text: '🔊' }]] })], [block({ plain: 'die Stunde' })]);
    expect(moreSheetTitle(dictation, null)).toBe('This card');
    expect(moreSheetTitle(f, null)).toBe('die Stunde');
  });

  it('Practice shows no learning-step pill: it changes no step (H3, final device pass)', () => {
    expect(sessionStepLabel('practice', '1/2 · 1m → 10m')).toBeNull();
    expect(sessionStepLabel('scheduled', '1/2 · 1m → 10m')).toBe('1/2 · 1m → 10m');
    expect(sessionStepLabel('ahead', '1/2 · 1m → 10m')).toBe('1/2 · 1m → 10m');
    expect(sessionStepLabel('scheduled', null)).toBeNull();
  });

  // Final device pass K1-3: TalkBack read "Card. What does a hash table
  // store?. Double tap to reveal." — a full stop after a question mark.
  it('a label never adds a full stop after text that ends with . ? ! : or … (K1-3)', () => {
    const q = face([block({ plain: 'What does a hash table store?' })], [block({ plain: 'Select items!', field: 1 })]);
    expect(cardA11yLabel(q, false)).toBe('Card. What does a hash table store? Double tap to reveal.');
    expect(cardA11yLabel(q, false, false)).toBe('Card. What does a hash table store?');
    expect(cardA11yLabel(q, true)).toBe('What does a hash table store? Select items!');
    expect(headlineLineLabel('Wie bitte!')).toBe('Card. Wie bitte!');
    // A field on the back that ends with ':' gets no full stop either.
    const colon = face(
      [block({ plain: 'Q' })],
      [block({ plain: 'A', field: 1 }), block({ plain: 'see below:', field: 2, label: 'Note', role: 'detail' })],
    );
    expect(cardA11yLabel(colon, true)).toBe('Q. A. Note: see below:');
    // asSentence: one full stop, never two; spaces around are dropped; empty stays empty.
    expect(asSentence(' die Stunde ')).toBe('die Stunde.');
    for (const end of ['.', '?', '!', ':', '…']) expect(asSentence(`Text${end}`)).toBe(`Text${end}`);
    expect(asSentence('   ')).toBe('');
    // An empty question never reads "Card. ." (the label is just "Card.").
    const empty = face([block({ plain: '' })], [block({ plain: 'x', field: 1 })]);
    expect(cardA11yLabel(empty, false)).toBe('Card. Double tap to reveal.');
    expect(cardA11yLabel(empty, false, false)).toBe('Card.');
    expect(headlineLineLabel('  ')).toBe('Card.');
  });

  it('rating buttons: "Good. Next in 3 days." (practice: no schedule change)', () => {
    expect(ratingA11yLabel('good', '3d', false)).toBe('Good. Next in 3 days.');
    expect(ratingA11yLabel('hard', '1d', true)).toBe('Hard, suggested. Next in 1 day.');
    expect(ratingA11yLabel('again', 'soon', false)).toBe('Again. Comes back soon in this session.');
    // Wave 5i: the curly apostrophe (’), like the rest of the session and Complete copy.
    expect(ratingA11yLabel('easy', null, false)).toBe('Easy. Doesn’t change your schedule.');
    // A passed Check keeps the card Known: no "Next in Known".
    expect(ratingA11yLabel('good', KNOWN_INTERVAL, true)).toBe('Good, suggested. Stays Known.');
    expect(['10m', '1h', '2mo', '1.5y', 'soon'].map(intervalWords)).toEqual(['10 minutes', '1 hour', '2 months', '1.5 years', 'soon']);
  });

  it('snackbars and lines use plural()', () => {
    expect(rateSnack('good', '3d', 'die Stunde')).toBe('Rated Good · next in 3d');
    expect(rateSnack('good', null, 'die Stunde')).toBe('Rated Good · your schedule is unchanged');
    expect(rateSnack('easy', KNOWN_INTERVAL, 'die Stunde')).toBe('Rated Easy · stays Known');
    expect(rateSnack('again', 'soon', 'die Stunde')).toBe('die Stunde is coming back soon in this session');
    expect(exitSavedLine(1)).toBe('The 1 card you reviewed will be saved.');
    expect(exitSavedLine(3)).toBe('The 3 cards you reviewed will be saved.');
    // Wave 5h (device pass E7): Practice changes no schedule (H3), so its exit sheet says so.
    expect(exitSavedLine(3, false)).toBe('The 3 cards you reviewed will be saved.');
    expect(exitSavedLine(1, true)).toBe('Your practice is kept (1 card). Your schedule does not change.');
    expect(exitSavedLine(3, true)).toBe('Your practice is kept (3 cards). Your schedule does not change.');
    expect(exitSavedLine(1200, true)).toBe('Your practice is kept (1,200 cards). Your schedule does not change.');
    // Wave 5g (walkthrough E11-4): "missed", never "lapse" (see the next test).
    expect(missedLine(1, 1, true)).toBe('1 card missed — it’ll come back soon.');
    expect(missedLine(2, 2, true)).toBe('2 cards missed — they’ll come back soon.');
    expect(missedLine(2, 2, false)).toBeNull(); // practice: nothing comes back
    expect(missedLine(0, 0, true)).toBeNull();
    expect(missedLine(1200, 1200, true)).toBe('1,200 cards missed — they’ll come back soon.');
  });

  // Wave 5g (walkthrough E11-4): the Complete screen said "1 lapse — it'll come back soon."
  // for a NEW card rated Again. A lapse is a REVIEW card that was forgotten (the scheduler
  // adds one only when reps > 0), so the line says "missed", which fits every Again.
  it('the Complete line counts the missed CARDS with a word that fits every Again (no "lapse")', () => {
    // A new card rated Again: the line, and no "lapse" in it.
    const line = missedLine(1, 1, true)!;
    expect(line).toBe('1 card missed — it’ll come back soon.');
    expect(line).not.toMatch(/lapse/i);
    // One card missed twice (two Again ratings): ONE card, like the box "You missed 1 card".
    expect(missedLine(2, 1, true)).toBe('1 card missed — it’ll come back soon.');
    expect(missedLine(3, 2, true)).toBe('2 cards missed — they’ll come back soon.');
    // No missed list (0): the Again count is used.
    expect(missedLine(2, 0, true)).toBe('2 cards missed — they’ll come back soon.');
    // Never more cards than Again ratings.
    expect(missedLine(1, 3, true)).toBe('1 card missed — it’ll come back soon.');
    // Practice writes nothing: no line, whatever the counts.
    expect(missedLine(3, 2, false)).toBeNull();
  });

  // Review of C1-5: a question that is only a picture gave an EMPTY question line on the
  // answer side — a silent TalkBack stop that took the focus after the reveal.
  it('answerQuestionLine: the question text, else promptPlain, else "" (a picture-only question)', () => {
    expect(answerQuestionLine(face([block({ plain: 'die Stunde' })], []))).toBe('die Stunde');
    // The headline's own lines (a conjugation table keeps its line breaks).
    const lines = block({ plain: 'ich bin du bist', lines: [[{ t: 'text', text: 'ich bin' }], [{ t: 'text', text: 'du bist' }]] });
    expect(answerQuestionLine(face([lines], []))).toBe('ich bin\ndu bist');
    // Only a picture: no text at all (htmlLines gives '' for an image-only field).
    const picture = block({ plain: '', lines: [[{ t: 'img', src: 'sample.png' }]] });
    expect(answerQuestionLine(face([picture], []))).toBe('');
    // Two picture lines: blockText is '\n', which is no text either.
    const twoPictures = block({ plain: '', lines: [[{ t: 'img', src: 'a.png' }], [{ t: 'img', src: 'b.png' }]] });
    expect(answerQuestionLine(face([twoPictures], []))).toBe('');
    // Spaces only, or no question block at all: ''.
    expect(answerQuestionLine(face([block({ plain: ' ', lines: [[{ t: 'text', text: '  ' }]] })], []))).toBe('');
    expect(answerQuestionLine({ prompt: [], promptPlain: '' })).toBe('');
    // A headline with no text but a one-line question (promptPlain): that line.
    expect(answerQuestionLine({ prompt: [picture], promptPlain: 'Was ist das?' })).toBe('Was ist das?');
  });

  it('the typing verdict', () => {
    const t = (typed: string, expected: string) => verdictText(checkTyped(typed, { text: expected, lang: 'de-DE', role: 'term', multiline: false }));
    expect(t('die Abfahrt', 'die Abfahrt')).toBe('Correct');
    expect(t('Abfahrt', 'die Abfahrt')).toBe('Almost — remember the article:');
    expect(t('uber', 'über')).toBe('Almost — check the accents');
    expect(t('die Abfhart', 'die Abfahrt')).toBe('Almost — a small typo');
    expect(t('Bahnhof', 'die Abfahrt')).toBe('Not quite');
    // Wave 5b (L5): a missing English "to" / "the" is close, with its own words for "to".
    const en = (typed: string, expected: string) =>
      verdictText(checkTyped(typed, { text: expected, lang: 'en-US', role: 'meaning', multiline: false }));
    expect(en('sleep', 'to sleep / the sleep')).toBe('Almost — remember the “to”:');
    expect(en('hour', 'the hour')).toBe('Almost — remember the article:');
  });

  // Wave 5b (walkthrough M10): ✕ → "End session" went back with no summary.
  it('the early-exit snackbar: "Session saved · {n} cards · +{xp} XP" (plural)', () => {
    expect(earlyExitSnack(3, 12)).toBe('Session saved · 3 cards · +12 XP');
    expect(earlyExitSnack(1, 4)).toBe('Session saved · 1 card · +4 XP');
    expect(earlyExitSnack(1200, 2400)).toBe('Session saved · 1,200 cards · +2,400 XP');
  });

  // Wave 5d (F1a): "Session saved" replaced the card editor's GLOBAL "“Wort” deleted · Undo".
  it('earlyExitSnackDelay: "Session saved" waits for a global Undo message to end; anything else shows at once', () => {
    // Nothing on screen, or a message with no action (only words): now.
    expect(earlyExitSnackDelay(null, 1000, SNACK_ACTION_MS)).toBe(0);
    expect(earlyExitSnackDelay({ withAction: false, at: 0 }, 1000, SNACK_ACTION_MS)).toBe(0);
    // An Undo message shown 1 s ago: the rest of its time, then a short pause.
    expect(earlyExitSnackDelay({ withAction: true, at: 0 }, 1000, SNACK_ACTION_MS)).toBe(SNACK_ACTION_MS - 1000 + SAVED_AFTER_UNDO_GAP_MS);
    expect(earlyExitSnackDelay({ withAction: true, at: 0 }, 1000, 15000)).toBe(14000 + SAVED_AFTER_UNDO_GAP_MS); // a screen reader
    expect(earlyExitSnackDelay({ withAction: true, at: 0.4 }, 1000, SNACK_ACTION_MS)).toBe(5001 + SAVED_AFTER_UNDO_GAP_MS); // whole ms
    // Its time is over (it is gone): now.
    expect(earlyExitSnackDelay({ withAction: true, at: 0 }, SNACK_ACTION_MS, SNACK_ACTION_MS)).toBe(0);
    expect(earlyExitSnackDelay({ withAction: true, at: 0 }, 9000, SNACK_ACTION_MS)).toBe(0);
  });

  it('blockHasImage: a block with a picture is never one screen-reader element (R9)', () => {
    expect(blockHasImage(block({ plain: '', lines: [[{ t: 'img', src: 'tree.png' }]] }))).toBe(true);
    expect(blockHasImage(block({ plain: 'Was ist das?', lines: [[{ t: 'text', text: 'Was ist das?' }], [{ t: 'img', src: 'a.png' }]] }))).toBe(true);
    expect(blockHasImage(block({ plain: 'die Stunde' }))).toBe(false);
    expect(blockHasImage(undefined)).toBe(false);
  });
});

/* ================================================================ 5. end */

describe('Complete: "Keep going" rows, each the length of the session it opens', () => {
  it('hardest = the practice pool of the scope, ease ascending then lapses descending (spec §6.6)', () => {
    expect(hardestParams({})).toEqual({ kind: 'practice', q: {}, sort: HARDEST_SORT });
    expect(hardestParams({ decks: ['d1'], life: ['review', 'new'] })).toEqual({
      kind: 'practice',
      q: { decks: ['d1'], life: ['review', 'new'] },
      sort: HARDEST_SORT,
    });
    // The order: lowest ease first; the same ease → more lapses first.
    const base = germanState();
    const [x, y, z] = base.cards;
    const state = {
      ...base,
      cards: base.cards.map((c) =>
        c.id === x.id ? { ...c, ease: 1.9, lapses: 1 } : c.id === y.id ? { ...c, ease: 1.9, lapses: 4 } : c.id === z.id ? { ...c, ease: 1.5 } : c,
      ),
    };
    const queue = buildSessionQueue(hardestParams({}), state, ctxOf(state));
    expect(queue.slice(0, 3).map((c) => c.id)).toEqual([z.id, y.id, x.id]);
    // The Complete row opens this session through sessionHref → parseSessionRoute: the same cards (one definition).
    const viaRoute = start(state, parseSessionRoute(sessionHref(hardestParams({})).params));
    expect(viaRoute.queue.map((c) => c.id)).toEqual(queue.map((c) => c.id));
  });

  it('the counts are the session lengths (and the Not started count of the scope)', () => {
    const state = germanState();
    const missed = state.cards.slice(0, 2).map((c) => c.id);
    const counts = keepGoingCounts(state, {}, missed, ctxOf(state));
    expect(counts.retry).toBe(start(state, { kind: 'practice', sel: 'sel-1' }, missed).queue.length);
    expect(counts.ahead).toBe(start(state, { kind: 'ahead' }).queue.length);
    expect(counts.hardest).toBe(start(state, { kind: 'practice', q: {}, sort: HARDEST_SORT }).queue.length);
    // The practice pool: 2 reviews + 1 learning card + 6 New cards (never the Not started one).
    expect(counts.hardest).toBe(9);
    expect(counts.notStarted).toBe(1);
    expect(keepGoingCounts(state, {}, [], ctxOf(state)).retry).toBe(0);
  });

  it('rows with 0 are hidden; Retry missed ON → the box first, "Not now" hides it; OFF → a row', () => {
    const counts = { retry: 3, ahead: 0, hardest: 12, notStarted: 1240 };
    const on = keepGoingRows(counts, { retryMissed: true, retryDismissed: false, missedCount: 3 });
    expect(on.retryBox).toEqual({ text: 'You missed 3 cards. Practice them now?', cta: 'Practice 3', count: 3 });
    expect(on.rows.map((r) => r.title)).toEqual(['Practice your hardest · 12', 'Choose what to learn · 1,240 not started']);
    // Wave 5i: "Doesn’t" with the curly apostrophe, the same as the Complete screen's own line above it.
    expect(on.rows.find((r) => r.key === 'hardest')?.sub).toBe('Doesn’t change your schedule.');
    expect(NO_SCHEDULE_CHANGE).toBe('Doesn’t change your schedule.');
    expect(keepGoingRows(counts, { retryMissed: true, retryDismissed: true, missedCount: 3 }).retryBox).toBeNull();
    const off = keepGoingRows(counts, { retryMissed: false, retryDismissed: false, missedCount: 3 });
    expect(off.retryBox).toBeNull();
    expect(off.rows[0]).toMatchObject({ key: 'retry', title: 'Practice the 3 you missed' });
    const one = keepGoingRows({ retry: 1, ahead: 5, hardest: 0, notStarted: 0 }, { retryMissed: true, retryDismissed: false, missedCount: 1 });
    expect(one.retryBox?.text).toBe('You missed 1 card. Practice it now?');
    expect(one.rows.map((r) => r.title)).toEqual(['Study ahead · 5']);
    expect(keepGoingRows({ retry: 0, ahead: 0, hardest: 0, notStarted: 0 }, { retryMissed: true, retryDismissed: false, missedCount: 2 })).toEqual({
      retryBox: null,
      rows: [],
    });
  });

  // Wave 5c (walkthrough M6): "Choose what to learn · {n}" counted CARDS, but
  // the triage it opens counts ITEMS: "· 6" opened "0 / 3 items".
  // Review round 1: the spec's copy (§6.10) is "{n} not started", with no
  // unit word, also when an item has two directions.
  it('"Choose what to learn" counts the items triage shows, with the spec copy "· {n} not started"', () => {
    const state = stateOfV3({
      decks: [makeDeckV3({ id: 'd1', name: 'Capitals' })],
      groups: ['Paris', 'Rome', 'Oslo'].map((city, i) =>
        noteWithCards({
          deckId: 'd1',
          typeId: BUILTIN_TYPE_IDS.basicReverse,
          fields: [city, `capital ${i}`, '', ''],
          note: { id: `n-cap-${i}` },
          card: lifeValues('notStarted', NOW),
        }),
      ),
    });
    const ctx = ctxOf(state);
    const counts = keepGoingCounts(state, {}, [], ctx);
    // 3 items of 2 cards each: 3, never the 6 cards.
    expect(counts.notStarted).toBe(3);
    // The same number as the triage screen's counter (triage.tsx: triageItems over the scope pool).
    expect(counts.notStarted).toBe(triageItems(scopePool(state, {}, ctx, 'browse'), triageLookupOf(state, ctx)).length);
    const opts = { retryMissed: false, retryDismissed: false, missedCount: 0 };
    expect(keepGoingRows(counts, opts).rows.find((r) => r.key === 'choose')).toMatchObject({
      title: 'Choose what to learn · 3 not started',
      count: 3,
    });
    expect(keepGoingRows({ retry: 0, ahead: 0, hardest: 0, notStarted: 1240 }, opts).rows[0].title).toBe(
      'Choose what to learn · 1,240 not started',
    );
    // A direction turned off in the deck: triage skips its cards, and so does the count.
    // "Paris" was started one way: only its other way is Not started, and that way is off.
    const started: DataStateV3 = {
      ...state,
      cards: state.cards.map((c) => (c.noteId === 'n-cap-0' && c.ord === 0 ? { ...c, ...lifeValues('review', NOW) } : c)),
    };
    expect(keepGoingCounts(started, {}, [], ctxOf(started)).notStarted).toBe(3);
    const oneWay: DataStateV3 = {
      ...started,
      decks: started.decks.map((d) => ({ ...d, options: { ...d.options, directions: { [BUILTIN_TYPE_IDS.basicReverse]: [0] } } })),
    };
    const one = keepGoingCounts(oneWay, {}, [], ctxOf(oneWay));
    expect(one.notStarted).toBe(2);
    expect(one.notStarted).toBe(triageItems(scopePool(oneWay, {}, ctxOf(oneWay), 'browse'), triageLookupOf(oneWay, ctxOf(oneWay))).length);
    expect(keepGoingRows(one, opts).rows.find((r) => r.key === 'choose')?.title).toBe('Choose what to learn · 2 not started');
  });

  // Final review (session area): after an "All decks" session (Today's hero passes `{}`), "Practice
  // your hardest" and "Choose what to learn" counted and opened the BROWSE pool of `{}`: a paused
  // deck's cards came first in "Your hardest cards", and "Choose what to learn · 32" opened triage on
  // a paused deck (and on suspended Not started cards), while Today's own buttons left them out.
  it('after an "All decks" session the hardest and choose rows leave a paused deck out, like Today', () => {
    const word = (deckId: string, i: number, life: 'review' | 'notStarted', card: Partial<Card> = {}) =>
      noteWithCards({
        deckId,
        fields: [`${deckId} front ${i}`, `${deckId} back ${i}`, '', ''],
        note: { id: `n-${deckId}-${life}-${i}` },
        card: { ...lifeValues(life, NOW), ...(life === 'review' ? { due: NOW + 5 * DAY, ease: 2.5 } : {}), ...card },
      });
    const state = stateOfV3({
      decks: [makeDeckV3({ id: 'act', name: 'Active', order: 0 }), makeDeckV3({ id: 'pz', name: 'Paused', order: 1, active: false })],
      groups: [
        word('act', 0, 'review'),
        word('act', 1, 'review'),
        word('act', 2, 'notStarted'),
        word('act', 3, 'notStarted', { suspended: true }),
        ...Array.from({ length: 3 }, (_, i) => word('pz', i, 'review', { ease: 1.3 })),
        ...Array.from({ length: 30 }, (_, i) => word('pz', 10 + i, 'notStarted')),
      ],
      overrides: { settings: makeSettingsV3({ sessionLimit: 0 }) },
    });
    const ctx = ctxOf(state);
    // Today's own numbers (TodayHero: PRACTICE_SCOPE, NOT_STARTED_SCOPE).
    const todayPractice = buildSessionQueue({ kind: 'practice', q: PRACTICE_SCOPE }, state, ctx);
    const todayChoose = triageItems(scopePool(state, NOT_STARTED_SCOPE, ctx, 'browse'), triageLookupOf(state, ctx));
    expect([todayPractice.length, todayChoose.length]).toEqual([2, 1]);

    // Over `{}` (the hero, "Study ahead") and over Today's "Practice" scope: Today's scopes and numbers.
    for (const scope of [{}, PRACTICE_SCOPE]) {
      expect(keepGoingScopes(scope)).toEqual({ practice: PRACTICE_SCOPE, choose: NOT_STARTED_SCOPE });
      const counts = keepGoingCounts(state, scope, [], ctx);
      expect(counts.hardest).toBe(todayPractice.length);
      expect(counts.notStarted).toBe(todayChoose.length);
      expect(counts.ahead).toBe(2); // "Study ahead" always left the paused deck out (the study pool)
      // Each number is the length of what its row opens (complete.tsx: hardestParams / triage of keepGoingScopes).
      const hardest = buildSessionQueue(hardestParams(keepGoingScopes(scope).practice), state, ctx);
      expect(hardest.length).toBe(counts.hardest);
      expect(hardest.every((c) => c.deckId === 'act')).toBe(true); // never a paused deck's card first
      const opened = triageItems(scopePool(state, keepGoingScopes(scope).choose, ctx, 'browse'), triageLookupOf(state, ctx));
      expect(opened.length).toBe(counts.notStarted);
    }

    // A scope that NAMES the paused deck stays as it is: its own page still offers its cards.
    const pausedDeck = { decks: ['pz'] };
    expect(keepGoingScopes(pausedDeck)).toEqual({ practice: pausedDeck, choose: pausedDeck });
    const named = keepGoingCounts(state, pausedDeck, [], ctx);
    expect(named.hardest).toBe(3);
    expect(named.notStarted).toBe(30);
  });

  // W5-5a: "Study ahead" from Complete (and from the empty queue) carried the
  // old label for every kind, so a Study ahead of deck D after "Practice your
  // hardest" was recorded as "Your hardest cards".
  it('a follow-up session carries the old label only when it names the scope (Study, Study ahead)', () => {
    const deck = { decks: ['d1'] };
    expect(followUpLabel({ kind: 'scheduled', label: 'German', scope: deck })).toBe('German');
    expect(followUpLabel({ kind: 'ahead', label: 'B1 verbs', scope: { list: 'l1' } })).toBe('B1 verbs');
    // A label that names the practice, not the scope: the new session names itself.
    expect(followUpLabel({ kind: 'practice', label: HARDEST_LABEL, scope: deck })).toBeUndefined();
    expect(followUpLabel({ kind: 'practice', label: MISSED_LABEL, scope: deck })).toBeUndefined();
    expect(followUpLabel({ kind: 'practice', label: 'Practice', scope: { notFlags: ['paused'] } })).toBeUndefined(); // Today's "Practice"
    expect(followUpLabel({ kind: 'cram', label: 'Old cram', scope: deck })).toBeUndefined(); // a legacy record kind
    // A selection, or all decks: never carried.
    expect(followUpLabel({ kind: 'scheduled', label: '12 selected cards', scope: deck, selection: true })).toBeUndefined();
    expect(followUpLabel({ kind: 'scheduled', label: 'All decks', scope: {} })).toBeUndefined();
    expect(followUpLabel({ kind: 'scheduled', label: '', scope: deck })).toBeUndefined();
    // Without a label, the new session takes the deck's own name (sessionLabel).
    const state = germanState();
    const ahead = parseSessionRoute(sessionHref({ kind: 'ahead', q: deck, label: followUpLabel({ kind: 'practice', label: 'Your hardest cards', scope: deck }) }).params);
    expect(startSession(ahead, state, ctxOf(state), DAY_KEY, null).label).toBe('German');
  });

  // W5-5a review round 1: followUpLabel dropped EVERY Practice label, so a
  // "Study ahead" after a Library Practice over chips was "Filtered cards"
  // (it was "German · Level: B1" before). Those labels name the scope.
  it('a Practice label that names the scope (Library chips, the deck page) is carried', () => {
    const state = germanState();
    const chips = { decks: ['d1'], fields: fieldRecord([['level', ['b1']]]) };
    // The Library's "Practice {n}" sends the chip label (libraryState practiceQueryRoute).
    const practice = startSession(
      parseSessionRoute(practiceQueryRoute(chips, { by: 'source' }, 'German · Level: B1').params),
      state,
      ctxOf(state),
      DAY_KEY,
      null,
    );
    expect(practice.label).toBe('German · Level: B1');
    const label = followUpLabel({ kind: practice.kind, label: practice.label, scope: practice.scope });
    expect(label).toBe('German · Level: B1');
    const ahead = startSession(parseSessionRoute(sessionHref({ kind: 'ahead', q: practice.scope, label }).params), state, ctxOf(state), DAY_KEY, null);
    expect(ahead.label).toBe('German · Level: B1'); // not "Filtered cards"
    // The deck page's "Practice your hardest" / "Practice articles" pass the deck's name.
    expect(followUpLabel({ kind: 'practice', label: 'German', scope: { decks: ['d1'], hard: true } })).toBe('German');
  });

  // W5-5a: Progress used the content pack's level names, Complete the generic payout name.
  it('the Complete level line uses the level names of the build (a pack may rename them)', () => {
    expect(completeLevelLine(6, levelNames(undefined), false)).toBe('Level 6 · Keeper');
    const pack = levelNames(['Beginner', 'Learner', 'Reader', 'Speaker', 'Writer', 'Linguist']);
    expect(completeLevelLine(6, pack, false)).toBe('Level 6 · Linguist');
    expect(completeLevelLine(7, pack, true)).toBe('Level 7 · Maker  — level up!'); // past the pack's list: the generic name
    // The same name as Progress shows for the same XP.
    expect(completeLevelLine(levelInfo(xpForLevel(6)).level, pack, false)).toContain(levelInfo(xpForLevel(6), pack).name);
  });

  it('the empty queue: buttons only with a count above 0; "new cards are done" only for an empty Study session', () => {
    expect(emptyQueueActions({ ahead: 0, practice: 0 })).toEqual([]);
    expect(emptyQueueActions({ ahead: 12, practice: 1240 }).map((a) => a.title)).toEqual(['Study ahead · 12', 'Practice · 1,240']);
    expect(emptyQueueActions({ ahead: 0, practice: 4 }).map((a) => a.key)).toEqual(['practice']);
    // A deck with only New cards, today's new-card limit used up: the Study session is empty.
    const state = germanState({ srs: { dailyNewLimit: 0 } });
    const newOnly = state.cards.filter((c) => life(c) === 'new');
    const newDeck = { ...state, cards: newOnly };
    expect(start(newDeck).queue).toHaveLength(0);
    const studyPool = scopePool(newDeck, {}, ctxOf(newDeck), 'study');
    expect(emptyQueueLine('scheduled', studyPool)).toBe('Today’s new cards are done. Come back tomorrow, or practice.');
    expect(emptyQueueLine('scheduled', [])).toBe('You’re all caught up.');
    // An empty Study ahead (or Practice) session: the daily new-card limit did not cut it,
    // so "today's new cards are done" would be false (3 New cards may still be allowed today).
    const open = germanState({ srs: { dailyNewLimit: 3 } });
    const newOnlyOpen = { ...open, cards: open.cards.filter((c) => life(c) === 'new') };
    expect(start(newOnlyOpen, { kind: 'ahead' }).queue).toHaveLength(0);
    const openPool = scopePool(newOnlyOpen, {}, ctxOf(newOnlyOpen), 'study');
    expect(emptyQueueLine('ahead', openPool)).toBe('You’re all caught up.');
    expect(emptyQueueLine('practice', openPool)).toBe('You’re all caught up.');
  });
});

/* ================================================================ 6. whole sessions through the reducer */

/**
 * Drive a session the way session.tsx does: reveal, rateCard (the real
 * reducer), rateRun with the card rateCard RETURNED, and the marker after
 * every rating. `ratings` are used in turn.
 */
function drive(state: DataStateV3, r: SessionRoute, ratings: Rating[], selIds: string[] | null = null) {
  const s = startSession(r, state, ctxOf(state), DAY_KEY, selIds);
  let run = initialRun(s.queue, s.plans);
  let st = state;
  let finalCard: Card | undefined;
  let i = 0;
  let at = NOW;
  for (;;) {
    const card = currentCard(run);
    if (!card) break;
    at += 5000;
    run = patchUi(run, { revealed: true, revealedAt: at - 1000, article: s.mode === 'article' ? 'die' : null });
    const rating = ratings[i % ratings.length];
    i += 1;
    const step = rateCard(st, { cardId: card.id, rating, kind: r.kind }, testCtx(at));
    st = step.state;
    const out = rateRun(run, { rating, rated: step.result!, wrote: routeWrites(r.kind), now: at });
    run = out.next;
    if (out.finished) {
      finalCard = step.result!;
      break;
    }
    st = { ...st, inProgressSession: markerOf(run, { kind: r.kind, label: s.label, durationSec: 5, studyDay: DAY_KEY, mode: s.mode }, out.reviewed) };
    if (i > 200) throw new Error('the session never ends');
  }
  return { start: s, run, state: st, finalCard };
}

describe('whole sessions (the real reducer)', () => {
  it('Study: every card is rated once (+ the Again copies), and finalCard is the rated card (M6)', () => {
    const state = germanState({ srs: { dailyNewLimit: 2 } });
    const out = drive(state, route(), ['good', 'again', 'good', 'easy']);
    const total = out.run.idx + 1;
    expect(total).toBe(out.start.queue.length + out.run.counts.again);
    expect(out.finalCard).toEqual(out.state.cards.find((c) => c.id === out.finalCard!.id));
    expect(out.state.reviewLog).toHaveLength(total);
    expect(out.state.person.dayDone.reviews + out.state.person.dayDone.neww).toBe(total);
    // The Again copy carried the post-Again card: a learning step, not the old review state (M10).
    const missedId = out.run.missed[0];
    const copy = out.run.queue.find((c, i) => i > 0 && c.id === missedId && c.requeued);
    expect(copy?.stepIndex).not.toBeNull();
  });

  it('Practice of the missed cards (retry) leaves the schedule, the daily counts and the review log alone (H3)', () => {
    const state = germanState();
    const missed = state.cards.slice(0, 3).map((c) => c.id);
    const out = drive(state, route({ kind: 'practice', sel: 'sel-1' }), ['again', 'good', 'hard'], missed);
    expect(out.run.counts.again).toBeGreaterThan(0);
    expect(out.state.cards).toBe(state.cards);
    expect(out.state.reviewLog).toBe(state.reviewLog);
    expect(out.state.person.dayDone).toBe(state.person.dayDone);
    expect(out.finalCard).toBeDefined();
    // A practice session is still recorded and pays XP (D5).
    const banked = completeSession(out.state, { kind: 'practice', label: 'Missed cards', counts: out.run.counts, total: out.run.idx + 1, bestRun: out.run.bestRun, durationSec: 30, fastAnswers: 0, mode: 'flash' }, testCtx(NOW + DAY / 4));
    expect(banked.state.sessions.at(-1)).toMatchObject({ kind: 'practice' });
    expect(banked.state.cards).toBe(state.cards);
    expect(banked.state.reviewLog).toBe(state.reviewLog);
  });

  it('Articles (practice): right / wrong counts, nothing written (H3)', () => {
    const state = germanState({ sessionLimit: 0 });
    const out = drive(state, route({ kind: 'practice', mode: 'article' }), ['good']);
    expect(out.start.queue.length).toBe(articleCards(out.start.queue, faceOfState(state), 0).length);
    expect(out.state.cards).toBe(state.cards);
    expect(out.state.reviewLog).toBe(state.reviewLog);
    expect(out.state.person.dayDone).toBe(state.person.dayDone);
  });

  it('a Check (a Known card): the rating buttons say what rateCard really does', () => {
    const base = germanState();
    const knownId = base.cards.find((c) => c.noteId === 'n-stunde')!.id;
    // A Known card that was studied before, with a 60-day interval.
    const state = {
      ...base,
      cards: base.cards.map((c) =>
        c.id === knownId ? { ...c, ...lifeValues('mastered', NOW), intervalDays: 60, knownAt: NOW - 90 * DAY } : c,
      ),
    };
    const card = state.cards.find((c) => c.id === knownId)!;
    const srs = state.settings.srs;
    const pred = ratingPredictions(card, srs, true)!;
    expect(pred.again).toBe('soon');
    expect(pred.good).toBe(KNOWN_INTERVAL);
    expect(pred.easy).toBe(KNOWN_INTERVAL);
    // The bug: the SM-2 preview of the old 60-day interval ("Good · 5mo") — nothing like that is scheduled.
    expect(predictAll(card, srs).good).not.toBe(KNOWN_INTERVAL);

    // Good / Easy: the Check is passed. The card stays Known; its schedule does not change.
    for (const rating of ['good', 'easy'] as const) {
      const rated = rateCard(state, { cardId: knownId, rating, kind: 'scheduled' }, testCtx(NOW)).result!;
      expect(rated.knownAt).toBe(card.knownAt);
      expect(rated.due).toBe(card.due);
      expect(rated.intervalDays).toBe(60);
    }
    // Hard: the Check is missed. The card starts Learning at step 0: the button shows THAT interval.
    const hard = rateCard(state, { cardId: knownId, rating: 'hard', kind: 'scheduled' }, testCtx(NOW)).result!;
    expect(hard.knownAt).toBeNull();
    expect(hard.stepIndex).toBe(0);
    expect(pred.hard).toBe(formatDelay(hard.due - NOW));
    expect(pred.hard).not.toBe(predictAll(card, srs).hard); // not the days of the old review interval

    // The texts the learner sees and hears.
    expect(rateSnack('good', pred.good, 'die Stunde')).toBe('Rated Good · stays Known');
    expect(ratingA11yLabel('easy', pred.easy, false)).toBe('Easy. Stays Known.');
    // Every other card: predictAll as before; Practice: no intervals at all.
    const review = state.cards.find((c) => c.noteId === 'n-tag')!;
    expect(ratingPredictions(review, srs, true)).toEqual(predictAll(review, srs));
    expect(ratingPredictions(card, srs, false)).toBeNull();
  });

  it('undo of a written rating: undoLastReview + undoRun bring the card and the tallies back', () => {
    const state = germanState();
    const s = start(state);
    let run = patchUi(initialRun(s.queue, s.plans), { revealed: true, revealedAt: NOW });
    const card = currentCard(run)!;
    const step = rateCard(state, { cardId: card.id, rating: 'again', kind: 'scheduled' }, testCtx(NOW + 1000));
    run = rateRun(run, { rating: 'again', rated: step.result!, wrote: true, now: NOW + 1000 }).next;
    const back = undoRun(run, () => false)!;
    expect(back.snapshot.wrote).toBe(true);
    const undone = undoLastReview(step.state, undefined, testCtx(NOW + 2000)).state;
    expect(undone.cards.find((c) => c.id === card.id)).toEqual(card);
    expect(undone.reviewLog).toHaveLength(0);
    expect(back.next.queue).toEqual(s.queue);
    expect(currentUi(back.next).revealed).toBe(true);
  });
});

/* ================================================================ 7. read aloud */

describe('read aloud (src/domain/speech.ts, spec §6.8)', () => {
  beforeEach(() => {
    mockSpeak.mockClear();
    mockVoices = [];
    resetVoiceNoticesForTests();
  });

  it('speaks with the field language and a slower rate; no language → the phone voice; empty text says nothing', () => {
    speak('die Stunde', 'de-DE');
    expect(mockSpeak).toHaveBeenLastCalledWith('die Stunde', { language: 'de-DE', rate: SPEECH_RATE });
    speak('the hour');
    expect(mockSpeak).toHaveBeenLastCalledWith('the hour', { rate: SPEECH_RATE });
    speak('   ', 'de-DE');
    expect(mockSpeak).toHaveBeenCalledTimes(2);
    expect(speechOptions('  ')).toEqual({ rate: SPEECH_RATE });
  });

  it('🔊 speaks the headline of the visible side in its language (speechOf), never the dictation emoji', () => {
    const state = germanState();
    const card = state.cards.find((c) => c.noteId === 'n-stunde')!;
    const f = faceOfState(state)(card);
    const front = speechOf(f, 'prompt');
    speak(front.text, front.lang);
    expect(mockSpeak).toHaveBeenLastCalledWith('die Stunde', { language: 'de-DE', rate: SPEECH_RATE });
    const back = speechOf(f, 'answer');
    speak(back.text, back.lang);
    expect(mockSpeak).toHaveBeenLastCalledWith('the hour', { language: 'en-US', rate: SPEECH_RATE });
  });

  it('a voice is found by its language part (de-AT reads de-DE; Android deu-DEU too)', () => {
    expect(hasVoiceFor([{ language: 'de-AT' }], 'de-DE')).toBe(true);
    expect(hasVoiceFor([{ language: 'deu-DEU' }], 'de-DE')).toBe(true);
    expect(hasVoiceFor([{ language: 'en-US' }], 'de-DE')).toBe(false);
    expect(missingVoiceMessage('de-DE')).toBe('No German voice on this phone. You can add one in system settings.');
  });

  it('the "no voice" note shows ONCE per language; an empty voice list (not loaded yet) decides nothing', async () => {
    mockVoices = [];
    await expect(missingVoiceNotice('de-DE')).resolves.toBeNull();
    mockVoices = [{ language: 'en-US' }];
    await expect(missingVoiceNotice('de-DE')).resolves.toBe(missingVoiceMessage('de-DE'));
    await expect(missingVoiceNotice('de-DE')).resolves.toBeNull();
    await expect(missingVoiceNotice('en-GB')).resolves.toBeNull(); // an English voice exists
    await expect(missingVoiceNotice(undefined)).resolves.toBeNull();
  });
});

/* ================================================================ 8. components */

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

/** Every host Text's own text. */
function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => {
      const kids = n.props.children;
      return (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === 'string' || typeof k === 'number').join('');
    });
}

/** The pressable (with onPress) whose screen-reader label is `label`. */
function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return r.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
}

/** The host Text whose text is exactly `text`. */
function textNode(r: ReactTestRenderer, text: string): ReactTestInstance | undefined {
  return r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text)[0];
}

/** A flat style object of a node. */
function flat(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (s: unknown) => {
    if (Array.isArray(s)) s.forEach(walk);
    else if (s && typeof s === 'object') Object.assign(out, s);
  };
  walk(style);
  return out;
}

describe('RatingButtons', () => {
  it('outlines the suggested rating, and says each interval; practice shows no interval', () => {
    const onRate = jest.fn<(r: Rating) => void>();
    const r = render(
      React.createElement(RatingButtons, {
        pred: { again: 'soon', hard: '1d', good: '3d', easy: '6d' },
        suggested: 'good',
        onRate,
      }),
    );
    const good = byLabel(r, 'Good, suggested. Next in 3 days.')!;
    expect(good).toBeDefined();
    act(() => good.props.onPress());
    expect(onRate).toHaveBeenCalledWith('good');
    const styleOf = (n: ReactTestInstance) => flat(typeof n.props.style === 'function' ? n.props.style({ pressed: false }) : n.props.style);
    expect(styleOf(good).borderWidth).toBe(2);
    expect(styleOf(byLabel(r, 'Hard. Next in 1 day.')!).borderWidth).toBe(1);
    act(() => r.update(React.createElement(RatingButtons, { pred: null, onRate })));
    expect(byLabel(r, 'Easy. Doesn’t change your schedule.')).toBeDefined();
    expect(texts(r).filter((t) => t === '—')).toHaveLength(4);
    // A Check: Good / Easy keep the card Known.
    act(() =>
      r.update(
        React.createElement(RatingButtons, { pred: { again: 'soon', hard: '1m', good: KNOWN_INTERVAL, easy: KNOWN_INTERVAL }, onRate }),
      ),
    );
    expect(byLabel(r, 'Good. Stays Known.')).toBeDefined();
    expect(byLabel(r, 'Hard. Next in 1 minute.')).toBeDefined();
    expect(texts(r).filter((t) => t === KNOWN_INTERVAL)).toHaveLength(2);
  });
});

// Wave 5b (walkthrough M1): Suspend / Reschedule / Bury on the LAST card.
describe('AllDoneHere', () => {
  it('shows the message, keeps its Undo on screen, and finishes the session', () => {
    const onUndo = jest.fn();
    const onFinish = jest.fn();
    const r = render(React.createElement(AllDoneHere, { message: 'Suspended', rated: 3, onUndo, onFinish }));
    const all = texts(r);
    expect(all).toContain(ALL_DONE_COPY.title);
    expect(all).toContain('Suspended');
    expect(all).toContain(ALL_DONE_COPY.last);
    act(() => byLabel(r, 'Undo: Suspended')!.props.onPress());
    expect(onUndo).toHaveBeenCalledTimes(1);
    act(() => byLabel(r, ALL_DONE_COPY.finish)!.props.onPress());
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('nothing rated: "Back"; nothing to undo (a deleted card): no Undo button', () => {
    const onFinish = jest.fn();
    const r = render(React.createElement(AllDoneHere, { message: 'Card deleted', rated: 0, onFinish }));
    expect(byLabel(r, ALL_DONE_COPY.finish)).toBeUndefined();
    act(() => byLabel(r, ALL_DONE_COPY.leave)!.props.onPress());
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').startsWith('Undo'))).toHaveLength(0);
  });
});

describe('CardActionsSheet', () => {
  const props = () => ({
    title: 'die Stunde',
    flagged: false,
    canReschedule: true,
    modeLabel: 'Flashcards',
    open: true,
    onClose: jest.fn(),
    onEdit: jest.fn(),
    onReschedule: jest.fn(),
    onBury: jest.fn(),
    onFlag: jest.fn(),
    onSuspend: jest.fn(),
    onSwitchMode: jest.fn(),
    onInfo: jest.fn(),
  });

  it('every row does what it says; Flag / Unflag reads the flag it is given (the store copy)', () => {
    const p = props();
    const r = render(React.createElement(CardActionsSheet, p));
    const all = texts(r);
    for (const title of [CARD_ACTIONS_COPY.edit, CARD_ACTIONS_COPY.reschedule, CARD_ACTIONS_COPY.bury, 'Flag', CARD_ACTIONS_COPY.suspend, CARD_ACTIONS_COPY.switchMode, CARD_ACTIONS_COPY.info]) {
      expect(all).toContain(title);
    }
    const press = (text: string) => {
      let at: ReactTestInstance | null = textNode(r, text)!;
      while (at && typeof at.props.onPress !== 'function') at = at.parent;
      act(() => at!.props.onPress());
    };
    press(CARD_ACTIONS_COPY.edit);
    press(CARD_ACTIONS_COPY.reschedule);
    press(CARD_ACTIONS_COPY.bury);
    press('Flag');
    press(CARD_ACTIONS_COPY.suspend);
    press(CARD_ACTIONS_COPY.switchMode);
    press(CARD_ACTIONS_COPY.info);
    for (const fn of [p.onEdit, p.onReschedule, p.onBury, p.onFlag, p.onSuspend, p.onSwitchMode, p.onInfo]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    act(() => r.update(React.createElement(CardActionsSheet, { ...p, flagged: true })));
    expect(texts(r)).toContain('Unflag');
    expect(texts(r)).toContain('Now: Flashcards · for this session only');
  });

  it('a card without a schedule cannot be rescheduled: the row says why and does nothing', () => {
    const p = { ...props(), canReschedule: false };
    const r = render(React.createElement(CardActionsSheet, p));
    expect(texts(r)).toContain(NOTHING_TO_RESCHEDULE);
    let at: ReactTestInstance | null = textNode(r, CARD_ACTIONS_COPY.reschedule)!;
    while (at && typeof at.props.onPress !== 'function') at = at.parent;
    // The nearest pressable above the row is the sheet's own panel/scrim, never the row.
    expect(at?.props.accessibilityLabel).not.toBe(CARD_ACTIONS_COPY.reschedule);
  });
});

describe('StudyCard', () => {
  const base = {
    deckId: 'd1',
    step: null,
    canSpeak: true,
    genderColors: true,
    onSpeak: () => undefined,
  };

  it('the front: the badges in their own row ABOVE the text, the tap label, the speaker button', () => {
    const f = face([block({ plain: 'Stunde', role: 'meaning' })], [block({ plain: 'hour', role: 'meaning', field: 1 })], [
      block({ plain: 'B1', role: 'badge', field: 5, label: 'Level' }),
      block({ plain: 'Core Patterns', role: 'badge', field: 6, label: 'Tag' }),
    ]);
    const onReveal = jest.fn();
    const r = render(React.createElement(StudyCard, { ...base, face: f, revealed: false, onReveal }));
    const all = texts(r);
    // Badges come before the question in the tree: their own row on top.
    expect(all.indexOf('Core Patterns')).toBeLessThan(all.indexOf('Stunde'));
    const card = byLabel(r, 'Card. Stunde. Double tap to reveal.')!;
    act(() => card.props.onPress());
    expect(onReveal).toHaveBeenCalled();
    expect(byLabel(r, 'Read aloud')).toBeDefined();
  });

  it('Typing: with the keyboard open, ONE tap on "Check" checks (the body ScrollView passes the tap on)', () => {
    const onCheck = jest.fn<(typed: string) => void>();
    const f = face([block({ plain: 'the departure', role: 'meaning' })], [block({ plain: 'die Abfahrt', field: 1 })]);
    const r = render(
      React.createElement(StudyCard, {
        ...base,
        face: f,
        revealed: false,
        questionExtra: React.createElement(TypingAnswer, { result: null, onCheck, autoFocus: false }),
      }),
    );
    // The TextInput and "Check" are inside the card's body ScrollView…
    const scroll = r.root.findAll((n) => n.props.keyboardShouldPersistTaps !== undefined && typeof n.type !== 'string')[0];
    expect(scroll).toBeDefined();
    expect(scroll.findAll((n) => typeof n.props.onChangeText === 'function')).not.toHaveLength(0);
    // …so it must not take the first tap to close the keyboard ('never', the default, does that).
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    act(() => byLabel(r, 'Check')!.props.onPress());
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  // W5-5a: the "Card. {question}." label was only on the Flashcards front.
  it('Typing, Quiz and Articles: the question headline is one element "Card. {question}."; the controls stay apart', () => {
    const f = face([block({ plain: 'the departure', role: 'meaning' })], [block({ plain: 'die Abfahrt', field: 1 })]);
    const typing = React.createElement(TypingAnswer, { result: null, onCheck: () => undefined, autoFocus: false });
    const r = render(React.createElement(StudyCard, { ...base, face: f, revealed: false, questionExtra: typing }));
    const head = r.root.findAll((n) => n.props.accessible === true && n.props.accessibilityLabel === 'Card. the departure.')[0];
    expect(head).toBeDefined();
    // The typing field is NOT inside the labelled element: it is reached on its own.
    expect(head.findAll((n) => typeof n.props.onChangeText === 'function')).toHaveLength(0);
    expect(byLabel(r, 'Check')).toBeDefined();
    // No "Double tap to reveal": a tap does not reveal here.
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').includes('Double tap'))).toHaveLength(0);
    // Articles: the label says the bare word that is shown, never "die Abfahrt".
    const term = face([block({ plain: 'die Abfahrt' })], [block({ plain: 'the departure', role: 'meaning', field: 1 })]);
    const shown = React.createElement(Text, null, 'Abfahrt');
    act(() => r.update(React.createElement(StudyCard, { ...base, face: term, revealed: false, promptOverride: shown, promptLabel: 'Abfahrt' })));
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card. Abfahrt.')).not.toHaveLength(0);
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').includes('die Abfahrt'))).toHaveLength(0);
    // Flashcards keep the one tappable card label.
    act(() => r.update(React.createElement(StudyCard, { ...base, face: f, revealed: false, onReveal: () => undefined })));
    expect(byLabel(r, 'Card. the departure. Double tap to reveal.')).toBeDefined();
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card. the departure.')).toHaveLength(0);
  });

  // Wave 5b (R9): the "Card. {question}." group swallowed a picture in the
  // Typing / Quiz headline, so a screen reader could not stop on it.
  it('Typing / Quiz: a picture in the question headline stays its own "Picture" element', () => {
    const lines = [[{ t: 'text' as const, text: 'Was ist das?' }], [{ t: 'img' as const, src: 'tree.png' }]];
    const f = face([block({ plain: 'Was ist das?', role: 'meaning', lines })], [block({ plain: 'der Baum', field: 1 })]);
    const typing = React.createElement(TypingAnswer, { result: null, onCheck: () => undefined, autoFocus: false });
    const r = render(React.createElement(StudyCard, { ...base, face: f, revealed: false, questionExtra: typing }));
    const picture = byLabel(r, 'Picture');
    expect(picture).toBeDefined();
    expect(picture!.props.accessibilityRole).toBe('imagebutton');
    // No ancestor groups it into one element: the screen reader can stop on the picture.
    for (let at = picture!.parent; at; at = at.parent) expect(at.props.accessible).not.toBe(true);
    // The card label is still there, on the question's line of text.
    const label = r.root.findAll((n) => n.props.accessibilityLabel === 'Card. Was ist das?');
    expect(label.length).toBeGreaterThan(0);
    expect(label[0].findAll((n) => n.props.accessibilityLabel === 'Picture')).toHaveLength(0);
    // A question field with a picture is not one element either.
    const rest = face(
      [block({ plain: 'Was ist das?', role: 'meaning' }), block({ plain: '', role: 'detail', field: 2, label: 'Bild', lines: [[{ t: 'img', src: 'a.png' }]] })],
      [block({ plain: 'der Baum', field: 1 })],
    );
    act(() => r.update(React.createElement(StudyCard, { ...base, face: rest, revealed: false, questionExtra: typing })));
    const second = byLabel(r, 'Picture')!;
    for (let at = second.parent; at; at = at.parent) expect(at.props.accessible).not.toBe(true);
    // A headline without a picture keeps its one "Card. {question}." element.
    expect(r.root.findAll((n) => n.props.accessible === true && n.props.accessibilityLabel === 'Card. Was ist das?')).not.toHaveLength(0);
  });

  // Review round 2: the label on the first line said the text of the WHOLE
  // headline, so the later lines were read twice: "Card. Was ist das? (ein
  // Tier).", "Picture", then "(ein Tier)" again.
  it('Typing / Quiz: a headline with a picture and two lines of text reads each line once', () => {
    const lines = [
      [{ t: 'text' as const, text: 'Was ist ' }, { t: 'text' as const, text: 'das?', b: true }],
      [{ t: 'img' as const, src: 'tree.png' }],
      [{ t: 'text' as const, text: '(ein Tier)' }],
    ];
    const f = face([block({ plain: 'Was ist das? (ein Tier)', role: 'meaning', lines })], [block({ plain: 'der Baum', field: 1 })]);
    const typing = React.createElement(TypingAnswer, { result: null, onCheck: () => undefined, autoFocus: false });
    const r = render(React.createElement(StudyCard, { ...base, face: f, revealed: false, questionExtra: typing }));
    // The first line: the card label with ONLY its own text (its bold part included).
    const first = r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.accessibilityLabel === 'Card. Was ist das?');
    expect(first).toHaveLength(1);
    // No label says the second line: the screen reader reads it once, from its own Text.
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').includes('ein Tier'))).toHaveLength(0);
    expect(texts(r)).toContain('(ein Tier)');
    // The picture is still its own element.
    expect(byLabel(r, 'Picture')).toBeDefined();
  });

  // Wave 5c (R9 read order): the card label sat on the first line of TEXT,
  // also when a picture came before it. A screen reader then said "Picture",
  // then "Card. Was ist das?" — the start of the card in the middle.
  it('Typing / Quiz: the headline is read in the order it is drawn, and "Card." comes first (also before a picture)', () => {
    /** True for a host Text inside another host Text (a styled part of a line, read with its line). */
    const nestedText = (n: ReactTestInstance): boolean => {
      for (let at = n.parent; at; at = at.parent) if ((at.type as unknown) === 'Text') return true;
      return false;
    };
    /** The whole text of a host Text and its parts. */
    const fullText = (n: ReactTestInstance): string =>
      n.findAll((k) => (k.type as unknown) === 'Text').map((k) => [k.props.children].flat().filter((x) => typeof x === 'string').join('')).join('');
    /** What a screen reader stops on, in tree order: pictures (their label) and lines of text (their label or text). */
    const readOrder = (r: ReactTestRenderer): string[] =>
      r.root
        .findAll(
          (n) =>
            (typeof n.type !== 'string' && n.props.accessibilityRole === 'imagebutton') ||
            (typeof n.type === 'string' && n.props.accessibilityLabel?.startsWith('Card. Picture')) ||
            ((n.type as unknown) === 'Text' && !nestedText(n)),
        )
        .map((n) => n.props.accessibilityLabel ?? fullText(n))
        .filter((t, i, all) => t !== '' && t !== 'Check' && all.indexOf(t) === i);
    const typing = React.createElement(TypingAnswer, { result: null, onCheck: () => undefined, autoFocus: false });
    // A picture first, then two lines of text.
    const pictureFirst = [
      [{ t: 'img' as const, src: 'tree.png' }],
      [{ t: 'text' as const, text: 'Was ist das?' }],
      [{ t: 'text' as const, text: '(ein Tier)' }],
    ];
    const f = face([block({ plain: 'Was ist das? (ein Tier)', role: 'meaning', lines: pictureFirst })], [block({ plain: 'der Baum', field: 1 })]);
    const r = render(React.createElement(StudyCard, { ...base, face: f, revealed: false, questionExtra: typing }));
    expect(readOrder(r).slice(0, 3)).toEqual(['Card. Picture.', 'Was ist das?', '(ein Tier)']);
    expect(byLabel(r, 'Card. Picture.')!.props.accessibilityRole).toBe('imagebutton');
    // "Card." is said once.
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').startsWith('Card.') && typeof n.type === 'string')).toHaveLength(1);
    // Text first: the first line says "Card." with its own text, the picture after it is "Picture".
    const textFirst = [pictureFirst[1], pictureFirst[0], pictureFirst[2]];
    const g = face([block({ plain: 'Was ist das? (ein Tier)', role: 'meaning', lines: textFirst })], [block({ plain: 'der Baum', field: 1 })]);
    act(() => r.update(React.createElement(StudyCard, { ...base, face: g, revealed: false, questionExtra: typing })));
    expect(readOrder(r).slice(0, 3)).toEqual(['Card. Was ist das?', 'Picture', '(ein Tier)']);
    // A picture that cannot be shown starts the card the same way.
    const missing = [[{ t: 'img' as const, src: 'missing.png' }], pictureFirst[1]];
    const h = face([block({ plain: 'Was ist das?', role: 'meaning', lines: missing })], [block({ plain: 'der Baum', field: 1 })]);
    act(() => r.update(React.createElement(StudyCard, { ...base, face: h, revealed: false, questionExtra: typing })));
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card. Picture missing.png is not available.')).not.toHaveLength(0);
  });

  it('headlineLineLabel: "Card. {that line}." in the same form as the card label', () => {
    expect(headlineLineLabel('Was ist das?')).toBe('Card. Was ist das?');
    expect(headlineLineLabel('  die Stunde ')).toBe('Card. die Stunde.');
    // The same text as cardA11yLabel's front (no tap to reveal) for that line.
    const f = face([block({ plain: 'die Stunde' })], [block({ plain: 'the hour', field: 1 })]);
    expect(headlineLineLabel('die Stunde')).toBe(cardA11yLabel(f, false, false));
  });

  it('a long answer is drawn in normal-weight sans 16 (never the big serif); a missing image is a quiet placeholder', () => {
    const longText = 'x '.repeat(100).trim();
    const f = face(
      [block({ plain: 'What is a topic beta?' })],
      [
        block({ plain: longText, role: 'meaning', field: 1 }),
        block({ plain: '', role: 'detail', field: 3, label: 'Diagram', lines: [[{ t: 'img', src: 'missing.png' }]] }),
        block({ plain: '', role: 'detail', field: 4, label: 'Picture', lines: [[{ t: 'img', src: 'tree.svg' }]] }),
      ],
    );
    const r = render(React.createElement(StudyCard, { ...base, face: f, revealed: true }));
    // The answer headline: the host Text that holds the long text.
    const longNode = r.root.findAll(
      (n) =>
        (n.type as unknown) === 'Text' &&
        n.findAll((k) => (k.type as unknown) === 'Text' && k.props.children === longText).length > 0 &&
        flat(n.props.style).fontSize !== undefined,
    )[0];
    expect(longNode).toBeDefined();
    expect(flat(longNode.props.style).fontSize).toBe(16);
    const style = flat(longNode.props.style);
    expect(style.fontFamily).toBe('HankenGrotesk_400Regular');
    expect(style.textAlign).toBe('left');
    expect(texts(r)).toContain('missing.png'); // the placeholder shows the file name
    const images = r.root.findAll((n) => (n.type as unknown) === 'ExpoImage');
    expect(images.map((n) => (n.props.source as { uri: string }).uri)).toEqual(['file:///media/d1/tree.svg']);
  });
});

describe('TypingAnswer, QuizChoices, Articles, HintBar', () => {
  it('Typing: Check sends what was typed; the result names the missing German article', () => {
    const onCheck = jest.fn<(typed: string) => void>();
    const r = render(React.createElement(TypingAnswer, { result: null, onCheck, autoFocus: false }));
    const input = r.root.findAll((n) => typeof n.props.onChangeText === 'function')[0];
    act(() => input.props.onChangeText('Abfahrt'));
    act(() => byLabel(r, 'Check')!.props.onPress());
    expect(onCheck).toHaveBeenCalledWith('Abfahrt');
    const result = checkTyped('Abfahrt', { text: 'die Abfahrt', lang: 'de-DE', role: 'term', multiline: false });
    act(() => r.update(React.createElement(TypingAnswer, { result, onCheck })));
    const all = texts(r).join(' | ');
    expect(all).toContain('Almost — remember the article:');
    expect(all).toContain('die');
    // Wave 5b (L5): an English answer without its "to" names the "to", in its own words.
    const toResult = checkTyped('sleep', { text: 'to sleep / the sleep', lang: 'en-US', role: 'meaning', multiline: false });
    act(() => r.update(React.createElement(TypingAnswer, { result: toResult, onCheck })));
    const shown = texts(r).join(' | ');
    expect(shown).toContain('Almost — remember the “to”:');
    expect(shown).toContain('to');
    expect(shown).toContain('sleep');
    expect(shown).not.toContain('Answer:'); // the hint line already shows the whole answer
  });

  // Final review (session area): right and wrong letters of the diff differed ONLY by green vs red,
  // which a red-green colour-blind learner cannot tell apart, and the label said only "You typed: …"
  // (spec §8.12 "Status is never colour-only").
  it('Typing: the letter diff is never colour-only, and the label names the wrong letters', () => {
    const target = { text: 'die Abfahrt', lang: 'de-DE', role: 'term', multiline: false } as const;
    /** The style of a piece WITHOUT its colours: what a learner who cannot see the colours still sees. */
    const shape = (style: unknown) => {
      const { color: _c, textDecorationColor: _d, backgroundColor: _b, ...rest } = flat(style);
      return rest;
    };
    const pieceStyle = (r: ReactTestRenderer, text: string) => textNode(r, text)!.props.style;
    const labelled = (r: ReactTestRenderer, label: string) =>
      r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.accessibilityLabel === label);

    // A wrong letter ('change'): "e" for "a".
    const changed = checkTyped('die Abfehrt', target);
    expect(changed.diff.map((p) => p.op)).toEqual(['same', 'change', 'same']);
    const r = render(React.createElement(TypingAnswer, { result: changed, onCheck: () => undefined }));
    const right = shape(pieceStyle(r, 'die Abf'));
    const wrong = shape(pieceStyle(r, 'e'));
    expect(wrong).not.toEqual(right);
    expect(String(wrong.textDecorationLine)).toContain('line-through');
    expect(right.textDecorationLine).toBe('underline');
    expect(flat(pieceStyle(r, 'e')).backgroundColor).toBeDefined();
    expect(labelled(r, 'You typed: die Abfehrt. “e” should be “a”.')).toHaveLength(1);

    // A missing letter: "h" is shown faded, with NO underline (a gap in the right letters' line).
    const missing = checkTyped('die Abfart', target);
    expect(missing.diff.map((p) => p.op)).toContain('missing');
    act(() => r.update(React.createElement(TypingAnswer, { result: missing, onCheck: () => undefined })));
    const gap = shape(pieceStyle(r, 'h'));
    expect(gap).not.toEqual(right);
    expect(gap.textDecorationLine).toBe('none');
    expect(labelled(r, 'You typed: die Abfart. “h” is missing.')).toHaveLength(1);

    // Exact: nothing is named; nothing typed: the copy.
    expect(typedAnswerLabel(checkTyped('die Abfahrt', target).diff)).toBe('You typed: die Abfahrt');
    expect(typedAnswerLabel(checkTyped('', target).diff)).toBe('You typed: (nothing typed)');
    // An extra letter, and a long list (at most 3 named, then the count).
    expect(typedAnswerLabel([{ op: 'same', typed: 'ab', expected: 'ab' }, { op: 'extra', typed: 'x', expected: '' }])).toBe(
      'You typed: abx. “x” is extra.',
    );
    const many = ['a', 'b', 'c', 'd', 'e'].map((ch) => ({ op: 'change' as const, typed: ch, expected: 'z' }));
    expect(typedAnswerLabel(many)).toBe('You typed: abcde. “a” should be “z”; “b” should be “z”; “c” should be “z”; and 2 more.');
    expect(typedAnswerLabel([{ op: 'same', typed: 'a', expected: 'a' }, { op: 'missing', typed: '', expected: ' ' }, { op: 'same', typed: 'b', expected: 'b' }])).toBe(
      'You typed: ab. a space is missing.',
    );
    // Every kind of piece has its own shape, without the colours.
    const shapes = (['same', 'change', 'extra', 'missing'] as const).map((op) => JSON.stringify(shape(diffPieceStyle(op, light))));
    expect(new Set([shapes[0], shapes[1], shapes[3]]).size).toBe(3);
    expect(shapes[2]).toBe(shapes[1]); // 'extra' is a wrong typed letter, like 'change'
  });

  it('Quiz: a pick calls onPick once; after the pick the choices are marked and no longer buttons', () => {
    const quiz = { choices: ['the minute', 'the hour', 'the day', 'the week'], answerIndex: 1 };
    const onPick = jest.fn<(i: number) => void>();
    const r = render(React.createElement(QuizChoices, { quiz, pick: null, onPick }));
    act(() => byLabel(r, 'Answer 3 of 4: the day')!.props.onPress());
    expect(onPick).toHaveBeenCalledWith(2);
    act(() => r.update(React.createElement(QuizChoices, { quiz, pick: 2, onPick })));
    expect(byLabel(r, 'Answer 2 of 4: the hour. Right answer.')).toBeUndefined(); // not pressable any more
    const right = r.root.findAll((n) => n.props.accessibilityLabel === 'Answer 2 of 4: the hour. Right answer.')[0];
    expect(right).toBeDefined();
  });

  // W5-5a: two taps before the screen is drawn again — the first one decides.
  it('Quiz and Typing: a second tap before the next render is ignored (the first tap decides)', () => {
    const quiz = { choices: ['the minute', 'the hour', 'the day', 'the week'], answerIndex: 1 };
    const onPick = jest.fn<(i: number) => void>();
    const r = render(React.createElement(QuizChoices, { quiz, pick: null, onPick }));
    // Both presses use the handlers of the SAME render (the parent has not drawn the pick yet).
    const wrong = byLabel(r, 'Answer 3 of 4: the day')!;
    const good = byLabel(r, 'Answer 2 of 4: the hour')!;
    act(() => {
      wrong.props.onPress();
      good.props.onPress();
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(2);
    // A NEW question (the next card, Switch mode) can be answered again.
    act(() => r.update(React.createElement(QuizChoices, { quiz: { ...quiz }, pick: null, onPick })));
    act(() => byLabel(r, 'Answer 1 of 4: the minute')!.props.onPress());
    expect(onPick).toHaveBeenLastCalledWith(0);
    expect(onPick).toHaveBeenCalledTimes(2);

    // Typing: the return key and then "Check" → ONE check, with what was typed.
    const onCheck = jest.fn<(typed: string) => void>();
    act(() => r.update(React.createElement(TypingAnswer, { result: null, onCheck, autoFocus: false })));
    const input = r.root.findAll((n) => typeof n.props.onChangeText === 'function')[0];
    act(() => input.props.onChangeText('Abfahrt'));
    act(() => {
      input.props.onSubmitEditing();
      byLabel(r, 'Check')!.props.onPress();
    });
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onCheck).toHaveBeenCalledWith('Abfahrt');
  });

  it('Articles: der · die · das, then the result with the article written out', () => {
    const onPick = jest.fn();
    const r = render(React.createElement(ArticleButtons, { onPick }));
    act(() => byLabel(r, 'die')!.props.onPress());
    expect(onPick).toHaveBeenCalledWith('die');
    const question = { article: 'die' as const, word: 'Abfahrt', gender: 'f' as const, lang: 'de-DE' };
    act(() => r.update(React.createElement(ArticleResult, { question, pick: 'der', genderColors: true })));
    expect(texts(r).join(' ')).toContain('Not quite — not der');
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Not quite. You chose der. It is die Abfahrt.')).not.toHaveLength(0);
  });

  it('HintBar: a real button with its step label; "tap the card to reveal" only for Flashcards', () => {
    const onHint = jest.fn();
    const r = render(React.createElement(HintBar, { showHint: true, step: 1, onHint, tapToReveal: true }));
    act(() => byLabel(r, 'More hint')!.props.onPress());
    expect(onHint).toHaveBeenCalled();
    expect(texts(r)).toContain('tap the card to reveal');
    act(() => r.update(React.createElement(HintBar, { showHint: false, step: 0, onHint, tapToReveal: false })));
    expect(byLabel(r, 'Hint')).toBeUndefined();
  });
});

/* ================================================================ 9. the session screen (wiring) */

// Review round 1. Two bugs that only the screen shows:
//   - Android's Back while the card editor (More › "Edit card") is on top of
//     the session opened "End this session?" over the editor: Android asks
//     the session's listener first, and the session stays mounted under it;
//   - a session could be banked twice: "End session" or "Finish session"
//     tapped twice, or Back during the fade to Complete (double XP and two
//     session records: M5 "payout once").
describe('the session screen (wiring)', () => {
  /** The Back listeners the screen added (React Native asks the NEWEST first). */
  let backListeners: (() => boolean | null | undefined)[] = [];
  /** The keyboard listeners the screen added. */
  let keyboardListeners: { name: string; listener: () => void }[] = [];
  /** Is the keyboard open? (Keyboard.isVisible(): true until its keyboardDidHide, like React Native.) */
  let keyboardOpen = false;
  const spies: { mockRestore: () => void }[] = [];

  beforeEach(() => {
    backListeners = [];
    keyboardListeners = [];
    mockNavListeners = [];
    keyboardOpen = false;
    mockFocused = true;
    mockGlobalSnack = null;
    spies.push(jest.spyOn(Date, 'now').mockReturnValue(NOW));
    spies.push(
      jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_name, listener) => {
        backListeners.push(listener);
        return { remove: () => void (backListeners = backListeners.filter((l) => l !== listener)) };
      }),
    );
    spies.push(jest.spyOn(Keyboard, 'isVisible').mockImplementation(() => keyboardOpen));
    spies.push(
      jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
        const entry = { name: String(name), listener: listener as () => void };
        keyboardListeners.push(entry);
        return { remove: () => void (keyboardListeners = keyboardListeners.filter((e) => e !== entry)) } as ReturnType<
          typeof Keyboard.addListener
        >;
      }),
    );
  });

  afterEach(() => {
    while (spies.length > 0) spies.pop()!.mockRestore();
    jest.clearAllMocks();
  });

  /** A deck of `n` due review cards (one card per note). */
  function screenState(n: number): DataStateV3 {
    return stateOfV3({
      decks: [makeDeckV3({ id: 'd1', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' })],
      groups: Array.from({ length: n }, (_, i) => deWord(`Wort ${i}`, `word ${i}`, dueReview(), `n-${i}`)),
      overrides: { settings: makeSettingsV3({ sessionLimit: 0, autoReadAloud: false }) },
    });
  }

  function renderSession(state: DataStateV3, mode: 'flash' | 'type' = 'flash'): ReactTestRenderer {
    mockState = state;
    mockParams = { mode };
    return render(React.createElement(SessionScreen));
  }

  /**
   * Draw the screen again after a store change made OUTSIDE the screen (the
   * card editor's snackbar Undo), the way the real store hook does: the real
   * useStateV3 subscribes to the store, the mocked one only reads mockState.
   * A new params object with the same values is the same route (routeKey),
   * so it is the same session, rendered again.
   */
  function rerenderSession(r: ReactTestRenderer): void {
    mockParams = { ...mockParams };
    act(() => r.update(React.createElement(SessionScreen)));
  }

  /** Typing: type `text` and tap "Check" (TypingAnswer closes the keyboard, then calls onCheck). */
  function checkOnScreen(r: ReactTestRenderer, text: string): void {
    act(() => r.root.findByType(TypingAnswer).props.onCheck(text));
  }

  /** A navigation event of the session's screen: 'focus' (back from the card editor) or 'beforeRemove'. */
  function fireNav(name: 'focus' | 'beforeRemove'): void {
    act(() => mockNavListeners.filter((e) => e.name === name).forEach((e) => e.listener()));
  }

  /** The id of the card rated first (the actions record every rating). */
  const firstRatedId = (): string => mockActions.rateCard.mock.calls[0][0];

  /** Show the answer of the card on screen, then rate it. */
  function rateOnScreen(r: ReactTestRenderer, rating: Rating): void {
    act(() => r.root.findByType(StudyCard).props.onReveal());
    act(() => r.root.findByType(RatingButtons).props.onRate(rating));
  }

  /**
   * Android's Back, the way React Native sends it: the newest listener first,
   * until one returns true. 'navigator' = no listener of the screen took it,
   * so the navigator's own Back runs (it closes the screen on top).
   */
  function pressBack(): 'session' | 'navigator' {
    let handled = false;
    act(() => {
      for (let i = backListeners.length - 1; i >= 0 && !handled; i--) handled = !!backListeners[i]();
    });
    return handled ? 'session' : 'navigator';
  }

  /** The keyboard went away (on any screen). */
  function keyboardHid(): void {
    keyboardOpen = false;
    act(() => keyboardListeners.filter((e) => e.name === 'keyboardDidHide').forEach((e) => e.listener()));
  }

  const exitSheetOpen = (r: ReactTestRenderer): boolean => r.root.findByType(ExitConfirmSheet).props.open;

  it('Back while the card editor is on top is the editor’s Back: never "End this session?" over it', () => {
    const r = renderSession(screenState(3));
    rateOnScreen(r, 'good');
    // More › Edit card: the editor is pushed on top; the session stays mounted under it.
    mockFocused = false;
    keyboardHid(); // the editor's keyboard closes
    expect(pressBack()).toBe('navigator'); // the navigator closes the editor (its own unsaved-changes guard runs)
    expect(exitSheetOpen(r)).toBe(false);
    expect(pressBack()).toBe('navigator');
    expect(exitSheetOpen(r)).toBe(false);
    // Back on the session: after a rating, Back asks first. The editor's
    // keyboard did not count as the session's (no Back press swallowed).
    mockFocused = true;
    expect(pressBack()).toBe('session');
    expect(exitSheetOpen(r)).toBe(true);
    // "Keep studying"; the session's OWN keyboard closing on a Back press still only closes the keyboard.
    act(() => r.root.findByType(ExitConfirmSheet).props.onKeep());
    keyboardHid();
    expect(pressBack()).toBe('session');
    expect(exitSheetOpen(r)).toBe(false);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
  });

  it('"End session" tapped twice banks the session once and goes back once; a banked screen rates nothing', () => {
    const r = renderSession(screenState(3));
    rateOnScreen(r, 'good');
    expect(pressBack()).toBe('session');
    const sheet = r.root.findByType(ExitConfirmSheet).props;
    act(() => {
      sheet.onEnd();
      sheet.onEnd(); // the second tap of a double tap (the same frame)
    });
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockShow).toHaveBeenCalledTimes(1);
    expect(mockShow.mock.calls[0][0]).toMatch(/^Session saved · 1 card · \+\d+ XP$/);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
    // The screen is on its way out: Back is not the session's any more…
    expect(pressBack()).toBe('navigator');
    // …and a late rating writes nothing: no review, and no new in-flight
    // marker that the next boot would bank a second time (M5).
    const rated = mockActions.rateCard.mock.calls.length;
    rateOnScreen(r, 'good');
    expect(mockActions.rateCard.mock.calls.length).toBe(rated);
    expect(mockState.inProgressSession).toBeNull();
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockState.sessions).toHaveLength(1);
  });

  it('"Finish session" in "All done here" tapped twice, or Back in the fade to Complete, banks once', () => {
    const r = renderSession(screenState(2));
    rateOnScreen(r, 'good');
    // More › Suspend on the LAST card: "All done here", with its Undo.
    act(() => r.root.findByType(CardActionsSheet).props.onSuspend());
    expect(texts(r)).toContain(ALL_DONE_COPY.title);
    expect(byLabel(r, 'Undo: Suspended')).toBeDefined();
    const finish = byLabel(r, ALL_DONE_COPY.finish)!;
    act(() => {
      finish.props.onPress();
      finish.props.onPress();
    });
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    // The screen stays during the fade to Complete: Back and a late tap do nothing more.
    expect(pressBack()).toBe('navigator');
    act(() => byLabel(r, ALL_DONE_COPY.finish)!.props.onPress());
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
    // The message stays while the screen fades out; its Undo is gone.
    expect(texts(r)).toContain('Suspended');
    expect(byLabel(r, 'Undo: Suspended')).toBeUndefined();
  });

  it('"Back" in "All done here" with nothing rated goes back once, and banks nothing', () => {
    const r = renderSession(screenState(1));
    act(() => r.root.findByType(CardActionsSheet).props.onSuspend());
    const back = byLabel(r, ALL_DONE_COPY.leave)!;
    act(() => {
      back.props.onPress();
      back.props.onPress();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
    expect(pressBack()).toBe('navigator');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  // Review round 2 (M1): after "Edit card" › Delete on the LAST card, the
  // focus listener called show('Card deleted') on the GLOBAL snackbar, which
  // REPLACED the editor's "“Wort 1” deleted · Undo", and then it ended the
  // session at once (router.replace to Complete): the deletion could not be
  // undone any more. Now it is "All done here", like a suspended last card.
  it('the LAST card deleted in the card editor: "All done here", and the editor’s Undo snackbar is never replaced', () => {
    const r = renderSession(screenState(2));
    rateOnScreen(r, 'good');
    const last = mockState.cards.find((c) => c.id !== firstRatedId())!;
    // More › Edit card: the editor is on top of the session, and deletes the note of the last card there.
    mockFocused = false;
    mockRun(deleteNotes, { noteIds: [last.noteId] });
    // The editor closes: the session is focused again.
    mockFocused = true;
    fireNav('focus');
    // No new GLOBAL message: the editor's "“Wort 1” deleted · Undo" stays (the session mounts a host for it).
    expect(mockShow).not.toHaveBeenCalled();
    expect(r.root.findAllByType(SnackbarHost)).toHaveLength(1);
    // Nothing banked, and the screen did not go anywhere.
    expect(mockActions.completeSession).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    // "All done here" with the message; no Undo of its own (the editor's snackbar has it).
    expect(texts(r)).toContain(ALL_DONE_COPY.title);
    expect(texts(r)).toContain('Card deleted');
    expect(byLabel(r, 'Undo: Card deleted')).toBeUndefined();
    // A second focus (the snackbar's own screen changes) changes nothing.
    fireNav('focus');
    expect(mockActions.completeSession).not.toHaveBeenCalled();
    // "Finish session" banks the one rated card, once, and opens Complete.
    act(() => byLabel(r, ALL_DONE_COPY.finish)!.props.onPress());
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession.mock.calls[0][0].total).toBe(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
    expect(mockShow).not.toHaveBeenCalled();
  });

  // Wave 5c (M1): the editor's Undo ("“Wort 1” deleted · Undo") brought the
  // note back in the store, but the session stayed in "All done here" ("Card
  // deleted. That was the last card…") and the card could not be studied —
  // although the Undo of a Suspend or a Reschedule there brings the card back.
  it('the card editor’s Undo of a deleted LAST card puts it back on screen ("2 / 2"); both cards bank once', () => {
    const r = renderSession(screenState(2));
    rateOnScreen(r, 'good');
    const last = mockState.cards.find((c) => c.id !== firstRatedId())!;
    mockFocused = false;
    const deleted = mockRun(deleteNotes, { noteIds: [last.noteId] });
    mockFocused = true;
    fireNav('focus');
    expect(texts(r)).toContain(ALL_DONE_COPY.title);
    // The editor's snackbar Undo, tapped on the session screen: the note and its card are back in the store…
    act(() => {
      mockRun(undoDelete, { deleted });
    });
    // …and the store hook draws the screen again (the real one subscribes; the mocked one is rendered again here).
    rerenderSession(r);
    expect(texts(r)).not.toContain(ALL_DONE_COPY.title);
    expect(texts(r)).not.toContain('Card deleted');
    const header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 2]);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
    // Rate it: the session ends with BOTH cards, banked once.
    rateOnScreen(r, 'good');
    expect(mockActions.rateCard.mock.calls.map((call) => call[0])).toEqual([firstRatedId(), last.id]);
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession.mock.calls[0][0].total).toBe(2);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
  });

  it('"Finish session" after a deleted LAST card, then the editor’s Undo: nothing comes back (the session is banked)', () => {
    const r = renderSession(screenState(2));
    rateOnScreen(r, 'good');
    const last = mockState.cards.find((c) => c.id !== firstRatedId())!;
    mockFocused = false;
    const deleted = mockRun(deleteNotes, { noteIds: [last.noteId] });
    mockFocused = true;
    fireNav('focus');
    act(() => byLabel(r, ALL_DONE_COPY.finish)!.props.onPress());
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    // The Undo lands on Complete (the global snackbar): the note is back, the banked session stays as it was.
    act(() => {
      mockRun(undoDelete, { deleted });
    });
    rerenderSession(r);
    expect(r.root.findAllByType(SessionHeader)).toHaveLength(0);
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession.mock.calls[0][0].total).toBe(1);
    expect(mockState.sessions).toHaveLength(1);
  });

  it('a deleted card that is NOT the last: the session goes on, with its own "Card deleted" (never the global one)', () => {
    const r = renderSession(screenState(3));
    rateOnScreen(r, 'good');
    const onScreen = mockState.cards.filter((c) => c.id !== firstRatedId());
    mockFocused = false;
    mockRun(deleteNotes, { noteIds: [onScreen[0].noteId] });
    mockFocused = true;
    fireNav('focus');
    expect(mockShow).not.toHaveBeenCalled();
    expect(texts(r)).toContain('Card deleted');
    expect(texts(r)).not.toContain(ALL_DONE_COPY.title);
    // The card that is left is on screen: "2 / 2".
    const header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 2]);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
  });

  // Wave 5c, review round 1: the editor's Undo brought back only a deleted
  // LAST card. A card deleted in the MIDDLE stayed out of the session after
  // that Undo, although its note was back in the store.
  it('the card editor’s Undo of a card deleted in the MIDDLE puts it back on screen ("2 / 3"); all 3 bank once', () => {
    /** The id of the card on screen (the screen gives it to the Reschedule sheet). */
    const onScreenId = (): string => r.root.findByType(RescheduleSheet).props.cardIds[0];
    const r = renderSession(screenState(3));
    rateOnScreen(r, 'good');
    const second = mockState.cards.find((c) => c.id === onScreenId())!;
    // More › Edit card › Delete the note of the card on screen (card 2 of 3).
    mockFocused = false;
    const deleted = mockRun(deleteNotes, { noteIds: [second.noteId] });
    mockFocused = true;
    fireNav('focus');
    expect(texts(r)).toContain('Card deleted');
    const third = onScreenId();
    expect(third).not.toBe(second.id);
    let header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 2]);
    // The editor's snackbar Undo, tapped on the session screen: the note is back in the store…
    act(() => {
      mockRun(undoDelete, { deleted });
    });
    rerenderSession(r);
    // …and the card is back on screen, before card 3: "2 / 3". The session's own "Card deleted" is gone.
    expect(onScreenId()).toBe(second.id);
    header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 3]);
    expect(texts(r)).not.toContain('Card deleted');
    expect(mockShow).not.toHaveBeenCalled();
    // A second draw changes nothing (it came back once).
    rerenderSession(r);
    expect(r.root.findByType(SessionHeader).props.total).toBe(3);
    // Rate both: the session ends with all 3 cards, banked once.
    rateOnScreen(r, 'good');
    expect(onScreenId()).toBe(third);
    rateOnScreen(r, 'good');
    expect(mockActions.rateCard.mock.calls.map((call) => call[0])).toEqual([firstRatedId(), second.id, third]);
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession.mock.calls[0][0].total).toBe(3);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
  });

  // Wave 5c, review round 2: the editor's snackbar stays 6 s, also after the
  // session's own bar shows "Good · Undo". Its Undo then brought the deleted
  // card back, but the session's Undo of the rating made meanwhile took it
  // out again, with no message: the card was gone from the session.
  it('the editor’s Undo, then the session’s Undo of a rating made meanwhile: the card that came back stays', () => {
    /** The id of the card on screen (the screen gives it to the Reschedule sheet). */
    const onScreenId = (): string => r.root.findByType(RescheduleSheet).props.cardIds[0];
    const position = (): number[] => {
      const header = r.root.findByType(SessionHeader).props;
      return [header.idx + 1, header.total];
    };
    const r = renderSession(screenState(4));
    rateOnScreen(r, 'good');
    const second = mockState.cards.find((c) => c.id === onScreenId())!;
    // More › Edit card › Delete the note of card 2 of 4.
    mockFocused = false;
    const deleted = mockRun(deleteNotes, { noteIds: [second.noteId] });
    mockFocused = true;
    fireNav('focus');
    const third = onScreenId();
    expect(position()).toEqual([2, 3]);
    // Rate card 3: the session's bar says "… · Undo" now.
    rateOnScreen(r, 'good');
    const fourth = onScreenId();
    expect(position()).toEqual([3, 3]);
    // The editor's Undo (its global bar is still on screen): card 2 is back on screen, "3 / 4".
    act(() => {
      mockRun(undoDelete, { deleted });
    });
    rerenderSession(r);
    expect([onScreenId(), ...position()]).toEqual([second.id, 3, 4]);
    // The session's Undo of the rating of card 3: card 3 is on screen again, and card 2 is still to come.
    const bar = r.root.findAllByType(SnackbarView).find((v) => v.props.onAction !== undefined)!;
    act(() => bar.props.onAction());
    expect([onScreenId(), ...position()]).toEqual([third, 2, 4]);
    // Rate the 3 cards left: every card is studied, and the session banks 4 cards once.
    rateOnScreen(r, 'good');
    expect(onScreenId()).toBe(second.id);
    rateOnScreen(r, 'good');
    expect(onScreenId()).toBe(fourth);
    rateOnScreen(r, 'good');
    expect(mockActions.rateCard.mock.calls.map((call) => call[0])).toEqual([firstRatedId(), third, third, second.id, fourth]);
    expect(mockActions.undoLastReview).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession.mock.calls[0][0].total).toBe(4);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
  });

  it('"All done here" after a Suspend, then the editor’s Undo of an earlier deleted card: the session goes on, and the Suspend keeps its Undo', () => {
    /** The id of the card on screen (the screen gives it to the Reschedule sheet). */
    const onScreenId = (): string => r.root.findByType(RescheduleSheet).props.cardIds[0];
    const r = renderSession(screenState(3));
    rateOnScreen(r, 'good');
    const second = mockState.cards.find((c) => c.id === onScreenId())!;
    mockFocused = false;
    const deleted = mockRun(deleteNotes, { noteIds: [second.noteId] });
    mockFocused = true;
    fireNav('focus');
    // More › Suspend on card 3, now the LAST card: "All done here", with its Undo.
    const third = onScreenId();
    act(() => r.root.findByType(CardActionsSheet).props.onSuspend());
    expect(texts(r)).toContain(ALL_DONE_COPY.title);
    // The editor's Undo lands now: card 2 is back on screen ("2 / 2")…
    act(() => {
      mockRun(undoDelete, { deleted });
    });
    rerenderSession(r);
    expect(texts(r)).not.toContain(ALL_DONE_COPY.title);
    expect(onScreenId()).toBe(second.id);
    // …and the Undo of the Suspend is still reachable, on the session's snackbar.
    const bar = r.root.findAllByType(SnackbarView).find((v) => v.props.text === 'Suspended')!;
    act(() => bar.props.onAction());
    expect(mockState.cards.find((c) => c.id === third)!.suspended).toBeFalsy();
    expect(onScreenId()).toBe(third);
    const header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 3]);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
  });

  // Review round 2: the wiring of the "All done here" Undo had no screen test.
  it('"Undo" in "All done here" puts the card back; the session goes on and banks both cards once', () => {
    const r = renderSession(screenState(2));
    rateOnScreen(r, 'good');
    const last = mockState.cards.find((c) => c.id !== firstRatedId())!;
    // More › Suspend on the LAST card: "All done here", with its Undo.
    act(() => r.root.findByType(CardActionsSheet).props.onSuspend());
    expect(texts(r)).toContain(ALL_DONE_COPY.title);
    expect(mockState.cards.find((c) => c.id === last.id)!.suspended).toBe(true);
    act(() => byLabel(r, 'Undo: Suspended')!.props.onPress());
    // The suspend is undone in the store, and the card is back on screen: "2 / 2", not "All done here".
    expect(mockActions.undoManualEdit).toHaveBeenCalledTimes(1);
    expect(mockState.cards.find((c) => c.id === last.id)!.suspended).toBeFalsy();
    expect(texts(r)).not.toContain(ALL_DONE_COPY.title);
    const header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 2]);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
    // Rate it: the session ends with BOTH cards, banked once.
    rateOnScreen(r, 'good');
    expect(mockActions.rateCard.mock.calls.map((call) => call[0])).toEqual([firstRatedId(), last.id]);
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession.mock.calls[0][0].total).toBe(2);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
  });

  // Final review (session area): "Bury until tomorrow" had no Undo (Suspend and Reschedule have one):
  // a mis-tap hid the card until midnight, and nothing in the app could bring it back.
  it('Bury: the snackbar Undo un-buries the card and puts it back on screen', () => {
    const r = renderSession(screenState(3));
    const onScreenId = (): string => r.root.findByType(RescheduleSheet).props.cardIds[0];
    const buried = onScreenId();
    act(() => r.root.findByType(CardActionsSheet).props.onBury());
    expect(mockState.cards.find((c) => c.id === buried)!.buriedUntil).toBeGreaterThan(NOW);
    expect(onScreenId()).not.toBe(buried); // the session goes on with the next card
    const bar = r.root.findAllByType(SnackbarView).find((v) => v.props.text === 'Wort 0 buried until tomorrow')!;
    expect(bar).toBeDefined();
    expect(typeof bar.props.onAction).toBe('function'); // it has an Undo
    act(() => bar.props.onAction());
    expect(mockActions.undoManualEdit).toHaveBeenCalledTimes(1);
    expect(mockState.cards.find((c) => c.id === buried)!.buriedUntil ?? null).toBeNull();
    expect(onScreenId()).toBe(buried);
    const header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([1, 3]);
  });

  it('Bury on the LAST card: "All done here" keeps its Undo, and the Undo brings the card back', () => {
    const r = renderSession(screenState(2));
    rateOnScreen(r, 'good');
    const last = mockState.cards.find((c) => c.id !== firstRatedId())!;
    act(() => r.root.findByType(CardActionsSheet).props.onBury());
    expect(texts(r)).toContain(ALL_DONE_COPY.title);
    expect(mockState.cards.find((c) => c.id === last.id)!.buriedUntil).toBeGreaterThan(NOW);
    act(() => byLabel(r, 'Undo: Wort 1 buried until tomorrow')!.props.onPress());
    expect(mockState.cards.find((c) => c.id === last.id)!.buriedUntil ?? null).toBeNull();
    expect(texts(r)).not.toContain(ALL_DONE_COPY.title);
    const header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 2]);
    // The session goes on with it: both cards are rated and banked once.
    rateOnScreen(r, 'good');
    expect(mockActions.rateCard.mock.calls.map((call) => call[0])).toEqual([firstRatedId(), last.id]);
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession.mock.calls[0][0].total).toBe(2);
  });

  // Review round 2 (M10): the safety net for any other way out had no screen
  // test. There is no swipe to leave (the route has `gestureEnabled: false`,
  // src/app/_layout.tsx), so that way out is a navigation from OUTSIDE the
  // session, for example a tap on a reminder (_layout.tsx ReminderTapRouter).
  it('beforeRemove banks the rated part once and says "Session saved · 1 card · +{xp} XP" (M10)', () => {
    const r = renderSession(screenState(3));
    // Nothing rated yet: a removal banks nothing and says nothing.
    fireNav('beforeRemove');
    expect(mockActions.completeSession).not.toHaveBeenCalled();
    expect(mockShow).not.toHaveBeenCalled();
    act(() => r.unmount());
    renderer = null;
    mockNavListeners = [];

    const again = renderSession(screenState(3));
    rateOnScreen(again, 'good');
    fireNav('beforeRemove');
    fireNav('beforeRemove'); // a second removal event: never a second bank
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    const payout = mockActions.completeSession.mock.results[0].value as ReturnType<typeof mockActions.completeSession>;
    expect(payout.total).toBe(1);
    expect(mockShow).toHaveBeenCalledTimes(1);
    expect(mockShow).toHaveBeenCalledWith(earlyExitSnack(1, payout.xpTotal));
    expect(mockShow.mock.calls[0][0]).toMatch(/^Session saved · 1 card · \+\d+ XP$/);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
    // The navigator removes the screen itself: the session does not go back a second time.
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  // Wave 5c: the M10 summary of the main way out (✕ → "End session") had no screen test.
  it('✕ → "End session" banks the rated part once and says "Session saved · 2 cards · +{xp} XP" on the next screen (M10)', () => {
    const r = renderSession(screenState(3));
    // Nothing rated: ✕ leaves at once, and banks and says nothing.
    act(() => r.root.findByType(SessionHeader).props.onClose());
    expect(exitSheetOpen(r)).toBe(false);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
    expect(mockShow).not.toHaveBeenCalled();
    act(() => r.unmount());
    renderer = null;
    mockNavListeners = [];
    mockGoBack.mockClear();

    const again = renderSession(screenState(3));
    rateOnScreen(again, 'good');
    rateOnScreen(again, 'good');
    // ✕ after ratings asks first; "End session" banks.
    act(() => again.root.findByType(SessionHeader).props.onClose());
    expect(exitSheetOpen(again)).toBe(true);
    act(() => again.root.findByType(ExitConfirmSheet).props.onEnd());
    expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
    const payout = mockActions.completeSession.mock.results[0].value as ReturnType<typeof mockActions.completeSession>;
    expect(payout.total).toBe(2);
    // The summary goes to the GLOBAL snackbar (the screen you land on); no Complete screen.
    expect(mockShow).toHaveBeenCalledTimes(1);
    expect(mockShow).toHaveBeenCalledWith(earlyExitSnack(2, payout.xpTotal));
    expect(mockShow.mock.calls[0][0]).toMatch(/^Session saved · 2 cards · \+\d+ XP$/);
    expect(mockActions.clearLastCompletion).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.inProgressSession).toBeNull();
  });

  // Wave 5d (F1a): the header says the session never replaces the card editor's GLOBAL
  // "“Wort” deleted · Undo", but ending the session early within that Undo's time showed
  // "Session saved" on the same global channel, which REPLACED it: the deletion could not be
  // undone any more. Now "Session saved" waits until the Undo's time is over.
  it('ending early while the card editor’s Undo is on screen: "Session saved" comes AFTER it, never over it', async () => {
    // Only the timers are fake (the screen's clock stays the test's NOW).
    jest.useFakeTimers({ doNotFake: ['Date', 'performance', 'nextTick', 'queueMicrotask'] });
    try {
      const r = renderSession(screenState(3));
      // The screen's first OS reads (Reduce Motion) answer inside act.
      await act(async () => {});
      rateOnScreen(r, 'good');
      const second = mockState.cards.find((c) => c.id === r.root.findByType(RescheduleSheet).props.cardIds[0])!;
      // More › Edit card › Delete: the editor shows its GLOBAL message with an Undo, and closes.
      mockFocused = false;
      const deleted = mockRun(deleteNotes, { noteIds: [second.noteId] });
      const editorUndo = jest.fn(() => mockRun(undoDelete, { deleted }));
      mockGlobalSnack = { text: '“Wort 1” deleted', actionLabel: 'Undo', onAction: editorUndo };
      mockFocused = true;
      fireNav('focus');
      rerenderSession(r); // the session sees the global message (the real snackbar hook re-renders it)
      // ✕ → "End session", within the Undo's time.
      act(() => r.root.findByType(SessionHeader).props.onClose());
      act(() => r.root.findByType(ExitConfirmSheet).props.onEnd());
      expect(mockActions.completeSession).toHaveBeenCalledTimes(1);
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      // Not now: the editor's Undo stays on screen.
      expect(mockShow).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(SNACK_ACTION_MS - 1000));
      expect(mockShow).not.toHaveBeenCalled();
      // The Undo still works in that time.
      editorUndo();
      expect(mockState.cards.some((c) => c.id === second.id)).toBe(true);
      // When the Undo's time is over: "Session saved", once.
      act(() => jest.advanceTimersByTime(1000 + SAVED_AFTER_UNDO_GAP_MS));
      const payout = mockActions.completeSession.mock.results[0].value as ReturnType<typeof mockActions.completeSession>;
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(mockShow).toHaveBeenCalledWith(earlyExitSnack(1, payout.xpTotal));
      act(() => jest.advanceTimersByTime(60_000));
      expect(mockShow).toHaveBeenCalledTimes(1);
      // Close the screen here: the OS reads of the sheets it opened answer after this test's code.
      act(() => r.unmount());
      renderer = null;
    } finally {
      jest.useRealTimers();
    }
  });

  it('a global message WITHOUT an Undo on screen does not hold "Session saved" back (it shows at once, as before)', () => {
    const r = renderSession(screenState(3));
    rateOnScreen(r, 'good');
    mockGlobalSnack = { text: 'Deck saved' };
    rerenderSession(r);
    act(() => r.root.findByType(SessionHeader).props.onClose());
    act(() => r.root.findByType(ExitConfirmSheet).props.onEnd());
    expect(mockShow).toHaveBeenCalledTimes(1);
    expect(mockShow.mock.calls[0][0]).toMatch(/^Session saved · 1 card · \+\d+ XP$/);
  });

  // Wave 5d (F1a): a deleted card that came back after "Switch mode" kept the plan of the OLD mode.
  it('a deleted card brought back by the editor’s Undo after "Switch mode" is asked in the NEW mode', () => {
    const onScreenId = (): string => r.root.findByType(RescheduleSheet).props.cardIds[0];
    const r = renderSession(screenState(3), 'flash');
    rateOnScreen(r, 'good');
    const second = mockState.cards.find((c) => c.id === onScreenId())!;
    expect(r.root.findAllByType(TypingAnswer)).toHaveLength(0);
    // More › Edit card › Delete the card on screen (card 2 of 3): card 3 is on screen.
    mockFocused = false;
    const deleted = mockRun(deleteNotes, { noteIds: [second.noteId] });
    mockFocused = true;
    fireNav('focus');
    expect(onScreenId()).not.toBe(second.id);
    // More › Switch mode › Typing: card 3 is asked by typing now.
    act(() => r.root.findByType(ModeSheet).props.onPickMode('type'));
    expect(r.root.findAllByType(TypingAnswer)).toHaveLength(1);
    // The editor's Undo: card 2 is back on screen — and asked by TYPING too, not as a flashcard.
    act(() => {
      mockRun(undoDelete, { deleted });
    });
    rerenderSession(r);
    expect(onScreenId()).toBe(second.id);
    expect(r.root.findAllByType(TypingAnswer)).toHaveLength(1);
  });

  // Wave 5c: the "All done here" Undo was pinned for Suspend only.
  it('"Undo" in "All done here" after a Reschedule of the LAST card: the old due is back, and so is the card', () => {
    const r = renderSession(screenState(2));
    rateOnScreen(r, 'good');
    const last = mockState.cards.find((c) => c.id !== firstRatedId())!;
    // RescheduleSheet (it has its own tests) moved the card; the session gets the edit id and the day.
    const dueMs = NOW + 7 * DAY;
    const editId = mockRun(reschedule, { cardIds: [last.id], dueMs }).edit.id;
    act(() => r.root.findByType(RescheduleSheet).props.onDone({ editId, dueMs }));
    const message = rescheduleSnack(dueMs, NOW);
    expect(texts(r)).toContain(ALL_DONE_COPY.title);
    expect(texts(r)).toContain(message);
    act(() => byLabel(r, `${ALL_DONE_COPY.undo}: ${message}`)!.props.onPress());
    expect(mockActions.undoManualEdit).toHaveBeenCalledWith(editId);
    expect(mockState.cards.find((c) => c.id === last.id)!.due).toBe(last.due);
    expect(texts(r)).not.toContain(ALL_DONE_COPY.title);
    const header = r.root.findByType(SessionHeader).props;
    expect([header.idx + 1, header.total]).toEqual([2, 2]);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
  });

  // Wave 5c: the grace window explained EVERY Back press for 500 ms, so a
  // second quick Back press after the keyboard closed by itself was lost too.
  it('Typing: the keyboard’s grace window takes ONE Back press; the next press is a real Back', () => {
    const r = renderSession(screenState(3), 'type');
    checkOnScreen(r, 'falsch');
    act(() => r.root.findByType(RatingButtons).props.onRate('good'));
    // Card 2: the keyboard closes by itself on a Back press (before the app hears it).
    keyboardOpen = true;
    keyboardHid();
    expect(pressBack()).toBe('session'); // that press only closed the keyboard: the typed answer stays
    expect(exitSheetOpen(r)).toBe(false);
    expect(pressBack()).toBe('session'); // the next press, at once: "End this session?"
    expect(exitSheetOpen(r)).toBe(true);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
  });

  // Review round 2: TypingAnswer's "Check" closes the keyboard. Its hide
  // started the Back grace window, so a Back press just after "Check" only
  // "closed the keyboard" (that was already closed) and was lost.
  it('Typing: a Back press just after "Check" is a real Back; a keyboard that closed by itself still only closes', () => {
    const r = renderSession(screenState(3), 'type');
    // Card 1: type with the keyboard open, "Check" (it closes the keyboard), rate.
    keyboardOpen = true;
    checkOnScreen(r, 'falsch');
    keyboardHid(); // the hide that "Check" asked for
    act(() => r.root.findByType(RatingButtons).props.onRate('good'));
    // Card 2: the keyboard is open again. It closes by itself on a Back press
    // (before the app hears it): that press only closes the keyboard.
    keyboardOpen = true;
    keyboardHid();
    expect(pressBack()).toBe('session');
    expect(exitSheetOpen(r)).toBe(false);
    // "Check" closes the keyboard; its hide comes a moment later. The next Back IS the session's Back.
    keyboardOpen = true;
    checkOnScreen(r, 'falsch');
    keyboardHid();
    expect(pressBack()).toBe('session');
    expect(exitSheetOpen(r)).toBe(true);
    expect(mockActions.completeSession).not.toHaveBeenCalled();
  });

  it('Typing: Back with the keyboard open only closes it, and the next Back press asks "End this session?"', () => {
    const r = renderSession(screenState(3), 'type');
    checkOnScreen(r, 'falsch');
    act(() => r.root.findByType(RatingButtons).props.onRate('good'));
    // Card 2, typing: Back closes the keyboard (the session closes it itself); the typed answer stays.
    keyboardOpen = true;
    expect(pressBack()).toBe('session');
    expect(exitSheetOpen(r)).toBe(false);
    keyboardHid(); // the hide the session asked for: it never swallows the next Back
    expect(pressBack()).toBe('session');
    expect(exitSheetOpen(r)).toBe(true);
    // The session's close explained ONE hide only: a later hide by itself opens the window again.
    act(() => r.root.findByType(ExitConfirmSheet).props.onKeep());
    keyboardOpen = true;
    keyboardHid();
    expect(pressBack()).toBe('session');
    expect(exitSheetOpen(r)).toBe(false);
  });

  // Wave 5b integration (walkthrough M5): the session draws its OWN snackbar.
  // It used a fixed 2.6 s, so "Good · Undo" left before a late tap. It now
  // takes the global rule (useSnackDuration): an Undo stays SNACK_ACTION_MS.
  it('the rating snackbar keeps its Undo as long as every Undo snackbar (M5), then closes', () => {
    // Date and performance stay real: the screen's clocks are mocked above.
    jest.useFakeTimers({ doNotFake: ['Date', 'performance', 'nextTick', 'queueMicrotask'] });
    try {
      const r = renderSession(screenState(3));
      rateOnScreen(r, 'good');
      const undoSnacks = () => r.root.findAllByType(SnackbarView).filter((s) => typeof s.props.onAction === 'function');
      expect(undoSnacks()).toHaveLength(1);
      // The old 2.6 s timer would have closed it here.
      act(() => {
        jest.advanceTimersByTime(SNACK_ACTION_MS - 1);
      });
      expect(undoSnacks()).toHaveLength(1);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(undoSnacks()).toHaveLength(0);
      act(() => r.unmount());
      renderer = null;
    } finally {
      jest.useRealTimers();
    }
  });

  /* ---- wave 5h: the session polish from the E7 device pass (and the C2 review of wave 5g) ---- */

  /** Every host text inside a node, one string per Text. */
  const hostTexts = (node: ReactTestInstance): string[] =>
    node
      .findAll((n) => n.type === ('Text' as unknown))
      .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')));

  it('the in-flight marker carries the session’s mode, also after "Switch mode"; a kill then banks it with that mode (E7-10)', () => {
    const r = renderSession(screenState(4));
    rateOnScreen(r, 'good');
    expect(mockState.inProgressSession).toMatchObject({ total: 1, mode: 'flash' });
    // More › Switch mode → Typing: the next rating saves the new mode.
    act(() => r.root.findByType(ModeSheet).props.onPickMode('type'));
    checkOnScreen(r, 'falsch');
    act(() => r.root.findByType(RatingButtons).props.onRate('good'));
    expect(mockState.inProgressSession).toMatchObject({ total: 2, mode: 'type' });
    // Undo keeps the marker in step, with the mode.
    act(() => r.root.findByType(SessionHeader).props.onUndo());
    expect(mockState.inProgressSession).toMatchObject({ total: 1, mode: 'type' });
    act(() => r.root.findByType(RatingButtons).props.onRate('good'));
    // The app is killed now: the next boot banks the session once, silently, with its mode (M5).
    const killed = mockState;
    const boot = reconcileOnBoot(killed, undefined, testCtx(NOW + MIN));
    expect(boot.result).toEqual({ banked: true });
    expect(boot.state.sessions.at(-1)).toMatchObject({ total: 2, mode: 'type' });
    expect(boot.state.inProgressSession).toBeNull();
    expect(reconcileOnBoot(boot.state, undefined, testCtx(NOW + 2 * MIN)).result).toEqual({ banked: false });
    expect(mockActions.completeSession).not.toHaveBeenCalled();
  });

  it('✕ in a PRACTICE session: the exit sheet says the practice is kept and the schedule does not change (E7)', () => {
    mockState = screenState(3);
    mockParams = { kind: 'practice', mode: 'flash' };
    const r = render(React.createElement(SessionScreen));
    rateOnScreen(r, 'good');
    act(() => r.root.findByType(SessionHeader).props.onClose());
    const sheet = r.root.findByType(ExitConfirmSheet);
    expect(sheet.props).toMatchObject({ open: true, practice: true, reviewed: 1 });
    expect(hostTexts(sheet)).toContain('Your practice is kept (1 card). Your schedule does not change.');
    expect(hostTexts(sheet)).not.toContain('The 1 card you reviewed will be saved.');
  });

  it('✕ in a STUDY session: the exit sheet keeps its words', () => {
    const r = renderSession(screenState(3));
    rateOnScreen(r, 'good');
    act(() => r.root.findByType(SessionHeader).props.onClose());
    const sheet = r.root.findByType(ExitConfirmSheet);
    expect(sheet.props).toMatchObject({ open: true, practice: false });
    expect(hostTexts(sheet)).toContain('The 1 card you reviewed will be saved.');
  });

  it('Card info before the reveal hides the answer (CardSheet hideAnswer); after the reveal it shows everything (E7-7)', () => {
    const r = renderSession(screenState(3));
    expect(r.root.findByType(CardSheet).props).toMatchObject({ readOnly: true, hideAnswer: true });
    expect(r.root.findByType(CardSheet).props.question).toBeUndefined();
    act(() => r.root.findByType(StudyCard).props.onReveal());
    expect(r.root.findByType(CardSheet).props.hideAnswer).toBe(false);
    // The next card is not revealed: hidden again.
    act(() => r.root.findByType(RatingButtons).props.onRate('good'));
    expect(r.root.findByType(CardSheet).props.hideAnswer).toBe(true);
  });

  it('Articles: Card info before the pick shows the bare word (the article is the answer)', () => {
    mockState = germanState();
    mockParams = { kind: 'practice', mode: 'article' };
    const r = render(React.createElement(SessionScreen));
    const bare = r.root.findByType(StudyCard).props.promptLabel as string;
    expect(bare).toBeTruthy();
    expect(r.root.findByType(CardSheet).props).toMatchObject({ hideAnswer: true, question: { text: bare, lang: 'de-DE' } });
    act(() => r.root.findByType(ArticleButtons).props.onPick('der'));
    expect(r.root.findByType(CardSheet).props.hideAnswer).toBe(false);
  });

  it('Typing: after "Check" the result’s first line is the card’s focus target (StudyCard answerExtraFocus, C2 review)', () => {
    const r = renderSession(screenState(3), 'type');
    checkOnScreen(r, 'falsch');
    const card = r.root.findByType(StudyCard).props;
    const result = r.root.findAllByType(TypingAnswer).filter((t) => t.props.result !== null);
    expect(result).toHaveLength(1);
    expect(result[0].props.focusRef).toBe(card.answerExtraFocus);
    // The ref holds the drawn "You typed: …" line. It is `accessible`: on Android a Text
    // without it cannot take the screen-reader focus.
    expect(String(card.answerExtraFocus.current?.props.accessibilityLabel)).toMatch(/^You typed: falsch/);
    expect(card.answerExtraFocus.current?.props.accessible).toBe(true);
  });

  it('Quiz: after the pick the PICKED choice is the card’s focus target (C2 review)', () => {
    mockState = screenState(4);
    mockParams = { mode: 'mc' };
    const r = render(React.createElement(SessionScreen));
    const front = r.root.findByType(QuizChoices).props;
    const wrong = front.quiz.choices.findIndex((_: string, i: number) => i !== front.quiz.answerIndex);
    act(() => front.onPick(wrong));
    const card = r.root.findByType(StudyCard).props;
    const picked = r.root.findAllByType(QuizChoices).filter((q) => q.props.pick !== null);
    expect(picked).toHaveLength(1);
    expect(picked[0].props.focusRef).toBe(card.answerExtraFocus);
    expect(String(card.answerExtraFocus.current?.props.accessibilityLabel)).toMatch(/Your choice, wrong\.$/);
  });

  // Final device pass K1-1: on the phone the app-wide keyboard guard
  // (src/platform/keyboardBack.ts) is installed at app start, and the
  // navigator's own Back listener under the session asks it first. The
  // session must work exactly as before, and the guard must stay in step
  // with it: a press the session took for the keyboard is never taken AGAIN
  // by the guard when the session passes the next press to the navigator.
  describe('with the app-wide keyboard guard installed (K1-1)', () => {
    let install: keyboardBack.KeyboardBackInstall | null = null;
    /** The navigator's own Back (it closes the screen on top): an older listener, so it is asked last. */
    const navigatorBack = jest.fn(() => true);

    /** Install the guard on the (spied) BackHandler and Keyboard, then add the navigator's listener, like the app. */
    function installLikeTheApp(): void {
      install = keyboardBack.installKeyboardBackGuard({ backHandler: BackHandler, keyboard: Keyboard });
      BackHandler.addEventListener('hardwareBackPress', navigatorBack);
    }

    /** Who took a Back press: 'taken' (the session or the guard), 'navigator', or 'nobody'. */
    function pressBackInApp(): 'taken' | 'navigator' | 'nobody' {
      const before = navigatorBack.mock.calls.length;
      const handled = pressBack() === 'session';
      if (navigatorBack.mock.calls.length > before) return 'navigator';
      return handled ? 'taken' : 'nobody';
    }

    afterEach(() => {
      install?.uninstall();
      install = null;
      navigatorBack.mockClear();
    });

    it('the session’s listener is not wrapped; the navigator under it is', () => {
      installLikeTheApp();
      renderSession(screenState(3));
      // The navigator's listener (first) is the guard's wrapper, the session's (last) is its own.
      expect(backListeners).toHaveLength(2);
      expect(backListeners[0]).not.toBe(navigatorBack);
      // Nothing rated, no keyboard: the session leaves, so the navigator goes back.
      expect(pressBackInApp()).toBe('navigator');
    });

    it('nothing rated, the keyboard closed by itself: ONE press only closes it, the next press leaves', () => {
      installLikeTheApp();
      const r = renderSession(screenState(3), 'type');
      keyboardOpen = true;
      keyboardHid(); // closed by itself on a Back press, before the app heard it
      expect(pressBackInApp()).toBe('taken');
      expect(exitSheetOpen(r)).toBe(false);
      // The session used the window up, and told the guard: the navigator's press is not taken again.
      expect(pressBackInApp()).toBe('navigator');
    });

    it('nothing rated, Back with the keyboard open: it only closes it, and the next press leaves', () => {
      installLikeTheApp();
      renderSession(screenState(3), 'type');
      keyboardOpen = true;
      expect(pressBackInApp()).toBe('taken');
      keyboardHid(); // the hide the session asked for: it never takes the next press (session or guard)
      expect(pressBackInApp()).toBe('navigator');
    });

    it('a Back press just after "Check" is a real Back (the guard knows the session closed the keyboard)', () => {
      installLikeTheApp();
      const r = renderSession(screenState(3), 'type');
      keyboardOpen = true;
      checkOnScreen(r, 'falsch');
      keyboardHid();
      // Nothing rated yet (only checked): the session leaves at once.
      expect(pressBackInApp()).toBe('navigator');
    });

    it('after a rating it still asks "End this session?" (exactly as without the guard)', () => {
      installLikeTheApp();
      const r = renderSession(screenState(3), 'type');
      checkOnScreen(r, 'falsch');
      act(() => r.root.findByType(RatingButtons).props.onRate('good'));
      keyboardOpen = true;
      keyboardHid();
      expect(pressBackInApp()).toBe('taken');
      expect(exitSheetOpen(r)).toBe(false);
      expect(pressBackInApp()).toBe('taken');
      expect(exitSheetOpen(r)).toBe(true);
      expect(mockActions.completeSession).not.toHaveBeenCalled();
    });

    it('the card editor on top: the press that closed ITS keyboard does not close the editor; the next one does', () => {
      installLikeTheApp();
      const r = renderSession(screenState(3));
      rateOnScreen(r, 'good');
      mockFocused = false; // More › Edit card: the editor is on top
      keyboardOpen = true;
      keyboardHid(); // the editor's keyboard closed itself on a Back press
      expect(pressBackInApp()).toBe('taken'); // the guard took it: the editor stays (K1-1)
      expect(exitSheetOpen(r)).toBe(false);
      expect(pressBackInApp()).toBe('navigator'); // a real Back: the navigator closes the editor
      // With the editor's keyboard still open, Back only closes it.
      keyboardOpen = true;
      expect(pressBackInApp()).toBe('taken');
      expect(exitSheetOpen(r)).toBe(false);
      expect(mockActions.completeSession).not.toHaveBeenCalled();
    });
  });
});
