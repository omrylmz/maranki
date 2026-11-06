/**
 * TagEditSheet — "Add tag…" / "Remove tag…" for many cards at once (spec
 * §2.3, §8.3 Library select mode, unit W4-2).
 *
 *   <TagEditSheet mode="add" open={…} onClose={…} tags={libraryTags}
 *                 cardCount={12} onApply={(tags) => actions.tagNotes(noteIds, tags, [])} />
 *
 *   Add a tag                              Remove a tag
 *   [ verb            ]                    Tap the tags to remove.
 *   (verb ×)                               (A1 (12)) (noun (3))
 *   Used in your library: + noun + A1      [ Remove 2 tags ]
 *   [ Add to 12 cards ]
 *
 * Tags belong to the ITEM (the note), so a tag is added to or removed from
 * every direction of a selected card; the screen's snackbar says how many
 * cards changed. Anki tags have no spaces: a space or a comma ends a tag,
 * and '::' makes a tree ("German::Verbs"). The sheet only reports the
 * choice (`onApply`); it never writes the store.
 *
 * `tags` is, for "add", the library's tags (suggestions, the most used
 * first) and, for "remove", the tags of the selected cards with how many of
 * them have each.
 */
import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Btn, Chip, Sheet } from '@/components/ui';
import { parseTagInput, tagsWithDraft } from '@/domain/fieldText';
import { foldText, plural } from '@/domain/text';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { shortLabel, valueText } from './libraryState';

export interface TagCount {
  tag: string;
  count: number;
}

interface TagEditSheetProps {
  open: boolean;
  onClose: () => void;
  mode: 'add' | 'remove';
  tags: readonly TagCount[];
  /** How many cards the change is for ("Add to {n} cards"). */
  cardCount: number;
  /** The chosen tags; the sheet then closes itself. */
  onApply: (tags: string[]) => void;
}

/** At most this many suggestions are shown under the box. */
const MAX_SUGGESTIONS = 12;

export function TagEditSheet({ open, onClose, mode, tags, cardCount, onApply }: TagEditSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={mode === 'add' ? 'Add a tag' : 'Remove a tag'}>
      {mode === 'add' ? (
        <AddBody tags={tags} cardCount={cardCount} onApply={onApply} onClose={onClose} />
      ) : (
        <RemoveBody tags={tags} cardCount={cardCount} onApply={onApply} onClose={onClose} />
      )}
    </Sheet>
  );
}

interface BodyProps {
  tags: readonly TagCount[];
  cardCount: number;
  onApply: (tags: string[]) => void;
  onClose: () => void;
}

/** "Add a tag": type tags (or tap a suggestion), then "Add to {n} cards". */
function AddBody({ tags, cardCount, onApply, onClose }: BodyProps) {
  const c = useColors();
  const [chosen, setChosen] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const all = tagsWithDraft(chosen, draft);
  const taken = new Set(all.map((t) => t.toLowerCase()));
  const typed = foldText(draft.trim());
  const suggestions = tags
    .filter((t) => !taken.has(t.tag.toLowerCase()) && (typed === '' || foldText(t.tag).startsWith(typed)))
    .slice(0, MAX_SUGGESTIONS);

  /** A space or a comma ends a tag: it becomes a chip, the rest stays in the box. */
  const type = (text: string) => {
    const lastSep = Math.max(text.lastIndexOf(' '), text.lastIndexOf(','));
    if (lastSep < 0) {
      setDraft(text);
      return;
    }
    const done = parseTagInput(text.slice(0, lastSep));
    if (done.length > 0) setChosen(tagsWithDraft(chosen, done.join(' ')));
    setDraft(text.slice(lastSep + 1));
  };

  const apply = () => {
    if (all.length === 0) return;
    onClose();
    onApply(all);
  };

  return (
    <View>
      <TextInput
        value={draft}
        onChangeText={type}
        onSubmitEditing={() => {
          setChosen(all);
          setDraft('');
        }}
        submitBehavior="submit"
        returnKeyType="done"
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Tag, for example verb"
        placeholderTextColor={c.ink3}
        accessibilityLabel="Tag"
        style={[
          font('sans', 400),
          {
            fontSize: 15.5,
            color: c.ink,
            backgroundColor: c.card,
            borderWidth: 1,
            borderColor: c.hairlineStrong,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
          },
        ]}
      />
      {chosen.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {chosen.map((tag) => (
            <Chip key={tag} active dismiss label={tag} onDismiss={() => setChosen(chosen.filter((t) => t !== tag))}>
              {shortLabel(tag, 30)}
            </Chip>
          ))}
        </View>
      ) : null}
      {suggestions.length > 0 ? (
        <View style={{ marginTop: 14 }}>
          <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginBottom: 6 }]}>
            Used in your library
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {suggestions.map((t) => (
              <Pressable
                key={t.tag}
                onPress={() => {
                  setChosen(tagsWithDraft(chosen, t.tag));
                  setDraft('');
                }}
                accessibilityRole="button"
                accessibilityLabel={`Add tag ${t.tag}`}
                hitSlop={6}
                style={({ pressed }) => ({
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: 999,
                  backgroundColor: c.paperSunk,
                  transform: [{ scale: pressed ? 0.97 : 1 }],
                })}
              >
                <Text style={[font('sans', 600), { fontSize: 12.5, color: c.ink2 }]}>+ {shortLabel(t.tag, 26)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      <Btn full disabled={all.length === 0} onPress={apply} style={{ marginTop: 18 }}>
        {`Add to ${plural(cardCount, 'card')}`}
      </Btn>
    </View>
  );
}

/** "Remove a tag": tap the tags of the selected cards, then "Remove {k} tags". */
function RemoveBody({ tags, onApply, onClose }: BodyProps) {
  const c = useColors();
  const [chosen, setChosen] = useState<string[]>([]);
  if (tags.length === 0) {
    return (
      <Text style={[font('sans', 400), { fontSize: 14, color: c.ink3, paddingVertical: 12 }]}>
        These cards have no tags.
      </Text>
    );
  }
  const toggle = (tag: string) =>
    setChosen(chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag]);
  const apply = () => {
    if (chosen.length === 0) return;
    onClose();
    onApply(chosen);
  };
  return (
    <View>
      <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2, marginBottom: 12 }]}>
        Tap the tags to remove.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {tags.map((t) => (
          <Chip
            key={t.tag}
            active={chosen.includes(t.tag)}
            onPress={() => toggle(t.tag)}
            label={`${t.tag}, ${plural(t.count, 'card')}`}
          >
            {valueText(shortLabel(t.tag, 28), t.count)}
          </Chip>
        ))}
      </View>
      <Btn full kind="danger" disabled={chosen.length === 0} onPress={apply} style={{ marginTop: 18 }}>
        {chosen.length === 0 ? 'Remove' : `Remove ${plural(chosen.length, 'tag')}`}
      </Btn>
    </View>
  );
}
