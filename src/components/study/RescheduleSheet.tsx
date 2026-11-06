/**
 * RescheduleSheet — "Reschedule…" (spec §6.5, §7 #1, unit A1). Opened from
 * the session's "More" sheet and from the CardSheet.
 *
 *   <RescheduleSheet cardIds={[card.id]} open={open} onClose={() => setOpen(false)} />
 *
 *   Reschedule
 *   Due Sat 31 Oct. The difficulty stays the same.
 *   Tomorrow        Sun 25 Oct      ›
 *   In 3 days       Tue 27 Oct      ›
 *   In a week       Sat 31 Oct      ›
 *   In a month      Tue 24 Nov      ›
 *   Pick a date…                    ›
 *
 * A choice calls `actions.reschedule(ids, dueMs)` with the START of the
 * chosen local day: only `due` changes, the interval and the ease stay. The
 * sheet then closes itself (it calls `onClose`).
 *
 * The snackbar:
 *   - no `onDone` → this sheet shows "Next review: Tue 28 Oct · difficulty
 *     unchanged" with Undo (`undoManualEdit`);
 *   - `onDone` given → the CALLER shows it. The session needs this: its Undo
 *     also puts the card back into the queue at the same place.
 *
 * Only Learning, Review and Mastered cards have a schedule. When none of the
 * cards has one, the sheet says "Not studied yet — nothing to reschedule".
 *
 * "Pick a date…" uses the date picker of `@expo/ui/community/datetime-picker`
 * (mode 'date', minimumDate = tomorrow). Android shows it as a dialog over
 * the sheet; iOS shows an inline calendar in the sheet with a "Reschedule"
 * button — in place of the intro and the rows, so the tall calendar and its
 * button are in view (Cancel brings the rows back); the web preview has no
 * picker, so the row is not shown there. All
 * date math (local days, DST, the picker's time zone rules) is in
 * rescheduleLogic.ts (pure, tested).
 *
 * A picked value is CHECKED, never moved to another day (`pickedDue`): an
 * empty or wrong date typed in Android's keyboard mode arrives as 1 January
 * 1970, and a day before tomorrow is not allowed. Then nothing changes and
 * the Android dialog stays open, so the learner sees Material's own error
 * under the field and can fix the date or tap Cancel.
 */
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import React, { useMemo, useState } from 'react';
import { Platform, Text, type TextStyle, View } from 'react-native';

import { Btn, ListRow, Sheet } from '@/components/ui';
import { useEngine, useStateV3 } from '@/store/selectors';
import { useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  cardsReader,
  choiceDueMs,
  clampDueDay,
  confirmedPickDay,
  formatDayShort,
  isUndoableEdit,
  NOTHING_TO_RESCHEDULE,
  pickedDue,
  pickerMinimumDate,
  pickerPresentation,
  pickerStartDay,
  pickerValue,
  RESCHEDULE_COPY,
  rescheduleChoices,
  rescheduleIntro,
  rescheduleSnack,
  rescheduleTargets,
  rescheduleView,
  skippedNote,
  undoManualEditAndReport,
  type RescheduleChoiceId,
} from './rescheduleLogic';

interface RescheduleSheetProps {
  /** The cards to move (usually one). Cards without a schedule are skipped. */
  cardIds: string[];
  open: boolean;
  onClose: () => void;
  /**
   * Called after the cards were rescheduled. When given, the caller shows the
   * snackbar (and its Undo: `actions.undoManualEdit(editId)`).
   */
  onDone?: (r: { editId: string; dueMs: number }) => void;
}

/** The time of a tap (event handlers only: it reads the clock; render uses useNow()). */
function pressTime(): number {
  return Date.now();
}

export function RescheduleSheet({ cardIds, open, onClose, onDone }: RescheduleSheetProps) {
  const c = useColors();
  const now = useNow();
  const engine = useEngine();
  const { actions } = useData();
  const { show } = useSnackbar();
  const os = Platform.OS;
  const presentation = pickerPresentation(os);

  // Keep the cards of the last open while the sheet slides out, even when
  // the caller clears `cardIds` at the same time (adjust-state-during-render).
  const idsKey = JSON.stringify(cardIds);
  const [shownKey, setShownKey] = useState(idsKey);
  if (open && idsKey !== shownKey) setShownKey(idsKey);

  const reader = useMemo(() => cardsReader(shownKey), [shownKey]);
  const cards = useStateV3(reader);
  // One pass over the cards: a Library selection can hold thousands of them.
  const { ids, dues, skipped } = rescheduleTargets(cards);
  const choices = rescheduleChoices(now);

  // The day the picker shows; null = the picker is closed.
  const [pickDay, setPickDay] = useState<number | null>(null);

  /**
   * Move the cards to `dueMs` (the start of a local day, tomorrow or later)
   * and close the sheet. `at` is the time of the tap; null = nothing to move.
   */
  const apply = (dueMs: number | null, at: number) => {
    setPickDay(null);
    onClose();
    if (dueMs === null || ids.length === 0) return;
    const editId = actions.reschedule(ids, dueMs);
    if (onDone) {
      onDone({ editId, dueMs });
      return;
    }
    const text = rescheduleSnack(dueMs, at);
    if (!isUndoableEdit(engine.store.getState().manualLog, editId)) {
      // Nothing changed (the cards were already due that day): no Undo to offer.
      show(text);
      return;
    }
    show(text, {
      onAction: () =>
        // The snackbar host clears the bar right after this handler, so a
        // follow-up message waits one tick.
        undoManualEditAndReport(actions.undoManualEdit, editId, (message) => setTimeout(() => show(message), 0)),
    });
  };

  const pickChoice = (id: RescheduleChoiceId) => {
    const at = pressTime();
    apply(clampDueDay(choiceDueMs(id, at), at), at);
  };

  /**
   * Android dialog "OK". A value we cannot use (see pickedDue: an empty or
   * wrong typed date, or a day before tomorrow) is rejected: nothing changes
   * and the dialog stays open (it closes only when it unmounts), so Material
   * shows its error under the field and the learner can fix it or Cancel.
   */
  const pickFromDialog = (date: Date | null | undefined) => {
    const at = pressTime();
    const dueMs = pickedDue(date, os, at);
    if (dueMs === null) return;
    apply(dueMs, at);
  };

  /** iOS calendar: keep the last valid day; a value we cannot use is ignored. */
  const pickInCalendar = (date: Date | null | undefined) => {
    const dueMs = pickedDue(date, os, pressTime());
    if (dueMs !== null) setPickDay(dueMs);
  };

  /**
   * iOS "Reschedule": check the day again (after midnight, the picked
   * "tomorrow" is today). A day that is no longer allowed is not moved to
   * another day: the calendar closes and the rows show the new dates.
   */
  const confirmCalendar = (day: number) => {
    const at = pressTime();
    const dueMs = confirmedPickDay(day, at);
    if (dueMs === null) {
      setPickDay(null);
      return;
    }
    apply(dueMs, at);
  };

  const muted: TextStyle[] = [font('sans', 400), { fontSize: 14, lineHeight: 20, color: c.ink2 }];
  const view = rescheduleView(ids.length, presentation, pickDay);

  return (
    <Sheet open={open} onClose={onClose} onClosed={() => setPickDay(null)} title={RESCHEDULE_COPY.title}>
      {view === 'nothing' ? (
        <View>
          <Text style={[...muted, { marginBottom: 18 }]}>{NOTHING_TO_RESCHEDULE}</Text>
          <Btn kind="secondary" full onPress={onClose}>
            {RESCHEDULE_COPY.close}
          </Btn>
        </View>
      ) : null}

      {/* iOS, after "Pick a date…": the inline calendar ALONE, so it and its button are in view. */}
      {view === 'calendar' && pickDay !== null ? (
        <View style={{ gap: 12 }}>
          <DateTimePicker
            mode="date"
            display="inline"
            value={pickerValue(pickDay, os)}
            minimumDate={pickerMinimumDate(now)}
            accentColor={c.pine}
            onValueChange={(_event, date) => pickInCalendar(date)}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setPickDay(null)}>
              {RESCHEDULE_COPY.cancel}
            </Btn>
            <Btn
              full
              style={{ flex: 1 }}
              label={`${RESCHEDULE_COPY.confirm} to ${formatDayShort(pickDay, now)}`}
              onPress={() => confirmCalendar(pickDay)}
            >
              {RESCHEDULE_COPY.confirm}
            </Btn>
          </View>
        </View>
      ) : null}

      {view === 'choices' ? (
        <View>
          <Text style={[...muted, { marginBottom: skipped > 0 ? 4 : 8 }]}>{rescheduleIntro(dues, now)}</Text>
          {skipped > 0 ? (
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, marginBottom: 8 }]}>
              {skippedNote(skipped)}
            </Text>
          ) : null}

          {choices.map((choice, i) => (
            <ListRow
              key={choice.id}
              icon={i === 0 ? 'sunny-outline' : 'calendar-outline'}
              title={choice.title}
              sub={choice.dateLabel}
              last={presentation === null && i === choices.length - 1}
              onPress={() => pickChoice(choice.id)}
            />
          ))}
          {presentation !== null ? (
            <ListRow
              icon="calendar-number-outline"
              title={RESCHEDULE_COPY.pick}
              last
              onPress={() => setPickDay(pickerStartDay(dues, pressTime()))}
            />
          ) : null}

          {/* Android: a Material dialog that opens when it mounts; it closes by unmounting. */}
          {presentation === 'dialog' && pickDay !== null ? (
            <DateTimePicker
              mode="date"
              presentation="dialog"
              value={pickerValue(pickDay, os)}
              minimumDate={pickerMinimumDate(now)}
              accentColor={c.pine}
              onValueChange={(_event, date) => pickFromDialog(date)}
              onDismiss={() => setPickDay(null)}
            />
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}
