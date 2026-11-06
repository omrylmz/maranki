/**
 * PlacementSheet — "Where do you start?" (spec §5.9, §8.2, §8.5), for a deck
 * with a level-like (ordinal) filter group:
 *
 *   Level   (A1) (A2) (B1) (B2) (C1)
 *   Easier levels:  ( I know them )  ( Leave them not started )
 *   [ Start at A2 ]
 *
 * The groups and their values in level order come from deckPageLogic.ts
 * `placementGroups`. The sheet only collects the choice; the caller applies
 * it (`onApply`):
 *   - the deck page (src/app/deck/[id].tsx `applyPlacement`): "I know them"
 *     marks the never-studied cards of the easier levels Known, "Leave them
 *     not started" moves their New cards back to Not started (one edit, with
 *     Undo); then it opens "Choose what to learn" from the chosen level up
 *     (deckPageLogic.ts `fromLevelScope`), when cards there are still Not
 *     started;
 *   - the triage screen: the easier items leave the run (Known, or left Not
 *     started).
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Btn, Chip, Ion, Overline, SegCtrl, Sheet } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import type { PlacementGroup } from './deckPageLogic';

/** What the learner chose. `fromRank` 0 = start at the first level (nothing is easier). */
export interface PlacementChoice {
  group: PlacementGroup;
  fromRank: number;
  below: 'known' | 'notStarted';
}

interface PlacementSheetProps {
  open: boolean;
  onClose: () => void;
  groups: readonly PlacementGroup[];
  onApply: (choice: PlacementChoice) => void;
}

export function PlacementSheet({ open, onClose, groups, onApply }: PlacementSheetProps) {
  const c = useColors();
  const [key, setKey] = useState<string | null>(null);
  const [fromRank, setFromRank] = useState(0);
  const [below, setBelow] = useState<'known' | 'notStarted'>('known');
  const group = groups.find((g) => g.key === key) ?? groups[0] ?? null;
  const rank = group ? Math.min(fromRank, Math.max(0, group.values.length - 1)) : 0;

  const reset = () => {
    setKey(null);
    setFromRank(0);
    setBelow('known');
  };

  return (
    <Sheet open={open} onClose={onClose} onClosed={reset} title="Where do you start?">
      {!group ? (
        <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2 }]}>This deck has no levels to start from.</Text>
      ) : (
        <View>
          {groups.length > 1 ? (
            <View style={{ marginBottom: 12 }}>
              <SegCtrl
                size="sm"
                label="Group"
                value={group.key}
                onChange={(k) => {
                  setKey(k);
                  setFromRank(0);
                }}
                options={groups.map((g) => ({ id: g.key, label: g.label }))}
              />
            </View>
          ) : null}
          <Overline header style={{ marginBottom: 8 }}>
            {group.label}
          </Overline>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 12 }}>
            {group.values.map((v, i) => (
              <Chip key={v.value} active={rank === i} onPress={() => setFromRank(i)}>
                {v.label}
              </Chip>
            ))}
          </View>

          {rank > 0 ? (
            <View style={{ marginTop: 16 }}>
              <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2, marginBottom: 2 }]}>Easier levels:</Text>
              <Choice on={below === 'known'} title="I know them" onPress={() => setBelow('known')} />
              <Choice on={below === 'notStarted'} title="Leave them not started" onPress={() => setBelow('notStarted')} />
            </View>
          ) : (
            <Text style={[font('sans', 400), { fontSize: 13, lineHeight: 18, color: c.ink3, marginTop: 14 }]}>
              Start at the first level: nothing is skipped.
            </Text>
          )}

          <Btn
            full
            size="lg"
            style={{ marginTop: 18 }}
            onPress={() => onApply({ group, fromRank: rank, below })}
          >
            {`Start at ${group.values[rank]?.label ?? ''}`}
          </Btn>
        </View>
      )}
    </Sheet>
  );
}

/** One radio choice. */
function Choice({ on, title, onPress }: { on: boolean; title: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 }}
    >
      <Ion name={on ? 'radio-button-on' : 'radio-button-off'} size={19} color={on ? c.pine : c.ink3} />
      <Text style={[font('sans', on ? 600 : 400), { flex: 1, fontSize: 14, color: on ? c.ink : c.ink2 }]}>{title}</Text>
    </Pressable>
  );
}
