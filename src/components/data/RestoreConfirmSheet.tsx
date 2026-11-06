/**
 * RestoreConfirmSheet — the last step before a restore (spec §8.4 step 4).
 *
 *   Restore this backup?
 *   From 12 Oct 2026, 21:04 · 3 decks · 1,240 cards · 12-day streak.
 *   This backup has no review history, so your current review history is kept.   ← only then (wave 5b R2)
 *   ┌ This replaces everything on this phone. We save a backup of your
 *   └ current data first.
 *   [ Hold to restore ]        ← a 1-second hold (HoldButton)
 *   Cancel
 *
 * It only shows and asks. The Restore flow (RestoreFlow.tsx) owns the backup
 * and does the restore in `onConfirm`. The HoldButton comes from the UI kit
 * (src/components/ui/HoldButton.tsx). Every word comes from RESTORE_COPY and
 * restoreSummaryLine() in src/store/backup.ts (pinned by autoBackup.test.ts).
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { A11Y_HIDDEN, HoldButton, Ion, Sheet } from '@/components/ui';
import { RESTORE_COPY, restoreHistoryNote, type RestoreSummary, restoreSummaryLine } from '@/store/backup';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface RestoreConfirmSheetProps {
  open: boolean;
  /** What the backup holds. null only while the sheet is closing. */
  summary: RestoreSummary | null;
  /** True while the restore runs: the hold button is disabled. */
  busy: boolean;
  /** The hold is complete: restore now. */
  onConfirm: () => void;
  /** "Cancel", the scrim or the back button. */
  onCancel: () => void;
  /** After the close animation (to forget the backup without a flash). */
  onClosed?: () => void;
}

export function RestoreConfirmSheet({
  open,
  summary,
  busy,
  onConfirm,
  onCancel,
  onClosed,
}: RestoreConfirmSheetProps) {
  const c = useColors();
  // A backup without review history keeps the phone's own (performRestore): say so before the hold.
  const historyNote = summary ? restoreHistoryNote(summary) : null;
  return (
    <Sheet open={open} onClose={onCancel} onClosed={onClosed} title={RESTORE_COPY.title}>
      {summary ? (
        <Text
          style={[
            font('sans', 400),
            tnum,
            { fontSize: 14.5, lineHeight: 21, color: c.ink2, marginBottom: historyNote ? 8 : 14 },
          ]}
        >
          {restoreSummaryLine(summary)}
        </Text>
      ) : null}
      {historyNote ? (
        <Text style={[font('sans', 400), { fontSize: 13.5, lineHeight: 20, color: c.ink2, marginBottom: 14 }]}>
          {historyNote}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          gap: 10,
          alignItems: 'flex-start',
          backgroundColor: c.warningTint,
          borderRadius: 12,
          paddingVertical: 11,
          paddingHorizontal: 14,
          marginBottom: 18,
        }}
      >
        <View {...A11Y_HIDDEN}>
          <Ion name="warning-outline" size={17} color={c.warning} style={{ marginTop: 1 }} />
        </View>
        <Text style={[font('sans', 400), { flex: 1, fontSize: 13.5, lineHeight: 20, color: c.ink }]}>
          {RESTORE_COPY.replaces}
        </Text>
      </View>
      <HoldButton icon="refresh-circle-outline" disabled={busy || !summary} onConfirm={onConfirm}>
        {RESTORE_COPY.hold}
      </HoldButton>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        style={{ alignSelf: 'center', marginTop: 14 }}
        hitSlop={8}
      >
        <Text style={[font('sans', 700), { fontSize: 14, color: c.ink2 }]}>{RESTORE_COPY.cancel}</Text>
      </Pressable>
    </Sheet>
  );
}
