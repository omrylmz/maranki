/**
 * CardActionsSheet — the per-card actions bottom sheet: Reschedule, Bury, Flag,
 * and Switch mode. Titled with the card's front. Reschedule and Switch mode are
 * informational-only (they surface a snack); Bury and Flag drive real mutations
 * owned by the session orchestrator.
 */
import React from 'react';

import { ListRow, Sheet } from '@/components/ui';
import { Card } from '@/domain/types';

interface CardActionsSheetProps {
  card: Card;
  open: boolean;
  onClose: () => void;
  onBury: () => void;
  onFlag: () => void;
  onSnack: (text: string) => void;
}

export function CardActionsSheet({
  card,
  open,
  onClose,
  onBury,
  onFlag,
  onSnack,
}: CardActionsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={card.front}>
      <ListRow
        icon="repeat"
        title="Reschedule"
        sub="Set when you'll see this next · difficulty unchanged"
        onPress={() => {
          onClose();
          onSnack('Reschedule — pick the next review date');
        }}
      />
      <ListRow
        icon="eye-off-outline"
        title="Bury for now"
        sub="Skip today without changing its schedule"
        onPress={onBury}
      />
      <ListRow
        icon={card.flagged ? 'flag' : 'flag-outline'}
        title={card.flagged ? 'Unflag' : 'Flag'}
        sub="Bookmark for later — no effect on scheduling"
        onPress={onFlag}
      />
      <ListRow
        icon="swap-horizontal"
        title="Switch mode"
        sub="Flashcard · typing · multiple choice"
        onPress={() => {
          onClose();
          onSnack('Mode switch — flashcard · typing · quiz');
        }}
        last
      />
    </Sheet>
  );
}
