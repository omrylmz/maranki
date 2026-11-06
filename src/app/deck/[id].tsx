/**
 * The deck page (`/deck/[id]`, spec §8.2, §9.3, unit W4-3) — the hub of one
 * deck. It replaces the old deck PeekSheet.
 *
 *   ‹                                                          ⋯   ← Rename and icon · Duplicate · Export as CSV · Delete
 *   🇩🇪  German  · 15,960 cards · 15 sections · Imported from …   (always the file's name, if known)
 *   [status bar] Mastered 312 · Review 900 · …
 *   [ ▶ Study 30 ]                                 [ Practice ]
 *   Today: 20 reviews + 10 new (limit 10 a day)    More ways to study ›   ← ModeSheet
 *   Next session: Quiz                             (only while a mode picked there waits)
 *   CHOOSE WHAT TO LEARN   17,940 cards (8,970 items) are not started yet.   (only cards of directions that are on)
 *   [ Choose what to learn ]   [ Add the next 50 items in order ]
 *   BY LEVEL / BY SECTION   (FacetBarsBlock; ⋯ = Study · Practice · Learn all · Mark all as known · Browse)
 *   CARDS   Browse all · Add card · Import more into this deck · Where do you start?
 *   DECK SETTINGS   (DeckSettings and its four sheets, Noun genders, Check known cards, Pause deck)
 *
 * "More ways to study": Study ahead, Practice all, Practice your hardest
 * (the deck's practice pool, hardest first — the same session as Complete's
 * row, so its count is the count of "Practice all"), Practice articles, and a
 * mode row. The mode picked there is for the
 * NEXT session started on this page only; then the default mode applies
 * again (walkthrough M4, deckPageLogic.ts `launchMode`).
 *
 * The "choose" flow counts ITEMS (notes): the line says "12 cards (6 items)"
 * when an item has two directions, and "Add the next 6 items in order" and
 * the triage's "0 / 6 items" count the same items (walkthrough M6). So do the
 * other choose actions of the page: a row menu's "Learn all 6 items" / "Mark
 * all 6 items as known", and every snackbar of the flow ("Where do you
 * start?" too) says "12 cards (6 items) …" in the triage's own words.
 *
 * "By section" is shown for every deck with 2 or more sections, after the
 * "By level" blocks (walkthrough M7, deckPageLogic.ts `barBlocks`).
 *
 * Every number on a button is the session it opens: "Study {n}" is
 * readyFor({ decks: [id] }).total and the session is built by
 * buildSessionQueue for the same scope (spec §4.6). "Study ahead · {n}",
 * "Practice · {n}" … are shown only when n > 0 (the old "Nothing due — study
 * ahead" opened an EMPTY session when only new cards were left and the
 * day's new-card limit was used up). The deck's own page names the deck, so
 * a PAUSED deck can still be studied here (spec §4.5).
 *
 * Performance: the page stays mounted under a session it opened. Its store
 * readers are frozen while the page is not focused (deckPageLogic.ts
 * `frozenUnless`), so a rating in that session does not count this page
 * again. The page's clock (`pageNow`) stands still while it is hidden too:
 * useNow() ticks once a minute, and a new time would build new readers that
 * count the whole deck again. A blur only wraps the same readers again.
 *
 * The Library and triage routes are built by plain-string helpers
 * (deckPageLogic libraryHref / triageHref), so they are cast to `Href`.
 *
 * Largest font size (device pass 2026-11-02, F1-5 / F1-6): no button label
 * and no line is cut. "Study {n}" and "Practice" sit side by side only while
 * both labels fit on one line (the kit's buttonPairLayout: a wrapping row);
 * otherwise, and always at a large font size (useLargeText), they are
 * stacked, each the full width ("Practi…" side by side at 2.0, "Practic / e"
 * at 1.15 on a 360 dp phone). At a large font size "Today: 50 new (limit 500
 * a day)" gets its own line above "More ways to study ›" (it was squeezed
 * into a 5-line column). Every full-width button may wrap onto 2 lines. The
 * "By section" lines wrap (the kit's FacetBars). A solid strip under the
 * status bar (StatusBarStrip) keeps the page from scrolling under the clock.
 */
import { type Href, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardTypeSheet } from '@/components/deck/CardTypeSheet';
import { DeckHeader } from '@/components/deck/DeckHeader';
import {
  articlePracticeCount,
  barBlocks,
  type BarBlock,
  type BarRow,
  cardTypesSummary,
  choosableCounts,
  chooseLine,
  chooseNamesItems,
  DECK_COPY,
  deckCsv,
  deckCsvFileName,
  deckFileName,
  deckPageMode,
  deckScope,
  deckTypes,
  deleteSnackText,
  directionSnack,
  directionsSummary,
  directionTypes,
  easierCardIds,
  effectiveNewLimit,
  fromLevelScope,
  frozenUnless,
  hardestSession,
  hasGermanTerms,
  itemCount,
  launchMode,
  libraryHref,
  lifeCounts,
  needsNoteSourceFile,
  newCardsLeftToday,
  newCardsScope,
  NEXT_IN_ORDER,
  nextInOrder,
  nextInOrderLabel,
  nextInOrderSnack,
  nextModeLine,
  noteSourceFile,
  notStartedScope,
  otherSourceFiles,
  pickNextMode,
  placementGroups,
  placementSnack,
  readAloudSummary,
  ROW_MENU,
  rowCardIds,
  rowMenuLabels,
  rowMenuSnack,
  sectionCount,
  sessionRoute,
  type SessionKindParam,
  studyBlock,
  todayLine,
  triageHref,
  triageLookupOf,
  typeDecks,
  typeSamples,
  valueScope,
} from '@/components/deck/deckPageLogic';
import { DeckSettings, type DeckSheet } from '@/components/deck/DeckSettings';
import { DeleteDeckSheet } from '@/components/deck/DeleteDeckSheet';
import { DirectionsSheet } from '@/components/deck/DirectionsSheet';
import { FacetBarsBlock } from '@/components/deck/FacetBarsBlock';
import { NewCardsSheet } from '@/components/deck/NewCardsSheet';
import { type PlacementChoice, PlacementSheet } from '@/components/deck/PlacementSheet';
import { ReadAloudSheet } from '@/components/deck/ReadAloudSheet';
import { triageItems } from '@/components/deck/triageLogic';
import { InfoButton } from '@/components/sheets/InfoButton';
import { ModeSheet } from '@/components/study/ModeSheet';
import { isUndoableEdit, undoManualEditAndReport } from '@/components/study/rescheduleLogic';
import { Btn, CardBox, Ion, ListRow, SectionHead, Sheet, SnackbarHost, StackBar } from '@/components/ui';
import { buttonPairLayout, StatusBarStrip, useLargeText } from '@/components/ui/layout';
import type { Facet } from '@/domain/facets';
import { sortDecks } from '@/domain/fieldText';
import { canOfferArticles } from '@/domain/modes';
import type { Card, DataStateV3, DeckOptions, FieldDef, Id, Query, SortSpec, StudyMode } from '@/domain/model';
import { serializeQuery } from '@/domain/query';
import { cardLookupOf, decksById, matchCtxOf, scopePool, sortScopeCards } from '@/domain/scope';
import { plural } from '@/domain/text';
import { writeCacheFile, writeDocumentFile } from '@/platform/files';
import { shareFile, type ShareKind } from '@/platform/share';
import type { DeleteStrategy } from '@/store/deckOps';
import { UNFILED_DECK_ID } from '@/store/deckOps';
import {
  facetsReader,
  memoOnInputs,
  readyReader,
  scopePoolReader,
  sessionLengthReader,
  sessionParamsKey,
  useEngine,
  useLibraryIndex,
  useReady,
  useSessionLength,
  useStateV3,
} from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { useNow } from '@/store/useNow';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/* ------------------------------------------------------------------ constants */

/** The share sheet of "Export as CSV". */
const SHARE_DECK_CSV: ShareKind = {
  mimeType: 'text/csv',
  UTI: 'public.comma-separated-values-text',
  dialogTitle: 'Export deck as CSV',
};

/** The folder in Paths.document an export is kept in when the phone cannot share. */
const EXPORTS_FOLDER = 'exports';

const decksOf = (s: DataStateV3) => s.decks;
const settingsOf = (s: DataStateV3) => s.settings;
const dayDoneOf = (s: DataStateV3) => s.person?.dayDone ?? null;
const NO_TYPE_DECKS: ReadonlyMap<Id, ReadonlySet<Id>> = new Map();
const noTypeDecks = () => NO_TYPE_DECKS;
const noArticles = () => 0;
const NO_CARDS: Card[] = [];
const noCards = () => NO_CARDS;
const ALL_KEY = serializeQuery({});

/** The sheets of the page. */
type PageSheet = DeckSheet | 'menu' | 'delete' | 'ways' | 'placement';

/** A short pause so a closing sheet (a native modal) is gone before the share sheet opens. */
function afterSheet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 350));
}

/* ------------------------------------------------------------------ screen */

export default function DeckPage() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const engine = useEngine();
  const actions = engine.actions;
  const { show } = useSnackbar();
  const params = useLocalSearchParams<{ id?: string }>();
  const deckId = typeof params.id === 'string' ? params.id : '';
  const now = useNow();
  const live = useIsFocused();
  // Large font size: side-by-side buttons and lines are stacked (see the top of the file).
  const large = useLargeText();
  // "Study {n}" and "Practice": side by side only while both labels fit (buttonPairLayout).
  const studyPair = buttonPairLayout(large);

  /* ---------------------------------------------------------- store */

  const deckOf = useMemo(() => (s: DataStateV3) => s.decks.find((d) => d.id === deckId) ?? null, [deckId]);
  const deck = useStateV3(deckOf);
  const decks = useStateV3(decksOf);
  const settings = useStateV3(settingsOf);
  const index = useLibraryIndex();

  const scope = useMemo(() => deckScope(deckId), [deckId]);
  const scopeKey = serializeQuery(scope);
  const aheadKey = sessionParamsKey({ kind: 'ahead', q: scope });
  const practiceKey = sessionParamsKey({ kind: 'practice', q: scope });
  const newKey = serializeQuery(newCardsScope(deckId));

  // The clock of the page's numbers. It stands still while the page is not
  // focused (a session on top): a new `now` builds new readers, and a new
  // reader counts the whole deck again. `pageNow` remembers the last time
  // the page was focused ("adjust state during render", no effect). While
  // focused, the readers use `now` itself, so the render that comes back to
  // the page already counts at the new time (and only once).
  const [pageNow, setPageNow] = useState(now);
  if (live && pageNow !== now) setPageNow(now);
  const readerNow = live ? now : pageNow;

  // Step 1: the readers, built again only for a new deck or a new page time.
  // Each one keeps its last result while the parts of the state it reads stay
  // the same (selectors.ts memoOnInputs).
  //
  // "Practice your hardest" has NO reader of its own: its session is the
  // practice pool of "Practice all" in another ORDER (hardest first,
  // deckPageLogic.ts hardestSession), and selectPractice cuts both at the same
  // session size. A sort never adds or removes a card, so its n is always
  // practiceCount. A second reader would build the pool again and sort up to
  // 16k cards after every change, only to get the same number.
  const readers = useMemo(
    () => ({
      pool: scopePoolReader(scopeKey, 'browse', readerNow),
      ready: readyReader(scopeKey, readerNow),
      ahead: sessionLengthReader(aheadKey, readerNow),
      practice: sessionLengthReader(practiceKey, readerNow),
      facets: facetsReader(ALL_KEY, scopeKey, readerNow),
      // The New cards Study may show (not suspended or buried, direction on).
      newPool: scopePoolReader(newKey, 'study', readerNow),
    }),
    [scopeKey, aheadKey, practiceKey, newKey, readerNow],
  );
  // Step 2: frozen while the page is hidden. A blur only wraps the SAME
  // readers again, so their first call returns the value they already have.
  const frozen = useMemo(
    () => ({
      pool: frozenUnless(readers.pool, live),
      ready: frozenUnless(readers.ready, live),
      ahead: frozenUnless(readers.ahead, live),
      practice: frozenUnless(readers.practice, live),
      facets: frozenUnless(readers.facets, live),
      newPool: frozenUnless(readers.newPool, live),
    }),
    [readers, live],
  );
  const pool = useStateV3(frozen.pool);
  const ready = useStateV3(frozen.ready);
  const aheadCount = useStateV3(frozen.ahead);
  const practiceCount = useStateV3(frozen.practice);
  const facets: Facet[] = useStateV3(frozen.facets);
  // Only asked when nothing can be studied now ("Today's new cards are done").
  const askNew = ready.total === 0 && aheadCount === 0;
  const eligibleNew = useStateV3(askNew ? frozen.newPool : noCards).length;
  const dayDone = useStateV3(dayDoneOf);

  const [sheet, setSheet] = useState<PageSheet | null>(null);
  const [rowMenu, setRowMenu] = useState<{ block: BarBlock; row: BarRow } | null>(null);
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  // The mode picked in "More ways to study": for the NEXT session started
  // here only (deckPageLogic.ts launchMode). null = Settings › Default mode.
  const [mode, setMode] = useState<StudyMode | null>(null);

  // Only while the CardTypeSheet is open: which decks use each card type.
  const typeDecksSel = useMemo(
    () => (sheet === 'cardTypes' ? memoOnInputs(({ cards, notes }: DataStateV3) => [cards, notes], typeDecks) : noTypeDecks),
    [sheet],
  );
  const decksByType = useStateV3(typeDecksSel);

  /* ---------------------------------------------------------- derived */

  const decksMap = useMemo(() => decksById(decks), [decks]);
  const counts = useMemo(() => lifeCounts(pool), [pool]);
  const total = pool.length;
  const sections = useMemo(() => sectionCount(pool, index), [pool, index]);
  const types = useMemo(() => deckTypes(pool, index), [pool, index]);
  const samples = useMemo(() => typeSamples(pool, index), [pool, index]);
  const blocks = useMemo(() => (deck ? barBlocks(pool, facets, index, deck) : []), [pool, facets, index, deck]);
  const placement = useMemo(() => placementGroups(pool, facets, index), [pool, facets, index]);
  const dirTypes = useMemo(
    () => (deck ? directionTypes(deck, types, pool, index, decksMap) : []),
    [deck, types, pool, index, decksMap],
  );
  // "Practice articles · {n}": only a deck with German terms can have any, so
  // other decks never draw a face per card for it.
  const german = deck ? hasGermanTerms(deck, types) : false;
  // The same two steps as the readers above: built for a page time, then frozen.
  const articlesReader = useMemo(
    () =>
      german
        ? memoOnInputs(
            ({ cards, notes, noteTypes, decks: all, lists, settings: prefs }: DataStateV3) => [cards, notes, noteTypes, all, lists, prefs],
            (s: DataStateV3) => articlePracticeCount(s, scope, readerNow),
          )
        : noArticles,
    [german, scope, readerNow],
  );
  const articlesSel = useMemo(() => frozenUnless(articlesReader, live), [articlesReader, live]);
  const articleCount = useStateV3(articlesSel);
  // What "Choose what to learn" and "Where do you start?" can change: only
  // cards of a direction that is on (triage skips the others, so counting
  // them would open an empty triage — a dead end).
  const choosable = useMemo(
    () => choosableCounts(pool, triageLookupOf({ cards: pool }, { decks: decksMap, index })),
    [pool, decksMap, index],
  );
  // The header names the file the deck came from. An old key ('file:msf:96')
  // or a nameless key (a made-up name) names no real file: then the file of
  // the deck's items (only for such a deck), else just "Imported".
  const noteFile = useMemo(
    () => (deck && needsNoteSourceFile(deck) ? noteSourceFile(pool, index, deck.sourceKey) : null),
    [deck, pool, index],
  );
  // Other files the deck's items came from (a newer version imported into
  // it): named after the deck's own file, "Imported from v1.apkg and
  // v4.apkg" (wave 5g). Only for a deck whose line names a file.
  const otherFiles = useMemo(() => {
    const main = deck ? deckFileName(deck, noteFile) : null;
    return deck && main ? otherSourceFiles(pool, index, main, deck.sourceKey) : null;
  }, [deck, noteFile, pool, index]);
  const otherDecks = useMemo(() => sortDecks(decks.filter((d) => d.id !== deckId)), [decks, deckId]);
  const otherDecksByType = useMemo(() => {
    const out = new Map<Id, number>();
    for (const [typeId, ids] of decksByType) out.set(typeId, ids.size - (ids.has(deckId) ? 1 : 0));
    return out;
  }, [decksByType, deckId]);

  /* ---------------------------------------------------------- handlers */

  /** A follow-up message after Undo waits one tick (the snackbar host clears the bar right after the Undo handler). */
  const later = (message: string) => setTimeout(() => show(message), 0);

  /** The snackbar of a manual edit, with Undo. Nothing changed → no Undo. */
  const offerUndo = (text: string, editId: string) => {
    if (!isUndoableEdit(engine.store.getState().manualLog, editId)) {
      show(text);
      return;
    }
    show(text, { onAction: () => undoManualEditAndReport(actions.undoManualEdit, editId, later) });
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  /**
   * Open a session over `q` (spec §2.2). The mode picked in "More ways to
   * study" goes along to THIS session only: the pick is used up, so the next
   * session uses the default mode again (walkthrough M4).
   */
  const go = (kind: SessionKindParam, q: Query, label: string, extra: { mode?: StudyMode; sort?: SortSpec } = {}) => {
    const launch = launchMode(mode, extra.mode);
    router.push(sessionRoute({ kind, q, label, mode: launch.mode, sort: extra.sort ?? null }));
    setMode(launch.next);
  };

  /**
   * The Library with these chips; a new nonce for every open (spec §4.6).
   *
   * `dismissTo`, never `push`: this page is a route of the ROOT stack, next to
   * the tabs. A push of '/(tabs)/library' put a whole second tab navigator on
   * top of this page (a second Library and tab bar, a stack that grew with
   * every "Browse", and the learner's own Library tab never got the filter).
   * dismissTo goes back to the tabs that are already there and opens THEIR
   * Library tab with the q + nonce (final review 2026-11).
   */
  const browse = (q: Query) => {
    // '/(tabs)/library?q=…' carries a query, so typed routes need the cast.
    router.dismissTo(libraryHref(q, String(Date.now())) as Href);
  };

  /**
   * "Choose what to learn" over the Not started cards of `q`. `placed`: the
   * learner just answered "Where do you start?" here, so triage does not ask again.
   */
  const choose = (q: Query, opts: { placed?: boolean } = {}) => {
    router.push(triageHref(q, { fromDeck: true, placed: opts.placed }) as Href);
  };

  /** "Add the next {n} in order": learn() on the first n Not started items by deck order. */
  const addNextInOrder = (max: number) => {
    const state = engine.store.getState();
    const ctx = matchCtxOf(state, Date.now());
    const ordered = sortScopeCards(scopePool(state, scope, ctx, 'browse'), { by: 'source' }, state, ctx);
    const { cardIds, items } = nextInOrder(ordered, triageLookupOf(state, ctx), max);
    if (cardIds.length === 0) return;
    // "12 cards (6 items) added to your queue": the 6 of the button is in it.
    offerUndo(nextInOrderSnack(cardIds.length, items), actions.learn(cardIds));
  };

  /**
   * "Learn all" or "Mark all as known" of one "By level" value: the cards it
   * changes, read now (event handlers only), then one edit with Undo. Only
   * directions that are on: a card of a turned-off direction stays as it is
   * (deckPageLogic.ts rowCardIds). The snackbar counts like the triage:
   * "580 cards (290 items) added to your queue" (walkthrough M6).
   */
  const changeValue = (q: Query, which: 'learnAll' | 'markKnown') => {
    const state = engine.store.getState();
    const ctx = matchCtxOf(state, Date.now());
    const lookup = triageLookupOf(state, ctx);
    const ids = rowCardIds(scopePool(state, q, ctx, 'browse'), which, lookup);
    if (ids.length === 0) return;
    const items = itemCount(ids, lookup.cardById);
    const editId = which === 'learnAll' ? actions.learn(ids) : actions.markKnown(ids);
    offerUndo(rowMenuSnack(which, ids.length, items), editId);
  };

  const exportCsv = async () => {
    if (!deck) return;
    setSheet(null);
    await afterSheet();
    try {
      const text = deckCsv(pool, index);
      const name = deckCsvFileName(deck.name, Date.now());
      const file = writeCacheFile(name, text);
      if (!(await shareFile(file.uri, SHARE_DECK_CSV))) {
        const saved = writeDocumentFile(name, text, EXPORTS_FOLDER);
        show(`Saved as ${saved.name}`);
      }
    } catch {
      show('Could not export this deck. Please try again.');
    }
  };

  const duplicate = () => {
    setSheet(null);
    const copy = actions.duplicateDeck(deckId);
    if (!copy) {
      show('Could not copy this deck.');
      return;
    }
    show(`Copied as “${copy.name}” — fresh cards, no progress`, {
      label: 'Open',
      onAction: () => router.push({ pathname: '/deck/[id]', params: { id: copy.id } }),
    });
  };

  const confirmDelete = (strategy: DeleteStrategy, how: 'move' | 'keep' | 'all', where: string) => {
    setSheet(null);
    actions.deleteDeck(deckId, strategy);
    show(deleteSnackText(how, total, where));
    leave();
  };

  /**
   * "Start at {level}" (PlacementSheet): first the easier levels ("I know
   * them" → Known, or "Leave them not started"), one edit with Undo; then
   * "Choose what to learn" opens from the chosen level up — when something
   * there is still Not started (else the snackbar says what happened).
   * "Start at {the first level}" opens it over the WHOLE deck, so items with
   * no level are in it too (deckPageLogic.ts fromLevelScope). The triage gets
   * `placed=1`: the question was answered, it is not asked there again.
   * The snackbar counts like the triage's own "Where do you start?": "580
   * cards (290 items) marked as known" (walkthrough M6, `placementSnack`).
   */
  const applyPlacement = (choice: PlacementChoice) => {
    setSheet(null);
    const level = choice.group.values[choice.fromRank]?.label ?? '';
    // Only directions that are on: a turned-off direction comes back as it was.
    const ids = choice.fromRank > 0 ? easierCardIds(pool, choice.group, choice.fromRank, index, decksMap, choice.below) : [];
    if (ids.length > 0) {
      const items = itemCount(ids, cardLookupOf(engine.store.getState().cards).cardById);
      const editId = choice.below === 'known' ? actions.markKnown(ids) : actions.setNotStarted(ids);
      offerUndo(placementSnack(choice.below, ids.length, items), editId);
    }
    // The levels from the chosen one up, read after the edit above.
    const state = engine.store.getState();
    const ctx = matchCtxOf(state, Date.now());
    const fromLevel = fromLevelScope(deckId, choice.group, choice.fromRank, scopePool(state, scope, ctx, 'browse'), ctx.index);
    const left = triageItems(scopePool(state, notStartedScope(fromLevel), ctx, 'browse'), triageLookupOf(state, ctx));
    if (left.length > 0) {
      choose(fromLevel, { placed: true });
      return;
    }
    if (ids.length === 0) {
      show(choice.fromRank > 0 ? `Nothing to change below ${level}` : `Nothing to choose from ${level} up`);
    }
  };

  const setOptions = (patch: Partial<DeckOptions>) => actions.setDeckOptions(deckId, patch);

  const setDirections = (typeId: Id, ords: number[], on: boolean) => {
    const { created } = actions.setDirections(deckId, typeId, ords);
    show(directionSnack(on, created));
  };

  const saveType = (typeId: Id, fields: FieldDef[]) => {
    actions.updateNoteType(typeId, { fields });
    show('Card type saved');
  };

  const setFieldLang = (typeId: Id, fieldIndex: number, lang: string | null) => {
    const type = index.typeById.get(typeId);
    if (!type) return;
    const fields = type.fields.map((f, i) => {
      if (i !== fieldIndex) return f;
      const next: FieldDef = { ...f };
      if (lang) next.lang = lang;
      else delete next.lang;
      return next;
    });
    actions.updateNoteType(typeId, { fields });
  };

  /* ---------------------------------------------------------- missing deck */

  if (!deck) {
    return (
      <View style={{ flex: 1, backgroundColor: c.paper }}>
        <StackBar title="Deck" onBack={leave} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Ion name="help-circle-outline" size={40} color={c.ink3} />
          <Text
            accessibilityRole="header"
            style={[font('serif', 600), { fontSize: 20, color: c.ink, marginTop: 14, textAlign: 'center' }]}
          >
            {DECK_COPY.missing}
          </Text>
          <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink3, marginTop: 6, marginBottom: 18, textAlign: 'center' }]}>
            {DECK_COPY.missingSub}
          </Text>
          <Btn onPress={leave} style={{ alignSelf: 'center' }}>
            Close
          </Btn>
        </View>
      </View>
    );
  }

  /* ---------------------------------------------------------- page */

  const pageMode = deckPageMode(total, counts, choosable.cards);
  const newLimit = effectiveNewLimit(deck.options, settings.srs.dailyNewLimit);
  const block = studyBlock({
    ready: ready.total,
    ahead: aheadCount,
    practice: practiceCount,
    choosable: choosable.cards,
    eligibleNew,
    newLimit,
    newLeft: newCardsLeftToday(deck, settings.srs.dailyNewLimit, dayDone, readerNow),
  });
  const today = todayLine(ready, newLimit);
  const label = deck.name;
  const nextMax = pageMode === 'nothingQueued' ? NEXT_IN_ORDER.nothingQueued : NEXT_IN_ORDER.normal;
  const nextItems = Math.min(nextMax, choosable.items);
  // Items with two directions: the choose block names its unit ("6 items").
  const namesItems = chooseNamesItems(choosable);
  const neverStudied = choosable.neverStudied;
  const showGenders = german;
  const articlesShown = canOfferArticles(articleCount) ? articleCount : 0;
  // "Next session: Quiz" while a pick waits (it is used up by the next session).
  const modeSub = nextModeLine(mode, settings.studyMode);
  const hardest = hardestSession(deckId);

  const ways = [
    {
      key: 'ahead',
      label: 'Study ahead',
      count: aheadCount,
      sub: 'Reviews that are not due yet. Changes your schedule.',
      onPress: () => go('ahead', scope, label),
    },
    {
      key: 'practice',
      label: 'Practice all',
      count: practiceCount,
      sub: 'Doesn’t change your schedule.',
      onPress: () => go('practice', scope, label),
    },
    {
      key: 'hardest',
      label: 'Practice your hardest',
      // The same cards as "Practice all", hardest first: the same count (see the readers above).
      count: practiceCount,
      sub: 'Doesn’t change your schedule.',
      onPress: () => go(hardest.kind, hardest.q, label, { sort: hardest.sort }),
    },
    {
      key: 'articles',
      label: 'Practice articles',
      count: articlesShown,
      sub: 'der, die or das? Doesn’t change your schedule.',
      onPress: () => go('practice', scope, label, { mode: 'article' }),
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 48 }}
        showsVerticalScrollIndicator={false}
      >
        <DeckHeader
          deck={deck}
          total={total}
          sections={sections}
          counts={counts}
          noteFile={noteFile}
          otherFiles={otherFiles}
          onBack={leave}
          onMenu={() => setSheet('menu')}
        />

        {/* ---------------- empty deck */}
        {pageMode === 'empty' ? (
          <CardBox style={{ marginTop: 20 }}>
            <Text accessibilityRole="header" style={[font('serif', 600), { fontSize: 20, color: c.ink, marginBottom: 14 }]}>
              {DECK_COPY.empty}
            </Text>
            <View style={{ gap: 10 }}>
              <Btn full lines={2} icon="add" onPress={() => router.push({ pathname: '/card-editor', params: { deckId } })}>
                {DECK_COPY.addFirst}
              </Btn>
              <Btn
                full
                lines={2}
                kind="secondary"
                icon="download-outline"
                onPress={() => router.push({ pathname: '/import', params: { source: 'file', deckId } })}
              >
                {DECK_COPY.importInto}
              </Btn>
            </View>
          </CardBox>
        ) : null}

        {/* ---------------- nothing in the queue yet */}
        {pageMode === 'nothingQueued' ? (
          <CardBox style={{ marginTop: 20 }}>
            <Text accessibilityRole="header" style={[font('serif', 600), { fontSize: 19, lineHeight: 24, color: c.ink, marginBottom: 6 }]}>
              {DECK_COPY.nothingQueued}
            </Text>
            <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2, marginBottom: 14 }]}>
              {chooseLine(choosable.cards, choosable.items)}
            </Text>
            <View style={{ gap: 10 }}>
              <Btn full lines={2} icon="albums-outline" onPress={() => choose(scope)}>
                {DECK_COPY.choose}
              </Btn>
              {nextItems > 0 ? (
                <Btn full lines={2} kind="secondary" onPress={() => addNextInOrder(NEXT_IN_ORDER.nothingQueued)}>
                  {nextInOrderLabel(nextItems, namesItems)}
                </Btn>
              ) : null}
            </View>
          </CardBox>
        ) : null}

        {/* ---------------- study */}
        {pageMode === 'normal' || (pageMode === 'nothingQueued' && block.study > 0) ? (
          <View style={{ marginTop: 20, gap: 10 }}>
            {block.study > 0 ? (
              // Side by side while both labels fit; else one under the other, each the full
              // width (always so at a large font size). The kit's buttonPairLayout.
              <View style={studyPair.row}>
                <Btn
                  full
                  lines={2}
                  size="lg"
                  icon="play"
                  style={studyPair.first}
                  onPress={() => go('scheduled', scope, label)}
                >
                  {`Study ${block.study.toLocaleString('en-US')}`}
                </Btn>
                {block.practice > 0 ? (
                  <Btn
                    full
                    lines={2}
                    size="lg"
                    kind="secondary"
                    style={studyPair.second}
                    onPress={() => go('practice', scope, label)}
                  >
                    {DECK_COPY.practice}
                  </Btn>
                ) : null}
              </View>
            ) : (
              <>
                <Btn full lines={2} size="lg" kind="secondary" disabled icon="checkmark-done">
                  {DECK_COPY.nothingDue}
                </Btn>
                {block.fallback === 'ahead' ? (
                  <Btn full lines={2} icon="play-forward" onPress={() => go('ahead', scope, label)}>
                    {`Study ahead · ${block.ahead.toLocaleString('en-US')}`}
                  </Btn>
                ) : null}
                {block.fallback === 'choose' ? (
                  <Btn full lines={2} icon="albums-outline" onPress={() => choose(scope)}>
                    {DECK_COPY.choose}
                  </Btn>
                ) : null}
                {block.newDone ? (
                  <Text style={[font('sans', 400), { fontSize: 13.5, lineHeight: 19, color: c.ink2 }]}>{DECK_COPY.newDone}</Text>
                ) : null}
                {block.practice > 0 && (block.fallback === 'practice' || block.newDone) ? (
                  <Btn
                    full
                    lines={2}
                    kind={block.fallback === 'practice' ? 'primary' : 'secondary'}
                    icon="repeat"
                    onPress={() => go('practice', scope, label)}
                  >
                    {`Practice · ${block.practice.toLocaleString('en-US')}`}
                  </Btn>
                ) : null}
              </>
            )}
            {/* Side by side; at a large font size the "Today: …" line gets the full width, the button goes under it.
                No "Today: …" line (nothing ready): NO Text at all. An empty Text is still one blank line
                on Android, so at a large font size it left a gap above "More ways to study" (release
                pass C1-3). In the row, `flex-end` keeps the button on the right without the line. */}
            <View
              style={
                large
                  ? { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }
                  : { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }
              }
            >
              {today ? (
                <Text
                  style={[
                    font('sans', 400),
                    { fontSize: 12.5, lineHeight: 17, color: c.ink3 },
                    large ? { alignSelf: 'stretch' } : { flex: 1 },
                  ]}
                >
                  {today}
                </Text>
              ) : null}
              <Btn kind="ghost" size="sm" lines={2} onPress={() => setSheet('ways')} label={DECK_COPY.moreWays}>
                {`${DECK_COPY.moreWays} ›`}
              </Btn>
            </View>
            {modeSub ? <Text style={[font('sans', 600), { fontSize: 12.5, color: c.pine }]}>{modeSub}</Text> : null}
          </View>
        ) : null}

        {/* ---------------- choose what to learn */}
        {pageMode === 'normal' && choosable.cards > 0 ? (
          <View>
            <SectionHead>{DECK_COPY.chooseHead}</SectionHead>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 10 }}>
              <Text style={[font('sans', 400), { flexShrink: 1, fontSize: 13.5, color: c.ink2 }]}>
                {chooseLine(choosable.cards, choosable.items)}
              </Text>
              <InfoButton term="Not started" />
            </View>
            {/* A wrapping row; at a large font size a column, each button the full width. A label may wrap, never "…". */}
            <View style={large ? { gap: 10 } : { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <Btn icon="albums-outline" full={large} lines={2} onPress={() => choose(scope)}>
                {DECK_COPY.choose}
              </Btn>
              {nextItems > 0 ? (
                <Btn kind="secondary" full={large} lines={2} onPress={() => addNextInOrder(NEXT_IN_ORDER.normal)}>
                  {nextInOrderLabel(nextItems, namesItems)}
                </Btn>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* ---------------- by level / by section */}
        {total > 0 ? (
          <FacetBarsBlock
            blocks={blocks}
            onBrowse={(b, row) => browse(valueScope(deckId, b.key, row.value))}
            onMore={(b, row) => {
              setRowMenu({ block: b, row });
              setRowMenuOpen(true);
            }}
          />
        ) : null}

        {/* ---------------- cards */}
        {total > 0 ? (
          <View>
            <SectionHead>{DECK_COPY.cardsHead}</SectionHead>
            <ListRow icon="search" title={`Browse all ${plural(total, 'card')}`} onPress={() => browse(scope)} />
            <ListRow
              icon="add"
              title={DECK_COPY.addCard}
              onPress={() => router.push({ pathname: '/card-editor', params: { deckId } })}
            />
            <ListRow
              icon="download-outline"
              title={DECK_COPY.importMore}
              onPress={() => router.push({ pathname: '/import', params: { source: 'file', deckId } })}
              last={!(placement.length > 0 && neverStudied > 0)}
            />
            {placement.length > 0 && neverStudied > 0 ? (
              <ListRow
                icon="flag-outline"
                title="Where do you start?"
                sub="Skip the levels you already know"
                onPress={() => setSheet('placement')}
                last
              />
            ) : null}
          </View>
        ) : null}

        {/* ---------------- deck settings */}
        <DeckSettings
          deck={deck}
          dailyNewLimit={settings.srs.dailyNewLimit}
          directionsSummary={directionsSummary(dirTypes)}
          cardTypesSummary={types.length > 0 ? cardTypesSummary(types) : ''}
          readAloudSummary={readAloudSummary(deck, types)}
          showGenders={showGenders}
          onOpen={(s) => setSheet(s)}
          onGenders={(on) => actions.updateDeck(deckId, { genderColors: on })}
          onKnownChecks={(on) => setOptions({ knownChecks: on })}
          onPause={(paused) => {
            actions.updateDeck(deckId, { active: !paused });
            show(paused ? "Deck paused — its cards don't show on Today" : 'Deck active again');
          }}
        />
      </ScrollView>
      {/* After the page, so it is drawn on top: the page scrolls under it, not under the clock. */}
      <StatusBarStrip />

      {/* ---------------- sheets */}
      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} title={deck.name}>
        <ListRow
          icon="create-outline"
          title={DECK_COPY.rename}
          onPress={() => {
            setSheet(null);
            router.push({ pathname: '/deck-editor', params: { deckId } });
          }}
        />
        <ListRow icon="copy-outline" title={DECK_COPY.duplicate} sub="Fresh cards, no progress" onPress={duplicate} />
        <ListRow
          icon="share-outline"
          title={DECK_COPY.exportCsv}
          sub="One row per item, with tags and section"
          onPress={() => void exportCsv()}
        />
        <ListRow icon="trash-outline" danger title={DECK_COPY.delete} onPress={() => setSheet('delete')} last />
      </Sheet>

      <DeleteDeckSheet
        open={sheet === 'delete'}
        onClose={() => setSheet(null)}
        deck={deck}
        cardCount={total}
        otherDecks={otherDecks}
        unfiled={decks.find((d) => d.id === UNFILED_DECK_ID) ?? null}
        onConfirm={confirmDelete}
      />

      <ModeSheet
        open={sheet === 'ways'}
        onClose={() => setSheet(null)}
        current={mode ?? settings.studyMode}
        onPickMode={(m) => setMode(pickNextMode(m, settings.studyMode))}
        ways={ways}
      />

      <NewCardsSheet
        open={sheet === 'newCards'}
        onClose={() => setSheet(null)}
        options={deck.options}
        dailyNewLimit={settings.srs.dailyNewLimit}
        onChange={setOptions}
      />
      <DirectionsSheet open={sheet === 'directions'} onClose={() => setSheet(null)} types={dirTypes} onSet={setDirections} />
      <CardTypeSheet
        open={sheet === 'cardTypes'}
        onClose={() => setSheet(null)}
        deck={deck}
        types={types}
        samples={samples}
        otherDecks={otherDecksByType}
        onSave={saveType}
      />
      <ReadAloudSheet
        open={sheet === 'readAloud'}
        onClose={() => setSheet(null)}
        deck={deck}
        types={types}
        onDeckLang={(side, lang) =>
          actions.updateDeck(deckId, side === 'front' ? { language: lang ?? undefined } : { meaningLanguage: lang ?? undefined })
        }
        onFieldLang={setFieldLang}
      />
      <PlacementSheet open={sheet === 'placement'} onClose={() => setSheet(null)} groups={placement} onApply={applyPlacement} />

      {rowMenu ? (
        <RowMenuSheet
          open={rowMenuOpen}
          onClose={() => setRowMenuOpen(false)}
          onClosed={() => setRowMenu(null)}
          deckId={deckId}
          deckName={deck.name}
          block={rowMenu.block}
          row={rowMenu.row}
          onStudy={(q, l) => go('scheduled', q, l)}
          onPractice={(q, l) => go('practice', q, l)}
          onBrowse={browse}
          onLearnAll={(q) => changeValue(q, 'learnAll')}
          onMarkKnown={(q) => changeValue(q, 'markKnown')}
        />
      ) : null}

      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}

/* ------------------------------------------------------------------ the row menu */

/**
 * The ⋯ menu of one "By level" value (spec §8.2): "Study {n}", "Practice
 * {n}", "Learn all {n}" (Not started → New), "Mark all {n} as known",
 * "Browse". A row with 0 is hidden. Mounted only while a value is chosen, so
 * its counts are computed only then.
 *
 * "Study" and "Practice" count cards (the session they open). "Learn all" and
 * "Mark all as known" belong to the choose flow, so they count ITEMS like the
 * triage, and say "items" when an item has two directions: "Learn all 290
 * items" here, "Learn all 290 items left" in the triage (walkthrough M6,
 * deckPageLogic.ts `rowMenuLabels`, triageLogic.ts `bulkLabels`).
 */
function RowMenuSheet({
  open,
  onClose,
  onClosed,
  deckId,
  deckName,
  block,
  row,
  onStudy,
  onPractice,
  onBrowse,
  onLearnAll,
  onMarkKnown,
}: {
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  deckId: Id;
  deckName: string;
  block: BarBlock;
  row: BarRow;
  onStudy: (q: Query, label: string) => void;
  onPractice: (q: Query, label: string) => void;
  onBrowse: (q: Query) => void;
  onLearnAll: (q: Query) => void;
  onMarkKnown: (q: Query) => void;
}) {
  const q = useMemo(() => valueScope(deckId, block.key, row.value), [deckId, block.key, row.value]);
  const ready = useReady(q);
  const practice = useSessionLength({ kind: 'practice', q });
  const { learnAll, markKnown } = rowMenuLabels(row);
  const title = block.key === 'section' ? row.label : `${block.group} ${row.label}`;
  const label = `${deckName} · ${title}`;
  const then = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} title={title}>
      {ready.total > 0 ? (
        <ListRow icon="play" title={ROW_MENU.study(ready.total)} onPress={then(() => onStudy(q, label))} />
      ) : null}
      {practice > 0 ? (
        <ListRow
          icon="repeat"
          title={ROW_MENU.practice(practice)}
          sub="Doesn’t change your schedule."
          onPress={then(() => onPractice(q, label))}
        />
      ) : null}
      {learnAll !== null ? (
        <ListRow icon="add-circle-outline" title={learnAll} sub="Not started → in your queue" onPress={then(() => onLearnAll(q))} />
      ) : null}
      {markKnown !== null ? (
        <ListRow icon="checkmark-done" title={markKnown} onPress={then(() => onMarkKnown(q))} />
      ) : null}
      <ListRow icon="search" title={ROW_MENU.browse} onPress={then(() => onBrowse(q))} last />
    </Sheet>
  );
}
