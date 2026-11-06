/**
 * ListActionsSheet — what you can do with one saved list (spec §2.3, §4.7,
 * §7 #17, unit W4-1). Opened from a Today list row's "⋯" button or a long
 * press on the row.
 *
 *   <ListActionsSheet listId={menuId} open={menuId !== null} onClose={() => setMenuId(null)} />
 *
 *   ⭐ B1 verbs
 *   Rename                       → SaveListSheet in its rename mode (spec §2.3): the name and the
 *                                  icon; saveList keeps the id, the filters and the sort
 *   Edit filters                 → Library with the list's chips (Library offers "Update list")
 *   Hide                         → off Today; it waits behind "Show all lists" (Undo)
 *   Delete list                  → asks first; the cards stay, only the saved filter goes
 *
 * A built-in list (Favorites, Hard cards …) is code, not data (§4.7): it
 * cannot be renamed, changed or deleted. Its sheet offers "Open in Library"
 * and "Hide". A hidden (or not pinned) list offers "Show on Today" instead
 * of "Hide", so hiding is never a one-way trap. Which actions show is
 * todayLogic.ts `listActionKeys` (tested).
 *
 * Every action is real: rename → SaveListSheet → `saveList`, hide/show →
 * `setListPref`, delete → `deleteList`. The sheet keeps the list while it
 * slides out, also after the list was deleted (L22, adjust-state-during-render).
 *
 * "Rename" opens SaveListSheet (the Library's "Save as list" sheet) so both
 * name a list the same way. It opens only AFTER this sheet has slid out
 * (`onClosed`): never two native modals animating at once (like the session's
 * More sheet).
 */
import { type Href, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Btn, ListRow, Sheet } from '@/components/ui';
import { findList } from '@/domain/lists';
import type { DataStateV3, ListDef, ListPref } from '@/domain/model';
import { useSnackbar } from '@/store/SnackbarContext';
import { useEngine, useStateV3 } from '@/store/selectors';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  LIST_ACTION_LABEL,
  type ListActionKey,
  listActionKeys,
  listPrefOf,
  libraryRoute,
  listScope,
} from '../today/todayLogic';

import { SaveListSheet } from './SaveListSheet';

/** The icon of each action row. */
const ACTION_ICON: Readonly<Record<ListActionKey, string>> = {
  rename: 'pencil-outline',
  edit: 'funnel-outline',
  open: 'search-outline',
  hide: 'eye-off-outline',
  show: 'eye-outline',
  delete: 'trash-outline',
};

/** The copy of the sheet (exact). "Rename" uses SaveListSheet's own copy. */
export const LIST_SHEET_COPY = {
  cancel: 'Cancel',
  deleteQuestion: (name: string) => `Delete ‘${name}’?`,
  deleteBody: 'Your cards stay. Only the saved filter is deleted.',
  hidden: (name: string) => `‘${name}’ is hidden. Find it under Show all lists.`,
  shown: (name: string) => `‘${name}’ is on Today again.`,
  deleted: (name: string) => `‘${name}’ deleted.`,
} as const;

type Stage = 'menu' | 'delete';

/** A new Library `nonce` (event handlers only: it reads the clock; render uses useNow()). */
function freshNonce(): string {
  return String(Date.now());
}


const listsOfState = (s: DataStateV3) => s.lists;
const prefsOfState = (s: DataStateV3) => s.listPrefs;

export function ListActionsSheet({
  listId,
  open,
  onClose,
}: {
  listId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const router = useRouter();
  const { actions } = useEngine();
  const { show } = useSnackbar();
  const userLists = useStateV3(listsOfState);
  const prefs = useStateV3(prefsOfState);

  // Keep the last list through the slide-out (L22): `listId` may become null
  // (or the list may be deleted) while the sheet is still closing.
  const [shownId, setShownId] = useState<string | null>(listId);
  if (listId && listId !== shownId) setShownId(listId);
  const [kept, setKept] = useState<ListDef | null>(null);
  const live = shownId ? (findList(shownId, userLists) ?? null) : null;
  if (live && live !== kept) setKept(live);
  const list = live ?? kept;

  const [stage, setStage] = useState<Stage>('menu');
  // "Rename" was tapped: open SaveListSheet once this sheet has slid out.
  // A ref, written and read only in event handlers (never during render).
  const renameNext = useRef(false);
  // The list SaveListSheet renames. It stays after that sheet closes, so the
  // sheet does not turn into "Save as list" while it slides out.
  const [renaming, setRenaming] = useState<ListDef | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const renameSheet = <SaveListSheet open={renameOpen} onClose={() => setRenameOpen(false)} list={renaming} />;
  // Without a list the menu is gone, but SaveListSheet may still be open.
  // The same two places as the full render below ([menu, renameSheet]), so
  // React keeps SaveListSheet mounted when the menu's list goes.
  if (!list) return <>{null}{renameSheet}</>;
  const pref: ListPref = listPrefOf(list, prefs);
  const keys = listActionKeys(list, pref);

  const run = (key: ListActionKey) => {
    switch (key) {
      case 'rename':
        // Close this sheet first; onClosed opens SaveListSheet for this list.
        renameNext.current = true;
        onClose();
        return;
      case 'delete':
        setStage('delete');
        return;
      case 'edit':
      case 'open':
        onClose();
        // Library route (unit W4-2): q = the list, nonce = a new request (spec §4.6).
        router.navigate(libraryRoute(listScope(list.id), freshNonce()) as unknown as Href);
        return;
      case 'hide': {
        const before = { pinned: pref.pinned, hidden: pref.hidden };
        actions.setListPref(list.id, { hidden: true });
        onClose();
        show(LIST_SHEET_COPY.hidden(list.name), { onAction: () => actions.setListPref(list.id, before) });
        return;
      }
      case 'show':
        actions.setListPref(list.id, { hidden: false, pinned: true });
        onClose();
        show(LIST_SHEET_COPY.shown(list.name));
        return;
    }
  };

  const confirmDelete = () => {
    actions.deleteList(list.id);
    onClose();
    show(LIST_SHEET_COPY.deleted(list.name));
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={`${list.icon} ${list.name}`}
        onClosed={() => {
          if (renameNext.current) {
            setRenaming(list);
            setRenameOpen(true);
          }
          renameNext.current = false;
          setStage('menu');
          setShownId(null);
          setKept(null);
        }}
      >
        {stage === 'menu' &&
          keys.map((key, i) => (
            <ListRow
              key={key}
              icon={ACTION_ICON[key]}
              iconColor={key === 'delete' ? c.danger : undefined}
              iconBg={key === 'delete' ? c.dangerTint : undefined}
              title={LIST_ACTION_LABEL[key]}
              danger={key === 'delete'}
              onPress={() => run(key)}
              last={i === keys.length - 1}
            />
          ))}

        {stage === 'delete' && (
          <View style={{ gap: 14 }}>
            <Text style={[font('serif', 600), { fontSize: 19, color: c.ink }]}>
              {LIST_SHEET_COPY.deleteQuestion(list.name)}
            </Text>
            <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2, lineHeight: 20 }]}>
              {LIST_SHEET_COPY.deleteBody}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn kind="secondary" onPress={() => setStage('menu')} style={{ flex: 1 }} full>
                {LIST_SHEET_COPY.cancel}
              </Btn>
              <Btn kind="dangerSolid" onPress={confirmDelete} style={{ flex: 1 }} full>
                {LIST_ACTION_LABEL.delete}
              </Btn>
            </View>
          </View>
        )}
      </Sheet>
      {renameSheet}
    </>
  );
}
