/**
 * SaveListSheet — "Save as list" in the Library, and "Rename" of a list
 * (spec §2.3, §4.7, unit W4-2). A list is a SAVED FILTER: it stores the
 * query, not the cards, so it is always up to date (glossary "List").
 *
 *   <SaveListSheet open={…} onClose={…} query={chips} sort={sort}
 *                  defaultName="Level: B1 · Not started" onSaved={(list) => …} />   // new list
 *   <SaveListSheet open={…} onClose={…} list={list} />                              // rename
 *
 *   Save as list (?)
 *   NAME   [ B1 verbs              ]   12 / 40
 *   ICON   🔖 ⭐ 📌 🎯 🧠 📚 …   [ Type any emoji ]
 *   [ Save list ]
 *
 * Props:
 *   - `query`, `sort`  what a NEW list saves (the Library's chips and its
 *                      sort). The `list` key is stripped (lists.ts
 *                      cleanListInput): a list is one level deep.
 *   - `list`           rename THIS list: only its name and icon change (its
 *                      query and sort stay). A built-in list cannot be
 *                      renamed (it is code): the sheet says so.
 *   - `defaultName`    the first name of a new list.
 *   - `onSaved`        called with the saved list.
 *
 * A new list is PINNED (setListPref), so it shows on Today at once — "Save
 * as list → Today list row shows the same N" (spec §11 E10). The name is at
 * most 40 characters (cut by whole characters, lists.ts). The sheet shows a
 * snackbar after saving.
 */
import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Btn, Overline, Sheet } from '@/components/ui';
import { firstGlyph } from '@/domain/fieldText';
import { cleanListInput, DEFAULT_LIST_ICON, isBuiltinListId, LIST_NAME_MAX } from '@/domain/lists';
import type { ListDef, Query, SortSpec } from '@/domain/model';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { InfoButton } from './InfoButton';

interface SaveListSheetProps {
  open: boolean;
  onClose: () => void;
  /** The filter a new list saves. */
  query?: Query;
  sort?: SortSpec;
  /** Rename this list instead of saving a new one. */
  list?: ListDef | null;
  /** The first name of a new list. */
  defaultName?: string;
  onSaved?: (list: ListDef) => void;
}

/** The emoji offered for a list (any other one can be typed). */
export const LIST_ICONS: readonly string[] = [
  '🔖', '⭐', '📌', '🎯', '🧠', '📚', '🔥', '🌱', '🗂️', '✏️', '💬', '🧩', '🎓', '⏱️', '❤️', '🚩',
];

/**
 * A typed icon: its first glyph — ONE emoji, even one made of several code
 * points (a flag, a skin tone, a family). The same rule as the deck icon
 * (fieldText firstGlyph).
 *
 *   typedIcon('🇩🇪 German') → '🇩🇪'     typedIcon('') → ''
 */
export function typedIcon(text: string): string {
  return firstGlyph(text);
}

export function SaveListSheet({ open, onClose, query, sort, list, defaultName, onSaved }: SaveListSheetProps) {
  const renaming = !!list;
  return (
    <Sheet open={open} onClose={onClose}>
      <SaveListBody
        query={query ?? {}}
        sort={sort}
        list={list ?? null}
        defaultName={defaultName ?? ''}
        onSaved={onSaved}
        onClose={onClose}
        title={renaming ? 'Rename list' : 'Save as list'}
      />
    </Sheet>
  );
}

interface BodyProps {
  query: Query;
  sort?: SortSpec;
  list: ListDef | null;
  defaultName: string;
  title: string;
  onSaved?: (list: ListDef) => void;
  onClose: () => void;
}

/** The sheet's content: mounted when the sheet opens, so its fields start fresh each time. */
function SaveListBody({ query, sort, list, defaultName, title, onSaved, onClose }: BodyProps) {
  const c = useColors();
  const { actions } = useData();
  const { show } = useSnackbar();
  const [name, setName] = useState(list ? list.name : defaultName);
  const [icon, setIcon] = useState(list ? list.icon : DEFAULT_LIST_ICON);
  const [custom, setCustom] = useState(list && !LIST_ICONS.includes(list.icon) ? list.icon : '');
  const builtin = list ? isBuiltinListId(list.id) : false;
  const clean = cleanListInput({ name, icon, query: list ? list.query : query });
  const length = Array.from(name.trim()).length;

  const save = () => {
    if (!clean || builtin) return;
    const saved = list
      ? actions.saveList({ id: list.id, name: clean.name, icon: clean.icon, query: list.query, sort: list.sort })
      : actions.saveList({ name: clean.name, icon: clean.icon, query: clean.query, ...(sort ? { sort } : {}) });
    onClose();
    if (!saved) {
      show('This list could not be saved.');
      return;
    }
    // A new list shows on Today at once (Today lists the pinned lists).
    if (!list) actions.setListPref(saved.id, { pinned: true });
    show(list ? `List renamed to '${saved.name}'` : `List '${saved.name}' saved`);
    onSaved?.(saved);
  };

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <Text accessibilityRole="header" style={[font('serif', 600), { fontSize: 22, color: c.ink }]}>
          {title}
        </Text>
        <InfoButton term="List" />
      </View>
      {builtin ? (
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
          Built-in lists can’t be renamed. You can hide this list instead.
        </Text>
      ) : (
        <>
          {!list ? (
            <Text style={[font('sans', 400), { fontSize: 13.5, lineHeight: 19, color: c.ink2, marginBottom: 14 }]}>
              A list saves these filters, not the cards. New cards that match show up in it by themselves.
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 7 }}>
            <Overline>Name</Overline>
            <Text style={[font('mono', 400), { fontSize: 11.5, color: length > LIST_NAME_MAX ? c.danger : c.ink3 }]}>
              {`${length} / ${LIST_NAME_MAX}`}
            </Text>
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus={!list}
            placeholder="For example B1 verbs"
            placeholderTextColor={c.ink3}
            accessibilityLabel="Name"
            returnKeyType="done"
            onSubmitEditing={save}
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
                marginBottom: 16,
              },
            ]}
          />
          <Overline style={{ marginBottom: 8 }}>Icon</Overline>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {LIST_ICONS.map((emoji) => {
              const on = emoji === icon;
              return (
                <Pressable
                  key={emoji}
                  onPress={() => {
                    setIcon(emoji);
                    setCustom('');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Icon ${emoji}`}
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: on ? c.pineTint : c.paperSunk,
                    borderWidth: on ? 1.5 : 0,
                    borderColor: c.pine,
                    transform: [{ scale: pressed ? 0.94 : 1 }],
                  })}
                >
                  <Text style={{ fontSize: 21 }}>{emoji}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={custom}
            onChangeText={(text) => {
              setCustom(text);
              const typed = typedIcon(text);
              setIcon(typed || DEFAULT_LIST_ICON);
            }}
            placeholder="Type any emoji"
            placeholderTextColor={c.ink3}
            accessibilityLabel="Type any emoji"
            style={[
              font('sans', 400),
              {
                fontSize: 15,
                color: c.ink,
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.hairlineStrong,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                marginBottom: 18,
              },
            ]}
          />
        </>
      )}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn kind="secondary" full style={{ flex: 1 }} onPress={onClose}>
          Cancel
        </Btn>
        {!builtin ? (
          <Btn kind="primary" full style={{ flex: 1 }} disabled={!clean} onPress={save}>
            {list ? 'Save' : 'Save list'}
          </Btn>
        ) : null}
      </View>
    </View>
  );
}
