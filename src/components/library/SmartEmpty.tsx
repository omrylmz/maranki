/**
 * The Library's two empty states (spec §8.3, §8.11, unit W4-2).
 *
 * SmartEmpty — the filters match no card:
 *
 *   No cards match Level: C2 + Suspended.
 *   [ Remove Suspended ]   [ Clear all ]
 *
 *   "Remove {chip}" is the ONE chip whose removal gives the most results
 *   (libraryState bestChipToRemove, the same one-pass counting as the
 *   filter groups). It is not shown when no single chip helps; "Clear all"
 *   always is.
 *
 * EmptyLibrary — there are no cards at all:
 *
 *   Your library is empty.
 *   [ Import a file ]   [ Make my own deck ]
 */
import React from 'react';
import { Text, View } from 'react-native';

import { A11Y_HIDDEN, Btn, Ion } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { type ChipRemoval, LIBRARY_COPY } from './libraryState';

interface SmartEmptyProps {
  /** The labels of every applied chip, text included ("Level: C2", "Suspended"). */
  labels: readonly string[];
  best: ChipRemoval | null;
  onRemove: (chipId: string) => void;
  onClearAll: () => void;
}

export function SmartEmpty({ labels, best, onRemove, onClearAll }: SmartEmptyProps) {
  const c = useColors();
  const bold = [font('sans', 700), { color: c.ink }];
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 12 }}>
      <View {...A11Y_HIDDEN}>
        <Ion name="search" size={32} color={c.ink3} />
      </View>
      <Text
        accessibilityRole="header"
        style={[font('sans', 400), { fontSize: 15, lineHeight: 22, color: c.ink2, textAlign: 'center', marginTop: 12 }]}
      >
        No cards match{' '}
        {labels.map((label, i) => (
          <Text key={label}>
            {i > 0 ? ' + ' : ''}
            <Text style={bold}>{label}</Text>
          </Text>
        ))}
        .
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 18 }}>
        {best ? (
          <Btn kind="primary" onPress={() => onRemove(best.chipId)}>
            {`Remove ${best.label}`}
          </Btn>
        ) : null}
        <Btn kind="secondary" onPress={onClearAll}>
          {LIBRARY_COPY.clearAll}
        </Btn>
      </View>
    </View>
  );
}

interface EmptyLibraryProps {
  onImport: () => void;
  onMakeDeck: () => void;
}

export function EmptyLibrary({ onImport, onMakeDeck }: EmptyLibraryProps) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 46, paddingHorizontal: 20 }}>
      <View {...A11Y_HIDDEN}>
        <Ion name="library-outline" size={34} color={c.ink3} />
      </View>
      <Text
        accessibilityRole="header"
        style={[font('serif', 600), { fontSize: 19, color: c.ink, marginTop: 12, marginBottom: 16, textAlign: 'center' }]}
      >
        {LIBRARY_COPY.emptyTitle}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 }}>
        <Btn onPress={onImport} icon="download-outline">
          {LIBRARY_COPY.importFile}
        </Btn>
        <Btn kind="secondary" onPress={onMakeDeck} icon="create-outline">
          {LIBRARY_COPY.makeDeck}
        </Btn>
      </View>
    </View>
  );
}
