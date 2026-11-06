/**
 * The study history (spec §3.8, §8.4, §8.8, unit W3-3): read the uncapped
 * review history (the `revlog` table of the row store) and build the files
 * of "Export study history".
 *
 * Two readers:
 *   - `cardHistory(cardId | card)` — the CardSheet line
 *       "History: 7 reviews · 1 lapse · last: 3 days ago (Good)";
 *   - `historyCsv(state)` — the two CSV files of the history export:
 *       sessions.csv  date, kind, mode, cards, again, hard, good, easy, minutes, xp
 *                     (the wave-2 builder `sessionsCsv`, backup.ts — reused)
 *       reviews.csv   date, deck, front, direction, rating, interval_before,
 *                     interval_after, ease_after, seconds   (one row per rating)
 *     `historyZip(files)` puts both in one zip (fflate), so ONE share sheet
 *     carries them: `maranki-history-<stamp>.zip`, named in the phone's
 *     LOCAL time by backup.ts `historyZipFileName` (wave 5b L8).
 *
 * File names (wave 5d, L8): this file makes no file name of its own any
 * more. It had a second zip name in UTC (`historyZipName`), which no screen
 * used; a name in UTC looks like the wrong time to the learner. Every file
 * name is made in LOCAL time (backup.ts `localFileStamp`): do not add a UTC
 * one again.
 *
 * The builders are PURE (state + rows in, text out), so they are tested
 * without a database. The async helpers read the rows from a RevlogStore:
 * the app's (`appRevlogStore()`) by default, or the one a test passes.
 *
 * A row keeps the history of a card that was deleted later. Its deck,
 * front and direction cells are then empty: the history is never dropped.
 *
 * Example (Progress "⤓", W4-6):
 *   const files = await historyFiles(state);
 *   const zip = historyZip(files);
 *   const saved = writeCacheFile(historyZipFileName(Date.now()), zip);   // backup.ts, local time
 *   await shareFile(saved.uri, SHARE_HISTORY_ZIP);
 */
import { strToU8, zipSync } from 'fflate';

import type { Card, CardFace, Deck, Note, NoteType, RevlogRow, SessionRecord } from '../domain/model';
import { renderFace } from '../domain/render';
import { plural } from '../domain/text';
import { DAY, dayKeyOf, type Rating } from '../domain/types';
import { toCsv } from '../platform/csv';
import { sessionsCsv } from './backup';
import { appRevlogStore, type RevlogStore } from './storage';

/** The columns of the review CSV (spec §8.8, wave 3), in order. */
export const REVIEWS_CSV_HEADER = [
  'date',
  'deck',
  'front',
  'direction',
  'rating',
  'interval_before',
  'interval_after',
  'ease_after',
  'seconds',
] as const;

/** The file names inside the history zip. */
export const HISTORY_FILE_NAMES = { sessions: 'sessions.csv', reviews: 'reviews.csv' } as const;

/** What the history builders read from the state (the app's DataState fits it). */
export interface HistoryState {
  sessions: readonly SessionRecord[];
  cards: readonly Card[];
  notes: readonly Note[];
  noteTypes: readonly NoteType[];
  decks: readonly Deck[];
}

/** The question side of a card as one line (default: rendered from its note, render.ts). */
export type FrontOf = (card: Card) => string;

/** One file of the history export. */
export interface HistoryFile {
  name: string;
  text: string;
}

/* ------------------------------------------------------------- lookups */

/** Fast lookups over the state, built once per export. */
function lookups(state: Omit<HistoryState, 'sessions'>) {
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  const notes = new Map(state.notes.map((n) => [n.id, n]));
  const types = new Map(state.noteTypes.map((t) => [t.id, t]));
  const decks = new Map(state.decks.map((d) => [d.id, d]));
  return { cards, notes, types, decks };
}

/** The default FrontOf: the card's rendered prompt line, or '' when its note or card type is gone. */
function renderedFront(state: Omit<HistoryState, 'sessions'>): FrontOf {
  const { notes, types, decks } = lookups(state);
  return (card) => {
    const note = notes.get(card.noteId);
    const type = note ? types.get(note.typeId) : undefined;
    if (!note || !type) return '';
    const face: CardFace = renderFace(note, type, card.ord, decks.get(card.deckId) ?? null);
    return face.promptPlain;
  };
}

/**
 * The direction of a card as a short name: its template's name ("DE-EN"),
 * "Cloze 2" for the second deletion of a cloze card, or '' when unknown.
 */
export function directionName(type: NoteType | undefined, ord: number): string {
  if (!type) return '';
  if (type.kind === 'cloze') return `Cloze ${ord + 1}`;
  return type.templates.find((t) => t.ord === ord)?.name ?? '';
}

/** 'YYYY-MM-DD HH:mm' in the phone's time zone. */
export function localDateTime(ms: number): string {
  const d = new Date(ms);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${dayKeyOf(ms)} ${hh}:${mm}`;
}

/** A number rounded to `digits` decimals (2.3456 → 2.35), or null when it is not finite. */
function round(value: number, digits: number): number | null {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/* ------------------------------------------------------------ builders */

/**
 * The review CSV: one row per rating, oldest first. Text cells are guarded
 * against spreadsheet formulas (csv.ts), because the front comes from a deck.
 *   - date      = the local date and time of the rating;
 *   - deck      = the deck the card was in WHEN it was rated;
 *   - front     = the card's question line (empty when the card is gone);
 *   - direction = its template name (directionName);
 *   - seconds   = reveal → rate, one decimal (empty when unknown).
 *
 * The front and direction cells are computed ONCE per card, not once per
 * row: a card has many ratings (about 73,000 rows after a year of 200
 * reviews a day), and rendering the same face again for each one blocked
 * the JS thread for seconds on a phone.
 */
export function reviewsCsv(rows: readonly RevlogRow[], state: Omit<HistoryState, 'sessions'>, frontOf?: FrontOf): string {
  const { cards, notes, types, decks } = lookups(state);
  const front = frontOf ?? renderedFront(state);
  /** card id → [front, direction] (see the comment above). */
  const cellsByCard = new Map<string, readonly [string, string]>();
  const cardCells = (card: Card): readonly [string, string] => {
    let cells = cellsByCard.get(card.id);
    if (!cells) {
      const note = notes.get(card.noteId);
      const type = note ? types.get(note.typeId) : undefined;
      cells = [front(card), directionName(type, card.ord)];
      cellsByCard.set(card.id, cells);
    }
    return cells;
  };
  const lines = [...rows]
    .sort((a, b) => a.seq - b.seq)
    .map((row) => {
      const card = cards.get(row.cardId);
      const [frontCell, directionCell] = card ? cardCells(card) : ['', ''];
      return [
        localDateTime(row.atMs),
        decks.get(row.deckId)?.name ?? '',
        frontCell,
        directionCell,
        row.rating,
        round(row.ivlBefore, 2),
        round(row.ivlAfter, 2),
        round(row.easeAfter, 2),
        row.durationMs === null ? null : round(row.durationMs / 1000, 1),
      ];
    });
  return toCsv(REVIEWS_CSV_HEADER, lines, { guardFormulas: true });
}

/**
 * The sessions CSV of wave 2 (`sessionsCsv`, backup.ts). It reads only
 * dayKey, kind, mode, counts, total and xp, which every session shape has.
 */
export function sessionsCsvOf(sessions: readonly SessionRecord[]): string {
  return sessionsCsv(sessions);
}

/** The two history files from the state and the history rows (pure). */
export function historyFilesOf(state: HistoryState, rows: readonly RevlogRow[], frontOf?: FrontOf): HistoryFile[] {
  return [
    { name: HISTORY_FILE_NAMES.sessions, text: sessionsCsvOf(state.sessions) },
    { name: HISTORY_FILE_NAMES.reviews, text: reviewsCsv(rows, state, frontOf) },
  ];
}

/**
 * The two history files, with the rows read from the review history (the
 * app's by default). Rejects when the history cannot be read.
 */
export async function historyFiles(
  state: HistoryState,
  store: RevlogStore = appRevlogStore(),
  frontOf?: FrontOf,
): Promise<HistoryFile[]> {
  return historyFilesOf(state, await store.all(), frontOf);
}

/**
 * Spec §3.8 `historyCsv()`: the sessions CSV and the review CSV as texts.
 * Rejects when the history cannot be read.
 */
export async function historyCsv(
  state: HistoryState,
  store: RevlogStore = appRevlogStore(),
  frontOf?: FrontOf,
): Promise<{ sessions: string; reviews: string }> {
  const [sessions, reviews] = await historyFiles(state, store, frontOf);
  return { sessions: sessions.text, reviews: reviews.text };
}

/**
 * The default file date inside the history zip: 2 January 1980, 12:00, in
 * the phone's LOCAL time (epoch ms).
 *
 * WHY local time: a zip stores a file date as local year, month, day, hour …
 * (the old DOS format, years 1980-2099 only), and fflate reads those parts
 * with `getFullYear()` and the other LOCAL getters. A UTC date such as
 * `Date.UTC(1980, 0, 1)` is still 31 Dec 1979 on every phone west of UTC
 * (all of the Americas), and fflate then throws "date not in range
 * 1980-2099". Local noon on 2 January is inside the range in EVERY time
 * zone, and the zip then holds the same date (1980-01-02 12:00) everywhere,
 * so the same files give the same bytes on every phone.
 */
export function historyZipEpoch(): number {
  return new Date(1980, 0, 2, 12, 0, 0).getTime();
}

/**
 * The history files as ONE zip (bytes), for one share sheet. The texts are
 * UTF-8 (the CSV starts with a BOM, csv.ts). `mtime` (epoch ms) is the file
 * date inside the zip; default `historyZipEpoch()` (a fixed early date), so
 * the same files always give the same bytes. A given `mtime` must be in
 * 1980-2099 in local time (Date.now() is).
 */
export function historyZip(files: readonly HistoryFile[], mtime: number = historyZipEpoch()): Uint8Array {
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const file of files) entries[file.name] = strToU8(file.text);
  return zipSync(entries, { level: 6, mtime });
}

/* ------------------------------------------------------- card history */

/**
 * What the CardSheet shows about one card's past (spec §8.4). Every number
 * comes from the SAME rows: the card's ratings in Maranki (the revlog).
 */
export interface CardHistory {
  /** Ratings recorded in Maranki. */
  reviews: number;
  /** How many of these ratings were lapses (see `isLapse`). Never more than `reviews`. */
  lapses: number;
  /** The newest rating, or null when there is none. */
  last: { atMs: number; rating: Rating } | null;
}

/**
 * True when this rating counted as a study of the card (reps + 1): every
 * rating in the 'new' and 'review' buckets (srs.ts applyRating), and a
 * MISSED Check (Again or Hard: the card starts Learning). A passed Check
 * (Good or Easy) only records the check; the card's reps do not change.
 */
function raisesReps(row: RevlogRow): boolean {
  return row.bucket !== 'check' || row.rating === 'again' || row.rating === 'hard';
}

/**
 * Was this rating a LAPSE — the learner forgot a card they had learned? The
 * same rule as the scheduler (srs.ts, reducer.ts rateByBucket):
 *   - a missed Check (Again or Hard on a Known card) of a card that was
 *     studied before (the reducer: `card.reps > 0`). The history has no
 *     column for reps, so "studied before" is: it had an interval
 *     (`ivlBefore > 0`), OR an earlier Maranki rating of this card raised
 *     its reps (`studied`, see raisesReps). Example: rated once (still in
 *     Learning, interval 0), then marked Known, then the Check is missed →
 *     a lapse. A card marked Known before it was ever studied is not;
 *   - Again on a studied card that had an interval (`ivlBefore > 0`: it had
 *     graduated at least once). A fresh card in its first learning steps has
 *     no interval yet, so its Again is not a lapse.
 * The history has no column for the learning step. A lapse lowers the ease
 * (by 0.2) or, when the ease is already at its floor, the interval, but an
 * Again DURING relearning changes neither. So an Again that lowered nothing
 * compared with the card's previous rating (`prev`) is relearning, not a
 * new lapse.
 * The FIRST Maranki rating of a card has no `prev`, so the ease before it
 * is not known: then only a lowered interval (`ivlAfter < ivlBefore`) shows
 * a lapse. Example: a card imported from Anki in RELEARNING (Anki type 3:
 * `stepIndex 0` and its interval, spec §5.5) is rated Again → the scheduler
 * keeps its interval and counts no lapse (srs.ts), so this is no lapse
 * either: { ivlBefore: 5, ivlAfter: 5 } → 0 lapses; { ivlBefore: 10,
 * ivlAfter: 5 } → 1 lapse.
 * (A lapse that lowers no interval — an interval of 1 day, or a lapse
 * multiplier of 1 or more — is seen only through the ease, so it is not
 * counted on a first row, nor at the ease floor: rare. And a reset of the
 * card's progress is not in the history: a missed Check right after a reset
 * can count here although the card itself was not studied since.)
 */
function isLapse(row: RevlogRow, prev: RevlogRow | null, studied: boolean): boolean {
  if (row.bucket === 'check') return (row.rating === 'again' || row.rating === 'hard') && (row.ivlBefore > 0 || studied);
  if (row.bucket !== 'review' || row.rating !== 'again' || !(row.ivlBefore > 0)) return false;
  const loweredInterval = row.ivlAfter < row.ivlBefore;
  if (!prev) return loweredInterval;
  return row.easeAfter < prev.easeAfter || loweredInterval;
}

/**
 * The summary of one card's history rows (pure): how many ratings, how many
 * of them were lapses (isLapse), and the newest one. The lapses are counted
 * from these rows, NOT from `card.lapses`: that field also counts the lapses
 * of the card's Anki past, and "2 reviews · 9 lapses" would mix two sources.
 */
export function summarizeCardHistory(rows: readonly RevlogRow[]): CardHistory {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  let lapses = 0;
  // True once an earlier row of this card raised its reps (see isLapse).
  let studied = false;
  ordered.forEach((row, i) => {
    if (isLapse(row, i > 0 ? ordered[i - 1] : null, studied)) lapses += 1;
    if (raisesReps(row)) studied = true;
  });
  const last = ordered[ordered.length - 1];
  return { reviews: ordered.length, lapses, last: last ? { atMs: last.atMs, rating: last.rating } : null };
}

/**
 * One card's history, read from the review history (the app's by default).
 * Spec §3.8 `cardHistory(cardId)`. The card itself may be passed instead of
 * its id (the CardSheet has it); only its id is read.
 *
 *   await cardHistory(card.id);   // { reviews: 7, lapses: 1, last: { atMs, rating: 'good' } }
 */
export async function cardHistory(card: string | Pick<Card, 'id'>, store: RevlogStore = appRevlogStore()): Promise<CardHistory> {
  return summarizeCardHistory(await store.forCard(typeof card === 'string' ? card : card.id));
}

/** The rating words as the rating buttons show them. */
const RATING_LABEL: Record<Rating, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

/** "today", "yesterday" or "{n} days ago", by local calendar days. */
export function daysAgo(atMs: number, now: number): string {
  const start = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.max(0, Math.round((start(now) - start(atMs)) / DAY));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * The CardSheet line (spec §8.4), or null when the card has no rating in
 * Maranki yet (the sheet then shows no History line):
 *   "History: 7 reviews · 1 lapse · last: 3 days ago (Good)"
 */
export function cardHistoryLine(history: CardHistory, now: number): string | null {
  if (history.reviews === 0 || history.last === null) return null;
  const parts = [plural(history.reviews, 'review'), plural(history.lapses, 'lapse')];
  const label = RATING_LABEL[history.last.rating] ?? String(history.last.rating);
  parts.push(`last: ${daysAgo(history.last.atMs, now)} (${label})`);
  return `History: ${parts.join(' · ')}`;
}
