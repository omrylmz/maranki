/**
 * The card-state commands (spec §3.6, §8.4 CardSheet, §8.5 Triage, unit W2-7).
 * The load-bearing properties:
 *   - learn: Not started → New; a Known card leaves Known; `first` puts the
 *     cards in front of the deck's feed (siblings share one position);
 *   - markKnown sets `knownAt` ONLY, and a Known card is never mastered;
 *   - setNotStarted refuses studied cards and reports them;
 *   - resetProgress gives a studied card a new card's schedule;
 *   - reschedule writes `due` only, and only for studied, not-Known cards;
 *   - each command returns a ManualEdit with each card's before/after, and
 *     "do, then undo" gives every card its old values back.
 */
import { describe, expect, it } from '@jest/globals';

import { isMastered, life } from './life';
import {
  CARD_PATCH_KEYS,
  type EditResult,
  type OpStep,
  readPatchValue,
  STUDY_GUARD_KEYS,
  undoManualEdit,
} from './manualLog';
import type { Card, CardPatch, DataStateV3, LifeKey } from './model';
import { learn, markKnown, reschedule, resetProgress, setFlags, setNotStarted } from './triage';
import { DAY } from './types';
import { FIXED_NOW } from '../test/clock';
import {
  cardInLifeV3,
  deepReadOnly,
  lifeValues,
  makeDeckV3,
  makeNoteV3,
  noteWithCards,
  randomStateV3,
  stateOfV3,
  stateProblemsV3,
  testCtx,
  threeWayType,
} from '../test/factoriesV3';
import { createRandom } from '../test/random';

const LIVES: readonly LifeKey[] = ['notStarted', 'new', 'learning', 'review', 'mastered', 'known'];

/** One deck 'd1' with one Basic note + card per status: card id = 'c-<status>'. */
function onePerLife(): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1' });
  const groups = LIVES.map((kind, i) => {
    const note = makeNoteV3({ id: `n-${kind}`, order: 100 + i });
    return { note, cards: [cardInLifeV3(kind, { id: `c-${kind}`, noteId: note.id, deckId: 'd1', newPos: note.order })] };
  });
  return deepReadOnly(stateOfV3({ decks: [deck], groups }));
}

const card = (state: Pick<DataStateV3, 'cards'>, id: string): Card => {
  const found = state.cards.find((c) => c.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
};

/** Every CardPatch value of a card (absent keys read as their meaning). */
const patchValues = (c: Card) => Object.fromEntries(CARD_PATCH_KEYS.map((k) => [k, readPatchValue(c, k)]));

/** The study guards editCards records with a card entry: the card's values, the same in `before` and `after`. */
const guardsOf = (c: Card): CardPatch =>
  Object.fromEntries(STUDY_GUARD_KEYS.map((k) => [k, readPatchValue(c, k)])) as CardPatch;

/** The keys an entry really changes (a guard key has the same value on both sides). */
const changedKeys = (entry: { before: CardPatch; after: CardPatch }): string[] =>
  (Object.keys(entry.after) as (keyof CardPatch)[]).filter((k) => entry.before[k] !== entry.after[k]);

/* --------------------------------------------------------------- learn */

describe('learn', () => {
  it('Not started → New, recorded as a ManualEdit with before/after', () => {
    const state = onePerLife();
    const step = learn(state, { cardIds: ['c-notStarted'] }, testCtx());
    expect(life(card(step.state, 'c-notStarted'))).toBe('new');
    expect(step.result.edit).toMatchObject({
      kind: 'learn',
      label: '1 card added to your queue',
      cards: [{ id: 'c-notStarted', before: { newState: 'notStarted' }, after: { newState: 'queued' } }],
    });
    expect(step.result.undoable).toBe(true);
    expect(step.state.manualLog).toEqual([step.result.edit]);
  });

  it('a Known card leaves Known ("In queue"); a studied Known card goes back to its schedule', () => {
    const studiedKnown = cardInLifeV3('review', { id: 'c-rk', noteId: 'n-x', deckId: 'd1', knownAt: FIXED_NOW - DAY, knownCheckedAt: FIXED_NOW });
    const state = deepReadOnly(
      stateOfV3({
        decks: [makeDeckV3({ id: 'd1' })],
        groups: [{ note: makeNoteV3({ id: 'n-x' }), cards: [studiedKnown] }],
      }),
    );
    const step = learn(state, { cardIds: ['c-rk'] }, testCtx());
    const after = card(step.state, 'c-rk');
    expect(life(after)).toBe('review');
    expect(after.knownAt).toBeNull();
    expect(after.knownCheckedAt).toBeNull();
    expect(after.due).toBe(studiedKnown.due);
  });

  it('does not change cards already in the queue', () => {
    const state = onePerLife();
    const step = learn(state, { cardIds: ['c-new', 'c-learning', 'c-review', 'c-mastered'] }, testCtx());
    expect(step.state).toBe(state);
    expect(step.result.undoable).toBe(false);
    expect(step.result.edit.label).toBe('0 cards added to your queue');
  });

  it('first: the cards move in front of the whole deck feed, in their order, siblings sharing one position', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const types = 'nt-basic-reverse';
    const early = noteWithCards({ deckId: 'd1', typeId: types, note: { id: 'n1', order: 10 } });
    const a = noteWithCards({ deckId: 'd1', typeId: types, note: { id: 'n2', order: 40 }, card: { newState: 'notStarted' } });
    const b = noteWithCards({ deckId: 'd1', typeId: types, note: { id: 'n3', order: 20 }, card: { newState: 'notStarted' } });
    const state = deepReadOnly(stateOfV3({ decks: [deck], groups: [early, a, b] }));
    const ids = [...a.cards, ...b.cards].map((c) => c.id);
    const step = learn(state, { cardIds: ids, first: true }, testCtx());
    const pos = (noteId: string) => step.state.cards.filter((c) => c.noteId === noteId).map((c) => c.newPos);
    // b (order 20) stays before a (order 40); both before n1 (newPos 10).
    expect(pos('n3')).toEqual([8, 8]);
    expect(pos('n2')).toEqual([9, 9]);
    expect(pos('n1')).toEqual([10, 10]);
    expect(step.state.cards.filter((c) => ids.includes(c.id)).every((c) => life(c) === 'new')).toBe(true);
  });

  it('first on ONE direction: its never-studied siblings get the same feed position and nothing else', () => {
    // One three-direction note (order 40): ords 0 and 1 Not started, ord 2 already studied.
    const type = threeWayType();
    const g = noteWithCards(
      {
        deckId: 'd1',
        typeId: type.id,
        note: { id: 'n1', order: 40 },
        card: (ord) => ({ id: `c${ord}`, ...(ord === 2 ? lifeValues('review') : { newState: 'notStarted' as const }) }),
      },
      [type],
    );
    const state = deepReadOnly(stateOfV3({ decks: [makeDeckV3({ id: 'd1' })], groups: [g], types: [type] }));
    const step = learn(state, { cardIds: ['c0'], first: true }, testCtx());
    // c0 (chosen) is New in front of the deck; c1 shares its position but stays Not started.
    expect(card(step.state, 'c0')).toMatchObject({ newPos: 39, newState: 'queued' });
    expect(card(step.state, 'c1')).toMatchObject({ newPos: 39, newState: 'notStarted' });
    expect(life(card(step.state, 'c1'))).toBe('notStarted');
    // A studied sibling keeps its schedule, so it does not move.
    expect(card(step.state, 'c2')).toBe(card(state, 'c2'));
    // The sibling is in the same edit (Undo moves it back too), but only the chosen card is counted.
    // Each entry also holds the study guards (never studied: reps 0, no review, no Check).
    const guards = { reps: 0, lastReviewedAt: null, knownCheckedAt: null };
    expect(step.result.edit.cards).toEqual([
      {
        id: 'c0',
        before: { newState: 'notStarted', newPos: 40, ...guards },
        after: { newState: 'queued', newPos: 39, ...guards },
      },
      { id: 'c1', before: { newPos: 40, ...guards }, after: { newPos: 39, ...guards } },
    ]);
    expect(step.result.edit.label).toBe('1 card added to your queue');
    expect(step.result.skipped).toBe(0);
    const undo = undoManualEdit(step.state, { editId: step.result.edit.id }, testCtx());
    expect(undo.result).toEqual({ found: true, reverted: 2, skipped: 0 });
    expect(undo.state.cards).toEqual(state.cards);
  });

  it('without first, the feed position is unchanged (the card joins the queue in deck order)', () => {
    const state = onePerLife();
    const step = learn(state, { cardIds: ['c-notStarted'] }, testCtx());
    expect(card(step.state, 'c-notStarted').newPos).toBe(card(state, 'c-notStarted').newPos);
  });
});

/* ----------------------------------------------------------- markKnown */

describe('markKnown', () => {
  it('sets knownAt = now and NOTHING else; a Known card is never mastered', () => {
    const state = onePerLife();
    const ctx = testCtx(FIXED_NOW + 5);
    const step = markKnown(state, { cardIds: ['c-mastered', 'c-new', 'c-notStarted'] }, ctx);
    for (const id of ['c-mastered', 'c-new', 'c-notStarted']) {
      const before = card(state, id);
      const after = card(step.state, id);
      expect(after).toEqual({ ...before, knownAt: ctx.now });
      expect(life(after)).toBe('known');
      expect(isMastered(after)).toBe(false);
    }
    // The edit changes knownAt only; the study guards hold each card's values, the same on both sides.
    expect(step.result.edit.cards.map(changedKeys)).toEqual([['knownAt'], ['knownAt'], ['knownAt']]);
    for (const e of step.result.edit.cards) {
      expect(e.after).toEqual({ knownAt: ctx.now, ...guardsOf(card(state, e.id)) });
    }
    expect(step.result.edit.cards.map((e) => e.id).sort()).toEqual(['c-mastered', 'c-new', 'c-notStarted']);
    expect(step.result.edit.label).toBe('3 cards marked as known');
  });

  it('keeps the first knownAt of a card that is already Known', () => {
    const state = onePerLife();
    const step = markKnown(state, { cardIds: ['c-known'] }, testCtx(FIXED_NOW + 99));
    expect(step.state).toBe(state);
    expect(card(step.state, 'c-known').knownAt).toBe(FIXED_NOW - DAY);
  });
});

/* ------------------------------------------------------- setNotStarted */

describe('setNotStarted', () => {
  it('moves never-studied cards to Not started; skips studied cards and reports them', () => {
    const state = onePerLife();
    const step = setNotStarted(state, { cardIds: LIVES.map((k) => `c-${k}`) }, testCtx());
    expect(step.result.skipped).toBe(3); // learning, review, mastered
    expect(life(card(step.state, 'c-new'))).toBe('notStarted');
    // A Known card that was never studied becomes Not started (Known cleared).
    expect(life(card(step.state, 'c-known'))).toBe('notStarted');
    expect(card(step.state, 'c-known').knownAt).toBeNull();
    for (const kind of ['learning', 'review', 'mastered']) {
      expect(card(step.state, `c-${kind}`)).toBe(card(state, `c-${kind}`));
    }
    expect(step.result.edit.cards.map((e) => e.id)).toEqual(['c-new', 'c-known']);
    expect(step.result.edit.label).toBe('2 cards moved back to Not started');
  });
});

/* ------------------------------------------------------- resetProgress */

describe('resetProgress', () => {
  it('gives a studied card the schedule of a new card, clears Known, keeps flags and feed position', () => {
    const studied = cardInLifeV3('mastered', {
      id: 'c1', noteId: 'n1', deckId: 'd1', fav: true, newPos: 77, knownAt: FIXED_NOW - DAY, knownCheckedAt: FIXED_NOW,
    });
    const state = deepReadOnly(
      stateOfV3({ decks: [makeDeckV3({ id: 'd1' })], groups: [{ note: makeNoteV3({ id: 'n1' }), cards: [studied] }] }),
    );
    const ctx = testCtx(FIXED_NOW + 1_000);
    const step = resetProgress(state, { cardIds: ['c1'] }, ctx);
    const after = card(step.state, 'c1');
    expect(after).toMatchObject({
      ease: state.settings.srs.startingEase,
      intervalDays: 0,
      stepIndex: null,
      reps: 0,
      lapses: 0,
      due: ctx.now,
      lastReviewedAt: null,
      knownAt: null,
      knownCheckedAt: null,
      fav: true,
      newPos: 77,
    });
    // An absent newState already means 'queued' (In queue), so it is not written.
    expect(readPatchValue(after, 'newState')).toBe('queued');
    expect(life(after)).toBe('new');
    expect(step.result.edit.kind).toBe('reset');
    expect(step.result.edit.label).toBe('1 card reset to New');
  });

  it('a Not started or Known card that was never studied becomes New; a New card does not change', () => {
    const state = onePerLife();
    const step = resetProgress(state, { cardIds: ['c-notStarted', 'c-known', 'c-new'] }, testCtx());
    expect(life(card(step.state, 'c-notStarted'))).toBe('new');
    expect(life(card(step.state, 'c-known'))).toBe('new');
    expect(card(step.state, 'c-new')).toBe(card(state, 'c-new'));
    // A never-studied card keeps its due: only the keys that change are written.
    expect(step.result.edit.cards.every((e) => !('due' in e.after))).toBe(true);
  });
});

/* ---------------------------------------------------------- reschedule */

describe('reschedule', () => {
  it('sets due only; interval and ease are unchanged', () => {
    const state = onePerLife();
    const due = FIXED_NOW + 7 * DAY;
    const step = reschedule(state, { cardIds: ['c-review', 'c-learning', 'c-mastered'], dueMs: due }, testCtx());
    for (const id of ['c-review', 'c-learning', 'c-mastered']) {
      expect(card(step.state, id)).toEqual({ ...card(state, id), due });
    }
    // The edit changes due only (the other keys of `after` are the study guards, equal to `before`).
    expect(step.result.edit.cards.map(changedKeys)).toEqual([['due'], ['due'], ['due']]);
    for (const e of step.result.edit.cards) {
      expect(Object.keys(e.after).sort()).toEqual(['due', ...STUDY_GUARD_KEYS].sort());
    }
    expect(step.result.edit.label).toBe('3 cards rescheduled');
  });

  it('skips New, Not started and Known cards ("Not studied yet — nothing to reschedule")', () => {
    const state = onePerLife();
    const step = reschedule(state, { cardIds: ['c-new', 'c-notStarted', 'c-known'], dueMs: FIXED_NOW + DAY }, testCtx());
    expect(step.state).toBe(state);
    expect(step.result.skipped).toBe(3);
  });

  it('a due that is not a finite number changes nothing', () => {
    const state = onePerLife();
    for (const dueMs of [NaN, Infinity]) {
      const step = reschedule(state, { cardIds: ['c-review'], dueMs }, testCtx());
      expect(step.state).toBe(state);
    }
  });
});

/* ------------------------------------------------------------ setFlags */

describe('setFlags', () => {
  it('sets only the given markers and words the snackbar', () => {
    const state = onePerLife();
    const step = setFlags(state, { cardIds: ['c-new', 'c-review'], patch: { suspended: true } }, testCtx());
    expect(card(step.state, 'c-new')).toEqual({ ...card(state, 'c-new'), suspended: true });
    expect(step.result.edit.label).toBe('2 cards suspended');
    const labels = [
      setFlags(state, { cardIds: ['c-new'], patch: { fav: true } }, testCtx()).result.edit.label,
      setFlags(state, { cardIds: ['c-new'], patch: { fav: false } }, testCtx()).result.edit.label,
      setFlags(state, { cardIds: ['c-new'], patch: { flagged: true } }, testCtx()).result.edit.label,
      setFlags(state, { cardIds: ['c-new'], patch: { flagged: true, fav: true } }, testCtx()).result.edit.label,
    ];
    expect(labels).toEqual([
      '1 card added to Favorites',
      '0 cards removed from Favorites',
      '1 card flagged',
      '1 card updated',
    ]);
  });

  it('accepts only marker keys: an SRS key is a compile error', () => {
    const state = onePerLife();
    // @ts-expect-error — setFlags must never write the schedule.
    setFlags(state, { cardIds: ['c-new'], patch: { due: 1 } }, testCtx());
    // @ts-expect-error — nor Known.
    setFlags(state, { cardIds: ['c-new'], patch: { knownAt: 1 } }, testCtx());
  });
});

/* ------------------------------------------------- do, then undo (property) */

type CardCommand = (state: DataStateV3, ids: string[]) => OpStep<DataStateV3, EditResult>;

describe('every command: do, then undo, gives back every card value (seeded random libraries)', () => {
  const ctx = testCtx(FIXED_NOW + 3_600_000);
  const commands: Record<string, CardCommand> = {
    learn: (s, ids) => learn(s, { cardIds: ids }, ctx),
    learnFirst: (s, ids) => learn(s, { cardIds: ids, first: true }, ctx),
    markKnown: (s, ids) => markKnown(s, { cardIds: ids }, ctx),
    setNotStarted: (s, ids) => setNotStarted(s, { cardIds: ids }, ctx),
    resetProgress: (s, ids) => resetProgress(s, { cardIds: ids }, ctx),
    reschedule: (s, ids) => reschedule(s, { cardIds: ids, dueMs: FIXED_NOW + 5 * DAY }, ctx),
    setFlags: (s, ids) => setFlags(s, { cardIds: ids, patch: { fav: true, suspended: false } }, ctx),
  };

  for (const [name, command] of Object.entries(commands)) {
    it(name, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const rnd = createRandom(`triage-${name}-${seed}`);
        const state = deepReadOnly(randomStateV3(rnd, { maxNotes: 20 }));
        const ids = rnd.sample(state.cards, rnd.int(0, state.cards.length)).map((c) => c.id);
        const done = command(state, ids);
        expect(stateProblemsV3(done.state)).toEqual([]);
        // Only the chosen cards may change. One exception (learn with `first`): a never-studied
        // sibling of a chosen card follows the note's new feed position, and changes NOTHING else.
        const chosen = new Set(ids);
        done.state.cards.forEach((c, i) => {
          if (chosen.has(c.id) || c === state.cards[i]) return;
          expect(name).toBe('learnFirst');
          expect(c.reps).toBe(0);
          expect(c).toEqual({ ...state.cards[i], newPos: c.newPos });
          const leader = done.state.cards.find(
            (s) => chosen.has(s.id) && s.noteId === c.noteId && s.deckId === c.deckId && s.reps === 0,
          );
          expect(leader?.newPos).toBe(c.newPos);
        });
        // The edit lists exactly the cards that changed, with their old and new values.
        for (const entry of done.result.edit.cards) {
          const before = card(state, entry.id);
          const after = card(done.state, entry.id);
          for (const [key, value] of Object.entries(entry.before)) {
            expect(readPatchValue(before, key as keyof typeof entry.before)).toEqual(value);
          }
          for (const [key, value] of Object.entries(entry.after)) {
            expect(readPatchValue(after, key as keyof typeof entry.after)).toEqual(value);
          }
        }
        if (!done.result.undoable) continue;
        const undone = undoManualEdit(deepReadOnly(done.state), { editId: done.result.edit.id }, ctx);
        expect(undone.result).toEqual({ found: true, reverted: done.result.edit.cards.length, skipped: 0 });
        expect(undone.state.cards.map(patchValues)).toEqual(state.cards.map(patchValues));
        expect(undone.state.manualLog).toEqual(state.manualLog);
      }
    });
  }
});
