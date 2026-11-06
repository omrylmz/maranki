/**
 * FacetSheet ("Filters") — every filter group the data really has, with
 * live counts (spec §4.3, §8.3, unit W4-2). Opened from the Library's
 * "+ Filter" chip, or by tapping a chip (then it opens scrolled to that group).
 *
 *   Filters (?)                                         Clear all
 *   STATUS     (Not started (8,970)) (New (4,200)) (Learning (48)) …
 *   DUE        (Due now (12)) (Due today (30))
 *   MARKERS    (Favorite (14)) (Flagged (3)) … (Hard (31)) (Recent (12))
 *   DECK       …
 *   SECTION    › Vocabulary (13,690)   › Grammar (906)       ← a tree
 *   LEVEL      (A1 (1,530)) (A2 (1,624)) (B1 (1,585)) …     ← ordinal order
 *   TAGS       [Search tags]  › Algo (120) …            ← a tree, searchable
 *   CARD TYPE · DIRECTION
 *   [ Show 1,585 cards ]
 *
 * How it works:
 *   - The sheet edits a DRAFT copy of the Library's query. Every tap changes
 *     the draft (facets.ts toggleFacetValue) and the counts follow. Closing
 *     the sheet ("Show {n} cards", the scrim, Android back) hands the draft
 *     to the Library (`onDone`), so the list is sorted again only once.
 *   - The counts are DISJUNCTIVE (spec §4.3): after picking A1 the other
 *     levels keep their real counts, so A1 + A2 can be picked. They come from
 *     the store's facet selector (selectors.ts facetsReader), computed ONLY
 *     while the sheet is open. Each count pass is timed as perfMarks 'facets'.
 *   - Budget (spec §4.3, walkthrough M9: 878 ms for 16,260 cards in a debug
 *     build). A library above FACET_SYNC_MAX_CARDS counts one tick AFTER the
 *     sheet opens, and one tick after each tap, with "Counting…" meanwhile
 *     (the spec's designed fallback). So the sheet slides in at once, and a
 *     tapped chip turns on at once (libraryState withDraftSelection draws the
 *     older counts with the draft's selection); only the numbers follow. A
 *     smaller library counts at once.
 *   - ONE count per open: the clock is the Library's (`now` prop), never a
 *     useNow() of the sheet's body. The body mounts fresh on every open, so a
 *     clock of its own would start at the app's BOOT time (useNow's first
 *     value) and change to the real time one tick later: every open counted
 *     twice over all the cards, the first time with "Due now" / "Buried" as
 *     of the app's start (review round 2). The Library stays mounted, so its
 *     clock is already the real time when the sheet opens.
 *   - At most one count per (draft, time, data) — unit P1: the store's facet
 *     selector keeps its results (selectors.ts facetsReader), so a reader
 *     made again for the same draft (a new render, opening the sheet again
 *     on the same library, tapping a chip on and off) gets the kept counts
 *     at once and records no 'facets' line. The release pass had seen a full
 *     count on every opening; a count itself is also about 2.5 times faster
 *     now (facets.ts).
 *   - A clock tick alone never counts again (unit P1 review). The release
 *     pass saw two counts for ONE opening (161.7 + 68.2 ms): the Library's
 *     clock ticks on every full minute (useNow), and the open sheet counted
 *     all 16,000 cards again with the new time. Now the counts use the time
 *     of the OPENING, or of the last tap (a tap needs a new count anyway).
 *     So a time count like "Due now" can be behind by as long as the sheet
 *     stays open; the list itself always uses the real clock. Each opening
 *     starts with a fresh body (`key`), so it counts at the Library's time
 *     then.
 *   - "Show {n} cards" reads n from the Status counts (libraryState
 *     resultCountFromFacets): every card has exactly one status.
 *   - Long labels are cut at a word boundary with "…" (shortLabel); the full
 *     label is what a screen reader says.
 *   - "Clear all" empties the draft and tells the Library at once (it also
 *     clears its search text and route params); the sheet stays open. When
 *     the sheet closes, the Library compares the draft with ITSELF as it is
 *     then (libraryState facetsDone), not with the query the sheet opened
 *     with: so "Clear all", then the same filters again, then "Show 3 cards"
 *     really shows those 3 cards.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { InfoButton } from '@/components/sheets/InfoButton';
import { Btn, Chip, IconBtn, Overline, Sheet } from '@/components/ui';
import { type Facet, type FacetKey, type FacetValue, toggleFacetValue } from '@/domain/facets';
import type { DataStateV3, Query } from '@/domain/model';
import { serializeQuery } from '@/domain/query';
import { foldText, plural } from '@/domain/text';
import { timedSelector } from '@/store/perfMarks';
import { facetsReader, useStateV3 } from '@/store/selectors';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  facetCountsDeferred,
  LIBRARY_COPY,
  resultCountFromFacets,
  searchTree,
  sheetGroupKey,
  sheetGroups,
  shortLabel,
  valueText,
  withDraftSelection,
} from './libraryState';

interface FacetSheetProps {
  open: boolean;
  /**
   * The query the draft starts from when the sheet opens: the Library's chips
   * and its search box AS TYPED (libraryState facetStartQuery), not the list's
   * 150 ms debounced text — or "Show" would take fresh words out of the box.
   * A half-typed last token (`level:b`) is left out, exactly as the list
   * leaves it out, so "Show {n} cards" starts at the list's n.
   */
  query: Query;
  /** The group to scroll to (a tapped chip's facet), or null for the top. */
  focus: FacetKey | null;
  /**
   * The Library's clock (its useNow()): "Due now", "Due today" and "Buried"
   * are counted at this time. It comes from the screen because the screen
   * stays mounted (see the header: one count per open).
   */
  now: number;
  /** The sheet closes: the draft (the Library decides whether it changes anything). */
  onDone: (query: Query) => void;
  /** "Clear all" was tapped (the Library clears its text and route params too). */
  onClearAll: () => void;
}

/** The facets while the counts are not computed yet. */
const NO_FACETS: Facet[] = [];
const noFacets = (): Facet[] => NO_FACETS;
/** How many cards the library has (a big one counts after a tick). */
const cardCountOf = (s: DataStateV3): number => s.cards.length;
/** The scope of the Library's facets: everything (the scope is a chip, spec §8.3). */
const ALL_KEY = serializeQuery({});
/** At most this many tags are listed for a search (type more to narrow it). */
const MAX_HITS = 60;

export function FacetSheet({ open, query, focus, now, onDone, onClearAll }: FacetSheetProps) {
  // The draft starts from the Library's query each time the sheet opens
  // (adjust-state-during-render, no effect).
  const [draft, setDraft] = useState<Query>(query);
  const [wasOpen, setWasOpen] = useState(open);
  // Which opening this is: the body's key, so every opening mounts a fresh
  // body — also one that starts while the last one still slides out (its
  // count time, "counts ready" flag and scroll position start again).
  const [opening, setOpening] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(query);
      setOpening((n) => n + 1);
    }
  }

  const close = () => onDone(draft);
  const clear = () => {
    setDraft({});
    onClearAll();
  };

  return (
    <Sheet open={open} onClose={close} maxHFrac={0.86}>
      <FacetSheetBody key={opening} draft={draft} setDraft={setDraft} focus={focus} now={now} onShow={close} onClear={clear} />
    </Sheet>
  );
}

interface BodyProps {
  draft: Query;
  setDraft: (q: Query) => void;
  focus: FacetKey | null;
  /** The Library's clock (never a clock of this body: it mounts fresh on every open). */
  now: number;
  onShow: () => void;
  onClear: () => void;
}

/**
 * The sheet's content. It mounts when the sheet opens and unmounts after it
 * closed, so its "counts ready" flag and scroll position start fresh each time.
 */
function FacetSheetBody({ draft, setDraft, focus, now, onShow, onClear }: BodyProps) {
  const c = useColors();
  const { height: winH } = useWindowDimensions();
  const cardCount = useStateV3(cardCountOf);

  const selectionKey = serializeQuery(draft);
  // The time the counts are made at: the Library's clock when the sheet
  // opened, and again when the draft changes (a tap counts anyway). A clock
  // tick ALONE keeps it (see the header: no second count for one opening).
  // adjust-state-during-render: a new draft takes the time of this render.
  const [countTime, setCountTime] = useState({ key: selectionKey, now });
  if (countTime.key !== selectionKey) setCountTime({ key: selectionKey, now });
  const at = countTime.key === selectionKey ? countTime.now : now;

  // The draft whose counts are shown. A small library counts the draft at
  // once. A big one (facetCountsDeferred) counts one tick LATER — after the
  // sheet opened, and after each tap — so the sheet slides in and a tapped
  // chip turns on at once; "Counting…" shows meanwhile (see the header).
  const deferred = facetCountsDeferred(cardCount);
  const [counted, setCounted] = useState<{ key: string; now: number } | null>(null);
  useEffect(() => {
    if (!deferred || (counted !== null && counted.key === selectionKey && counted.now === at)) return;
    const t = setTimeout(() => setCounted({ key: selectionKey, now: at }), 0);
    return () => clearTimeout(t);
  }, [deferred, counted, selectionKey, at]);
  const shown = deferred ? counted : { key: selectionKey, now: at };

  const shownKey = shown?.key ?? null;
  const shownNow = shown?.now ?? 0;
  const reader = useMemo(
    () =>
      shownKey !== null
        ? timedSelector('facets', facetsReader(shownKey, ALL_KEY, shownNow), (f) => plural(f.length, 'group'))
        : noFacets,
    [shownKey, shownNow],
  );
  const counts = useStateV3(reader);
  // Counts of an older draft: drawn with the draft's selection NOW, and the footer waits.
  const stale = shownKey !== selectionKey;
  const facets = useMemo(() => (stale ? withDraftSelection(counts, draft) : counts), [stale, counts, draft]);
  const groups = useMemo(() => sheetGroups(facets), [facets]);
  const count = facets.length > 0 && !stale ? resultCountFromFacets(facets) : null;
  const empty = Object.keys(draft).length === 0;

  // Scroll to the tapped chip's group once, when it is laid out.
  const scrollRef = useRef<ScrollView>(null);
  const scrolled = useRef(false);
  const focusKey = sheetGroupKey(focus);
  const onGroupLayout = (key: FacetKey, y: number) => {
    if (scrolled.current || key !== focusKey) return;
    scrolled.current = true;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
  };

  const toggle = (key: FacetKey, value: string) => setDraft(toggleFacetValue(draft, key, value));

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Text accessibilityRole="header" style={[font('serif', 600), { fontSize: 22, color: c.ink }]}>
          Filters
        </Text>
        <InfoButton term="Filter group" />
        <View style={{ flex: 1 }} />
        <Btn kind="ghost" size="sm" onPress={onClear} disabled={empty}>
          {LIBRARY_COPY.clearAll}
        </Btn>
      </View>

      <ScrollView
        ref={scrollRef}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: winH * 0.55 }}
        contentContainerStyle={{ paddingBottom: 8 }}
      >
        {facets.length === 0 ? (
          <Text style={[font('sans', 400), { fontSize: 14, color: c.ink3, paddingVertical: 24 }]}>Counting…</Text>
        ) : (
          groups.map((group) => (
            <View
              key={group.key}
              onLayout={(e) => onGroupLayout(group.key, e.nativeEvent.layout.y)}
              style={{ marginBottom: 18 }}
            >
              <Overline style={{ marginBottom: 8 }}>{group.label}</Overline>
              {group.facets.map((facet) =>
                facet.info ? (
                  <Text key={facet.key} style={[font('sans', 400), { fontSize: 13.5, color: c.ink2 }]}>
                    {facet.info}
                  </Text>
                ) : facet.kind === 'tree' ? (
                  <TreeFacet key={facet.key} facet={facet} onPick={(v) => toggle(facet.key, v)} />
                ) : (
                  <View key={facet.key} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                    {facet.values.map((v) => (
                      <ValueChip key={v.value} value={v} onPress={() => toggle(facet.key, v.value)} />
                    ))}
                  </View>
                ),
              )}
            </View>
          ))
        )}
      </ScrollView>

      <Btn full onPress={onShow} disabled={count === null} style={{ marginTop: 10 }}>
        {count === null ? 'Counting…' : `Show ${plural(count, 'card')}`}
      </Btn>
    </View>
  );
}

/** One value as a chip: "B1 (1,585)"; selected = active. The full label is read aloud. */
function ValueChip({ value, onPress, max = 28 }: { value: FacetValue; onPress: () => void; max?: number }) {
  return (
    <Chip active={value.selected} onPress={onPress} label={`${value.label}, ${plural(value.count, 'card')}`}>
      {valueText(shortLabel(value.label, max), value.count)}
    </Chip>
  );
}

/** True when a node or one of its children (any depth) is selected. */
function selectedBelow(node: FacetValue): boolean {
  return (node.children ?? []).some((child) => child.selected || selectedBelow(child));
}

/**
 * A tree group (Section, Tags): the top level, each node can open to show
 * its parts. A node opens by itself when a part of it is selected. With
 * more than 30 tags a search box finds a node at any depth.
 */
function TreeFacet({ facet, onPick }: { facet: Facet; onPick: (value: string) => void }) {
  const c = useColors();
  const [search, setSearch] = useState('');
  // The user's own open / closed choice per node (default: open when a part is selected).
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const hits = facet.searchable && search.trim() !== '' ? searchTree(facet.values, search, foldText) : null;

  const renderNodes = (nodes: readonly FacetValue[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isOpen = openNodes[node.value] ?? selectedBelow(node);
      const hasChildren = (node.children?.length ?? 0) > 0;
      return (
        <View key={node.value}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: depth * 18, marginBottom: 8 }}>
            {hasChildren ? (
              <IconBtn
                icon={isOpen ? 'chevron-down' : 'chevron-forward'}
                size={28}
                label={isOpen ? `Hide the parts of ${node.label}` : `Show the parts of ${node.label}`}
                onPress={() => setOpenNodes({ ...openNodes, [node.value]: !isOpen })}
              />
            ) : (
              <View style={{ width: 28 }} />
            )}
            <ValueChip value={node} onPress={() => onPick(node.value)} max={Math.max(14, 28 - depth * 4)} />
          </View>
          {hasChildren && isOpen ? renderNodes(node.children ?? [], depth + 1) : null}
        </View>
      );
    });

  return (
    <View>
      {facet.searchable ? (
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search tags"
          placeholderTextColor={c.ink3}
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel="Search tags"
          style={[
            font('sans', 400),
            {
              fontSize: 14.5,
              color: c.ink,
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.hairlineStrong,
              borderRadius: 999,
              paddingVertical: 9,
              paddingHorizontal: 14,
              marginBottom: 10,
            },
          ]}
        />
      ) : null}
      {hits ? (
        hits.length === 0 ? (
          <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink3 }]}>No tag matches “{search.trim()}”.</Text>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {hits.slice(0, MAX_HITS).map((hit) => (
              <Chip
                key={hit.value}
                active={hit.selected}
                onPress={() => onPick(hit.value)}
                label={`${hit.path}, ${plural(hit.count, 'card')}`}
              >
                {valueText(shortLabel(hit.path, 30), hit.count)}
              </Chip>
            ))}
          </View>
        )
      ) : (
        renderNodes(facet.values, 0)
      )}
    </View>
  );
}
