/**
 * The card editor's "Card type" row (spec §8.10, shown only for a NEW card):
 *
 *   CARD TYPE   [ Basic + reverse ▾ ]
 *
 * Tapping it opens a sheet with the card types this card can use
 * (`cardTypeOptions`, src/domain/fieldText.ts): the deck's own types first
 * (an imported deck offers its type with every field), then Basic,
 * Basic + reverse and Cloze. A card type is the list of fields and
 * directions that many cards share (glossary §1.2); the editor then shows
 * that type's fields.
 *
 * A row's second line lists the type's fields and ends with "…" when there
 * are more ("2 directions · Word, Grammar, Verb Forms, Examples,
 * Translation, …"). The space before that "…" is a no-break space
 * (keepEllipsisWithWord), so the "…" never wraps onto a line of its own
 * (walkthrough L10).
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Ion, Overline, Row, Sheet } from '@/components/ui';
import type { CardTypeOption } from '@/domain/fieldText';
import type { Id } from '@/domain/model';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** U+00A0: a space where a line may not break. */
const NO_BREAK_SPACE = '\u00a0';

/**
 * The same text, with the spaces right before a final "…" made no-break
 * spaces: the "…" stays on the line of the word before it.
 *
 *   keepEllipsisWithWord('Word, Grammar, …') → 'Word, Grammar,\u00a0…'
 *   keepEllipsisWithWord('Front, Back')      → 'Front, Back'
 */
export function keepEllipsisWithWord(text: string): string {
  return text.replace(/[ \t]+…$/, `${NO_BREAK_SPACE}…`);
}

interface CardTypePickerProps {
  options: CardTypeOption[];
  value: Id;
  onChange: (typeId: Id) => void;
}

export function CardTypePicker({ options, value, onChange }: CardTypePickerProps) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value) ?? null;
  const name = current?.name ?? 'Choose a card type';
  return (
    <View style={{ marginBottom: 16 }}>
      <Overline style={{ marginBottom: 7 }}>Card type</Overline>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Card type: ${name}. Change`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.hairlineStrong,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 11,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>
            {name}
          </Text>
          {current ? (
            <Text numberOfLines={1} style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginTop: 1 }]}>
              {keepEllipsisWithWord(current.sub)}
            </Text>
          ) : null}
        </View>
        <Ion name="chevron-down" size={16} color={c.ink3} />
      </Pressable>

      <Sheet open={open} onClose={() => setOpen(false)} title="Card type">
        {options.map((o, i) => (
          <Row
            key={o.id}
            last={i === options.length - 1}
            padV={12}
            onPress={() => {
              onChange(o.id);
              setOpen(false);
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>
                {o.name}
              </Text>
              <Text numberOfLines={2} style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>
                {keepEllipsisWithWord(o.sub)}
              </Text>
            </View>
            {o.id === value ? <Ion name="checkmark" size={19} color={c.pine} /> : null}
          </Row>
        ))}
      </Sheet>
    </View>
  );
}
