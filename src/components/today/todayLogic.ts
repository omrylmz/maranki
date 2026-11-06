/**
 * The rules of the Today tab (spec §8.1, §8.10 AddSheet, §8.11 empty states,
 * unit W4-1) as PURE functions, so they are tested without a phone. The
 * screen files (src/app/(tabs)/index.tsx and src/components/today/*) only
 * hold React state and layout.
 *
 *   THURSDAY 23 OCTOBER                          (🔥 12)  (+)
 *   Good evening
 *   30 cards ready · about 12 min            ← heroLine(ready); "34 ready · Study 30" when capped
 *   ┌──────────────── UP FIRST ────────────────┐
 *   │               die Abfahrt                 │   ← upFirstReader: the first card of the queue
 *   │    12 due · 8 learning · 10 new · 2 checks│   ← breakdownLine(ready)
 *   └───────────────────────────────────────────┘
 *   [ ▶  Study 30 ]                               ← the ONLY "study everything" control
 *   Reviews ▓▓▓░ 12 / 30 goal   New ▓░ 4 / 10 goal  ← goalBars (a goal of 0 hides its bar)
 *   YOUR DECKS                                    ← deckRowModel (one per deck)
 *   LISTS                                         ← todayListsReader (shown + "Show all lists")
 *
 * THE NUMBERS. Every "Study {n}" number is readyFor(scope).total (scope.ts),
 * and the button opens the session of the SAME scope, so the number is the
 * length of the session (spec §4.6). A deck row's pill is that deck's OWN
 * session. The daily limits (new cards, reviews) are shared by all decks,
 * and the session size cuts the top button, so the deck pills can add up to
 * more than the "Study {n}" at the top. That is why a deck row says
 * "{d} due · {n} new" (what is in THAT deck's session) and a short note says
 * the pills are separate sessions and names the real cause (sharedLimitNote):
 * the numbers are never shown as parts of the total (device finding 2026-10-24).
 *
 * Plain functions: no React, no clock (the caller passes `now`). Counts go
 * through scope.ts (scopePool, readyFor, buildSessionQueue), the one place
 * that turns a scope into cards.
 */
import { sortDecks } from '../../domain/fieldText';
import { BUILTIN_LISTS, isBuiltinListId } from '../../domain/lists';
import type {
  Card,
  DataStateV3,
  DayDone,
  Deck,
  Id,
  ListDef,
  ListPref,
  Query,
  ReadyCounts,
  SessionRecord,
} from '../../domain/model';
import { serializeQuery } from '../../domain/query';
import {
  buildSessionQueue,
  type DeckSummary,
  dueAndReadyFor,
  libraryIndexOf,
  matchCtxOf,
  scopePool,
} from '../../domain/scope';
import type { StarterDeckOutcome } from '../../domain/starterDecks';
import { plural } from '../../domain/text';
import { addDays, dayKeyOf } from '../../domain/types';
import { DEFAULT_REMINDER_TIME, parseReminderTime } from '../../platform/reminderPlan';
import { memoOnInputs } from '../../store/selectors';
import type { ContentPack } from '../../variants/types';
import { triageLookupOf } from '../deck/deckPageLogic';
import { triageItems } from '../deck/triageLogic';

/** A number with thousands separators, like the rest of the app: 1240 → '1,240'. */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/* ------------------------------------------------------------------ scopes and routes */

/**
 * The scope of the Today hero, the tab badge and "Study ahead" there:
 * everything. (Study reads the 'study' pool, which leaves the cards of a
 * paused deck out by itself, scope.ts.)
 */
export const ALL_SCOPE: Query = Object.freeze({});

/**
 * The scope of "Choose what to learn" on Today: every Not started card that
 * Today could bring in (not in a paused deck, not suspended). The count on the
 * button (notStartedItemCount) and the triage screen use the same query and
 * the same items rule, so they agree.
 */
export const NOT_STARTED_SCOPE: Query = { life: ['notStarted'], notFlags: ['paused', 'suspended'] };

/**
 * What the "Choose what to learn" count needs (a DataStateV3 fits). The
 * 'browse' pool reads only the cards, the library, decks and lists (the
 * memo inputs below); `person` and `settings` are there for scope.ts's type.
 */
type NotStartedState = Pick<DataStateV3, 'cards' | 'notes' | 'noteTypes' | 'decks' | 'lists' | 'person' | 'settings'>;

/**
 * "Choose what to learn · {n} not started" on Today: the ITEMS (notes) the
 * triage screen shows for NOT_STARTED_SCOPE — the same rule as the triage
 * screen itself (triage.tsx), the Complete screen (sessionLogic.ts
 * keepGoingCounts) and the deck page (choosableCounts): triageItems over the
 * scope's 'browse' pool. So
 *   - a note with two Not started directions is ONE item ("· 6", not "· 12");
 *   - a Not started card of a direction that is turned off in its deck is not
 *     counted: triage leaves it out, so a count of it opened "Nothing left to
 *     choose here." (a dead end, final review 2026-11).
 *
 *   notStartedItemCount(state, now) === triageItems(scopePool(state, NOT_STARTED_SCOPE, ctx, 'browse'), lookup).length
 */
export function notStartedItemCount(state: NotStartedState, now: number): number {
  const ctx = matchCtxOf(state, now);
  return triageItems(scopePool(state, NOT_STARTED_SCOPE, ctx, 'browse'), triageLookupOf(state, ctx)).length;
}

/** The selector behind Today's not-started count (memoized on what it reads). */
export function notStartedItemsReader(now: number): (state: NotStartedState) => number {
  return memoOnInputs(
    (s: NotStartedState) => [s.cards, libraryIndexOf(s), s.decks, s.lists],
    (state) => notStartedItemCount(state, now),
  );
}

/**
 * The scope of "Practice · {n}" on Today: every card, except the cards of a
 * paused deck (a paused deck's cards leave Today, spec §1.2). Practice reads
 * the 'browse' pool, which would keep them, so the query says it.
 */
export const PRACTICE_SCOPE: Query = { notFlags: ['paused'] };

/** The scope of one deck (its row pill). */
export function deckScope(deckId: Id): Query {
  return { decks: [deckId] };
}

/** The scope of one list (its row pill and its Library view). */
export function listScope(listId: string): Query {
  return { list: listId };
}

/** The session label of the hero button ("All decks"). */
export const ALL_DECKS_LABEL = 'All decks';

/** A session route (spec §2.2 `/session?kind=&q=&label=`). The screen casts it to `Href`. */
export function sessionRoute(kind: 'scheduled' | 'ahead' | 'practice', q: Query, label: string) {
  return { pathname: '/session', params: { kind, q: serializeQuery(q), label } } as const;
}

/** The deck page of a deck (spec §2.2 `/deck/[id]`). */
export function deckRoute(deckId: Id): string {
  return `/deck/${encodeURIComponent(deckId)}`;
}

/**
 * Library with filters (spec §4.6): the query as the `q` param and a new
 * `nonce`, so Library knows a new request arrived even with the same query.
 * `extra` adds more params (the AddSheet "New list" banner).
 */
export function libraryRoute(q: Query, nonce: string, extra: Record<string, string> = {}): LibraryRoute {
  return { pathname: '/(tabs)/library', params: { ...extra, q: serializeQuery(q), nonce } };
}

/** A Library route: the query, the nonce and any extra params (all text, as route params are). */
export interface LibraryRoute {
  pathname: '/(tabs)/library';
  params: { q: string; nonce: string; [param: string]: string };
}

/**
 * The extra Library param of "New list" (AddSheet row and Today "+ New list"):
 * Library shows the banner "Add filters, then tap Save as list." (spec §8.10).
 *
 * CROSS-UNIT CONTRACT with Library (unit W4-2; W4-1 review round 1). The spec
 * pins only `q` and `nonce` for Library, so this third param is written down
 * here, and Library must read it:
 *   - when a NEW request arrives (a new `nonce`, the "adjust state when a prop
 *     changes" step of spec §4.6), Library keeps `banner = newListBannerFor(params.newList)`;
 *   - the banner stays until "Save as list" or "Clear all" (and "Clear all"
 *     clears `newList` with the other route params);
 *   - every other caller leaves `newList` out, and a navigate WITH params
 *     REPLACES a tab's params (no merge), so an old `newList=1` is gone then;
 *   - a tab-bar press KEEPS the tab's params (the same nonce, W4-1 review
 *     round 2), so Library must read `newList` ONLY when the nonce changes,
 *     never on every render: else the banner would come back after
 *     "Save as list" each time the learner taps the Library tab.
 * The test "merge guard: Library reads the New list param" in
 * todayLogic.test.ts fails until Library does this. MERGE NOTE: the spec
 * pins only `q` and `nonce` for Library, so the Library unit (W4-2) does not
 * know this param; the guard is EXPECTED to fail right after the merge, until
 * library.tsx reads it (an edit at integration).
 */
export const NEW_LIST_PARAM = { newList: '1' } as const;

/**
 * The banner Library shows for NEW_LIST_PARAM (spec §8.10). "Add filters"
 * (walkthrough L11): "Save as list" appears only after a filter is added.
 */
export const NEW_LIST_BANNER = 'Add filters, then tap Save as list.';

/**
 * The "New list" banner for the value of Library's `newList` route param, or
 * null (see NEW_LIST_PARAM). A route param can be a string or a list of
 * strings (expo-router useLocalSearchParams); the first value counts.
 *
 *   const params = useLocalSearchParams<{ q?: string; nonce?: string; newList?: string }>();
 *   newListBannerFor(params.newList)   // '1' → 'Add filters, then tap Save as list.'
 *   newListBannerFor(undefined)        // → null (a list row, "Edit filters", a tab press)
 */
export function newListBannerFor(newList: string | readonly string[] | undefined): string | null {
  const value = typeof newList === 'string' ? newList : newList?.[0];
  return value === NEW_LIST_PARAM.newList ? NEW_LIST_BANNER : null;
}

/** "Choose what to learn" over `q` (spec §2.2 `/triage?q=`). */
export function triageRoute(q: Query) {
  return { pathname: '/triage', params: { q: serializeQuery(q) } } as const;
}

/**
 * Where the one-time "Want a daily reminder?" card goes (pinned cross-unit
 * contract): the Reminders screen, which runs the permission flow when it
 * opens with `enable=1`. Today never schedules a notification itself.
 */
export const REMINDER_OFFER_HREF = '/(tabs)/settings/reminders?enable=1';

/* ------------------------------------------------------------------ header and hero */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The date line over the greeting: 'Thursday 23 October' (the Overline shows it in capitals). */
export function dateOverline(now: number): string {
  const d = new Date(now);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The greeting by the local hour: before 12 → morning, before 18 → afternoon, else evening. */
export function greeting(now: number): string {
  const h = new Date(now).getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The line under the greeting while there is something to study:
 *   '30 cards ready · about 12 min'
 *   '34 ready · Study 30'            when the session size cut the run (spec §4.6)
 */
export function heroLine(ready: Pick<ReadyCounts, 'total' | 'mins' | 'capped' | 'uncappedTotal'>): string {
  if (ready.capped) return `${fmt(ready.uncappedTotal)} ready · Study ${fmt(ready.total)}`;
  return `${plural(ready.total, 'card')} ready · about ${fmt(ready.mins)} min`;
}

/** The text of a Study button: 'Study 30'. */
export function studyLabel(n: number): string {
  return `Study ${fmt(n)}`;
}

/**
 * The soft "breathing" pulse of Today's "Study {n}" button (design
 * pulseSoft: one breath = 2 × `halfMs` = 3.2 s, scale 1 → `scale` → 1).
 *
 * It is FINITE (wave 5i, release re-measure): `times` breaths when Today
 * comes into view, and again when the number on the button changes; then the
 * button rests. WHY: the pulse was an endless Animated.loop. Idle on Today
 * the phone drew 105–193 frames every 5 s at 13–17 % CPU (Settings: 0 frames,
 * 0 %), which costs battery, and the shared Library warm-up was about 5×
 * slower while Today was on screen.
 */
export const STUDY_PULSE = { times: 2, halfMs: 1600, scale: 1.015 } as const;

/**
 * True when the Study button may pulse now (TodayHero StudyHero): Today is the
 * screen in front (`focused`), the phone does not ask for less motion
 * (`reduced`, spec §8.12: no pulse with Reduce Motion), and the button has
 * cards to study. A change of any of these (or of `total`) stops the pulse
 * or starts a new short one.
 *
 *   pulseOn({ focused: true, reduced: false, total: 30 })  → true
 *   pulseOn({ focused: false, reduced: false, total: 30 }) → false  (another tab or a session on top)
 */
export function pulseOn(p: { focused: boolean; reduced: boolean; total: number }): boolean {
  return p.focused && !p.reduced && p.total > 0;
}

/**
 * The parts of the session under the "Up first" card, in the order of the
 * wireframe, parts that are 0 left out: '12 due · 8 learning · 10 new · 2 checks'.
 * They add up to the session (`ready.total`).
 */
export function breakdownLine(ready: Pick<ReadyCounts, 'due' | 'learning' | 'neww' | 'checks'>): string {
  const parts: string[] = [];
  if (ready.due > 0) parts.push(`${fmt(ready.due)} due`);
  if (ready.learning > 0) parts.push(`${fmt(ready.learning)} learning`);
  if (ready.neww > 0) parts.push(`${fmt(ready.neww)} new`);
  if (ready.checks > 0) parts.push(plural(ready.checks, 'check'));
  return parts.join(' · ');
}

/** One goal bar on Today. */
export interface GoalBar {
  key: 'reviews' | 'new';
  /** 'Reviews' / 'New'. */
  label: string;
  done: number;
  goal: number;
  /** 0–100 for the Bar. */
  pct: number;
  /** '12 / 30 goal'. */
  text: string;
  /** What a screen reader says: 'Reviews: 12 of 30 goal'. */
  a11y: string;
}

/**
 * The daily goal bars (spec §8.1). A goal of 0 means "Off": its bar is not
 * shown (and an empty list means no goal section at all). A goal never
 * blocks cards (§1.2 "Daily goal").
 */
export function goalBars(dayDone: Pick<DayDone, 'reviews' | 'neww'>, goals: { goalReviews: number; goalNew: number }): GoalBar[] {
  const bar = (key: GoalBar['key'], label: string, done: number, goal: number): GoalBar => ({
    key,
    label,
    done,
    goal,
    pct: Math.min(100, (Math.max(0, done) / goal) * 100),
    text: `${fmt(done)} / ${fmt(goal)} goal`,
    a11y: `${label}: ${fmt(done)} of ${fmt(goal)} goal`,
  });
  const out: GoalBar[] = [];
  if (goals.goalReviews > 0) out.push(bar('reviews', 'Reviews', dayDone.reviews, goals.goalReviews));
  if (goals.goalNew > 0) out.push(bar('new', 'New', dayDone.neww, goals.goalNew));
  return out;
}

/* ------------------------------------------------------------------ what Today shows */

/**
 * What the top of Today shows (spec §8.1, §8.11):
 *   'noDecks'         no deck at all          → "Start with a deck"
 *   'allPaused'       every deck is paused    → "All your decks are paused."
 *   'pausedCardsOnly' the active decks have no cards, the paused decks have
 *                     some                    → "Your cards are in paused decks."
 *   'noCards'         no deck has a card (active or paused) → "Your decks have no cards yet."
 *   'study'           ready > 0               → Up first + "Study {n}"
 *   'notStartedOnly'  nothing in the queue, but Not started cards → "Nothing is in your queue yet."
 *   'caughtUp'        cards exist, ready = 0  → "You're all caught up."
 * Only ACTIVE decks are studied: a paused deck's cards leave Today (§1.2
 * "Pause a deck"). The paused decks count only for 'pausedCardsOnly': "no
 * cards yet" would be false when a paused deck holds 300 cards (W4-1 review
 * round 1, for example a paused import next to a new empty deck).
 *
 * `notStarted` is the number of ITEMS the "Choose what to learn" button
 * opens in triage (notStartedItemCount: NOT_STARTED_SCOPE, the triage items
 * rule). It is not the sum of DeckSummary life.notStarted, and not the number
 * of Not started CARDS: those count suspended cards (W4-1 review round 2) and
 * cards of a direction that is turned off (final review 2026-11), but triage
 * leaves both out. So a deck whose only Not started cards are such cards
 * would show "Nothing is in your queue yet." with a button to an empty
 * triage (a dead end); now it shows "You're all caught up."
 *
 *   const notStarted = useStateV3(notStartedItemsReader(now));   // memoized per `now`
 *   todayMode({ decks, stats, readyTotal: ready.total, notStarted });
 */
export type TodayMode =
  | 'noDecks'
  | 'allPaused'
  | 'pausedCardsOnly'
  | 'noCards'
  | 'study'
  | 'notStartedOnly'
  | 'caughtUp';

export function todayMode(input: {
  decks: readonly Pick<Deck, 'id' | 'active'>[];
  stats: ReadonlyMap<Id, Pick<DeckSummary, 'total' | 'life'>>;
  readyTotal: number;
  /** The triage ITEMS of NOT_STARTED_SCOPE (notStartedItemCount): what "Choose what to learn" opens. */
  notStarted: number;
}): TodayMode {
  const { decks, stats, readyTotal, notStarted } = input;
  if (decks.length === 0) return 'noDecks';
  const active = decks.filter((d) => d.active);
  if (active.length === 0) return 'allPaused';
  if (readyTotal > 0) return 'study';
  let total = 0;
  let inQueue = 0;
  for (const deck of active) {
    const s = stats.get(deck.id);
    if (!s) continue;
    total += s.total;
    inQueue += s.life.new + s.life.learning + s.life.review + s.life.mastered;
  }
  if (total === 0) {
    const pausedCards = decks.reduce((sum, d) => sum + (d.active ? 0 : (stats.get(d.id)?.total ?? 0)), 0);
    return pausedCards > 0 ? 'pausedCardsOnly' : 'noCards';
  }
  if (inQueue === 0 && notStarted > 0) return 'notStartedOnly';
  return 'caughtUp';
}

/** A button of the caught-up card. */
export interface CaughtUpAction {
  key: 'ahead' | 'practice' | 'choose';
  label: string;
  count: number;
}

/**
 * The caught-up card's buttons (spec §8.1), only those with a count above 0:
 * "Study ahead · {n}" (changes the schedule), "Practice · {n}" (never
 * does), "Choose what to learn · {n} not started" (`notStarted` = the triage
 * ITEMS, notStartedItemCount — the same number as Complete and the triage
 * counter).
 */
export function caughtUpActions(n: { ahead: number; practice: number; notStarted: number }): CaughtUpAction[] {
  const out: CaughtUpAction[] = [];
  if (n.ahead > 0) out.push({ key: 'ahead', label: `Study ahead · ${fmt(n.ahead)}`, count: n.ahead });
  if (n.practice > 0) out.push({ key: 'practice', label: `Practice · ${fmt(n.practice)}`, count: n.practice });
  if (n.notStarted > 0) {
    out.push({ key: 'choose', label: `Choose what to learn · ${fmt(n.notStarted)} not started`, count: n.notStarted });
  }
  return out;
}

/** The copy of the empty and caught-up states (spec §8.1, §8.11, exact). */
export const TODAY_COPY = {
  caughtUpTitle: 'You’re all caught up.',
  /** With at least one button under it. */
  caughtUpSub: 'Come back tomorrow, or keep going:',
  /** When no button has a count above 0: the colon would point at nothing. */
  caughtUpSubAlone: 'Come back tomorrow.',
  noDecksTitle: 'Start with a deck',
  noDecksSub: 'Bring cards from Anki or a file, or make your own.',
  importFile: 'Import a file',
  findAnkiWeb: 'Find on AnkiWeb',
  makeDeck: 'Make my own deck',
  starterDecks: 'Starter decks',
  allPausedTitle: 'All your decks are paused.',
  pausedCardsTitle: 'Your cards are in paused decks.',
  pausedCardsSub: 'Your other decks have no cards yet.',
  showPaused: 'Show paused decks',
  notStartedTitle: 'Nothing is in your queue yet.',
  chooseWhat: 'Choose what to learn',
  noCardsTitle: 'Your decks have no cards yet.',
  noCardsSub: 'Add cards, or bring them from Anki or a file.',
  addCard: 'Add a card',
  noLists: 'No lists yet. Filter the Library, then tap Save as list.',
  showAllLists: 'Show all lists',
  showFewerLists: 'Show fewer lists',
  newList: '+ New list',
  addLabel: 'Add a deck, card, list or import',
} as const;

/**
 * The content pack's button on the no-decks card (spec §8.11), or null when
 * the pack has no starter decks. The button opens the AddSheet, whose
 * "Starter decks" part adds the decks one by one. So its title says THAT:
 * "Starter decks" — never the pack's onboarding first choice ("Start with
 * German"), which in the tour adds every starter deck at once after "Where
 * do you start?" (onboarding.tsx startWithPack). The same words for a
 * smaller action made the button promise what it did not do (final review
 * 2026-11). The line under it keeps the pack's own description.
 *
 *   packChoiceFor(german) → { title: 'Starter decks', sub: '9,105 words and grammar, A1 to C2' }
 *   packChoiceFor(generic) → null
 */
export function packChoiceFor(
  pack: Pick<ContentPack, 'starterDecks' | 'onboarding'>,
): { title: string; sub: string } | null {
  if (pack.starterDecks.length === 0) return null;
  return { title: TODAY_COPY.starterDecks, sub: pack.onboarding?.firstChoice?.sub ?? pack.starterDecks[0].subtitle };
}

/* ------------------------------------------------------------------ deck rows */

/** The decks in list order (deck.order), active first, the paused ones apart. */
export function splitDecks<D extends Pick<Deck, 'active' | 'order' | 'createdAt' | 'name'>>(
  decks: readonly D[],
): { active: D[]; paused: D[] } {
  const sorted = sortDecks(decks);
  return { active: sorted.filter((d) => d.active), paused: sorted.filter((d) => !d.active) };
}

/** What one deck row says. */
export interface DeckRowModel {
  /** The line under the name: '22 due · 10 new', 'All caught up ✓', 'Paused · 240 cards'. */
  line: string;
  /** The number of the "Study {n}" pill (= that deck's own session), or null for no pill. */
  pill: number | null;
}

/**
 * The line and pill of one deck row (spec §8.1).
 *   active, something to study → '{d} due · {n} new' + pill 'Study {ready}'
 *       d = the deck's cards due now (DeckSummary.dueNow), n = the new cards
 *       of THIS deck's session today (ready.neww). Parts that are 0 are left out.
 *   active, nothing to study   → 'All caught up ✓' (or '{n} not started' when
 *                                nothing of the deck is in the queue yet), no pill
 *   no cards                   → 'No cards yet', no pill
 *   paused                     → 'Paused · {n} cards', no pill: a paused deck's
 *                                cards leave Today; its deck page still studies it.
 */
export function deckRowModel(summary: DeckSummary | undefined, paused: boolean): DeckRowModel {
  const total = summary?.total ?? 0;
  if (paused) return { line: `Paused · ${plural(total, 'card')}`, pill: null };
  if (!summary || total === 0) return { line: 'No cards yet', pill: null };
  const ready = summary.ready;
  if (ready.total > 0) {
    const parts: string[] = [];
    if (summary.dueNow > 0) parts.push(`${fmt(summary.dueNow)} due`);
    if (ready.neww > 0) parts.push(`${fmt(ready.neww)} new`);
    if (ready.checks > 0) parts.push(plural(ready.checks, 'check'));
    return { line: parts.length > 0 ? parts.join(' · ') : plural(ready.total, 'card'), pill: ready.total };
  }
  const life = summary.life;
  const inQueue = life.new + life.learning + life.review + life.mastered;
  if (inQueue === 0 && life.notStarted > 0) return { line: `${fmt(life.notStarted)} not started`, pill: null };
  return { line: 'All caught up ✓', pill: null };
}

/** The numbers of one deck pill that the shared-limit note compares (DeckSummary.ready). */
export type PillCounts = Pick<ReadyCounts, 'total' | 'due' | 'neww'>;

/** The sentences of the shared-limit note (exact copy). */
export const SHARED_LIMIT_COPY = {
  separate: 'Each Study button is a session of that deck only.',
  newLimit: 'New cards come from one daily limit for all your decks.',
  reviewLimit: 'Reviews come from one daily limit for all your decks.',
  bothLimits: 'New cards and reviews each have one daily limit for all your decks.',
  sessionSize: (n: number) => `Your session size is ${plural(n, 'card')}.`,
} as const;

/**
 * The note under the deck rows when the pills add up to MORE than the hero's
 * "Study {n}" (device finding 2026-10-24), or null when the pills do not look
 * like parts of a bigger total (fewer than 2 pills, or a sum ≤ the total).
 *
 * `decks` = the `ready` counts of the ACTIVE decks (a deck with 0 has no pill).
 * The first sentence is always true: each pill is that deck's own session.
 * Then the note names ONLY the causes the numbers prove (W4-1 review round 1:
 * it used to blame new cards every time, also when no new card was involved):
 *   - the session size cut the hero ("80 ready · Study 50")
 *       → "Your session size is 50 cards."
 *   - the decks' new cards together are more than the hero could have had
 *       → "New cards come from one daily limit for all your decks."
 *   - the same for due reviews (the daily review limit is shared too)
 *       → "Reviews come from one daily limit for all your decks."
 *
 * WHY "more than the hero could have had": the session size cuts a run from
 * its END — new cards first, then checks, then reviews (schedule.ts
 * cutToSessionSize). So before its cut the hero had at most `neww + cut` new
 * cards and at most `due + cut` reviews (`cut` = uncappedTotal − total). Each
 * deck alone gets min(limit, its cards); all decks together get
 * min(limit, all cards). The decks' sum can be above the hero's count only
 * when that daily limit stopped the hero.
 *
 *   two decks with 40 due reviews each, no new cards, session size 50:
 *   hero 80 ready · Study 50, pills 40 + 40
 *   → 'Each Study button is a session of that deck only. Your session size is 50 cards.'
 */
export function sharedLimitNote(
  decks: readonly PillCounts[],
  hero: Pick<ReadyCounts, 'total' | 'due' | 'neww' | 'uncappedTotal'>,
): string | null {
  const withPill = decks.filter((d) => d.total > 0);
  const sum = (key: keyof PillCounts) => withPill.reduce((acc, d) => acc + d[key], 0);
  if (withPill.length < 2 || sum('total') <= hero.total) return null;
  const cut = Math.max(0, hero.uncappedTotal - hero.total);
  const newLimit = sum('neww') > hero.neww + cut;
  const reviewLimit = sum('due') > hero.due + cut;
  const parts: string[] = [SHARED_LIMIT_COPY.separate];
  if (newLimit && reviewLimit) parts.push(SHARED_LIMIT_COPY.bothLimits);
  else if (newLimit) parts.push(SHARED_LIMIT_COPY.newLimit);
  else if (reviewLimit) parts.push(SHARED_LIMIT_COPY.reviewLimit);
  if (cut > 0) parts.push(SHARED_LIMIT_COPY.sessionSize(hero.total));
  return parts.join(' ');
}

/** The row label of the paused group: 'Paused (2)'. */
export function pausedLabel(n: number): string {
  return `Paused (${fmt(n)})`;
}

/* ------------------------------------------------------------------ lists */

/**
 * The display preference of a list. A list without a stored pref:
 *   - a USER list is shown on Today (the learner made it for that);
 *   - a BUILT-IN list is not pinned (it waits behind "Show all lists").
 * `order` Infinity = after the lists with a stored order.
 */
export function listPrefOf(list: Pick<ListDef, 'id'>, prefs: Readonly<Record<string, ListPref>>): ListPref {
  const own = Object.prototype.hasOwnProperty.call(prefs, list.id) ? prefs[list.id] : undefined;
  if (own) return own;
  return { pinned: !isBuiltinListId(list.id), hidden: false, order: Number.POSITIVE_INFINITY };
}

/** Every list Today knows: the built-in lists (code, §4.7) then the user's lists. */
export function allLists(userLists: readonly ListDef[]): ListDef[] {
  return [...BUILTIN_LISTS, ...userLists.filter((l) => !isBuiltinListId(l.id))];
}

/** The numbers of one list row. */
export interface ListRowStats {
  /** Every card the list matches ('browse': paused decks too). */
  count: number;
  /**
   * Cards of the list that are due now AND that Study can show: the
   * scheduler's own due buckets (scope.ts dueAndReadyFor), like a deck row's
   * "{n} due". Never the second direction of an item, never a review whose
   * sibling was studied today, never a card with a broken due time.
   */
  due: number;
  /** = readyFor({ list: id }).total: the pill "Study {n}" and the session it opens. */
  ready: number;
}

/** One list row: the list, its pref and its numbers (`stats` only for a row that is drawn). */
export interface ListRowModel {
  list: ListDef;
  builtin: boolean;
  pref: ListPref;
  count: number;
  stats: ListRowStats | null;
}

/**
 * Which lists Today shows (spec §4.7, §8.1):
 *   shown — not hidden, pinned, and (a user list, or a built-in list with cards);
 *   more  — every other list, behind a quiet "Show all lists": hidden lists,
 *           built-in lists that are not pinned, and built-in lists with 0 cards.
 * Order: the stored `order`, then the built-in order, then the user lists by creation.
 */
export function splitLists(
  lists: readonly ListDef[],
  prefs: Readonly<Record<string, ListPref>>,
  counts: ReadonlyMap<string, number>,
): { shown: ListDef[]; more: ListDef[] } {
  const builtinIndex = new Map(BUILTIN_LISTS.map((l, i) => [l.id, i]));
  const rank = (l: ListDef) => {
    const order = listPrefOf(l, prefs).order;
    return {
      order: Number.isFinite(order) ? order : Number.POSITIVE_INFINITY,
      builtin: builtinIndex.get(l.id) ?? Number.POSITIVE_INFINITY,
      created: Number.isFinite(l.createdAt) ? l.createdAt : 0,
    };
  };
  const sorted = [...lists].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra.order !== rb.order) return ra.order < rb.order ? -1 : 1;
    if (ra.builtin !== rb.builtin) return ra.builtin < rb.builtin ? -1 : 1;
    return ra.created - rb.created;
  });
  const shown: ListDef[] = [];
  const more: ListDef[] = [];
  for (const list of sorted) {
    const pref = listPrefOf(list, prefs);
    const builtin = isBuiltinListId(list.id);
    const visible = !pref.hidden && pref.pinned && (!builtin || (counts.get(list.id) ?? 0) > 0);
    (visible ? shown : more).push(list);
  }
  return { shown, more };
}

/** The line under a list name: '14 cards · 3 due'. */
export function listRowLine(stats: Pick<ListRowStats, 'count' | 'due'>): string {
  const cards = plural(stats.count, 'card');
  return stats.due > 0 ? `${cards} · ${fmt(stats.due)} due` : cards;
}

/** The parts of the state the list rows read (a DataStateV3 fits). */
type ListState = Pick<
  DataStateV3,
  'cards' | 'notes' | 'noteTypes' | 'decks' | 'lists' | 'listPrefs' | 'person' | 'settings'
>;

/**
 * The numbers of one list (spec §4.6 "Today list row"): its cards, its due
 * cards and its "Study {n}", all through scope.ts. "{n} due" and "Study {n}"
 * come from ONE scheduler run (dueAndReadyFor), the rule of the deck rows:
 * a per-card "is it due?" (`due: 'now'`) counted both directions of an item
 * and a review whose sibling was studied today, so a row said "2 cards ·
 * 1 due" with no Study pill (final review 2026-11).
 *
 *   due >= learning + due reviews of the pill, and equal when no limit cuts it.
 */
export function listRowStats(state: ListState, listId: string, now: number): ListRowStats {
  const ctx = matchCtxOf(state, now);
  const q = listScope(listId);
  const { dueNow, ready } = dueAndReadyFor(state, q, ctx);
  return {
    count: scopePool(state, q, ctx, 'browse').length,
    due: dueNow,
    ready: ready.total,
  };
}

/** What the Lists section shows. */
export interface TodayLists {
  shown: ListRowModel[];
  more: ListRowModel[];
}

/**
 * The Lists section of a state (spec §8.1). Every list's card count decides
 * where it goes (splitLists). The full numbers (due, "Study {n}") are
 * computed only for the rows that are drawn: `shown`, and `more` only when
 * `expanded` ("Show all lists" was tapped). A rating changes `cards`, so the
 * numbers are computed again then — only for the drawn rows.
 */
export function todayLists(state: ListState, now: number, expanded: boolean): TodayLists {
  const ctx = matchCtxOf(state, now);
  const lists = allLists(state.lists ?? []);
  const prefs = state.listPrefs ?? {};
  const counts = new Map<string, number>();
  for (const list of lists) counts.set(list.id, scopePool(state, listScope(list.id), ctx, 'browse').length);
  const { shown, more } = splitLists(lists, prefs, counts);
  const row = (list: ListDef, withStats: boolean): ListRowModel => ({
    list,
    builtin: isBuiltinListId(list.id),
    pref: listPrefOf(list, prefs),
    count: counts.get(list.id) ?? 0,
    stats: withStats ? listRowStats(state, list.id, now) : null,
  });
  return { shown: shown.map((l) => row(l, true)), more: more.map((l) => row(l, expanded)) };
}

/**
 * Whether the Lists section says "No lists yet. Filter the Library, then tap
 * Save as list." — only when no row is drawn AND the learner has made no list
 * at all (W4-1 review round 2). When their lists are only hidden (Hide, or
 * behind "Show all lists"), the line would be false and would ask them to
 * make a list they already have: then only the "Show all lists" toggle shows.
 *
 *   no user list, no built-in list with cards            → true
 *   'B1 verbs' hidden, every built-in list has 0 cards   → false ("Show all lists" only)
 */
export function showNoListsLine(lists: TodayLists, expanded: boolean): boolean {
  const drawn = expanded ? lists.shown.length + lists.more.length : lists.shown.length;
  if (drawn > 0) return false;
  return ![...lists.shown, ...lists.more].some((row) => !row.builtin);
}

/** What the Lists section reads: when one of these changes, its numbers are computed again. */
function listInputs(s: ListState): readonly unknown[] {
  return [s.cards, libraryIndexOf(s), s.decks, s.lists, s.listPrefs, s.person?.dayDone, s.settings];
}

/** The selector behind the Lists section (memoized: the same inputs give the same object). */
export function todayListsReader(now: number, expanded: boolean): (state: ListState) => TodayLists {
  return memoOnInputs(listInputs, (state) => todayLists(state, now, expanded));
}

/** One action of the ListActionsSheet. */
export type ListActionKey = 'rename' | 'edit' | 'open' | 'hide' | 'show' | 'delete';

/** The label of each list action (spec §2.3, §7 #17). */
export const LIST_ACTION_LABEL: Readonly<Record<ListActionKey, string>> = Object.freeze({
  rename: 'Rename',
  edit: 'Edit filters',
  open: 'Open in Library',
  hide: 'Hide',
  show: 'Show on Today',
  delete: 'Delete list',
});

/**
 * The actions of a list's ⋯ sheet:
 *   a user list     → Rename · Edit filters · Hide (or Show on Today) · Delete list
 *   a built-in list → Open in Library · Hide (or Show on Today)
 * Built-in lists are code (§4.7): they cannot be renamed, changed or deleted,
 * only hidden or shown. "Show on Today" is the way back from "Hide" (and pins
 * a built-in list that is not pinned yet), so Hide is never a one-way trap.
 */
export function listActionKeys(list: Pick<ListDef, 'id'>, pref: ListPref): ListActionKey[] {
  const onToday = pref.pinned && !pref.hidden;
  const toggle: ListActionKey = onToday ? 'hide' : 'show';
  if (isBuiltinListId(list.id)) return ['open', toggle];
  return ['rename', 'edit', toggle, 'delete'];
}

/* ------------------------------------------------------------------ up first */

/** What the hero reads (the same parts as a Study count). */
type HeroState = Pick<DataStateV3, 'cards' | 'notes' | 'noteTypes' | 'decks' | 'lists' | 'person' | 'settings'>;

/** The first card of the session "Study {n}" opens now, or null (spec §8.1 "Up first"). */
export function upFirstCard(state: HeroState, now: number): Card | null {
  return buildSessionQueue({ kind: 'scheduled', q: ALL_SCOPE }, state, matchCtxOf(state, now))[0] ?? null;
}

function heroInputs(s: HeroState): readonly unknown[] {
  return [s.cards, libraryIndexOf(s), s.decks, s.lists, s.person?.dayDone, s.settings];
}

/** The selector behind "Up first" (memoized on what the queue reads). */
export function upFirstReader(now: number): (state: HeroState) => Card | null {
  return memoOnInputs(heroInputs, (state) => upFirstCard(state, now));
}

/* ------------------------------------------------------------------ one-time cards */

/** The one-time cards of Today (spec §8.1): at most one is shown at a time. */
export type OneTimeCardKind = 'repairs' | 'reminder';

/**
 * Which one-time card Today shows, or null:
 *   1. 'repairs'  — the last boot repaired `repairs` items (checkIntegrity),
 *                   until the learner closes it;
 *   2. 'reminder' — "Want a daily reminder?": after the first completed
 *                   session, while reminders are off, until it was seen once
 *                   (`settings.reminderOfferSeen`).
 */
export function pickOneTimeCard(input: {
  repairs: number;
  repairsDismissed: boolean;
  sessions: number;
  reminderEnabled: boolean;
  reminderOfferSeen: boolean;
}): OneTimeCardKind | null {
  if (input.repairs > 0 && !input.repairsDismissed) return 'repairs';
  if (input.sessions > 0 && !input.reminderEnabled && !input.reminderOfferSeen) return 'reminder';
  return null;
}

/** The repairs card: 'We fixed 3 items in your library.' */
export function repairsLine(n: number): string {
  return `We fixed ${plural(n, 'item')} in your library.`;
}

/** A 'HH:MM' reminder time as the UI says it: '20:00' → '8:00 PM'. A broken value reads as the default time. */
export function clockLabel(time: unknown): string {
  const t = parseReminderTime(time) ?? parseReminderTime(DEFAULT_REMINDER_TIME)!;
  const suffix = t.hour < 12 ? 'AM' : 'PM';
  const hour = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${hour}:${String(t.minute).padStart(2, '0')} ${suffix}`;
}

/** The copy of the reminder offer (spec §8.1, exact). */
export const REMINDER_OFFER_COPY = {
  title: 'Want a daily reminder?',
  notNow: 'Not now',
} as const;

/** The reminder offer's main button: 'Remind me at 8:00 PM' (the reminder time setting). */
export function reminderOfferButton(time: unknown): string {
  return `Remind me at ${clockLabel(time)}`;
}

/* ------------------------------------------------------------------ streak sheet */

/** One day of the streak strip: studied, saved by a freeze, missed, or today. */
export type DayMark = 'studied' | 'frozen' | 'missed' | 'today';

/** How many days the streak sheet looks back (the strip and the freeze count). */
export const STREAK_STRIP_DAYS = 14;

/**
 * The 14-day strip of the streak sheet, oldest first, today last. A day is
 * 'frozen' when a freeze bridged it, else 'studied' when a session belongs
 * to it, else 'missed'.
 */
export function streakStrip(
  sessions: readonly Pick<SessionRecord, 'dayKey'>[],
  freezeUsedDays: readonly string[],
  now: number,
): DayMark[] {
  const today = dayKeyOf(now);
  const studied = new Set(sessions.map((s) => s.dayKey));
  const frozen = new Set(freezeUsedDays);
  const out: DayMark[] = [];
  for (let back = STREAK_STRIP_DAYS - 1; back >= 0; back--) {
    const key = addDays(today, -back);
    if (back === 0) out.push('today');
    else if (frozen.has(key)) out.push('frozen');
    else if (studied.has(key)) out.push('studied');
    else out.push('missed');
  }
  return out;
}

/**
 * How many freezes were used in the last 14 days, today included (spec §7
 * #31: the old sheet said "1 freeze used" whatever happened). A day is
 * counted once, even if it is listed twice.
 */
export function freezesUsedRecently(freezeUsedDays: readonly string[], now: number): number {
  const today = dayKeyOf(now);
  const window = new Set<string>();
  for (let back = 0; back < STREAK_STRIP_DAYS; back++) window.add(addDays(today, -back));
  return new Set(freezeUsedDays.filter((d) => window.has(d))).size;
}

/** The freeze line of the streak sheet (spec §8.11): '1 freeze used in the last 14 days.' */
export function freezesUsedLine(k: number): string {
  return `${plural(k, 'freeze')} used in the last ${STREAK_STRIP_DAYS} days.`;
}

/** 'day in a row' / 'days in a row' after the big streak number. */
export function streakUnit(days: number): string {
  return days === 1 ? 'day in a row' : 'days in a row';
}

/* ------------------------------------------------------------------ AddSheet */

/** One row of the AddSheet (spec §8.10). */
export interface AddRow {
  key: 'card' | 'deck' | 'import' | 'ankiweb' | 'list';
  title: string;
  sub: string;
  icon: string;
}

/** The AddSheet title (spec §8.10, §8.11 copy sweep: "Add", no overline). */
export const ADD_SHEET_TITLE = 'Add';

/**
 * The rows of the AddSheet, in order (spec §8.10). "New card" goes into the
 * last used deck and is hidden when there is no deck (`lastDeckName` null).
 */
export function addSheetRows(lastDeckName: string | null): AddRow[] {
  const rows: AddRow[] = [];
  if (lastDeckName !== null) {
    rows.push({ key: 'card', title: 'New card', sub: `Into ${lastDeckName}`, icon: 'document-text-outline' });
  }
  rows.push(
    { key: 'deck', title: 'New deck', sub: 'Start empty and type your own cards', icon: 'albums-outline' },
    { key: 'import', title: 'Import a file', sub: 'Anki .apkg or .csv', icon: 'document-attach-outline' },
    { key: 'ankiweb', title: 'Find on AnkiWeb', sub: 'Search shared decks', icon: 'cloud-download-outline' },
    { key: 'list', title: 'New list', sub: 'Save a filter, like ‘B1 verbs’', icon: 'bookmark-outline' },
  );
  return rows;
}

/** The words of a starter deck row (spec §8.10): "Added ✓" or "Add". */
export const STARTER_COPY = { added: 'Added ✓', add: 'Add', adding: 'Adding…' } as const;

/** What the snackbar says after a starter deck "Add", and which retry it offers. */
export interface StarterMessage {
  text: string;
  /** 'copy' = "Add as a new deck"; 'images' = write the images again. */
  retry?: { kind: 'copy' | 'images'; label: string };
}

/**
 * The snackbar after `addStarterDeck` (src/domain/starterDecks.ts):
 *   'add'       → 'Added German vocabulary · 6,845 cards.'
 *   'update'    → 'Updated German vocabulary: 522 items changed, 500 new. Your progress is kept.'
 *                 (the counts are left out when they are 0)
 *                 + ' 245 old items are not in the new version, so they are suspended.'
 *                 when the newer file dropped items (retired: kept, cards suspended)
 *   'upToDate'  → 'Already up to date.'
 *   'elsewhere' → 'These cards are already in Unfiled cards.' + "Add as a new deck"
 * When the images were not written ('skipped' / 'failed'), it says so and
 * offers "Try again" (the images only, `writeStarterImages`): the deck row
 * then reads "Added ✓", so there is no other way back to the images.
 */
export function starterMessage(
  outcome: Pick<StarterDeckOutcome, 'kind' | 'starter' | 'result' | 'images' | 'elsewhereDecks'>,
): StarterMessage {
  const title = outcome.starter.title;
  let text: string;
  switch (outcome.kind) {
    case 'add':
      text = `Added ${title} · ${plural(outcome.result?.cardsAdded ?? 0, 'card')}.`;
      break;
    case 'update': {
      // What changed, in items (notes): "18 items changed, 2 new".
      const changed = outcome.result?.notesUpdated ?? 0;
      const added = outcome.result?.notesAdded ?? 0;
      const detail =
        changed > 0 && added > 0
          ? `${plural(changed, 'item')} changed, ${added.toLocaleString('en-US')} new`
          : changed > 0
            ? `${plural(changed, 'item')} changed`
            : added > 0
              ? plural(added, 'new item')
              : '';
      text = detail ? `Updated ${title}: ${detail}. Your progress is kept.` : `Updated ${title}. Your progress is kept.`;
      const retired = outcome.result?.notesRetired ?? 0;
      if (retired > 0) {
        const one = retired === 1;
        text += ` ${plural(retired, 'old item')} ${one ? 'is' : 'are'} not in the new version, so ${one ? 'it is' : 'they are'} suspended.`;
      }
      break;
    }
    case 'upToDate':
      text = 'Already up to date.';
      break;
    case 'elsewhere': {
      const names = outcome.elsewhereDecks.map((d) => d.deckName);
      const where = names.length > 0 ? names.join(', ') : 'your other decks';
      return { text: `These cards are already in ${where}.`, retry: { kind: 'copy', label: 'Add as a new deck' } };
    }
  }
  if (outcome.images === 'skipped' || outcome.images === 'failed') {
    return { text: `${text} Some images were not saved.`, retry: { kind: 'images', label: 'Try again' } };
  }
  return { text };
}
