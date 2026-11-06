/**
 * Tests for "Choose what to learn" (src/components/deck/triageLogic.ts,
 * spec §8.5, unit W4-3):
 *   - items are NOTES: a choice applies to every Not started card of the note
 *     in an ENABLED direction (checked through the real reducer: learn →
 *     both directions in the queue, markKnown → both Known; a turned-off
 *     direction stays as it was);
 *   - "Later" moves the item to the end; only Later items left = done;
 *     "Show the later ones" goes through them again;
 *   - Undo takes back the last step (queue, Later list, counters), and the
 *     store edit it returns puts the cards back (real undoManualEdit);
 *   - Undo is offered only while the store can take the step back
 *     (canUndoLast): not for "Learn all" over more than 20,000 cards, not
 *     for an edit that 50 newer edits pushed out of the log;
 *   - "Learn all {n} left" / "Mark all {n} known": n = the items still in the
 *     queue (Later ones too), and the counters after it;
 *   - "Where do you start?" in the run (place);
 *   - the words: "34 / 520", "12 to learn · 20 known · 2 later",
 *     "Done — 1 card added to your queue.", "They come in 10 a day, in deck order."
 *     — never "NaN a day" (a broken limit uses the default) and never "0 a day"
 *     (the line is left out); "Where do you start?" is not offered again after
 *     the deck page answered it (`placed=1`);
 *   - wave 5b (walkthrough M6): one counting language — the run counts ITEMS,
 *     and when an item has two cards the counter says "0 / 3 items", the bulk
 *     buttons say "Learn all 3 items left" (like the deck page's row menu,
 *     review round 2) and every card number says its items too ("Done — 6
 *     cards (3 items) added …").
 *
 * Part 2 — the triage screen's wiring (src/app/triage.tsx), rendered with
 * react-test-renderer: the store hooks read one in-memory state and every
 * action runs the REAL reducer on it; the router, gesture-handler, haptics,
 * theme and icons are small fakes. Learn / I know it / Later / Undo / the bulk
 * buttons / the end screen really call the store and the routes.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import TriageScreen from '../../app/triage';

import { BUILTIN_TYPE_IDS } from '../../domain/builtinTypes';
import { life } from '../../domain/life';
import { MANUAL_LOG_MAX_EDITS, MANUAL_LOG_MAX_SNAPSHOTS } from '../../domain/manualLog';
import type { Card, DataStateV3, NoteType } from '../../domain/model';
import { DEFAULT_SRS } from '../../domain/types';
import { cardLookupOf, decksById } from '../../domain/scope';
import * as reducer from '../../store/reducer';
import { isUndoableEdit } from '../study/rescheduleLogic';
import { FIXED_NOW } from '../../test/clock';
import { cardInLifeV3, lifeValues, makeDeckV3, noteWithCards, stateOfV3, testCtx } from '../../test/factoriesV3';
import {
  againLater,
  bulkLabels,
  canUndoLast,
  cardIdsOf,
  cardsAndItems,
  choose,
  chooseAll,
  currentItem,
  directionOn,
  doneCopy,
  handledCount,
  hasChosen,
  isDone,
  leftItems,
  newPerDayOf,
  place,
  positionLabel,
  positionParts,
  runLine,
  safeDailyNewLimit,
  startRun,
  stepSnack,
  triageItems,
  type TriageLookup,
  undoStep,
} from './triageLogic';

const REVERSE = BUILTIN_TYPE_IDS.basicReverse;

/** A Not started card of one direction. */
const notStarted = (ord: number): Partial<Card> => ({ ...cardInLifeV3('notStarted'), ord });

/** The triage lookups of a state (what the screen builds with triageLookupOf). */
function lookupOf(state: DataStateV3): TriageLookup {
  const { cardById, cardIdsByNote } = cardLookupOf(state.cards);
  const { notes } = state;
  const typeOfNote = new Map(notes.map((n) => [n.id, n.typeId]));
  return { cardById, cardIdsByNote, decks: decksById(state.decks), typeIdOf: (id) => typeOfNote.get(id) };
}

/** A deck with `n` Basic + reverse notes; each note's cards come from `card(ord, i)`. */
function deckState(
  n: number,
  card: (ord: number, i: number) => Partial<Card> = notStarted,
  deck: Parameters<typeof makeDeckV3>[0] = {},
) {
  const d = makeDeckV3({ id: 'd1', ...deck });
  const groups = Array.from({ length: n }, (_, i) =>
    noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i }, card: (ord) => card(ord, i) }),
  );
  return stateOfV3({ decks: [d], groups });
}

describe('triageItems: one item per note, every enabled direction', () => {
  it('a note with both directions Not started is ONE item with both cards', () => {
    const state = deckState(2);
    const items = triageItems(state.cards, lookupOf(state));
    expect(items).toHaveLength(2);
    expect(items[0].noteId).toBe('n0');
    expect(items[0].cardIds).toHaveLength(2);
    expect(items.map((i) => i.noteId)).toEqual(['n0', 'n1']);
  });

  it('takes the siblings along when the pool holds only one direction (a Direction chip)', () => {
    const state = deckState(1);
    const onlyOrd1 = state.cards.filter((c) => c.ord === 1);
    const [item] = triageItems(onlyOrd1, lookupOf(state));
    expect(item.cardIds.sort()).toEqual(state.cards.map((c) => c.id).sort());
    expect(item.shownCardId).toBe(onlyOrd1[0].id);
  });

  it('leaves out studied siblings and cards of a turned-off direction', () => {
    const state = deckState(1, (ord) => (ord === 0 ? notStarted(0) : { ...cardInLifeV3('review'), ord: 1 }));
    const [item] = triageItems(state.cards, lookupOf(state));
    expect(item.cardIds).toEqual([state.cards.find((c) => c.ord === 0)!.id]);

    const off = deckState(1, notStarted, { options: { directions: { [REVERSE]: [0] } } });
    const [only] = triageItems(off.cards, lookupOf(off));
    expect(only.cardIds).toEqual([off.cards.find((c) => c.ord === 0)!.id]);
  });

  it('skips notes with no Not started card, and keeps the order of the pool', () => {
    const state = deckState(3, (ord, i) => (i === 1 ? { ...cardInLifeV3('new'), ord } : notStarted(ord)));
    const reversed = [...state.cards].reverse();
    expect(triageItems(reversed, lookupOf(state)).map((i) => i.noteId)).toEqual(['n2', 'n0']);
  });

  it('directionOn: no list = on; a list names the ords that are on', () => {
    const deck = makeDeckV3({ options: { directions: { t1: [0] } } });
    expect(directionOn(deck, 't1', 0)).toBe(true);
    expect(directionOn(deck, 't1', 1)).toBe(false);
    expect(directionOn(deck, 'other', 1)).toBe(true);
    expect(directionOn(makeDeckV3(), 't1', 3)).toBe(true);
  });
});

describe('a choice applies to every enabled direction (real reducer)', () => {
  it('Learn puts both directions in the queue; I know it marks both Known', () => {
    const state = deckState(2);
    const items = triageItems(state.cards, lookupOf(state));
    const ctx = testCtx();
    const learned = reducer.learn(state, { cardIds: items[0].cardIds }, ctx).state;
    const known = reducer.markKnown(learned, { cardIds: items[1].cardIds }, ctx).state;
    const lifeOf = (noteId: string) => known.cards.filter((c) => c.noteId === noteId).map(life);
    expect(lifeOf('n0')).toEqual(['new', 'new']);
    expect(lifeOf('n1')).toEqual(['known', 'known']);
  });

  it('a turned-off direction is not changed by the choice', () => {
    const state = deckState(1, notStarted, { options: { directions: { [REVERSE]: [0] } } });
    const [item] = triageItems(state.cards, lookupOf(state));
    const next = reducer.learn(state, { cardIds: item.cardIds }, testCtx()).state;
    expect(next.cards.map((c) => [c.ord, life(c)])).toEqual([
      [0, 'new'],
      [1, 'notStarted'],
    ]);
  });
});

describe('the run: Later, done, undo', () => {
  const state = deckState(3);
  const items = triageItems(state.cards, lookupOf(state));

  it('Later moves the item to the end of the run and writes nothing', () => {
    let run = startRun(items);
    expect(currentItem(run)?.noteId).toBe('n0');
    run = choose(run, 'later');
    expect(run.queue).toEqual(['n1', 'n2', 'n0']);
    expect(run.history[0].editId).toBeNull();
    expect(currentItem(run)?.noteId).toBe('n1');
    expect(runLine(run)).toBe('1 later');
  });

  it('only Later items left = done; "Show the later ones" goes through them again', () => {
    let run = startRun(items);
    run = choose(run, 'later');
    run = choose(run, 'learn', 'e1');
    run = choose(run, 'known', 'e2');
    expect(isDone(run)).toBe(true);
    expect(currentItem(run)).toBeNull();
    expect(run.queue).toEqual(['n0']);
    run = againLater(run);
    expect(isDone(run)).toBe(false);
    expect(currentItem(run)?.noteId).toBe('n0');
  });

  it('Undo takes back the last step: queue, Later list and counters', () => {
    let run = startRun(items);
    run = choose(run, 'learn', 'edit-1');
    run = choose(run, 'later');
    const back = undoStep(run)!;
    expect(back.kind).toBe('later');
    expect(back.editId).toBeNull();
    expect(back.run.queue).toEqual(['n1', 'n2']);
    expect(back.run.later).toEqual([]);
    const back2 = undoStep(back.run)!;
    expect(back2.editId).toBe('edit-1');
    expect(back2.run.queue).toEqual(['n0', 'n1', 'n2']);
    expect(back2.run.counts.learn).toBe(0);
    expect(hasChosen(back2.run)).toBe(false);
    expect(undoStep(back2.run)).toBeNull();
  });

  it('Undo of Learn, with the real undoManualEdit, puts the cards back to Not started', () => {
    const ctx = testCtx();
    let run = startRun(items);
    const item = currentItem(run)!;
    const step = reducer.learn(state, { cardIds: item.cardIds }, ctx);
    run = choose(run, 'learn', step.result.edit.id);
    expect(step.state.cards.filter((c) => c.noteId === 'n0').map(life)).toEqual(['new', 'new']);
    const back = undoStep(run)!;
    const undone = reducer.undoManualEdit(step.state, { editId: back.editId! }, ctx).state;
    expect(undone.cards.filter((c) => c.noteId === 'n0').map(life)).toEqual(['notStarted', 'notStarted']);
    expect(currentItem(back.run)?.noteId).toBe('n0');
  });

  it('a done run does not change on another choice', () => {
    let run = startRun(items.slice(0, 1));
    run = choose(run, 'learn', 'e');
    expect(choose(run, 'known', 'x')).toBe(run);
  });
});

describe('"Learn all {n} left" / "Mark all {n} known"', () => {
  const state = deckState(5);
  const items = triageItems(state.cards, lookupOf(state));

  it('n = the items still in the queue, Later ones too', () => {
    // 2 cards per item (both directions): the buttons name the unit, like the
    // counter "0 / 5 items" and the deck page's "Learn all 5 items" (walkthrough M6, review round 2).
    let run = startRun(items);
    expect(bulkLabels(run)).toEqual({ learn: 'Learn all 5 items left', known: 'Mark all 5 items known' });
    run = choose(run, 'learn', 'e1');
    run = choose(run, 'later');
    expect(bulkLabels(run)).toEqual({ learn: 'Learn all 4 items left', known: 'Mark all 4 items known' });
    expect(cardIdsOf(leftItems(run))).toHaveLength(8);
    // One item left: "1 item" (plural-safe).
    run = chooseAll(startRun(items.slice(0, 1)), 'learnAll', 'e2');
    expect(bulkLabels(startRun(items.slice(0, 1)))).toEqual({ learn: 'Learn all 1 item left', known: 'Mark all 1 item known' });
    expect(bulkLabels(run)).toBeNull();
  });

  it('one card per item: the plain words of spec §8.5 ("Learn all 486 left"), like the counter "0 / 3"', () => {
    const one = deckState(3, notStarted, { options: { directions: { [REVERSE]: [0] } } });
    const run = startRun(triageItems(one.cards, lookupOf(one)));
    expect([run.total, run.cards]).toEqual([3, 3]);
    expect(positionLabel(run)).toBe('0 / 3');
    expect(bulkLabels(run)).toEqual({ learn: 'Learn all 3 left', known: 'Mark all 3 known' });
    // Big numbers keep their thousands separator in both forms.
    const big = { ...run, total: 1200, cards: 1200, queue: Array.from({ length: 1200 }, (_, i) => `x${i}`) };
    expect(bulkLabels(big)).toEqual({ learn: 'Learn all 1,200 left', known: 'Mark all 1,200 known' });
    expect(bulkLabels({ ...big, cards: 2400 })).toEqual({ learn: 'Learn all 1,200 items left', known: 'Mark all 1,200 items known' });
  });

  it('learns every item left: the run is done and the counters add up', () => {
    let run = startRun(items);
    run = choose(run, 'known', 'e1');
    run = chooseAll(run, 'learnAll', 'e2');
    expect(run.queue).toEqual([]);
    expect(isDone(run)).toBe(true);
    expect(run.counts).toMatchObject({ learn: 4, known: 1, learnCards: 8, knownCards: 2 });
    expect(bulkLabels(run)).toBeNull();
    expect(stepSnack('learnAll', 8)).toBe('8 cards added to your queue');
    // Undo brings every one of them back.
    const back = undoStep(run)!;
    expect(back.editId).toBe('e2');
    expect(back.run.queue).toHaveLength(4);
  });
});

describe('Undo only while the store can take the step back (canUndoLast)', () => {
  /** isStored for a state: the edit is still in its undo log (what the screen asks). */
  const storedIn = (s: DataStateV3) => (editId: string) => isUndoableEdit(s.manualLog, editId);

  it('a step that wrote nothing can always be undone; nothing to undo → false', () => {
    const state = deckState(2);
    const run = startRun(triageItems(state.cards, lookupOf(state)));
    expect(canUndoLast(run, () => false)).toBe(false);
    expect(canUndoLast(choose(run, 'later'), () => false)).toBe(true);
    expect(canUndoLast(place(run, ['n0'], 'notStarted', null), () => false)).toBe(true);
  });

  it('"Learn all" over more cards than the undo log keeps: no Undo (the run is not taken back)', () => {
    // 10,001 items × 2 directions = 20,002 cards > MANUAL_LOG_MAX_SNAPSHOTS (20,000).
    const state = deckState(MANUAL_LOG_MAX_SNAPSHOTS / 2 + 1);
    let run = startRun(triageItems(state.cards, lookupOf(state)));
    const ids = cardIdsOf(leftItems(run));
    expect(ids.length).toBeGreaterThan(MANUAL_LOG_MAX_SNAPSHOTS);
    const step = reducer.learn(state, { cardIds: ids }, testCtx());
    // The change happened, but the store cannot take it back.
    expect(step.result.undoable).toBe(false);
    expect(step.state.cards.every((c) => life(c) === 'new')).toBe(true);
    run = chooseAll(run, 'learnAll', step.result.edit.id);
    expect(canUndoLast(run, storedIn(step.state))).toBe(false);
  });

  it('a choice pushed out of the log by 50 newer edits: no Undo for it, Undo for the newer ones', () => {
    const state = deckState(3);
    const ctx = testCtx();
    let run = startRun(triageItems(state.cards, lookupOf(state)));
    const first = reducer.learn(state, { cardIds: currentItem(run)!.cardIds }, ctx);
    run = choose(run, 'learn', first.result.edit.id);
    expect(canUndoLast(run, storedIn(first.state))).toBe(true);
    // 50 newer edits (a flag on and off, again and again) push the first one out.
    let s = first.state;
    for (let i = 0; i < MANUAL_LOG_MAX_EDITS; i += 1) {
      s = reducer.setFlags(s, { cardIds: [s.cards[5].id], patch: { fav: i % 2 === 0 } }, ctx).state;
    }
    expect(isUndoableEdit(s.manualLog, first.result.edit.id)).toBe(false);
    expect(canUndoLast(run, storedIn(s))).toBe(false);
    // A newer choice is in the log: it can be undone, and then the old one cannot.
    const second = reducer.markKnown(s, { cardIds: currentItem(run)!.cardIds }, ctx);
    const after = choose(run, 'known', second.result.edit.id);
    expect(canUndoLast(after, storedIn(second.state))).toBe(true);
    const back = undoStep(after)!;
    const undone = reducer.undoManualEdit(second.state, { editId: back.editId! }, ctx).state;
    expect(canUndoLast(back.run, storedIn(undone))).toBe(false);
  });
});

describe('"Where do you start?" in the run', () => {
  const state = deckState(4);
  const items = triageItems(state.cards, lookupOf(state));

  it('the easier items leave the run: Known (counted) or left Not started (skipped)', () => {
    const run = startRun(items);
    const known = place(run, ['n0', 'n1'], 'known', 'e1');
    expect(known.queue).toEqual(['n2', 'n3']);
    expect(known.counts).toMatchObject({ known: 2, knownCards: 4 });
    const left = place(run, ['n0'], 'notStarted', 'ignored');
    expect(left.queue).toEqual(['n1', 'n2', 'n3']);
    expect(left.counts.skipped).toBe(1);
    expect(left.history[0].editId).toBeNull();
    expect(undoStep(known)!.run.queue).toEqual(['n0', 'n1', 'n2', 'n3']);
    expect(place(run, [], 'known', null)).toBe(run);
  });
});

describe('the words', () => {
  const state = deckState(4);
  const items = triageItems(state.cards, lookupOf(state));

  it('position and run line', () => {
    let run = startRun(items);
    // Wave 5b (M6): two cards per item, so the counter names its unit.
    expect([run.total, run.cards]).toEqual([4, 8]);
    expect(positionLabel(run)).toBe('0 / 4 items');
    expect(runLine(run)).toBe('');
    run = choose(run, 'learn', 'a');
    run = choose(run, 'known', 'b');
    run = choose(run, 'later');
    expect(handledCount(run)).toBe(3);
    expect(positionLabel(run)).toBe('3 / 4 items');
    expect(runLine(run)).toBe('1 to learn · 1 known · 1 later');
    // One card per item: the plain numbers (cards and items are the same).
    const single = startRun(items.map((i) => ({ ...i, cardIds: [i.cardIds[0]] })));
    expect([single.total, single.cards]).toEqual([4, 4]);
    expect(positionLabel(single)).toBe('0 / 4');
    expect(positionLabel(startRun(items.slice(0, 1)))).toBe('0 / 1 item');
  });

  it('cards and items: said together only when they differ (M6)', () => {
    expect(cardsAndItems(12, 6)).toBe('12 cards (6 items)');
    expect(cardsAndItems(2, 1)).toBe('2 cards (1 item)');
    expect(cardsAndItems(6, 6)).toBe('6 cards');
    expect(cardsAndItems(1, 1)).toBe('1 card');
    expect(cardsAndItems(0, 0)).toBe('0 cards');
    expect(stepSnack('learnAll', 12, 6)).toBe('12 cards (6 items) added to your queue');
    expect(stepSnack('knownAll', 12, 6)).toBe('12 cards (6 items) marked as known');
    expect(stepSnack('place', 4, 2)).toBe('4 cards (2 items) marked as known');
    expect(stepSnack('learn', 3)).toBe('3 cards added to your queue');
    expect(stepSnack('later', 2, 1)).toBe('Put off for later');
  });

  it('the end of the run (plural-safe)', () => {
    let run = startRun(items.slice(0, 1));
    run = choose(run, 'learn', 'a');
    // Wave 5b (M6): the 2 cards are 1 item, and the end says so.
    expect(doneCopy(run, { perDay: 10, random: false })).toEqual({
      title: 'Done — 2 cards (1 item) added to your queue.',
      lines: ['They come in 10 a day, in deck order.'],
    });
    const one = startRun([{ ...items[0], cardIds: [items[0].cardIds[0]] }]);
    const learnedOne = choose(one, 'learn', 'a');
    expect(doneCopy(learnedOne, { perDay: 1, random: true }).title).toBe('Done — 1 card added to your queue.');
    expect(doneCopy(learnedOne, { perDay: 1, random: true }).lines).toEqual(['They come in 1 a day, in random order.']);

    let mixed = startRun(items);
    mixed = choose(mixed, 'known', 'k');
    mixed = choose(mixed, 'later');
    mixed = choose(mixed, 'later');
    mixed = choose(mixed, 'later');
    expect(isDone(mixed)).toBe(true);
    expect(doneCopy(mixed, { perDay: 10, random: false })).toEqual({
      title: 'Done — 0 cards added to your queue.',
      lines: ['2 cards (1 item) marked as known.', '3 items left for later — they stay Not started.'],
    });
  });

  it('"They come in {n} a day": the one deck’s own cap (never above the daily limit), else the daily limit', () => {
    expect(newPerDayOf([makeDeckV3({ options: { newPerDay: 5 } })], 10)).toBe(5);
    expect(newPerDayOf([makeDeckV3({ options: { newPerDay: 50 } })], 10)).toBe(10);
    expect(newPerDayOf([makeDeckV3()], 10)).toBe(10);
    expect(newPerDayOf([makeDeckV3({ options: { newPerDay: 5 } }), makeDeckV3()], 10)).toBe(10);
  });

  it('"They come in {n} a day" never says NaN or 0: a broken limit uses the default, a cap of 0 leaves the line out', () => {
    // A broken saved limit (old data): the default, the same guard as the deck page.
    expect(safeDailyNewLimit(Number.NaN)).toBe(DEFAULT_SRS.dailyNewLimit);
    expect(safeDailyNewLimit(undefined)).toBe(DEFAULT_SRS.dailyNewLimit);
    expect(safeDailyNewLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SRS.dailyNewLimit);
    expect(safeDailyNewLimit(12.7)).toBe(12);
    expect(newPerDayOf([makeDeckV3()], Number.NaN)).toBe(DEFAULT_SRS.dailyNewLimit);
    expect(newPerDayOf([makeDeckV3({ options: { newPerDay: 5 } })], Number.NaN)).toBe(5);
    expect(newPerDayOf([], undefined as unknown as number)).toBe(DEFAULT_SRS.dailyNewLimit);
    const learned = choose(startRun(items.slice(0, 1)), 'learn', 'a');
    const perDay = newPerDayOf([makeDeckV3()], Number.NaN);
    expect(doneCopy(learned, { perDay, random: false }).lines).toEqual([
      `They come in ${DEFAULT_SRS.dailyNewLimit} a day, in deck order.`,
    ]);
    // A deck that gets 0 new cards a day: no promise of "0 a day".
    const zero = newPerDayOf([makeDeckV3({ options: { newPerDay: 0 } })], 10);
    expect(zero).toBe(0);
    expect(doneCopy(learned, { perDay: zero, random: false })).toEqual({
      title: 'Done — 2 cards (1 item) added to your queue.',
      lines: [],
    });
    expect(doneCopy(learned, { perDay: Number.NaN, random: false }).lines).toEqual([]);
    expect(doneCopy(learned, { perDay: 0, random: false }).lines.some((l) => l.includes('NaN') || l.includes(' 0 a day'))).toBe(false);
  });
});

/* ======================================================================= the triage screen (wiring) */

/** The in-memory store of the render tests (every action runs the real reducer on it). */
let mockState: DataStateV3 = stateOfV3({ decks: [] });
let mockParams: Record<string, string> = {};
/** The clock of the render tests (a `mock…` name: jest.mock factories may read it). */
const mockNow = FIXED_NOW;
const mockPush = jest.fn<(href: unknown) => void>();
const mockReplace = jest.fn<(href: unknown) => void>();
const mockBack = jest.fn<() => void>();
const mockShow = jest.fn<(text: string, action?: { label?: string; onAction: () => void }) => void>();
const mockHaptics = jest.fn<(kind: string, enabled: boolean) => void>();

/** Run one reducer command on mockState; returns its result. */
function mockRun<I, R>(command: (s: DataStateV3, input: I, ctx: reducer.ReducerCtx) => { state: DataStateV3; result: R }, input: I): R {
  const step = command(mockState, input, testCtx(FIXED_NOW));
  mockState = step.state;
  return step.result;
}

const mockActions = {
  learn: jest.fn((cardIds: string[]) => mockRun(reducer.learn, { cardIds }).edit.id),
  markKnown: jest.fn((cardIds: string[]) => mockRun(reducer.markKnown, { cardIds }).edit.id),
  undoManualEdit: jest.fn((editId: string) => mockRun(reducer.undoManualEdit, { editId })),
};

jest.mock('../../store/selectors', () => {
  const actual = jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors');
  const scope = jest.requireActual<typeof import('../../domain/scope')>('../../domain/scope');
  return {
    ...actual,
    useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(mockState),
    useEngine: () => ({ store: { getState: () => mockState }, actions: mockActions }),
    useLibraryIndex: () => scope.libraryIndexOf(mockState),
    useReady: (q: Parameters<typeof scope.readyFor>[1]) => scope.readyFor(mockState, q, scope.matchCtxOf(mockState, mockNow)),
  };
});
jest.mock('../../store/SnackbarContext', () => ({
  useSnackbar: () => ({ show: mockShow, snack: null, dismiss: () => undefined }),
}));
jest.mock('../../platform/haptics', () => ({ haptics: (kind: string, enabled: boolean) => mockHaptics(kind, enabled) }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: mockBack, canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-native-gesture-handler', () => {
  const pan: Record<string, unknown> = {};
  for (const name of ['runOnJS', 'activeOffsetX', 'failOffsetY', 'onUpdate', 'onEnd']) pan[name] = () => pan;
  const pass = ({ children }: { children: React.ReactNode }) => children;
  return { Gesture: { Pan: () => pan }, GestureDetector: pass, GestureHandlerRootView: pass };
});
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// The OS "Reduce Motion" answer arrives later (a promise): fixed here, so no update lands outside act().
jest.mock('../../store/useReduceMotion', () => ({ useReduceMotion: () => false }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.clearAllMocks();
});

/** A deck of `n` Basic + reverse items, all Not started, in deck order n0, n1, … */
function screenState(n: number): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1', name: 'Words' });
  const groups = Array.from({ length: n }, (_, i) =>
    noteWithCards({
      deckId: 'd1',
      typeId: REVERSE,
      fields: [`word ${i}`, `meaning ${i}`, '', ''],
      note: { id: `n${i}`, order: i },
      card: () => lifeValues('notStarted'),
    }),
  );
  return stateOfV3({ decks: [deck], groups });
}

function renderTriage(state: DataStateV3, params: Record<string, string>): ReactTestRenderer {
  mockState = state;
  mockParams = params;
  act(() => {
    renderer = TestRenderer.create(React.createElement(TriageScreen));
  });
  return renderer!;
}

function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')));
}

function press(r: ReactTestRenderer, text: string): void {
  const nodes = r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text);
  for (const node of nodes) {
    let at: ReactTestInstance | null = node;
    while (at && typeof at.props.onPress !== 'function') at = at.parent;
    if (at) {
      const target = at;
      act(() => target.props.onPress());
      return;
    }
  }
  throw new Error(`nothing to press with text ${text}`);
}

/**
 * The bar's counter (wave 5c): the numbers on one line and the unit UNDER them
 * (two texts), read aloud as one label: "0 of 3 items".
 */
function expectCounter(r: ReactTestRenderer, count: string, unit: string | null): void {
  const all = texts(r);
  expect(all).toContain(count);
  const counter = r.root.findAll((n) => n.props.accessible === true && n.props.accessibilityLabel === `${count.replace(' / ', ' of ')}${unit ? ` ${unit}` : ''}`);
  expect(counter.length).toBeGreaterThan(0);
  const inCounter = counter[0]
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => String(n.props.children));
  expect(inCounter).toEqual(unit ? [count, unit] : [count]);
}

/** The status of the cards of one note in the store now. */
const lifeOfNote = (noteId: string) => mockState.cards.filter((c) => c.noteId === noteId).map(life);

const DECK_Q = JSON.stringify({ decks: ['d1'], life: ['notStarted'] });

describe('the triage screen (wiring)', () => {
  it('Learn / I know it / Later change every direction of the item; position and counters follow', () => {
    const r = renderTriage(screenState(3), { q: DECK_Q, from: 'deck' });
    // Wave 5b (M6): 3 items of 2 cards each — the counter names its unit.
    expectCounter(r, '0 / 3', 'items');
    expect(texts(r)).toContain('word 0');
    expect(texts(r)).toContain('meaning 0');
    press(r, 'Learn');
    expect(mockActions.learn.mock.calls[0][0]).toHaveLength(2);
    expect(lifeOfNote('n0')).toEqual(['new', 'new']);
    expect(mockHaptics).toHaveBeenCalledWith('tick', expect.any(Boolean));
    expectCounter(r, '1 / 3', 'items');
    expect(texts(r)).toContain('word 1');
    press(r, 'Later');
    expect(texts(r)).toContain('word 2');
    expect(texts(r)).toContain('1 to learn · 1 later');
    // Wave 5b review round 2: the bulk buttons name the unit like the counter.
    expect(texts(r)).toContain('Learn all 2 items left');
    expect(texts(r)).toContain('Mark all 2 items known');
    press(r, 'I know it');
    expect(lifeOfNote('n2')).toEqual(['known', 'known']);
    // Only the Later item is left: the run is done.
    expect(texts(r)).toContain('Done — 2 cards (1 item) added to your queue.');
    expect(texts(r)).toContain('2 cards (1 item) marked as known.');
    expect(texts(r)).toContain('1 item left for later — it stays Not started.');
    expect(lifeOfNote('n1')).toEqual(['notStarted', 'notStarted']);
  });

  it('Undo takes back the last choice in the store and in the run', () => {
    const r = renderTriage(screenState(2), { q: DECK_Q });
    press(r, 'Learn');
    expect(lifeOfNote('n0')).toEqual(['new', 'new']);
    press(r, 'Undo');
    expect(mockActions.undoManualEdit).toHaveBeenCalledTimes(1);
    expect(lifeOfNote('n0')).toEqual(['notStarted', 'notStarted']);
    expect(texts(r)).toContain('word 0');
    expectCounter(r, '0 / 2', 'items');
  });

  it('no Undo for a step whose edit left the undo log: the run is not taken back', () => {
    const r = renderTriage(screenState(3), { q: DECK_Q, from: 'deck' });
    press(r, 'Learn all 3 items left');
    expect(texts(r)).toContain('Done — 6 cards (3 items) added to your queue.');
    expect(texts(r)).toContain('Undo');
    // The edit leaves the log (too big for it, or 50 newer edits): the store
    // cannot take it back, so the screen offers no Undo.
    mockState = { ...mockState, manualLog: [] };
    act(() => r.update(React.createElement(TriageScreen)));
    expect(texts(r)).not.toContain('Undo');
    expect(texts(r)).toContain('Done — 6 cards (3 items) added to your queue.');
    expect(mockState.cards.every((c) => life(c) === 'new')).toBe(true);
  });

  it('Undo pressed after the edit left the log: nothing goes back, and the screen says so', () => {
    const r = renderTriage(screenState(2), { q: DECK_Q });
    press(r, 'Learn');
    expectCounter(r, '1 / 2', 'items');
    // The edit leaves the log while the button is still on screen.
    mockState = { ...mockState, manualLog: [] };
    press(r, 'Undo');
    expect(mockActions.undoManualEdit).not.toHaveBeenCalled();
    expect(mockShow).toHaveBeenCalledWith('This can no longer be undone');
    // The run and the store agree: n0 stays in the queue, and the run stays on the next item.
    expect(lifeOfNote('n0')).toEqual(['new', 'new']);
    expectCounter(r, '1 / 2', 'items');
    expect(texts(r)).toContain('word 1');
  });

  it('"Learn all {n} left", then the end: Study now opens the deck\'s session, Back to deck goes back', () => {
    const r = renderTriage(screenState(3), { q: DECK_Q, from: 'deck' });
    press(r, 'Learn all 3 items left');
    expect(mockActions.learn.mock.calls[0][0]).toHaveLength(6);
    expect(mockState.cards.every((c) => life(c) === 'new')).toBe(true);
    // The snackbar says the 3 of the button too (M6).
    expect(mockShow).toHaveBeenCalledWith('6 cards (3 items) added to your queue');
    expect(texts(r)).toContain('Done — 6 cards (3 items) added to your queue.');
    press(r, 'Study now');
    const route = mockReplace.mock.calls[0][0] as { pathname: string; params: Record<string, string> };
    expect(route.pathname).toBe('/session');
    expect(JSON.parse(route.params.q)).toEqual({ decks: ['d1'] });
    press(r, 'Back to deck');
    expect(mockBack).toHaveBeenCalled();
  });

  it('"Where do you start?" is offered once: not when the deck page answered it already (placed=1)', () => {
    // A German deck with real levels A1, A2, B1 (the Level field of the built-in card type).
    const deck = makeDeckV3({ id: 'd1', name: 'German' });
    const groups = ['A1', 'A2', 'B1', 'B1'].map((level, i) => {
      const fields = Array<string>(10).fill('');
      fields[0] = `wort ${i}`;
      fields[1] = `word ${i}`;
      fields[5] = level;
      return noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.legacyVocabDe, fields, note: { id: `n${i}`, order: i }, card: () => lifeValues('notStarted') });
    });
    const state = stateOfV3({ decks: [deck], groups });
    // Opened from "Choose what to learn" (no placement yet): offered.
    const plain = renderTriage(state, { q: DECK_Q, from: 'deck' });
    expect(texts(plain)).toContain('Where do you start?');
    act(() => plain.unmount());
    renderer = null;
    // Opened by the deck page's "Where do you start?" → "Start at A2": not asked again.
    const placed = renderTriage(state, { q: DECK_Q, from: 'deck', placed: '1' });
    expect(texts(placed)).not.toContain('Where do you start?');
    // The run itself is the same.
    expectCounter(placed, '0 / 4', null);
  });

  it('nothing Not started: "Nothing left to choose here."; without from=deck, Back to deck opens the deck page', () => {
    const state = screenState(1);
    const r = renderTriage({ ...state, cards: state.cards.map((c) => ({ ...c, newState: 'queued' as const })) }, { q: DECK_Q });
    expect(texts(r)).toContain('Nothing left to choose here.');
    act(() => r.unmount());
    renderer = null;
    const again = renderTriage(screenState(1), { q: DECK_Q });
    press(again, 'Mark all 1 item known');
    expect(lifeOfNote('n0')).toEqual(['known', 'known']);
    press(again, 'Back to deck');
    expect(mockReplace).toHaveBeenLastCalledWith({ pathname: '/deck/[id]', params: { id: 'd1' } });
  });
});

describe('wave 5c — the counter never takes the title\'s room; the title names chips like the Library', () => {
  it('positionParts: the numbers, and the unit apart (positionLabel is the two together)', () => {
    const state = deckState(4);
    const items = triageItems(state.cards, lookupOf(state));
    const two = startRun(items);
    expect(positionParts(two)).toEqual({ count: '0 / 4', unit: 'items', a11y: '0 of 4 items' });
    expect(positionLabel(two)).toBe('0 / 4 items');
    const one = startRun(items.slice(0, 1));
    expect(positionParts(one)).toEqual({ count: '0 / 1', unit: 'item', a11y: '0 of 1 item' });
    const single = startRun(items.map((i) => ({ ...i, cardIds: [i.cardIds[0]] })));
    expect(positionParts(single)).toEqual({ count: '0 / 4', unit: null, a11y: '0 of 4' });
    expect(positionLabel(single)).toBe('0 / 4');
    // Big numbers keep their thousands separators.
    const many = { ...two, total: 8970, cards: 17940, queue: two.queue };
    expect(positionParts(many).count).toBe(`${(8970 - 4).toLocaleString('en-US')} / 8,970`);
  });

  it('the bar draws the unit UNDER the numbers, and the counter is at most 30 % of the screen wide', () => {
    const r = renderTriage(screenState(3), { q: DECK_Q, from: 'deck' });
    expectCounter(r, '0 / 3', 'items');
    const counter = r.root.findAll((n) => n.props.accessible === true && n.props.accessibilityLabel === '0 of 3 items')[0];
    const style = StyleSheet.flatten(counter.props.style) as { maxWidth?: number };
    expect(style.maxWidth).toBe(Math.round(Dimensions.get('window').width * 0.3));
    // The numbers shrink to fit that width instead of growing past it.
    const numbers = counter.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === '0 / 3')[0];
    expect(numbers.props.numberOfLines).toBe(1);
    expect(numbers.props.adjustsFontSizeToFit).toBe(true);
  });

  it('the title line names a field and a Direction chip EXACTLY like the Library chip row (walkthrough M8)', () => {
    // Two card types with different template names share the two directions; a CamelCase field.
    const verbs: NoteType = {
      id: 'nt-verbs',
      name: 'German Verbs (bidirectional)',
      kind: 'standard',
      fields: [
        { name: 'Verb', role: 'term', facet: 'off' },
        { name: 'Meaning', role: 'meaning', facet: 'off' },
        { name: 'Tags', role: 'badge', facet: 'on', multiSep: ',' },
        { name: 'VerbClass', role: 'badge', facet: 'on' },
      ],
      templates: [
        { ord: 0, name: 'Forward', prompt: [0], answer: [1] },
        { ord: 1, name: 'Reverse', prompt: [1], answer: [0] },
      ],
      sortField: 0,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    const words: NoteType = {
      ...verbs,
      id: 'nt-words',
      name: 'German Vocabulary',
      fields: verbs.fields.slice(0, 2),
      templates: [
        { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
        { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
      ],
    };
    const groups = [
      noteWithCards({ deckId: 'd1', typeId: verbs.id, fields: ['gehen', 'to go', 'irregular, sein', 'strong'], note: { id: 'v1', tags: ['verbs'] }, card: () => lifeValues('notStarted') }, [verbs]),
      noteWithCards({ deckId: 'd1', typeId: verbs.id, fields: ['machen', 'to make', 'regular', 'weak'], note: { id: 'v2' }, card: () => lifeValues('notStarted') }, [verbs]),
      noteWithCards({ deckId: 'd1', typeId: words.id, fields: ['das Haus', 'the house'], note: { id: 'w1' }, card: () => lifeValues('notStarted') }, [words]),
    ];
    const state = stateOfV3({ decks: [makeDeckV3({ id: 'd1', name: 'German' })], groups, types: [verbs, words] });
    const q = { decks: ['d1'], fields: { tags: ['irregular'], verbclass: ['strong'] }, directions: [1], life: ['notStarted'] };
    const r = renderTriage(state, { q: JSON.stringify(q) });
    // The Library's names: "Tags (German Verbs)" (not "Tags (field)"), "Verb Class" (not
    // "VerbClass") and "Back → Front" (not "Reverse / EN-DE").
    expect(texts(r)).toContain('German · Tags (German Verbs): irregular · Verb Class: strong · Direction: Back → Front');
    // One item ("gehen"): both of its directions come along, so the counter names the unit.
    expectCounter(r, '0 / 1', 'item');
  });
});
