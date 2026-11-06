/**
 * SessionHeader — the chrome-minimal top bar: close, the "n / total" counter,
 * undo, more, and the thin ink progress line beneath. A Practice session
 * says so under the counter ("Practice · no schedule change"), because its
 * ratings change nothing (spec §6.6).
 *
 * Every icon button has a label for the screen reader (spec §8.12).
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bar, IconBtn } from '@/components/ui';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The screen-reader labels of the header buttons. */
export const SESSION_HEADER_LABELS = {
  close: 'Close session',
  undo: 'Undo last rating',
  more: 'More actions for this card',
} as const;

/** The line under the counter in a Practice session. */
export const PRACTICE_LINE = 'Practice · no schedule change';

interface SessionHeaderProps {
  idx: number;
  total: number;
  canUndo: boolean;
  /** True in a Practice session (shows PRACTICE_LINE). */
  practice?: boolean;
  onClose: () => void;
  onUndo: () => void;
  onMore: () => void;
}

export function SessionHeader({ idx, total, canUndo, practice, onClose, onUndo, onMore }: SessionHeaderProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const shown = Math.min(idx + 1, Math.max(total, 1));
  return (
    <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <IconBtn
          icon="close"
          size={36}
          iconSize={20}
          color={c.ink2}
          label={SESSION_HEADER_LABELS.close}
          onPress={onClose}
        />
        <View
          style={{ flex: 1, alignItems: 'center' }}
          accessible
          accessibilityLabel={`Card ${shown} of ${total}${practice ? `. ${PRACTICE_LINE}` : ''}`}
        >
          <Text style={[font('mono', 400), tnum, { fontSize: 13.5, color: c.ink2 }]}>
            {shown} <Text style={{ color: c.ink3 }}>/ {total}</Text>
          </Text>
          {practice ? (
            <Text style={[font('sans', 600), { fontSize: 11.5, color: c.ink3, marginTop: 1 }]}>{PRACTICE_LINE}</Text>
          ) : null}
        </View>
        <IconBtn
          icon="arrow-undo"
          size={36}
          iconSize={18}
          disabled={!canUndo}
          label={SESSION_HEADER_LABELS.undo}
          onPress={onUndo}
          color={c.ink2}
        />
        <IconBtn
          icon="ellipsis-horizontal"
          size={36}
          iconSize={18}
          label={SESSION_HEADER_LABELS.more}
          onPress={onMore}
          color={c.ink2}
        />
      </View>
      <View style={{ marginTop: 8, marginHorizontal: 2 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Bar value={total > 0 ? (idx / total) * 100 : 0} h={3} />
      </View>
    </View>
  );
}
