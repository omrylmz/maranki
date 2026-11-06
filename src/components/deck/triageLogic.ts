/**
 * "Choose what to learn" — the triage run (spec §8.5, unit W4-3). PURE: no
 * React, no store, no clock. The triage screen (src/app/triage.tsx) keeps a
 * `TriageRun` in its state and calls the store's commands itself
 * (`learn`, `markKnown`, `undoManualEdit`); this file only decides WHICH
 * cards a choice changes and what the run looks like after it.
 *
 *   ×   Choose what to learn · Level A2                     34 / 520   ← positionLabel
 *   ┌──────────────────────────────────────────┐
 *   │                die Reise                  │
 *   └──────────────────────────────────────────┘
 *        [ I know it ]     [ Later ]     [ Learn ]                   ← choose()
 *   12 to learn · 20 known · 2 later                     Undo        ← runLine, undoStep
 *   Learn all 486 left  ·  Mark all 486 known                        ← chooseAll()
 *
 * The run works per ITEM (a note), never per card (spec §8.5): one choice
 * applies to every Not started card of the note in an ENABLED direction
 * (`triageItems`). So "Learn" on "die Reise" puts both "German → English" and
 * "English → German" in the queue. (The CardSheet can still change one
 * direction alone.)
 *
 * The choices:
 *   Learn      → `learn(cardIds)`: Not started → New, in deck order;
 *   I know it  → `markKnown(cardIds)`: the cards are Known (a few come back
 *                once for a Check);
 *   Later      → nothing is written: the item moves to the END of this run
 *                and stays Not started.
 * When only Later items are left, the run is done (`isDone`): the end screen
 * says how many wait, and "Show the later ones" (`againLater`) goes through
 * them once more.
 *
 * Undo (`undoStep`) takes back the LAST step of the run: the item comes back
 * to the front, the counters go back, and the screen calls
 * `undoManualEdit(editId)` for a step that wrote something. Undo is offered
 * only while the store can take that edit back (`canUndoLast`), so the run
 * and the store never disagree.
 *
 * ONE COUNTING LANGUAGE (walkthrough M6, glossary §1.2 "{n} items"). The
 * whole "choose" flow — the deck page's "Choose what to learn" block, its
 * buttons, a "By level" row's "Learn all" / "Mark all as known", "Where do
 * you start?" and this screen — counts ITEMS (notes): "0 / 6", "Learn all 6
 * left", "Add the next 6 in order". The deck page's snackbars use `stepSnack`
 * too (deckPageLogic.ts `rowMenuSnack`, `placementSnack`), so the same
 * choice reads the same on both screens. When an item has more than one card (two
 * directions), a number of CARDS always says its items too: "12 cards (6
 * items)" (`cardsAndItems`), the counter says "0 / 6 items", and the bulk
 * buttons say "Learn all 6 items left" (`bulkLabels`, like the deck page's
 * "Learn all 6 items"). So "12 cards are not started yet" never stands next
 * to "Add the next 6" without saying why the numbers differ. When every item
 * is one card, both numbers are the same and the plain words of spec §8.5
 * stay ("6 cards", "0 / 6", "Learn all 6 left"). The run line ("1 to learn ·
 * 1 known") has no noun: the counter above it names the unit. The screen
 * draws the counter's unit UNDER its numbers (`positionParts`, wave 5c), so
 * the counter never takes the title's room on a narrow phone. The Library's
 * "Choose ({n})" counts these same items (libraryState chooseCount).
 */
import { life } from '../../domain/life';
import type { Card, Deck, Id } from '../../domain/model';
import { plural } from '../../domain/text';
import { DEFAULT_SRS } from '../../domain/types';

/* ------------------------------------------------------------------ items */

/** One thing to decide: a note and its Not started cards in enabled directions. */
export interface TriageItem {
  noteId: Id;
  deckId: Id;
  /** The cards a choice changes, in direction order. Never empty. */
  cardIds: Id[];
  /** The card the run shows for the item (the first card of the note in the run's order). */
  shownCardId: Id;
}

/** What `triageItems` needs to know about the library (the store's cached lookups fit). */
export interface TriageLookup {
  cardById: ReadonlyMap<Id, Card>;
  cardIdsByNote: ReadonlyMap<Id, readonly Id[]>;
  decks: ReadonlyMap<Id, Deck>;
  /** The card type of a note (for the deck's directions). */
  typeIdOf: (noteId: Id) => Id | undefined;
}

/**
 * Is direction `ord` of card type `typeId` on in this deck (spec §3.4
 * `DeckOptions.directions`)? The same rule as the scheduler (schedule.ts):
 * no list for the card type = every direction that has cards is on.
 *
 *   directionOn(deck with directions { 'nt-1': [0] }, 'nt-1', 1) → false
 *   directionOn(deck without directions, 'nt-1', 1)            → true
 */
export function directionOn(deck: Pick<Deck, 'options'> | undefined, typeId: Id | undefined, ord: number): boolean {
  const directions = deck?.options?.directions;
  if (!directions || typeof directions !== 'object' || typeId === undefined) return true;
  if (!Object.prototype.hasOwnProperty.call(directions, typeId)) return true;
  const ords: unknown = directions[typeId];
  return Array.isArray(ords) ? ords.includes(ord) : true;
}

/**
 * The items of a run, in the order of `pool` (the scope's cards, already
 * sorted: deck order, or the Library's sort). One item per note that has at
 * least one Not started card in an enabled direction. A note's other Not
 * started cards come along (all its enabled directions), also when the pool
 * holds only one of them (a Direction chip in the Library).
 *
 * A card of a paused deck counts too: choosing what to learn is not studying.
 */
export function triageItems(pool: readonly Card[], lookup: TriageLookup): TriageItem[] {
  const seen = new Set<Id>();
  const out: TriageItem[] = [];
  for (const card of pool) {
    if (seen.has(card.noteId) || life(card) !== 'notStarted') continue;
    const deck = lookup.decks.get(card.deckId);
    const typeId = lookup.typeIdOf(card.noteId);
    if (!deck || !directionOn(deck, typeId, card.ord)) continue;
    seen.add(card.noteId);
    const siblings: Card[] = [];
    for (const id of lookup.cardIdsByNote.get(card.noteId) ?? [card.id]) {
      const sib = lookup.cardById.get(id);
      if (!sib || sib.deckId !== card.deckId || life(sib) !== 'notStarted') continue;
      if (!directionOn(deck, typeId, sib.ord)) continue;
      siblings.push(sib);
    }
    if (siblings.length === 0) siblings.push(card);
    siblings.sort((a, b) => a.ord - b.ord);
    out.push({ noteId: card.noteId, deckId: card.deckId, cardIds: siblings.map((c) => c.id), shownCardId: card.id });
  }
  return out;
}

/** The card ids of some items, in item order. */
export function cardIdsOf(items: readonly TriageItem[]): Id[] {
  return items.flatMap((item) => item.cardIds);
}

/**
 * A number of cards with its number of items, for the "choose" flow (see the
 * file header). The items are said only when they differ from the cards.
 *
 *   cardsAndItems(12, 6) → '12 cards (6 items)'
 *   cardsAndItems(2, 1)  → '2 cards (1 item)'
 *   cardsAndItems(6, 6)  → '6 cards'
 *   cardsAndItems(1, 1)  → '1 card'
 */
export function cardsAndItems(cards: number, items: number): string {
  const text = plural(cards, 'card');
  return cards === items ? text : `${text} (${plural(items, 'item')})`;
}

/* -------------------------------------------------------------------- run */

export type TriageChoice = 'learn' | 'known' | 'later';

/** What one step did (for the counters and for Undo). */
export type TriageStepKind = TriageChoice | 'learnAll' | 'knownAll' | 'place';

/** The counters of a run. Items are notes; cards are what the store changed. */
export interface TriageCounts {
  /** Items put into the queue. */
  learn: number;
  /** Items marked Known. */
  known: number;
  /** Cards put into the queue ("Done — {n} cards added to your queue."). */
  learnCards: number;
  /** Cards marked Known. */
  knownCards: number;
  /** Items left Not started by "Where do you start?" ("Leave them not started"). */
  skipped: number;
}

/** One step of the run. `editId` is the ManualEdit the store made ('' or null: nothing written). */
export interface TriageStep {
  kind: TriageStepKind;
  noteIds: Id[];
  editId: string | null;
  queueBefore: readonly Id[];
  laterBefore: readonly Id[];
  countsBefore: TriageCounts;
}

export interface TriageRun {
  /** Every item of the run, by note id. */
  items: ReadonlyMap<Id, TriageItem>;
  /** The number of items the run started with ("… / 520"). */
  total: number;
  /**
   * The number of cards of those items. When it differs from `total` (items
   * with two directions), the counter names its unit: "34 / 520 items".
   */
  cards: number;
  /** The note ids still to decide, in order. "Later" moves one to the end. */
  queue: readonly Id[];
  /** The items in the queue that were put off with "Later" in this pass. */
  later: readonly Id[];
  counts: TriageCounts;
  history: readonly TriageStep[];
}

const ZERO: TriageCounts = Object.freeze({ learn: 0, known: 0, learnCards: 0, knownCards: 0, skipped: 0 });

/** A new run over these items (the screen builds them ONCE, when it opens). */
export function startRun(items: readonly TriageItem[]): TriageRun {
  const map = new Map<Id, TriageItem>();
  const queue: Id[] = [];
  let cards = 0;
  for (const item of items) {
    if (map.has(item.noteId)) continue;
    map.set(item.noteId, item);
    queue.push(item.noteId);
    cards += item.cardIds.length;
  }
  return { items: map, total: queue.length, cards, queue, later: [], counts: ZERO, history: [] };
}

/** True when the run has nothing to show: no item left, or only items put off with "Later". */
export function isDone(run: TriageRun): boolean {
  if (run.queue.length === 0) return true;
  const later = new Set(run.later);
  return run.queue.every((id) => later.has(id));
}

/** The item on the card now, or null when the run is done. */
export function currentItem(run: TriageRun): TriageItem | null {
  if (isDone(run)) return null;
  return run.items.get(run.queue[0]) ?? null;
}

/** The items still in the queue (Later ones too), in order. */
export function leftItems(run: TriageRun): TriageItem[] {
  const out: TriageItem[] = [];
  for (const id of run.queue) {
    const item = run.items.get(id);
    if (item) out.push(item);
  }
  return out;
}

/** The step record for a change of `run`. */
function stepOf(run: TriageRun, kind: TriageStepKind, noteIds: Id[], editId: string | null): TriageStep {
  return { kind, noteIds, editId: editId || null, queueBefore: run.queue, laterBefore: run.later, countsBefore: run.counts };
}

/** The number of cards of some notes of the run. */
function cardCount(run: TriageRun, noteIds: readonly Id[]): number {
  let n = 0;
  for (const id of noteIds) n += run.items.get(id)?.cardIds.length ?? 0;
  return n;
}

/** The counters after learning or marking Known some items. */
function counted(counts: TriageCounts, how: 'learn' | 'known', items: number, cards: number): TriageCounts {
  return how === 'learn'
    ? { ...counts, learn: counts.learn + items, learnCards: counts.learnCards + cards }
    : { ...counts, known: counts.known + items, knownCards: counts.knownCards + cards };
}

/**
 * The run after a choice on the CURRENT item (the screen first calls the
 * store: `learn` / `markKnown` for its cardIds, and passes the edit id).
 * A done run does not change.
 */
export function choose(run: TriageRun, choice: TriageChoice, editId: string | null = null): TriageRun {
  const item = currentItem(run);
  if (!item) return run;
  const step = stepOf(run, choice, [item.noteId], choice === 'later' ? null : editId);
  const rest = run.queue.slice(1);
  if (choice === 'later') {
    const later = run.later.includes(item.noteId) ? run.later : [...run.later, item.noteId];
    return { ...run, queue: [...rest, item.noteId], later, history: [...run.history, step] };
  }
  return {
    ...run,
    queue: rest,
    later: run.later.filter((id) => id !== item.noteId),
    counts: counted(run.counts, choice, 1, item.cardIds.length),
    history: [...run.history, step],
  };
}

/**
 * "Learn all {n} left" / "Mark all {n} known": every item still in the
 * queue (Later ones too). The run is done after it.
 */
export function chooseAll(run: TriageRun, kind: 'learnAll' | 'knownAll', editId: string | null): TriageRun {
  if (run.queue.length === 0) return run;
  const noteIds = [...run.queue];
  const step = stepOf(run, kind, noteIds, editId);
  return {
    ...run,
    queue: [],
    later: [],
    counts: counted(run.counts, kind === 'learnAll' ? 'learn' : 'known', noteIds.length, cardCount(run, noteIds)),
    history: [...run.history, step],
  };
}

/**
 * "Where do you start?" in the run: the items of the easier levels
 * (`noteIds`) leave the run. `below` = 'known' → the screen marked their cards
 * Known (counted as known); 'notStarted' → nothing was written, they stay Not
 * started (counted as skipped). The other items keep their order.
 */
export function place(run: TriageRun, noteIds: readonly Id[], below: 'known' | 'notStarted', editId: string | null): TriageRun {
  const gone = new Set(noteIds.filter((id) => run.queue.includes(id)));
  if (gone.size === 0) return run;
  const ids = run.queue.filter((id) => gone.has(id));
  const step = stepOf(run, 'place', ids, below === 'known' ? editId : null);
  const counts =
    below === 'known'
      ? counted(run.counts, 'known', ids.length, cardCount(run, ids))
      : { ...run.counts, skipped: run.counts.skipped + ids.length };
  return {
    ...run,
    queue: run.queue.filter((id) => !gone.has(id)),
    later: run.later.filter((id) => !gone.has(id)),
    counts,
    history: [...run.history, step],
  };
}

/** "Show the later ones": the items put off with Later come back for one more pass. */
export function againLater(run: TriageRun): TriageRun {
  return run.later.length === 0 ? run : { ...run, later: [] };
}

/**
 * Can Undo take back the last step? The run may go back only when the store
 * goes back too — otherwise the run would show the items as undecided while
 * their cards stay New (or Known), with no message.
 *   - a step that wrote nothing ("Later", "Leave them not started"): yes;
 *   - a step that wrote an edit: only while that edit is still in the store's
 *     `manualLog` (`isStored`, rescheduleLogic.ts `isUndoableEdit`). It is
 *     not there when it alone was larger than the log can keep (more than
 *     MANUAL_LOG_MAX_SNAPSHOTS = 20,000 cards, for example "Learn all 12,000
 *     left" over two directions), or when 50 newer edits pushed it out.
 * The screen shows Undo only when this is true (manualLog.ts EditResult:
 * "the UI just shows no Undo button").
 *
 *   last step 'learnAll', its edit not in manualLog → false
 */
export function canUndoLast(run: TriageRun, isStored: (editId: string) => boolean): boolean {
  const last = run.history[run.history.length - 1];
  if (!last) return false;
  return last.editId === null || isStored(last.editId);
}

/**
 * Undo the last step: the queue, the Later list and the counters as they
 * were. `editId` is the store edit to take back (null: the step wrote
 * nothing, like "Later"). null when there is nothing to undo. Check
 * `canUndoLast` first: this function only knows the run, not the store.
 */
export function undoStep(run: TriageRun): { run: TriageRun; editId: string | null; kind: TriageStepKind } | null {
  const last = run.history[run.history.length - 1];
  if (!last) return null;
  return {
    run: { ...run, queue: last.queueBefore, later: last.laterBefore, counts: last.countsBefore, history: run.history.slice(0, -1) },
    editId: last.editId,
    kind: last.kind,
  };
}

/** True once the learner chose something in this run (placement is offered only before that). */
export function hasChosen(run: TriageRun): boolean {
  return run.history.length > 0;
}

/* ------------------------------------------------------------------- copy */

/** How many items were handled (decided or put off): the "34" of "34 / 520". */
export function handledCount(run: TriageRun): number {
  const later = new Set(run.later);
  let laterInQueue = 0;
  for (const id of run.queue) if (later.has(id)) laterInQueue += 1;
  return run.total - run.queue.length + laterInQueue;
}

/**
 * "34 / 520" (handled items / all items). When the items hold more cards than
 * there are items (two directions), it names the unit, so it matches the deck
 * page's "1,040 cards (520 items) are not started yet.":
 *
 *   one card per item   → '34 / 520'
 *   two cards per item  → '34 / 520 items'
 */
export function positionLabel(run: TriageRun): string {
  const { count, unit } = positionParts(run);
  return unit === null ? count : `${count} ${unit}`;
}

/** The counter of the triage bar in two parts (positionParts). */
export interface PositionParts {
  /** The numbers: "34 / 520". */
  count: string;
  /** The unit under the numbers, "items" ("item" for one), or null when every item is one card. */
  unit: string | null;
  /** What a screen reader says: "34 of 520 items" (or "34 of 520"). */
  a11y: string;
}

/**
 * The counter of positionLabel, split for the screen's top bar (wave 5c).
 * WHY: the counter sits next to the title "Choose what to learn" in the
 * StackBar, and the title gets only the room the counter leaves. On one line,
 * "1,234 / 8,970 items" (about 148 pt) cut the title to "Choose what to…" on
 * a 360 pt phone. So the screen draws the numbers on one line and the unit
 * in small type UNDER them: the counter is only as wide as its numbers.
 *
 *   one card per item   → { count: '34 / 520', unit: null,    a11y: '34 of 520' }
 *   two cards per item  → { count: '34 / 520', unit: 'items', a11y: '34 of 520 items' }
 */
export function positionParts(run: TriageRun): PositionParts {
  const handled = handledCount(run).toLocaleString('en-US');
  const total = run.total.toLocaleString('en-US');
  const count = `${handled} / ${total}`;
  if (run.cards === run.total) return { count, unit: null, a11y: `${handled} of ${total}` };
  // plural() says "1 item" / "520 items"; the unit is its word.
  const items = plural(run.total, 'item');
  return { count, unit: items.slice(total.length + 1), a11y: `${handled} of ${items}` };
}

/** "12 to learn · 20 known · 2 later" (items). Empty parts are left out; '' before the first choice. */
export function runLine(run: TriageRun): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const parts: string[] = [];
  if (run.counts.learn > 0) parts.push(`${n(run.counts.learn)} to learn`);
  if (run.counts.known > 0) parts.push(`${n(run.counts.known)} known`);
  if (run.later.length > 0) parts.push(`${n(run.later.length)} later`);
  return parts.join(' · ');
}

/**
 * The bulk buttons: "Learn all 486 left" and "Mark all 486 known" (items
 * left, Later ones too). When the run's items hold more cards than there are
 * items (two directions), the buttons name the unit, like the counter
 * ("0 / 486 items") and the deck page's row menu ("Learn all 486 items",
 * deckPageLogic.ts `rowMenuLabels`), so the same choice reads the same on
 * both screens (walkthrough M6):
 *
 *   one card per item  → 'Learn all 486 left',       'Mark all 486 known'
 *   two cards per item → 'Learn all 486 items left', 'Mark all 486 items known'
 */
export function bulkLabels(run: TriageRun): { learn: string; known: string } | null {
  const left = run.queue.length;
  if (left === 0) return null;
  const n = run.cards === run.total ? left.toLocaleString('en-US') : plural(left, 'item');
  return { learn: `Learn all ${n} left`, known: `Mark all ${n} known` };
}

/** The words of the screen (spec §8.5, exact). */
export const TRIAGE_COPY = {
  title: 'Choose what to learn',
  know: 'I know it',
  later: 'Later',
  learn: 'Learn',
  undo: 'Undo',
  undoGone: 'This can no longer be undone',
  empty: 'Nothing left to choose here.',
  studyNow: 'Study now',
  backToDeck: 'Back to deck',
  backLabel: 'Back',
  againLater: 'Show the later ones',
  placement: 'Where do you start?',
  swipeLearn: 'Learn',
  swipeKnow: 'I know it',
} as const;

/**
 * The end of the run: the title and the lines under it (spec §8.5).
 * "They come in {n} a day" is said only when n is a real number above 0: a
 * deck that gets 0 new cards a day would promise nothing ("They come in 0 a
 * day"), and a broken number must never show as "NaN".
 *
 * The card numbers say their items when they differ (`cardsAndItems`): after
 * "Learn all 6 left" the title is "Done — 12 cards (6 items) added to your
 * queue.", so the 6 the learner tapped is on the screen too.
 */
export function doneCopy(
  run: TriageRun,
  opts: { perDay: number; random: boolean },
): { title: string; lines: string[] } {
  const { counts } = run;
  const title = `Done — ${cardsAndItems(counts.learnCards, counts.learn)} added to your queue.`;
  const lines: string[] = [];
  if (counts.learnCards > 0 && Number.isFinite(opts.perDay) && opts.perDay > 0) {
    const order = opts.random ? 'in random order' : 'in deck order';
    lines.push(`They come in ${Math.floor(opts.perDay).toLocaleString('en-US')} a day, ${order}.`);
  }
  if (counts.knownCards > 0) lines.push(`${cardsAndItems(counts.knownCards, counts.known)} marked as known.`);
  const later = run.queue.length;
  if (later > 0) {
    lines.push(
      later === 1
        ? '1 item left for later — it stays Not started.'
        : `${plural(later, 'item')} left for later — they stay Not started.`,
    );
  }
  return { title, lines };
}

/**
 * The snackbar after a step: "12 cards (6 items) added to your queue", "2
 * cards marked as known", "Put off for later". `items` = the items of those
 * cards (said only when it differs, `cardsAndItems`). The screen adds the
 * Undo action.
 */
export function stepSnack(kind: TriageStepKind, cards: number, items: number = cards): string {
  switch (kind) {
    case 'learn':
    case 'learnAll':
      return `${cardsAndItems(cards, items)} added to your queue`;
    case 'known':
    case 'knownAll':
    case 'place':
      return `${cardsAndItems(cards, items)} marked as known`;
    case 'later':
      return 'Put off for later';
  }
}

/**
 * The daily new-card limit as a safe number (the ONE guard of the deck page
 * and the triage screen; deckPageLogic.ts uses it too). A broken saved value
 * (NaN, Infinity, missing — old data) uses the default limit, like the
 * scheduler (schedule.ts `remaining`): never NaN, and never 0, which would
 * hide every new card.
 *
 *   safeDailyNewLimit(12.7)      → 12
 *   safeDailyNewLimit(Number.NaN) → 10 (DEFAULT_SRS.dailyNewLimit)
 */
export function safeDailyNewLimit(dailyNewLimit: number | null | undefined): number {
  return typeof dailyNewLimit === 'number' && Number.isFinite(dailyNewLimit)
    ? Math.max(0, Math.floor(dailyNewLimit))
    : DEFAULT_SRS.dailyNewLimit;
}

/**
 * The per-day number of "They come in {10} a day": the deck's own cap when
 * one deck is chosen (never above the daily limit), else the daily limit.
 * A broken daily limit uses the default (`safeDailyNewLimit`), so the line
 * never says "NaN"; a result of 0 makes `doneCopy` leave the line out.
 */
export function newPerDayOf(decks: readonly Pick<Deck, 'options'>[], dailyNewLimit: number): number {
  const global = safeDailyNewLimit(dailyNewLimit);
  if (decks.length !== 1) return global;
  const own = decks[0].options?.newPerDay;
  return typeof own === 'number' && Number.isFinite(own) ? Math.min(Math.max(0, Math.floor(own)), global) : global;
}
