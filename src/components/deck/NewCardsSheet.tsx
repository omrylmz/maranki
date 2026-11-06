/**
 * NewCardsSheet — how new cards come from this deck (spec §3.4 DeckOptions,
 * §8.2 deck settings). Three choices, each saved at once with
 * `setDeckOptions` (the page passes `onChange`):
 *
 *   NEW CARDS PER DAY   (•) Use my daily limit (10)   ( ) My own number for this deck   [ - 20 + ]
 *   NEW CARD ORDER      ( Deck order | Random order )
 *   NEW CARDS ARRIVE AS ( In my queue | Not started )
 *
 * The deck's own number is a CAP: the daily limit still counts (spec §4.5
 * bucket 4), so a deck number above the daily limit gives the daily limit.
 * The sheet says so. "Random order" is a stable order (a hash of the card
 * id), not a new shuffle every day.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { Ion, Overline, SegCtrl, Sheet, Stepper } from '@/components/ui';
import type { DeckOptions } from '@/domain/model';
import { plural } from '@/domain/text';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { ARRIVAL_LABELS, NEW_ORDER_LABELS, NEW_PER_DAY_MAX } from './deckPageLogic';

interface NewCardsSheetProps {
  open: boolean;
  onClose: () => void;
  options: DeckOptions;
  dailyNewLimit: number;
  onChange: (patch: Partial<DeckOptions>) => void;
}

export function NewCardsSheet({ open, onClose, options, dailyNewLimit, onChange }: NewCardsSheetProps) {
  const c = useColors();
  const own = typeof options.newPerDay === 'number' && Number.isFinite(options.newPerDay);
  const value = own ? Math.max(0, Math.floor(options.newPerDay as number)) : Math.max(0, dailyNewLimit);
  const hint: React.ComponentProps<typeof Text>['style'] = [
    font('sans', 400),
    { fontSize: 12.5, lineHeight: 18, color: c.ink3, marginTop: 6 },
  ];

  return (
    <Sheet open={open} onClose={onClose} title="New cards">
      <Overline header style={{ marginBottom: 7 }}>
        New cards per day
      </Overline>
      {/* Two radio rows, not a segmented control: the first label is long and must never be cut. */}
      <Choice
        on={!own}
        title={`Use my daily limit (${dailyNewLimit.toLocaleString('en-US')})`}
        onPress={() => onChange({ newPerDay: null })}
      />
      <Choice on={own} title="My own number for this deck" onPress={() => onChange({ newPerDay: value })} />
      {own ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <Text style={[font('sans', 600), { fontSize: 14.5, color: c.ink }]}>New cards a day from this deck</Text>
          <Stepper
            value={value}
            min={0}
            max={NEW_PER_DAY_MAX}
            onChange={(n) => onChange({ newPerDay: n })}
            label="New cards a day from this deck"
            valueLabel={(n) => `${plural(n, 'new card')} a day`}
          />
        </View>
      ) : null}
      <Text style={hint}>
        {own && value > dailyNewLimit
          ? `Your daily limit (${dailyNewLimit.toLocaleString('en-US')}) still counts, so this deck gives at most ${dailyNewLimit.toLocaleString('en-US')}.`
          : 'Your daily limit counts for all decks together. A deck number is the most this deck adds.'}
      </Text>

      <Overline header style={{ marginTop: 22, marginBottom: 7 }}>
        New card order
      </Overline>
      <SegCtrl
        size="sm"
        label="New card order"
        value={options.newOrder}
        onChange={(id) => onChange({ newOrder: id === 'random' ? 'random' : 'source' })}
        options={[
          { id: 'source', label: NEW_ORDER_LABELS.source },
          { id: 'random', label: NEW_ORDER_LABELS.random },
        ]}
      />

      <Overline header style={{ marginTop: 22, marginBottom: 7 }}>
        New cards arrive as
      </Overline>
      <SegCtrl
        size="sm"
        label="New cards arrive as"
        value={options.newArrival}
        onChange={(id) => onChange({ newArrival: id === 'notStarted' ? 'notStarted' : 'queued' })}
        options={[
          { id: 'queued', label: ARRIVAL_LABELS.queued },
          { id: 'notStarted', label: ARRIVAL_LABELS.notStarted },
        ]}
      />
      <Text style={hint}>
        For cards you add or import into this deck from now on. Not started cards wait until you choose them.
      </Text>
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
      <Text style={[font('sans', on ? 600 : 400), { flex: 1, fontSize: 14.5, color: on ? c.ink : c.ink2 }]}>{title}</Text>
    </Pressable>
  );
}
