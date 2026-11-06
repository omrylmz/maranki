/**
 * The logic of the Progress tab (spec §8.8, unit W4-6), kept out of the
 * screen so it can be tested without React.
 *
 *   Progress                                        ⤓  ("Export study history")
 *   🔥 12-day streak · best 30   ✓ 312 mastered · 1,530 known   Level 7 · Scholar
 *   TODAY            Reviews 12 / 30 goal · New 4 / 10 goal · 9 min
 *   NEXT 7 DAYS      ▂ ▅ ▃ ▇ ▂ ▁ ▃                    (src/domain/forecast.ts)
 *   ACTIVITY         (5 weeks | 35 weeks)
 *   BY DECK          🇩🇪 German  ▓▓▓░░░ 21% mastered   → deck page
 *   GERMAN · BY LEVEL  A1 Known · A2 62% · B1 8% …     → Library with Deck + Level chips
 *   ACHIEVEMENTS     12 / 24
 *   ALL TIME
 *
 * The rules that this file keeps (spec §8.8):
 *   - Progress is READ-ONLY. It never starts a session: there is no Start or
 *     Review button. A row opens the deck page or the Library (with the
 *     row's chips and a fresh `nonce`, spec §4.6).
 *   - Known is NEVER counted as mastered (life.ts `isMastered`). The mastery
 *     bars stack mastered | review | learning | new | not started | known,
 *     and "{p}% mastered" counts Mastered cards only (FacetBars.tsx rules).
 *   - "BY {GROUP}" blocks appear for each deck that has an ORDINAL filter
 *     group: a field (Level A1 < A2 < B1 …) or, when the deck has no such
 *     field, a section level ("Unit 1", "Unit 2" …). The group is found from
 *     the data, never from a language (spec §4.3).
 *   - Every count says its unit with `plural()` ("1 card", never "1 cards").
 *   - "Export study history" = the sessions CSV + the review CSV, zipped
 *     into ONE file (history.ts `historyZip`) and shared.
 *
 * Pure (state in, numbers and text out), except the history export: it
 * writes a file and opens the share sheet. It takes the disk, the share
 * sheet and the review history as one argument (`HistoryExportIO`; the app
 * passes `deviceHistoryIO()`), so the tests pass fakes.
 */
import { type FacetBarRow, facetBarLine } from '../ui/FacetBars';
import type { SegOption } from '../ui/controls';
import { fieldGroupLabel } from '../../domain/facets';
import { dueForecast, forecastDayLabel, type ForecastDay, forecastTotal } from '../../domain/forecast';
import type { LibraryIndex } from '../../domain/libraryIndex';
import { life } from '../../domain/life';
import type { Card, DataStateV3, Deck, Id, LifeKey, Note, Query, SessionRecord } from '../../domain/model';
import { compareLabels, detectOrdinal, type OrdinalKind } from '../../domain/ordinal';
import { fieldRecord, serializeQuery } from '../../domain/query';
import { minutesFor } from '../../domain/schedule';
import { decksById, type DeckSummary, libraryIndexOf } from '../../domain/scope';
import { plural } from '../../domain/text';
import { addDays, type DayDone } from '../../domain/types';
import { deleteCacheFiles, type SavedFile, writeCacheFile } from '../../platform/files';
import { SHARE_HISTORY_ZIP, shareFile, type ShareKind } from '../../platform/share';
import { HISTORY_PREFIX, type HistoryOutcome, historyMessage, historyZipFileName } from '../../store/backup';
import { historyFilesOf, type HistoryState, historyZip } from '../../store/history';
import { memoOnInputs } from '../../store/selectors';
import { appRevlogStore, type RevlogStore } from '../../store/storage';

/* ------------------------------------------------------------------ the hero line */

/**
 * The streak part of the hero line.
 *
 *   streakText(12, 30) → '12-day streak · best 30'
 *   streakText(0, 4)   → 'No streak yet · best 4'
 *   streakText(0, 0)   → 'No streak yet'
 */
export function streakText(streak: number, best: number): string {
  const days = Math.max(0, Math.floor(streak || 0));
  const top = Math.max(days, Math.floor(best || 0));
  const head = days > 0 ? `${days.toLocaleString('en-US')}-day streak` : 'No streak yet';
  return top > 0 ? `${head} · best ${top.toLocaleString('en-US')}` : head;
}

/**
 * The mastery part of the hero line. Known cards are their own number:
 * they are never counted as mastered (spec §8.8).
 *
 *   masteryText(312, 1530) → '312 mastered · 1,530 known'
 *   masteryText(5, 0)      → '5 mastered'
 */
export function masteryText(mastered: number, known: number): string {
  const head = `${mastered.toLocaleString('en-US')} mastered`;
  return known > 0 ? `${head} · ${known.toLocaleString('en-US')} known` : head;
}

/** "Level 7 · Scholar". */
export function levelText(info: { level: number; name: string }): string {
  return `Level ${info.level} · ${info.name}`;
}

/** Mastered and Known cards over every deck row (one sum, no extra pass over the cards). */
export function libraryTotals(stats: ReadonlyMap<Id, DeckSummary>): { cards: number; mastered: number; known: number } {
  let cards = 0;
  let mastered = 0;
  let known = 0;
  for (const row of stats.values()) {
    cards += row.total;
    mastered += row.life.mastered;
    known += row.life.known;
  }
  return { cards, mastered, known };
}

/* ------------------------------------------------------------------ today */

/** One goal bar of the TODAY row. */
export interface TodayGoal {
  label: 'Reviews' | 'New';
  done: number;
  /** 0 = no goal (the bar is hidden, spec §8.1 "a goal of 0 hides its bar"). */
  goal: number;
}

export interface TodaySummary {
  goals: TodayGoal[];
  /** Cards studied today in every session (Practice too). */
  studied: number;
  /** The TODAY line: "Reviews 12 / 30 goal · New 4 / 10 goal · 9 min". */
  line: string;
}

/** "Reviews 12 / 30 goal", or "Reviews 12" when the goal is off. */
function goalText(goal: TodayGoal): string {
  const done = goal.done.toLocaleString('en-US');
  return goal.goal > 0 ? `${goal.label} ${done} / ${goal.goal.toLocaleString('en-US')} goal` : `${goal.label} ${done}`;
}

/**
 * The TODAY row (spec §8.8). The goal numbers are today's tallies (the same
 * as the bars on Today): `dayDone` must be today's (normalizedDayDone). The
 * minutes come from the cards studied today in every session, with the one
 * minutes formula of the app (`minutesFor`; a session does not store its
 * length). The copy is the spec's: "9 min" (W5-5a: it said "about 9 min").
 *
 *   todaySummary({ reviews: 12, neww: 4 …}, { goalReviews: 30, goalNew: 10 }, sessions, '2026-06-10')
 *     → line 'Reviews 12 / 30 goal · New 4 / 10 goal · 7 min'
 */
export function todaySummary(
  dayDone: Pick<DayDone, 'reviews' | 'neww'>,
  goals: { goalReviews: number; goalNew: number },
  sessions: readonly Pick<SessionRecord, 'dayKey' | 'total'>[],
  today: string,
): TodaySummary {
  const list: TodayGoal[] = [
    { label: 'Reviews', done: Math.max(0, dayDone.reviews || 0), goal: Math.max(0, goals.goalReviews || 0) },
    { label: 'New', done: Math.max(0, dayDone.neww || 0), goal: Math.max(0, goals.goalNew || 0) },
  ];
  let studied = 0;
  for (const s of sessions) if (s.dayKey === today) studied += Math.max(0, s.total || 0);
  const parts = list.map(goalText);
  const mins = minutesFor(studied);
  if (mins > 0) parts.push(`${mins.toLocaleString('en-US')} min`);
  return { goals: list, studied, line: parts.join(' · ') };
}

/**
 * The colour of each goal bar, by token name (wave 5b L14): Reviews = pine,
 * New = amber — the SAME colours as the goal bars on Today (TodayHero.tsx
 * GoalBars), so one goal never has two colours in the app. (New was blue
 * here: `c.info`.) A screen draws `c[GOAL_BAR_TONE[goal.label]]`.
 */
export const GOAL_BAR_TONE: Readonly<Record<TodayGoal['label'], 'pine' | 'amber'>> = {
  Reviews: 'pine',
  New: 'amber',
};

/** A goal bar's percent (0–100) and its screen-reader label: "Reviews: 12 of 30 goal". */
export function goalBar(goal: TodayGoal): { pct: number; label: string } {
  const pct = goal.goal > 0 ? Math.min(100, (goal.done / goal.goal) * 100) : 0;
  return { pct, label: `${goal.label}: ${goal.done.toLocaleString('en-US')} of ${goal.goal.toLocaleString('en-US')} goal` };
}

/* ------------------------------------------------------------------ next 7 days */

/** One bar of the forecast, ready to draw. */
export interface ForecastBar {
  dayKey: string;
  label: string;
  count: number;
  /** 0–1: the bar height as a share of the busiest day (0 when no day has cards). */
  share: number;
}

/** The forecast days → bars with labels and heights. */
export function forecastBars(days: readonly ForecastDay[]): ForecastBar[] {
  const max = days.reduce((m, d) => Math.max(m, d.count), 0);
  return days.map((d, i) => ({
    dayKey: d.dayKey,
    label: forecastDayLabel(d, i),
    count: d.count,
    share: max > 0 ? d.count / max : 0,
  }));
}

/**
 * The forecast's screen-reader summary (spec §8.12: a chart is never colour only):
 *   "Due in the next 7 days: 34 cards. Today 12, Thu 5, Fri 0, …"
 */
export function forecastLabel(days: readonly ForecastDay[]): string {
  const bars = forecastBars(days);
  const total = forecastTotal(days);
  const each = bars.map((b) => `${b.label} ${b.count.toLocaleString('en-US')}`).join(', ');
  return `Due in the next ${plural(days.length, 'day')}: ${plural(total, 'card')}. ${each}`;
}

/**
 * The selector behind the forecast: dueForecast over every card at `now`,
 * computed again only when the cards, decks, notes or card types change.
 */
export function forecastReader(now: number): (state: DataStateV3) => ForecastDay[] {
  return memoOnInputs(
    // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
    ({ cards, decks, notes, noteTypes }: DataStateV3) => [cards, decks, notes, noteTypes],
    (s) => {
      const index = libraryIndexOf(s);
      return dueForecast(s.cards, {
        now,
        decks: decksById(s.decks),
        typeIdOf: (card) => index.noteById.get(card.noteId)?.typeId,
      });
    },
  );
}

/* ------------------------------------------------------------------ activity */

/** The two ranges of the activity heatmap. */
export type HeatRange = '5w' | '35w';

/** The range switch (spec §8.8 "(5 weeks | 35 weeks)"). */
export const HEAT_RANGES: SegOption[] = [
  { id: '5w', label: '5 weeks' },
  { id: '35w', label: '35 weeks' },
];

/** True for a range id of HEAT_RANGES. */
export function isHeatRange(id: string): id is HeatRange {
  return id === '5w' || id === '35w';
}

/** How many cells the heatmap has: 5 rows of 7. */
export const HEAT_CELLS = 35;

/** Cards studied → a heat level 0–4 (0 = nothing, 4 = 30 or more). */
export function heatLevel(cards: number): 0 | 1 | 2 | 3 | 4 {
  if (!(cards > 0)) return 0;
  if (cards < 10) return 1;
  if (cards < 20) return 2;
  if (cards < 30) return 3;
  return 4;
}

export interface Heatmap {
  /** 35 levels (0–4), oldest first: 5 rows of 7, read left to right, top to bottom. */
  cells: number[];
  /** Days (5 weeks) or weeks (35 weeks) with at least one studied card. */
  active: number;
  /** The first day the heatmap covers, 'YYYY-MM-DD'. */
  from: string;
  /** The screen-reader summary: "Studied 18 of the last 35 days". */
  label: string;
}

/**
 * The activity heatmap from the sessions (every kind counts: Practice too).
 *   '5w'   one cell per day, the last 35 days (today last);
 *   '35w'  one cell per week, the last 35 weeks (this week last); a week's
 *          level is its average cards per day, and at least 1 when the
 *          week has any studied card (so the picture and the label agree).
 */
export function heatmap(sessions: readonly Pick<SessionRecord, 'dayKey' | 'total'>[], today: string, range: HeatRange): Heatmap {
  const perDay = new Map<string, number>();
  for (const s of sessions) perDay.set(s.dayKey, (perDay.get(s.dayKey) ?? 0) + Math.max(0, s.total || 0));
  const cells: number[] = [];
  let active = 0;
  if (range === '5w') {
    for (let back = HEAT_CELLS - 1; back >= 0; back--) {
      const n = perDay.get(addDays(today, -back)) ?? 0;
      if (n > 0) active += 1;
      cells.push(heatLevel(n));
    }
    return { cells, active, from: addDays(today, -(HEAT_CELLS - 1)), label: `Studied ${active} of the last 35 days` };
  }
  for (let week = HEAT_CELLS - 1; week >= 0; week--) {
    let sum = 0;
    for (let d = 0; d < 7; d++) sum += perDay.get(addDays(today, -(week * 7 + d))) ?? 0;
    if (sum > 0) active += 1;
    // A week with any studied card is at least level 1: 3 cards in a week average 0 a day,
    // but the cell must not look empty while the label counts the week as studied.
    cells.push(sum > 0 ? Math.max(1, heatLevel(Math.round(sum / 7))) : 0);
  }
  return {
    cells,
    active,
    from: addDays(today, -(HEAT_CELLS * 7 - 1)),
    label: `Studied in ${active} of the last 35 weeks`,
  };
}

/** 'YYYY-MM-DD' → "Mar 5", read as a LOCAL date (so a time zone can never move the day). */
export function shortDate(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ by deck */

/** Status counts → the SegBar counts (FacetBarRow keys). */
function segCounts(lifeCounts: Readonly<Record<LifeKey, number>>): Omit<FacetBarRow, 'value' | 'label'> {
  return {
    mastered: lifeCounts.mastered,
    review: lifeCounts.review,
    learning: lifeCounts.learning,
    neww: lifeCounts.new,
    notStarted: lifeCounts.notStarted,
    known: lifeCounts.known,
  };
}

/** One BY DECK row: a deck's mastery bar. `value` is the deck id. */
export interface DeckMasteryRow extends FacetBarRow {
  icon: string;
  paused: boolean;
}

/** The decks in the user's deck order, then by name. */
function inDeckOrder(decks: readonly Deck[]): Deck[] {
  return [...decks].sort((a, b) => {
    const oa = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
    const ob = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
    return oa !== ob ? (oa < ob ? -1 : 1) : compareLabels(a.name, b.name);
  });
}

/**
 * The BY DECK rows: every deck that has cards (paused decks too: their
 * progress is real), in deck order, from the deck stats (one pass over the
 * cards, scope.ts deckStatsMap).
 */
export function deckMasteryRows(decks: readonly Deck[], stats: ReadonlyMap<Id, DeckSummary>): DeckMasteryRow[] {
  const out: DeckMasteryRow[] = [];
  for (const deck of inDeckOrder(decks)) {
    const row = stats.get(deck.id);
    if (!row || row.total === 0) continue;
    out.push({
      value: deck.id,
      label: deck.name,
      icon: deck.icon,
      paused: deck.active === false,
      total: row.total,
      ...segCounts(row.life),
    });
  }
  return out;
}

/** The line under a deck's bar: "21% mastered · 1,240 cards", "· Paused" for a paused deck. */
export function deckRowLine(row: DeckMasteryRow): string {
  return row.paused ? `${facetBarLine(row)} · Paused` : facetBarLine(row);
}

/** A deck row's screen-reader label: "German: 21% mastered · 1,240 cards" (the row's hint says where it goes). */
export function deckRowLabel(row: DeckMasteryRow): string {
  return `${row.label}: ${deckRowLine(row)}`;
}

/* ------------------------------------------------------------------ by {group} */

/** One row of a BY {GROUP} block: one value, its mastery and its Library chips. */
export interface GroupRow extends FacetBarRow {
  /** The Library chips of this row: the deck AND the value (spec §11 E10). */
  query: Query;
}

/** One "{DECK} · BY {GROUP}" block. */
export interface GroupBlock {
  /** Stable React key: deck id + group. */
  key: string;
  deckId: Id;
  deckName: string;
  /** The group's label, e.g. "Level" (field) or "Section". */
  group: string;
  kind: OrdinalKind;
  rows: GroupRow[];
}

/** The status counts of one value. */
type LifeTally = Record<LifeKey, number>;

function zeroTally(): LifeTally {
  return { notStarted: 0, new: 0, learning: 0, review: 0, mastered: 0, known: 0 };
}

/** One section node at one depth: its display label, its folded paths and its counts. */
interface SectionTally {
  label: string;
  paths: Set<string>;
  tally: LifeTally;
}

/** What one pass collects for one deck. */
interface DeckTally {
  /** folded field name → folded value → counts. */
  fields: Map<string, Map<string, LifeTally>>;
  /** depth (1 = top level) → folded last part → node. */
  sections: Map<number, Map<string, SectionTally>>;
  /** The note of each card of the deck, one entry per card (for the equivalence check). */
  cardNotes: Note[];
}

/**
 * The partition key of a card that is in NO row of a group: no value in the
 * field, or no section at that depth. A control character, so it never
 * equals a real (folded) value.
 */
const NO_ROW = '\u0000';

/**
 * True when two groups split the same `n` cards into exactly the same parts
 * (spec §4.3 "Equivalence collapse"): the keys of the two groups map one to
 * one. `a(i)` and `b(i)` are the keys of card i in each group (NO_ROW when
 * the card is in no row). One pass with two maps.
 *
 *   Level A1, A1, A2  vs  section A1, A1, A2          → true  (the same parts)
 *   Level A1, A1, A2  vs  section Lesson 1, 2, 3      → false (A1 is split in two)
 */
function samePartition(n: number, a: (i: number) => string, b: (i: number) => string): boolean {
  const aToB = new Map<string, string>();
  const bToA = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const x = a(i);
    const y = b(i);
    const seenB = aToB.get(x);
    if (seenB === undefined) aToB.set(x, y);
    else if (seenB !== y) return false;
    const seenA = bToA.get(y);
    if (seenA === undefined) bToA.set(y, x);
    else if (seenA !== x) return false;
  }
  return true;
}

function tallyOf<K>(map: Map<K, LifeTally>, key: K): LifeTally {
  let t = map.get(key);
  if (!t) map.set(key, (t = zeroTally()));
  return t;
}

/** The last '::' part of a path ('Verbs::B1' → 'B1'). */
function lastPart(path: string): string {
  const at = path.lastIndexOf('::');
  return at === -1 ? path : path.slice(at + 2);
}

/** The rows of one block, in ordinal order (rank, then label). */
function ordinalRows(
  entries: { value: string; label: string; tally: LifeTally; query: Query }[],
  rank: (label: string) => number,
): GroupRow[] {
  return entries
    .map((e) => {
      const counts = segCounts(e.tally);
      const total = Object.values(e.tally).reduce((n, v) => n + v, 0);
      return { row: { value: e.value, label: e.label, total, query: e.query, ...counts }, rank: rank(e.label) };
    })
    .sort((a, b) => (a.rank !== b.rank ? (a.rank < b.rank ? -1 : 1) : compareLabels(a.row.label, b.row.label)))
    .map((x) => x.row);
}

/**
 * The "{DECK} · BY {GROUP}" blocks (spec §8.8): for each deck with cards,
 * in deck order, one block per ORDINAL field group, and one block for the
 * first ordinal section level that is not the same group as a field (spec
 * §4.3 "Equivalence collapse": field > section). ONE pass over the cards
 * (a second pass over one deck's cards only for the equivalence check).
 *
 * A field is a block when (the facet rules of spec §4.3, inside one deck):
 *   - it is a filter group of the library (`index.fieldSpecs`), with one
 *     value per card (a multi-value field like "regular, separable" would
 *     count a card in several rows, so it is not a breakdown);
 *   - the deck's cards have at least 2 of its values;
 *   - every one of those values is ordinal (CEFR, JLPT, HSK, numbers,
 *     "Unit 2"…: ordinal.ts detectOrdinal).
 * A section level is a block when, at that depth of the section tree, the
 * deck has at least 2 parts and all their names are ordinal. Parts with the
 * same name under different parents are one row (Vocabulary › A1 and
 * Grammar › A1 → one "A1" row that holds both). Only the first such level
 * is shown, and a level that splits the deck's cards EXACTLY like one of its
 * field blocks is skipped: it is the same group twice (German: Level ==
 * the "A1, A2 …" section level → only "By level"). A level that groups the
 * cards differently is a group of its own and is shown too (Level A1/A2
 * with sections "Lesson 1" … "Lesson 4" → "By level" and "By section").
 *
 * Each row's `query` is the Library chips Deck + the value, so the Library
 * count of a row is the row's card count.
 */
export function groupBlocks(cards: readonly Card[], index: LibraryIndex, decks: readonly Deck[]): GroupBlock[] {
  const deckIds = new Set(decks.map((d) => d.id));
  const byDeck = new Map<Id, DeckTally>();
  for (const card of cards) {
    if (!deckIds.has(card.deckId)) continue;
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    let t = byDeck.get(card.deckId);
    if (!t) byDeck.set(card.deckId, (t = { fields: new Map(), sections: new Map(), cardNotes: [] }));
    t.cardNotes.push(note);
    const key = life(card);

    for (const [field, values] of index.facetValues(note)) {
      const spec = index.fieldSpecs.get(field);
      if (!spec || spec.multiSep !== undefined || values.length !== 1) continue;
      let perValue = t.fields.get(field);
      if (!perValue) t.fields.set(field, (perValue = new Map()));
      tallyOf(perValue, values[0])[key] += 1;
    }

    const path = index.sectionPath(note);
    if (path === '') continue;
    const parts = path.split('::');
    for (let depth = 1; depth <= parts.length; depth++) {
      let level = t.sections.get(depth);
      if (!level) t.sections.set(depth, (level = new Map()));
      const name = parts[depth - 1];
      let node = level.get(name);
      if (!node) {
        const prefix = parts.slice(0, depth).join('::');
        node = { label: lastPart(index.sectionLabel(prefix)), paths: new Set(), tally: zeroTally() };
        level.set(name, node);
      }
      node.paths.add(parts.slice(0, depth).join('::'));
      node.tally[key] += 1;
    }
  }

  const out: GroupBlock[] = [];
  for (const deck of inDeckOrder(decks)) {
    const t = byDeck.get(deck.id);
    if (!t) continue;
    const blocks: GroupBlock[] = [];
    /** The fields that became blocks (for the equivalence check of the section levels). */
    const blockFields: string[] = [];

    for (const [field, perValue] of t.fields) {
      if (perValue.size < 2) continue;
      const entries = [...perValue].map(([value, tally]) => ({
        value,
        label: index.valueLabel(field, value),
        tally,
        query: { decks: [deck.id], fields: fieldRecord([[field, [value]]]) } as Query,
      }));
      const ordinal = detectOrdinal(entries.map((e) => e.label));
      if (!ordinal) continue;
      const spec = index.fieldSpecs.get(field);
      blockFields.push(field);
      blocks.push({
        key: `${deck.id}:field:${field}`,
        deckId: deck.id,
        deckName: deck.name,
        // The SAME group name as the Library's FacetSheet and chips (facets
        // fieldGroupLabel with its card types, walkthrough M8): a label a card
        // type chose wins, and a raw name is made readable ("CEFR Level").
        group: fieldGroupLabel(spec?.label ?? field, spec ? { spec, typeById: index.typeById } : undefined),
        kind: ordinal.kind,
        rows: ordinalRows(entries, ordinal.rank),
      });
    }
    blocks.sort((a, b) => compareLabels(a.group, b.group));

    // The partition keys of the deck's cards (see samePartition), read only when a field block exists.
    const notes = t.cardNotes;
    const fieldKey = (field: string) => (i: number) => {
      const values = index.facetValues(notes[i]).get(field);
      return values && values.length === 1 ? values[0] : NO_ROW;
    };
    let pathParts: string[][] | null = null;
    const sectionKey = (depth: number) => {
      const parts = (pathParts ??= notes.map((note) => {
        const path = index.sectionPath(note);
        return path === '' ? [] : path.split('::');
      }));
      return (i: number) => parts[i][depth - 1] ?? NO_ROW;
    };
    /** True when this section level is the same group as a field block (field > section, spec §4.3). */
    const sameAsAField = (depth: number) =>
      blockFields.some((field) => samePartition(notes.length, sectionKey(depth), fieldKey(field)));

    const depths = [...t.sections.keys()].sort((a, b) => a - b);
    for (const depth of depths) {
      const level = t.sections.get(depth)!;
      if (level.size < 2) continue;
      const entries = [...level].map(([name, node]) => ({
        value: name,
        label: node.label,
        tally: node.tally,
        query: { decks: [deck.id], sections: [...node.paths].sort().map((p) => ({ deckId: deck.id, path: p })) } as Query,
      }));
      const ordinal = detectOrdinal(entries.map((e) => e.label));
      if (!ordinal || sameAsAField(depth)) continue;
      blocks.push({
        key: `${deck.id}:section:${depth}`,
        deckId: deck.id,
        deckName: deck.name,
        group: 'Section',
        kind: ordinal.kind,
        rows: ordinalRows(entries, ordinal.rank),
      });
      break;
    }
    out.push(...blocks);
  }
  return out;
}

/** The heading of a block: "German · By level" (the heading draws it in capitals). */
export function groupHeading(block: Pick<GroupBlock, 'deckName' | 'group'>): string {
  return `${block.deckName} · By ${block.group.toLowerCase()}`;
}

/**
 * The selector behind the BY {GROUP} blocks: computed again only when the
 * cards, notes, card types or decks change. Each Progress screen makes its
 * own reader (it keeps the last result).
 */
export function groupBlocksReader(): (state: DataStateV3) => GroupBlock[] {
  return memoOnInputs(
    // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
    ({ cards, notes, noteTypes, decks }: DataStateV3) => [cards, notes, noteTypes, decks],
    (s) => groupBlocks(s.cards, libraryIndexOf(s), s.decks),
  );
}

/* ------------------------------------------------------------------ navigation */

/**
 * Where a deck row goes: the deck page. A plain string: the route file
 * `/deck/[id]` belongs to another unit of this wave, so the caller casts it
 * to expo-router's `Href`.
 *
 *   deckHref('d1') → '/deck/d1'
 */
export function deckHref(deckId: Id): string {
  return `/deck/${encodeURIComponent(deckId)}`;
}

/**
 * Where a BY {GROUP} row goes: the Library with the row's chips (spec §4.6:
 * `q` = the Query as JSON, `nonce` = a new value for every tap, so the
 * Library applies it even when the same row is tapped twice). The caller
 * passes the nonce from the press handler (it reads the clock), never from
 * render.
 *
 *   libraryHref({ decks: ['d1'] }, '17') → '/(tabs)/library?q=%7B%22decks%22%3A%5B%22d1%22%5D%7D&nonce=17'
 */
export function libraryHref(q: Query, nonce: string): string {
  return `/(tabs)/library?q=${encodeURIComponent(serializeQuery(q))}&nonce=${encodeURIComponent(nonce)}`;
}

/* ------------------------------------------------------------------ achievements, all time */

/** "12 / 24": unlocked of all. */
export function achievementsCount(statuses: readonly { unlocked: boolean }[]): string {
  return `${statuses.filter((s) => s.unlocked).length} / ${statuses.length}`;
}

/** The ALL TIME ledger rows: [label, value]. */
export function allTimeRows(sessions: readonly Pick<SessionRecord, 'dayKey' | 'total'>[]): [string, string][] {
  let cards = 0;
  const days = new Set<string>();
  for (const s of sessions) {
    cards += Math.max(0, s.total || 0);
    days.add(s.dayKey);
  }
  const count = sessions.length;
  return [
    ['Cards studied', cards.toLocaleString('en-US')],
    ['Sessions', count.toLocaleString('en-US')],
    ['Average per session', count > 0 ? plural(Math.round(cards / count), 'card') : '—'],
    ['Days active', days.size.toLocaleString('en-US')],
  ];
}

/* ------------------------------------------------------------------ export study history */

/** The empty-state copy (spec §8.11 "Progress, no sessions"). */
export const PROGRESS_EMPTY = {
  title: 'Your progress shows up after your first session.',
  action: 'Go to Today',
} as const;

/** The ⤓ button's label (spec §8.8). */
export const EXPORT_HISTORY_LABEL = 'Export study history';

/**
 * What "Export study history" did: the outcomes of the wave-2 export
 * (backup.ts HistoryOutcome), and 'read-failed' — the review history could
 * not be read, so no file was made.
 */
export type HistoryExportOutcome = HistoryOutcome | { kind: 'read-failed' };

/** The disk, share sheet and review history that the export uses. Tests pass fakes. */
export interface HistoryExportIO {
  /** The review history (the app's: `appRevlogStore()`). Only `all()` is read. */
  revlog: Pick<RevlogStore, 'all'>;
  /** Write bytes to the cache folder (for sharing). Throws on failure. */
  writeCache(name: string, content: Uint8Array): SavedFile;
  /** Delete the cache files whose name starts with `prefix`. Throws on failure. */
  clearCache(prefix: string): void;
  /** Open the share sheet. Resolves false when sharing is not available. May reject. */
  share(uri: string, kind: ShareKind): Promise<boolean>;
}

/** The phone's review history, cache folder (expo-file-system) and share sheet (expo-sharing). */
export function deviceHistoryIO(): HistoryExportIO {
  return {
    revlog: appRevlogStore(),
    writeCache: (name, content) => writeCacheFile(name, content),
    clearCache: (prefix) => {
      deleteCacheFiles(prefix);
    },
    share: (uri, kind) => shareFile(uri, kind),
  };
}

/** Delete old history files in the cache; a failure only leaves an old file behind. */
function clearQuietly(io: HistoryExportIO, prefix: string): void {
  try {
    io.clearCache(prefix);
  } catch {
    // Ignored: an old cache file does no harm.
  }
}

/**
 * "Export study history" (Progress ⤓, spec §8.8): the sessions CSV and the
 * review CSV (history.ts), zipped into ONE file `maranki-history-<stamp>.zip`
 * (local time, backup.ts `historyZipFileName`), then the share sheet. Resolves null without writing anything when there
 * is no session yet. Never rejects.
 *
 * The history is never kept inside the app: older history files in the
 * cache are deleted first, and the new one is deleted again when it could
 * not be shared (a hidden copy that nobody can open helps nobody).
 */
export async function exportStudyHistory(
  state: HistoryState,
  now: number,
  io: HistoryExportIO,
): Promise<HistoryExportOutcome | null> {
  if (state.sessions.length === 0) return null;
  let zip: Uint8Array;
  try {
    zip = historyZip(historyFilesOf(state, await io.revlog.all()));
  } catch {
    return { kind: 'read-failed' };
  }
  // Local time in the name, like every file the learner sees (wave 5b L8).
  const name = historyZipFileName(now);
  clearQuietly(io, HISTORY_PREFIX);
  let file: SavedFile;
  try {
    file = io.writeCache(name, zip);
  } catch {
    return { kind: 'failed' };
  }
  let outcome: HistoryExportOutcome;
  try {
    if (await io.share(file.uri, SHARE_HISTORY_ZIP)) return { kind: 'shared', name };
    outcome = { kind: 'unavailable' };
  } catch {
    outcome = { kind: 'share-failed' };
  }
  clearQuietly(io, HISTORY_PREFIX);
  return outcome;
}

/** The snackbar line after "Export study history", or null when the share sheet opened. */
export function historyExportMessage(outcome: HistoryExportOutcome | null): string | null {
  if (outcome !== null && outcome.kind === 'read-failed') return "We couldn't read your study history. Please try again.";
  return historyMessage(outcome);
}
