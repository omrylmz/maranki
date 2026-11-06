/**
 * "Lists" on Today (spec §4.7, §8.1, unit W4-1).
 *
 *   LISTS                                               + New list
 *   ❤ Favorites            14 cards · 3 due              [Study 3]  ⋯
 *   🔥 Hard cards           31 cards · 5 due              [Study 5]  ⋯
 *   ⭐ B1 verbs             64 cards · 6 due              [Study 6]  ⋯
 *   Show all lists
 *
 * - Which lists show: todayLogic.ts `splitLists` — pinned lists that are not
 *   hidden; built-in lists only when they have cards. Every other list waits
 *   behind a quiet "Show all lists" (hidden lists, built-in lists that are not
 *   pinned or have 0 cards).
 * - Row tap → Library with the list loaded (`q={"list":id}` + a new nonce).
 *   The pill → a Study session over the list; its number is readyFor({ list })
 *   — exactly the session it opens. No pill when that is 0.
 * - "⋯" or a long press → ListActionsSheet (Rename / Edit filters / Hide /
 *   Delete list; a built-in list: Open in Library / Hide).
 * - "+ New list" → Library with the banner "Choose filters, then tap Save as list."
 *   (the route param `newList=1`; Library reads it with todayLogic newListBannerFor).
 * - "No lists yet. Filter the Library, then tap Save as list." shows only when
 *   the learner has made no list (showNoListsLine). When their lists are only
 *   hidden, the section shows just "Show all lists".
 *
 * The numbers come from ONE memoized selector (todayListsReader): the full
 * numbers are computed only for the rows that are drawn.
 *
 * Large font sizes (device pass 2026-11-02, like the deck rows F1-2): a list
 * name wraps (up to todayNameLines lines, DeckRows.tsx), and at a large font size
 * (useLargeText) the "Study {n}" pill moves under the name.
 */
import { type Href, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ListActionsSheet } from '@/components/sheets/ListActionsSheet';
import { A11Y_HIDDEN, Btn, IconBtn, SectionHead } from '@/components/ui';
import { useLargeText } from '@/components/ui/layout';
import type { ListDef } from '@/domain/model';
import { useStateV3 } from '@/store/selectors';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { todayNameLines } from './DeckRows';
import {
  libraryRoute,
  type ListRowModel,
  listRowLine,
  listScope,
  NEW_LIST_PARAM,
  sessionRoute,
  showNoListsLine,
  studyLabel,
  TODAY_COPY,
  todayListsReader,
} from './todayLogic';

/** A new Library `nonce` (event handlers only: it reads the clock; render uses useNow()). */
function freshNonce(): string {
  return String(Date.now());
}

export function ListRows() {
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const selector = useMemo(() => todayListsReader(now, expanded), [now, expanded]);
  const { shown, more } = useStateV3(selector);

  // Library route (unit W4-2): q = the list (or nothing), nonce = a new request (spec §4.6).
  const openList = (list: ListDef) =>
    router.navigate(libraryRoute(listScope(list.id), freshNonce()) as unknown as Href);
  const newList = () => router.navigate(libraryRoute({}, freshNonce(), NEW_LIST_PARAM) as unknown as Href);
  const study = (list: ListDef) =>
    router.push(sessionRoute('scheduled', listScope(list.id), list.name) as unknown as Href);

  const rows = expanded ? [...shown, ...more] : shown;
  // "No lists yet…" only when the learner has no list at all, not when theirs are hidden.
  const noLists = showNoListsLine({ shown, more }, expanded);

  return (
    <View>
      <SectionHead actionLabel={TODAY_COPY.newList} onAction={newList}>
        Lists
      </SectionHead>
      {noLists && (
        <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, paddingVertical: 10, lineHeight: 19 }]}>
          {TODAY_COPY.noLists}
        </Text>
      )}
      {rows.map((row, i) => (
        <ListRowView
          key={row.list.id}
          row={row}
          onOpen={() => openList(row.list)}
          onStudy={() => study(row.list)}
          onMenu={() => setMenuId(row.list.id)}
          last={i === rows.length - 1}
        />
      ))}
      {more.length > 0 && (
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          hitSlop={10}
          style={{ paddingVertical: 12, alignSelf: 'flex-start' }}
        >
          <Text style={[font('sans', 600), { fontSize: 13, color: c.ink3 }]}>
            {expanded ? TODAY_COPY.showFewerLists : TODAY_COPY.showAllLists}
          </Text>
        </Pressable>
      )}
      <ListActionsSheet listId={menuId} open={menuId !== null} onClose={() => setMenuId(null)} />
    </View>
  );
}

/** The list icon square and the gap after it; at a large font size the pill is indented by both. */
const ICON = 36;
const ICON_GAP = 12;

/**
 * One list row: the row (icon, name, line), the pill and the "⋯" button are
 * separate touch targets, so a screen reader reaches each one.
 *
 *   normal font size:   [❤  Favorites      ] [Study 3]  ⋯
 *                            14 cards · 3 due
 *   large font size:    [❤  Favorites      ]            ⋯
 *                            14 cards · 3 due
 *                            [Study 3]
 *
 * Exported for its layout test (uiKit.test.ts): it reads no store, only its props.
 */
export function ListRowView({
  row,
  onOpen,
  onStudy,
  onMenu,
  last,
}: {
  row: ListRowModel;
  onOpen: () => void;
  onStudy: () => void;
  onMenu: () => void;
  last: boolean;
}) {
  const c = useColors();
  const large = useLargeText();
  const { list, stats } = row;
  const line = listRowLine(stats ?? { count: row.count, due: 0 });
  const ready = stats?.ready ?? 0;
  const dim = row.pref.hidden || !row.pref.pinned || row.count === 0;
  const pill =
    ready > 0 ? (
      <Btn
        size="sm"
        kind="secondary"
        onPress={onStudy}
        label={`${studyLabel(ready)} from ${list.name}`}
        // Large font size: under the name, in line with it (past the list icon).
        style={large ? { marginLeft: ICON + ICON_GAP, marginBottom: 13 } : undefined}
      >
        {studyLabel(ready)}
      </Btn>
    ) : null;
  return (
    <View style={{ borderBottomWidth: last ? 0 : 1, borderBottomColor: c.hairlineSoft }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable
          onPress={onOpen}
          onLongPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel={`${list.name}, ${line}`}
          accessibilityHint="Opens the list in the Library"
          accessibilityActions={[{ name: 'longpress', label: 'List actions' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'longpress') onMenu();
          }}
          style={({ pressed }) => ({
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: ICON_GAP,
            paddingVertical: 13,
            opacity: pressed ? 0.75 : dim ? 0.7 : 1,
          })}
        >
          <View
            {...A11Y_HIDDEN}
            style={{
              width: ICON,
              height: ICON,
              borderRadius: 10,
              backgroundColor: c.pineTint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 17 }}>{list.icon}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={todayNameLines(large)} style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>
              {list.name}
            </Text>
            <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>{line}</Text>
          </View>
        </Pressable>
        {large ? null : pill}
        <IconBtn icon="ellipsis-horizontal" size={32} iconSize={18} label={`Actions for ${list.name}`} onPress={onMenu} />
      </View>
      {large ? pill : null}
    </View>
  );
}
