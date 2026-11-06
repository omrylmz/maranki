/**
 * The decisions of the RescheduleSheet (spec §6.5, §7 #1, unit A1). Pure: no
 * React, no clock — the caller passes `now` (useNow() in render, Date.now()
 * in a press handler).
 *
 *   Tomorrow · In 3 days · In a week · In a month · Pick a date…
 *       → actions.reschedule(ids, dueMs)   (dueMs = the START of that local day)
 *
 * What "reschedule" means (triage.ts `reschedule`): only `due` changes. The
 * interval and the ease stay, so the snackbar says "difficulty unchanged".
 * Only a card that HAS a schedule can move: Learning, Review or Mastered.
 * New, Not started and Known cards have none: "Not studied yet — nothing to
 * reschedule".
 *
 * Days are LOCAL calendar days, never "n × 24 hours". On the day the clocks
 * change (DST) a day is 23 or 25 hours long, so `now + 7 × DAY` can land on
 * the wrong day or at 23:00. `new Date(y, m, d + n)` lets the JS calendar do
 * the work: it is always the first moment of the local day n days later.
 *
 * The date picker (`@expo/ui/community/datetime-picker`) works differently
 * on the two phones (checked in the @expo/ui sources for SDK 56):
 *   - Android (Material 3 dialog): it reads its start value as a UTC day and
 *     returns the picked day as UTC midnight. So the value we pass is UTC
 *     noon of the local day, and the result is read with the UTC getters.
 *   - iOS (SwiftUI, always inline): it works in local time. We pass local
 *     noon and read the result with the local getters.
 * Noon (not midnight) keeps the value inside the same day in every time
 * zone. `pickerValue` and `pickedDayStart` hold this rule in one place.
 */
import { life } from '../../domain/life';
import { partialUndoMessage } from '../../domain/manualLog';
import type { Card, DataStateV3, Id, ManualEdit } from '../../domain/model';
import { startOfLocalDay } from '../../domain/schedule';
import { cardLookupOf } from '../../domain/scope';
import { plural } from '../../domain/text';

/** The note shown when no card can move (spec §6.5, exact copy). */
export const NOTHING_TO_RESCHEDULE = 'Not studied yet — nothing to reschedule';

/** The sheet's texts (exact copy). */
export const RESCHEDULE_COPY = {
  title: 'Reschedule',
  pick: 'Pick a date…',
  confirm: 'Reschedule',
  cancel: 'Cancel',
  close: 'Close',
} as const;

/** The card keys the reschedule rules read. */
export type ReschedulableCard = Pick<Card, 'reps' | 'stepIndex' | 'intervalDays' | 'due' | 'knownAt' | 'newState'>;

/**
 * True when the card has a schedule that can move: Learning, Review or
 * Mastered (the same rule as triage.ts `reschedule`, which skips the others).
 */
export function canReschedule(card: ReschedulableCard): boolean {
  const key = life(card);
  return key === 'learning' || key === 'review' || key === 'mastered';
}

/**
 * Which of the asked cards can move, in ONE pass over the cards:
 *   - `ids`     the cards that can move, in the order asked;
 *   - `dues`    their current due times, in the same order (`dues[i]` is the
 *               due of `ids[i]`). The intro line and the picker's start day
 *               read them;
 *   - `skipped` how many cards have no schedule.
 * Missing cards (deleted since) are not counted at all.
 *
 * WHY one pass: a Library selection can hold thousands of cards ("Select
 * all" on a 16k-card deck), and the sheet runs this on every render. Finding
 * each due with `ids.includes(card.id)` took cards × ids steps (about 2.4 s
 * for 16,000 cards); this takes one step per card.
 *
 *   rescheduleTargets([review, fresh, null])
 *     → { ids: ['r'], dues: [review.due], skipped: 1 }
 */
export function rescheduleTargets(cards: readonly ((ReschedulableCard & { id: Id }) | null | undefined)[]): {
  ids: Id[];
  dues: number[];
  skipped: number;
} {
  const ids: Id[] = [];
  const dues: number[] = [];
  let skipped = 0;
  for (const card of cards) {
    if (!card) continue;
    if (canReschedule(card)) {
      ids.push(card.id);
      dues.push(card.due);
    } else {
      skipped += 1;
    }
  }
  return { ids, dues, skipped };
}

/**
 * The cards of the sheet, read from the store (for useStateV3). `idsKey` is
 * `JSON.stringify(cardIds)`, so a new array with the same ids gives the
 * same selector. It returns the SAME array while every card is the same
 * object, so the sheet does not re-render for other changes. A missing card
 * is null.
 */
export function cardsReader(idsKey: string): (state: Pick<DataStateV3, 'cards'>) => (Card | null)[] {
  let ids: Id[] = [];
  try {
    const parsed: unknown = JSON.parse(idsKey);
    if (Array.isArray(parsed)) ids = parsed.filter((id): id is Id => typeof id === 'string');
  } catch {
    ids = [];
  }
  let last: (Card | null)[] = [];
  return (state) => {
    const { cardById } = cardLookupOf(state.cards);
    const next = ids.map((id) => cardById.get(id) ?? null);
    if (next.length === last.length && next.every((card, i) => card === last[i])) return last;
    last = next;
    return next;
  };
}

/**
 * True when the edit `editId` is in the undo log, so a snackbar "Undo" can
 * take it back. False when nothing changed (the edit was not kept).
 */
export function isUndoableEdit(manualLog: readonly Pick<ManualEdit, 'id'>[] | undefined, editId: string): boolean {
  return editId !== '' && (manualLog ?? []).some((edit) => edit.id === editId);
}

/**
 * The snackbar "Undo" of a manual edit: take the edit back
 * (`actions.undoManualEdit`), and when some cards were studied since and
 * stayed as they are, report the spec's text (manualLog.ts
 * `partialUndoMessage`): "Undone for 0 cards. 1 was studied since and was
 * not changed back." Returns the undo result.
 */
export function undoManualEditAndReport(
  undo: (editId: string) => { reverted: number; skipped: number },
  editId: string,
  report: (text: string) => void,
): { reverted: number; skipped: number } {
  const result = undo(editId);
  const message = partialUndoMessage(result);
  if (message) report(message);
  return result;
}

/* ------------------------------------------------------------ calendar days */

/** The start of the local day `n` days after the day of `ms` (n may be 0 or negative). DST-safe. */
export function addLocalDays(ms: number, n: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/**
 * The start of the same day of the month, `n` months after the day of `ms`.
 * A day the month does not have becomes its last day: 31 January + 1 month
 * = 28 February (29 in a leap year), never 3 March.
 */
export function addLocalMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = d.getMonth() + n;
  // Day 0 of the next month is the last day of `month` (the Date constructor rolls the year).
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(d.getDate(), lastDay)).getTime();
}

/** The start of tomorrow (local): the earliest day a card can be moved to. */
export function startOfTomorrow(now: number): number {
  return addLocalDays(now, 1);
}

/**
 * The due time for a QUICK choice (Tomorrow … In a month): the start of that
 * local day, but never before tomorrow (a "reschedule" to today or the past
 * would make the card due at once, which is not what the learner asked
 * for). null for a value that is not a finite number (a NaN due date would
 * break the scheduler).
 *
 * Only for the quick choices: a day from the date picker is never clamped,
 * it is checked by `pickedDue` / `confirmedPickDay` and rejected when it is
 * not a day the learner can pick.
 */
export function clampDueDay(dayMs: number, now: number): number | null {
  if (!Number.isFinite(dayMs) || !Number.isFinite(now)) return null;
  return Math.max(startOfLocalDay(dayMs), startOfTomorrow(now));
}

/* ------------------------------------------------------------ the choices */

export type RescheduleChoiceId = 'tomorrow' | 'in3days' | 'inWeek' | 'inMonth';

export interface RescheduleChoice {
  id: RescheduleChoiceId;
  /** The row title (exact copy). */
  title: string;
  /** The start of the target day (what `reschedule` gets). */
  dueMs: number;
  /** The day as a short date: "Tue 28 Oct". */
  dateLabel: string;
}

const CHOICE_TITLES: Readonly<Record<RescheduleChoiceId, string>> = {
  tomorrow: 'Tomorrow',
  in3days: 'In 3 days',
  inWeek: 'In a week',
  inMonth: 'In a month',
};

/** The order of the rows. */
export const RESCHEDULE_CHOICE_IDS: readonly RescheduleChoiceId[] = ['tomorrow', 'in3days', 'inWeek', 'inMonth'];

/** The start of the target day of one choice, counted from `now`. */
export function choiceDueMs(id: RescheduleChoiceId, now: number): number {
  switch (id) {
    case 'tomorrow':
      return addLocalDays(now, 1);
    case 'in3days':
      return addLocalDays(now, 3);
    case 'inWeek':
      return addLocalDays(now, 7);
    case 'inMonth':
      return addLocalMonths(now, 1);
  }
}

/** The four quick rows, with their dates (the fifth row, "Pick a date…", is the picker). */
export function rescheduleChoices(now: number): RescheduleChoice[] {
  return RESCHEDULE_CHOICE_IDS.map((id) => {
    const dueMs = choiceDueMs(id, now);
    return { id, title: CHOICE_TITLES[id], dueMs, dateLabel: formatDayShort(dueMs, now) };
  });
}

/* ------------------------------------------------------------ dates as text */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A day as "Tue 28 Oct" (the spec's format), in local time. The year is
 * added only when it is not the year of `now`: "Tue 28 Oct 2027".
 */
export function formatDayShort(ms: number, now?: number): string {
  const d = new Date(ms);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (now === undefined || new Date(now).getFullYear() === d.getFullYear()) return base;
  return `${base} ${d.getFullYear()}`;
}

/** The snackbar after a reschedule (spec §6.5): "Next review: Tue 28 Oct · difficulty unchanged". */
export function rescheduleSnack(dueMs: number, now?: number): string {
  return `Next review: ${formatDayShort(dueMs, now)} · difficulty unchanged`;
}

/**
 * The line under the title: when the card is due at the moment, and what
 * happens to it.
 *   one card, due now        → "Due now. The difficulty stays the same."
 *   one card, due later today → "Due later today. The difficulty stays the same."
 *   one card, due tomorrow   → "Due tomorrow. The difficulty stays the same."
 *   one card, due later      → "Due Sat 31 Oct. The difficulty stays the same."
 *   several cards            → "3 cards. The difficulty stays the same."
 */
export function rescheduleIntro(dues: readonly number[], now: number): string {
  const rest = 'The difficulty stays the same.';
  if (dues.length !== 1) return `${plural(dues.length, 'card')}. ${rest}`;
  const due = dues[0];
  if (!Number.isFinite(due) || due <= now) return `Due now. ${rest}`;
  const day = startOfLocalDay(due);
  if (day === startOfLocalDay(now)) return `Due later today. ${rest}`;
  if (day === startOfTomorrow(now)) return `Due tomorrow. ${rest}`;
  return `Due ${formatDayShort(due, now)}. ${rest}`;
}

/**
 * The note when only some of the cards can move:
 *   (1 skipped) → "1 card is not studied yet and stays as it is."
 *   (0 skipped) → null
 */
export function skippedNote(skipped: number): string | null {
  if (skipped <= 0) return null;
  return skipped === 1
    ? '1 card is not studied yet and stays as it is.'
    : `${plural(skipped, 'card')} are not studied yet and stay as they are.`;
}

/* ------------------------------------------------------------ the date picker */

/** How "Pick a date…" works on a platform: a dialog (Android), an inline calendar (iOS), or not at all (web). */
export type PickerPresentation = 'dialog' | 'inline' | null;

/** `Platform.OS` → how the picker is shown. The web build of the picker renders nothing, so it is not offered there. */
export function pickerPresentation(os: string): PickerPresentation {
  if (os === 'android') return 'dialog';
  if (os === 'ios') return 'inline';
  return null;
}

/**
 * What the sheet shows:
 *   'nothing'  → no card can move: "Not studied yet — nothing to reschedule";
 *   'choices'  → the intro line and the rows (Tomorrow … Pick a date…);
 *   'calendar' → ONLY the inline calendar and Cancel / Reschedule (iOS,
 *                after "Pick a date…").
 * Why the calendar is shown alone: it is about 350 pt tall. Under the intro
 * and the five rows it would start low in the sheet (which is at most 78 %
 * of the screen), so the calendar and its Reschedule button would be below
 * the visible part, and the tap would seem to do nothing. Cancel brings the
 * rows back. Android's picker is a dialog over the sheet, so the rows stay.
 */
export type RescheduleView = 'nothing' | 'choices' | 'calendar';

export function rescheduleView(
  targets: number,
  presentation: PickerPresentation,
  pickDay: number | null,
): RescheduleView {
  if (targets === 0) return 'nothing';
  if (presentation === 'inline' && pickDay !== null) return 'calendar';
  return 'choices';
}

/**
 * The day the picker opens on: the card's next review when that is tomorrow
 * or later (one card), else tomorrow.
 */
export function pickerStartDay(dues: readonly number[], now: number): number {
  const tomorrow = startOfTomorrow(now);
  if (dues.length === 1 && Number.isFinite(dues[0]) && dues[0] >= tomorrow) return startOfLocalDay(dues[0]);
  return tomorrow;
}

/**
 * The `value` to give the picker for the local day of `dayMs` (see the file
 * header): Android → UTC noon of that calendar day; iOS → local noon.
 */
export function pickerValue(dayMs: number, os: string): Date {
  const d = new Date(dayMs);
  const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
  return os === 'android' ? new Date(Date.UTC(y, m, day, 12)) : new Date(y, m, day, 12);
}

/**
 * The picker's `minimumDate`: the start of tomorrow, local. (Android turns
 * it into a UTC day with the phone's own calendar, so local is right on both.)
 */
export function pickerMinimumDate(now: number): Date {
  return new Date(startOfTomorrow(now));
}

/**
 * The start of the local day the learner picked (see the file header):
 * Android returns UTC midnight of the picked calendar day; iOS a local time.
 */
export function pickedDayStart(date: Date, os: string): number {
  if (os === 'android') return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).getTime();
  return startOfLocalDay(date.getTime());
}

/**
 * The due time for a value from the date picker: the start of the picked
 * local day (pickedDayStart), or null when the value must be REJECTED:
 *   - it is not a valid date (missing, or an Invalid Date);
 *   - it is 1 January 1970 or earlier (`getTime() <= 0`);
 *   - its day is before tomorrow (today or the past).
 *
 * Why the 1970 case exists: Android's Material dialog has a keyboard-input
 * mode (the pencil button), and its OK button is always enabled. When the
 * typed text is empty, not a full date, or a day that is not allowed,
 * Material has NO selected day. The @expo/ui wrapper then calls
 * `new Date(null)`, and that is 1 January 1970.
 *
 * Why reject and not clamp to tomorrow: the learner did not choose
 * tomorrow. Clamping would quietly move the card to a day they never
 * picked. `now` is the time of the tap.
 *
 *   pickedDue(new Date(0), 'android', now)                   → null
 *   pickedDue(new Date(Date.UTC(2026, 9, 31)), 'android', now) → start of local 31 Oct
 */
export function pickedDue(date: Date | null | undefined, os: string, now: number): number | null {
  // Duck typing, not `instanceof Date`: a value from another JS realm is a Date too.
  if (date == null || typeof date.getTime !== 'function') return null;
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return confirmedPickDay(pickedDayStart(date, os), now);
}

/**
 * A picked day (the start of a local day), checked again at the moment the
 * learner confirms it (the iOS "Reschedule" button): the start of that day
 * when it is tomorrow or later, else null. It can become null while the
 * calendar is open: after midnight, the picked "tomorrow" is today.
 */
export function confirmedPickDay(dayMs: number, now: number): number | null {
  if (!Number.isFinite(dayMs) || !Number.isFinite(now)) return null;
  const day = startOfLocalDay(dayMs);
  return day >= startOfTomorrow(now) ? day : null;
}
