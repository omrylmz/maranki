/**
 * The manual-edit log (spec §3.4 ManualEdit, §3.6 undo rule, unit W2-7).
 * The load-bearing properties:
 *   - caps: at most 50 edits and 20,000 snapshots; the oldest edits go first;
 *     an edit that alone is too big is not kept (and the older ones stay);
 *   - undo reverts ONLY the cards that still have the `after` values, and
 *     counts the rest (the partial-undo snackbar uses both numbers);
 *   - study guards: a card that was studied since the edit is skipped, also
 *     when the rating did not touch the edited keys (learn → rate, markKnown
 *     → passed Check); flags edits are not guarded;
 *   - undo never reads or writes `reviewLog` (§3.12 "Manual edits never
 *     break session undo") and never changes its input;
 *   - `before` / `after` never hold `undefined`, so the log survives a JSON
 *     save and load and still undoes correctly.
 */
import { describe, expect, it } from '@jest/globals';

import {
  CARD_PATCH_KEYS,
  diffCard,
  editCards,
  MANUAL_LOG_MAX_EDITS,
  MANUAL_LOG_MAX_SNAPSHOTS,
  matchesPatch,
  partialUndoMessage,
  pushManualEdit,
  readPatchValue,
  snapshotCount,
  undoManualEdit,
} from './manualLog';
import type { Card, CardPatch, DataStateV3, ManualEdit } from './model';
import { learn, markKnown, resetProgress, setFlags } from './triage';
import { DAY } from './types';
import { FIXED_NOW } from '../test/clock';
import {
  cardInLifeV3,
  deepReadOnly,
  makeCardV3,
  makeDeckV3,
  makeStateV3,
  noteWithCards,
  stateOfV3,
  stateProblemsV3,
  testCtx,
} from '../test/factoriesV3';

/** An edit with `n` card snapshots (ids e<i>-c<k>). */
function editOf(id: string, n: number): ManualEdit {
  return {
    id,
    at: FIXED_NOW,
    kind: 'flags',
    label: `${n} cards`,
    cards: Array.from({ length: n }, (_, k) => ({ id: `${id}-c${k}`, before: { fav: false }, after: { fav: true } })),
  };
}

/** A small library: one deck, three Basic notes with one New card each. */
function library(): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1' });
  const groups = ['a', 'b', 'c'].map((x) =>
    noteWithCards({ deckId: 'd1', note: { id: `n-${x}` }, card: { id: `c-${x}` } }),
  );
  return stateOfV3({ decks: [deck], groups });
}

const card = (state: Pick<DataStateV3, 'cards'>, id: string): Card => {
  const found = state.cards.find((c) => c.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
};

/* ------------------------------------------------------- patch values */

describe('patch values', () => {
  it('reads an absent key as its meaning, so a snapshot never holds undefined', () => {
    const c = makeCardV3({ id: 'x' });
    expect(c.newState).toBeUndefined();
    expect(readPatchValue(c, 'newState')).toBe('queued');
    expect(readPatchValue(c, 'knownAt')).toBeNull();
    expect(readPatchValue({ ...c, fav: undefined }, 'fav')).toBe(false);
  });

  it('lists every CardPatch key', () => {
    // Compile-time: a CardPatch key missing from this object is an error.
    const all: Record<keyof CardPatch, true> = {
      fav: true, flagged: true, suspended: true, deckId: true, newState: true, newPos: true,
      knownAt: true, knownCheckedAt: true, ease: true, intervalDays: true, stepIndex: true,
      reps: true, lapses: true, due: true, lastReviewedAt: true, buriedUntil: true,
    };
    expect([...CARD_PATCH_KEYS].sort()).toEqual(Object.keys(all).sort());
  });

  it('diffCard keeps only the keys that really change', () => {
    const c = makeCardV3({ id: 'x', fav: true });
    expect(diffCard(c, { fav: true, knownAt: 5, newState: 'queued' })).toEqual({
      before: { knownAt: null },
      after: { knownAt: 5 },
    });
    expect(diffCard(c, { fav: true })).toBeNull();
    // An `undefined` in the wanted patch means "no wish", never "write undefined".
    expect(diffCard(c, { fav: undefined })).toBeNull();
  });

  it('matchesPatch compares with absent keys read as their meaning', () => {
    const c = makeCardV3({ id: 'x' });
    expect(matchesPatch(c, { newState: 'queued', knownAt: null })).toBe(true);
    expect(matchesPatch(c, { knownAt: 1 })).toBe(false);
  });
});

/* -------------------------------------------------------------- caps */

describe('pushManualEdit caps', () => {
  it('keeps at most 50 edits: the oldest leave first', () => {
    let log: ManualEdit[] = [];
    for (let i = 1; i <= MANUAL_LOG_MAX_EDITS + 1; i++) log = pushManualEdit(log, editOf(`e${i}`, 1)).log;
    expect(log).toHaveLength(MANUAL_LOG_MAX_EDITS);
    expect(log[0].id).toBe('e2');
    expect(log[log.length - 1].id).toBe(`e${MANUAL_LOG_MAX_EDITS + 1}`);
  });

  it('keeps at most 20,000 snapshots in total: the oldest leave until the new edit fits', () => {
    const log = [editOf('e1', 8_000), editOf('e2', 8_000)];
    const pushed = pushManualEdit(log, editOf('e3', 8_000));
    expect(pushed.stored).toBe(true);
    expect(pushed.log.map((e) => e.id)).toEqual(['e2', 'e3']);
    expect(pushed.log.reduce((n, e) => n + snapshotCount(e), 0)).toBeLessThanOrEqual(MANUAL_LOG_MAX_SNAPSHOTS);
    // The input log is not changed.
    expect(log.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('an edit of exactly 20,000 snapshots fits (it empties the log)', () => {
    const pushed = pushManualEdit([editOf('e1', 1)], editOf('big', MANUAL_LOG_MAX_SNAPSHOTS));
    expect(pushed.stored).toBe(true);
    expect(pushed.log.map((e) => e.id)).toEqual(['big']);
  });

  it('does not keep an edit larger than the cap, and keeps the older edits', () => {
    const log = [editOf('e1', 3)];
    const pushed = pushManualEdit(log, editOf('huge', MANUAL_LOG_MAX_SNAPSHOTS + 1));
    expect(pushed.stored).toBe(false);
    expect(pushed.log).toBe(log);
  });

  it('does not keep an empty edit (nothing to undo)', () => {
    const log = [editOf('e1', 3)];
    expect(pushManualEdit(log, editOf('empty', 0))).toEqual({ log, stored: false });
  });

  it('counts note snapshots too (a tag edit on many notes is capped as well)', () => {
    const tagEdit: ManualEdit = {
      id: 'tags',
      at: FIXED_NOW,
      kind: 'tags',
      label: '',
      cards: [],
      notes: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, before: { tags: [] }, after: { tags: ['x'] } })),
    };
    expect(snapshotCount(tagEdit)).toBe(5);
  });

  it('trims a stored log that is already over the caps (old data) on the next push', () => {
    const tooLong = Array.from({ length: 60 }, (_, i) => editOf(`e${i}`, 1));
    const pushed = pushManualEdit(tooLong, editOf('new', 1));
    expect(pushed.log).toHaveLength(MANUAL_LOG_MAX_EDITS);
    expect(pushed.log[pushed.log.length - 1].id).toBe('new');
  });

  it('a command on a big selection keeps the log inside both caps', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const cards = Array.from({ length: 12_000 }, (_, i) => makeCardV3({ id: `c${i}`, noteId: `n${i}`, deckId: 'd1' }));
    let state = makeStateV3({ decks: [deck], cards });
    const ctx = testCtx();
    const ids = cards.map((c) => c.id);
    state = markKnown(state, { cardIds: ids }, ctx).state;
    expect(state.manualLog).toHaveLength(1);
    state = setFlags(state, { cardIds: ids, patch: { fav: true } }, ctx).state;
    // 12,000 + 12,000 > 20,000: the first edit had to leave.
    expect(state.manualLog.map((e) => e.kind)).toEqual(['flags']);
  });
});

/* ---------------------------------------------------------- editCards */

describe('editCards', () => {
  it('changes only the planned keys, records before/after, and keeps unchanged cards as the same objects', () => {
    const state = deepReadOnly(library());
    const step = editCards(
      state,
      { cardIds: ['c-a', 'c-b'], kind: 'flags', plan: () => ({ flagged: true }), label: (n) => `${n} flagged` },
      testCtx(),
    );
    expect(step.result.edit.cards).toEqual([
      { id: 'c-a', before: { flagged: false }, after: { flagged: true } },
      { id: 'c-b', before: { flagged: false }, after: { flagged: true } },
    ]);
    expect(step.result.edit.label).toBe('2 flagged');
    expect(step.result.undoable).toBe(true);
    expect(step.state.manualLog).toEqual([step.result.edit]);
    expect(card(step.state, 'c-c')).toBe(card(state, 'c-c'));
    expect(step.state.notes).toBe(state.notes);
    expect(card(step.state, 'c-a')).toEqual({ ...card(state, 'c-a'), flagged: true });
  });

  it('ignores unknown ids, handles a repeated id once, and counts refused cards', () => {
    const state = deepReadOnly(library());
    const step = editCards(
      state,
      {
        cardIds: ['c-a', 'c-a', 'nope', 'c-b'],
        kind: 'notStarted',
        plan: (c) => (c.id === 'c-b' ? 'skip' : { newState: 'notStarted' }),
        label: (n) => `${n}`,
      },
      testCtx(),
    );
    expect(step.result.edit.cards.map((e) => e.id)).toEqual(['c-a']);
    expect(step.result.skipped).toBe(1);
  });

  it('followers are recorded in the same edit, but never counted in the label or in skipped', () => {
    const state = deepReadOnly(library());
    const step = editCards(
      state,
      {
        cardIds: ['c-a'],
        // 'c-a' is also chosen (a normal card); 'c-c' is refused: not counted, because nobody asked for it.
        followerIds: ['c-a', 'c-b', 'c-c'],
        kind: 'learn',
        plan: (c) => (c.id === 'c-c' ? 'skip' : { newPos: 1 }),
        label: (n) => `${n} counted`,
      },
      testCtx(),
    );
    expect(step.result.edit.cards.map((e) => e.id)).toEqual(['c-a', 'c-b']);
    expect(step.result.edit.label).toBe('1 counted');
    expect(step.result.skipped).toBe(0);
    expect(card(step.state, 'c-b').newPos).toBe(1);
  });

  it('when nothing changes, returns the same state and an empty, not-undoable edit', () => {
    const state = deepReadOnly(library());
    const step = editCards(
      state,
      { cardIds: ['c-a'], kind: 'flags', plan: () => ({ fav: false }), label: () => 'x' },
      testCtx(),
    );
    expect(step.state).toBe(state);
    expect(step.result.edit.cards).toEqual([]);
    expect(step.result.undoable).toBe(false);
  });
});

/* -------------------------------------------------------------- undo */

describe('undoManualEdit', () => {
  it('reverts every card that is unchanged since, and removes the edit from the log', () => {
    const state = deepReadOnly(library());
    const ctx = testCtx();
    const known = markKnown(state, { cardIds: ['c-a', 'c-b'] }, ctx);
    const undo = undoManualEdit(deepReadOnly(known.state), { editId: known.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 2, skipped: 0 });
    expect(undo.state.manualLog).toEqual([]);
    for (const id of ['c-a', 'c-b']) expect(readPatchValue(card(undo.state, id), 'knownAt')).toBeNull();
    expect(card(undo.state, 'c-c')).toBe(card(state, 'c-c'));
  });

  it('skips a card that was changed since (partial undo) and reports both counts', () => {
    const ctx = testCtx();
    const known = markKnown(library(), { cardIds: ['c-a', 'c-b', 'c-c'] }, ctx);
    // c-b failed a Check since: knownAt was cleared and it went to learning.
    const studied = {
      ...known.state,
      cards: known.state.cards.map((c) => (c.id === 'c-b' ? { ...c, knownAt: null, reps: 1, stepIndex: 0 } : c)),
    };
    const studiedView = deepReadOnly(studied);
    const undo = undoManualEdit(studiedView, { editId: known.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 2, skipped: 1 });
    expect(card(undo.state, 'c-b')).toBe(card(studiedView, 'c-b'));
    expect(partialUndoMessage(undo.result)).toBe('Undone for 2 cards. 1 was studied since and was not changed back.');
  });

  it('skips a card that was deleted since', () => {
    const ctx = testCtx();
    const flagged = setFlags(library(), { cardIds: ['c-a', 'c-b'], patch: { flagged: true } }, ctx);
    const gone = { ...flagged.state, cards: flagged.state.cards.filter((c) => c.id !== 'c-a') };
    const undo = undoManualEdit(gone, { editId: flagged.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 1, skipped: 1 });
    expect(stateProblemsV3(undo.state)).toEqual([]);
  });

  it('an unknown edit id (already undone, too old) changes nothing', () => {
    const state = deepReadOnly(library());
    const step = undoManualEdit(state, { editId: 'edit-nope' }, testCtx());
    expect(step.state).toBe(state);
    expect(step.result).toEqual({ found: false, reverted: 0, skipped: 0 });
  });

  it('an edit is undone once: the second undo finds nothing', () => {
    const ctx = testCtx();
    const known = markKnown(library(), { cardIds: ['c-a'] }, ctx);
    const first = undoManualEdit(known.state, { editId: known.result.edit.id }, ctx);
    const second = undoManualEdit(first.state, { editId: known.result.edit.id }, ctx);
    expect(second.result.found).toBe(false);
    expect(second.state).toBe(first.state);
  });

  it('undoes an OLDER edit and leaves the newer edits in the log', () => {
    const ctx = testCtx();
    const a = markKnown(library(), { cardIds: ['c-a'] }, ctx);
    const b = setFlags(a.state, { cardIds: ['c-b'], patch: { fav: true } }, ctx);
    const undo = undoManualEdit(b.state, { editId: a.result.edit.id }, ctx);
    expect(undo.result.reverted).toBe(1);
    expect(undo.state.manualLog.map((e) => e.id)).toEqual([b.result.edit.id]);
    expect(card(undo.state, 'c-b').fav).toBe(true);
  });

  it('never touches reviewLog or any key outside the note model (session undo stays intact)', () => {
    const base = library();
    const withLog: DataStateV3 = deepReadOnly({
      ...base,
      reviewLog: [
        {
          id: 'rl-1',
          seq: 1,
          cardId: 'c-a',
          deckId: 'd1',
          rating: 'good',
          atMs: FIXED_NOW,
          bucket: 'new',
          prev: {
            ease: 2.5, intervalDays: 0, stepIndex: null, reps: 0, lapses: 0, due: FIXED_NOW,
            lastReviewedAt: null, knownAt: null, knownCheckedAt: null, newState: 'queued',
          },
        },
      ],
    });
    const ctx = testCtx();
    const known = markKnown(withLog, { cardIds: ['c-a'] }, ctx);
    const undo = undoManualEdit(known.state, { editId: known.result.edit.id }, ctx);
    for (const s of [known.state, undo.state]) {
      expect(s.reviewLog).toBe(withLog.reviewLog);
      expect(s.person).toBe(withLog.person);
      expect(s.settings).toBe(withLog.settings);
    }
  });

  it('still undoes correctly after the log went through a JSON save and load', () => {
    const ctx = testCtx();
    const state = stateOfV3({
      decks: [makeDeckV3({ id: 'd1' })],
      groups: [
        { note: noteWithCards({ note: { id: 'n1' } }).note, cards: [cardInLifeV3('notStarted', { id: 'c1', noteId: 'n1', deckId: 'd1' })] },
      ],
    });
    const known = markKnown(state, { cardIds: ['c1'] }, ctx);
    const reloaded = JSON.parse(JSON.stringify(known.state)) as DataStateV3;
    const undo = undoManualEdit(reloaded, { editId: known.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 1, skipped: 0 });
    expect(readPatchValue(card(undo.state, 'c1'), 'knownAt')).toBeNull();
    expect(card(undo.state, 'c1').newState).toBe('notStarted');
  });

  it('counts a tag edit (notes only) in cards', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const g = noteWithCards({ deckId: 'd1', typeId: 'nt-basic-reverse', note: { id: 'n1', tags: ['a'] } });
    const tagged: DataStateV3 = {
      ...stateOfV3({ decks: [deck], groups: [g] }),
      notes: [{ ...g.note, tags: ['a', 'b'] }],
    };
    const edit: ManualEdit = {
      id: 'e-tags',
      at: FIXED_NOW,
      kind: 'tags',
      label: '2 cards tagged',
      cards: [],
      notes: [{ id: 'n1', before: { tags: ['a'] }, after: { tags: ['a', 'b'] } }],
    };
    const undo = undoManualEdit({ ...tagged, manualLog: [edit] }, { editId: 'e-tags' }, testCtx());
    expect(undo.result).toEqual({ found: true, reverted: 2, skipped: 0 });
    expect(undo.state.notes[0].tags).toEqual(['a']);
  });
});

/* ------------------------------------------------------- study guards */

describe('study guards: a card studied since the edit is skipped, also when the rating did not touch the edited keys', () => {
  const T = FIXED_NOW + 60_000;

  /** One deck, one note, one card `c1` in this status. */
  function oneCard(kind: Parameters<typeof cardInLifeV3>[0]): DataStateV3 {
    const g = noteWithCards({ note: { id: 'n1' } });
    return deepReadOnly(
      stateOfV3({
        decks: [makeDeckV3({ id: 'd1' })],
        groups: [{ note: g.note, cards: [cardInLifeV3(kind, { id: 'c1', noteId: 'n1', deckId: 'd1' })] }],
      }),
    );
  }

  /** The state after `change` was applied to card c1 (a rating, a Check, a session undo …). */
  function withCard(state: DataStateV3, change: (c: Card) => Card): DataStateV3 {
    return deepReadOnly({ ...state, cards: state.cards.map((c) => (c.id === 'c1' ? change(c) : c)) });
  }

  /** What a first "Good" rating does to a New card (the keys applyRating sets). */
  const rateNew = (c: Card): Card => ({ ...c, reps: c.reps + 1, stepIndex: 0, due: T + 600_000, lastReviewedAt: T });

  it('learn → rated → undo: skipped, and the studied card keeps newState "queued"', () => {
    const ctx = testCtx();
    const learned = learn(oneCard('notStarted'), { cardIds: ['c1'] }, ctx);
    // learn records only newState; a rating changes reps and lastReviewedAt, never newState.
    const studied = withCard(learned.state, rateNew);
    const undo = undoManualEdit(studied, { editId: learned.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 0, skipped: 1 });
    expect(card(undo.state, 'c1')).toBe(card(studied, 'c1'));
    expect(card(undo.state, 'c1').newState).toBe('queued');
    expect(partialUndoMessage(undo.result)).toBe('Undone for 0 cards. 1 was studied since and was not changed back.');
  });

  it('markKnown → Check passed → undo: skipped, the card stays Known with its Check', () => {
    const ctx = testCtx();
    const known = markKnown(oneCard('review'), { cardIds: ['c1'] }, ctx);
    // A passed Check sets knownCheckedAt only (spec §3.6: "stays Known; SRS untouched").
    const checked = withCard(known.state, (c) => ({ ...c, knownCheckedAt: T }));
    const undo = undoManualEdit(checked, { editId: known.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 0, skipped: 1 });
    expect(card(undo.state, 'c1')).toMatchObject({ knownAt: ctx.now, knownCheckedAt: T });
  });

  it('"In queue" on a Known card → rated → undo does not make the studied card Known again', () => {
    const ctx = testCtx();
    const queued = learn(oneCard('known'), { cardIds: ['c1'] }, ctx);
    const studied = withCard(queued.state, rateNew);
    const undo = undoManualEdit(studied, { editId: queued.result.edit.id }, ctx);
    expect(undo.result.skipped).toBe(1);
    expect(card(undo.state, 'c1').knownAt).toBeNull();
  });

  it('a rating that the session took back (every value as before) no longer blocks the undo', () => {
    const ctx = testCtx();
    const learned = learn(oneCard('notStarted'), { cardIds: ['c1'] }, ctx);
    const before = card(learned.state, 'c1');
    const studied = withCard(learned.state, rateNew);
    // undoLastReview restores the `prev` snapshot of the rating.
    const sessionUndone = withCard(studied, () => ({ ...before }));
    const undo = undoManualEdit(sessionUndone, { editId: learned.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 1, skipped: 0 });
    expect(card(undo.state, 'c1').newState).toBe('notStarted');
  });

  it('flags edits have no guard: taking back a favorite after a review still works', () => {
    const ctx = testCtx();
    const fav = setFlags(oneCard('new'), { cardIds: ['c1'], patch: { fav: true } }, ctx);
    expect(fav.result.edit.cards[0]).toEqual({ id: 'c1', before: { fav: false }, after: { fav: true } });
    const studied = withCard(fav.state, rateNew);
    const undo = undoManualEdit(studied, { editId: fav.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 1, skipped: 0 });
    expect(card(undo.state, 'c1')).toMatchObject({ fav: false, reps: 1, lastReviewedAt: T });
  });

  it('records the guards in before AND after, never writes them to the card, and they survive JSON', () => {
    const ctx = testCtx();
    const state = oneCard('notStarted');
    expect('knownCheckedAt' in card(state, 'c1')).toBe(false);
    const learned = learn(state, { cardIds: ['c1'] }, ctx);
    const guards = { reps: 0, lastReviewedAt: null, knownCheckedAt: null };
    expect(learned.result.edit.cards).toEqual([
      { id: 'c1', before: { newState: 'notStarted', ...guards }, after: { newState: 'queued', ...guards } },
    ]);
    // The card gets the real change only: no new keys.
    expect(card(learned.state, 'c1')).toEqual({ ...card(state, 'c1'), newState: 'queued' });
    expect('knownCheckedAt' in card(learned.state, 'c1')).toBe(false);
    // Undo after a JSON save and load writes back the real change only.
    const reloaded = JSON.parse(JSON.stringify(learned.state)) as DataStateV3;
    const undo = undoManualEdit(reloaded, { editId: learned.result.edit.id }, ctx);
    expect(undo.result).toEqual({ found: true, reverted: 1, skipped: 0 });
    expect(card(undo.state, 'c1')).toEqual(card(state, 'c1'));
    expect('knownCheckedAt' in card(undo.state, 'c1')).toBe(false);
  });

  it('a guard key the edit changes itself keeps its real before/after (resetProgress)', () => {
    const ctx = testCtx(T);
    const reset = resetProgress(oneCard('review'), { cardIds: ['c1'] }, ctx);
    const entry = reset.result.edit.cards[0];
    expect(entry.before).toMatchObject({ reps: 4, lastReviewedAt: FIXED_NOW - 3 * DAY, knownCheckedAt: null });
    expect(entry.after).toMatchObject({ reps: 0, lastReviewedAt: null, knownCheckedAt: null });
  });
});

describe('partialUndoMessage', () => {
  it('is null when every card was changed back', () => {
    expect(partialUndoMessage({ reverted: 4, skipped: 0 })).toBeNull();
  });

  it('uses the spec copy, with plural forms', () => {
    expect(partialUndoMessage({ reverted: 9, skipped: 3 })).toBe(
      'Undone for 9 cards. 3 were studied since and were not changed back.',
    );
    expect(partialUndoMessage({ reverted: 1, skipped: 1 })).toBe(
      'Undone for 1 card. 1 was studied since and was not changed back.',
    );
  });
});
