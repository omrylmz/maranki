/**
 * The manual-edit log: undo for card and note changes made OUTSIDE a review
 * (spec §3.4 `ManualEdit`, §3.6 "ManualEdit undo rule", unit W2-7).
 *
 * WHY a separate log: `reviewLog` is the undo of a STUDY session. "Undo" in a
 * session must always take back the last rating. If a manual change (mark
 * known, reschedule, move …) went into `reviewLog`, a session undo could take
 * back the wrong thing. So manual changes go into `manualLog`, and these
 * functions never read or write `reviewLog` (invariant "Manual edits never
 * break session undo", spec §3.12).
 *
 * What is in this file:
 *   - the shared shapes of the pure note and triage commands (`NoteModelState`,
 *     `OpCtx`, `OpStep`, `EditResult`), so noteOps.ts and triage.ts use one shape;
 *   - `editCards`: the ONE way to change cards and record a ManualEdit;
 *   - `pushManualEdit`: add an edit to the log, inside the caps
 *     (≤ 50 edits and ≤ 20,000 snapshots in total);
 *   - `undoManualEdit`: take an edit back, but only for the cards that nobody
 *     changed since.
 *
 * The undo rule (spec §3.6): for each card, go back to `before` ONLY IF the
 * card's current values still equal `after` on those keys. Otherwise skip the
 * card. Example: you mark 10 cards Known, then study 1 of them in a Check and
 * miss it (knownAt becomes null). Undo then reverts 9 cards and skips 1:
 * "Undone for 9 cards. 1 was studied since and was not changed back."
 *
 * Study guards: a rating does not always touch the keys an edit changed
 * (learn changes `newState`; a passed Check sets only `knownCheckedAt`). So
 * every card entry also holds the GUARD keys `reps`, `lastReviewedAt` and
 * `knownCheckedAt`, with the same value in `before` and `after` (see
 * STUDY_GUARD_KEYS). A rating changes at least one of them, so a card that
 * was studied since no longer matches `after` and is skipped. A guard key is
 * never written back (its two values are equal).
 *
 * Pure: no React, no clock. Time and ids come in through `ctx`. The state is
 * NEVER changed in place: a changed card or note is a new object, every other
 * object keeps its identity (the row store saves by object identity, §3.8).
 */
import type { Card, CardPatch, Deck, Id, ManualEdit, ManualKind, Note, NoteType, SrsSettings } from './model';
import { plural } from './text';

/* -------------------------------------------------------- shared shapes */

/**
 * The parts of the v3 state (DataStateV3, src/domain/model.ts) that the note,
 * triage and undo commands read and write. A whole DataStateV3 fits this type.
 * Every command is generic over the state type `S`, so it returns the SAME
 * type it gets: pass a DataStateV3, get a DataStateV3 back (with every other
 * key, for example `reviewLog`, untouched).
 */
export interface NoteModelState {
  noteTypes: NoteType[];
  notes: Note[];
  cards: Card[];
  decks: Deck[];
  manualLog: ManualEdit[];
  /** Only `startingEase` is read: the ease of a new or reset card. */
  settings: { srs: Pick<SrsSettings, 'startingEase'> };
}

/**
 * The outside world of a command: the clock and an id maker. Same shape as
 * `ReducerCtx` (src/store/reducer.ts), so the reducer passes its ctx as it is.
 */
export interface OpCtx {
  /** The current time, epoch ms. */
  now: number;
  /** A new unique id that starts with `prefix`, for example 'c-lx3k9q-12'. */
  newId: (prefix: string) => string;
}

/** The output of one command: the next state and the command's return value. */
export interface OpStep<S, R> {
  state: S;
  result: R;
}

/** The id prefix of a ManualEdit. */
export const EDIT_ID_PREFIX = 'edit';

/** The most edits the log keeps (the oldest go first). */
export const MANUAL_LOG_MAX_EDITS = 50;

/**
 * The most snapshots the log keeps in total. One snapshot = one card entry or
 * one note entry of an edit (a tag change records notes, not cards, so notes
 * count too; otherwise a tag edit on 100,000 notes would have no limit).
 * 20,000 is enough for "Mark all 15,960 known" on the biggest real deck.
 */
export const MANUAL_LOG_MAX_SNAPSHOTS = 20_000;

/**
 * What a command that records a ManualEdit returns.
 *
 * `edit` is ALWAYS there (also when nothing changed), so the reducer can
 * always return `edit.id` for the snackbar "Undo". When `undoable` is false,
 * `undoManualEdit(edit.id)` simply finds nothing and changes nothing.
 */
export interface EditResult {
  /** The edit, with every changed card's (and note's) `before` and `after` values. */
  edit: ManualEdit;
  /**
   * True when the edit is in `manualLog`, so Undo can take it back. False when
   * nothing changed, or when the edit alone is larger than the log can keep
   * (more than MANUAL_LOG_MAX_SNAPSHOTS): the change still happened, the UI
   * just shows no Undo button.
   */
  undoable: boolean;
  /**
   * Cards that were asked for but that the command's rule refused, for
   * example studied cards in setNotStarted ("others are skipped and counted").
   * Missing ids are not counted.
   */
  skipped: number;
}

/* ---------------------------------------------------------- patch values */

/**
 * Every key of CardPatch, with the value that an ABSENT key means on a card.
 * `undefined` = a valid card always has this key.
 *
 *   fav / flagged / suspended  absent → false
 *   newState                   absent → 'queued' (= New, spec §3.4)
 *   knownAt / knownCheckedAt   absent → null
 *   buriedUntil                absent → null (not buried)
 *
 * The type lists every CardPatch key, so a new key in CardPatch is a compile
 * error here until it is added.
 */
const PATCH_KEY_ABSENT: { readonly [K in keyof Required<CardPatch>]: CardPatch[K] } = {
  fav: false,
  flagged: false,
  suspended: false,
  deckId: undefined,
  newState: 'queued',
  newPos: undefined,
  knownAt: null,
  knownCheckedAt: null,
  ease: undefined,
  intervalDays: undefined,
  stepIndex: undefined,
  reps: undefined,
  lapses: undefined,
  due: undefined,
  lastReviewedAt: undefined,
  buriedUntil: null,
};

/** Every key a ManualEdit may change on a card. */
export const CARD_PATCH_KEYS = Object.freeze(Object.keys(PATCH_KEY_ABSENT)) as readonly (keyof CardPatch)[];

/** One value of a CardPatch (a boolean, number, string or null). */
type PatchValue = CardPatch[keyof CardPatch];

/**
 * The value of `key` on `card`, with an absent key read as its meaning
 * (absent newState → 'queued', absent knownAt → null …).
 *
 * WHY: `before` and `after` are saved as JSON (the log is persisted), and JSON
 * drops `undefined`. So a snapshot must never hold `undefined`: it holds the
 * meaning ('queued', null, false) instead.
 */
export function readPatchValue(card: Card, key: keyof CardPatch): PatchValue {
  const value = card[key];
  return value === undefined ? PATCH_KEY_ABSENT[key] : value;
}

/** Equal patch values. NaN equals NaN (a broken number must not look "changed since"). */
function samePatchValue(a: PatchValue, b: PatchValue): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

/** Set one key of a patch (one typed place for the dynamic write). */
function setPatchValue(patch: CardPatch, key: keyof CardPatch, value: PatchValue): void {
  (patch as Record<string, PatchValue>)[key] = value;
}

/** The keys a patch really sets (keys holding `undefined` are ignored). */
function patchKeys(patch: CardPatch): (keyof CardPatch)[] {
  return CARD_PATCH_KEYS.filter((key) => patch[key] !== undefined);
}

/**
 * The keys that every rating changes (at least one of them): `reps` and
 * `lastReviewedAt` (applyRating), `knownCheckedAt` (a passed Check, which
 * leaves the schedule alone). editCards records their values in each card
 * entry as guards, so undo can see that a card was studied since the edit.
 * They are all CardPatch keys, so the ManualEdit type stays the same.
 */
export const STUDY_GUARD_KEYS = Object.freeze(['reps', 'lastReviewedAt', 'knownCheckedAt'] as const);

/**
 * Edit kinds without study guards. A flags edit (favorite, flag, suspend)
 * or a bury (`buriedUntil`) and a rating never touch the same keys, so
 * taking one back after a review is safe: it must not be reported as
 * "studied since".
 */
const UNGUARDED_KINDS: ReadonlySet<ManualKind> = new Set<ManualKind>(['flags', 'bury']);

/**
 * The `before` values that differ from `after`: what an undo writes back.
 * Guard keys have equal values, so they are left out (the card keeps its shape).
 */
function revertPatch(entry: { before: CardPatch; after: CardPatch }): CardPatch {
  const out: CardPatch = {};
  for (const key of patchKeys(entry.before)) {
    const before = entry.before[key] as PatchValue;
    if (!samePatchValue(before, entry.after[key] as PatchValue)) setPatchValue(out, key, before);
  }
  return out;
}

/**
 * Compare a wanted patch with the card. Returns the `before`/`after` pair of
 * the keys that really change, or null when the card already has every
 * wanted value.
 *
 *   diffCard({ knownAt: null }, { knownAt: 5 }) → { before: { knownAt: null }, after: { knownAt: 5 } }
 *   diffCard({ knownAt: 5 },    { knownAt: 5 }) → null
 */
export function diffCard(card: Card, wanted: CardPatch): { before: CardPatch; after: CardPatch } | null {
  const before: CardPatch = {};
  const after: CardPatch = {};
  let changed = false;
  for (const key of patchKeys(wanted)) {
    const now = readPatchValue(card, key);
    const next = wanted[key] as PatchValue;
    if (samePatchValue(now, next)) continue;
    setPatchValue(before, key, now);
    setPatchValue(after, key, next);
    changed = true;
  }
  return changed ? { before, after } : null;
}

/** True when the card still has every value of `after` (the undo test). */
export function matchesPatch(card: Card, after: CardPatch): boolean {
  return patchKeys(after).every((key) => samePatchValue(readPatchValue(card, key), after[key] as PatchValue));
}

/* ------------------------------------------------------------- the log */

/** The number of snapshots in one edit: its card entries plus its note entries. */
export function snapshotCount(edit: ManualEdit): number {
  return edit.cards.length + (edit.notes?.length ?? 0);
}

/**
 * Add `edit` to the end of the log, inside the caps. The oldest edits leave
 * first, until there are at most MANUAL_LOG_MAX_EDITS edits and at most
 * MANUAL_LOG_MAX_SNAPSHOTS snapshots.
 *
 * The edit is NOT added (stored: false, the log is returned as it is) when:
 *   - it changed nothing (0 snapshots): there is nothing to undo;
 *   - it alone is larger than MANUAL_LOG_MAX_SNAPSHOTS: it can never fit.
 *     The older edits stay; the change itself is simply not undoable.
 */
export function pushManualEdit(log: ManualEdit[], edit: ManualEdit): { log: ManualEdit[]; stored: boolean } {
  const size = snapshotCount(edit);
  if (size === 0 || size > MANUAL_LOG_MAX_SNAPSHOTS) return { log, stored: false };
  const next = [...log, edit];
  let total = 0;
  for (const e of next) total += snapshotCount(e);
  let start = 0;
  while (next.length - start > MANUAL_LOG_MAX_EDITS || total > MANUAL_LOG_MAX_SNAPSHOTS) {
    total -= snapshotCount(next[start]);
    start += 1;
  }
  return { log: start === 0 ? next : next.slice(start), stored: true };
}

/** A new, empty ManualEdit (the commands fill `cards` / `notes`). */
export function newEdit(kind: ManualKind, label: string, ctx: OpCtx): ManualEdit {
  return { id: ctx.newId(EDIT_ID_PREFIX), at: ctx.now, kind, label, cards: [] };
}

/**
 * Put a finished edit into the state's log and build the command result.
 * `stateWithChanges` already holds the changed cards and notes.
 */
export function commitEdit<S extends NoteModelState>(
  stateWithChanges: S,
  edit: ManualEdit,
  skipped: number,
): OpStep<S, EditResult> {
  const pushed = pushManualEdit(stateWithChanges.manualLog, edit);
  const state = pushed.stored ? { ...stateWithChanges, manualLog: pushed.log } : stateWithChanges;
  return { state, result: { edit, undoable: pushed.stored, skipped } };
}

/* ----------------------------------------------------------- editCards */

/**
 * What a command wants for ONE card:
 *   - a CardPatch: the values the card should have (keys it already has are
 *     ignored, so the patch may list more than what changes);
 *   - 'skip': the command's rule refuses this card (it is counted in `skipped`);
 *   - null: nothing to do for this card.
 */
export type CardPlan = CardPatch | 'skip' | null;

export interface EditCardsInput {
  /** The cards to change. Unknown ids are ignored; a repeated id counts once. */
  cardIds: readonly Id[];
  /**
   * Extra cards that change only to keep a rule of the model, for example
   * the siblings of a note that must keep sharing one feed position (learn
   * with `first`). `plan` is called for them too. Their changes go into the
   * SAME edit, so Undo takes them back as well. But they are not counted in
   * the label, and never in `skipped` (nobody asked for them). An id that is
   * also in `cardIds` is a normal card.
   */
  followerIds?: readonly Id[];
  kind: ManualKind;
  /** Decides the wanted values for each card (see CardPlan). */
  plan: (card: Card) => CardPlan;
  /** The snackbar text for `changed` cards (followers not counted), e.g. (12) → "12 cards suspended". */
  label: (changed: number) => string;
}

/**
 * Change some cards and record ONE ManualEdit with each changed card's
 * `before` and `after` values. Every triage command (learn, markKnown,
 * setNotStarted, resetProgress, reschedule, setFlags) is a thin wrapper
 * around this.
 *
 * Only the keys that really change are written to the card. The edit holds
 * them, plus the study guards (STUDY_GUARD_KEYS, the same value in `before`
 * and `after`) for every kind except 'flags'. When nothing changes, the state
 * is returned as it is (the same object) and the edit is empty and not
 * undoable.
 */
export function editCards<S extends NoteModelState>(
  state: S,
  input: EditCardsInput,
  ctx: OpCtx,
): OpStep<S, EditResult> {
  const wanted = new Set(input.cardIds);
  const followers = new Set((input.followerIds ?? []).filter((id) => !wanted.has(id)));
  const entries: ManualEdit['cards'] = [];
  const guarded = !UNGUARDED_KINDS.has(input.kind);
  let changed = 0;
  let skipped = 0;
  const cards = state.cards.map((card) => {
    const follower = followers.has(card.id);
    if (!wanted.has(card.id) && !follower) return card;
    // A repeated card id (broken data) is handled once.
    wanted.delete(card.id);
    followers.delete(card.id);
    const plan = input.plan(card);
    if (plan === 'skip') {
      if (!follower) skipped += 1;
      return card;
    }
    if (plan === null) return card;
    const diff = diffCard(card, plan);
    if (!diff) return card;
    const entry = { id: card.id, before: { ...diff.before }, after: { ...diff.after } };
    if (guarded) {
      for (const key of STUDY_GUARD_KEYS) {
        if (entry.after[key] !== undefined) continue; // the edit changes this key itself
        const value = readPatchValue(card, key);
        setPatchValue(entry.before, key, value);
        setPatchValue(entry.after, key, value);
      }
    }
    entries.push(entry);
    if (!follower) changed += 1;
    // Only the real changes are written (a guard key keeps its value AND its shape on the card).
    return { ...card, ...diff.after };
  });
  const edit = { ...newEdit(input.kind, input.label(changed), ctx), cards: entries };
  if (entries.length === 0) return { state, result: { edit, undoable: false, skipped } };
  return commitEdit({ ...state, cards }, edit, skipped);
}

/* -------------------------------------------------------------- undo */

/** What undoManualEdit reports (the snackbar after a partial undo uses both counts). */
export interface UndoResult {
  /** False when no edit has this id (already undone, too old, or never stored). */
  found: boolean;
  /**
   * Cards changed back. A note entry without moved cards (a tag edit, a new
   * section inside the same deck) counts the cards of that note.
   */
  reverted: number;
  /** Cards left as they are, because they (or their note) were changed since, or deleted. */
  skipped: number;
}

/** Same tags in the same order. */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** One note entry of an edit, with the keys it really changed. */
interface NoteChange {
  entry: NonNullable<ManualEdit['notes']>[number];
  tags: boolean;
  section: boolean;
}

/**
 * Take back one ManualEdit (spec §3.6 "ManualEdit undo rule").
 *
 * For each card of the edit: if the card still has the `after` values, it
 * gets its `before` values back; otherwise it is skipped. A deleted card is
 * skipped. The `after` values include the study guards, so a card that was
 * studied since the edit is skipped too (see the file header). Only the keys
 * the edit really changed are written back. For each note of the edit (tags,
 * section): the same rule, on the keys the edit changed. Three extra rules
 * keep the library valid:
 *   - A MOVE is taken back per note, all or nothing. The note is ONE unit:
 *     its cards' deck AND its section (a "move to deck, section …" records
 *     both). Either every card goes back to the old deck and the note gets
 *     its old section, or nothing of the note changes. So the cards of one
 *     note are never split over two decks, and a note never ends up in one
 *     deck with the section path of another deck. A card made after the move
 *     (for example by setDirections) goes back with its siblings.
 *   - A move is NOT taken back when the old deck no longer exists (that
 *     would make orphan cards, spec §3.12 "No-orphan"). The note then keeps
 *     its new section too.
 *   - The counts are in CARDS, the one unit on every screen (spec §8.3): a
 *     note entry without moved cards (a tag edit, or a new section inside the
 *     same deck) counts the note's cards. A note is never counted twice.
 *
 * Example: notes n1 (2 cards, deck A) and n2 (2 cards, already in deck B) go
 * to deck B, section 'S'. Later n2 gets section 'T'. Undo: n1 goes back to A
 * with its old section (2 reverted); n2 keeps 'T' (2 skipped).
 *
 * The edit then leaves the log, also after a partial undo (an edit is undone
 * once). `reviewLog` is never read or written.
 */
export function undoManualEdit<S extends NoteModelState>(
  state: S,
  input: { editId: string },
  ctx: OpCtx,
): OpStep<S, UndoResult> {
  const edit = state.manualLog.find((e) => e.id === input.editId);
  if (!edit) return { state, result: { found: false, reverted: 0, skipped: 0 } };

  const cardById = new Map(state.cards.map((c) => [c.id, c]));
  const noteById = new Map(state.notes.map((n) => [n.id, n]));
  const deckIds = new Set(state.decks.map((d) => d.id));
  const replaced = new Map<Id, Card>();
  const notesReplaced = new Map<Id, Note>();
  let reverted = 0;
  let skipped = 0;

  // 1. Card entries. Entries that move a card (deckId) are grouped by note.
  const moves = new Map<Id, ManualEdit['cards']>();
  for (const entry of edit.cards) {
    const card = cardById.get(entry.id);
    if (!card) {
      skipped += 1;
      continue;
    }
    if (entry.after.deckId !== undefined) {
      const group = moves.get(card.noteId) ?? [];
      group.push(entry);
      moves.set(card.noteId, group);
      continue;
    }
    if (matchesPatch(card, entry.after)) {
      replaced.set(card.id, { ...card, ...revertPatch(entry) });
      reverted += 1;
    } else {
      skipped += 1;
    }
  }

  // 2. Note entries (tags, section), by note: only the keys this edit changed.
  const noteChanges = new Map<Id, NoteChange>();
  for (const entry of edit.notes ?? []) {
    const tags = !sameTags(entry.before.tags, entry.after.tags);
    const section =
      entry.before.section !== undefined &&
      entry.after.section !== undefined &&
      entry.before.section !== entry.after.section;
    // A repeated note id (broken data) is handled once.
    if ((tags || section) && !noteChanges.has(entry.id)) noteChanges.set(entry.id, { entry, tags, section });
  }
  /** The note still exists and still has the `after` values of its entry. */
  const noteUnchanged = (change: NoteChange): boolean => {
    const note = noteById.get(change.entry.id);
    return (
      note !== undefined &&
      (!change.tags || sameTags(note.tags, change.entry.after.tags)) &&
      (!change.section || note.section === change.entry.after.section)
    );
  };
  /** Give the note its `before` values back (call only after noteUnchanged). */
  const revertNote = (change: NoteChange): void => {
    const note = noteById.get(change.entry.id) as Note;
    notesReplaced.set(note.id, {
      ...note,
      ...(change.tags ? { tags: [...change.entry.before.tags] } : {}),
      ...(change.section ? { section: change.entry.before.section as string } : {}),
      updatedAt: ctx.now,
    });
  };

  // 3. Moves: per note, all or nothing (cards AND the note's own entry), and
  //    only into a deck that still exists.
  if (moves.size > 0) {
    const cardsByNote = new Map<Id, Card[]>();
    for (const card of state.cards) {
      if (!moves.has(card.noteId)) continue;
      const list = cardsByNote.get(card.noteId) ?? [];
      list.push(card);
      cardsByNote.set(card.noteId, list);
    }
    for (const [noteId, group] of moves) {
      const home = group[0].before.deckId;
      const change = noteChanges.get(noteId);
      const ok =
        home !== undefined &&
        deckIds.has(home) &&
        group.every((e) => e.before.deckId === home && matchesPatch(cardById.get(e.id) as Card, e.after)) &&
        (change === undefined || noteUnchanged(change));
      if (!ok) {
        skipped += group.length;
        continue;
      }
      for (const e of group) replaced.set(e.id, { ...(cardById.get(e.id) as Card), ...revertPatch(e) });
      // Siblings that are not in the edit follow, so the note stays in one deck.
      for (const sibling of cardsByNote.get(noteId) ?? []) {
        if (!replaced.has(sibling.id) && sibling.deckId !== home) replaced.set(sibling.id, { ...sibling, deckId: home });
      }
      if (change) revertNote(change);
      reverted += group.length;
    }
  }

  // 4. Notes without moved cards (a tag edit, or a new section inside the
  //    same deck). They are counted in their cards; a card that is in the
  //    edit itself was counted above already.
  const notesAlone = [...noteChanges.values()].filter((change) => !moves.has(change.entry.id));
  if (notesAlone.length > 0) {
    const cardsInEdit = new Set(edit.cards.map((e) => e.id));
    const cardCount = new Map<Id, number>();
    for (const card of state.cards) {
      if (!cardsInEdit.has(card.id)) cardCount.set(card.noteId, (cardCount.get(card.noteId) ?? 0) + 1);
    }
    for (const change of notesAlone) {
      const count = cardCount.get(change.entry.id) ?? 0;
      if (noteUnchanged(change)) {
        revertNote(change);
        reverted += count;
      } else {
        skipped += count;
      }
    }
  }

  const next: S = {
    ...state,
    cards: replaced.size > 0 ? state.cards.map((c) => replaced.get(c.id) ?? c) : state.cards,
    notes: notesReplaced.size > 0 ? state.notes.map((n) => notesReplaced.get(n.id) ?? n) : state.notes,
    manualLog: state.manualLog.filter((e) => e !== edit),
  };
  return { state: next, result: { found: true, reverted, skipped } };
}

/**
 * The snackbar text after a PARTIAL undo (spec §3.6), or null when every card
 * was changed back (then the UI shows its normal text).
 *
 *   partialUndoMessage({ reverted: 9, skipped: 1 })
 *   → "Undone for 9 cards. 1 was studied since and was not changed back."
 */
export function partialUndoMessage(result: Pick<UndoResult, 'reverted' | 'skipped'>): string | null {
  if (result.skipped === 0) return null;
  const rest =
    result.skipped === 1
      ? '1 was studied since and was not changed back.'
      : `${result.skipped.toLocaleString('en-US')} were studied since and were not changed back.`;
  return `Undone for ${plural(result.reverted, 'card')}. ${rest}`;
}
