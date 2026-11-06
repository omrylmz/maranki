/**
 * The card editor's tag row (spec §8.10):
 *
 *   Tags   (verb ×) (irregular ×) [+ tag]
 *          From this deck: (A1) (noun) …
 *
 * Fully CONTROLLED: the screen owns both the chips (`tags`) and the text
 * still being typed (`draft`). WHY the draft too: a tag typed but not yet
 * confirmed must still be saved when the learner taps Save (the screen adds
 * it with `tagsWithDraft`, src/domain/fieldText.ts) — tapping Save does not
 * blur the text box, so this component could not commit it in time.
 *
 * A space, a comma or the Return key turns the typed text into chips (Anki
 * tags have no spaces). '::' marks a hierarchy ("German::Verbs").
 *
 * A suggestion tap FINISHES the word being typed (`pickSuggestion`): "ver"
 * + tap "+ verb" gives the chip "verb" and an empty box, never the extra tag
 * "ver" on Save. The screen passes suggestions that start with the draft
 * (fieldText.ts `tagSuggestions(…, draft)`). The screen's ScrollView keeps
 * taps (`keyboardShouldPersistTaps="handled"`), so the tap does not blur the
 * box first (a blur would commit the half word as a chip).
 */
import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Chip, Ion, Overline } from '@/components/ui';
import { parseTagInput, pickSuggestion, tagsWithDraft } from '@/domain/fieldText';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface TagInputProps {
  tags: string[];
  draft: string;
  onChangeTags: (tags: string[]) => void;
  onChangeDraft: (draft: string) => void;
  /** Tags of this deck that are not chosen yet (and start with the draft), the most used first. */
  suggestions: string[];
}

export function TagInput({ tags, draft, onChangeTags, onChangeDraft, suggestions }: TagInputProps) {
  const c = useColors();

  /** Turn the typed text into chips, keep the unfinished last word in the box. */
  const type = (text: string) => {
    const lastSep = Math.max(text.lastIndexOf(' '), text.lastIndexOf(','), text.lastIndexOf('\n'));
    if (lastSep < 0) {
      onChangeDraft(text);
      return;
    }
    const done = parseTagInput(text.slice(0, lastSep));
    if (done.length > 0) onChangeTags(tagsWithDraft(tags, done.join(' ')));
    onChangeDraft(text.slice(lastSep + 1));
  };

  const commit = () => {
    if (parseTagInput(draft).length > 0) onChangeTags(tagsWithDraft(tags, draft));
    onChangeDraft('');
  };

  const remove = (tag: string) => onChangeTags(tags.filter((t) => t !== tag));

  /** A suggestion tap: add it, and replace the half word it finishes. */
  const suggest = (tag: string) => {
    const next = pickSuggestion(tags, draft, tag);
    onChangeTags(next.tags);
    if (next.draft !== draft) onChangeDraft(next.draft);
  };

  return (
    <View style={{ marginBottom: 16 }}>
      <Overline style={{ marginBottom: 7 }}>Tags</Overline>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
        {tags.map((tag) => (
          <Chip key={tag} dismiss onDismiss={() => remove(tag)}>
            {tag}
          </Chip>
        ))}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: c.hairlineStrong,
            borderRadius: 999,
            paddingLeft: 10,
            paddingRight: 12,
            minWidth: 96,
          }}
        >
          <Ion name="add" size={14} color={c.ink3} />
          <TextInput
            value={draft}
            onChangeText={type}
            onSubmitEditing={commit}
            onBlur={commit}
            submitBehavior="submit"
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="tag"
            placeholderTextColor={c.ink3}
            accessibilityLabel="Add a tag"
            style={[
              font('sans', 600),
              { fontSize: 13.5, color: c.ink, paddingVertical: 7, minWidth: 60 },
            ]}
          />
        </View>
      </View>
      {suggestions.length > 0 ? (
        <View style={{ marginTop: 10 }}>
          <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginBottom: 6 }]}>
            From this deck
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {suggestions.map((tag) => (
              <Pressable
                key={tag}
                onPress={() => suggest(tag)}
                accessibilityRole="button"
                accessibilityLabel={`Add tag ${tag}`}
                hitSlop={4}
                style={({ pressed }) => ({
                  paddingVertical: 5,
                  paddingHorizontal: 10,
                  borderRadius: 999,
                  backgroundColor: c.paperSunk,
                  transform: [{ scale: pressed ? 0.97 : 1 }],
                })}
              >
                <Text style={[font('sans', 600), { fontSize: 12.5, color: c.ink2 }]}>+ {tag}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
