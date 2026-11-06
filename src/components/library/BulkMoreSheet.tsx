/**
 * BulkMoreSheet — the "More" of the Library's select mode (spec §2.3, §8.3,
 * unit W4-2). Every row is a real change of the selected cards:
 *
 *   Learn these                     Not started → New
 *   Mark as known
 *   Move back to Not started        only cards never studied; others are skipped and counted
 *   Reset progress…                 (confirm)
 *   Reschedule…                     (RescheduleSheet)
 *   Move to deck…                   (DeckPickerSheet)
 *   Add tag… · Remove tag…          (TagEditSheet)
 *   Delete 12 cards…                (confirm with a 1-second hold; deletes whole items, says so)
 *
 *   <BulkMoreSheet open={more} onClose={() => setMore(false)} cardIds={ids} onDone={endSelectMode} />
 *
 * A row that would change nothing is not shown (for example "Reschedule…"
 * when no selected card has a schedule, or "Move to deck…" when the only
 * deck already holds every selected card) — no fake controls. Every change
 * shows the snackbar "{n} cards {verb} · Undo" (`undoManualEdit`; a delete
 * uses `undoDelete`). The menu closes before a change runs, so the snackbar
 * of the screen is in view.
 *
 * The smaller sheets are siblings of the menu (not inside it), so they stay
 * open while the menu slides away. Cancel in one of them goes back to the menu.
 *
 * The rows WRAP their second line (MoreRow, walkthrough L13): "Only cards
 * never studied · 6 studied cards will be skipped" was cut to "… will be s…"
 * by the kit's one-line ListRow, and that note is what the row is about.
 */
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { DeckPickerSheet } from '@/components/editor/DeckPickerSheet';
import { RescheduleSheet } from '@/components/study/RescheduleSheet';
import { rescheduleSnack, undoManualEditAndReport } from '@/components/study/rescheduleLogic';
import { A11Y_HIDDEN, Btn, HoldButton, Ion, Row, Sheet } from '@/components/ui';
import type { Card, DataStateV3, Id } from '@/domain/model';
import { cardLookupOf } from '@/domain/scope';
import { plural } from '@/domain/text';
import { useData } from '@/store/DataContext';
import { useEngine, useLibraryIndex, useStateV3 } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { editSnack, libraryTags, noteIdsOf, selectionSummary, skippedNote, tagCountsOf } from './libraryState';
import { TagEditSheet } from './TagEditSheet';

interface BulkMoreSheetProps {
  open: boolean;
  onClose: () => void;
  /** The selected cards (the Library resolved "Select all" to ids when it opened this sheet). */
  cardIds: readonly Id[];
  /** A change was made: the Library ends select mode. */
  onDone: () => void;
}

/** The smaller sheet open instead of the menu. */
type Panel = 'reset' | 'reschedule' | 'move' | 'addTag' | 'removeTag' | 'delete';

const cardsOf = (s: DataStateV3) => s.cards;

/** "Next review: Tue 28 Oct · difficulty unchanged" (event handlers only: it reads the clock). */
function pressNote(dueMs: number): string {
  return rescheduleSnack(dueMs, Date.now());
}

const decksOf = (s: DataStateV3) => s.decks;

interface MoreRowProps {
  icon: string;
  title: string;
  /** The second line: it wraps, it is never cut. */
  sub?: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
}

/**
 * One row of the menu: the kit's ListRow look (a tinted icon square, a bold
 * title, a quiet second line and a chevron), but the texts WRAP instead of
 * ending in "…" (walkthrough L13).
 */
function MoreRow({ icon, title, sub, onPress, danger, last }: MoreRowProps) {
  const c = useColors();
  return (
    <Row onPress={onPress} last={last} padV={13}>
      <View
        {...A11Y_HIDDEN}
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          backgroundColor: danger ? c.dangerTint : c.pineTint,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ion name={icon} size={17} color={danger ? c.danger : c.pine} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[font('sans', 700), { fontSize: 15, color: danger ? c.danger : c.ink }]}>{title}</Text>
        {sub ? (
          <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 17, color: c.ink3, marginTop: 1 }]}>{sub}</Text>
        ) : null}
      </View>
      <View {...A11Y_HIDDEN}>
        <Ion name="chevron-forward" size={16} color={c.ink3} />
      </View>
    </Row>
  );
}

export function BulkMoreSheet({ open, onClose, cardIds, onDone }: BulkMoreSheetProps) {
  const c = useColors();
  const engine = useEngine();
  const { actions } = useData();
  const { show } = useSnackbar();
  const allCards = useStateV3(cardsOf);
  const decks = useStateV3(decksOf);
  const index = useLibraryIndex();
  const [panel, setPanel] = useState<Panel | null>(null);
  // Keep the cards of the last open while the sheets slide out, also when the
  // Library clears `cardIds` at the same time (adjust-state-during-render).
  const [shownIds, setShownIds] = useState(cardIds);
  if (open && cardIds !== shownIds) setShownIds(cardIds);

  // The selected cards as they are NOW (a card deleted meanwhile is left out).
  const selected = useMemo(() => {
    const { cardById } = cardLookupOf(allCards);
    const out: Card[] = [];
    for (const id of shownIds) {
      const card = cardById.get(id);
      if (card) out.push(card);
    }
    return out;
  }, [allCards, shownIds]);
  const summary = useMemo(() => selectionSummary(selected), [selected]);
  const noteIds = useMemo(() => noteIdsOf(selected), [selected]);
  // A delete removes whole items: every direction of each selected card.
  const deleteTotal = useMemo(() => {
    const { cardIdsByNote } = cardLookupOf(allCards);
    let n = 0;
    for (const noteId of noteIds) n += cardIdsByNote.get(noteId)?.length ?? 0;
    return n;
  }, [allCards, noteIds]);
  const ownTags = useMemo(() => (open ? tagCountsOf(selected, index) : []), [open, selected, index]);
  const allTags = useMemo(() => (open ? libraryTags(index) : []), [open, index]);
  // The deck of the selection when every card is in the same one (the picker shows its check mark).
  const singleDeck =
    selected.length > 0 && selected.every((card) => card.deckId === selected[0].deckId) ? selected[0].deckId : null;
  // "Move to deck…" needs a deck the cards can move TO: with one deck that
  // holds every selected card already, a move would change nothing.
  const canMove = decks.some((deck) => deck.id !== singleDeck);

  const ids = selected.map((card) => card.id);
  const n = summary.total;

  /** Close everything; the Library ends select mode. */
  const finish = () => {
    setPanel(null);
    onClose();
    onDone();
  };
  /** Cancel in a smaller sheet: back to the menu. */
  const back = () => setPanel(null);

  /** A follow-up message after Undo waits one tick (the snackbar host clears the bar right after the Undo handler). */
  const later = (message: string) => setTimeout(() => show(message), 0);

  /** The snackbar of a manual edit, with Undo when the edit is in the undo log. */
  const report = (editId: string, fallback: string, note = '') => {
    const snack = editSnack(engine.store.getState().manualLog, editId, fallback);
    const text = note ? `${snack.text}. ${note}` : snack.text;
    if (!snack.undoable) {
      show(text);
      return;
    }
    show(text, { onAction: () => undoManualEditAndReport(actions.undoManualEdit, editId, later) });
  };

  const learn = () => {
    finish();
    report(actions.learn(ids), `${plural(summary.learnable, 'card')} added to your queue`);
  };
  const markKnown = () => {
    finish();
    report(actions.markKnown(ids), `${plural(summary.knowable, 'card')} marked as known`);
  };
  const toNotStarted = () => {
    finish();
    report(
      actions.setNotStarted(ids),
      `${plural(summary.toNotStarted, 'card')} moved back to Not started`,
      skippedNote(summary.studied),
    );
  };
  const reset = () => {
    finish();
    report(actions.resetProgress(ids), `${plural(summary.resettable, 'card')} reset to New`);
  };
  const rescheduled = ({ editId, dueMs }: { editId: string; dueMs: number }) => {
    finish();
    report(editId, `${plural(summary.reschedulable, 'card')} rescheduled`, pressNote(dueMs));
  };
  const move = (deckId: Id) => {
    // Every card is in that deck already: nothing to move.
    if (deckId === singleDeck) return;
    const deck = decks.find((d) => d.id === deckId);
    finish();
    // Moves whole items: every direction stays in one deck.
    report(actions.moveNotes(noteIds, deckId), `${plural(n, 'card')} moved to ${deck?.name ?? 'another deck'}`);
  };
  const addTags = (tags: string[]) => {
    finish();
    report(actions.tagNotes(noteIds, tags, []), `${plural(n, 'card')} tagged`);
  };
  const removeTags = (tags: string[]) => {
    finish();
    report(actions.tagNotes(noteIds, [], tags), `${plural(n, 'card')} untagged`);
  };
  const remove = () => {
    finish();
    const token = actions.deleteNotes(noteIds);
    show(`${plural(deleteTotal, 'card')} deleted`, { onAction: () => actions.undoDelete(token) });
  };

  const muted = [font('sans', 400), { fontSize: 14.5, lineHeight: 21, color: c.ink2, marginBottom: 18 }];
  const items = plural(noteIds.length, 'item');

  return (
    <>
      <Sheet open={open && panel === null} onClose={onClose} title={`${plural(n, 'card')} selected`}>
        <View>
          {summary.learnable > 0 ? (
            <MoreRow
              icon="add-circle-outline"
              title="Learn these"
              sub={`Not started → New · ${plural(summary.learnable, 'card')}`}
              onPress={learn}
            />
          ) : null}
          {summary.knowable > 0 ? (
            <MoreRow
              icon="checkmark-done"
              title="Mark as known"
              sub={`They leave your study queue · ${plural(summary.knowable, 'card')}`}
              onPress={markKnown}
            />
          ) : null}
          {summary.toNotStarted > 0 ? (
            <MoreRow
              icon="ellipse-outline"
              title="Move back to Not started"
              sub={
                summary.studied > 0
                  ? `Only cards never studied · ${plural(summary.studied, 'studied card')} will be skipped`
                  : `Only cards never studied · ${plural(summary.toNotStarted, 'card')}`
              }
              onPress={toNotStarted}
            />
          ) : null}
          {summary.resettable > 0 ? (
            <MoreRow
              icon="refresh-outline"
              title="Reset progress…"
              sub={`Start again as New · ${plural(summary.resettable, 'card')}`}
              onPress={() => setPanel('reset')}
            />
          ) : null}
          {summary.reschedulable > 0 ? (
            <MoreRow
              icon="calendar-outline"
              title="Reschedule…"
              sub={`Move the next review · ${plural(summary.reschedulable, 'card')}`}
              onPress={() => setPanel('reschedule')}
            />
          ) : null}
          {canMove ? (
            <MoreRow
              icon="swap-horizontal-outline"
              title="Move to deck…"
              sub="Moves whole items, with every direction"
              onPress={() => setPanel('move')}
            />
          ) : null}
          <MoreRow icon="pricetag-outline" title="Add tag…" onPress={() => setPanel('addTag')} />
          {ownTags.length > 0 ? (
            <MoreRow icon="pricetags-outline" title="Remove tag…" onPress={() => setPanel('removeTag')} />
          ) : null}
          <MoreRow
            icon="trash-outline"
            danger
            title={`Delete ${plural(n, 'card')}…`}
            sub={deleteTotal > n ? `Deletes whole items: ${plural(deleteTotal, 'card')} with every direction` : 'Deletes whole items and their progress'}
            onPress={() => setPanel('delete')}
            last
          />
        </View>
      </Sheet>

      <Sheet open={open && panel === 'reset'} onClose={back} title={`Start ${plural(summary.resettable, 'card')} again as New?`}>
        <Text style={muted}>Their history is kept. They come back into your queue as New cards.</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={back}>
            Cancel
          </Btn>
          <Btn kind="primary" full style={{ flex: 1 }} onPress={reset}>
            Reset progress
          </Btn>
        </View>
      </Sheet>

      <RescheduleSheet
        cardIds={ids}
        open={open && panel === 'reschedule'}
        onClose={back}
        onDone={rescheduled}
      />

      <DeckPickerSheet
        open={open && panel === 'move'}
        onClose={back}
        decks={decks}
        selectedId={singleDeck}
        onPick={move}
        title="Move to deck"
      />

      <TagEditSheet
        mode="add"
        open={open && panel === 'addTag'}
        onClose={back}
        tags={allTags}
        cardCount={n}
        onApply={addTags}
      />
      <TagEditSheet
        mode="remove"
        open={open && panel === 'removeTag'}
        onClose={back}
        tags={ownTags}
        cardCount={n}
        onApply={removeTags}
      />

      <Sheet open={open && panel === 'delete'} onClose={back} title={`Delete ${plural(deleteTotal, 'card')}?`}>
        <Text style={muted}>
          {`This deletes whole items: ${items}, with every direction — ${plural(deleteTotal, 'card')} and their study progress. You can undo it right after.`}
        </Text>
        <HoldButton kind="dangerSolid" icon="trash-outline" onConfirm={remove}>
          Hold to delete
        </HoldButton>
        <Btn kind="secondary" full onPress={back} style={{ marginTop: 10 }}>
          Cancel
        </Btn>
      </Sheet>
    </>
  );
}
