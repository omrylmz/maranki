/**
 * Library — find, filter, choose and manage cards (spec §8.3, §4.2, §4.6,
 * §4.7, unit W4-2). It replaces the old Browse tab.
 *
 *   Library                                                   Select
 *   (🔍 Search cards…                                           ×)
 *   (Deck: German ×) (Level: B1, B2 ×) (Not started ×) (+ Filter)
 *   From list 'B1 verbs' · Update list
 *   1,585 cards · Deck order ▾                              Clear all
 *   [ Study 34 ]  [ Practice 30 ]  [ Choose (1,585) ]  [ Save as list ]
 *   die Reise                                   B1
 *   the trip
 *   ● Not started
 *   …                                                           (+)
 *
 * ONE filter language: the chips are a Query (§4.1). The search box uses the
 * search syntax (searchParse.ts): free words stay text, and a token
 * (`is:flagged`, `level:b1`, `tag:x`, `deck:german` …) becomes a chip on
 * Return or on a space after it. Every number on a button comes from the
 * same query as the list:
 *   - "Study {n}"     readyFor(chips).total (selectors.ts readyReader, the reader of
 *                     useReady) — the session opens exactly n cards;
 *   - "Practice {n}"  the practice session's length (sessionLengthReader, the reader
 *                     of useSessionLength);
 *   - "Choose ({n})"  the ITEMS the triage shows for the list: notes with a
 *                     Not started card ("Choose (6 items)" when they hold 12
 *                     cards, libraryState chooseButton; walkthrough M6);
 *   - "{n} cards"     the list itself.
 *
 * Route params `q` (a Query as JSON) and `nonce` are applied DURING RENDER
 * with React's "adjust state when a prop changes" pattern (libraryState
 * applyRouteParams): no effect, no frame with the old filters. A list opens
 * as its own chips with the line "From list '{name}'". "Clear all" clears
 * every chip and the route params. `newList=1` (the AddSheet's and Today's
 * "New list", spec §8.10, todayLogic NEW_LIST_PARAM — the one spelling of
 * that request) adds the line "Add filters, then tap Save as list."
 * (todayLogic NEW_LIST_BANNER) until the first "Save as list" or "Clear all".
 *
 * Moments where the 150 ms search debounce (or a busy phone) must not fool
 * the learner:
 *   - Return parses the text OF THE EVENT (`nativeEvent.text`), and every
 *     box update is made from the latest state (walkthrough H2: a fast
 *     `tag:algo` + Return made the chip "Tag: alg").
 *   - A half-typed last token (`level:b`) never reaches the list until it
 *     is complete, so no count is shown for it (libraryState listTextFor,
 *     walkthrough M9). A space does not finish it (wave 5c): `level:b` +
 *     space stays in the box as text, never the chip "Level: b" with 0
 *     cards (libraryState typeSearch); only Return makes it a chip. The list keeps its previous result meanwhile: while
 *     the learner edits a complete token (`level:b1` → `level:b` → `level:b2`)
 *     the list stays at `level:b1`; while a NEW token is typed (`haus
 *     level:b`) it shows the text before it ('haus').
 *   - "Select all" stores the query of the rows the learner SEES: the box as
 *     typed (shownQueryNow), and the list catches up at the same time. A
 *     row is drawn selected only when the selection is the list's own query
 *     (libraryState selectsAllShown).
 *   - The FacetSheet starts from the list's own query (libraryState
 *     facetStartQuery: the box as typed, without a half-typed token), so its
 *     "Show {n} cards" starts at the list's n. Its result is compared with
 *     the Library as it is NOW (libraryState facetsDone), so "Clear all" in
 *     the sheet and then the same filters again still applies what "Show {n}
 *     cards" promised; a half-typed token stays in the box.
 *
 * With free words in the box, the cards whose headline IS them come first,
 * then the ones that start with them, then the rest — each part in the
 * chosen sort (libraryState rankRows, walkthrough L12: "der Hund" before
 * "Achtung"). Select mode ends by itself when a bulk change took every
 * selected card out of the list; its Undo snackbar stays (walkthrough L16).
 *
 * Speed with 16,000 cards (device finding: the first open took 1–1.6 s):
 * the list is a FlatList with a FIXED row height (getItemLayout), 20 rows
 * first and a window of 7 screens; the library index and the card lookups
 * are cached in the store (a rating does not rebuild them); the search is
 * debounced (150 ms); the filter groups are counted only while the
 * FacetSheet is open. The list's reader gets the clock only when its query
 * reads it (libraryState listClock), so the clock tick right after the
 * first open, and the one every minute, do not filter and sort the list
 * again. The list is memoized per (query, sort, data) in the screen's rows
 * cache (libraryState rowsReader, walkthrough M9: "filter 1204 ms" in a
 * debug build), so typing back to an earlier text, a new sort of the same
 * filter, or a sheet opening does not filter 16,000 cards again. The counts
 * on the buttons all read this screen's ONE clock, so a tick recomputes them
 * in one render; the FacetSheet counts with it too (its `now` prop: its
 * content mounts fresh on every open, so a clock of its own would count
 * twice per open, the first time with the app's boot time). The sheet
 * keeps the time of its opening (or of its last tap): a tick while it is
 * open counts nothing again (unit P1 review, FacetSheet.tsx). The list's
 * filter + sort is timed as perfMarks 'filter' (the FacetSheet times
 * 'facets').
 *
 * Unit P1 (the release pass on 16,260 cards: filter 31–68 ms, the first A–Z
 * 685 ms, the first search 234 ms): the sort no longer sorts the filtered
 * cards each time — the library's order for each sort is made once and the
 * list is that order with the other cards left out (scope.ts sortScopeCards);
 * the A–Z key needs only the card's headline (face.ts faceHeadline); and a
 * warm-up fills the per-note caches (search text, headlines, facet data) and
 * the index's label lookups in small slices while the phone is idle
 * (scope.ts warmLibraryCaches, timed as perfMarks 'warm'), so the first
 * search, A–Z or FacetSheet waits for none of them. The results are exactly
 * the same as before. Unit P1 review 2: after a rating the kept order is
 * repaired (only the rated cards move), and a list without a usable order
 * is sorted on its own; the library's order for the list's sort is then
 * made in an idle step (scope.ts warmLibraryOrder, perfMarks 'order').
 *
 * Unit P2: that warm-up no longer lives in this screen. It started only
 * 400 ms after this lazy tab opened, and a fast learner typed before the
 * search text was ready (release: 234 ms for the first search). ONE shared
 * warm-up now runs from the tab layout, 1.5 s after the app is ready, the
 * search text of every note first (src/store/libraryWarmup.ts). This screen
 * only asks it whether its data is warmed (the idle order step below).
 *
 * Unit P3: the idle order step waits for the warm-up WITHOUT POLLING
 * (libraryWarmup runWhenWarmed: a listener that is called once when a run
 * completes; before, it looked again every 100 ms, also while this tab was
 * frozen in the background). And when the Library opens before the shared
 * warm-up began, it asks for it 400 ms later (useLibraryWarmupSoon), as
 * this screen's own warm-up of unit P1 did.
 *
 * Unit P4 (the release re-measure on 16,260 cards): "Deck order" with a
 * Level chip took 36–54 ms; the time was in the FILTER (the Level test
 * read each card's note), not in the sort — the other sorts only looked
 * faster because they re-sorted the pool Deck order had filtered. Level,
 * Section and Card type chips are now one Set lookup per card (scope.ts
 * note lookups, made by the shared warm-up). With no filter, the list's
 * pool is the store's own cards array and Deck order is that array itself
 * (scope.ts browsePool, sortScopeRows: no copy; the warm-up makes the Deck order
 * ahead of time). And when the search box gets the focus before the
 * warm-up made the search text, it is made at once (onSearchFocus), so
 * the first search right after start reads no note.
 *
 * Unit P4 review: the "no filter" opening took 4.2–6.2 ms in five release
 * runs and 32.1–33.9 ms (once 135.5 ms) in four others, for the SAME work —
 * node --jitless needs about 5 ms for it with the old code, early or after
 * the warm-up. So the slow ones were not this list's work: the JS thread
 * was paused (a GC) or not run (the busy emulator host; the warm-up needed
 * 5–8 times more time while Today was on screen). Now the opening makes no
 * big array at all (the list IS the store's cards array: scope.ts
 * sortScopeRows), and its 'filter' line names any GC inside it ("1 GC 28.0
 * ms", perfMarks.ts), so a slow line on the device shows its cause. A
 * first Level chip after a note edit makes only the Level lookup, and the
 * focus of the search box also brings the headlines soon (the first
 * search's rank).
 *
 * A solid strip under the status bar (StatusBarStrip, device pass
 * 2026-11-02 F1-6) keeps the list from scrolling under the clock.
 *
 * All the rules are in src/components/library/libraryState.ts (pure,
 * tested); this file holds React state, hooks and layout.
 */
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BulkBar } from '@/components/library/BulkBar';
import { BulkMoreSheet } from '@/components/library/BulkMoreSheet';
import { FacetSheet } from '@/components/library/FacetSheet';
import {
  applyRouteParams,
  bestChipToRemove,
  type BulkToggle,
  bulkToggles,
  chipScopeFor,
  chooseButton,
  chooseCount,
  clearAll,
  countLine,
  createRowsCache,
  defaultListName,
  directionLabeler,
  editSnack,
  effectiveQuery,
  fabDeckId,
  facetsDone,
  facetStartQuery,
  fieldsWithValues,
  initialLibraryState,
  LIBRARY_COPY,
  libraryChips,
  libraryDirectionNames,
  type LibraryParams,
  type LibraryState,
  listClock,
  listLine,
  listTextFor,
  newCardRoute,
  ordinalFields,
  parseForList,
  practiceQueryRoute,
  practiceSelectionRoute,
  removeBestChip,
  removeChipFrom,
  rowHeight,
  rowsReader,
  savedAsList,
  searchCtxFor,
  selectAll,
  selectAllText,
  selectedText,
  selectionGone,
  selectsAllShown,
  sessionLabel,
  showsNewListBanner,
  shownQueryNow,
  sortId,
  sortLabel,
  sortOptions,
  startSelecting,
  toggleSnack,
  stopSelecting,
  studyRoute,
  submitSearch,
  suggestionChips,
  summarizeRows,
  toggleSelected,
  triageHref,
  typeSearch,
  withChips,
  withSelectedIds,
  withSort,
  withText,
} from '@/components/library/libraryState';
import { EmptyLibrary, SmartEmpty } from '@/components/library/SmartEmpty';
import { CardSheet } from '@/components/sheets/CardSheet';
import { NEW_LIST_BANNER } from '@/components/today/todayLogic';
import { SaveListSheet } from '@/components/sheets/SaveListSheet';
import { undoManualEditAndReport } from '@/components/study/rescheduleLogic';
import { LibraryRow } from '@/components/library/LibraryRow';
import {
  A11Y_HIDDEN,
  Btn,
  Chip,
  FAB,
  FilterChipsRow,
  Ion,
  MIN_TOUCH,
  ResultActions,
  Row,
  ScreenHead,
  Sheet,
  squareSlop,
  type ResultAction,
} from '@/components/ui';
import { StatusBarStrip } from '@/components/ui/layout';
import type { FacetKey } from '@/domain/facets';
import { lastUsedDeckId } from '@/domain/fieldText';
import type { Card, DataStateV3, Id, Query } from '@/domain/model';
import { isEmptyQuery, sameQuery, serializeQuery } from '@/domain/query';
import { cardLookupOf, scopePool, type SessionParams, warmLibraryOrder } from '@/domain/scope';
import { mergeQueries } from '@/domain/searchParse';
import { plural } from '@/domain/text';
import { useData } from '@/store/DataContext';
import { useFaces } from '@/store/faces';
import { libraryWarmup, runWhenWarmed, useLibraryWarmupSoon, warmTargetOf } from '@/store/libraryWarmup';
import { perfMarks, timedSelector } from '@/store/perfMarks';
import { putSelection } from '@/store/selectionRegistry';
import {
  readyReader,
  sessionLengthReader,
  sessionParamsKey,
  useEngine,
  useMatchCtx,
  useStateV3,
} from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { useNow } from '@/store/useNow';
import { font, TABBAR_HEIGHT, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The search waits this long after the last key (spec §8.3). */
const SEARCH_DEBOUNCE_MS = 150;
/** The idle order step starts this long after the screen opened or the data changed (its first frames come first). */
const ORDER_DELAY_MS = 400;

/* Stable selectors (module level, so the store hook keeps them). */
const wholeState = (s: DataStateV3) => s;

export default function LibraryScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const engine = useEngine();
  const { actions } = useData();
  const { show } = useSnackbar();
  const now = useNow();
  const faceOf = useFaces();
  const ctx = useMatchCtx();
  const { index, decks: deckMap, lists } = ctx;
  const data = useStateV3(wholeState);
  const allCards = data.cards;
  // `q`, `nonce` and the "New list" request `newList=1` (todayLogic NEW_LIST_PARAM).
  const params: LibraryParams = useLocalSearchParams<{ q?: string; nonce?: string; newList?: string }>();

  /* --------------------------------------------------------------- screen state */

  // The per-note caches that the search, A–Z, the headline rank and the
  // FacetSheet read are warmed by the ONE shared warm-up of the tab layout
  // (src/store/libraryWarmup.ts, unit P2), not here: it starts 1.5 s after
  // the app is ready, so they are usually warm before this tab opens. The
  // idle order step below waits until this screen's data is warmed.
  // Opened before that warm-up began? It begins 400 ms from now (unit P3).
  useLibraryWarmupSoon();

  const [lib, setLib] = useState<LibraryState>(() => initialLibraryState(params, lists));
  // The search text the list uses: the box, 150 ms later (debounced), but
  // never a half-typed last token (libraryState listTextFor): while one is
  // typed, the list keeps the text it shows (editing a complete token) or
  // the text before the token (a new one).
  const [liveText, setLiveText] = useState(lib.text);
  // A new route request (a new nonce): adjust the state during render (spec §4.6).
  const routed = applyRouteParams(lib, params, lists);
  if (routed) {
    setLib(routed);
    setLiveText(routed.text);
  }
  const L = routed ?? lib;

  // What the list will show for the box as it is now (no half-typed token).
  const listTarget = listTextFor(L.text, liveText, () => searchCtxFor(allCards, ctx, L.chips), index);
  useEffect(() => {
    if (listTarget === liveText) return;
    const t = setTimeout(() => setLiveText(listTarget), listTarget === '' ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // L.text: every key starts the 150 ms again, also when the target stays the same.
  }, [L.text, listTarget, liveText]);

  const [peekId, setPeekId] = useState<Id | null>(null);
  const [facetOpen, setFacetOpen] = useState(false);
  const [facetFocus, setFacetFocus] = useState<FacetKey | null>(null);
  // The query the FacetSheet's draft starts from (set when it opens, libraryState
  // facetStartQuery). Only the sheet's start: its result is compared with the
  // Library as it is when the sheet closes (facetsDone), never with this.
  const [facetStart, setFacetStart] = useState<Query>({});
  const [sortOpen, setSortOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [moreIds, setMoreIds] = useState<Id[] | null>(null);
  const [headerH, setHeaderH] = useState(0);

  /* ------------------------------------------------------------- the query */

  // The search box through the search syntax (searchParse.ts). The parser's
  // view of the library is built only when the text holds a token. A
  // half-typed last token (`level:b`) never reaches the list text (see
  // listTarget above; parseForList leaves it out too): no count for a half token.
  const textParse = useMemo(
    () => parseForList(liveText, () => searchCtxFor(allCards, ctx, L.chips), index),
    [liveText, allCards, ctx, L.chips, index],
  );
  const query = useMemo(() => effectiveQuery(L.chips, textParse.query), [L.chips, textParse]);
  const queryKey = serializeQuery(query);

  // The list: every matching card in the sort order (scope.ts sortScopeCards,
  // the ONE sort — A–Z by the word, not its article); with free words, the
  // cards whose headline matches them come first (libraryState rankRows).
  // Timed: perfMarks 'filter'. `listNow` is 0 unless the query reads the
  // clock (listClock): then a clock tick keeps this reader, and the 16,000
  // cards are not filtered and sorted again for the same result. The
  // screen's rows cache (libraryState rowsReader) keeps the newest lists per
  // query and sort until the data changes: going back to a text or a sort
  // shown before does not filter again.
  const [rowsCache] = useState(createRowsCache);
  const sortKey = JSON.stringify({ by: L.sort.by, field: L.sort.field, dir: L.sort.dir });
  const listNow = listClock(query, lists, now);
  const listReader = useMemo(
    () => timedSelector('filter', rowsReader(rowsCache, queryKey, sortKey, listNow), (rows) => plural(rows.length, 'card')),
    [rowsCache, queryKey, sortKey, listNow],
  );
  const rows = useStateV3(listReader);

  // The library's order for the list's sort, made while the phone is idle
  // (scope.ts warmLibraryOrder, unit P1 review 2). A list that had to be
  // sorted on its own — the first list of a sort, or one after a big change
  // such as an import — leaves the work of the library's order to this step,
  // so the next filters of this sort only cut that order. It waits until
  // the shared cache warm-up is done for these cards (then the A–Z keys are
  // ready, no long block of cold note values) WITHOUT POLLING (unit P3,
  // runWhenWarmed: no timer while it waits, nothing left after it ran or
  // when the screen goes away), and it is one quick check when the order is
  // ready. Its work is one perfMarks line: "[perf] order 31.4 ms (16,260 cards)".
  const listSort = L.sort;
  useEffect(
    () =>
      runWhenWarmed(libraryWarmup, { cards: data.cards, index: ctx.index, decks: ctx.decks }, ORDER_DELAY_MS, () => {
        const start = perfMarks.clock();
        if (warmLibraryOrder(data, listSort, ctx)) {
          perfMarks.mark('order', perfMarks.clock() - start, plural(data.cards.length, 'card'));
        }
      }),
    [data, listSort, ctx],
  );

  // "Study {n}" and "Practice {n}": the store's readers (selectors.ts, the
  // same ones useReady and useSessionLength use) with this screen's ONE
  // clock, so a tick recomputes every count in the same render.
  const readyRead = useMemo(() => readyReader(queryKey, now), [queryKey, now]);
  const ready = useStateV3(readyRead);
  // The length of a practice session does not depend on its order: count it without sorting.
  const practiceKey = sessionParamsKey({ kind: 'practice', q: query, sort: null });
  const practiceRead = useMemo(() => sessionLengthReader(practiceKey, now), [practiceKey, now]);
  const practiceCount = useStateV3(practiceRead);

  const fields = useMemo(() => ordinalFields(index), [index]);
  // A row says its direction like the Direction filter group (libraryState
  // directionLabeler: its languages, else the group's role label, else its
  // template name). The group is read only for a card without languages.
  const dirLabel = useMemo(
    () => directionLabeler(index, deckMap, () => libraryDirectionNames(allCards, ctx)),
    [index, deckMap, allCards, ctx],
  );
  const summary = useMemo(() => summarizeRows(rows, now, dirLabel), [rows, now, dirLabel]);
  // "Choose ({n})" counts the ITEMS the triage will show for this list (one
  // word with two directions is one thing to choose), never the cards.
  const choose = useMemo(() => chooseCount(rows, allCards, ctx), [rows, allCards, ctx]);
  const chooseText = chooseButton(choose);
  // The chips, named like the FacetSheet groups (libraryChips: "Tags (German
  // Verbs)", "Direction: Back → Front"). The chip row, the "No cards match"
  // line and its "Remove …" button all take the scope from chipScopeFor.
  const chipModels = useMemo(
    () => libraryChips(L.chips, ctx, chipScopeFor(allCards, ctx, L.chips)),
    [L.chips, ctx, allCards],
  );
  const queryLabels = useMemo(
    () => libraryChips(query, ctx, chipScopeFor(allCards, ctx, query)).map((chip) => chip.label),
    [query, ctx, allCards],
  );
  const line = listLine(L.fromList, lists, query);
  const label = sessionLabel(queryLabels, line);
  const sorts = useMemo(() => sortOptions(fields), [fields]);
  const rowH = rowHeight(fontScale);

  const filtered = !isEmptyQuery(query);
  // Under an EMPTY search box (spec §8.3), also when chips are set: a scoped
  // Library (the chip "Deck: German") still gets the scope's real groups.
  // suggestionChips skips a group that already has a chip.
  const showSuggestions = !L.selecting && L.text === '' && rows.length > 0;
  const suggestions = useMemo(
    () => (showSuggestions ? suggestionChips(summary, L.chips, fieldsWithValues(rows, index, fields)) : []),
    [showSuggestions, summary, L.chips, rows, index, fields],
  );
  const noMatch = rows.length === 0 && allCards.length > 0;
  // "Remove {chip}": the chip's label as in the "No cards match" line (the same scope).
  const best = useMemo(
    () => (noMatch ? bestChipToRemove(allCards, query, ctx, chipScopeFor(allCards, ctx, query)) : null),
    [noMatch, allCards, query, ctx],
  );

  /* ------------------------------------------------------------- selection */

  const sel = L.selection;
  const selectedCards = useMemo((): readonly Card[] => {
    if (!L.selecting) return [];
    if (sel.kind === 'query') {
      return sameQuery(sel.query, query) ? rows : scopePool(data, sel.query, ctx, 'browse');
    }
    const { cardById } = cardLookupOf(allCards);
    const out: Card[] = [];
    for (const id of sel.ids) {
      const card = cardById.get(id);
      if (card) out.push(card);
    }
    return out;
  }, [L.selecting, sel, query, rows, data, ctx, allCards]);
  const selectedSet = useMemo(() => (sel.kind === 'ids' ? new Set(sel.ids) : null), [sel]);
  // Walkthrough L16: when a bulk change took EVERY selected card out of the
  // list ("Unsuspend" on the Suspended list), select mode ends by itself
  // (adjust state during render, no effect). The change's snackbar with Undo
  // stays on screen: it is the way back.
  const shownIds = useMemo(
    () => (L.selecting && sel.kind === 'ids' && sel.ids.length > 0 ? new Set(rows.map((card) => card.id)) : null),
    [L.selecting, sel, rows],
  );
  if (shownIds && selectionGone(L, (id) => shownIds.has(id))) setLib(stopSelecting(L));
  // "Select all" draws every row selected only when it IS the list's query.
  const allShownSelected = selectsAllShown(sel, query);
  const toggles = useMemo(() => bulkToggles(selectedCards), [selectedCards]);
  const selParams: SessionParams =
    sel.kind === 'query' ? { kind: 'practice', q: sel.query, sort: null } : { kind: 'practice', sel: sel.ids, sort: null };
  const selKey = sessionParamsKey(selParams);
  const selPracticeRead = useMemo(() => sessionLengthReader(selKey, now), [selKey, now]);
  const selPracticeCount = useStateV3(selPracticeRead);

  /* ------------------------------------------------------------- handlers */

  /** The ids of the selection NOW (event handlers only: "Select all" is resolved from its query here). */
  const selectedIdsNow = (): Id[] => {
    if (sel.kind === 'ids') return [...sel.ids];
    return scopePool(engine.store.getState(), sel.query, ctx, 'browse').map((card) => card.id);
  };

  /** A follow-up message after Undo waits one tick (the snackbar host clears the bar right after the Undo handler). */
  const later = (message: string) => setTimeout(() => show(message), 0);

  const onRowPress = (id: Id) => {
    if (!L.selecting) {
      setPeekId(id);
      return;
    }
    setLib(toggleSelected(L, id, sel.kind === 'query' ? rows.map((card) => card.id) : []));
  };

  const onToggle = (t: BulkToggle) => {
    const ids = selectedIdsNow();
    if (ids.length === 0) return;
    const editId = actions.setFlags(ids, t.patch);
    const snack = editSnack(engine.store.getState().manualLog, editId, toggleSnack(t, ids.length));
    if (snack.undoable) show(snack.text, { onAction: () => undoManualEditAndReport(actions.undoManualEdit, editId, later) });
    else show(snack.text);
    // The next toggle works on the same cards, even if they left the list.
    setLib(withSelectedIds(L, ids));
  };

  const practiceSelected = () => {
    if (sel.kind === 'query') {
      router.push(practiceQueryRoute(sel.query, L.sort, label));
    } else {
      // Card ids never go in a URL: the session reads them by this token.
      router.push(practiceSelectionRoute(putSelection(sel.ids), `${plural(sel.ids.length, 'selected card')}`));
    }
    setLib(stopSelecting(L));
  };

  const openMore = () => setMoreIds(selectedIdsNow());

  const doClearAll = () => {
    const cleared = clearAll(L);
    setLib(cleared.state);
    setLiveText('');
    router.setParams(cleared.params);
  };

  /** The parser's view of the library NOW, for these chips (event handlers only: it reads the store). */
  const ctxFor = (chips: Query) => () => searchCtxFor(engine.store.getState().cards, ctx, chips);
  /** The parser's view of the library NOW, for the screen's chips (event handlers only). */
  const boxCtx = ctxFor(L.chips);
  /**
   * The search box as typed, parsed NOW like the list shows it once it has
   * caught up (no half-typed token; a complete token being edited keeps the
   * list's result) — not the debounced text.
   */
  const parseShownNow = () => parseForList(L.text, boxCtx, index, liveText);
  /** The list text for the box text `text`, keeping nothing (listTextFor with no shown text). */
  const freshListText = (text: string, chips: Query) => listTextFor(text, null, ctxFor(chips), index);

  /**
   * Typing (walkthrough H2): the update is made from the LATEST state
   * (`setLib(prev => …)`). On a busy phone this render's `L` can be a key
   * behind the keyboard; built from it, a commit could drop the chips of a
   * token committed a moment ago.
   */
  const onChangeText = (text: string) => {
    setLib((prev) => typeSearch(prev, text, ctxFor(prev.chips), index));
    // A token became a chip: the list catches up with the box at once. A
    // half-typed token that stays in the box (`level:b `) is not part of the
    // list text (freshListText), so no count is shown for it.
    const committed = typeSearch(L, text, boxCtx, index);
    if (committed.text !== text) setLiveText(freshListText(committed.text, committed.chips));
  };

  /**
   * The search box got the focus (unit P4). If the shared warm-up has not
   * made the search text of every note yet (the app became ready a moment
   * ago), it makes the rest of it NOW, in one go (libraryWarmup
   * warmSearchText). The keyboard opens natively meanwhile, and a key typed
   * in that time only waits, so the first search's filter reads no note:
   * the release device needed 188.5 ms for a search typed 1.5 s after the
   * app was ready. Nothing to do (0 ms) when the warm-up is past that part.
   * Then the headlines (the first search ranks its rows by them) come next,
   * a frame later and in bigger slices (unit P4 review), so they are ready
   * when the first search runs, 150 ms after the last key. While a save is
   * being written, all this waits until the write is done (P4 review 2: the
   * save's timing line must not count it).
   */
  const onSearchFocus = () => {
    libraryWarmup.warmSearchText(warmTargetOf(engine.store.getState()));
  };

  /**
   * Return (walkthrough H2): parses `typed`, the text OF THE EVENT — never
   * `L.text` or the debounced list text, which can still miss the last keys
   * (`tag:algo` became "Tag: alg"). The list follows at once.
   */
  const onSubmit = (typed: string) => {
    setLib((prev) => submitSearch(prev, typed, ctxFor(prev.chips)));
    const next = submitSearch(L, typed, boxCtx);
    setLiveText(freshListText(next.text, next.chips));
  };

  const openFacets = (focus: FacetKey | null) => {
    // Words typed in the last 150 ms count too: the list catches up now, and
    // the sheet starts from the box as it is (not the debounced text), so
    // "Show" keeps them in the box. A half-typed last token (`level:b`) is
    // left out, as in the list (a complete token being edited keeps the
    // list's result): "Show {n} cards" starts at the list's n.
    setLiveText(listTextFor(L.text, liveText, boxCtx, index));
    setFacetStart(facetStartQuery(L, boxCtx, index, liveText));
    setFacetFocus(focus);
    setFacetOpen(true);
  };

  const onFacetsDone = (q: Query) => {
    setFacetOpen(false);
    // Compared with the Library NOW: the sheet's "Clear all" may have cleared it meanwhile.
    // A half-typed token stays in the box (libraryState facetsDone); the
    // list shows the text before it (the draft holds every other filter).
    const next = facetsDone(L, q, boxCtx, index, liveText);
    if (!next) return;
    setLib(next);
    setLiveText(freshListText(next.text, next.chips));
  };

  /**
   * "Select all {n}": the cards of the rows the learner SEES. Words typed in
   * the last 150 ms count too: the list catches up now (like openFacets), and
   * the selection is the box as typed — never the old, debounced list.
   */
  const onSelectAll = () => {
    setLiveText(listTextFor(L.text, liveText, boxCtx, index));
    setLib(selectAll(L, shownQueryNow(L, boxCtx, index, liveText)));
  };

  const updateList = () => {
    if (!line || !line.canUpdate) return;
    const saved = actions.saveList({ id: line.list.id, name: line.list.name, icon: line.list.icon, query, sort: L.sort });
    show(saved ? `List '${saved.name}' updated` : 'This list could not be saved.');
  };

  const addCard = () => {
    const deckId = fabDeckId(L.chips, deckMap, () => lastUsedDeckId(engine.store.getState()));
    router.push(newCardRoute(deckId));
  };

  /* ------------------------------------------------------------- layout */

  const resultActions: ResultAction[] = [
    {
      key: 'study',
      label: `Study ${ready.total.toLocaleString('en-US')}`,
      onPress: () => router.push(studyRoute(query, label)),
      hidden: ready.total === 0,
      a11yLabel: `Study ${plural(ready.total, 'card')}`,
    },
    {
      key: 'practice',
      label: `Practice ${practiceCount.toLocaleString('en-US')}`,
      onPress: () => router.push(practiceQueryRoute(query, L.sort, label)),
      hidden: practiceCount === 0,
      a11yLabel: `Practice ${plural(practiceCount, 'card')}`,
      hint: 'Doesn’t change your schedule.',
    },
    {
      key: 'choose',
      // Items, like the triage it opens (libraryState chooseButton, walkthrough M6).
      label: chooseText.label,
      // The triage route belongs to another unit of this wave: a plain string href.
      onPress: () => router.push(triageHref(query, L.sort) as Href),
      hidden: choose.items === 0,
      a11yLabel: chooseText.a11y,
    },
    {
      key: 'save',
      label: line?.changed ? LIBRARY_COPY.saveAsNewList : LIBRARY_COPY.saveAsList,
      onPress: () => setSaveOpen(true),
      // A list of "everything" is the Library itself; an unchanged list exists already.
      hidden: !filtered || (line !== null && !line.changed),
      icon: 'bookmark-outline',
    },
  ];

  const selectedCount = selectedCards.length;
  const header = (
    <View onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}>
      <ScreenHead
        title={LIBRARY_COPY.title}
        right={
          allCards.length > 0 ? (
            L.selecting ? (
              <Btn size="sm" kind="quiet" onPress={() => setLib(stopSelecting(L))}>
                {LIBRARY_COPY.cancel}
              </Btn>
            ) : (
              <Btn size="sm" kind="quiet" onPress={() => setLib(startSelecting(L))}>
                {LIBRARY_COPY.select}
              </Btn>
            )
          ) : null
        }
      />

      {L.selecting ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 8 }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={[font('sans', 700), tnum, { fontSize: 15, color: c.ink }]}
          >
            {selectedText(selectedCount)}
          </Text>
          {rows.length > 0 ? (
            <Btn size="sm" kind="ghost" onPress={onSelectAll}>
              {selectAllText(rows.length)}
            </Btn>
          ) : null}
        </View>
      ) : null}

      {allCards.length > 0 ? (
        <>
          {/* the AddSheet's "New list" (spec §8.10): what to do next, until Save as list or Clear all */}
          {showsNewListBanner(L) ? (
            <View
              accessibilityRole="text"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                backgroundColor: c.pineTint,
                borderRadius: 14,
                paddingVertical: 10,
                paddingHorizontal: 14,
                marginTop: 12,
              }}
            >
              <View {...A11Y_HIDDEN}>
                <Ion name="bookmark-outline" size={16} color={c.pine} />
              </View>
              <Text style={[font('sans', 600), { flex: 1, fontSize: 13.5, lineHeight: 19, color: c.ink }]}>
                {NEW_LIST_BANNER}
              </Text>
            </View>
          ) : null}

          {/* search */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.hairlineStrong,
              borderRadius: 999,
              paddingVertical: 11,
              paddingHorizontal: 16,
              marginTop: 12,
            }}
          >
            <View {...A11Y_HIDDEN}>
              <Ion name="search" size={17} color={c.ink3} />
            </View>
            <TextInput
              value={L.text}
              // Unit P4: the search text of every note, now — before the first key (see onSearchFocus).
              onFocus={onSearchFocus}
              onChangeText={onChangeText}
              onSubmitEditing={(e) => onSubmit(e.nativeEvent.text)}
              placeholder={LIBRARY_COPY.searchPlaceholder}
              placeholderTextColor={c.ink3}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              accessibilityLabel="Search cards"
              accessibilityHint="Words search every field. Filters like is:flagged or level:b1 become chips."
              style={[font('sans', 400), { flex: 1, fontSize: 14.5, color: c.ink, padding: 0 }]}
            />
            {L.text !== '' ? (
              <Pressable
                onPress={() => {
                  setLib(withText(L, ''));
                  setLiveText('');
                }}
                // 17 pt icon + 2 × 14 = 45 pt (spec §8.12: at least 44 pt).
                hitSlop={squareSlop(17)}
                accessibilityRole="button"
                accessibilityLabel={LIBRARY_COPY.clearSearch}
              >
                <Ion name="close-circle" size={17} color={c.ink3} />
              </Pressable>
            ) : null}
          </View>
          {textParse.hints.length > 0 ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[font('sans', 400), { fontSize: 12.5, color: c.warning, marginTop: 6, marginHorizontal: 4 }]}
            >
              {textParse.hints.join(' ')}
            </Text>
          ) : null}

          {/* chips: one row that scrolls sideways */}
          <FilterChipsRow
            style={{ marginTop: 8, marginHorizontal: -20 }}
            inset={20}
            chips={chipModels.map((chip) => ({
              key: chip.id,
              label: chip.label,
              onRemove: () => setLib(removeChipFrom(L, chip.id)),
              onPress: chip.facet ? () => openFacets(chip.facet) : undefined,
            }))}
            onAdd={() => openFacets(null)}
          />

          {suggestions.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, alignItems: 'center' }}>
              <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>Try:</Text>
              {suggestions.map((s) => (
                <Chip
                  key={s.id}
                  icon="add"
                  label={s.add ? `Add the filter ${s.label}` : `Filter by ${s.label}`}
                  onPress={() => (s.add ? setLib(withChips(L, mergeQueries(L.chips, s.add))) : openFacets(s.facet ?? null))}
                >
                  {s.label}
                </Chip>
              ))}
            </View>
          ) : null}

          {line ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
              <Text numberOfLines={1} style={[font('sans', 600), { flexShrink: 1, fontSize: 13, color: c.ink2 }]}>
                {line.text}
              </Text>
              {line.canUpdate ? (
                <>
                  <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>·</Text>
                  <Btn size="sm" kind="ghost" onPress={updateList}>
                    {LIBRARY_COPY.updateList}
                  </Btn>
                </>
              ) : null}
            </View>
          ) : null}

          {/* count · sort · clear all */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2 }}>
            <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>{countLine(rows.length)} ·</Text>
            {/* At least 44 pt high (spec §8.12): a 12.5 pt line with a slop of 10 was about 36 pt.
                The height is the button's own (not a slop), so no parent edge can cut it. */}
            <Pressable
              onPress={() => setSortOpen(true)}
              hitSlop={{ left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel={`Sort: ${sortLabel(L.sort, sorts)}. Change`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: MIN_TOUCH }}
            >
              <Text style={[font('sans', 700), { fontSize: 12.5, color: c.pine }]}>{sortLabel(L.sort, sorts)}</Text>
              <Ion name="chevron-down" size={13} color={c.pine} />
            </Pressable>
            <View style={{ flex: 1 }} />
            {filtered || L.fromList ? (
              <Btn size="sm" kind="ghost" onPress={doClearAll}>
                {LIBRARY_COPY.clearAll}
              </Btn>
            ) : null}
          </View>

          {!L.selecting ? <ResultActions actions={resultActions} style={{ marginTop: 10, marginBottom: 6 }} /> : null}
        </>
      ) : null}
    </View>
  );

  const empty =
    allCards.length === 0 ? (
      <EmptyLibrary onImport={() => router.push('/import')} onMakeDeck={() => router.push('/deck-editor')} />
    ) : (
      <SmartEmpty
        labels={queryLabels}
        best={best}
        onRemove={(chipId) => {
          // The chip may still be a token in the box (`is:suspended`, no space
          // yet): removeBestChip makes the tokens chips first, then removes it.
          // A kept token (being edited) becomes a chip as the list showed it.
          const next = removeBestChip(L, parseShownNow(), chipId);
          setLib(next);
          setLiveText(freshListText(next.text, next.chips));
        }}
        onClearAll={doClearAll}
      />
    );

  const listBottom = TABBAR_HEIGHT + insets.bottom + (L.selecting ? 96 : 84);

  return (
    <>
      <FlatList
        data={rows}
        keyExtractor={(card) => card.id}
        renderItem={({ item }) => (
          <LibraryRow
            card={item}
            faceOf={faceOf}
            index={index}
            decks={deckMap}
            fields={fields}
            dirLabel={summary.directions ? dirLabel : null}
            now={now}
            height={rowH}
            selecting={L.selecting}
            selected={L.selecting && (selectedSet ? selectedSet.has(item.id) : allShownSelected)}
            onPress={onRowPress}
          />
        )}
        getItemLayout={(_, i) => ({ length: rowH, offset: headerH + rowH * i, index: i })}
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={7}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        style={{ flex: 1, backgroundColor: c.paper }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: listBottom }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
      {/* After the list, so it is drawn on top: the list scrolls under it, not under the clock. */}
      <StatusBarStrip />

      {!L.selecting && deckMap.size > 0 ? (
        <FAB onPress={addCard} label={LIBRARY_COPY.addCard} bottom={TABBAR_HEIGHT + insets.bottom + 18} />
      ) : null}

      {L.selecting ? (
        <BulkBar
          toggles={toggles}
          onToggle={onToggle}
          practiceCount={selPracticeCount}
          onPractice={practiceSelected}
          onMore={openMore}
          disabled={selectedCount === 0}
          bottom={TABBAR_HEIGHT + insets.bottom + 12}
        />
      ) : null}

      <CardSheet cardId={peekId} open={peekId !== null} onClose={() => setPeekId(null)} />

      <FacetSheet
        open={facetOpen}
        query={facetStart}
        focus={facetFocus}
        now={now}
        onDone={onFacetsDone}
        onClearAll={doClearAll}
      />

      <BulkMoreSheet
        open={moreIds !== null}
        onClose={() => setMoreIds(null)}
        cardIds={moreIds ?? []}
        onDone={() => setLib(stopSelecting(L))}
      />

      <SaveListSheet
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        query={query}
        sort={L.sort}
        defaultName={defaultListName(queryLabels)}
        onSaved={(list) => setLib(savedAsList(L, list.id))}
      />

      <Sheet open={sortOpen} onClose={() => setSortOpen(false)} title={LIBRARY_COPY.sortTitle}>
        {sorts.map((option, i) => {
          const on = option.id === sortId(L.sort);
          return (
            <Row
              key={option.id}
              last={i === sorts.length - 1}
              padV={13}
              label={on ? `${option.label}, chosen` : option.label}
              onPress={() => {
                setLib(withSort(L, option.sort));
                setSortOpen(false);
              }}
            >
              <Text style={[font('sans', on ? 700 : 500), { flex: 1, fontSize: 15, color: on ? c.pine : c.ink }]}>
                {option.label}
              </Text>
              {on ? <Ion name="checkmark" size={19} color={c.pine} /> : null}
            </Row>
          );
        })}
      </Sheet>
    </>
  );
}
