/**
 * CardActionsSheet — the session's "More" sheet for the card on screen
 * (spec §6.5). Every row does what it says; the session (session.tsx) owns
 * the actions:
 *
 *   Edit card            the card editor over the session (all directions of the item)
 *   Reschedule…          RescheduleSheet; the card leaves this session
 *   Bury until tomorrow  hidden until tomorrow; the card leaves this session
 *   Flag / Unflag        your marker; the label reads the STORE copy of the card
 *   Suspend card         hidden until you unsuspend it; the card leaves this session
 *   Switch mode          ModeSheet; for the rest of this session
 *   Card info            CardSheet, read-only (status, next due, history …)
 *
 * The sheet gets plain values, not the card: `title` is the face's one-line
 * prompt, and `flagged` comes from the STORE copy. The session's queue copy
 * goes stale after a flag change, so reading it made the row say "Flag"
 * again and flag the card twice (spec §6.5, §7 #22).
 *
 * Reschedule needs a schedule: a New, Not started or Known card has none, so
 * the row then says "Not studied yet — nothing to reschedule" and does nothing.
 *
 * A tap calls the row's handler. The session closes this sheet and opens the
 * next sheet (or the editor) only after this one has slid out (Sheet onClosed),
 * so two native modals never animate at the same time.
 */
import React from 'react';
import { View } from 'react-native';

import { ListRow, Sheet } from '@/components/ui';

import { NOTHING_TO_RESCHEDULE } from './rescheduleLogic';

/** The rows' texts (exact copy, spec §6.5). */
export const CARD_ACTIONS_COPY = {
  edit: 'Edit card',
  editSub: 'Change the text of every direction',
  reschedule: 'Reschedule…',
  rescheduleSub: 'Pick the next review · difficulty unchanged',
  bury: 'Bury until tomorrow',
  burySub: 'Skip it today; the schedule stays',
  flag: 'Flag',
  unflag: 'Unflag',
  flagSub: 'Your marker · no effect on scheduling',
  suspend: 'Suspend card',
  suspendSub: 'Hide it until you unsuspend it',
  switchMode: 'Switch mode',
  info: 'Card info',
  infoSub: 'Status, next review and history',
} as const;

interface CardActionsSheetProps {
  /** The card's one-line prompt (face.promptPlain). */
  title: string;
  /** Is the card flagged right now? Read from the store copy, not the queue copy. */
  flagged: boolean;
  /** Does the card have a schedule to move (Learning, Review, Mastered)? */
  canReschedule: boolean;
  /** The current mode's word ("Flashcards"), for the Switch mode row. */
  modeLabel: string;
  open: boolean;
  onClose: () => void;
  onClosed?: () => void;
  onEdit: () => void;
  onReschedule: () => void;
  onBury: () => void;
  onFlag: () => void;
  onSuspend: () => void;
  onSwitchMode: () => void;
  onInfo: () => void;
}

export function CardActionsSheet({
  title,
  flagged,
  canReschedule,
  modeLabel,
  open,
  onClose,
  onClosed,
  onEdit,
  onReschedule,
  onBury,
  onFlag,
  onSuspend,
  onSwitchMode,
  onInfo,
}: CardActionsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} title={title}>
      <ListRow icon="create-outline" title={CARD_ACTIONS_COPY.edit} sub={CARD_ACTIONS_COPY.editSub} onPress={onEdit} />
      <ListRow
        icon="calendar-outline"
        title={CARD_ACTIONS_COPY.reschedule}
        sub={canReschedule ? CARD_ACTIONS_COPY.rescheduleSub : NOTHING_TO_RESCHEDULE}
        onPress={canReschedule ? onReschedule : undefined}
        // No chevron when the row cannot open anything.
        right={canReschedule ? undefined : <View />}
      />
      <ListRow icon="eye-off-outline" title={CARD_ACTIONS_COPY.bury} sub={CARD_ACTIONS_COPY.burySub} onPress={onBury} />
      <ListRow
        icon={flagged ? 'flag' : 'flag-outline'}
        title={flagged ? CARD_ACTIONS_COPY.unflag : CARD_ACTIONS_COPY.flag}
        sub={CARD_ACTIONS_COPY.flagSub}
        onPress={onFlag}
      />
      <ListRow
        icon="pause-circle-outline"
        title={CARD_ACTIONS_COPY.suspend}
        sub={CARD_ACTIONS_COPY.suspendSub}
        onPress={onSuspend}
      />
      <ListRow
        icon="swap-horizontal"
        title={CARD_ACTIONS_COPY.switchMode}
        sub={`Now: ${modeLabel} · for this session only`}
        onPress={onSwitchMode}
      />
      <ListRow
        icon="information-circle-outline"
        title={CARD_ACTIONS_COPY.info}
        sub={CARD_ACTIONS_COPY.infoSub}
        onPress={onInfo}
        last
      />
    </Sheet>
  );
}
