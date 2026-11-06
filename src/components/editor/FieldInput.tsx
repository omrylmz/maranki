/**
 * One note field in the card editor (spec §8.10): a labelled, MULTILINE text
 * box in the paper & ink style of the kit's `Field` (src/components/ui/controls.tsx).
 *
 *   <FieldInput ref={firstRef} label="Front" required value={v} onChange={setV} />
 *
 * Why not the kit's `Field`: the editor needs a `ref` to the text box, so
 * "Save & add another" can put the cursor back into the first field. (React 19:
 * `ref` is a normal prop of a function component.)
 *
 * `formatted` shows the note "Formatted text — edits keep line breaks" under
 * a field whose stored text is HTML (an imported Anki field). The text box
 * then shows the raw HTML as text, with <br> as real line breaks
 * (src/domain/fieldText.ts converts both ways).
 */
import React from 'react';
import { Text, TextInput, View } from 'react-native';

import { Overline } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface FieldInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Adds " *" to the label: Save stays disabled while this field is empty. */
  required?: boolean;
  /** The stored text is HTML: show the "Formatted text" note. */
  formatted?: boolean;
  /** A small line under the box (for example how to write a cloze deletion). */
  hint?: string;
  /** A warning under the box, in the danger colour (for example "Add a deletion like {{c1::this}}."). */
  error?: string;
  placeholder?: string;
  autoFocus?: boolean;
  ref?: React.Ref<TextInput>;
}

export function FieldInput({
  label,
  value,
  onChange,
  required,
  formatted,
  hint,
  error,
  placeholder,
  autoFocus,
  ref,
}: FieldInputProps) {
  const c = useColors();
  const title = required ? `${label} *` : label;
  return (
    <View style={{ marginBottom: 16 }}>
      <Overline style={{ marginBottom: 7 }}>{title}</Overline>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.ink3}
        autoFocus={autoFocus}
        multiline
        // The box grows with its text; the screen's ScrollView scrolls.
        scrollEnabled={false}
        accessibilityLabel={title}
        accessibilityHint={formatted ? 'Formatted text. Edits keep line breaks.' : undefined}
        style={[
          font('sans', 400),
          {
            backgroundColor: c.card,
            borderWidth: 1,
            borderColor: error ? c.danger : c.hairlineStrong,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 12,
            fontSize: 15.5,
            color: c.ink,
            lineHeight: 22,
            minHeight: 48,
            textAlignVertical: 'top',
          },
        ]}
      />
      {formatted ? (
        <Text style={[font('sans', 600), { fontSize: 12, color: c.ink3, marginTop: 5 }]}>
          Formatted text — edits keep line breaks
        </Text>
      ) : null}
      {error ? (
        <Text style={[font('sans', 600), { fontSize: 12, color: c.danger, marginTop: 5 }]}>{error}</Text>
      ) : null}
      {hint ? (
        <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginTop: 5 }]}>{hint}</Text>
      ) : null}
    </View>
  );
}
