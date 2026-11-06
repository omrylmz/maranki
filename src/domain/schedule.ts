/**
 * The ONE scheduler (spec §4.5): a pure function that decides what Study
 * shows. Every "Study N" button and every session use it, so the number on
 * the button is ALWAYS the length of the session it opens:
 *
 *   const sel = selectScheduled(pool, ctx);
 *   readyCounts(sel).total === planQueue(sel).length   // by construction
 *
 * The queue is made of four buckets, in this order:
 *
 *   1. learn   — Learning cards that are due now. Never capped by a daily limit.
 *   2. reviews — Review/Mastered cards that are due now, one per note, and
 *                (spaceSiblings on) none whose sibling was studied today
 *                (review-sibling rule), capped by the daily review limit.
 *   3. checks  — a ~10% sample of Known cards, each checked once, 21–90 days
 *                after "I know it", one per note and none whose note is
 *                already in this run, and (spaceSiblings on) none whose
 *                sibling was studied today or is in learning (check-sibling
 *                rule), capped by "Known-card checks per day".
 *   4. fresh   — New cards, round robin over decks (so no deck starves),
 *                per-deck and global new-card caps, new-sibling rule.
 *
 * Then the session size (settings.sessionLimit, 0 = no cap) cuts the
 * concatenation from the end. The session size applies to EVERY kind:
 * scheduled (here), study ahead (selectAhead) and practice (selectPractice).
 *
 * What the caller passes (scope.ts, W3-4):
 *   - `pool`: the cards of the scope that are `studyEligible` (for practice:
 *     every card of the scope). The scheduler checks again what it can check
 *     without the scope query (deck exists, direction enabled, not suspended,
 *     not buried), so a careless caller can never put a hidden card into a
 *     session. A paused deck it can NOT check: whether a paused deck is
 *     allowed depends on the query (`explicitDecks`), so `studyEligible` does it.
 *   - `ctx` (ScheduleCtx, src/domain/model.ts): now, decks, today's tallies,
 *     settings, and a sibling lookup over ALL cards.
 *
 * Pure: no React, no clock (the caller passes `now`), no Math.random() —
 * "random" new-card order and the Check sample come from a stable hash
 * (./hash.ts), so the same state always gives the same queue.
 */
import { fnv1a } from './hash';
import { hasReviewDate, isBuried, life } from './life';
import type {
  Card,
  DayDone,
  Deck,
  Id,
  ReadyCounts,
  ScheduleCtx,
  Selection,
  SortSpec,
} from './model';
import { DAY, dayKeyOf, DEFAULT_SRS } from './types';

export type { ReadyCounts, ScheduleCtx, Selection };

/**
 * What the ONE sort rule reads of a ScheduleCtx: the decks (Deck order) and
 * the A–Z / field key (`sortKey`). A whole ScheduleCtx fits. Unit P4: the
 * Library's shared warm-up (store/libraryWarmup.ts) makes the library's
 * Deck order ahead of time with only these two — it has no tallies or
 * settings, and a sort never reads them.
 */
export type SortCtx = Pick<ScheduleCtx, 'decks' | 'sortKey'>;

/** The honest time estimate: about 23 seconds per card. */
const SECONDS_PER_CARD = 23;

/** One Known card in CHECK_SAMPLE gets a Check (hash % 10 === 0 → about 10%). */
const CHECK_SAMPLE = 10;
/** The earliest day after "I know it" on which a Check can come. */
const CHECK_SPREAD_MIN_DAYS = 21;
/** How many different days the Checks are spread over: 21 … 90. */
const CHECK_SPREAD_RANGE_DAYS = 70;
/**
 * The default of settings.knownChecksPerDay (spec §3.5). Used only when the
 * saved value is missing or broken (see `remaining`).
 */
const DEFAULT_KNOWN_CHECKS_PER_DAY = 5;

/* ------------------------------------------------------------------ small helpers */

/** Epoch ms of local midnight at the start of the day of `ms` (the phone's time zone). */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The ONE formula for "about N min" on every Study button:
 * max(1, round(cards × 23 / 60)), and 0 cards → 0 min.
 *
 *   minutesFor(0) → 0    minutesFor(1) → 1    minutesFor(30) → 12
 */
export function minutesFor(cards: number): number {
  if (!(cards > 0)) return 0; // 0, a negative number and NaN all mean "nothing to study"
  return Math.max(1, Math.round((cards * SECONDS_PER_CARD) / 60));
}

/** The session size as a number of cards. 0 (or a broken value) = no cap. */
function sessionCap(sessionLimit: number): number {
  return Number.isFinite(sessionLimit) && sessionLimit > 0 ? Math.floor(sessionLimit) : Infinity;
}

/**
 * What is left of a daily limit: max(0, limit − used).
 *
 * A limit that is not a finite number uses `fallback` instead. Damaged or old
 * saved data can have such a limit: JSON stores NaN and Infinity as null, and
 * an old file can miss the key. The fallback is the DEFAULT limit, never 0,
 * because a limit of 0 hides every card without telling the learner (spec §8.6).
 *
 *   remaining(200, 15, 200)       → 185
 *   remaining(undefined, 15, 200) → 185   (the default limit is used)
 *   remaining(null, 3, Infinity)  → Infinity   (no cap)
 */
function remaining(limit: number | null | undefined, used: number, fallback: number): number {
  const safeLimit = typeof limit === 'number' && Number.isFinite(limit) ? limit : fallback;
  const usedSafe = Number.isFinite(used) && used > 0 ? used : 0;
  return Math.max(0, Math.floor(safeLimit) - usedSafe);
}

/** `record[key]` only when the record really has that key (ids like "constructor" are safe). */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Today's tallies. The caller should pass dayDone rolled over to the day of
 * `now`; a dayDone of another day is read as all zeros (nothing done yet).
 */
function todayDone(ctx: ScheduleCtx): DayDone {
  const dayKey = dayKeyOf(ctx.now);
  if (ctx.done.dayKey === dayKey) return ctx.done;
  return { dayKey, reviews: 0, neww: 0, checks: 0, newByDeck: {} };
}

/** Sort helper: compare two ids as plain strings (stable, no locale). */
function compareIds(a: Id, b: Id): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Does the card have a real due time? Damaged saved data can hold `null` or
 * NaN in `due` (JSON saves NaN as null). Such a card is never due — not now
 * and not later — because in JavaScript `null <= now` is TRUE, so a null due
 * would count as "due now" and a NaN due would not. (On load, sanitize repairs
 * a broken due; this keeps the scheduler honest if one still gets here.)
 */
function hasDueTime(card: Card): boolean {
  return Number.isFinite(card.due);
}

/** Is the card due at the moment `now` (a real due time, on or before `now`)? */
function isDueBy(card: Card, now: number): boolean {
  return hasDueTime(card) && card.due <= now;
}

/** Soonest `due` first; the same `due` → by id, so the order never depends on the pool order. */
function byDue(a: Card, b: Card): number {
  return a.due - b.due || compareIds(a.id, b.id);
}

/**
 * True for a New, Not started or Known card: it has NO review date yet
 * (life.ts hasReviewDate). Its `due` is only the time it was made or
 * imported, so the Library's "Due date" sort puts it after the cards that
 * have a review date (cardComparator, orderPositions). The scheduler's
 * queues do not use it: they never take such a card by its `due`.
 *
 *   hasNoDueDate(newCard)        → true
 *   hasNoDueDate(learningCard)   → false
 */
function hasNoDueDate(card: Card): boolean {
  return !hasReviewDate(card);
}

/* ------------------------------------------------------------------ eligibility */

/**
 * The options of a deck. Damaged saved data (a hand-edited backup) can lack
 * them; then every option has its "nothing set" meaning: no directions map,
 * no per-deck new cap, source order, and no Checks (knownChecks is not true).
 * checkIntegrity repairs such a deck on load; this keeps the scheduler from
 * throwing if one still gets here.
 */
function optionsOf(deck: Deck): Partial<Deck['options']> {
  return (deck.options as Deck['options'] | undefined) ?? {};
}

/**
 * Is the card's direction switched on in its deck? `deck.options.directions`
 * maps a card type to its enabled ords. No map, no entry for the card type,
 * or an unknown note (typeIdOf → undefined) = every direction is on.
 *
 * A DAMAGED entry (not a list, for example `1` or `null` from a broken
 * backup) also counts as "no entry": every direction is on. Without this,
 * `ords.includes` would throw, and one bad deck would break every Study
 * count. (checkIntegrity removes such an entry on load.)
 *
 *   directions: { 'nt-basic-reverse': [0] }  → ord 0 on, ord 1 off
 *   directions: { 'nt-basic-reverse': 1 }    → every ord on (damaged entry)
 */
function directionEnabled(card: Card, deck: Deck, ctx: ScheduleCtx): boolean {
  const directions = optionsOf(deck).directions;
  if (typeof directions !== 'object' || directions === null) return true;
  const typeId = ctx.typeIdOf(card);
  if (typeId === undefined) return true;
  const ords: unknown = own(directions, typeId);
  if (!Array.isArray(ords)) return true;
  return ords.includes(card.ord);
}

/**
 * Every eligibility rule that does NOT depend on the scope query: the deck
 * exists, the direction is on, the card is not suspended and not buried.
 * Returns the card's deck, or null when the card cannot be studied now.
 */
function usableDeck(card: Card, ctx: ScheduleCtx): Deck | null {
  const deck = ctx.decks.get(card.deckId);
  if (!deck) return null;
  if (!directionEnabled(card, deck, ctx)) return null;
  if (card.suspended || isBuried(card, ctx.now)) return null;
  return deck;
}

/**
 * Can this card be studied in a Study session (spec §4.5)?
 *   - its deck exists;
 *   - the deck is active, OR the scope names the deck (`explicitDecks`):
 *     a paused deck can still be studied from its own deck page or by a
 *     query that names it;
 *   - its direction is enabled (`deck.options.directions`);
 *   - it is not suspended and not buried.
 * The status (New, Known …) is NOT checked here: the buckets decide that.
 */
export function studyEligible(card: Card, ctx: ScheduleCtx, explicitDecks: ReadonlySet<Id>): boolean {
  const deck = usableDeck(card, ctx);
  if (!deck) return false;
  return deck.active || explicitDecks.has(deck.id);
}

/* ------------------------------------------------------------------ checks (Known cards) */

/**
 * Is this card in the ~10% sample of Known cards that get one Check?
 * `fnv1a(id) % 10 === 0`: stable, so the same card is always in (or out).
 */
export function isCheckSampled(cardId: Id): boolean {
  return fnv1a(cardId) % CHECK_SAMPLE === 0;
}

/**
 * How many days after "I know it" the Check of this card comes: 21 … 90.
 * It uses other bits of the hash than the sample test (`/ 10`), so the
 * sampled cards are spread evenly over the 70 days.
 */
export function spreadDays(cardId: Id): number {
  return CHECK_SPREAD_MIN_DAYS + (Math.floor(fnv1a(cardId) / CHECK_SAMPLE) % CHECK_SPREAD_RANGE_DAYS);
}

/** The moment a Known card's Check becomes ready: knownAt + spreadDays × DAY. Infinity when not Known. */
export function checkReadyAt(card: Card): number {
  if (card.knownAt == null) return Infinity;
  return card.knownAt + spreadDays(card.id) * DAY;
}

/** Is this Known card a Check candidate right now? (The daily cap is applied later.) */
function isCheckDue(card: Card, deck: Deck, now: number): boolean {
  return (
    card.knownAt != null &&
    card.knownCheckedAt == null &&
    optionsOf(deck).knownChecks === true &&
    isCheckSampled(card.id) &&
    checkReadyAt(card) <= now
  );
}

/* ------------------------------------------------------------------ the scheduled selection */

/** The four buckets before the session-size cut. */
interface Buckets {
  learn: Card[];
  reviews: Card[];
  checks: Card[];
  fresh: Card[];
}

/**
 * The scheduled study run for `pool` (spec §4.5). The pool should already be
 * `studyEligible` (see the file header). Returns the buckets AFTER every cap.
 *
 * Example: 3 decks with new cards, daily new limit 10, nothing studied today
 * → fresh = deck1, deck2, deck3, deck1, deck2, … (all three decks get new
 * cards on day 1, the bug "Grammar and Verbs starve behind Vocabulary" is gone).
 */
export function selectScheduled(pool: readonly Card[], ctx: ScheduleCtx): Selection {
  return scheduledRun(pool, ctx).selection;
}

/**
 * selectScheduled, plus `dueNow`: how many cards of the run are DUE now —
 * bucket 1 (learning cards due now) and bucket 2 (due reviews after the
 * review-sibling rule), counted BEFORE the daily review limit and the
 * session size. The deck rows show it as "{n} due" (scope.ts deckStatsMap).
 *
 * WHY from the scheduler and not from life.ts `isDueNow`: "{n} due" must
 * never count a card that Study cannot show. The scheduler leaves out a
 * card with a broken `due` (null or NaN: in JavaScript `null <= now` is
 * true, so `isDueNow` says "due"), and a review whose sibling waits for
 * another day. Counting from the same buckets keeps the label and the
 * session in agreement:
 *
 *   dueNow >= ready.learning + ready.due, and equal when no daily review
 *   limit and no session size cuts the run.
 */
export function selectScheduledWithDue(pool: readonly Card[], ctx: ScheduleCtx): { selection: Selection; dueNow: number } {
  return scheduledRun(pool, ctx);
}

/** The work of selectScheduled (see there); `dueNow` is explained at selectScheduledWithDue. */
function scheduledRun(pool: readonly Card[], ctx: ScheduleCtx): { selection: Selection; dueNow: number } {
  const { now } = ctx;
  const done = todayDone(ctx);

  // One pass: sort every usable card into the candidate list of its bucket.
  // `seen` drops a card that is in the pool twice (no duplicate in a session).
  const seen = new Set<Id>();
  const learnCandidates: Card[] = [];
  const reviewCandidates: Card[] = [];
  const checkCandidates: Card[] = [];
  const newCandidates: Card[] = [];
  for (const card of pool) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const deck = usableDeck(card, ctx);
    if (!deck) continue;
    switch (life(card)) {
      case 'learning':
        if (isDueBy(card, now)) learnCandidates.push(card);
        break;
      case 'review':
      case 'mastered':
        if (isDueBy(card, now)) reviewCandidates.push(card);
        break;
      case 'known':
        // Known cards are never reviews: they only come back as a Check.
        if (isCheckDue(card, deck, now)) checkCandidates.push(card);
        break;
      case 'new':
        newCandidates.push(card);
        break;
      case 'notStarted':
        // Not started cards are never fed: the learner chooses them in triage.
        break;
    }
  }

  // 1. learn: by due. No daily cap, and no sibling rule (learning is exempt).
  const learn = learnCandidates.sort(byDue);

  // 2. reviews: by due, then the review-sibling rule (see reviewSiblingRule),
  //    then the daily cap. The cap comes LAST, so it counts notes, not hidden siblings.
  const dueReviews = reviewSiblingRule(reviewCandidates.sort(byDue), ctx);
  const reviews = dueReviews.slice(
    0,
    remaining(ctx.settings.srs.dailyReviewLimit, done.reviews, DEFAULT_SRS.dailyReviewLimit),
  );

  // 3. checks: the card whose Check became ready first comes first, then the
  //    check-sibling rule (see checkSiblingRule), then the daily cap. The cap
  //    comes LAST, like for reviews, so a Check that waits does not use it.
  const picked = new Set<Id>();
  for (const bucket of [learn, reviews]) for (const card of bucket) picked.add(card.noteId);
  const checks = checkSiblingRule(
    checkCandidates.sort((a, b) => checkReadyAt(a) - checkReadyAt(b) || compareIds(a.id, b.id)),
    ctx,
    picked,
  ).slice(0, remaining(ctx.settings.knownChecksPerDay, done.checks, DEFAULT_KNOWN_CHECKS_PER_DAY));

  // 4. fresh: new cards. Notes already in this run are "picked" for the new-sibling rule.
  for (const card of checks) picked.add(card.noteId);
  const fresh = allocateNew(newCandidates, ctx, done, picked);

  // 5. session size cuts the concatenation from the end.
  return {
    selection: cutToSessionSize({ learn, reviews, checks, fresh }, sessionCap(ctx.settings.sessionLimit)),
    dueNow: learn.length + dueReviews.length,
  };
}

/**
 * The review-sibling rule (spec §4.5), used by Study (bucket 2) and by Study
 * ahead. `sorted` must already be sorted by due, soonest first.
 *
 *   1. Only with settings.spaceSiblings on ("never show both directions of
 *      one item on the same day"): drop a card when ANOTHER card of its note
 *      was studied today. So after the learner rates direction 0, direction 1
 *      waits until tomorrow; it does not come back in the next session today.
 *   2. Always: keep one card per note, the soonest-due one. The other waits.
 *
 * Example (spacing on): a Basic + reverse note, both directions due.
 *   09:00  Study gives direction 0 only (step 2).
 *   09:05  the learner rates direction 0 "Good".
 *   09:15  Study gives nothing for this note (step 1): "all caught up".
 *   next day  Study gives direction 1.
 *
 * Learning is exempt: a learning card is never held back (bucket 1 has no
 * sibling rule), and a sibling IN LEARNING does not hold a review back, even
 * when it was studied today. (A known limit: when direction 0 lapses today,
 * direction 1 can still come today.)
 */
function reviewSiblingRule(sorted: Card[], ctx: ScheduleCtx): Card[] {
  const dayStart = startOfLocalDay(ctx.now);
  const spaceSiblings = ctx.settings.spaceSiblings;
  const notes = new Set<Id>();
  const out: Card[] = [];
  for (const card of sorted) {
    if (notes.has(card.noteId)) continue; // a sooner card of this note is already in
    if (spaceSiblings && siblingStudiedToday(card, ctx, dayStart)) continue;
    notes.add(card.noteId);
    out.push(card);
  }
  return out;
}

/**
 * The check-sibling rule (bucket 3). `sorted` must be in Check order (the
 * Check that became ready first comes first). `inRun` = the notes that
 * already have a card in this run (learn and reviews); it is not changed.
 *
 * A Check is never urgent: a Known card that waits one more day loses
 * nothing. So Checks follow the STRICTEST sibling rules:
 *   1. Always: one card per note in the whole run. A Check waits when a card
 *      of its note is already in this run (in learn, in reviews, or an
 *      earlier Check). If the learner has just seen the other direction, the
 *      Check would not test anything.
 *   2. Only with settings.spaceSiblings on ("never show both directions of
 *      one item on the same day"): a Check also waits when another card of
 *      its note was studied today, or is in learning now (see siblingBusy —
 *      the same test as for new cards).
 *
 * Example (spacing on), a Basic + reverse note whose direction 1 is Known
 * and ready for its Check:
 *   direction 0 is a due review        → the review comes, the Check waits (rule 1)
 *   direction 0 was reviewed at 08:00  → no Check today (rule 2)
 *   direction 0 is Known and ready too → one Check today, the other on another day (rule 1)
 */
function checkSiblingRule(sorted: Card[], ctx: ScheduleCtx, inRun: ReadonlySet<Id>): Card[] {
  const dayStart = startOfLocalDay(ctx.now);
  const notes = new Set(inRun);
  const out: Card[] = [];
  for (const card of sorted) {
    if (notes.has(card.noteId)) continue; // rule 1
    if (ctx.settings.spaceSiblings && siblingBusy(card, ctx, dayStart)) continue; // rule 2
    notes.add(card.noteId);
    out.push(card);
  }
  return out;
}

/**
 * Was this card studied today (on or after `dayStart`, local midnight)? A
 * rating sets `lastReviewedAt`; a PASSED Check sets only `knownCheckedAt`
 * (reducer.ts rateByBucket: a Known card keeps its schedule). Both count:
 * after a passed Check the other direction must wait for another day too
 * (settings.spaceSiblings, final review).
 */
function studiedToday(card: Card, dayStart: number): boolean {
  if (card.lastReviewedAt != null && card.lastReviewedAt >= dayStart) return true;
  return card.knownCheckedAt != null && card.knownCheckedAt >= dayStart;
}

/**
 * Is ANOTHER card of this card's note busy today: studied today
 * (studiedToday: a rating or a passed Check on or after local midnight), or
 * in learning now? Used by
 * the new-sibling rule (bucket 4) and the check-sibling rule (bucket 3).
 *
 * A learning sibling that can never come back (suspended, its direction is
 * off, or its due is broken) does not count, or this card would wait
 * forever (see canComeBack). The lookup covers
 * ALL cards, not only the pool, so a sibling from another scope counts too.
 */
function siblingBusy(card: Card, ctx: ScheduleCtx, dayStart: number): boolean {
  for (const id of ctx.lookup.cardIdsByNote.get(card.noteId) ?? []) {
    if (id === card.id) continue;
    const sib = ctx.lookup.cardById.get(id);
    if (!sib) continue;
    if (studiedToday(sib, dayStart)) return true; // studied today
    if (life(sib) === 'learning' && canComeBack(sib, ctx)) return true; // in learning now
  }
  return false;
}

/**
 * Was ANOTHER card of this card's note studied today (studiedToday: a rating
 * or a passed Check on or after local midnight)? A sibling in learning does
 * not count (see reviewSiblingRule). The lookup covers ALL cards, not only
 * the pool, so a sibling studied from another scope counts too.
 */
function siblingStudiedToday(card: Card, ctx: ScheduleCtx, dayStart: number): boolean {
  for (const id of ctx.lookup.cardIdsByNote.get(card.noteId) ?? []) {
    if (id === card.id) continue;
    const sib = ctx.lookup.cardById.get(id);
    if (!sib || life(sib) === 'learning') continue;
    if (studiedToday(sib, dayStart)) return true;
  }
  return false;
}

/**
 * New cards for today (spec §4.5 bucket 4, "allocateNew").
 *
 *   - Lanes: one per deck, in `deck.order`. Inside a lane the cards are sorted
 *     by the deck's `newOrder`: 'source' = newPos, then ord, then id;
 *     'random' = fnv1a(id + dayKey) (a new stable order every day).
 *   - Each lane has its own cap: `newPerDay − done.newByDeck[deck]`
 *     (newPerDay null = no per-deck cap).
 *   - Round robin: take ONE card from each lane in turn, while the global
 *     `dailyNewLimit − done.neww` is above 0.
 *   - New-sibling rule (when settings.spaceSiblings is on): skip a card when
 *     a sibling was studied today, is in learning now, or is already picked
 *     in this run. So at most one card per note per day.
 *
 * `picked` holds the note ids already in this run; it is updated here.
 */
function allocateNew(candidates: Card[], ctx: ScheduleCtx, done: DayDone, picked: Set<Id>): Card[] {
  let globalLeft = remaining(ctx.settings.srs.dailyNewLimit, done.neww, DEFAULT_SRS.dailyNewLimit);
  if (globalLeft === 0 || candidates.length === 0) return [];

  const dayKey = dayKeyOf(ctx.now);
  const dayStart = startOfLocalDay(ctx.now);
  const spaceSiblings = ctx.settings.spaceSiblings;

  // Group the candidates by deck. (Every candidate has a deck: usableDeck checked it.)
  const byDeck = new Map<Id, Card[]>();
  for (const card of candidates) {
    const list = byDeck.get(card.deckId);
    if (list) list.push(card);
    else byDeck.set(card.deckId, [card]);
  }

  interface Lane {
    cards: Card[];
    next: number; // index of the next card to look at
    left: number; // per-deck cap still free
  }
  const lanes: Lane[] = [];
  const decks = [...byDeck.keys()]
    .map((id) => ctx.decks.get(id))
    .filter((deck): deck is Deck => deck !== undefined)
    .sort((a, b) => a.order - b.order || compareIds(a.id, b.id));
  for (const deck of decks) {
    // newPerDay null (or a broken value) = no per-deck cap: the fallback is Infinity.
    const left = remaining(optionsOf(deck).newPerDay, own(done.newByDeck, deck.id) ?? 0, Infinity);
    if (left === 0) continue;
    lanes.push({ cards: sortNewCards(byDeck.get(deck.id) ?? [], deck, dayKey), next: 0, left });
  }

  /** True when the new-sibling rule says this card must wait for another day. */
  const siblingBlocks = (card: Card): boolean =>
    spaceSiblings && (picked.has(card.noteId) || siblingBusy(card, ctx, dayStart));

  /** The next card of a lane that may be fed now, or null when the lane is empty. */
  const takeFrom = (lane: Lane): Card | null => {
    while (lane.next < lane.cards.length) {
      const card = lane.cards[lane.next];
      lane.next += 1;
      if (!siblingBlocks(card)) return card;
    }
    return null;
  };

  const fresh: Card[] = [];
  while (globalLeft > 0 && lanes.length > 0) {
    // One round: one card from each lane, in deck order.
    for (let i = 0; i < lanes.length && globalLeft > 0; ) {
      const lane = lanes[i];
      const card = takeFrom(lane);
      if (!card) {
        lanes.splice(i, 1); // this deck has nothing more to give
        continue;
      }
      fresh.push(card);
      picked.add(card.noteId);
      globalLeft -= 1;
      lane.left -= 1;
      if (lane.left <= 0) lanes.splice(i, 1); // per-deck cap reached
      else i += 1;
    }
  }
  return fresh;
}

/**
 * Can a learning sibling still be shown at some point? A suspended card, a
 * card whose direction is switched off, or a card without a real due time
 * (a broken `due`: null or NaN from damaged data, or Infinity — see
 * hasDueTime) can not: Study never shows it. Such a sibling must not block a
 * new card or a Check, or that card would wait forever. (Buried is only
 * "until tomorrow", so a buried sibling still counts.)
 */
function canComeBack(card: Card, ctx: ScheduleCtx): boolean {
  if (card.suspended) return false;
  if (!hasDueTime(card)) return false;
  const deck = ctx.decks.get(card.deckId);
  return deck !== undefined && directionEnabled(card, deck, ctx);
}

/** The new cards of ONE deck in the deck's feed order (a new array). */
function sortNewCards(cards: Card[], deck: Deck, dayKey: string): Card[] {
  if (optionsOf(deck).newOrder === 'random') {
    // A stable "random" order: hash each id with today's day key once.
    const key = new Map<Id, number>();
    for (const card of cards) key.set(card.id, fnv1a(card.id + dayKey));
    return [...cards].sort(
      (a, b) => (key.get(a.id) ?? 0) - (key.get(b.id) ?? 0) || compareIds(a.id, b.id),
    );
  }
  return [...cards].sort((a, b) => a.newPos - b.newPos || a.ord - b.ord || compareIds(a.id, b.id));
}

/** Keep the first `cap` cards of [...learn, ...reviews, ...checks, ...fresh]. */
function cutToSessionSize(b: Buckets, cap: number): Selection {
  const uncappedTotal = b.learn.length + b.reviews.length + b.checks.length + b.fresh.length;
  if (uncappedTotal <= cap) return { ...b, uncappedTotal };
  let left = cap;
  const take = (cards: Card[]): Card[] => {
    const out = cards.slice(0, left);
    left -= out.length;
    return out;
  };
  const learn = take(b.learn);
  const reviews = take(b.reviews);
  const checks = take(b.checks);
  const fresh = take(b.fresh);
  return { learn, reviews, checks, fresh, uncappedTotal };
}

/** The session queue of a scheduled run: [...learn, ...reviews, ...checks, ...fresh]. */
export function planQueue(sel: Selection): Card[] {
  return [...sel.learn, ...sel.reviews, ...sel.checks, ...sel.fresh];
}

/**
 * The numbers on a Study button. `total` is the sum of the bucket lengths,
 * so it equals planQueue(sel).length BY CONSTRUCTION.
 * When the session size cut cards (`capped`), the UI says
 * "{uncappedTotal} ready · Study {total}".
 */
export function readyCounts(sel: Selection): ReadyCounts {
  const total = sel.learn.length + sel.reviews.length + sel.checks.length + sel.fresh.length;
  return {
    total,
    learning: sel.learn.length,
    due: sel.reviews.length,
    checks: sel.checks.length,
    neww: sel.fresh.length,
    mins: minutesFor(total),
    capped: total < sel.uncappedTotal,
    uncappedTotal: sel.uncappedTotal,
  };
}

/* ------------------------------------------------------------------ study ahead */

/**
 * "Study ahead": Review/Mastered cards that are NOT due yet, soonest first,
 * capped by the session size. It changes the schedule (it is a real review).
 * The pool is the same as for Study (`studyEligible` cards of the scope).
 *
 * The review-sibling rule applies here too, BEFORE the session-size cut: one
 * card per note (so the two directions of one item never come back to back),
 * and, with spaceSiblings on, no card whose sibling was studied today.
 */
export function selectAhead(pool: readonly Card[], ctx: ScheduleCtx): Card[] {
  const seen = new Set<Id>();
  const out: Card[] = [];
  for (const card of pool) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    if (!usableDeck(card, ctx)) continue;
    const key = life(card);
    if ((key === 'review' || key === 'mastered') && hasDueTime(card) && card.due > ctx.now) out.push(card);
  }
  return reviewSiblingRule(out.sort(byDue), ctx).slice(0, sessionCap(ctx.settings.sessionLimit));
}

/* ------------------------------------------------------------------ practice */

/**
 * Free practice (spec §6.6). It never changes the schedule, so it may use
 * cards Study would not show (paused decks, not-due cards). The pool is every
 * card of the scope ('browse'), or the cards of a selection.
 *
 * Removed from the pool, unless the practice scope asks for them
 * (`ctx.scope`, the query's `life` and `flags` groups):
 *   - Known cards        (kept when scope.life has 'known')
 *   - Not started cards  (kept when scope.life has 'notStarted')
 *   - suspended cards    (kept when scope.flags has 'suspended')
 *   - buried cards       (kept when scope.flags has 'buried')
 * No `ctx.scope` (a selection, "Practice the {n} you missed") removes all four.
 *
 * Sort: `sort` from the caller (Library passes its current sort); `null`
 * keeps the pool order ("Practice the {n} you missed" keeps the miss order).
 * The order is `sortCards` — the ONE sort rule, also the Library's.
 * Then the session size cuts it.
 */
export function selectPractice(
  pool: readonly Card[],
  sort: SortSpec | null,
  ctx: ScheduleCtx,
): Card[] {
  const lifeAllowed = new Set(ctx.scope?.life ?? []);
  const flagsAllowed = new Set(ctx.scope?.flags ?? []);
  const seen = new Set<Id>();
  const out: Card[] = [];
  for (const card of pool) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const key = life(card);
    if (key === 'known' && !lifeAllowed.has('known')) continue;
    if (key === 'notStarted' && !lifeAllowed.has('notStarted')) continue;
    if (card.suspended && !flagsAllowed.has('suspended')) continue;
    if (isBuried(card, ctx.now) && !flagsAllowed.has('buried')) continue;
    out.push(card);
  }
  if (sort) out.sort(cardComparator(sort, ctx));
  return out.slice(0, sessionCap(ctx.settings.sessionLimit));
}

/* ------------------------------------------------------------------ the one sort rule */

/**
 * The sort key of a card that has NO value for a field sort (what
 * `ScheduleCtx.sortKey` returns, scope.ts). Such a card always comes LAST,
 * also with `dir: 'desc'`.
 */
export const NO_SORT_KEY = Number.POSITIVE_INFINITY;

/**
 * Compare two sort keys — the ONE rule for every A–Z and field sort (the
 * Library sort menu and Practice): numbers by value, text by CODE POINTS
 * (not `localeCompare`: Hermes has no reliable one, and a locale order would
 * differ from phone to phone); a number comes before text.
 *
 * The keys are already folded (lower case, no accents; a German term without
 * its article: face.ts faceSortKey), so code-point order is A–Z for letters.
 * Digits and most punctuation come before letters, '~' after them:
 *
 *   ['_x', '10 apples', '2 pears', 'apple', '~tilde'].sort(compareSortKeys)
 *   → ['10 apples', '2 pears', '_x', 'apple', '~tilde']
 */
export function compareSortKeys(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `cards` in the order of `sort` (a new array): the ONE sort rule of the
 * Library sort menu and of Practice (selectPractice uses it too), so a list
 * and the practice session it opens are always in the same order. The A–Z
 * and field keys come from `ctx.sortKey` (scope.ts gives the A–Z rule of
 * face.ts faceSortKey: "das Anliegen" sorts under A).
 */
export function sortCards(cards: readonly Card[], sort: SortSpec, ctx: SortCtx): Card[] {
  return [...cards].sort(cardComparator(sort, ctx));
}

/**
 * The comparator for a SortSpec (the Library sort menu):
 *   'source'  "Deck order"     deck.order, then newPos, ord, id
 *   'due'     "Due date"       Learning, Review and Mastered cards by due, soonest
 *                              first; then New, Not started and Known cards
 *                              (no review date yet: hasNoDueDate), by due too
 *   'az'      "A–Z"            ctx.sortKey (language-aware text); without it → 'source'
 *   'newest'  "Recently added" createdAt, newest first
 *   'hardest' "Hardest first"  ease ascending, then lapses descending
 *   'field'   (an ordinal filter group, e.g. Level) ctx.sortKey; without it → 'source'
 * `dir: 'desc'` reverses the order — except for the cards with NO value:
 * those of an A–Z or field sort (key NO_SORT_KEY) and, for "Due date", the
 * cards with no review date. They stay LAST in both directions, because
 * "no Level" is not "the highest Level", and a New card's `due` (the time it
 * was made or imported) is not a review date. Inside each group the order
 * follows the direction. Ties always end on the id, so the result never
 * depends on the pool order.
 *
 * Example, "Due date" (final pass; NOW = the time of the sort):
 *   asc:  learning (due NOW), review (due NOW + 3 d), new (due = made last week)
 *   desc: review (due NOW + 3 d), learning (due NOW), new
 */
function cardComparator(sort: SortSpec, ctx: SortCtx): (a: Card, b: Card) => number {
  const deckOrder = (card: Card): number => ctx.decks.get(card.deckId)?.order ?? Number.MAX_SAFE_INTEGER;
  const bySource = (a: Card, b: Card): number =>
    deckOrder(a) - deckOrder(b) ||
    compareIds(a.deckId, b.deckId) ||
    a.newPos - b.newPos ||
    a.ord - b.ord ||
    compareIds(a.id, b.id);

  let compare: (a: Card, b: Card) => number;
  /** For the Due date, A–Z and field sorts: true for a card with no value (it stays last). */
  let noValue: ((card: Card) => boolean) | null = null;
  switch (sort.by) {
    case 'due':
      compare = byDue;
      // A New, Not started or Known card has no review date: last, in both directions.
      noValue = hasNoDueDate;
      break;
    case 'newest':
      compare = (a, b) => b.createdAt - a.createdAt || compareIds(a.id, b.id);
      break;
    case 'hardest':
      compare = (a, b) => a.ease - b.ease || b.lapses - a.lapses || compareIds(a.id, b.id);
      break;
    case 'az':
    case 'field': {
      const sortKey = ctx.sortKey;
      if (!sortKey) {
        compare = bySource;
        break;
      }
      // Compute each key once (a sort calls the comparator ~N log N times).
      const keys = new Map<Id, string | number>();
      const keyOf = (card: Card): string | number => {
        let k = keys.get(card.id);
        if (k === undefined) {
          k = sortKey(card, sort);
          keys.set(card.id, k);
        }
        return k;
      };
      compare = (a, b) => compareSortKeys(keyOf(a), keyOf(b)) || bySource(a, b);
      noValue = (card) => keyOf(card) === NO_SORT_KEY;
      break;
    }
    case 'source':
    default:
      compare = bySource;
  }
  const ordered = sort.dir === 'desc' ? (a: Card, b: Card) => compare(b, a) : compare;
  const last = noValue;
  if (!last) return ordered;
  return (a, b) => {
    const aLast = last(a);
    if (aLast !== last(b)) return aLast ? 1 : -1;
    return ordered(a, b);
  };
}

/* ------------------------------------------------------------------ the one sort rule, fast (units P1, P2) */

/*
 * WHY a second way to the same order. The release build sorts with a JS
 * comparator: Hermes calls it about 240,000 times for 16,000 cards, and
 * each call costs (deck order 20–34 ms; A–Z 150–237 ms with its key
 * lookups). `orderCards` gives EXACTLY the order of `sortCards` with far
 * fewer comparator calls:
 *   - "Deck order": the cards are usually already in deck order (the store
 *     keeps them in import order). One pass checks it (n − 1 comparisons);
 *     only when they are not, the comparator sort runs.
 *   - A–Z and field sorts: the cards are put in deck order, then grouped by
 *     their key, and only the DISTINCT keys are sorted — text keys with the
 *     engine's own sort (no JS comparator: it compares UTF-16 code units,
 *     exactly like `compareSortKeys`), number keys with a comparator (a
 *     field has few values). Inside one key the cards keep deck order.
 *   - Due date, Recently added, Hardest first: a comparator sort. Due date
 *     (final pass) first splits the cards into two groups — with a review
 *     date, and without one (New, Not started, Known: hasNoDueDate) — and
 *     sorts each group on its own; the second group goes last. The same
 *     order as the card comparator (dueDatePositions).
 *
 * Unit P2: the comparator of these sorts reads its numbers from TYPED
 * ARRAYS ("columns", sortColumns below), made in ONE pass over the cards.
 * The old position sort called the card comparator through one more
 * function and read each card object again on every call: making the
 * library's order was 20–40 % slower than the plain sortCards (release:
 * Deck order 33.6 ms, Due date 20.9 ms). The column comparator is one
 * small function with no calls inside it (no Map lookup for the deck
 * order, no compareIds call), so it is faster than sortCards itself.
 * It compares the SAME numbers with the SAME subtractions, so the order is
 * the same: `x[i] - x[j]` with the numbers read once equals `a.x - b.x`.
 *
 * Both ways give the same order only when the comparator is a real order
 * (each pair compares the same way every time). A NaN number breaks that
 * (NaN − x is NaN, which counts as "equal" to everything), and so do ids
 * that are not text. `sortIsStrict` checks it (sortColumns makes the same
 * checks in its one pass); when it says no (damaged data — sanitize repairs
 * it on load), `orderCards` simply uses `sortCards`.
 */

/** The card keys a sort's comparator reads (and the deck order through `deckId`). */
export function sortFieldsOf(sort: Pick<SortSpec, 'by'>): readonly (keyof Card)[] {
  switch (sort.by) {
    case 'due':
      return DUE_FIELDS;
    case 'newest':
      return NEWEST_FIELDS;
    case 'hardest':
      return HARDEST_FIELDS;
    case 'az':
    case 'field':
      return KEY_FIELDS;
    default:
      return SOURCE_FIELDS;
  }
}

const SOURCE_FIELDS: readonly (keyof Card)[] = Object.freeze(['id', 'deckId', 'newPos', 'ord']);
/** A–Z and field keys come from the card's note, direction and deck (scope.ts sortKeyFor). */
const KEY_FIELDS: readonly (keyof Card)[] = Object.freeze(['id', 'deckId', 'newPos', 'ord', 'noteId']);
/**
 * "Due date" reads `due`, and `reps` + `knownAt` for its two groups
 * (hasNoDueDate reads exactly these two: reps 0 = New or Not started,
 * knownAt set = Known). So scope.ts sees every change that moves a card
 * from one group to the other, and places that card again: a first rating
 * (reps 0 → 1), "Mark as known" / "I know it" (only knownAt changes),
 * "Learn" on a Known card (only knownAt changes) and "Reset progress"
 * (knownAt cleared, reps back to 0).
 * (`newState` is not needed: New and Not started are in the same group.)
 */
const DUE_FIELDS: readonly (keyof Card)[] = Object.freeze(['id', 'due', 'reps', 'knownAt']);
const NEWEST_FIELDS: readonly (keyof Card)[] = Object.freeze(['id', 'createdAt']);
const HARDEST_FIELDS: readonly (keyof Card)[] = Object.freeze(['id', 'ease', 'lapses']);

/**
 * Card keys the comparators compare as TEXT (`<`), only look up, or only
 * test (`reps` and `knownAt`: hasNoDueDate gives true or false, never NaN);
 * every other sort field is subtracted. So a `knownAt` of null never makes
 * sortIsStrict say "no real order".
 */
const NOT_SUBTRACTED: ReadonlySet<keyof Card> = new Set<keyof Card>(['id', 'deckId', 'noteId', 'reps', 'knownAt']);

/**
 * True when the comparator of `sort` is a real order on these cards: every
 * id and deck id is text, and no number the comparator subtracts is NaN
 * (the deck order included; a missing number is NaN too, like `undefined − 1`).
 */
export function sortIsStrict(cards: readonly Card[], sort: Pick<SortSpec, 'by'>, ctx: Pick<ScheduleCtx, 'decks'>): boolean {
  for (const deck of ctx.decks.values()) {
    // deckOrder() reads `order ?? MAX_SAFE_INTEGER`, then subtracts it.
    if (deck.order != null && !subtractable(deck.order)) return false;
  }
  const numeric = sortFieldsOf(sort).filter((f) => !NOT_SUBTRACTED.has(f));
  // The usual sorts read two numbers or one: tested without a loop (this runs over every card).
  const [first, second] = numeric;
  for (const card of cards) {
    if (typeof card.id !== 'string' || typeof card.deckId !== 'string') return false;
    if (first !== undefined && !subtractable(card[first])) return false;
    if (second !== undefined && !subtractable(card[second])) return false;
    for (let f = 2; f < numeric.length; f++) if (!subtractable(card[numeric[f]])) return false;
  }
  return true;
}

/** True when `a - b` with this value is never NaN by itself: a number that is not NaN, or text/null that converts to one. */
function subtractable(value: unknown): boolean {
  // `value === value` is false only for NaN.
  return typeof value === 'number' ? value === value : !Number.isNaN(Number(value));
}

/** [0, 1, … n − 1]. */
function identityPositions(n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * Positions in reverse, except that runs of cards that compare as EQUAL keep
 * their order (what a stable sort does with `dir: 'desc'`).
 */
function reverseStable(list: readonly number[], equal: (i: number, j: number) => boolean): number[] {
  const out: number[] = [];
  let end = list.length;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && equal(list[start - 1], list[start])) start -= 1;
    for (let i = start; i < end; i++) out.push(list[i]);
    end = start;
  }
  return out;
}

/**
 * The numbers one sort compares, read ONCE per card (unit P2), by position:
 * `id[i]` is the id of cards[i], and `keys` are 1 to 3 number columns,
 * compared first to last. A column is already turned so that the SMALLER
 * number comes first:
 *   'due'      [due]
 *   'newest'   [−createdAt]              (newest first)
 *   'hardest'  [ease, −lapses]           (more lapses first)
 *   'source'   [deck place, newPos, ord] (also the base of A–Z and field sorts)
 * `−x` is exact in floating point and `(−b) − (−a)` is exactly `a − b`, so
 * every comparison gives the same answer as the card comparator.
 */
interface SortColumns {
  id: string[];
  keys: Float64Array[];
}

/**
 * The columns of `by` for these cards, or null when the comparator is no
 * real order on them: the checks of sortIsStrict, made in the same pass.
 * A number column holds what the comparator's subtraction reads (a Float64Array
 * turns the value into a number exactly like `a - b` does), so "not
 * subtractable" is "NaN in the column".
 *
 * The deck place: the decks of the cards, sorted ONCE by the comparator's
 * own rule (deck.order, then the deck id), numbered 0, 1, 2 … So
 * `place[i] - place[j]` has the sign of `deckOrder(a) - deckOrder(b) ||
 * compareIds(a.deckId, b.deckId)`, without a Map lookup per comparison.
 */
function sortColumns(cards: readonly Card[], by: SortSpec['by'], ctx: Pick<ScheduleCtx, 'decks'>): SortColumns | null {
  for (const deck of ctx.decks.values()) {
    // deckOrder() reads `order ?? MAX_SAFE_INTEGER`, then subtracts it.
    if (deck.order != null && !subtractable(deck.order)) return null;
  }
  const n = cards.length;
  const id = new Array<string>(n);
  if (by === 'due' || by === 'newest' || by === 'hardest') {
    const first = new Float64Array(n);
    const second = by === 'hardest' ? new Float64Array(n) : null;
    for (let i = 0; i < n; i++) {
      const card = cards[i];
      if (typeof card.id !== 'string' || typeof card.deckId !== 'string') return null;
      id[i] = card.id;
      if (by === 'due') first[i] = card.due;
      else if (by === 'newest') first[i] = -card.createdAt;
      else {
        first[i] = card.ease;
        second![i] = -card.lapses;
        // `x !== x` is true only for NaN.
        if (second![i] !== second![i]) return null;
      }
      if (first[i] !== first[i]) return null;
    }
    return { id, keys: second ? [first, second] : [first] };
  }
  // Deck order. The deck place is filled in two steps: first a number per
  // deck id (in the order the decks are met), then that number's place.
  const place = new Float64Array(n);
  const newPos = new Float64Array(n);
  const ord = new Float64Array(n);
  const slotOf = new Map<string, number>();
  const deckIds: string[] = [];
  let lastDeck: string | null = null;
  let lastSlot = 0;
  for (let i = 0; i < n; i++) {
    const card = cards[i];
    if (typeof card.id !== 'string' || typeof card.deckId !== 'string') return null;
    id[i] = card.id;
    newPos[i] = card.newPos;
    ord[i] = card.ord;
    if (newPos[i] !== newPos[i] || ord[i] !== ord[i]) return null;
    // Cards of one deck usually come together: one Map lookup per run of them.
    if (card.deckId !== lastDeck) {
      lastDeck = card.deckId;
      let slot = slotOf.get(lastDeck);
      if (slot === undefined) {
        slot = deckIds.length;
        slotOf.set(lastDeck, slot);
        deckIds.push(lastDeck);
      }
      lastSlot = slot;
    }
    place[i] = lastSlot;
  }
  const deckOrder = (deckId: Id): number => ctx.decks.get(deckId)?.order ?? Number.MAX_SAFE_INTEGER;
  const ranked = identityPositions(deckIds.length).sort(
    (s, t) => deckOrder(deckIds[s]) - deckOrder(deckIds[t]) || compareIds(deckIds[s], deckIds[t]),
  );
  const placeOfSlot = new Float64Array(deckIds.length);
  for (let r = 0; r < ranked.length; r++) placeOfSlot[ranked[r]] = r;
  for (let i = 0; i < n; i++) place[i] = placeOfSlot[place[i]];
  return { id, keys: [place, newPos, ord] };
}

/**
 * The comparator of two POSITIONS over `columns`: the number columns first
 * to last, then the id as text, then — only for two cards with one id
 * (damaged data) — the position (`i - j`): exactly what the stable sort of
 * sortCards does with two equal cards. `desc` turns the columns and the id
 * around, never the position (a stable sort keeps equal cards in input
 * order both ways). No function call inside: Hermes runs it about 240,000
 * times for 16,000 cards.
 */
function columnComparator(columns: SortColumns, desc: boolean): (i: number, j: number) => number {
  const { id, keys } = columns;
  const [k1, k2, k3] = keys;
  // One small function per number of columns and direction, so none tests
  // for a missing column on every call. `x || y` goes on to y for 0 and for
  // NaN (∞ − ∞), exactly like the card comparator's `a - b || …`.
  // The id: less → −1; the same id (damaged data) → the input order; else (greater) → 1.
  if (!desc) {
    if (keys.length === 1) return (i, j) => k1[i] - k1[j] || (id[i] < id[j] ? -1 : id[i] === id[j] ? i - j : 1);
    if (keys.length === 2) {
      return (i, j) => k1[i] - k1[j] || k2[i] - k2[j] || (id[i] < id[j] ? -1 : id[i] === id[j] ? i - j : 1);
    }
    return (i, j) =>
      k1[i] - k1[j] || k2[i] - k2[j] || k3[i] - k3[j] || (id[i] < id[j] ? -1 : id[i] === id[j] ? i - j : 1);
  }
  if (keys.length === 1) return (i, j) => k1[j] - k1[i] || (id[j] < id[i] ? -1 : id[j] === id[i] ? i - j : 1);
  if (keys.length === 2) {
    return (i, j) => k1[j] - k1[i] || k2[j] - k2[i] || (id[j] < id[i] ? -1 : id[j] === id[i] ? i - j : 1);
  }
  return (i, j) =>
    k1[j] - k1[i] || k2[j] - k2[i] || k3[j] - k3[i] || (id[j] < id[i] ? -1 : id[j] === id[i] ? i - j : 1);
}

/** True when the cards at positions i and j compare as EQUAL (the comparator gives 0: one id). */
function sameColumns(columns: SortColumns): (i: number, j: number) => boolean {
  const { id, keys } = columns;
  return (i, j) => {
    if (id[i] !== id[j]) return false;
    for (const k of keys) if (k[i] - k[j]) return false;
    return true;
  };
}

/** The positions of the cards sorted by their columns (a stable sort: see columnComparator). */
function sortedPositions(columns: SortColumns, desc: boolean): number[] {
  return identityPositions(columns.id.length).sort(columnComparator(columns, desc));
}

/**
 * The positions of "Due date" (final pass): first the cards WITH a review
 * date (Learning, Review, Mastered), then the cards with none (New, Not
 * started, Known: hasNoDueDate). Inside each group: by due, then id, in
 * the direction of the sort.
 *
 * How: one pass splits the positions into the two groups (hasReviewDate,
 * the opposite of hasNoDueDate), then each group is sorted by the columns,
 * and the second group goes after the first.
 * This is exactly the card comparator's order (cardComparator: the no-date
 * cards last, then byDue), because columnComparator is a strict order on
 * positions (its last tie is the position): a group sorted alone is in the
 * same order as its cards in one sort of all of them. (Splitting BEFORE the
 * sort, not after it: the two sorts together make fewer comparisons, and no
 * second pass is needed. In node --jitless on the device's 16,264 cards it
 * was the faster of the two.)
 *
 *   input:  [new (made last week), review (NOW + 3 d), learning (NOW)]
 *   split:  dated [review, learning]        no date [new]
 *   result: [learning, review, new]         ('desc': [review, learning, new])
 */
function dueDatePositions(cards: readonly Card[], columns: SortColumns, desc: boolean): number[] {
  const dated: number[] = [];
  const undated: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    if (hasReviewDate(cards[i])) dated.push(i);
    else undated.push(i);
  }
  const cmp = columnComparator(columns, desc);
  dated.sort(cmp);
  undated.sort(cmp);
  for (let k = 0; k < undated.length; k++) dated.push(undated[k]);
  return dated;
}

/** The positions of the cards in "Deck order" ('source', ascending): no sort at all when they already are in it. */
function sourcePositions(columns: SortColumns): number[] {
  const inOrder = columnComparator(columns, false);
  for (let i = 1; i < columns.id.length; i++) {
    // Two equal cards in input order give `i - j` < 0: in order, like `bySource(…) > 0` was false.
    if (inOrder(i - 1, i) > 0) return sortedPositions(columns, false);
  }
  return identityPositions(columns.id.length);
}

/* ------------------------------------------------------------------ Deck order a part at a time (unit P4 review) */

/*
 * WHY: the Library's shared warm-up (store/libraryWarmup.ts) makes the
 * library's Deck order ahead of time, in slices of about 8 ms. Usually the
 * cards are already in Deck order, and one pass checks it. But after some
 * normal changes they are NOT — a card added to an older deck after a newer
 * deck was imported, "Move to deck…", a new deck order — and then
 * orderPositions sorts all 16,000 positions in ONE call (the P4 review: one
 * 26.7 ms slice in node --jitless; the phone needs 20–37 ms for such a
 * sort). `sourceOrderJob` makes the SAME positions a part at a time:
 *   1. the columns (sortColumns: one pass over the cards, one step);
 *   2. one pass that finds where the order breaks: the cards are cut into
 *      RUNS that are already in order (usually few: the cards of one deck
 *      stay together). No break: the positions are 0, 1, 2 … at once;
 *   3. merge passes: two neighbour runs become one, until one run is left.
 * `stop()` is asked after the columns and after every ORDER_STEPS_PER_STOP
 * steps (a step: one comparison of the second part, or one position copied
 * in the third), so a call does little more work after a yes.
 *
 * EXACTLY the positions of orderPositions(cards, { by: 'source' }, ctx):
 * columnComparator is a strict order on positions — two different
 * positions never compare as equal (the last tie is `i - j`) — so there is
 * only ONE sorted order, whatever way of sorting makes it.
 */

/** How many steps sourceOrderJob does between two stop() questions (about 0.3 ms in node --jitless). */
export const ORDER_STEPS_PER_STOP = 1024;

/** What one call of a sourceOrderJob gives: not done yet, or the positions (null: no strict order here). */
export type SourceOrderStep =
  | { done: false }
  | {
      done: true;
      /** = orderPositions(cards, { by: 'source' }, ctx): null when the comparator is no real order on these cards. */
      positions: number[] | null;
      /** True when `positions` are 0, 1, 2 … (the cards were already in Deck order). */
      inOrder: boolean;
    };

const NOT_DONE: SourceOrderStep = Object.freeze({ done: false });

/**
 * The positions of "Deck order" (ascending) of `cards`, made a part at a
 * time (see above). It returns the function that does the next part: call
 * it again until it gives `done: true`; after that it gives the same result
 * at once.
 *
 *   const next = sourceOrderJob(cards, ctx);
 *   let step = next(() => clock() - start > 8);
 *   while (!step.done) step = next(…);           // in later slices
 *   step.positions                               // = orderPositions(cards, { by: 'source' }, ctx)
 */
export function sourceOrderJob(
  cards: readonly Card[],
  ctx: Pick<ScheduleCtx, 'decks'>,
): (stop: () => boolean) => SourceOrderStep {
  const n = cards.length;
  let result: SourceOrderStep | null = null;
  /** The comparator of two positions; null until the columns are made (part 1). */
  let compare: ((i: number, j: number) => number) | null = null;
  /** Part 2: the next position to compare with the one before it. */
  let scan = 1;
  /** Where each run starts (0 first); in part 3, the runs of the current merge pass. */
  let starts: number[] = [0];
  /** Part 3: the runs of the next merge pass (where each merged run starts). */
  let next: number[] = [];
  /** Part 3: the positions in the order so far (`src`), and the merge pass writes into `dst`. */
  let src: number[] = [];
  let dst: number[] = [];
  /** Part 3: which runs are merged now (starts[pair] and starts[pair + 1]), and where in them. */
  let pair = 0;
  let i = -1;
  let iEnd = 0;
  let j = 0;
  let jEnd = 0;
  let o = 0;

  return (stop) => {
    if (result) return result;
    if (!compare) {
      // 1. The columns: one pass over the cards (null: no strict order — orderPositions gives null too).
      const columns = sortColumns(cards, 'source', ctx);
      if (!columns) return (result = { done: true, positions: null, inOrder: false });
      compare = columnComparator(columns, false);
      if (stop()) return NOT_DONE;
    }
    const cmp = compare;
    let work = 0;
    // 2. The runs. A break: the card at `k` comes before the one at `k - 1`.
    for (let k = scan; k < n; ) {
      if (cmp(k - 1, k) > 0) starts.push(k);
      k += 1;
      if (++work % ORDER_STEPS_PER_STOP === 0 && stop()) {
        scan = k;
        return NOT_DONE;
      }
    }
    scan = n;
    if (starts.length === 1) return (result = { done: true, positions: identityPositions(n), inOrder: true });
    // 3. Merge passes over the runs (a break means the cards were NOT in order).
    if (src.length === 0) {
      src = identityPositions(n);
      dst = new Array<number>(n);
    }
    for (;;) {
      while (pair < starts.length) {
        if (i < 0) {
          // The next two runs (the last one alone when the number of runs is odd: it is only copied).
          i = starts[pair];
          iEnd = pair + 1 < starts.length ? starts[pair + 1] : n;
          j = iEnd;
          jEnd = pair + 2 < starts.length ? starts[pair + 2] : n;
          o = i;
          next.push(i);
        }
        // The hot loop works on local copies (faster than the closure's
        // variables on Hermes); they are written back when it pauses.
        const from = src;
        const into = dst;
        const ie = iEnd;
        const je = jEnd;
        let a = i;
        let b = j;
        let w = o;
        while (w < je) {
          if (a < ie && (b >= je || cmp(from[a], from[b]) <= 0)) into[w++] = from[a++];
          else into[w++] = from[b++];
          if (++work % ORDER_STEPS_PER_STOP === 0 && stop()) {
            i = a;
            j = b;
            o = w;
            return NOT_DONE;
          }
        }
        i = -1;
        pair += 2;
      }
      [src, dst] = [dst, src];
      starts = next;
      next = [];
      pair = 0;
      if (starts.length === 1) return (result = { done: true, positions: src, inOrder: false });
    }
  };
}

/**
 * The order of `sort` as POSITIONS in `cards` (`cards[out[0]]` comes first) —
 * the order of `sortCards(cards, sort, ctx)` — or null when the comparator is
 * no real order on these cards (sortIsStrict; then only sortCards itself
 * gives its order). See the section comment for how; scope.ts keeps the
 * positions of a whole library, so a later cards array can reuse them.
 */
export function orderPositions(cards: readonly Card[], sort: SortSpec, ctx: SortCtx): number[] | null {
  const columns = sortColumns(cards, sort.by, ctx);
  if (!columns) return null;
  const desc = sort.dir === 'desc';
  if (sort.by === 'due') return dueDatePositions(cards, columns, desc);
  if (sort.by === 'newest' || sort.by === 'hardest') return sortedPositions(columns, desc);
  const sortKey = ctx.sortKey;
  const source = sourcePositions(columns);
  const sameSource = sameColumns(columns);
  // Deck order (and A–Z or a field without a key function: deck order too, like cardComparator).
  if ((sort.by !== 'az' && sort.by !== 'field') || sortKey === undefined) {
    return desc ? reverseStable(source, sameSource) : source;
  }

  // Group the cards (in deck order) by their key; NO_SORT_KEY = no value (always last).
  const textGroups = new Map<string, number[]>();
  const numberGroups = new Map<number, number[]>();
  const noValue: number[] = [];
  for (const i of source) {
    const k = sortKey(cards[i], sort);
    if (k === NO_SORT_KEY) noValue.push(i);
    else if (typeof k === 'number') {
      const group = numberGroups.get(k);
      if (group) group.push(i);
      else numberGroups.set(k, [i]);
    } else {
      const group = textGroups.get(k);
      if (group) group.push(i);
      else textGroups.set(k, [i]);
    }
  }
  // The engine's sort without a comparator compares text by UTF-16 code units: compareSortKeys' order.
  const texts = [...textGroups.keys()].sort();
  const numbers = [...numberGroups.keys()].sort(compareSortKeys);
  const out: number[] = [];
  const put = (group: number[]) => {
    for (const i of desc ? reverseStable(group, sameSource) : group) out.push(i);
  };
  // A number key comes before a text key (compareSortKeys); Z–A turns both lists around.
  if (!desc) {
    for (const n of numbers) put(numberGroups.get(n)!);
    for (const t of texts) put(textGroups.get(t)!);
  } else {
    for (let i = texts.length - 1; i >= 0; i--) put(textGroups.get(texts[i])!);
    for (let i = numbers.length - 1; i >= 0; i--) put(numberGroups.get(numbers[i])!);
  }
  put(noValue);
  return out;
}

/**
 * The order of `sort` as positions in `cards`, REPAIRED from `kept` instead
 * of sorted again (unit P1 review 2). `kept` is the order of an EARLIER cards
 * array of the same length, in which only the cards at the positions
 * `changed` had other values that this sort reads (sortFieldsOf). The usual
 * case: a rating changes `due`, `ease` and `lapses` of ONE card, and "Due
 * date" or "Hardest first" would sort all 16,000 cards again for it.
 *
 * How: the comparator reads only a card's OWN values (and the decks and the
 * card's key, which the caller keeps the same), so the cards that did not
 * change keep their order among themselves. They are copied in that order,
 * and each changed card is put at its place with a binary search (the
 * changed cards first sorted among themselves). The cost is two passes over
 * `kept` and about k·log₂N comparisons for k changed cards, instead of
 * N·log₂N comparisons for a new sort.
 *
 * The result is exactly orderPositions(cards, sort, ctx) — the order of
 * sortCards — when the comparator is a strict order on `cards`: unique ids
 * and sortIsStrict (the caller checks both, scope.ts libraryOrder). `changed`
 * holds each position once.
 *
 *   repairPositions(cards, kept, [10], { by: 'due' }, ctx)   // after a rating of cards[10]
 */
export function repairPositions(
  cards: readonly Card[],
  kept: readonly number[],
  changed: readonly number[],
  sort: SortSpec,
  ctx: SortCtx,
): number[] {
  const compare = cardComparator(sort, ctx);
  // The tie on the position (`|| i - j`) is what columnComparator does too.
  const order = (i: number, j: number): number => compare(cards[i], cards[j]) || i - j;
  const moved = new Uint8Array(cards.length);
  for (const i of changed) moved[i] = 1;
  // The cards that did not change, still in their order. (A separate array:
  // a binary search over `kept` that steps over changed positions would be
  // slow when the changed cards sit together, e.g. a whole deck moved.)
  const rest = new Array<number>(kept.length - changed.length);
  let r = 0;
  for (let t = 0; t < kept.length; t++) if (moved[kept[t]] === 0) rest[r++] = kept[t];
  const fresh = [...changed].sort(order);
  const out = new Array<number>(kept.length);
  let o = 0;
  let from = 0;
  for (const c of fresh) {
    // The first card of rest[from …] that comes AFTER c (fresh is sorted, so never before `from`).
    let lo = from;
    let hi = rest.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (order(rest[mid], c) < 0) lo = mid + 1;
      else hi = mid;
    }
    while (from < lo) out[o++] = rest[from++];
    out[o++] = c;
  }
  while (from < rest.length) out[o++] = rest[from++];
  return out;
}

/**
 * `cards` in the order of `sort` (a new array) — EXACTLY `sortCards(cards,
 * sort, ctx)`, with far fewer comparator calls (see above). The Library's
 * list uses it (scope.ts sortScopeCards); `sortCards` stays the rule it
 * must match (schedule.test.ts compares both on big random libraries).
 *
 *   orderCards(cards, { by: 'az' }, ctx)   // same as sortCards(cards, { by: 'az' }, ctx)
 *
 * Due date, Recently added and Hardest first are a comparator sort here
 * too, but over the columns (unit P2): faster than sortCards, also with
 * the positions in between (unit P1 review 2 sent them straight to
 * sortCards, because the old position sort was about a quarter slower).
 */
export function orderCards(cards: readonly Card[], sort: SortSpec, ctx: SortCtx): Card[] {
  const at = orderPositions(cards, sort, ctx);
  if (!at) return sortCards(cards, sort, ctx);
  const out = new Array<Card>(at.length);
  for (let k = 0; k < at.length; k++) out[k] = cards[at[k]];
  return out;
}
