/**
 * The rules of a study session and of the Complete screen (spec §6, unit
 * W4-4). Pure: no React, no clock, no store. The screens
 * (src/app/session.tsx, src/app/complete.tsx) hold React state and call
 * these functions; every decision lives here, so it is tested.
 *
 * What is here, in order:
 *
 *   1. ROUTE   `/session?kind=&q=&sel=&mode=&sort=&label=` → a SessionRoute
 *              (parseSessionRoute), and back (sessionHref). Only this
 *              format: the old v2 params (deckId, collectionId, cardIds) and
 *              kinds (cram, hardest, deck, collection) went away with the
 *              v2 screens that sent them (W5-5a).
 *   2. START   the session's queue, built ONCE (spec §6.1): the same
 *              `buildSessionQueue` (scope.ts) that counts every "Study N"
 *              button, so the button number is the queue length. The
 *              per-card mode plans (modes.ts planCards) are fixed here too.
 *   3. RUN     the session's own state (RunState): the queue, the index, the
 *              counts, the run of correct answers, the UNDO stack of
 *              snapshots, the missed cards, and the answer state of the card
 *              on screen. Every change is a pure function that returns a new
 *              RunState (rateRun, undoRun, removeFromRun, restoreToRun,
 *              restoreDeleted, dropMissing, switchModeRun); leaveOutcome says what happens
 *              when a card leaves the session ("All done here" when it was
 *              the last one, sessionScreen), and backPressAction what
 *              Android's Back does.
 *   4. CARD    what the card on screen shows: the suggested rating, the
 *              intervals on the rating buttons (ratingPredictions, a Check
 *              included), the hint button, the headline size, the
 *              screen-reader texts, the question line of the answer side
 *              (answerQuestionLine).
 *   5. END     the Complete screen's "Keep going" rows (keepGoingCounts,
 *              keepGoingRows), its line about the missed cards
 *              (missedLine), the empty-queue copy, and the early-exit
 *              snackbar ("Session saved · 3 cards · +12 XP").
 *
 * The session rules that keep the data safe (spec §3.12) and where they are:
 *   - undo snapshots: rateRun pushes one RunSnapshot per rating; undoRun
 *     pops it and also gives back bestRun and fastAnswers (L9 / #7);
 *   - "Again" re-queues the card at idx + 3 (requeueIndex), as the card
 *     rateCard RETURNED, so its intervals show the lapse (M10);
 *   - the in-flight marker after every rating (markerOf, with studyDay);
 *   - practice writes nothing (H3): the session passes `wrote` = whether
 *     the kind changes the schedule, and undo only undoes a review that
 *     was written.
 */
import { ARTICLE_HINT_COPY, type AnswerResult, leadHintCopy } from '../../domain/answerCheck';
import { createQuizPool } from '../../domain/distractors';
import { blockText, type FaceOf, facesFor } from '../../domain/face';
import { levelName } from '../../domain/gamification';
import { type Hint, hintAt, hintSourceOf, type HintSource } from '../../domain/hints';
import type { GermanArticle } from '../../domain/lang';
import { life } from '../../domain/life';
import type {
  Card,
  CardFace,
  DataStateV3,
  FieldBlock,
  Id,
  InProgressSession,
  Query,
  SortSpec,
  StudyMode,
} from '../../domain/model';
import {
  articleCards,
  type ArticleQuestion,
  canOfferArticles,
  type CardPlan,
  type Fallback,
  isStudyMode,
  type ModeOutcome,
  planCards,
  suggestRating,
  wayTitle,
} from '../../domain/modes';
import { isEmptyQuery, type MatchCtx, parseQueryParam, sanitizeQuery, serializeQuery } from '../../domain/query';
import { isSpeakerBlock } from '../../domain/render';
import {
  buildSessionQueue,
  decksById,
  libraryIndexOf,
  listsOf,
  type ScopeState,
  scopePool,
  type SessionParams,
} from '../../domain/scope';
import { predictAll, type Predictions } from '../../domain/srs';
import { plural } from '../../domain/text';
import { dayKeyOf, MIN, type Rating, type SrsSettings } from '../../domain/types';
import { hideOpensGrace, keyboardBackAction } from '../../platform/keyboardBack';
import { triageLookupOf } from '../deck/deckPageLogic';
import { triageItems } from '../deck/triageLogic';
import { NOT_STARTED_SCOPE, PRACTICE_SCOPE } from '../today/todayLogic';

/* ================================================================== 1. route */

/** The kinds a session route opens (spec §2.2). */
export type RouteKind = 'scheduled' | 'ahead' | 'practice';

/** What `/session?kind=&q=&sel=&mode=&sort=&label=` asks for. */
export interface SessionRoute {
  kind: RouteKind;
  /** The scope (a Query, §4.1). `{}` = all decks. For a selection it is `{}`. */
  q: Query;
  /** A selection token (selectionRegistry), or null. Card ids are never in a URL. */
  sel: string | null;
  /** The study mode the caller asks for; null = Settings › Study mode. */
  mode: StudyMode | null;
  /** The practice order; null = the pool order. */
  sort: SortSpec | null;
  /** What was studied ("German · Level B1"); null = made from the scope. */
  label: string | null;
}

/** The params expo-router gives (a repeated param may come as an array). */
export type RouteParams = Readonly<Record<string, string | string[] | undefined>>;

/** The first value of a route param, or undefined. */
function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : undefined;
}

const SORT_BYS: readonly SortSpec['by'][] = ['source', 'due', 'az', 'newest', 'hardest', 'field'];

/**
 * The `sort` param → a SortSpec: JSON (`{"by":"field","field":"level"}`) or a
 * bare `by` word (`hardest`). Anything else → null (the pool order).
 *
 *   parseSortParam('hardest')            → { by: 'hardest' }
 *   parseSortParam('{"by":"az","dir":"desc"}') → { by: 'az', dir: 'desc' }
 *   parseSortParam('nonsense')           → null
 */
export function parseSortParam(raw: string | string[] | undefined): SortSpec | null {
  const text = first(raw)?.trim();
  if (!text) return null;
  let value: unknown = text;
  if (text.startsWith('{')) {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const obj: Record<string, unknown> =
    typeof value === 'string' ? { by: value } : value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const by = obj.by;
  if (typeof by !== 'string' || !(SORT_BYS as readonly string[]).includes(by)) return null;
  const sort: SortSpec = { by: by as SortSpec['by'] };
  if (typeof obj.field === 'string' && obj.field !== '') sort.field = obj.field;
  if (obj.dir === 'asc' || obj.dir === 'desc') sort.dir = obj.dir;
  if (sort.by === 'field' && !sort.field) return null;
  return sort;
}

/** "Hardest first": ease ascending, then lapses descending (spec §6.6). */
export const HARDEST_SORT: SortSpec = Object.freeze({ by: 'hardest' }) as SortSpec;

/**
 * The `kind` param → a route kind: 'scheduled' (Study), 'ahead' (Study
 * ahead) or 'practice'. Anything else → Study. The old v2 kinds ('cram',
 * 'hardest', 'deck', 'collection') are not read any more: nothing sends them
 * since the v2 screens were deleted. "Practice your hardest" is
 * `kind=practice&sort=hardest`.
 */
export function parseKind(raw: string | undefined): RouteKind {
  return raw === 'ahead' || raw === 'practice' ? raw : 'scheduled';
}

/**
 * The route params → what the session opens. A broken param never crashes:
 * a bad `q` is `{}`, a bad `mode` or `sort` is null. A selection (`sel`) is
 * always Practice (spec §2.2: "Practice the {n} you missed", "Practice {n}
 * selected"), and it has no query. Any other param is ignored.
 */
export function parseSessionRoute(params: RouteParams): SessionRoute {
  const sel = first(params.sel)?.trim() || null;
  const mode = first(params.mode);
  return {
    kind: sel ? 'practice' : parseKind(first(params.kind)),
    q: sel ? {} : parseQueryParam(first(params.q)),
    sel,
    mode: isStudyMode(mode) ? mode : null,
    sort: parseSortParam(params.sort),
    label: first(params.label)?.trim() || null,
  };
}

/**
 * The href of a session (for router.push / router.replace). Only the params
 * that say something are set, so the URL stays short.
 *
 *   sessionHref({ kind: 'ahead', q: { decks: ['d1'] }, label: 'German' })
 *     → { pathname: '/session', params: { kind: 'ahead', q: '{"decks":["d1"]}', label: 'German' } }
 */
export function sessionHref(route: Partial<SessionRoute> & { kind: RouteKind }): {
  pathname: '/session';
  params: Record<string, string>;
} {
  const params: Record<string, string> = { kind: route.kind };
  if (route.sel) params.sel = route.sel;
  else if (route.q && !isEmptyQuery(route.q)) params.q = serializeQuery(route.q);
  if (route.mode) params.mode = route.mode;
  if (route.sort) params.sort = JSON.stringify(route.sort);
  if (route.label) params.label = route.label;
  return { pathname: '/session', params };
}

/**
 * A text key of the params that decide the session. When it changes while the
 * screen stays mounted (a replace to the same route can keep the screen),
 * the screen starts a NEW session (it is the `key` of the session body).
 */
export function routeKey(params: RouteParams): string {
  const keys = ['kind', 'q', 'sel', 'mode', 'sort', 'label'];
  return JSON.stringify(keys.map((k) => first(params[k]) ?? null));
}

/**
 * The href of the Complete screen: the session's scope (for "Keep going")
 * and the token of the missed cards (for "Practice the {n} you missed").
 * Card ids are never put in a URL: only the selection token is.
 */
export function completeHref(
  scope: Query,
  missedToken: string | null,
): { pathname: '/complete'; params: Record<string, string> } {
  const params: Record<string, string> = {};
  if (!isEmptyQuery(scope)) params.q = serializeQuery(scope);
  if (missedToken) params.missed = missedToken;
  return { pathname: '/complete', params };
}

/** The Complete screen's params → its scope and the missed-cards token. */
export function parseCompleteParams(params: RouteParams): { scope: Query; missed: string | null } {
  return { scope: parseQueryParam(first(params.q)), missed: first(params.missed)?.trim() || null };
}

/* ================================================================== 2. start */

/**
 * The SessionParams of scope.ts for a route. A selection whose token is
 * unknown (`selIds` null: the app restarted, or the token expired) → null:
 * the screen shows "This selection is no longer available."
 */
export function sessionParamsOf(route: SessionRoute, selIds: readonly Id[] | null): SessionParams | null {
  if (route.sel) return selIds ? { kind: 'practice', sel: selIds, sort: route.sort } : null;
  if (route.kind === 'practice') return { kind: 'practice', q: route.q, sort: route.sort };
  return { kind: route.kind, q: route.q };
}

/** Does this kind change the schedule? Practice writes nothing (H3, reducer.ts writesSchedule). */
export function routeWrites(kind: RouteKind): boolean {
  return kind !== 'practice';
}

/**
 * The session's mode: the route's, else Settings › Study mode. Articles is
 * "Practice only" (spec §6.3): it has no rating buttons, so a Study session
 * never runs in it (it uses the Settings mode instead).
 */
export function sessionModeOf(kind: RouteKind, routeMode: StudyMode | null, settingsMode: StudyMode): StudyMode {
  const mode = routeMode ?? settingsMode;
  if (mode === 'article' && kind !== 'practice') return settingsMode === 'article' ? 'flash' : settingsMode;
  return mode;
}

/** The state with no session-size cap (for the Articles queue, which cuts by itself). */
function uncapped<S extends ScopeState>(state: S): S {
  return { ...state, settings: { ...state.settings, sessionLimit: 0 } };
}

/**
 * The cards of an Articles practice (spec §6.3): the practice cards of the
 * scope (the selectPractice rules of §6.6, in the asked order) BEFORE the
 * session-size cut, then `articleCards` keeps the German nouns, one card per
 * item, and cuts to the session size. The deck page's "Practice articles ·
 * {n}" must use this same function, so the button number is the queue length.
 */
export function articleQueue(params: SessionParams, state: ScopeState, ctx: MatchCtx, faceOf: FaceOf): Card[] {
  if (params.kind !== 'practice') return [];
  return articleCards(buildSessionQueue(params, uncapped(state), ctx), faceOf, state.settings.sessionLimit);
}

/** The card → face function of a state (the same one useFaces() gives). */
export function faceOfState(state: Pick<DataStateV3, 'notes' | 'noteTypes' | 'decks'>): FaceOf {
  return facesFor(libraryIndexOf(state), decksById(state.decks));
}

/**
 * The plans (how each card is asked, modes.ts) of `cards` in `mode`. The
 * quiz pool is made only for Quiz and Mixed, and it builds a deck's choices
 * only when the first card of that deck needs them.
 */
export function plansFor(
  cards: readonly Card[],
  mode: StudyMode,
  kind: RouteKind,
  dayKey: string,
  state: ScopeState,
): Map<Id, CardPlan> {
  const library = libraryIndexOf(state);
  const faceOf = facesFor(library, decksById(state.decks));
  const quiz = mode === 'mc' || mode === 'mix' ? createQuizPool(state.cards, library, faceOf, dayKey) : null;
  return planCards(cards, { mode, kind, dayKey, faceOf, library, quiz });
}

/**
 * What a study session needs to start ("label" for the record, the scope
 * for the Complete screen's "Keep going" rows).
 *   - `params` null and `expired` true: the selection is no longer available.
 */
export interface SessionStart {
  expired: boolean;
  params: SessionParams | null;
  kind: RouteKind;
  mode: StudyMode;
  label: string;
  /** The scope for "Keep going" and the empty queue ({} for a selection). */
  scope: Query;
  queue: Card[];
  plans: Map<Id, CardPlan>;
}

/** How old the screens' time may be for a new session to build its queue at it: one tick (1 min) + slack. */
export const COUNTED_TIME_MAX_AGE_MS = 2 * MIN;

/**
 * The moment a new session builds its queue at (final review): the time
 * the Study buttons counted with — the app's ONE shared clock (useNow,
 * at most a minute old) — so "Study N" opens exactly N cards (spec §0),
 * never one more learning card that became due since the clock's last
 * tick. Only while that time is fresh (not in the future, at most
 * COUNTED_TIME_MAX_AGE_MS old) and of the same local day as `startedAt`
 * (the session's day); else the real time `startedAt`.
 *
 *   sessionQueueTime(09:00:00, 09:00:40) → 09:00:00   (the button's time)
 *   sessionQueueTime(08:50:00, 09:00:40) → 09:00:40   (too old: the real time)
 *   sessionQueueTime(23:59:00, 00:00:01) → 00:00:01   (a new day: today's budget)
 */
export function sessionQueueTime(countedAt: number, startedAt: number): number {
  const age = startedAt - countedAt;
  if (!Number.isFinite(age) || age < 0 || age > COUNTED_TIME_MAX_AGE_MS) return startedAt;
  return dayKeyOf(countedAt) === dayKeyOf(startedAt) ? countedAt : startedAt;
}

/**
 * Build a session (spec §6.1). Call it ONCE, in the screen's useState
 * initializer, with the current state, the moment `now` (the queue's time:
 * `sessionQueueTime`) and the selection ids (`getSelection(route.sel)`,
 * null when unknown).
 *
 *   scheduled → planQueue(selectScheduled(scopePool(q, 'study')))   (scope.ts buildSessionQueue)
 *   ahead     → selectAhead(scopePool(q, 'study'))
 *   practice  → selectPractice(scopePool(q, 'browse') or the selection, sort)
 *   practice + Articles → articleQueue (German nouns only)
 */
export function startSession(
  route: SessionRoute,
  state: ScopeState,
  ctx: MatchCtx,
  dayKey: string,
  selIds: readonly Id[] | null,
): SessionStart {
  const params = sessionParamsOf(route, selIds);
  const mode = sessionModeOf(route.kind, route.mode, state.settings.studyMode);
  const scope = route.sel ? {} : sanitizeQuery(route.q);
  if (!params) {
    const label = sessionLabel(route, state);
    return { expired: true, params: null, kind: route.kind, mode, label, scope, queue: [], plans: new Map() };
  }
  const queue =
    mode === 'article' ? articleQueue(params, state, ctx, faceOfState(state)) : buildSessionQueue(params, state, ctx);
  // A selection is named by its size ("Practice · 1 card"), so the label needs the queue.
  const label = sessionLabel(route, state, route.sel ? queue.length : undefined);
  const plans = plansFor(queue, mode, route.kind, dayKey, state);
  return { expired: false, params, kind: route.kind, mode, label, scope, queue, plans };
}

/**
 * The flags that only HIDE cards: a paused deck, a suspended or a buried
 * card. A scope that leaves them out still names the same decks: Today's
 * "Practice" scope `{ notFlags: ['paused'] }` is "All decks", not
 * "Filtered cards" (and a Study pool leaves them out by itself, scope.ts).
 */
const HIDING_FLAGS: ReadonlySet<string> = new Set(['paused', 'suspended', 'buried']);

/**
 * The scope as it is NAMED: sanitized, without the `notFlags` that only hide
 * cards (HIDING_FLAGS). Only for the label; the session still uses the
 * whole scope.
 *
 *   namedScope({ notFlags: ['paused'] })                    → {}
 *   namedScope({ decks: ['d1'], notFlags: ['paused', 'fav'] }) → { decks: ['d1'], notFlags: ['fav'] }
 */
function namedScope(q: Query): Query {
  const named = sanitizeQuery(q);
  const kept = (named.notFlags ?? []).filter((flag) => !HIDING_FLAGS.has(flag));
  if (kept.length > 0) named.notFlags = kept;
  else delete named.notFlags;
  return named;
}

/**
 * The label of a Practice of a selection of `n` cards: "Practice · 1 card",
 * "Practice · 12 cards". WHY not the label the caller passed: CardSheet's
 * "Practice this card" passes the card's own text ("over / about / across"),
 * and the Complete overline then shouted it in capitals (wave-5b
 * walkthrough L17). The size names a selection well, whatever the caller.
 */
export function selectionLabel(n: number): string {
  return `Practice · ${plural(n, 'card')}`;
}

/**
 * The session's label (SessionRecord.scopeLabel, the Complete overline):
 *   - a selection (`sel`): a label that names the practice ("Missed cards",
 *     PRACTICE_ONLY_LABELS) stays; else "Practice · {n} cards" (selectionLabel)
 *     with `selectionSize` = the length of the session's queue; without a
 *     size (an expired selection), the route's label or "Selected cards";
 *   - else the route's `label`;
 *   - else from the scope (namedScope: the flags that only hide cards do not
 *     count): the one deck's name, the list's name, "All decks" for `{}`,
 *     "Filtered cards" for any other scope.
 *
 *   sessionLabel({ kind: 'ahead', q: { notFlags: ['paused'] }, … })  → 'All decks'
 *   sessionLabel({ kind: 'practice', sel: 't', label: 'over / about', … }, state, 1) → 'Practice · 1 card'
 */
export function sessionLabel(route: SessionRoute, state: Pick<ScopeState, 'decks' | 'lists'>, selectionSize?: number): string {
  if (route.sel) {
    if (route.label && PRACTICE_ONLY_LABELS.has(route.label)) return route.label;
    if (selectionSize !== undefined) return selectionLabel(selectionSize);
    return route.label ?? 'Selected cards';
  }
  if (route.label) return route.label;
  const q = namedScope(route.q);
  const keys = Object.keys(q);
  if (keys.length === 0) return 'All decks';
  if (keys.length === 1 && q.decks?.length === 1) {
    const deck = decksById(state.decks).get(q.decks[0]);
    if (deck) return deck.name;
  }
  if (keys.length === 1 && q.list !== undefined) {
    const list = listsOf(state.lists).get(q.list);
    if (list) return list.name;
  }
  return 'Filtered cards';
}

/* ================================================================== 3. run */

/** A card in the queue. `requeued` = this copy came back after "Again" in this session. */
export type QueueCard = Card & { requeued?: boolean };

/** The four ratings, all at 0. */
export const ZERO_COUNTS: Readonly<Record<Rating, number>> = Object.freeze({ again: 0, hard: 0, good: 0, easy: 0 });

/** Reveal → rate faster than this is a "fast answer" (Quick draw achievement). */
export const FAST_ANSWER_MS = 3000;

/** The four ratings, in button order. */
export const RATINGS: readonly Rating[] = Object.freeze(['again', 'hard', 'good', 'easy']);

/** The word on each rating button. */
export const RATING_LABELS: Readonly<Record<Rating, string>> = Object.freeze({
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
});

/**
 * The answer state of the card on screen. `key` says which card (and which
 * place in the queue) it belongs to; when the card on screen changes, a
 * fresh state is used (currentUi). So nothing of the last card leaks into
 * the next one, and undo can give an old card its answer state back.
 */
export interface CardUi {
  key: string;
  /** The answer side is shown (and the rating buttons). */
  revealed: boolean;
  /** When the answer was shown or checked (ms; 0 = not yet). The "reveal" moment of a fast answer. */
  revealedAt: number;
  /** How many hint taps (0–2; the third tap reveals). */
  hintStep: number;
  /** Typing: the result of "Check". */
  check: AnswerResult | null;
  /** Quiz: the index of the picked choice. */
  pick: number | null;
  /** Articles: the picked article. */
  article: GermanArticle | null;
}

/** The key of the card at `idx`. */
export function uiKey(card: Pick<Card, 'id'> | undefined, idx: number): string {
  return card ? `${card.id}#${idx}` : `#${idx}`;
}

/** A card's answer state before anything was done. */
export function freshUi(key: string): CardUi {
  return { key, revealed: false, revealedAt: 0, hintStep: 0, check: null, pick: null, article: null };
}

/** One undo step: everything a rating changed in the session (spec §6.1 "snapshot undo stack"). */
export interface RunSnapshot {
  queue: QueueCard[];
  idx: number;
  counts: Record<Rating, number>;
  run: number;
  /** bestRun BEFORE the rating, so undo also takes back the run bonus (#7). */
  bestRun: number;
  /** fastAnswers BEFORE the rating (L9). */
  fastAnswers: number;
  missed: Id[];
  /** Did this rating write the schedule? (Practice does not, H3.) Only then does undo call undoLastReview. */
  wrote: boolean;
  /** The card's answer state, so it shows again after undo (suggestion and all). */
  ui: CardUi;
  /** The card's plan at the time (Switch mode may have changed it since). */
  plan: CardPlan | undefined;
}

/** The session's own state. Every change makes a new object. */
export interface RunState {
  queue: QueueCard[];
  /** The index of the card on screen = how many cards were rated. */
  idx: number;
  counts: Record<Rating, number>;
  /** Correct answers in a row (Again resets it). */
  run: number;
  bestRun: number;
  fastAnswers: number;
  /** The cards rated "Again", once each, in the order they were missed (§6.7). */
  missed: Id[];
  /** The undo stack: one snapshot per rating, newest last. */
  history: RunSnapshot[];
  /** Cards that LEFT this session (bury, suspend, reschedule, deleted): undo never brings them back. */
  left: Id[];
  /** The answer state of the card on screen (see CardUi). */
  ui: CardUi;
  /** How each card is asked, by card id (modes.ts planCards). */
  plans: ReadonlyMap<Id, CardPlan>;
}

/** The first state of a session. */
export function initialRun(queue: readonly Card[], plans: ReadonlyMap<Id, CardPlan>): RunState {
  return {
    queue: [...queue],
    idx: 0,
    counts: { ...ZERO_COUNTS },
    run: 0,
    bestRun: 0,
    fastAnswers: 0,
    missed: [],
    history: [],
    left: [],
    ui: freshUi(uiKey(queue[0], 0)),
    plans,
  };
}

/** The card on screen, or undefined when the queue is done. */
export function currentCard(run: RunState): QueueCard | undefined {
  return run.queue[run.idx];
}

/** The answer state of the card on screen (a fresh one when the card changed). */
export function currentUi(run: RunState): CardUi {
  const key = uiKey(currentCard(run), run.idx);
  return run.ui.key === key ? run.ui : freshUi(key);
}

/** Change the answer state of the card on screen. */
export function patchUi(run: RunState, patch: Partial<Omit<CardUi, 'key'>>): RunState {
  return { ...run, ui: { ...currentUi(run), ...patch } };
}

/**
 * How the learner answered the card on screen: a tap that shows the answer
 * (Flashcards, or the last hint tap), "Check" (Typing), a choice (Quiz) or an
 * article (Articles).
 */
export type Answer =
  | { kind: 'reveal'; hintStep?: number }
  | { kind: 'check'; result: AnswerResult }
  | { kind: 'pick'; index: number }
  | { kind: 'article'; choice: GermanArticle };

/**
 * Record an answer of the card with ui key `key`, at `at` (ms). The FIRST
 * answer of a card wins: once the answer side is shown, a second answer
 * changes nothing, and an answer for another card (the card changed in
 * between) is ignored.
 *
 * WHY here, and not only in the tap handler: the handler sees the state of
 * the LAST render. Two taps before React draws again (two fingers, Enter
 * plus the "Check" button) both pass a check in the handler. The session
 * calls this inside its state update (`setRun((r) => answerRun(r, …))`), so
 * the second update sees the first answer and keeps it. Without it the LAST
 * tap won: a wrong choice and then the right one in one frame showed the
 * right one as picked and suggested Good.
 *
 *   answerRun(run, key, { kind: 'pick', index: 0 }, t1) → pick 0, revealed
 *   … then answerRun(that, key, { kind: 'pick', index: 2 }, t2) → the same object (pick stays 0)
 */
export function answerRun(run: RunState, key: string, answer: Answer, at: number): RunState {
  const ui = currentUi(run);
  if (ui.key !== key || ui.revealed) return run;
  const shown = { revealed: true, revealedAt: at };
  switch (answer.kind) {
    case 'reveal':
      return patchUi(run, answer.hintStep !== undefined ? { ...shown, hintStep: answer.hintStep } : shown);
    case 'check':
      return patchUi(run, { ...shown, check: answer.result });
    case 'pick':
      return patchUi(run, { ...shown, pick: answer.index });
    case 'article':
      return patchUi(run, { ...shown, article: answer.choice });
  }
}

/** A plan for a card that has none (a flashcard). */
export const FLASH_PLAN: CardPlan = Object.freeze({
  mode: 'flash',
  fallback: null,
  typing: null,
  quiz: null,
  article: null,
}) as CardPlan;

/** The plan of the card on screen. */
export function currentPlan(run: RunState): CardPlan {
  const card = currentCard(run);
  return (card && run.plans.get(card.id)) || FLASH_PLAN;
}

/** Where "Again" puts the card back: 3 places later, or at the end (spec §6.1). */
export function requeueIndex(idx: number, length: number): number {
  return Math.min(idx + 3, length);
}

/** True when the answer counts as fast: no hint, and rated within 3 s of the reveal (or Check / choice). */
export function isFastAnswer(ui: CardUi, now: number): boolean {
  return ui.hintStep === 0 && ui.revealedAt > 0 && now - ui.revealedAt < FAST_ANSWER_MS;
}

/** What a rating needs. */
export interface RateInput {
  rating: Rating;
  /**
   * The card `rateCard` RETURNED (M6): after the rating for Study, unchanged
   * for Practice. The "Again" copy is this card, so its intervals show the lapse (M10).
   */
  rated: Card;
  /** Does the session change the schedule (routeWrites)? */
  wrote: boolean;
  /** The moment of the tap (for the fast-answer rule). */
  now: number;
}

/** The result of one rating. */
export interface RateOutcome {
  next: RunState;
  /** True when this was the last card: the session ends now. */
  finished: boolean;
  /** Cards rated so far, this one included. */
  reviewed: number;
  /** "5 in a row" (every 5th correct answer in a row), else null. */
  milestone: number | null;
}

/**
 * One rating (spec §6.1). Pushes the undo snapshot, counts the rating,
 * re-queues an "Again" card at idx + 3, keeps the run of correct answers
 * and the missed cards, and moves to the next card.
 */
export function rateRun(run: RunState, input: RateInput): RateOutcome {
  const card = currentCard(run);
  if (!card) return { next: run, finished: true, reviewed: run.idx, milestone: null };
  const ui = currentUi(run);
  const snapshot: RunSnapshot = {
    queue: run.queue,
    idx: run.idx,
    counts: run.counts,
    run: run.run,
    bestRun: run.bestRun,
    fastAnswers: run.fastAnswers,
    missed: run.missed,
    wrote: input.wrote,
    ui,
    plan: run.plans.get(card.id),
  };
  const again = input.rating === 'again';
  let queue = run.queue;
  if (again) {
    queue = [...run.queue];
    queue.splice(requeueIndex(run.idx, run.queue.length), 0, { ...input.rated, requeued: true });
  }
  const nextRunLength = again ? 0 : run.run + 1;
  const reviewed = run.idx + 1;
  const finished = reviewed >= queue.length;
  const next: RunState = {
    ...run,
    queue,
    idx: finished ? run.idx : reviewed,
    counts: { ...run.counts, [input.rating]: run.counts[input.rating] + 1 },
    run: nextRunLength,
    bestRun: Math.max(run.bestRun, nextRunLength),
    fastAnswers: run.fastAnswers + (isFastAnswer(ui, input.now) ? 1 : 0),
    missed: again && !run.missed.includes(card.id) ? [...run.missed, card.id] : run.missed,
    history: [...run.history, snapshot],
  };
  const milestone = nextRunLength > 0 && nextRunLength % 5 === 0 ? nextRunLength : null;
  return { next, finished, reviewed, milestone };
}

/**
 * Undo the last rating (spec §6.1): the snapshot comes back, and the card
 * shows its answer side again (with its old answer state and plan).
 *
 * The restored queue is checked first: a card that LEFT the session since
 * (bury, suspend, reschedule, a deleted note — `blocked(id)`) must not come
 * back, but the cards up to the restored index stay, so the index still
 * points at the card being un-rated (#6).
 *
 * A card that came BACK into the session after the snapshot stays too: it
 * is still to come now, but the snapshot was taken while it was out (the
 * card editor's Undo of a deleted note, restoreDeleted). It goes right after
 * the card being un-rated, in its order of now. WHY (wave 5c, review round
 * 2): rate c1 · delete c2's note in the editor · rate c3 · the editor's
 * Undo puts c2 on screen · then undo the rating of c3. The snapshot of c3
 * has no c2, so c2 was silently gone from the session (neither in the
 * queue nor in `left`). The editor's snackbar stays 6 s, so this order is
 * real. A card is compared by id, from the restored index on: the "Again"
 * copy of the un-rated card (same id) still goes, as before.
 *
 *   history top = { queue: [c1, c3, c4], idx: 1 }, run.queue = [c1, c3, c2, c4], idx 2
 *     → queue [c1, c3, c2, c4], idx 1 (c3 on screen again, then c2)
 *
 * null when there is nothing to undo.
 */
export function undoRun(run: RunState, blocked: (id: Id) => boolean): { next: RunState; snapshot: RunSnapshot } | null {
  const prev = run.history[run.history.length - 1];
  if (!prev) return null;
  const kept = prev.queue.filter((q, i) => i <= prev.idx || !blocked(q.id));
  // The cards still to come now that the snapshot does not have (they came back since it was taken).
  const ahead = new Set(kept.slice(prev.idx).map((q) => q.id));
  const returned = run.queue.slice(run.idx).filter((q) => {
    if (ahead.has(q.id) || blocked(q.id)) return false;
    ahead.add(q.id);
    return true;
  });
  const queue =
    returned.length === 0 ? kept : [...kept.slice(0, prev.idx + 1), ...returned, ...kept.slice(prev.idx + 1)];
  const card = queue[prev.idx];
  const plans = new Map(run.plans);
  if (card && prev.plan) plans.set(card.id, prev.plan);
  const next: RunState = {
    ...run,
    queue,
    idx: prev.idx,
    counts: prev.counts,
    run: prev.run,
    bestRun: prev.bestRun,
    fastAnswers: prev.fastAnswers,
    missed: prev.missed,
    history: run.history.slice(0, -1),
    ui: { ...prev.ui, key: uiKey(card, prev.idx), revealed: true },
    plans,
  };
  return { next, snapshot: prev };
}

/**
 * The card leaves this session (bury, suspend, reschedule): every copy at
 * or after the card on screen is taken out, and the id is remembered in
 * `left` (so undo never brings it back). Cards already rated stay.
 */
export function removeFromRun(run: RunState, cardId: Id): RunState {
  const queue = run.queue.filter((q, i) => i < run.idx || q.id !== cardId);
  return {
    ...run,
    queue,
    left: run.left.includes(cardId) ? run.left : [...run.left, cardId],
  };
}

/** True when the session has no card left to show. */
export function isExhausted(run: RunState): boolean {
  return run.idx >= run.queue.length;
}

/** What happens to the session after a card left it (see leaveOutcome). */
export interface LeaveOutcome {
  next: RunState;
  /**
   * 'stay'  cards are left: the session goes on, and its own snackbar shows
   *         the message of the action, with its Undo;
   * 'done'  nothing is left: the session screen STAYS, in the "All done
   *         here" state (sessionScreen). It shows the message and keeps its
   *         Undo on screen until the learner taps "Finish session" (or
   *         "Back" when nothing was rated).
   *
   * WHY 'done' does not end the session at once (wave-5b walkthrough M1):
   * when "Suspend" on the LAST card closed the session, its "Suspended ·
   * Undo" snackbar went away with it, and a late tap on Undo hit the next
   * screen. Now the Undo is always reachable.
   */
  end: 'stay' | 'done';
}

/**
 * The card on screen leaves the session (bury, suspend, reschedule, a deleted
 * note). Example: 5 cards rated, the 6th (the last) is suspended →
 * `end: 'done'`: "All done here", with "Undo" and "Finish session".
 */
export function leaveOutcome(run: RunState, cardId: Id): LeaveOutcome {
  const next = removeFromRun(run, cardId);
  return { next, end: isExhausted(next) ? 'done' : 'stay' };
}

/**
 * What the session screen shows:
 *   'card'     the card on screen;
 *   'empty'    the session opened with nothing to study (EmptyQueue);
 *   'allDone'  the last card LEFT the session (bury, suspend, reschedule, a
 *              deleted note): "All done here", with the action's Undo
 *              (AllDoneHere, see LeaveOutcome).
 * A session whose last card was RATED never shows a state: it opens Complete.
 * That holds also when a card left EARLIER (`left` is not empty): rateRun
 * keeps `idx` on the rated last card (the run is not exhausted), so this
 * returns 'card' while the screen fades to Complete. Only a card that
 * LEAVES can exhaust the run on screen (leaveOutcome 'done'), so 'allDone'
 * always means "the LAST card left".
 */
export function sessionScreen(run: RunState): 'card' | 'empty' | 'allDone' {
  if (!isExhausted(run)) return 'card';
  return run.left.length > 0 ? 'allDone' : 'empty';
}

/** The texts of the "All done here" state (session.tsx, EmptyQueue.tsx AllDoneHere). */
export const ALL_DONE_COPY = {
  title: 'All done here.',
  last: 'That was the last card of this session.',
  undo: 'Undo',
  finish: 'Finish session',
  leave: 'Back',
} as const;

/**
 * Put a card back into the session (the snackbar Undo of a reschedule or a
 * suspend): at the place of the card on screen, so it is shown again.
 * `replan` plans it in the session's CURRENT mode, like restoreDeleted
 * (wave 5d): a "Switch mode" while its Undo was on screen did not plan it.
 */
export function restoreToRun(
  run: RunState,
  card: QueueCard,
  replan?: (cards: readonly QueueCard[]) => ReadonlyMap<Id, CardPlan>,
): RunState {
  const queue = [...run.queue];
  if (!queue.slice(run.idx).some((q) => q.id === card.id)) queue.splice(run.idx, 0, card);
  let plans = run.plans;
  if (replan) {
    const merged = new Map(run.plans);
    for (const [id, plan] of replan([card])) merged.set(id, plan);
    plans = merged;
  }
  return { ...run, queue, left: run.left.filter((id) => id !== card.id), plans };
}

/**
 * The card editor's Undo brought back the note of a deleted card (wave 5c,
 * M1): put its queue cards back, so the session goes on with them.
 *
 * The story: More › "Edit card" › delete the note. Back on the session, its
 * cards have left the queue (dropMissing): the session shows the next card
 * with its own "Card deleted", or "All done here" when it was the last card.
 * The editor's global snackbar "“Wort” deleted · Undo" is still on screen.
 * Its Undo puts the note and its cards back in the STORE, but the session
 * did not see it: the card could not be studied any more. (Suspend and
 * Reschedule bring the card back with their own Undo, restoreToRun.)
 *
 * `deleted` = the queue cards that deletions took out (in queue order, an
 * "Again" copy included); `exists` says whether a card is in the store
 * again. Only a card that LEFT the session (its id is in `left`) comes back,
 * once. The cards that came back go back at the place of the card on screen,
 * in their old order, so the first one is on screen again: the same place as
 * the Undo of a Suspend (restoreToRun). This works on a card on screen and
 * on "All done here". An undo of a rating made while the card was out keeps
 * the card in the session (undoRun). null when nothing came back.
 *
 * `replan` (wave 5d, F1a) plans the cards that came back in the session's
 * CURRENT mode (session.tsx: plansFor with the mode now on). WHY: a card
 * keeps the plan it had when it left. "Switch mode" plans only the cards
 * still in the queue (switchModeRun), so a deleted card that came back
 * after a mode switch was asked in the OLD mode (a Quiz card in a Typing
 * session). It cannot be planned at the switch: its note is not in the
 * store then. Without `replan` the old plans stay (the tests of the queue
 * order).
 *
 *   'allDone' run, deleted = [c2], c2 in the store again → the run with c2 on screen ("2 / 2")
 *   c3 on screen ("2 / 2"), deleted = [c2], c2 back       → c2 on screen, then c3 ("2 / 3")
 */
export function restoreDeleted(
  run: RunState,
  deleted: readonly QueueCard[],
  exists: (id: Id) => boolean,
  replan?: (cards: readonly QueueCard[]) => ReadonlyMap<Id, CardPlan>,
): RunState | null {
  if (deleted.length === 0) return null;
  const left = new Set(run.left);
  const returned = deleted.filter((card) => left.has(card.id) && exists(card.id));
  if (returned.length === 0) return null;
  const ids = new Set(returned.map((card) => card.id));
  let plans = run.plans;
  if (replan) {
    const merged = new Map(run.plans);
    for (const [id, plan] of replan(returned)) merged.set(id, plan);
    plans = merged;
  }
  return {
    ...run,
    queue: [...run.queue.slice(0, run.idx), ...returned, ...run.queue.slice(run.idx)],
    left: run.left.filter((id) => !ids.has(id)),
    plans,
  };
}

/**
 * Take out the cards that no longer exist (their note was deleted in the
 * card editor, spec §6.5 "Edit card"). Cards already rated stay. The same
 * object comes back when nothing was dropped.
 */
export function dropMissing(run: RunState, exists: (id: Id) => boolean): { next: RunState; dropped: number } {
  const gone = new Set<Id>();
  const queue = run.queue.filter((q, i) => {
    if (i < run.idx || exists(q.id)) return true;
    gone.add(q.id);
    return false;
  });
  if (gone.size === 0) return { next: run, dropped: 0 };
  const left = [...run.left];
  for (const id of gone) if (!left.includes(id)) left.push(id);
  return { next: { ...run, queue, left }, dropped: gone.size };
}

/**
 * "Switch mode" (spec §6.5): new plans for the cards still to come (the
 * card on screen included), and the card on screen starts again in the new mode.
 */
export function switchModeRun(run: RunState, plans: ReadonlyMap<Id, CardPlan>): RunState {
  const merged = new Map(run.plans);
  for (const [id, plan] of plans) merged.set(id, plan);
  return { ...run, plans: merged, ui: freshUi(uiKey(currentCard(run), run.idx)) };
}

/**
 * After the card editor (More › "Edit card", spec §6.5): the text lives in
 * the notes and faces are read live, so the card shows the new text by
 * itself. But the mode plans were made from the old text (the text to type,
 * the quiz choices), so the cards still to come are planned again. When the
 * note of the card on screen changed, its answer state starts again too.
 * `before` = the notes and card types the plans were made from; the same
 * object comes back when they did not change.
 */
export function replanRun(
  run: RunState,
  state: ScopeState,
  before: Pick<ScopeState, 'notes' | 'noteTypes'>,
  mode: StudyMode,
  kind: RouteKind,
  dayKey: string,
): RunState {
  // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes in src/components.
  const { notes, noteTypes } = state;
  const { notes: notesBefore, noteTypes: typesBefore } = before;
  if (notes === notesBefore && noteTypes === typesBefore) return run;
  const plans = plansFor(remainingCards(run), mode, kind, dayKey, state);
  const merged = new Map(run.plans);
  for (const [id, plan] of plans) merged.set(id, plan);
  const card = currentCard(run);
  const changed =
    card !== undefined &&
    libraryIndexOf(before).noteById.get(card.noteId) !== libraryIndexOf(state).noteById.get(card.noteId);
  return { ...run, plans: merged, ui: changed ? freshUi(uiKey(card, run.idx)) : run.ui };
}

/** The cards still to come (the card on screen first). */
export function remainingCards(run: RunState): QueueCard[] {
  return run.queue.slice(run.idx);
}

/**
 * Does More › "Switch mode" show the Articles chip? Only in Practice
 * (Articles writes nothing, spec §6.3), and one of:
 *   - the session is IN Articles now: the chip of the current mode is always
 *     there, so the learner sees which mode is on;
 *   - the session STARTED in Articles ("Practice articles · 6") and a German
 *     noun is still to come: the learner can come back to it after trying
 *     another mode;
 *   - at least 4 German nouns are still to come (modes.ts canOfferArticles).
 * `mode` = the mode now, `startMode` = the mode the session started in.
 * Example: "Practice articles · 6" after 3 ratings has 3 nouns left. The
 * chip stays, although 3 is fewer than 4, also after a switch to Flashcards.
 */
export function articleChipShown(kind: RouteKind, mode: StudyMode, nounsLeft: number, startMode: StudyMode): boolean {
  if (kind !== 'practice') return false;
  return mode === 'article' || (startMode === 'article' && nounsLeft > 0) || canOfferArticles(nounsLeft);
}

/**
 * The in-flight marker (M5) after `total` rated cards: if the app is killed
 * now, the next boot banks exactly this, once and silently.
 *
 * `meta.mode` = the session's study mode now (after a "Switch mode", the
 * new one). It goes into the marker (wave 5h, device note E7-10), so the
 * record the boot reconcile writes has a mode, like the record of a
 * session that ended normally (completeSession `mode`).
 */
export function markerOf(
  run: Pick<RunState, 'counts' | 'bestRun' | 'fastAnswers'>,
  meta: { kind: RouteKind; label: string; durationSec: number; studyDay: string; mode: StudyMode },
  total: number,
): InProgressSession {
  return {
    kind: meta.kind,
    label: meta.label,
    counts: run.counts,
    total,
    bestRun: run.bestRun,
    durationSec: meta.durationSec,
    fastAnswers: run.fastAnswers,
    studyDay: meta.studyDay,
    mode: meta.mode,
  };
}

/**
 * The cards undo must not bring back: those that left the session, and
 * those the store no longer allows (missing, suspended, buried now).
 */
export function blockedIn(
  cardById: ReadonlyMap<Id, Pick<Card, 'suspended' | 'buriedUntil'>>,
  left: readonly Id[],
  now: number,
): (id: Id) => boolean {
  const gone = new Set(left);
  return (id) => {
    if (gone.has(id)) return true;
    const card = cardById.get(id);
    return !card || !!card.suspended || (card.buriedUntil != null && card.buriedUntil > now);
  };
}

/* ================================================================== 4. card */

/**
 * The card's name in a snackbar: its one-line question; "This card" when the
 * question shows nothing to name (a dictation card shows only 🔊, and its
 * hidden word must not be given away).
 */
export function cardName(face: Pick<CardFace, 'prompt' | 'promptPlain'>): string {
  const head = face.prompt[0];
  if (head && isSpeakerBlock(head)) return 'This card';
  return face.promptPlain.trim() || 'This card';
}

/**
 * The title of the session's "More" sheet (⋯). It must not give the answer
 * away before the reveal (final device pass): Articles asks with the bare
 * word, so the title is that word, never "die Stunde"; a dictation card is
 * "This card" (cardName).
 *
 *   moreSheetTitle(face('die Stunde'), { word: 'Stunde', … }) → 'Stunde'
 *   moreSheetTitle(dictationFace, null)                      → 'This card'
 *   moreSheetTitle(face('die Stunde'), null)                 → 'die Stunde'
 */
export function moreSheetTitle(
  face: Pick<CardFace, 'prompt' | 'promptPlain'>,
  article: Pick<ArticleQuestion, 'word'> | null,
): string {
  return article ? article.word : cardName(face);
}

/**
 * The learning-step pill ("1/2 · 1m → 10m") of the card on screen, or null.
 * Practice changes no step (H3), so it shows none: the pill would promise a
 * move that does not happen (final device pass).
 */
export function sessionStepLabel(kind: RouteKind, label: string | null): string | null {
  return routeWrites(kind) ? label : null;
}

/** What the card's mode did before the rating (for the suggestion). */
export function outcomeOf(plan: CardPlan, ui: CardUi): ModeOutcome {
  if (plan.mode === 'type' && ui.check) return { mode: 'type', verdict: ui.check.verdict };
  if (plan.mode === 'mc' && plan.quiz && ui.pick !== null) return { mode: 'mc', right: ui.pick === plan.quiz.answerIndex };
  return { mode: 'flash' };
}

/**
 * The rating button to outline (spec §6.3, §6.4), or null. Only after the
 * answer is shown. A used hint outlines Hard (unless the answer was wrong).
 */
export function suggestedRating(plan: CardPlan, ui: CardUi): Rating | null {
  if (!ui.revealed) return null;
  return suggestRating(outcomeOf(plan, ui), ui.hintStep > 0);
}

/** The Articles answer: right or wrong, or null before the pick. */
export function articleRight(plan: CardPlan, ui: CardUi): boolean | null {
  if (plan.mode !== 'article' || !plan.article || ui.article === null) return null;
  return ui.article === plan.article.article;
}

/**
 * The rating an Articles answer counts as (it has no rating buttons, and
 * Practice writes nothing): right → Good, wrong → Again (so a missed word
 * comes back 3 cards later, and "Practice the {n} you missed" offers it).
 */
export function articleRating(right: boolean): Rating {
  return right ? 'good' : 'again';
}

/**
 * Is the hint button shown? (spec §6.4) Not when Settings › Hints is off, not
 * in Quiz or Articles, not after the answer is shown.
 */
export function showHintButton(hintsEnabled: boolean, plan: CardPlan, ui: CardUi): boolean {
  return hintsEnabled && !ui.revealed && plan.mode !== 'mc' && plan.mode !== 'article';
}

/** The hint button's word after `step` taps: "Hint", "More hint", "Show answer". */
export function hintButtonLabel(step: number): string {
  if (step <= 0) return 'Hint';
  if (step === 1) return 'More hint';
  return 'Show answer';
}

/** What the hints of a card are made from: in Typing, the text to type. */
export function hintSourceFor(face: CardFace, plan: CardPlan): HintSource {
  return plan.typing ? hintSourceOf(face, plan.typing.text, plan.typing.lang) : hintSourceOf(face);
}

/** The hint after one more tap: the new step, the hint, and whether this tap reveals the card. */
export function nextHint(source: HintSource, step: number): { step: number; hint: Hint | null; reveal: boolean } {
  const hint = hintAt(source, step + 1);
  const reveal = hint?.kind === 'reveal';
  return { step: reveal ? step : step + 1, hint, reveal };
}

/** The hint shown on the card after `step` taps (null before the first tap). */
export function shownHint(source: HintSource, step: number): Hint | null {
  if (step <= 0) return null;
  const hint = hintAt(source, step);
  return hint && hint.kind !== 'reveal' ? hint : null;
}

/**
 * The quiet line when a card is shown as a flashcard although its mode asked
 * for something else (modes.ts Fallback). The long-answer text is the
 * spec's (§6.3).
 */
export const FALLBACK_COPY: Readonly<Record<Fallback, string>> = Object.freeze({
  long: 'Long answer — flip instead',
  noText: 'Nothing to type here — flip instead',
  fewChoices: 'Not enough choices for a quiz — flip instead',
  noArticle: 'No der, die or das here — flip instead',
});

/**
 * The size class of a headline (spec §6.2 and the device findings): a short
 * text gets the big serif; 40–120 characters (or a few lines) a smaller
 * serif; longer text (or many lines, a long Anki back) a normal-weight sans,
 * so it is never drawn at the big size and never bold.
 *
 *   'die Stunde'        → 'big'
 *   a 60-character text → 'medium'
 *   a 300-character back, or 4+ lines → 'long'
 */
export type HeadlineSize = 'big' | 'medium' | 'long';

export function headlineSize(block: Pick<FieldBlock, 'plain' | 'lines'> | undefined): HeadlineSize {
  if (!block) return 'big';
  const length = Array.from(block.plain ?? '').length;
  const lines = block.lines?.length ?? 0;
  if (length > 120 || lines >= 4) return 'long';
  if (length >= 40 || lines >= 2) return 'medium';
  return 'big';
}

/**
 * True when a block shows a picture (an `<img>` in its field). Such a block is
 * never wrapped into ONE screen-reader element: the picture must stay
 * reachable on its own ("Picture", wave-5b R9), so the screen reader can
 * stop on it and open it full screen.
 *
 *   blockHasImage({ lines: [[{ t: 'img', src: 'tree.png' }]] }) → true
 *   blockHasImage({ lines: [[{ t: 'text', text: 'die Stunde' }]] }) → false
 */
export function blockHasImage(block: Pick<FieldBlock, 'lines'> | undefined): boolean {
  return !!block && block.lines.some((line) => line.some((part) => part.t === 'img'));
}

/** The screen-reader label of a picture in a card. */
export const PICTURE_LABEL = 'Picture';

/**
 * The question line at the top of the ANSWER side (the question again, small,
 * StudyCard): the text of the question headline, else the face's one-line
 * question (`promptPlain`). '' when the question has no text to show — a
 * question that is only a picture (htmlLines gives '' for an image-only
 * field; two picture lines give '\n', which is no text either).
 *
 * WHY '' matters (review of C1-5): the card drew this line as an `accessible`
 * Text even when it was empty, so TalkBack got a silent stop, and the focus
 * after the reveal went to it. With '' the card draws no line, and the focus
 * goes to the first element of the answer headline instead.
 *
 *   answerQuestionLine(face of 'die Stunde')        → 'die Stunde'
 *   answerQuestionLine(face of a picture-only question) → ''
 */
export function answerQuestionLine(face: Pick<CardFace, 'prompt' | 'promptPlain'>): string {
  const head = blockText(face.prompt[0]);
  if (head.trim() !== '') return head;
  return face.promptPlain.trim() !== '' ? face.promptPlain : '';
}

/** The text of a block for a screen reader: a speaker block (dictation) says "Read aloud", never the hidden word. */
function spokenBlock(block: FieldBlock | undefined, fallback: string): string {
  if (!block) return fallback;
  if (isSpeakerBlock(block)) return 'Read aloud';
  return block.plain || fallback;
}

/**
 * The card's screen-reader label (spec §8.12):
 *   front  "Card. die Stunde. Double tap to reveal."  (the last part only when a tap reveals)
 *   back   "die Stunde. the hour. Example: Die Stunde ist um."
 * A part that already ends a sentence gets no second full stop (asSentence):
 * "Card. Was ist das? Double tap to reveal.".
 * `shownPrompt` = the question the screen draws INSTEAD of the face's
 * headline (Articles shows the bare word "Abfahrt"): the label says that
 * text, so it never reads out the article the learner must choose.
 */
export function cardA11yLabel(face: CardFace, revealed: boolean, tapReveals = true, shownPrompt?: string): string {
  const prompt = shownPrompt ?? spokenBlock(face.prompt[0], face.promptPlain);
  if (!revealed) {
    const head = cardIntro(prompt);
    return tapReveals ? `${head} Double tap to reveal.` : head;
  }
  const parts = [prompt, face.answer[0]?.plain || face.answerPlain];
  for (const block of face.answer.slice(1)) {
    if (block.role === 'hidden' || block.plain.trim() === '') continue;
    parts.push(block.label ? `${block.label}: ${block.plain}` : block.plain);
  }
  // One sentence per part; a part that already ends a sentence ("um.", "pattern?") gets no second full stop.
  return parts
    .map(asSentence)
    .filter((p) => p !== '')
    .join(' ');
}

/**
 * A part of a screen-reader label as one sentence: it gets a full stop,
 * unless it already ends with . ? ! : or … . WHY (final device pass K1-3):
 * a screen reader read "Card. What does a hash table store?. Double
 * tap to reveal." — a full stop after a question mark. Empty text stays
 * empty (the caller leaves it out).
 *
 *   asSentence(' die Stunde ') → 'die Stunde.'
 *   asSentence('What is it?')  → 'What is it?'
 *   asSentence('Beispiel:')    → 'Beispiel:'
 */
export function asSentence(text: string): string {
  const t = text.trim();
  return t === '' || /[.!?:…]$/.test(t) ? t : `${t}.`;
}

/** "Card. {text}" — the start of a card's label; just "Card." when the text is empty. */
function cardIntro(text: string): string {
  const sentence = asSentence(text);
  return sentence === '' ? 'Card.' : `Card. ${sentence}`;
}

/**
 * The screen-reader label of the FIRST line of text of a question headline
 * that shows a picture (Typing and Quiz, wave-5b R9): "Card. {that line}.".
 * Only that line's OWN text: the picture and every later line of text stay
 * their own elements, and each reads itself. WHY (review round 2): the label
 * said the text of the WHOLE headline, so a later line was read twice:
 * "Card. Was ist das? (ein Tier).", "Picture", then "(ein Tier)" again.
 *
 *   headlineLineLabel('die Stunde')   → 'Card. die Stunde.'  (the same form as cardA11yLabel's front)
 *   headlineLineLabel('Was ist das?') → 'Card. Was ist das?'  (no full stop after "?", K1-3)
 */
export function headlineLineLabel(lineText: string): string {
  return cardIntro(lineText);
}

const UNIT_WORDS: Readonly<Record<string, [string, string]>> = {
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
  mo: ['month', 'months'],
  y: ['year', 'years'],
};

/**
 * A compact interval in words, for a screen reader: '3d' → '3 days',
 * '10m' → '10 minutes', '1mo' → '1 month'. Anything else stays as it is.
 */
export function intervalWords(interval: string): string {
  const m = /^(\d+(?:\.\d+)?)(mo|m|h|d|y)$/.exec(interval.trim());
  if (!m) return interval;
  const n = Number(m[1]);
  const [one, many] = UNIT_WORDS[m[2]];
  return `${m[1]} ${n === 1 ? one : many}`;
}

/**
 * The interval line of Good and Easy on a Check (a Known card, spec §1.2):
 * a passed Check keeps the card Known and schedules NOTHING, so there is no
 * "next in …" to show. Short, so it fits under the button.
 */
export const KNOWN_INTERVAL = 'Known';

/**
 * What each rating button shows under its name (the next interval), or null
 * in Practice (it changes no schedule).
 *
 * Most cards: srs.ts predictAll. But a Known card is rated as a CHECK
 * (reducer.ts rateByBucket), and predictAll does not know that:
 *   - Good / Easy: the Check is passed. The card stays Known and its schedule
 *     is not changed → KNOWN_INTERVAL ("Known"), never "2mo";
 *   - Again / Hard: the Check is missed. The card is not Known any more and
 *     starts Learning at step 0 → the intervals of THAT card ("10m"), not the
 *     days of its old review interval.
 *
 *   a Known card with a 60-day interval → { again: 'soon', hard: '1m', good: 'Known', easy: 'Known' }
 */
export function ratingPredictions(card: Card, srs: SrsSettings, writes: boolean): Predictions | null {
  if (!writes) return null;
  if (card.knownAt == null) return predictAll(card, srs);
  // The same start card as reducer.ts rateByBucket gives a missed Check.
  const missed: Card = {
    ...card,
    knownAt: null,
    knownCheckedAt: null,
    stepIndex: 0,
    lapses: card.reps > 0 ? card.lapses + 1 : card.lapses,
  };
  const p = predictAll(missed, srs);
  return { again: p.again, hard: p.hard, good: KNOWN_INTERVAL, easy: KNOWN_INTERVAL };
}

/**
 * A rating button's screen-reader label (spec §8.12):
 *   ('good', '3d')             → 'Good. Next in 3 days.'
 *   ('again', 'soon')          → 'Again. Comes back soon in this session.'
 *   ('good', null)             → 'Good. Doesn’t change your schedule.'   (Practice)
 *   ('good', 'Known')          → 'Good. Stays Known.'                     (a passed Check)
 *   suggested                  → 'Good, suggested. Next in 3 days.'
 */
export function ratingA11yLabel(rating: Rating, interval: string | null, suggested: boolean): string {
  const name = `${RATING_LABELS[rating]}${suggested ? ', suggested' : ''}`;
  if (interval === null) return `${name}. Doesn’t change your schedule.`;
  if (rating === 'again') return `${name}. Comes back soon in this session.`;
  if (interval === KNOWN_INTERVAL) return `${name}. Stays Known.`;
  return `${name}. Next in ${intervalWords(interval)}.`;
}

/**
 * The snackbar after a rating (it has Undo):
 *   Again            → "die Stunde is coming back soon in this session"
 *   Study            → "Rated Good · next in 3d"
 *   a passed Check   → "Rated Good · stays Known"
 *   Practice         → "Rated Good · your schedule is unchanged"
 */
export function rateSnack(rating: Rating, interval: string | null, name: string): string {
  if (rating === 'again') return `${name || 'This card'} is coming back soon in this session`;
  if (interval === null) return `Rated ${RATING_LABELS[rating]} · your schedule is unchanged`;
  if (interval === KNOWN_INTERVAL) return `Rated ${RATING_LABELS[rating]} · stays Known`;
  return `Rated ${RATING_LABELS[rating]} · next in ${interval}`;
}

/**
 * The line under a typed answer after "Check" (the article case is drawn
 * with the little word in bold after it):
 *   "Almost — remember the article: **die** Abfahrt"   (German, English the / a / an)
 *   "Almost — remember the “to”: **to** sleep"          (English "to", answerCheck rule 6b)
 */
export function verdictText(result: AnswerResult): string {
  if (result.verdict === 'exact') return 'Correct';
  if (result.verdict === 'wrong') return 'Not quite';
  switch (result.reason) {
    case 'accents':
      return 'Almost — check the accents';
    case 'article':
      return result.article ? leadHintCopy(result.article.article) : ARTICLE_HINT_COPY;
    default:
      return 'Almost — a small typo';
  }
}

/* ================================================================== 5. end */

/**
 * The SessionParams of "Practice your hardest" in a scope, exactly as spec
 * §6.6 defines it: the PRACTICE pool of the scope (selectPractice: no Known,
 * Not started, suspended or buried cards unless the scope asks for them),
 * sorted by ease ascending, then lapses descending, cut by the session size.
 * The deck page's "Practice your hardest · {n}" (ModeSheet ways) is the same
 * session, so the two numbers always agree.
 */
export function hardestParams(scope: Query): { kind: 'practice'; q: Query; sort: SortSpec } {
  return { kind: 'practice', q: sanitizeQuery(scope), sort: HARDEST_SORT };
}

/**
 * The scopes of Complete's "Practice your hardest" and "Choose what to learn"
 * after a session over `scope`.
 *
 * After a session over ALL decks (a scope that names no deck, list or
 * filter — namedScope is empty: Today's hero and Today's "Study ahead" pass
 * `{}`, Today's "Practice" `{ notFlags: ['paused'] }`), they are TODAY's own
 * scopes, because a paused deck's cards leave Today (spec §1.2) and must
 * not come back through Complete:
 *   - practice: PRACTICE_SCOPE `{ notFlags: ['paused'] }`, like Today's "Practice · {n}";
 *   - choose:   NOT_STARTED_SCOPE (no paused deck, no suspended card), like
 *               Today's "Choose what to learn".
 * WHY: the 'browse' pool (practice, triage) keeps a paused deck's cards, so
 * over `{}` "Practice your hardest" put a paused deck's cards FIRST and
 * "Choose what to learn · 300 not started" opened triage on a paused deck,
 * while Today offered neither. ("Study ahead" needs nothing: the 'study'
 * pool leaves a paused deck out by itself.)
 *
 * Any other scope stays as it is: the learner chose that deck, list or
 * filter (a paused deck's own page still offers its cards).
 *
 *   keepGoingScopes({})                → { practice: { notFlags: ['paused'] }, choose: NOT_STARTED_SCOPE }
 *   keepGoingScopes({ decks: ['d1'] }) → { practice: { decks: ['d1'] }, choose: { decks: ['d1'] } }
 */
export function keepGoingScopes(scope: Query): { practice: Query; choose: Query } {
  if (Object.keys(namedScope(scope)).length > 0) return { practice: scope, choose: scope };
  return { practice: PRACTICE_SCOPE, choose: NOT_STARTED_SCOPE };
}

/** The label of Complete's "Practice your hardest · {n}" session. It names the practice, not the scope. */
export const HARDEST_LABEL = 'Your hardest cards';

/** The label of "Practice the {n} you missed" (a selection). It names the practice, not the scope. */
export const MISSED_LABEL = 'Missed cards';

/**
 * The Practice labels that name the PRACTICE itself, not its scope:
 *   - HARDEST_LABEL and MISSED_LABEL (Complete);
 *   - 'Practice': Today's "Practice · {n}" button (TodayHero) uses it as the label.
 * Every other Practice label names the scope: the Library's chip label
 * ("German · Level: B1", libraryState practiceQueryRoute) and the deck
 * page's deck name ("Practice all", "Practice your hardest", "Practice
 * articles" all pass the deck's name).
 */
const PRACTICE_ONLY_LABELS: ReadonlySet<string> = new Set([HARDEST_LABEL, MISSED_LABEL, 'Practice']);

/**
 * The label of a session that starts from another one over the SAME scope
 * ("Study ahead · {n}" on Complete or on the empty queue). The old label is
 * carried only when it names the scope:
 *   - a Study or Study ahead label ("German", "B1 verbs");
 *   - a Practice label that names its scope ("German · Level: B1" from the
 *     Library, the deck's name from the deck page).
 * Otherwise undefined, and the new session names itself from its scope
 * (sessionLabel: the deck, the list, "All decks", "Filtered cards"):
 *   - a Practice label that names the PRACTICE (PRACTICE_ONLY_LABELS: "Your
 *     hardest cards", "Missed cards"). A Study ahead of deck D is not "Your
 *     hardest cards" (W5-5a: that label went into the history CSV and the
 *     Complete overline);
 *   - a selection's label ("12 selected cards") never names a scope;
 *   - over all decks the new session says "All decks" itself;
 *   - any other kind (an old v2 record kind such as 'cram').
 *
 *   followUpLabel({ kind: 'scheduled', label: 'German', scope: { decks: ['d1'] } }) → 'German'
 *   followUpLabel({ kind: 'practice', label: 'German · Level: B1', scope: { decks: ['d1'], fields: … } }) → 'German · Level: B1'
 *   followUpLabel({ kind: 'practice', label: 'Your hardest cards', scope: { decks: ['d1'] } }) → undefined
 */
export function followUpLabel(prev: { kind: string; label: string | null | undefined; scope: Query; selection?: boolean }): string | undefined {
  if (prev.selection || isEmptyQuery(prev.scope) || !prev.label) return undefined;
  if (prev.kind === 'scheduled' || prev.kind === 'ahead') return prev.label;
  if (prev.kind === 'practice' && !PRACTICE_ONLY_LABELS.has(prev.label)) return prev.label;
  return undefined;
}

/**
 * The level line of the Complete screen: "Level 6 · Keeper", "  — level up!"
 * after a level-up. The name comes from `names` = the level names of this
 * build (`levelNames(activePack.levelNames)`, spec §8.8, §9.4), the same as
 * on Progress. The payout's own `levelAfter.name` is the generic one: the
 * store never reads the content pack.
 *
 *   completeLevelLine(6, levelNames(['…', 'Linguist']), false) → 'Level 6 · Linguist'
 */
export function completeLevelLine(level: number, names: readonly string[], levelUp: boolean): string {
  return `Level ${level} · ${levelName(level, names)}${levelUp ? '  — level up!' : ''}`;
}

/** The numbers of the Complete screen's "Keep going" rows. */
export interface KeepGoingCounts {
  /** "Practice the {n} you missed": the practice session of the missed cards. */
  retry: number;
  /** "Study ahead · {n}". */
  ahead: number;
  /** "Practice your hardest · {n}". */
  hardest: number;
  /**
   * "Choose what to learn · {n} not started": the ITEMS (notes) the triage
   * screen shows, the same number as its counter ("0 / 6 items").
   */
  notStarted: number;
}

/**
 * The "Keep going" numbers for a scope (each one = the length of the session
 * its row opens, or for "Choose what to learn" the Not started ITEMS triage
 * shows). `missed` = the ids of the missed cards (the selection).
 *
 * "Choose what to learn" counts what triage counts (walkthrough M6): the
 * items of the scope's Not started cards, without a direction that is off
 * in its deck (triageLogic.ts `triageItems`, over the same scope pool as
 * triage.tsx). It counted CARDS, so "Choose what to learn · 12" opened
 * "0 / 6 items" for a deck with two directions.
 *
 * "Practice your hardest" and "Choose what to learn" use keepGoingScopes:
 * over all decks they leave a paused deck out, like Today (the Complete
 * screen opens the SAME scopes, so each number is still the length of
 * what its row opens).
 */
export function keepGoingCounts(state: ScopeState, scope: Query, missed: readonly Id[], ctx: MatchCtx): KeepGoingCounts {
  const scopes = keepGoingScopes(scope);
  const items = triageItems(scopePool(state, scopes.choose, ctx, 'browse'), triageLookupOf(state, ctx));
  return {
    retry: missed.length > 0 ? buildSessionQueue({ kind: 'practice', sel: missed }, state, ctx).length : 0,
    ahead: buildSessionQueue({ kind: 'ahead', q: scope }, state, ctx).length,
    hardest: buildSessionQueue(hardestParams(scopes.practice), state, ctx).length,
    notStarted: items.length,
  };
}

/** One "Keep going" row of the Complete screen. */
export interface KeepGoingRow {
  key: 'retry' | 'ahead' | 'hardest' | 'choose';
  title: string;
  sub: string;
  count: number;
}

/** The highlighted "Retry missed" box (Settings › Retry missed on, spec §6.7). */
export interface RetryBox {
  text: string;
  cta: string;
  count: number;
}

/**
 * "Doesn’t change your schedule." (spec §6.10, exact copy). The curly
 * apostrophe (’) like every other line of this file and the Complete
 * screen (wave 5i): the "Practice your hardest" row said "Doesn't" (straight)
 * right under the Complete screen's own "Doesn’t" (curly).
 */
export const NO_SCHEDULE_CHANGE = 'Doesn’t change your schedule.';

/**
 * The Complete screen's "Keep going" (spec §6.7, §6.10). Each row is hidden
 * when its count is 0. Missed cards (count > 0):
 *   Settings › Retry missed ON  → the box first ("You missed 3 cards. Practice
 *                                 them now?" · "Practice 3" · "Not now");
 *                                 after "Not now", nothing (the learner said no);
 *   OFF                         → the ordinary row "Practice the 3 you missed".
 * `missedCount` = how many cards were missed (unique), for the box text.
 */
export function keepGoingRows(
  counts: KeepGoingCounts,
  opts: { retryMissed: boolean; retryDismissed: boolean; missedCount: number },
): { retryBox: RetryBox | null; rows: KeepGoingRow[] } {
  const rows: KeepGoingRow[] = [];
  let retryBox: RetryBox | null = null;
  if (counts.retry > 0) {
    if (opts.retryMissed) {
      if (!opts.retryDismissed) {
        const n = Math.max(opts.missedCount, counts.retry);
        retryBox = {
          text: `You missed ${plural(n, 'card')}. Practice ${n === 1 ? 'it' : 'them'} now?`,
          cta: `Practice ${counts.retry.toLocaleString('en-US')}`,
          count: counts.retry,
        };
      }
    } else {
      rows.push({
        key: 'retry',
        title: `Practice the ${counts.retry.toLocaleString('en-US')} you missed`,
        sub: NO_SCHEDULE_CHANGE,
        count: counts.retry,
      });
    }
  }
  if (counts.ahead > 0) {
    rows.push({ key: 'ahead', title: wayTitle('Study ahead', counts.ahead), sub: 'Reviews that are not due yet. Changes your schedule.', count: counts.ahead });
  }
  if (counts.hardest > 0) {
    rows.push({ key: 'hardest', title: wayTitle('Practice your hardest', counts.hardest), sub: NO_SCHEDULE_CHANGE, count: counts.hardest });
  }
  if (counts.notStarted > 0) {
    // {n} counts ITEMS, like triage's "0 / 6 items" (keepGoingCounts). The copy is the
    // spec's (§6.10): the number alone, with no unit word ("· 3 not started").
    rows.push({
      key: 'choose',
      title: `${wayTitle('Choose what to learn', counts.notStarted)} not started`,
      sub: 'Sort them into Learn, I know it or Later.',
      count: counts.notStarted,
    });
  }
  return { retryBox, rows };
}

/**
 * The Complete screen's line about the missed cards, under the rating bar
 * (Study and Study ahead only; Practice changes no schedule, so nothing
 * "comes back"):
 *
 *   missedLine(1, 1, true)  → '1 card missed — it’ll come back soon.'
 *   missedLine(3, 2, true)  → '2 cards missed — they’ll come back soon.'  (one card was missed twice)
 *   missedLine(2, 0, false) → null                                       (Practice)
 *
 * `again` = the "Again" ratings of the session (payout.counts.again);
 * `missedCards` = the cards rated "Again", each once (the session's missed
 * list, the same number as the Retry-missed box "You missed {n} cards").
 * The line counts CARDS, so a card missed twice is one card; when the list
 * is not there (0), it falls back to the Again count.
 *
 * WHY not "lapse" (walkthrough E11-4): it said "1 lapse" for a NEW card
 * rated Again. In this app (and in Anki) a lapse is a REVIEW card that was
 * forgotten: the scheduler adds a lapse only when the card had repetitions
 * (`lapses + 1` when `reps > 0`). "Missed" fits every Again: new, learning,
 * review and a missed Check.
 */
export function missedLine(again: number, missedCards: number, wrote: boolean): string | null {
  if (again <= 0 || !wrote) return null;
  const n = missedCards > 0 ? Math.min(missedCards, again) : again;
  return `${plural(n, 'card')} missed — ${n === 1 ? 'it' : 'they'}’ll come back soon.`;
}

/**
 * The copy of the empty queue: spec §6.10, plus `newDone` from the device
 * findings of the wave-3 emulator run (a deck with only New cards, after
 * today's new-card limit was used up).
 */
export const EMPTY_QUEUE_COPY = {
  title: 'Nothing to study here.',
  caughtUp: 'You’re all caught up.',
  newDone: 'Today’s new cards are done. Come back tomorrow, or practice.',
  expired: 'This selection is no longer available.',
  leave: 'Back',
} as const;

/**
 * The line under the empty queue's title.
 *
 *   "Today's new cards are done. Come back tomorrow, or practice."
 *     ONLY for an empty Study session (`kind` 'scheduled') whose scope still
 *     has New cards. Why that means "held back by today's limits": the study
 *     pool (scopePool 'study') already leaves out suspended and buried cards,
 *     paused decks and directions that are off. So a New card in it that the
 *     scheduler did not take was held back by the daily new-card limits.
 *   "You're all caught up."
 *     every other case. The daily new-card limit does not cut Study ahead
 *     (reviews only) or Practice, so the line would be false there (an empty
 *     Study ahead while 3 New cards are still allowed today).
 */
export function emptyQueueLine(kind: RouteKind, studyPool: readonly Card[]): string {
  if (kind !== 'scheduled') return EMPTY_QUEUE_COPY.caughtUp;
  return studyPool.some((card) => life(card) === 'new') ? EMPTY_QUEUE_COPY.newDone : EMPTY_QUEUE_COPY.caughtUp;
}

/** The empty queue's buttons, each only when its count is above 0. */
export function emptyQueueActions(counts: { ahead: number; practice: number }): {
  key: 'ahead' | 'practice';
  title: string;
  count: number;
}[] {
  const out: { key: 'ahead' | 'practice'; title: string; count: number }[] = [];
  if (counts.ahead > 0) out.push({ key: 'ahead', title: wayTitle('Study ahead', counts.ahead), count: counts.ahead });
  if (counts.practice > 0) out.push({ key: 'practice', title: wayTitle('Practice', counts.practice), count: counts.practice });
  return out;
}

/**
 * The exit sheet's text ("End this session?"). `practice` = the session
 * changes no schedule (a Practice session: routeWrites is false).
 *
 *   exitSavedLine(3)       → 'The 3 cards you reviewed will be saved.'
 *   exitSavedLine(3, true) → 'Your practice is kept (3 cards). Your schedule does not change.'
 *
 * Practice has its own words (wave 5h, device pass E7). "The 3 cards you
 * reviewed will be saved" made it sound as if the practice changed the
 * schedule of those cards. It never does (H3). What is kept is the session
 * itself: its record, its XP and the streak day (spec §6.6, D5).
 */
export function exitSavedLine(reviewed: number, practice: boolean = false): string {
  if (practice) return `Your practice is kept (${plural(reviewed, 'card')}). Your schedule does not change.`;
  return `The ${plural(reviewed, 'card')} you reviewed will be saved.`;
}

/**
 * The snackbar on the screen you land on after ending a session early
 * (✕ → "End session", wave-5b walkthrough M10). The early exit banks the
 * session (by design) but showed no summary; this line is that summary.
 * `reviewed` and `xp` come from the payout (completeSession).
 *
 *   earlyExitSnack(3, 12) → 'Session saved · 3 cards · +12 XP'
 *   earlyExitSnack(1, 4)  → 'Session saved · 1 card · +4 XP'
 */
export function earlyExitSnack(reviewed: number, xp: number): string {
  return `Session saved · ${plural(reviewed, 'card')} · +${xp.toLocaleString('en-US')} XP`;
}

/**
 * A GLOBAL message the session saw on screen (session.tsx reads it from
 * useSnackbar): whether it has an action (an Undo), and when it appeared, in
 * ms on the session's steady clock.
 */
export interface SeenSnack {
  withAction: boolean;
  at: number;
}

/** The short pause between the end of a global Undo message and "Session saved" (ms), so the two never look like one. */
export const SAVED_AFTER_UNDO_GAP_MS = 300;

/**
 * How long "Session saved · …" (earlyExitSnack) must wait before it is shown,
 * in ms (wave 5d, F1a). The global snackbar shows ONE message, and a new one
 * replaces the old one. The story: More › "Edit card" › Delete, the editor
 * shows "“Wort” deleted · Undo" on the GLOBAL snackbar, and the learner ends
 * the session early within that Undo's time. "Session saved" REPLACED the
 * editor's message, so its Undo was lost. Now it waits until that message's
 * time (`actionMs`, the global snackbar's rule for a message with an action)
 * is over, plus a short pause. 0 = show it now: no message on screen, a
 * message without an action (only words, it may be replaced), or one whose
 * time is over.
 *
 *   earlyExitSnackDelay(null, 1000, 6000)                         → 0
 *   earlyExitSnackDelay({ withAction: false, at: 0 }, 1000, 6000) → 0
 *   earlyExitSnackDelay({ withAction: true, at: 0 }, 1000, 6000)  → 5300   (5,000 left + 300)
 *   earlyExitSnackDelay({ withAction: true, at: 0 }, 9000, 6000)  → 0      (it is gone)
 */
export function earlyExitSnackDelay(seen: SeenSnack | null, now: number, actionMs: number): number {
  if (!seen || !seen.withAction) return 0;
  const left = seen.at + actionMs - now;
  return left > 0 ? Math.ceil(left) + SAVED_AFTER_UNDO_GAP_MS : 0;
}

/*
 * The keyboard's Back rules (KEYBOARD_BACK_GRACE_MS, SELF_DISMISS_MS,
 * withinMs) live in ONE place for the whole app: src/platform/keyboardBack.ts
 * (final device pass K1-1: every screen got the session's rule). They are
 * exported here too, so the session's API and its tests stay the same:
 *   - KEYBOARD_BACK_GRACE_MS (500 ms): how long after the keyboard went away
 *     by itself a Back press still counts as "the press that closed it";
 *   - SELF_DISMISS_MS (1000 ms): how long after the app closed the keyboard
 *     ITSELF its hide is still that close (never a Back press);
 *   - withinMs(ms, window): 0 ≤ ms < window (a negative time, a clock that
 *     went back, is never "just now").
 */
export { KEYBOARD_BACK_GRACE_MS, SELF_DISMISS_MS, withinMs } from '../../platform/keyboardBack';

/**
 * Does a keyboardDidHide start the Back grace window (KEYBOARD_BACK_GRACE_MS)?
 * Only a hide of the SESSION's keyboard that the session did not ask for:
 *   - `focused` false: the keyboard of the card editor on top of the
 *     session (review round 1), never the session's;
 *   - `msSinceSelfDismiss` inside SELF_DISMISS_MS: the session closed the
 *     keyboard itself ("Check" in Typing, or Back's 'keyboard' case). Such a
 *     hide is not a Back press, so the next Back press must work at once
 *     (review round 2: a Back press just after "Check" was ignored). This
 *     part is the app-wide rule (keyboardBack.ts hideOpensGrace).
 * `msSinceSelfDismiss` = Infinity when the session never closed it.
 *
 *   keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: Infinity }) → true
 *   keyboardHideOpensGrace({ focused: true, msSinceSelfDismiss: 300 }) → false  (after "Check")
 *   keyboardHideOpensGrace({ focused: false, msSinceSelfDismiss: Infinity }) → false  (the editor's keyboard)
 */
export function keyboardHideOpensGrace(s: { focused: boolean; msSinceSelfDismiss: number }): boolean {
  return s.focused && hideOpensGrace(s.msSinceSelfDismiss);
}

/**
 * What Android's hardware Back does in a session (wave-5b walkthrough H1):
 *   'pass'      NOT the session's Back: the navigator handles it as usual.
 *               Two cases: the session is not the focused screen (the card
 *               editor of More › "Edit card" is on top of it), or the session
 *               is already banked (`committed`: it is on its way out);
 *   'keyboard'  the keyboard is open (or closed itself on this press, see
 *               KEYBOARD_BACK_GRACE_MS; `msSinceKeyboardHid` must be 0 or
 *               more, see withinMs): only close the keyboard; the typed
 *               answer and the session stay. The app-wide rule
 *               (keyboardBack.ts keyboardBackAction: 'closeKeyboard' or
 *               'swallow');
 *   'allDone'   the "All done here" state: the same as its main button
 *               ("Finish session" → Complete, or "Back" when nothing was rated);
 *   'confirm'   at least one card was rated: open the same "End this
 *               session?" sheet as ✕ (never leave without asking);
 *   'leave'     nothing was rated: leave at once (nothing to lose).
 * A sheet that is open (More, the exit sheet …) handles Back itself
 * (its Modal), so this is never asked then.
 *
 * WHY 'pass' (review round 1): Android asks the NEWEST Back listener first,
 * and the session's listener is newer than the navigator's own. The session
 * stays mounted under the card editor, so without 'pass' a Back press IN THE
 * EDITOR opened "End this session?" over the editor, and the editor never
 * closed (its unsaved-changes guard never ran either).
 *
 *   backPressAction({ focused: true, committed: false, keyboardVisible: true, msSinceKeyboardHid: Infinity, rated: 3, allDone: false }) → 'keyboard'
 *   backPressAction({ focused: true, committed: false, keyboardVisible: false, msSinceKeyboardHid: 5000, rated: 3, allDone: false }) → 'confirm'
 *   backPressAction({ focused: false, committed: false, keyboardVisible: false, msSinceKeyboardHid: 5000, rated: 3, allDone: false }) → 'pass'
 */
export function backPressAction(s: {
  focused: boolean;
  committed: boolean;
  keyboardVisible: boolean;
  msSinceKeyboardHid: number;
  rated: number;
  allDone: boolean;
}): 'pass' | 'keyboard' | 'allDone' | 'confirm' | 'leave' {
  if (!s.focused || s.committed) return 'pass';
  if (keyboardBackAction(s) !== 'pass') return 'keyboard';
  if (s.allDone) return 'allDone';
  return s.rated > 0 ? 'confirm' : 'leave';
}
