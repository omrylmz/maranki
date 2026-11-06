/**
 * The deck page (`/deck/[id]`, spec §8.2, §9.3, unit W4-3) — its PURE parts:
 * every number, line and label the page shows, the scope queries and routes
 * its buttons open, the "By level" bars, "Where do you start?", the deck
 * settings summaries, the card type editor's choices and the CSV export.
 *
 * WHY a separate file: the page is a hub with many small rules ("Study ahead
 * only when there is something to study ahead", "Today's new cards are
 * done", "Add the next 50 in order" …). Pure functions can be unit-tested
 * (deckPageLogic.test.ts); the screen only draws what they return.
 *
 * Inputs are the store's own values: the deck's cards come from
 * `useScopePool({ decks: [id] })` (src/store/selectors.ts — the ONE scope
 * rule), the counts from `useDeckStatsMap()` / `useReady()` /
 * `useSessionLength()`, the filter groups from `useFacets()`. Nothing here
 * filters `state.cards` itself.
 */
import { langLabel, primary } from '../../domain/lang/bcp47';
import { directionLabel, type Facet, parseSectionValue, sectionValue } from '../../domain/facets';
import { life, LIFE_KEYS, LIFE_LABELS } from '../../domain/life';
import type { LibraryIndex } from '../../domain/libraryIndex';
import { pathPrefixes } from '../../domain/libraryIndex';
import type {
  Card,
  DayDone,
  Deck,
  DeckOptions,
  FieldDef,
  FieldRole,
  Id,
  ImportSummary,
  LifeKey,
  Note,
  NoteType,
  Query,
  ReadyCounts,
  SortSpec,
  StudyMode,
} from '../../domain/model';
import { articleCards, MODE_LABELS } from '../../domain/modes';
import { detectOrdinal, type OrdinalKind, sortByOrdinalOrCount } from '../../domain/ordinal';
import { fieldRecord, type MatchCtx, serializeQuery } from '../../domain/query';
import { resolveFieldLang } from '../../domain/render';
import {
  buildSessionQueue,
  cardLookupOf,
  decksById,
  libraryIndexOf,
  matchCtxOf,
  type ScopeState,
} from '../../domain/scope';
import { facesFor } from '../../domain/face';
import { firstPlanChanges, type ImportPrefs } from '../../domain/importFile';
import { plural } from '../../domain/text';
import { dayKeyOf } from '../../domain/types';
import { toCsv } from '../../platform/csv';
import {
  cardIdsOf,
  cardsAndItems,
  directionOn,
  safeDailyNewLimit,
  stepSnack,
  triageItems,
  type TriageLookup,
} from './triageLogic';

/* ================================================================ scopes and routes */

/** The scope of the whole deck: `{ decks: [id] }`. Every deck-wide number uses it. */
export function deckScope(deckId: Id): Query {
  return { decks: [deckId] };
}

/**
 * The scope of one value of a filter group inside the deck (the "By level"
 * row menu and its "Browse"):
 *   field group → { decks: [id], fields: { level: ['b1'] } }
 *   section     → { decks: [id], sections: [{ deckId, path: 'verbs' }] }
 */
export function valueScope(deckId: Id, facetKey: string, value: string): Query {
  if (facetKey === 'section') {
    const { path } = parseSectionValue(value);
    return { decks: [deckId], sections: [{ deckId, path }] };
  }
  const field = facetKey.startsWith('field:') ? facetKey.slice('field:'.length) : facetKey;
  return { decks: [deckId], fields: fieldRecord([[field, [value]]]) };
}

/** The Not started cards of a scope: what "Choose what to learn" sorts. */
export function notStartedScope(q: Query): Query {
  return { ...q, life: ['notStarted'] };
}

/** The kinds of session the deck page opens (spec §2.2 `/session?kind=`). */
export type SessionKindParam = 'scheduled' | 'ahead' | 'practice';

/**
 * The route of a session over a query (spec §2.2):
 * `/session?kind=&q=&label=&mode=&sort=`. `q` is the Query as JSON; `sort`
 * is the SortSpec as JSON; `mode` only when the learner picked one here.
 * Card ids are never put in a URL.
 *
 *   sessionRoute({ kind: 'scheduled', q: { decks: ['d1'] }, label: 'German' })
 *   → { pathname: '/session', params: { kind: 'scheduled', q: '{"decks":["d1"]}', label: 'German' } }
 */
export function sessionRoute(p: {
  kind: SessionKindParam;
  q: Query;
  label: string;
  mode?: StudyMode | null;
  sort?: SortSpec | null;
}) {
  const params: Record<string, string> = { kind: p.kind, q: serializeQuery(p.q), label: p.label };
  if (p.mode) params.mode = p.mode;
  if (p.sort) params.sort = JSON.stringify(p.sort);
  return { pathname: '/session' as const, params };
}

/**
 * The Library with these chips (spec §4.6): `/(tabs)/library?q=…&nonce=…`.
 * `nonce` comes from the press handler (a new one for every open, so the
 * Library knows a new request arrived). The Library route belongs to unit
 * W4-2, so this is a plain string; the caller casts it to `Href`.
 */
export function libraryHref(q: Query, nonce: string): string {
  return `/(tabs)/library?q=${encodeURIComponent(serializeQuery(q))}&nonce=${encodeURIComponent(nonce)}`;
}

/**
 * The triage screen over the Not started cards of `q` (spec §2.2 `/triage?q=`).
 * `fromDeck` adds `from=deck`, so "Back to deck" can simply go back.
 * `placed` adds `placed=1`: the learner just answered "Where do you start?"
 * on the deck page, so triage does not ask it again (spec §8.5: it is offered
 * once, only while nothing was chosen yet).
 *
 *   triageHref({ decks: ['d1'] }, { fromDeck: true, placed: true })
 *   → '/triage?q=…&from=deck&placed=1'
 */
export function triageHref(q: Query, opts: { fromDeck?: boolean; placed?: boolean } = {}): string {
  let href = `/triage?q=${encodeURIComponent(serializeQuery(notStartedScope(q)))}`;
  if (opts.fromDeck) href += '&from=deck';
  if (opts.placed) href += `&${PLACED_PARAM}=1`;
  return href;
}

/** The triage route param that says "Where do you start?" was answered already (`placed=1`). */
export const PLACED_PARAM = 'placed';

/** True when the triage route says placement was done already (`placed=1`; an array param: its first value). */
export function placementDone(param: unknown): boolean {
  const value: unknown = Array.isArray(param) ? param[0] : param;
  return value === '1';
}

/**
 * Did the import screen open from THIS deck's page? The deck page opens
 * `/import?source=file&deckId=<id>` ("Import more into this deck", "Import
 * cards into this deck") with `router.push`, so that page is right under the
 * import screen. When the cards went into the same deck, the Done buttons go
 * BACK to it: "Open deck" goes back, and "Choose what to learn" gets
 * `from=deck`, so its "Back to deck" goes back too. A NEW deck page on top
 * would put the same page on the stack twice (hardware back shows it again).
 *
 *   importFromDeckPage('d1', 'd1')      → true
 *   importFromDeckPage(undefined, 'd1') → false   (opened from Today or Settings)
 *   importFromDeckPage('d1', 'd2')      → false   (the cards went into another deck)
 */
export function importFromDeckPage(deckParam: unknown, doneDeckId: Id | null): boolean {
  const param: unknown = Array.isArray(deckParam) ? deckParam[0] : deckParam;
  return typeof param === 'string' && param !== '' && param === doneDeckId;
}

/**
 * A re-import starts on "Existing deck: <home>" only when the home deck
 * holds at least this share of the file's chosen items (by guid).
 */
export const REIMPORT_MIN_SHARE = 0.5;

/** The guids of the chosen notes of an import (plan.ts `chosenNotesByMid`), each once. */
export function chosenGuidsOf(notesByMid: ReadonlyMap<string, readonly { guid?: string | null }[]>): Set<string> {
  const out = new Set<string>();
  for (const notes of notesByMid.values()) for (const n of notes) if (n.guid) out.add(n.guid);
  return out;
}

/**
 * The deck an import starts on by default, from the guid home
 * (importApkg.ts `guidHomeDeck`: the deck with the most of the file's guids):
 * that deck only when it holds AT LEAST HALF of the file's chosen items, so
 * the import really is a RE-import. Else null (the usual "New deck" /
 * sourceKey default; spec §5.6 rule 3, "Update them where they are", still
 * updates the few shared items in their own deck).
 *
 * WHY: a different file that shares 5 of its 2,000 items with "Spanish A"
 * must not start on "Existing deck: Spanish A" — one tap on Import would put
 * 1,995 new items there.
 *
 *   reimportHomeDeck('d1', 300 guids, d1 holds 300) → 'd1'   (the same file again)
 *   reimportHomeDeck('d1', 2,000 guids, d1 holds 5) → null   (another file)
 */
export function reimportHomeDeck(
  home: Id | null,
  fileGuids: ReadonlySet<string>,
  library: Pick<ScopeState, 'notes' | 'cards'>,
): Id | null {
  if (home === null || fileGuids.size === 0) return null;
  const { cardById, cardIdsByNote } = cardLookupOf(library.cards);
  // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
  const { notes } = library;
  let inHome = 0;
  for (const note of notes) {
    if (!note.guid || !fileGuids.has(note.guid)) continue;
    const firstId = cardIdsByNote.get(note.id)?.[0];
    if (firstId && cardById.get(firstId)?.deckId === home) inHome += 1;
  }
  return inHome >= fileGuids.size * REIMPORT_MIN_SHARE ? home : null;
}

/** How many notes an import chose (plan.ts `chosenNotesByMid`): for a CSV, its rows. */
export function chosenCountOf(notesByMid: ReadonlyMap<string, readonly unknown[]>): number {
  let n = 0;
  for (const notes of notesByMid.values()) n += notes.length;
  return n;
}

/**
 * The deck a CSV import starts on when no deck was found by the file's name
 * (its sourceKey) or by Anki id: the deck where at least HALF of the file's
 * chosen rows are already here, or null. "Already here" is the planner's own
 * rule for rows without an id (spec §5.6 rule 4: a CSV card type with the
 * same Front, and the same folded Front text), so the Preview then says the
 * same number ("Already in this deck {n}").
 *
 * WHY (wave 5g, walkthrough E8): Android's picker gives the real file name
 * only sometimes. The first pick of three-words.csv had it (deck
 * "three-words", key 'file:three-words.csv'). The second pick came from the
 * picker's recent files as a document id ('msf:102'), so the name was
 * unknown: the key became 'file:Imported deck.csv#<hash>' and the suggested
 * name "Imported deck". No key matched, and the .apkg way out (the same Anki
 * guid, `guidHomeDeck` + `reimportHomeDeck`) does not exist for a CSV: its
 * rows have no guid. So the Preview offered "New deck: Imported deck" with
 * "Already in this deck 0", and one tap added the same rows again.
 *
 * How (pure; `importStartPlan` passes the planner in):
 *   - `overlap` is the first plan's headword list (`summary.overlap` of the
 *     plan into a NEW deck): every deck that holds items with the same text,
 *     largest first — only the decks that may hold the SAME file
 *     (`maybeSameFile`: two different real file names are two files). A row
 *     that is already in a deck has the same text there, so (with the same
 *     Front column) only those decks can hold the rows. A deck with fewer
 *     than half of the rows there is not asked (it cannot reach half), so a
 *     big library is not planned again for every deck;
 *   - `alreadyHereIn(deckId)` plans the import into that deck and returns its
 *     `summary.skipped.alreadyHere`;
 *   - the deck with the most rows already here wins (a tie: the first in
 *     `overlap`), when it holds at least half of the rows
 *     (REIMPORT_MIN_SHARE, the same rule as an .apkg re-import).
 * A deck whose items only share the text but are of another card type (an
 * Anki "German Vocabulary" deck) has 0 rows already here: it is never chosen.
 *
 *   csvHomeDeck([{ deckId: 'd1', notes: 3 }], 3, () => 3) → 'd1'   (the same CSV again)
 *   csvHomeDeck([{ deckId: 'd1', notes: 3 }], 3, () => 0) → null   (same words, another card type)
 *   csvHomeDeck([{ deckId: 'd1', notes: 1 }], 3, …)       → null   (not asked: 1 of 3 rows)
 */
export function csvHomeDeck(
  overlap: readonly { deckId: Id; notes: number }[],
  rows: number,
  alreadyHereIn: (deckId: Id) => number,
): Id | null {
  if (rows <= 0) return null;
  const need = rows * REIMPORT_MIN_SHARE;
  let best: Id | null = null;
  let most = 0;
  // Destructured: the face guard (face.test.ts) forbids a direct property read of `notes` here.
  for (const { deckId, notes: withText } of overlap) {
    if (withText < need) continue;
    const here = alreadyHereIn(deckId);
    // Only a LARGER count wins, so a tie keeps the deck listed first.
    if (here >= need && here > most) {
      best = deckId;
      most = here;
    }
  }
  return best;
}

/**
 * Can the picked file and the file of a deck be the SAME file? Only two
 * KNOWN real file names that differ say no: 'file:week2.csv' and a deck from
 * 'file:week1.csv' are two files. When one of the two names is unknown, the
 * rows decide (`csvHomeDeck`): a nameless pick ('file:Imported
 * deck.csv#<hash>', the picker gave no name), an old 'file:msf:96' key, a
 * deck with no key. The same name in two keys ('file:three-words.csv' and
 * 'file:primary:Download/three-words.csv') is the same file.
 * `importStartPlan` asks this only for decks that came from a file
 * (`isFileDeck`): a deck made in the app, a starter pack or an AnkiWeb
 * download is never asked.
 *
 * WHY (wave 5g, review of E8): the walkthrough lost the file's name on ONE
 * of two picks of the same three-words.csv. The rows may find the deck of
 * that file again — in both orders: first named, then nameless, or first
 * nameless, then named. But a different, correctly named file (week2.csv,
 * which repeats half of the words of week1.csv) still starts on "New deck:
 * week2", as before wave 5g; its shared words are "the same text" (§5.6
 * rule 5) and can be skipped there.
 *
 *   maybeSameFile('file:Imported deck.csv#1x2b', 'file:three-words.csv') → true
 *   maybeSameFile('file:three-words.csv', 'file:Imported deck.csv#1x2b') → true
 *   maybeSameFile('file:week2.csv', 'file:week1.csv')                    → false
 */
export function maybeSameFile(pickKey: string | undefined, deckKey: string | undefined): boolean {
  const pick = sourceKeyFileName(pickKey);
  const deck = sourceKeyFileName(deckKey);
  return pick === null || deck === null || pick === deck;
}

/** What `importStartPlan` reads of a plan: the numbers of its summary. */
export interface StartPlan {
  summary: Pick<ImportSummary, 'overlap' | 'skipped' | 'imagesAskFirst' | 'newCards'>;
}

/**
 * The Preview's first preferences and plan (import.tsx `startPlanning`), in
 * ONE pure step, so the screen and the tests run the same decision:
 *   1. `earlier` (the learner's own choices, back from Fields) wins and is
 *      never changed: it is planned once, nothing else;
 *   2. else `first` (importFile.ts `startingPrefs`). When it starts on "New
 *      deck" and a guid home exists, "Existing deck" points at that home;
 *   3. a CSV (`csv` is not null) that still starts on "New deck" starts on
 *      "Existing deck: {the deck where at least half of its rows are already
 *      here}" (`csvHomeDeck`, §5.6 rule 4), among the decks that came from a
 *      FILE (`isFileDeck`: an .apkg or a CSV) and may hold the same file
 *      (`maybeSameFile`). The plan is then the plan INTO that deck, so the
 *      Preview says "Already in this deck {n}" for it. A deck made in the app,
 *      a starter pack or an AnkiWeb download is never this home (wave 5h,
 *      I3): it came from no picked file, so it cannot hold "the same file" —
 *      its shared rows are the same-text note (§5.6 rule 5), with "Skip these
 *      {n}";
 *   4. `firstPlanChanges` (images ask first; many new cards start Not
 *      started) on the plan of the target that stays.
 * `planWith` is the planner (import.tsx `makePlan`); a deck that was tried
 * and chosen is not planned twice.
 *
 * WHY one helper (wave 5g, review of E8): the steps depend on each other (the
 * CSV step needs the first plan; firstPlanChanges needs the plan of the deck
 * that was chosen). A copy of them in a test could pass while the screen
 * planned every .apkg again, reset the learner's own target, or showed the
 * numbers of the "New deck" plan for the existing deck.
 */
export function importStartPlan<P extends StartPlan>(input: {
  earlier: ImportPrefs | null;
  first: ImportPrefs;
  /** The deck that holds most of the file's items by guid (`reimportHomeDeck`), or null. */
  home: Id | null;
  /** A CSV's chosen rows (`chosenCountOf`) and the pick's key; null for an .apkg or an AnkiWeb deck. */
  csv: { rows: number; sourceKey: string | undefined } | null;
  decks: readonly Pick<Deck, 'id' | 'source' | 'sourceKey'>[];
  triageReady: boolean;
  planWith: (prefs: ImportPrefs) => P;
}): { prefs: ImportPrefs; plan: P } {
  const { earlier, first, home, csv, decks, triageReady, planWith } = input;
  if (earlier) return { prefs: earlier, plan: planWith(earlier) };
  let prefs: ImportPrefs = first.targetKind === 'new' && home ? { ...first, existingDeckId: home } : first;
  let plan = planWith(prefs);
  if (csv && prefs.targetKind === 'new') {
    const base = prefs;
    const into = (deckId: Id): ImportPrefs => ({ ...base, targetKind: 'existing', existingDeckId: deckId });
    // Only the decks that came from a file; a hand-made or pack deck is not even planned again.
    const keyOf = new Map(decks.filter(isFileDeck).map((d) => [d.id, d.sourceKey] as const));
    const candidates = plan.summary.overlap.filter(
      ({ deckId }) => keyOf.has(deckId) && maybeSameFile(csv.sourceKey, keyOf.get(deckId)),
    );
    const tried = new Map<Id, P>();
    const rowsHome = csvHomeDeck(candidates, csv.rows, (deckId) => {
      const there = planWith(into(deckId));
      tried.set(deckId, there);
      return there.summary.skipped.alreadyHere;
    });
    if (rowsHome) {
      prefs = into(rowsHome);
      plan = tried.get(rowsHome) ?? planWith(prefs);
    }
  }
  const changes = firstPlanChanges(plan.summary, triageReady);
  if (Object.keys(changes).length > 0) {
    prefs = { ...prefs, ...changes };
    plan = planWith(prefs);
  }
  return { prefs, plan };
}

/** "Practice your hardest" (spec §6.6): ease ascending, then lapses descending. */
export const HARDEST_SORT: SortSpec = Object.freeze({ by: 'hardest' }) as SortSpec;

/**
 * The session of "Practice your hardest · {n}" in "More ways to study" (spec
 * §6.6, §8.2): the deck's PRACTICE pool, hardest first, capped by the session
 * size. The same session as the Complete screen's "Practice your hardest"
 * (sessionLogic.ts `hardestParams` over the deck), so the words mean one
 * thing everywhere (§1.2).
 *
 * WHY not only the "Hard" cards (`hard: true`, reps > 0 and ease ≤ 2.2): a
 * deck where no card has a low ease yet had NO row at all (walkthrough M7:
 * German with 2 Learning cards, Algo all New). "Hardest" is an ORDER
 * (spec §6.6), not a filter.
 *
 *   hardestSession('d1') → { kind: 'practice', q: { decks: ['d1'] }, sort: { by: 'hardest' } }
 */
export function hardestSession(deckId: Id): { kind: 'practice'; q: Query; sort: SortSpec } {
  return { kind: 'practice', q: deckScope(deckId), sort: HARDEST_SORT };
}

/* ================================================================ the study mode of the next session */

/**
 * The mode picked in "More ways to study" is for the NEXT session the
 * learner starts on this page, and only for that one (walkthrough M4: it
 * used to stay on, so every later session opened in Quiz while the sheet said
 * "Only for this session"). The page keeps the pick in its state (`null` = no
 * pick: the session uses Settings › Default mode):
 *
 *   pickNextMode('mc', 'flash')    → 'mc'    (Quiz for the next session)
 *   pickNextMode('flash', 'flash') → null    (the default again: no pick)
 *   launchMode('mc')               → { mode: 'mc', next: null }   (used up)
 *   launchMode(null)               → { mode: null, next: null }   (the default)
 *   launchMode('mc', 'article')    → { mode: 'article', next: null } (a way row with its own mode)
 */
export function pickNextMode(mode: StudyMode, defaultMode: StudyMode): StudyMode | null {
  return mode === defaultMode ? null : mode;
}

/**
 * The mode a session started here gets, and the pick after it: always
 * `null`. Every start uses the pick up — also a way row with its own mode
 * ("Practice articles"), so a pick never waits for a later session.
 */
export function launchMode(
  picked: StudyMode | null,
  own?: StudyMode | null,
): { mode: StudyMode | null; next: null } {
  return { mode: own ?? picked, next: null };
}

/**
 * The line under the study block while a pick waits: "Next session: Quiz".
 * null when nothing is picked (or the pick is the default mode).
 */
export function nextModeLine(picked: StudyMode | null, defaultMode: StudyMode): string | null {
  if (picked === null || picked === defaultMode) return null;
  return `Next session: ${MODE_LABELS[picked]}`;
}

/* ================================================================ header */

/**
 * The made-up name of a file the picker gave no name for AND whose deck had
 * no name either (importApkg.ts `fallbackFileName`: "Imported deck.csv",
 * "Imported deck.apkg"). It names no real file, so the header never shows it.
 */
const MADE_UP_FILE_NAME = /^imported deck\.[a-z0-9]{1,6}$/i;

/**
 * The file name in a text, or null when it is none: the last part after a
 * '/' (an Android path "primary:Download/German.apkg"), and only when it
 * looks like a real file name ("German.apkg") — not a document id ("msf:96"),
 * not the made-up "Imported deck.csv", and not the ref of an item from a
 * nameless pick ("German.apkg#1x2b9k", importFile.ts `importOrigin`): it
 * ends in a hash, not in a file extension.
 *
 *   realFileName('German.apkg')        → 'German.apkg'
 *   realFileName('msf:96')             → null
 *   realFileName('Imported deck.csv')  → null
 *   realFileName('German.apkg#1x2b9k') → null
 */
export function realFileName(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const name = text.slice(text.lastIndexOf('/') + 1).trim();
  if (name === '' || !/\.[a-z0-9]{1,6}$/i.test(name) || MADE_UP_FILE_NAME.test(name)) return null;
  return name;
}

/**
 * The key of a file the picker gave NO name for (importApkg.ts
 * `namelessSourceKey`): 'file:<made-up name>#<content hash>'. The import
 * screen makes the name up: from the file's root deck
 * ("Algo Deck.apkg", "Default.apkg") or "Imported deck.csv".
 * The real file has another name (for example "Algo_Patterns.apkg"), so a
 * name from such a key is never shown as the file's name.
 */
const NAMELESS_KEY = /^file:(.*)#[0-9a-z]+$/i;

/**
 * The made-up file name inside a nameless key (see NAMELESS_KEY), or null
 * for every other key. Before wave 5g the import gave the deck's items the
 * same made-up name as their `Note.source.ref`, so `noteSourceFile` and
 * `otherSourceFiles` use this to skip those refs too (`ownMadeUpRef`).
 *
 *   madeUpKeyName('file:Algo Deck.apkg#1x2b') → 'Algo Deck.apkg'
 *   madeUpKeyName('file:German_Complete.apkg')               → null
 */
export function madeUpKeyName(sourceKey: string | null | undefined): string | null {
  if (typeof sourceKey !== 'string') return null;
  const match = NAMELESS_KEY.exec(sourceKey);
  return match ? match[1] : null;
}

/**
 * The REAL file name inside a deck's 'file:' sourceKey, or null when the key
 * names no real file:
 *
 *   'file:German_Complete.apkg'               → 'German_Complete.apkg'
 *   'file:primary:Download/German.apkg'       → 'German.apkg'
 *   'file:Algo Deck.apkg#1x2b' → null   (a nameless key: the name is made up)
 *   'file:msf:96' (an import from before the fix) → null
 *
 * WHY a nameless key gives null: its name comes from the root deck, not from
 * the file. "Imported from Algo Deck.apkg" (or "Imported from
 * Default.apkg") would name a file that does not exist, and the learner
 * could not find it (review of walkthrough L15).
 */
export function sourceKeyFileName(sourceKey: string | undefined): string | null {
  if (!sourceKey || !sourceKey.startsWith('file:')) return null;
  if (madeUpKeyName(sourceKey) !== null) return null;
  return realFileName(sourceKey.slice('file:'.length));
}

/** True for a deck that came from a file (an .apkg or a CSV). */
function isFileDeck(deck: Pick<Deck, 'source' | 'sourceKey'>): boolean {
  const key = deck.sourceKey ?? '';
  if (deck.source === 'pack' || key.startsWith('pack:') || key.startsWith('ankiweb:') || deck.source === 'ankiweb') return false;
  return key.startsWith('file:') || deck.source === 'apkg' || deck.source === 'csv';
}

/**
 * True when the header needs `noteSourceFile`: the deck came from a file, but
 * its sourceKey says NOTHING about that file — an old 'file:msf:96' key (a
 * document id), or a file deck with no key at all. Only then the page looks
 * at the items, so other decks never pay for it.
 *
 * Never for a key that already names its file: a real name
 * ('file:German.apkg'), and also a nameless key ('file:German.apkg#h1',
 * `madeUpKeyName`). The import made that key for THIS deck, so it is the
 * deck's own origin; its header says "Imported" (the name is made up). WHY
 * (wave 5d, P3): the items of such a deck carry the made-up name (since wave
 * 5g: the key without 'file:', `ownMadeUpRef`), and items that "Import more
 * into this deck" added later carry their own file's name.
 * Counting the items then relabelled the deck: 10 items of the deck's own
 * file and 20 items of Spanish.apkg said "Imported from Spanish.apkg".
 *
 *   needsNoteSourceFile({ source: 'apkg', sourceKey: 'file:msf:96' })        → true
 *   needsNoteSourceFile({ source: 'apkg', sourceKey: 'file:German.apkg#h1' }) → false
 *   needsNoteSourceFile({ source: 'apkg', sourceKey: 'file:German.apkg' })    → false
 */
export function needsNoteSourceFile(deck: Pick<Deck, 'source' | 'sourceKey'>): boolean {
  return isFileDeck(deck) && sourceKeyFileName(deck.sourceKey) === null && madeUpKeyName(deck.sourceKey) === null;
}

/** The kinds of `Note.source` that came from a file (an .apkg or a CSV). */
function fromFile(kind: string | undefined): boolean {
  return kind === 'apkg' || kind === 'csv';
}

/**
 * True when an item's `source.ref` is the made-up name of the deck's OWN
 * nameless key (`madeUpKeyName`), in either form the import stored:
 *   - since wave 5g: the key without 'file:' ('German.apkg#h1',
 *     importFile.ts `importOrigin`; `realFileName` rejects it anyway);
 *   - before wave 5g: the made-up name alone ('German.apkg').
 * False for a key that is not nameless.
 *
 *   ownMadeUpRef('German.apkg#h1', 'file:German.apkg#h1') → true
 *   ownMadeUpRef('German.apkg', 'file:German.apkg#h1')    → true
 *   ownMadeUpRef('German.apkg', 'file:German.apkg')       → false   (a real name)
 */
function ownMadeUpRef(ref: string | undefined, sourceKey: string | undefined): boolean {
  const madeUp = madeUpKeyName(sourceKey);
  if (madeUp === null || typeof sourceKey !== 'string') return false;
  return ref === madeUp || ref === sourceKey.slice('file:'.length);
}

/**
 * The file MOST of the deck's file items came from, or null. An item's
 * `Note.source.ref` is the name of its file (importFile.ts `importOrigin`).
 * Each item counts once (two directions are one item).
 *
 * Two groups of items are counted:
 *   - items with a real file name ("German.apkg"): one counter per file;
 *   - items from a file with NO real name: a document id ("msf:96"), the
 *     made-up "Imported deck.csv", the ref of a nameless pick
 *     ("German.apkg#1x2b9k", since wave 5g), or the made-up name of the
 *     deck's own nameless key (`sourceKey`, see `ownMadeUpRef`). They share
 *     ONE "unnamed" counter.
 * Items that did not come from a file (typed in the app, from AnkiWeb or a
 * starter pack) are not counted: they say nothing about the deck's file.
 *
 * The file with the most items wins only when it has MORE items than the
 * unnamed group. WHY: an old deck of 6,000 "msf:96" items that later got 10
 * items from "Extra.csv" ("Import more into this deck") came from an unknown
 * file, not from Extra.csv. A tie with the unnamed group gives null too.
 *
 * A tie between two files keeps the file of the FIRST item (in the order of
 * `cards`). WHY two steps: every file is counted first, and only then the
 * largest count is picked. A Map keeps the order in which its keys were
 * first added, so the first file with the largest count is the first-seen
 * one. (Picking "the file that reaches the top count first" while counting
 * would choose 'B' for A, B, B, A — B reaches 2 first.)
 *
 *   refs A, B, B, A       → 'A'   (2 each: A came first)
 *   refs A, B, B          → 'B'   (B has more items)
 *   refs msf:96, A        → null  (1 unnamed, 1 A: a tie)
 *   refs msf:96 × 6,000, Extra.csv × 10 → null
 */
export function noteSourceFile(
  cards: readonly Card[],
  index: Pick<LibraryIndex, 'noteById'>,
  sourceKey?: string,
): string | null {
  const counts = new Map<string, number>(); // file name → items, in first-seen order
  let unnamed = 0; // items from a file with no real name
  const seen = new Set<Id>();
  for (const card of cards) {
    if (seen.has(card.noteId)) continue;
    seen.add(card.noteId);
    const source = index.noteById.get(card.noteId)?.source;
    if (!source || !fromFile(source.kind)) continue;
    const name = ownMadeUpRef(source.ref, sourceKey) ? null : realFileName(source.ref);
    if (name === null) unnamed += 1;
    else counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    // Only a LARGER count wins, so a tie keeps the file seen first.
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return bestCount > unnamed ? best : null;
}

/**
 * The real file name the header gives as the deck's origin, or null: from
 * the sourceKey, else (only for a key that names nothing, needsNoteSourceFile)
 * from the items (`noteFile` = `noteSourceFile`). Null for a deck that did
 * not come from a file, and for a nameless key (the name is made up).
 *
 *   deckFileName({ source: 'apkg', sourceKey: 'file:German.apkg' })            → 'German.apkg'
 *   deckFileName({ source: 'apkg', sourceKey: 'file:msf:96' }, 'German.apkg')  → 'German.apkg'
 *   deckFileName({ source: 'apkg', sourceKey: 'file:German.apkg#h1' }, 'X.apkg') → null
 */
export function deckFileName(deck: Pick<Deck, 'source' | 'sourceKey'>, noteFile: string | null = null): string | null {
  if (!isFileDeck(deck)) return null;
  const fromItems = needsNoteSourceFile(deck) ? realFileName(noteFile) : null;
  return sourceKeyFileName(deck.sourceKey) ?? fromItems;
}

/**
 * The OTHER real files the deck's items came from (not the deck's own file,
 * `deckFileName`): the newest of them, and how many more there are.
 */
export interface OtherSourceFiles {
  /** The file whose items came into the deck last (the newest `Note.createdAt`). */
  newest: string;
  /** How many other files there are besides `newest`. */
  more: number;
}

/**
 * The other real files the deck's items came from, or null when there are
 * none. `main` is the file the header names (`deckFileName`); null → null
 * (a deck that names no file is never given a file, wave 5d P3).
 *
 * WHY (wave 5g, walkthrough E8): after German_Vocabulary_v4.apkg updated the
 * deck from German_Vocabulary_v1.apkg (4,000 items updated, 500 added), the
 * header still said only "Imported from German_Vocabulary_v1.apkg". The
 * stored data cannot say which file UPDATED an item: an update keeps the
 * item's `source.ref` (the reducer changes only the fields, tags and
 * section). But each ADDED item names its file, so the 500 new items say
 * that v4 was imported into this deck too. The header then says "Imported
 * from German_Vocabulary_v1.apkg and German_Vocabulary_v4.apkg" — true, and
 * it never takes the deck's own file away (P3).
 *
 * Counted like `noteSourceFile`: each item once; only items from a file; a
 * document id, the made-up "Imported deck.csv", the made-up name of the
 * deck's own nameless key and the ref of a nameless pick are no file names.
 * The newest file is the one with the newest item (`createdAt`); a tie keeps
 * the file seen first.
 *
 * A nameless pick (the picker gave no name) INTO this deck: its items carry
 * 'German Vocabulary.apkg#1x2b9k' (importFile.ts `importOrigin`), which is no
 * file name, so it never adds "and German Vocabulary.apkg" — a name made up
 * from the root deck. Limit: items that a nameless pick stored BEFORE wave
 * 5g carry the made-up name alone ('German Vocabulary.apkg'); nothing stored
 * tells it from a real file name, so such items are still named.
 *
 *   items v1 × 4,000 (createdAt 1), v4 × 500 (createdAt 2), main 'v1' → { newest: 'v4', more: 0 }
 *   items A (1), B (3), C (2), main 'A'                               → { newest: 'B', more: 1 }
 *   items only from main, or from 'msf:96'                            → null
 */
export function otherSourceFiles(
  cards: readonly Card[],
  index: Pick<LibraryIndex, 'noteById'>,
  main: string | null,
  sourceKey?: string,
): OtherSourceFiles | null {
  if (main === null) return null;
  const newestAt = new Map<string, number>(); // file name → its newest item, in first-seen order
  const seen = new Set<Id>();
  for (const card of cards) {
    if (seen.has(card.noteId)) continue;
    seen.add(card.noteId);
    const note = index.noteById.get(card.noteId);
    const source = note?.source;
    if (!note || !source || !fromFile(source.kind)) continue;
    if (ownMadeUpRef(source.ref, sourceKey)) continue;
    const name = realFileName(source.ref);
    if (name === null || name === main) continue;
    const at = Number.isFinite(note.createdAt) ? note.createdAt : 0;
    const before = newestAt.get(name);
    if (before === undefined || at > before) newestAt.set(name, at);
  }
  let newest: string | null = null;
  let newestTime = 0;
  for (const [name, at] of newestAt) {
    // Only a LATER item wins, so a tie keeps the file seen first.
    if (newest === null || at > newestTime) {
      newest = name;
      newestTime = at;
    }
  }
  return newest === null ? null : { newest, more: newestAt.size - 1 };
}

/**
 * Where the deck came from, for the header line (spec §8.2). A deck from a
 * file names the file when its real name is known (walkthrough L15): from its
 * sourceKey, else from its items (`noteFile` = `noteSourceFile`), else just
 * "Imported". A made-up name is never shown as a file name. A nameless key
 * (`madeUpKeyName`) is the deck's own origin: its items never relabel it, so
 * `noteFile` is not read for it (wave 5d, P3; see needsNoteSourceFile).
 *
 * `others` (`otherSourceFiles`) adds the other files the deck's items came
 * from, AFTER the deck's own file, which always stays first (wave 5g, E8).
 * Only a line that names a file gets them: "Imported" stays "Imported".
 *
 *   sourceKey 'file:German_Complete.apkg'         → 'Imported from German_Complete.apkg'
 *   sourceKey 'file:Algo Deck.apkg#1x2b' → 'Imported'   (the name is made up)
 *   sourceKey 'file:German.apkg#h1', noteFile 'Spanish.apkg' → 'Imported'   (never the items' file)
 *   sourceKey 'file:msf:96', noteFile 'German.apkg' → 'Imported from German.apkg'
 *   sourceKey 'file:msf:96', no noteFile          → 'Imported'
 *   sourceKey 'file:v1.apkg', others { newest: 'v4.apkg', more: 0 } → 'Imported from v1.apkg and v4.apkg'
 *   sourceKey 'file:v1.apkg', others { newest: 'v4.apkg', more: 2 } → 'Imported from v1.apkg, v4.apkg and 2 other files'
 *   sourceKey 'ankiweb:…'                         → 'Imported from AnkiWeb'
 *   source 'pack'                                 → 'Starter deck'
 *   made in the app                               → null (nothing to say)
 */
export function deckSourceLine(
  deck: Pick<Deck, 'source' | 'sourceKey'>,
  noteFile: string | null = null,
  others: OtherSourceFiles | null = null,
): string | null {
  const key = deck.sourceKey ?? '';
  if (deck.source === 'pack' || key.startsWith('pack:')) return 'Starter deck';
  if (key.startsWith('ankiweb:') || deck.source === 'ankiweb') return 'Imported from AnkiWeb';
  if (!isFileDeck(deck)) return null;
  const name = deckFileName(deck, noteFile);
  if (!name) return 'Imported';
  if (!others || others.newest === name) return `Imported from ${name}`;
  if (others.more <= 0) return `Imported from ${name} and ${others.newest}`;
  return `Imported from ${name}, ${others.newest} and ${plural(others.more, 'other file')}`;
}

/** The number of sections (subdecks) the deck's cards are in. The deck root is not a section. */
export function sectionCount(cards: readonly Card[], index: Pick<LibraryIndex, 'noteById' | 'sectionPath'>): number {
  const paths = new Set<string>();
  const seenNotes = new Set<Id>();
  for (const card of cards) {
    if (seenNotes.has(card.noteId)) continue;
    seenNotes.add(card.noteId);
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    const path = index.sectionPath(note);
    if (path !== '') paths.add(path);
  }
  return paths.size;
}

/** "15,960 cards · 15 sections · Imported from German_Complete.apkg" (empty parts left out). */
export function deckSubLine(total: number, sections: number, source: string | null): string {
  const parts = [plural(total, 'card')];
  if (sections > 0) parts.push(plural(sections, 'section'));
  if (source) parts.push(source);
  return parts.join(' · ');
}

/** The statuses in the header legend, in the order of the bar (mastered first). */
const LEGEND_ORDER: readonly LifeKey[] = ['mastered', 'review', 'learning', 'new', 'notStarted', 'known'];

/**
 * The legend under the bar: "Mastered 312 · Review 900 · Learning 48 · New
 * 4,200 · Not started 8,970 · Known 1,530". Statuses with 0 cards are left out.
 */
export function lifeLegend(counts: Readonly<Record<LifeKey, number>>): string {
  return LEGEND_ORDER.filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${LIFE_LABELS[k]} ${(counts[k] ?? 0).toLocaleString('en-US')}`)
    .join(' · ');
}

/** The SegBar counts of a status tally (the bar's `neww` is the status 'new'). */
export function segCountsOf(counts: Readonly<Record<LifeKey, number>>) {
  return {
    mastered: counts.mastered ?? 0,
    review: counts.review ?? 0,
    learning: counts.learning ?? 0,
    neww: counts.new ?? 0,
    notStarted: counts.notStarted ?? 0,
    known: counts.known ?? 0,
  };
}

/* ================================================================ what the page shows */

/**
 * What "Choose what to learn" and "Where do you start?" can really change in
 * the deck: only cards of a direction that is ON. The triage screen skips a
 * Not started card of a turned-off direction (triageLogic.ts `triageItems`),
 * so a button that counted it would open "Nothing left to choose here." — a
 * dead end. (The header legend and the bars still count every card.)
 *   cards         the Not started cards triage can choose: "8,970 cards are not started yet."
 *   items         their items (notes): "Add the next 50 in order"
 *   neverStudied  the Not started and New cards: what "Where do you start?" can change
 *
 *   deck with 'English → German' off, only its cards Not started
 *   → { cards: 0, items: 0, … }   (no "Choose what to learn" on the page)
 */
export function choosableCounts(cards: readonly Card[], lookup: TriageLookup): { cards: number; items: number; neverStudied: number } {
  const items = triageItems(cards, lookup);
  let neverStudied = 0;
  for (const card of cards) {
    const key = life(card);
    if (key !== 'notStarted' && key !== 'new') continue;
    if (!directionOn(lookup.decks.get(card.deckId), lookup.typeIdOf(card.noteId), card.ord)) continue;
    neverStudied += 1;
  }
  return { cards: cardIdsOf(items).length, items: items.length, neverStudied };
}

/**
 * Which body the page has (spec §8.2 "Empty states"):
 *   'empty'          no card: "This deck is empty." · Add your first card · Import cards into this deck
 *   'nothingQueued'  every card is Not started (or Known), and triage has
 *                    something to choose: "Nothing from this deck is in your queue yet."
 *   'normal'         everything else
 *
 * `choosable` = the Not started cards of directions that are on
 * (`choosableCounts(…).cards`). When it is 0, "Choose what to learn" would
 * open an empty triage, so the page is never 'nothingQueued' then.
 */
export type DeckPageMode = 'empty' | 'nothingQueued' | 'normal';

export function deckPageMode(total: number, counts: Readonly<Record<LifeKey, number>>, choosable: number): DeckPageMode {
  if (total === 0) return 'empty';
  const notStarted = counts.notStarted ?? 0;
  if (choosable > 0 && notStarted + (counts.known ?? 0) >= total) return 'nothingQueued';
  return 'normal';
}

/** The words of the deck page (spec §8.2, exact). */
export const DECK_COPY = {
  empty: 'This deck is empty.',
  addFirst: 'Add your first card',
  importInto: 'Import cards into this deck',
  nothingQueued: 'Nothing from this deck is in your queue yet.',
  choose: 'Choose what to learn',
  nothingDue: 'Nothing due',
  practice: 'Practice',
  moreWays: 'More ways to study',
  newDone: "Today's new cards are done. Come back tomorrow, or practice.",
  chooseHead: 'Choose what to learn',
  cardsHead: 'Cards',
  addCard: 'Add card',
  importMore: 'Import more into this deck',
  settingsHead: 'Deck settings',
  pauseHint: "Paused decks don't add cards to Today. You can still study them here.",
  pausedBanner: "This deck is paused. Its cards don't show on Today.",
  missing: 'This deck no longer exists',
  missingSub: 'It may have been deleted.',
  menuTitle: 'Deck',
  rename: 'Rename and icon',
  duplicate: 'Duplicate deck',
  exportCsv: 'Export as CSV',
  delete: 'Delete deck…',
} as const;

/** What the study block of the page shows (spec §8.2 and the device finding about "study ahead"). */
export interface StudyBlock {
  /** "Study {n}" when n > 0; 0 = the disabled "Nothing due" button. */
  study: number;
  /**
   * The primary action when there is nothing to study now:
   *   'ahead'    "Study ahead · {n}" (reviews that are not due yet)
   *   'choose'   "Choose what to learn"
   *   'practice' "Practice · {n}"
   *   null       none, or Study itself is the primary.
   */
  fallback: 'ahead' | 'choose' | 'practice' | null;
  /** "Study ahead · {n}" — shown only when n > 0 (never an empty session). */
  ahead: number;
  /** "Practice · {n}" — shown only when n > 0. */
  practice: number;
  /**
   * True: "Today's new cards are done. Come back tomorrow, or practice."
   * Only when that is TRUE: the deck has New cards Study could show, and
   * today's new-card budget (not their state) leaves them out.
   */
  newDone: boolean;
}

/**
 * The study block. A button is shown only when the session it opens has
 * cards (the "Nothing due — study ahead" dead end opened an EMPTY session
 * when a deck had only new cards and the day's new-card limit was used up).
 *
 * "Today's new cards are done" needs three things, so it never promises
 * something that will not happen:
 *   - `eligibleNew > 0`: New cards that Study could show (not suspended, not
 *     buried, their direction on) — so there IS something to come back for;
 *   - `newLimit > 0`: the deck gets new cards at all (a deck cap of 0 gets
 *     none tomorrow either);
 *   - `newLeft === 0`: today's budget is used up (`newCardsLeftToday`).
 *
 * "Choose what to learn" is the fallback only when triage has something to
 * choose (`choosable` > 0): Not started cards of a turned-off direction do
 * not count, because triage skips them.
 *
 *   studyBlock({ ready: 0, ahead: 0, practice: 3, choosable: 0, eligibleNew: 3, newLimit: 10, newLeft: 0 })
 *   → { study: 0, fallback: 'practice', ahead: 0, practice: 3, newDone: true }
 */
export function studyBlock(input: {
  ready: number;
  ahead: number;
  practice: number;
  /** The Not started cards of directions that are on (`choosableCounts(…).cards`). */
  choosable: number;
  /** New cards of the deck that Study may show (the 'study' pool with status New). */
  eligibleNew: number;
  /** The deck's new-card limit a day (`effectiveNewLimit`). */
  newLimit: number;
  /** What is left of it today (`newCardsLeftToday`). */
  newLeft: number;
}): StudyBlock {
  const study = Math.max(0, input.ready);
  const ahead = Math.max(0, input.ahead);
  const practice = Math.max(0, input.practice);
  let fallback: StudyBlock['fallback'] = null;
  if (study === 0) {
    if (ahead > 0) fallback = 'ahead';
    else if (input.choosable > 0) fallback = 'choose';
    else if (practice > 0) fallback = 'practice';
  }
  const newDone = study === 0 && ahead === 0 && input.eligibleNew > 0 && input.newLimit > 0 && input.newLeft <= 0;
  return { study, fallback, ahead, practice, newDone };
}

/*
 * The daily new-card limit as a number the page can show: triageLogic.ts
 * `safeDailyNewLimit` (one guard for the deck page AND the triage's "They
 * come in {n} a day", so the two screens never disagree).
 */

/** The deck's own cap a day, or null for "no cap of its own" (null or a broken value). */
function deckNewCap(options: Pick<DeckOptions, 'newPerDay'> | undefined): number | null {
  const own = options?.newPerDay;
  return typeof own === 'number' && Number.isFinite(own) ? Math.max(0, Math.floor(own)) : null;
}

/**
 * The new-card limit that really applies to this deck: its own cap, but
 * never above the daily limit (both are counted, spec §4.5 bucket 4).
 */
export function effectiveNewLimit(options: Pick<DeckOptions, 'newPerDay'> | undefined, dailyNewLimit: number): number {
  const global = safeDailyNewLimit(dailyNewLimit);
  const own = deckNewCap(options);
  return own === null ? global : Math.min(own, global);
}

/**
 * How many more new cards this deck may get TODAY: the rest of the daily
 * limit (`dailyNewLimit − dayDone.neww`) and of the deck's own cap
 * (`newPerDay − dayDone.newByDeck[deck]`), the smaller one. The same two
 * budgets the scheduler uses (schedule.ts allocateNew). A `dayDone` of
 * another day counts as nothing done yet (the day roll-over).
 *
 *   daily limit 10, 10 new cards done today (any deck) → 0
 *   deck cap 5, 2 done in this deck, 3 done in total    → 3
 */
export function newCardsLeftToday(
  deck: Pick<Deck, 'id' | 'options'>,
  dailyNewLimit: number,
  dayDone: Pick<DayDone, 'dayKey' | 'neww' | 'newByDeck'> | null | undefined,
  now: number,
): number {
  const today = dayDone && dayDone.dayKey === dayKeyOf(now) ? dayDone : null;
  const used = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  const globalLeft = Math.max(0, safeDailyNewLimit(dailyNewLimit) - used(today?.neww));
  const cap = deckNewCap(deck.options);
  if (cap === null) return globalLeft;
  const byDeck = today?.newByDeck;
  const deckUsed = byDeck && Object.prototype.hasOwnProperty.call(byDeck, deck.id) ? byDeck[deck.id] : 0;
  return Math.min(globalLeft, Math.max(0, cap - used(deckUsed)));
}

/** The scope of the deck's New cards (in the queue). In a 'study' pool: the New cards Study may show. */
export function newCardsScope(deckId: Id): Query {
  return { decks: [deckId], life: ['new'] };
}

/**
 * "Today: 20 reviews + 10 new (limit 10 a day)" (spec §8.2), from the deck's
 * ReadyCounts. Learning cards count as reviews here. null when the session
 * would be empty.
 */
export function todayLine(ready: Pick<ReadyCounts, 'total' | 'learning' | 'due' | 'checks' | 'neww'>, newLimit: number): string | null {
  if (ready.total <= 0) return null;
  const reviews = ready.learning + ready.due;
  const parts: string[] = [];
  if (reviews > 0) parts.push(plural(reviews, 'review'));
  if (ready.checks > 0) parts.push(plural(ready.checks, 'check'));
  if (ready.neww > 0) parts.push(`${ready.neww.toLocaleString('en-US')} new`);
  const limit = ready.neww > 0 ? ` (limit ${newLimit.toLocaleString('en-US')} a day)` : '';
  return `Today: ${parts.join(' + ')}${limit}`;
}

/**
 * The line of "Choose what to learn" (spec §8.2). `items` = the items (notes)
 * of those cards: the "choose" flow counts items ("Add the next 6 in order",
 * triage "0 / 6"), so when an item has two directions the line says both
 * numbers (triageLogic.ts `cardsAndItems`, walkthrough M6):
 *
 *   chooseLine(8970)     → '8,970 cards are not started yet.'
 *   chooseLine(12, 6)    → '12 cards (6 items) are not started yet.'
 *   chooseLine(1)        → '1 card is not started yet.'
 */
export function chooseLine(notStarted: number, items: number = notStarted): string {
  if (notStarted === 1 && items === 1) return '1 card is not started yet.';
  return `${cardsAndItems(notStarted, items)} are not started yet.`;
}

/**
 * True when the "choose" flow must name its unit: the choosable cards are
 * more than their items (two directions), so "Add the next 6" counts items,
 * not cards. With one card per item both numbers are the same.
 */
export function chooseNamesItems(choosable: { cards: number; items: number }): boolean {
  return choosable.cards !== choosable.items;
}

/** How many items "Add the next {n} in order" adds: 50 on the normal page, 20 in the empty state (spec §8.2). */
export const NEXT_IN_ORDER = { normal: 50, nothingQueued: 20 } as const;

/**
 * "Add the next {n} in order" (spec §8.2): `learn()` on the first `max` Not
 * started ITEMS of the deck by deck order (all their enabled directions).
 * `cards` must be the deck's cards in deck order (scope.ts sortScopeCards
 * with `{ by: 'source' }`). Returns the card ids and the item count (it can
 * be less than `max`, so the label never promises more than it does).
 */
export function nextInOrder(cards: readonly Card[], lookup: TriageLookup, max: number): { cardIds: Id[]; items: number } {
  const items = triageItems(cards, lookup).slice(0, Math.max(0, max));
  return { cardIds: items.flatMap((i) => i.cardIds), items: items.length };
}

/**
 * The label of that button: "Add the next 50 in order" (or fewer, when fewer
 * are left). `namesItems` (`chooseNamesItems`): the deck's items have more
 * than one card, so the button says what it counts, like the line above it
 * ("12 cards (6 items) are not started yet." → "Add the next 6 items in order").
 */
export function nextInOrderLabel(items: number, namesItems = false): string {
  return namesItems
    ? `Add the next ${plural(items, 'item')} in order`
    : `Add the next ${items.toLocaleString('en-US')} in order`;
}

/** The snackbar of "Add the next {n} in order": "12 cards (6 items) added to your queue". */
export function nextInOrderSnack(cards: number, items: number): string {
  return `${cardsAndItems(cards, items)} added to your queue`;
}

/**
 * The number of items (notes) some cards belong to. Each item counts once,
 * however many of its directions are in `cardIds`. A card id that is not in
 * `cardById` is not counted. The snackbars of the choose flow need it: they
 * say "580 cards (290 items)" like the triage (walkthrough M6).
 *
 *   both cards of note n1 + one card of note n2 → 2
 */
export function itemCount(cardIds: readonly Id[], cardById: ReadonlyMap<Id, Pick<Card, 'noteId'>>): number {
  const notes = new Set<Id>();
  for (const id of cardIds) {
    const card = cardById.get(id);
    if (card) notes.add(card.noteId);
  }
  return notes.size;
}

/**
 * The snackbar of "Where do you start?" on the deck page. spec §8.5 makes the
 * question part of the choose flow, so it uses the triage's words and counts
 * (walkthrough M6: the same choice must read the same on both screens):
 *
 *   'known'       → '580 cards (290 items) marked as known'   (= triage stepSnack('place', …))
 *   'notStarted'  → '4 cards (2 items) moved back to Not started'
 *   one card per item → '3 cards marked as known'
 */
export function placementSnack(below: 'known' | 'notStarted', cards: number, items: number): string {
  if (below === 'known') return stepSnack('place', cards, items);
  return `${cardsAndItems(cards, items)} moved back to Not started`;
}

/* ================================================================ "By level" bars */

/**
 * One row of a "By {group}" block: the six status counts of one value (every
 * card of the value, like the header bar), and the counts of the row menu.
 */
export interface BarRow {
  value: string;
  label: string;
  total: number;
  mastered: number;
  review: number;
  learning: number;
  neww: number;
  notStarted: number;
  known: number;
  /**
   * What "Learn all" changes: the Not started cards in a direction that is
   * ON. A card of a turned-off direction is left as it is (spec §8.2: it
   * comes back with its history when the direction is turned on again).
   */
  learnable: number;
  /** The items (notes) of the `learnable` cards: the {n} of "Learn all {n}" (the triage counts items too). */
  learnableItems: number;
  /** What "Mark all as known" changes: the cards that are not Known yet, in a direction that is ON. */
  markable: number;
  /** The items (notes) of the `markable` cards: the {n} of "Mark all {n} as known". */
  markableItems: number;
  /** The tree below a section row (empty for a field value). */
  children: BarRow[];
}

/** One "By {group}" block (spec §8.2): an ordinal filter group, or the section tree. */
export interface BarBlock {
  /** The facet key: 'field:level' or 'section'. */
  key: string;
  /** "Level", "Section". */
  group: string;
  kind: OrdinalKind | null;
  rows: BarRow[];
}

function emptyRow(value: string, label: string): BarRow {
  return {
    value,
    label,
    total: 0,
    mastered: 0,
    review: 0,
    learning: 0,
    neww: 0,
    notStarted: 0,
    known: 0,
    learnable: 0,
    learnableItems: 0,
    markable: 0,
    markableItems: 0,
    children: [],
  };
}

/**
 * The items (note ids) of the row menu counts, per row, while `barBlocks`
 * tallies. A Set per row, because the cards of one note need not be next to
 * each other in the deck's cards (a direction turned on later adds its cards
 * at the end). Only the sizes go into the rows.
 */
type ItemSets = Map<BarRow, { learn: Set<Id>; mark: Set<Id> }>;

/** Count one card in a row: its status, and (direction on) the row menu counts. */
function addLife(row: BarRow, key: LifeKey, on: boolean, noteId: Id, items: ItemSets): void {
  row.total += 1;
  if (key === 'new') row.neww += 1;
  else row[key] += 1;
  if (!on || key === 'known') return;
  let sets = items.get(row);
  if (!sets) items.set(row, (sets = { learn: new Set(), mark: new Set() }));
  if (key === 'notStarted') {
    row.learnable += 1;
    sets.learn.add(noteId);
  }
  row.markable += 1;
  sets.mark.add(noteId);
}

/** The facet value tree as rows, every node in the map by value. */
function rowsOf(values: Facet['values'], into: Map<string, BarRow>): BarRow[] {
  return values
    .filter((v) => v.count > 0)
    .map((v) => {
      const row = emptyRow(v.value, v.label);
      into.set(v.value, row);
      row.children = v.children ? rowsOf(v.children, into) : [];
      return row;
    });
}

/** The label of the section block ("By section"), as the facet engine names the group. */
const SECTION_GROUP = 'Section';

/**
 * The section tree of the deck's cards, built here (the same values, labels
 * and order as the facet engine's Section group, facets.ts): one node per
 * path prefix ('verbs', 'verbs::b1'), value = `sectionValue(deck, prefix)`,
 * label = the last part of the path as the import wrote it, each level in
 * level order (A1 < A2) or by count. null when the cards are in fewer than 2
 * sections (full paths; the deck root is no section, spec §4.3).
 */
export function sectionTree(
  cards: readonly Card[],
  index: Pick<LibraryIndex, 'noteById' | 'sectionPath' | 'sectionLabel'>,
  deckId: Id,
): Facet['values'] | null {
  const counts = new Map<string, number>(); // folded path prefix → cards
  const leaves = new Set<string>();
  for (const card of cards) {
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    const path = index.sectionPath(note);
    if (path === '') continue;
    leaves.add(path);
    for (const prefix of pathPrefixes(path)) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  if (leaves.size < 2) return null;
  const nodes = new Map<string, Facet['values'][number]>();
  for (const [prefix, count] of counts) {
    nodes.set(prefix, { value: sectionValue(deckId, prefix), label: lastPart(index.sectionLabel(prefix)), count, selected: false });
  }
  const roots: Facet['values'] = [];
  for (const [prefix, node] of nodes) {
    const at = prefix.lastIndexOf('::');
    const parent = at === -1 ? undefined : nodes.get(prefix.slice(0, at));
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  const sortLevel = (level: Facet['values']) => {
    const ordinal = detectOrdinal(level.map((v) => v.label));
    sortByOrdinalOrCount(level, ordinal);
    for (const v of level) {
      if (ordinal) v.rank = ordinal.rank(v.label);
      if (v.children) sortLevel(v.children);
    }
  };
  sortLevel(roots);
  return roots;
}

/**
 * True when a field splits the deck's items exactly like their full section
 * paths (each field value ↔ one path, both ways). Then a "By {field}" block
 * already shows every part of the sections, and a "By section" block would
 * only repeat it (Spanish: Level == the section "A1"). A field with two
 * values on one item is no such split.
 *
 * The same two rules as the facet engine's equivalence collapse (facets.ts
 * `canHideBehind`):
 *   1. the parts map one to one;
 *   2. every part the section block could show must have a row in the field
 *      block. An item with NO value in the field has no row there ("By
 *      level" has no row for an empty Level). So when such an item is in a
 *      section (its path is not ''), the sections are NOT the same split:
 *      without "By section", that section could not be reached from any
 *      block on the page.
 *
 *   Level empty on exactly the items of section "Misc" → false (keep "By section")
 */
export function splitsLikeSections(
  cards: readonly Card[],
  index: Pick<LibraryIndex, 'noteById' | 'facetValues' | 'sectionPath'>,
  field: string,
): boolean {
  const pathOf = new Map<string, string>(); // field value → path
  const valueOf = new Map<string, string>(); // path → field value
  const seen = new Set<Id>();
  for (const card of cards) {
    if (seen.has(card.noteId)) continue;
    seen.add(card.noteId);
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    const values = index.facetValues(note).get(field) ?? [];
    if (values.length > 1) return false;
    const value = values[0] ?? '';
    const path = index.sectionPath(note);
    // Rule 2: no value (no row in the field block), but a section (a row in "By section").
    if (value === '' && path !== '') return false;
    const p = pathOf.get(value);
    if (p === undefined) pathOf.set(value, path);
    else if (p !== path) return false;
    const v = valueOf.get(path);
    if (v === undefined) valueOf.set(path, value);
    else if (v !== value) return false;
  }
  return true;
}

/**
 * The "By {group}" blocks of the deck page (spec §8.2): one block per
 * ORDINAL field group (Level A1 < A2 < B1 …), then the section tree. Which
 * field groups exist comes from the facet engine (`facets` = deriveFacets
 * over the deck scope, spec §4.3: a group needs ≥ 2 values). The status
 * counts are tallied here, in one pass over the deck's cards.
 *
 * "By section" is shown for EVERY deck whose cards are in ≥ 2 sections
 * (walkthrough M7), also when the facet engine hid its Section group behind
 * an equivalent field: in the Library that field is the filter, but on the
 * deck page only ORDINAL fields get a block. Coding: Category == the
 * sections, and Category is no level → no "By category" block, so the
 * sections are built here (`sectionTree`). It is left out only when a shown
 * "By {field}" block already splits the cards exactly like the sections
 * (`splitsLikeSections`, the facet engine's two rules, so every section can
 * still be reached; Spanish: Level == section).
 *
 * `deck` gives the directions that are on (triageLogic.ts `directionOn`):
 * the bar counts every card, but the row menu counts (`learnable`,
 * `markable`) only the cards of directions that are on — the cards
 * "Learn all" and "Mark all as known" change (`rowCardIds`). Their items
 * (`learnableItems`, `markableItems`) are the numbers the menu shows: the
 * choose flow counts items (walkthrough M6).
 */
export function barBlocks(
  cards: readonly Card[],
  facets: readonly Facet[],
  index: Pick<LibraryIndex, 'noteById' | 'facetValues' | 'sectionPath' | 'sectionLabel'>,
  deck: Pick<Deck, 'id' | 'options'>,
): BarBlock[] {
  const deckId = deck.id;
  const blocks: { block: BarBlock; byValue: Map<string, BarRow>; field: string | null }[] = [];
  let section: Pick<Facet, 'label' | 'values'> | null = null;
  for (const facet of facets) {
    if (facet.info) continue;
    const live = facet.values.filter((v) => v.count > 0);
    if (facet.key.startsWith('field:') && facet.ordinal && live.length >= 2) {
      const byValue = new Map<string, BarRow>();
      const rows = rowsOf(facet.values, byValue);
      blocks.push({ block: { key: facet.key, group: facet.label, kind: facet.ordinal, rows }, byValue, field: facet.key.slice(6) });
    } else if (facet.key === 'section' && live.length >= 1) {
      section = facet;
    }
  }
  // The facet engine hid the sections (an equivalent field): build them here,
  // unless a "By {field}" block above already shows the same split.
  if (section === null) {
    const values = sectionTree(cards, index, deckId);
    if (values && !blocks.some((b) => b.field !== null && splitsLikeSections(cards, index, b.field))) {
      section = { label: SECTION_GROUP, values };
    }
  }
  if (section !== null) {
    const byValue = new Map<string, BarRow>();
    const rows = rowsOf(section.values, byValue);
    blocks.push({ block: { key: 'section', group: section.label, kind: null, rows }, byValue, field: null });
  }
  if (blocks.length === 0) return [];
  const items: ItemSets = new Map();
  for (const card of cards) {
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    const key = life(card);
    const on = directionOn(deck, note.typeId, card.ord);
    for (const { byValue, field } of blocks) {
      if (field !== null) {
        const seen = new Set<string>();
        for (const v of index.facetValues(note).get(field) ?? []) {
          if (seen.has(v)) continue;
          seen.add(v);
          const row = byValue.get(v);
          if (row) addLife(row, key, on, card.noteId, items);
        }
      } else {
        for (const prefix of pathPrefixes(index.sectionPath(note))) {
          const row = byValue.get(sectionValue(deckId, prefix));
          if (row) addLife(row, key, on, card.noteId, items);
        }
      }
    }
  }
  // The item counts of the row menu (each note once per row).
  for (const [row, sets] of items) {
    row.learnableItems = sets.learn.size;
    row.markableItems = sets.mark.size;
  }
  // Rows with no card of this deck (a stale facet) are left out.
  const prune = (rows: BarRow[]): BarRow[] =>
    rows.filter((r) => r.total > 0).map((r) => ({ ...r, children: prune(r.children) }));
  return blocks.map(({ block }) => ({ ...block, rows: prune(block.rows) })).filter((b) => b.rows.length > 0);
}

/**
 * The {n} of the row menu's "Learn all {n}" and "Mark all {n} as known":
 * ITEMS (notes), only of directions that are on (see BarRow). WHY items:
 * "Learn all" and "Mark all as known" are part of the choose flow, and the
 * triage counts items ("0 / 290 items", "Learn all 290 items left"). With
 * cards, Level A1 of a two-direction deck said "Learn all 580" here and
 * "Learn all 290 left" in the triage — the same action, two numbers
 * (walkthrough M6).
 * The cards they change are `rowCardIds`; the snackbar names both
 * (`rowMenuSnack`).
 */
export function rowMenuCounts(row: Pick<BarRow, 'learnableItems' | 'markableItems'>): { learnAll: number; markKnown: number } {
  return { learnAll: row.learnableItems, markKnown: row.markableItems };
}

/**
 * The labels of the row menu (spec §8.2). "Learn all {n}" and "Mark all {n}
 * as known" count items; `namesItems` adds the noun when an item has more
 * than one card, like "Add the next 6 items in order" (glossary §1.2: notes
 * are "{n} items"). A count of 0 hides its row.
 */
export const ROW_MENU = {
  study: (n: number) => `Study ${n.toLocaleString('en-US')}`,
  practice: (n: number) => `Practice ${n.toLocaleString('en-US')}`,
  learnAll: (n: number, namesItems = false) =>
    namesItems ? `Learn all ${plural(n, 'item')}` : `Learn all ${n.toLocaleString('en-US')}`,
  markKnown: (n: number, namesItems = false) =>
    namesItems ? `Mark all ${plural(n, 'item')} as known` : `Mark all ${n.toLocaleString('en-US')} as known`,
  browse: 'Browse',
} as const;

/**
 * The two choose labels of one row's menu, or null for a count of 0 (the row
 * is hidden). Both name "items" when either count has more cards than items
 * (two directions), so one menu never mixes the plain and the named form:
 *
 *   A1, 290 items × 2 directions Not started → 'Learn all 290 items', 'Mark all 290 items as known'
 *   one card per item                       → 'Learn all 290', 'Mark all 290 as known'
 */
export function rowMenuLabels(
  row: Pick<BarRow, 'learnable' | 'learnableItems' | 'markable' | 'markableItems'>,
): { learnAll: string | null; markKnown: string | null } {
  const namesItems = row.learnable !== row.learnableItems || row.markable !== row.markableItems;
  const { learnAll, markKnown } = rowMenuCounts(row);
  return {
    learnAll: learnAll > 0 ? ROW_MENU.learnAll(learnAll, namesItems) : null,
    markKnown: markKnown > 0 ? ROW_MENU.markKnown(markKnown, namesItems) : null,
  };
}

/**
 * The snackbar of the row menu's "Learn all" / "Mark all as known": the
 * triage's words for "Learn all {n} left" / "Mark all {n} known"
 * (triageLogic.ts `stepSnack`), so the same choice reads the same on both
 * screens:
 *
 *   rowMenuSnack('learnAll', 580, 290)  → '580 cards (290 items) added to your queue'
 *   rowMenuSnack('markKnown', 580, 290) → '580 cards (290 items) marked as known'
 */
export function rowMenuSnack(which: 'learnAll' | 'markKnown', cards: number, items: number): string {
  return stepSnack(which === 'learnAll' ? 'learnAll' : 'knownAll', cards, items);
}

/**
 * The ids of the cards "Learn all" or "Mark all as known" change, from the
 * cards of one value (`cards`, the value's 'browse' pool):
 *   'learnAll'  the Not started cards, per ITEM like triage (`triageItems`:
 *               every Not started card of the note in a direction that is on);
 *   'markKnown' the cards that are not Known yet, in a direction that is on.
 * A card of a turned-off direction is never changed: when the learner turns
 * the direction on again, it comes back exactly as it was (spec §8.2).
 */
export function rowCardIds(cards: readonly Card[], which: 'learnAll' | 'markKnown', lookup: TriageLookup): Id[] {
  if (which === 'learnAll') return cardIdsOf(triageItems(cards, lookup));
  const out: Id[] = [];
  for (const card of cards) {
    if (life(card) === 'known') continue;
    if (!directionOn(lookup.decks.get(card.deckId), lookup.typeIdOf(card.noteId), card.ord)) continue;
    out.push(card.id);
  }
  return out;
}

/* ================================================================ "Where do you start?" */

/** One group "Where do you start?" can use: its values in level order. */
export interface PlacementGroup {
  /** 'field:level' or 'section'. */
  key: string;
  label: string;
  values: { value: string; label: string }[];
}

/** The last '::' part of a path. */
function lastPart(path: string): string {
  const at = path.lastIndexOf('::');
  return at === -1 ? path : path.slice(at + 2);
}

/**
 * The groups "Where do you start?" offers (spec §8.2, §8.5): every ordinal
 * field group of the scope that holds ONE value per item (a multi-value
 * field has no single level), else the sections when their last level is
 * ordinal ("Vocabulary::A1", "Grammar::A2" → A1, A2). Empty: the deck has no
 * level-like group, and the question is not asked.
 */
export function placementGroups(
  cards: readonly Card[],
  facets: readonly Facet[],
  index: Pick<LibraryIndex, 'noteById' | 'sectionPath' | 'sectionLabel' | 'fieldSpecs'>,
): PlacementGroup[] {
  const out: PlacementGroup[] = [];
  for (const facet of facets) {
    if (!facet.key.startsWith('field:') || !facet.ordinal || facet.info) continue;
    const spec = index.fieldSpecs.get(facet.key.slice(6));
    if (spec?.multiSep !== undefined) continue;
    const values = facet.values.filter((v) => v.count > 0).map((v) => ({ value: v.value, label: v.label }));
    if (values.length >= 2) out.push({ key: facet.key, label: facet.label, values });
  }
  if (out.length > 0) return out;
  const levels = new Map<string, string>(); // folded last level → display
  for (const card of cards) {
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    const path = index.sectionPath(note);
    if (path === '') continue;
    const folded = lastPart(path);
    if (!levels.has(folded)) levels.set(folded, lastPart(index.sectionLabel(path)));
  }
  if (levels.size < 2) return out;
  const ordinal = detectOrdinal([...levels.values()]);
  if (!ordinal) return out;
  const values = [...levels.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => ordinal.rank(a.label) - ordinal.rank(b.label));
  out.push({ key: 'section', label: 'Section', values });
  return out;
}

/** The level rank of a note in a placement group (its index in `group.values`), or undefined. */
export function placementRank(
  group: PlacementGroup,
  note: Note,
  index: Pick<LibraryIndex, 'facetValues' | 'sectionPath'>,
): number | undefined {
  const value =
    group.key === 'section' ? lastPart(index.sectionPath(note)) : index.facetValues(note).get(group.key.slice(6))?.[0];
  if (value === undefined || value === '') return undefined;
  const at = group.values.findIndex((v) => v.value === value);
  return at === -1 ? undefined : at;
}

/** The note ids of `noteIds` whose level is below `fromRank` (the easier levels). */
export function easierNotes(
  noteIds: readonly Id[],
  group: PlacementGroup,
  fromRank: number,
  index: Pick<LibraryIndex, 'noteById' | 'facetValues' | 'sectionPath'>,
): Id[] {
  const out: Id[] = [];
  for (const id of noteIds) {
    const note = index.noteById.get(id);
    if (!note) continue;
    const rank = placementRank(group, note, index);
    if (rank !== undefined && rank < fromRank) out.push(id);
  }
  return out;
}

/**
 * The cards of the easier levels that the deck page's "Where do you start?"
 * changes. A studied card keeps its schedule, so only never-studied cards:
 *   'known'      "I know them": Not started and New cards → Known;
 *   'notStarted' "Leave them not started": the New cards (in the queue) →
 *                Not started (the Not started ones are already there).
 * A card of a turned-off direction is never changed (`decks` gives the
 * directions, triageLogic.ts `directionOn`), like the row menu's "Learn all"
 * (`rowCardIds`): when the learner turns the direction on again, its cards
 * come back exactly as they were (spec §8.2 DirectionsSheet).
 */
export function easierCardIds(
  cards: readonly Card[],
  group: PlacementGroup,
  fromRank: number,
  index: Pick<LibraryIndex, 'noteById' | 'facetValues' | 'sectionPath'>,
  decks: ReadonlyMap<Id, Pick<Deck, 'options'>>,
  below: 'known' | 'notStarted' = 'known',
): Id[] {
  const out: Id[] = [];
  for (const card of cards) {
    if (card.reps !== 0 || card.knownAt != null) continue;
    if (below === 'notStarted' && card.newState === 'notStarted') continue;
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    if (!directionOn(decks.get(card.deckId), note.typeId, card.ord)) continue;
    const rank = placementRank(group, note, index);
    if (rank !== undefined && rank < fromRank) out.push(card.id);
  }
  return out;
}

/**
 * The triage scope from the chosen level up (the deck page's "Where do you
 * start?" then opens "Choose what to learn" there). Section groups list the
 * matching full paths of the deck's notes.
 *
 * Starting at the FIRST level (`fromRank` 0) means "nothing is easier": the
 * scope is the WHOLE deck. WHY: a level scope (`fields: { level: [...] }`)
 * matches only items that HAVE a level, so items with an empty Level field
 * would be left out silently — "Learn all 460 left" while 40 items stay Not
 * started. The page's own "Choose what to learn" uses the whole deck too.
 */
export function fromLevelScope(
  deckId: Id,
  group: PlacementGroup,
  fromRank: number,
  cards: readonly Card[],
  index: Pick<LibraryIndex, 'noteById' | 'sectionPath'>,
): Query {
  if (fromRank <= 0) return deckScope(deckId);
  const chosen = group.values.slice(fromRank).map((v) => v.value);
  if (group.key !== 'section') {
    return { decks: [deckId], fields: fieldRecord([[group.key.slice(6), chosen]]) };
  }
  const wanted = new Set(chosen);
  const paths = new Set<string>();
  for (const card of cards) {
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    const path = index.sectionPath(note);
    if (path !== '' && wanted.has(lastPart(path))) paths.add(path);
  }
  return { decks: [deckId], sections: [...paths].sort().map((path) => ({ deckId, path })) };
}

/* ================================================================ deck settings */

/** The card types of the deck's cards, by name. */
export function deckTypes(cards: readonly Card[], index: Pick<LibraryIndex, 'noteById' | 'typeById'>): NoteType[] {
  const ids = new Set<Id>();
  for (const card of cards) {
    const note = index.noteById.get(card.noteId);
    if (note) ids.add(note.typeId);
  }
  const out: NoteType[] = [];
  for (const id of ids) {
    const type = index.typeById.get(id);
    if (type) out.push(type);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** "Use my daily limit (10)" / "20 a day" (spec §8.2 "New cards per day"). */
export function newPerDayLabel(newPerDay: number | null | undefined, dailyNewLimit: number): string {
  if (typeof newPerDay !== 'number' || !Number.isFinite(newPerDay)) {
    return `Use my daily limit (${dailyNewLimit.toLocaleString('en-US')})`;
  }
  return `${Math.max(0, Math.floor(newPerDay)).toLocaleString('en-US')} a day`;
}

/** "New card order" values (spec §3.4 DeckOptions.newOrder). */
export const NEW_ORDER_LABELS: Readonly<Record<DeckOptions['newOrder'], string>> = Object.freeze({
  source: 'Deck order',
  random: 'Random order',
});

/** "New cards arrive as" values (spec §3.4 DeckOptions.newArrival). */
export const ARRIVAL_LABELS: Readonly<Record<DeckOptions['newArrival'], string>> = Object.freeze({
  queued: 'In my queue',
  notStarted: 'Not started',
});

/** The highest per-deck new-card number the NewCardsSheet offers (the daily limit's range). */
export const NEW_PER_DAY_MAX = 999;

/** One direction of a card type in the DirectionsSheet. */
export interface DirectionRow {
  ord: number;
  /** "German → English", or the template name. */
  label: string;
  /** Cards of this direction in the deck. */
  cards: number;
  on: boolean;
}

/** One card type in the DirectionsSheet: only types with two or more directions (a cloze has none to choose). */
export interface DirectionType {
  typeId: Id;
  name: string;
  rows: DirectionRow[];
}

/**
 * The DirectionsSheet rows (spec §8.2): a checkbox per template with the
 * deck's card count. "On" = the deck's direction list for the type, or (no
 * list) every direction that has cards.
 */
export function directionTypes(
  deck: Deck,
  types: readonly NoteType[],
  cards: readonly Card[],
  index: Pick<LibraryIndex, 'noteById' | 'typeById'>,
  decks: ReadonlyMap<Id, Deck>,
): DirectionType[] {
  const counts = new Map<string, number>(); // `${typeId}|${ord}` → cards
  for (const card of cards) {
    const typeId = index.noteById.get(card.noteId)?.typeId;
    if (typeId === undefined) continue;
    const key = `${typeId}|${card.ord}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: DirectionType[] = [];
  for (const type of types) {
    if (type.kind === 'cloze' || type.templates.length < 2) continue;
    const listed = Object.prototype.hasOwnProperty.call(deck.options.directions ?? {}, type.id);
    const rows = type.templates.map((t) => {
      const n = counts.get(`${type.id}|${t.ord}`) ?? 0;
      return {
        ord: t.ord,
        label: directionLabel(t.ord, [type.id], index.typeById, { decks, decksByType: new Map([[type.id, [deck.id]]]) }),
        cards: n,
        on: listed ? directionOn(deck, type.id, t.ord) : n > 0,
      };
    });
    out.push({ typeId: type.id, name: type.name, rows });
  }
  return out;
}

/**
 * The directions after a tap on one checkbox, or null when the tap would
 * turn off the LAST direction (a card type must keep one direction).
 */
export function toggledOrds(rows: readonly DirectionRow[], ord: number): number[] | null {
  const on = new Set(rows.filter((r) => r.on).map((r) => r.ord));
  if (on.has(ord)) {
    if (on.size <= 1) return null;
    on.delete(ord);
  } else on.add(ord);
  return [...on].sort((a, b) => a - b);
}

/** The "Directions" row's summary: the directions that are on ("German → English · English → German"). */
export function directionsSummary(types: readonly DirectionType[]): string {
  const labels: string[] = [];
  for (const t of types) for (const r of t.rows) if (r.on && !labels.includes(r.label)) labels.push(r.label);
  return labels.join(' · ');
}

/** The snackbar after turning a direction on or off. */
export function directionSnack(on: boolean, created: number): string {
  if (!on) return 'Direction off — its cards and progress are kept';
  return created > 0 ? `${plural(created, 'card')} added` : 'Direction on';
}

/** The fields whose read-aloud language matters (the roles that are spoken or drawn as text). */
const SPOKEN_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>(['term', 'meaning', 'example', 'exampleMeaning']);

/** True for a field the ReadAloudSheet lists per Anki card type. */
export function isSpokenField(field: Pick<FieldDef, 'role'>): boolean {
  return SPOKEN_ROLES.has(field.role);
}

/** True for a card type from Anki (it names its languages itself; the deck is no fallback). */
export function isAnkiType(type: Pick<NoteType, 'source'>): boolean {
  return Boolean(type.source?.ankiMid);
}

/** The resolved languages of the fields with `role`, over the deck's card types (spec §6.8). */
function langsOfRole(deck: Pick<Deck, 'language' | 'meaningLanguage'>, types: readonly NoteType[], role: FieldRole): string[] {
  const out: string[] = [];
  for (const type of types) {
    for (const field of type.fields) {
      if (field.role !== role) continue;
      const lang = resolveFieldLang(field, type, deck);
      if (lang && !out.includes(lang)) out.push(lang);
    }
  }
  return out;
}

/**
 * The "Read aloud" row's summary: "German / English" (the question and answer
 * languages), "German" (one side only), "Mixed" (card types disagree) or
 * "Device voice" (none set).
 *
 * A deck with NO card types yet (a new, empty deck) shows its own front and
 * back languages: they are what its first Basic cards will use (render.ts
 * resolveFieldLang falls back to them), and what the ReadAloudSheet shows.
 * So "Create deck" with "Front language: German" never says "Device voice".
 */
export function readAloudSummary(deck: Pick<Deck, 'language' | 'meaningLanguage'>, types: readonly NoteType[]): string {
  const side = (role: FieldRole) => {
    if (types.length === 0) {
      const own = role === 'term' ? deck.language : deck.meaningLanguage;
      return own ? langLabel(own) : '';
    }
    const langs = langsOfRole(deck, types, role);
    if (langs.length === 0) return '';
    const names = [...new Set(langs.map((l) => langLabel(l)))];
    return names.length === 1 ? names[0] : 'Mixed';
  };
  const front = side('term');
  const back = side('meaning');
  if (!front && !back) return 'Device voice';
  if (front && back) return `${front} / ${back}`;
  return front || back;
}

/** True when a term field of the deck resolves to German: the "Noun genders (German)" row (spec §9.3). */
export function hasGermanTerms(deck: Pick<Deck, 'language' | 'meaningLanguage'>, types: readonly NoteType[]): boolean {
  return langsOfRole(deck, types, 'term').some((lang) => primary(lang) === 'de');
}

/** Gender colours are on unless the deck turned them off (spec §3.4: default true for German terms). */
export function genderColorsOn(deck: Pick<Deck, 'genderColors'>): boolean {
  return deck.genderColors !== false;
}

/** "3 card types" / "Basic" (one type: its name). */
export function cardTypesSummary(types: readonly Pick<NoteType, 'name'>[]): string {
  if (types.length === 1) return types[0].name;
  return plural(types.length, 'card type');
}

/* ================================================================ card type editor */

/** The roles of the CardTypeSheet, with the spec's words (§8.2). */
export const ROLE_OPTIONS: readonly { id: FieldRole; label: string }[] = Object.freeze([
  { id: 'term', label: 'Headline' },
  { id: 'meaning', label: 'Answer' },
  { id: 'example', label: 'Example' },
  { id: 'exampleMeaning', label: 'Example meaning' },
  { id: 'pronunciation', label: 'Pronunciation' },
  { id: 'detail', label: 'Detail' },
  { id: 'badge', label: 'Badge' },
  { id: 'hidden', label: 'Hidden' },
]);

/** The filter choice of a field (spec §8.2: Auto / On / Off). */
export const FILTER_OPTIONS: readonly { id: FieldDef['facet']; label: string }[] = Object.freeze([
  { id: 'auto', label: 'Auto' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
]);

/**
 * One field of the draft with some keys changed. An empty language is removed.
 *
 * The label is kept EXACTLY as typed, spaces too. WHY: the label box calls
 * this on every key press, so a clean-up here would run on half-typed text.
 * Typing "Word (DE)" on the field "Word" passes "Word" on the way; removing
 * it there emptied the box, and the saved label became "(DE)".
 * `normalizeFields` cleans the draft once, when it is compared and saved.
 */
export function patchFieldDef(fields: readonly FieldDef[], i: number, patch: Partial<Pick<FieldDef, 'label' | 'role' | 'facet' | 'lang'>>): FieldDef[] {
  return fields.map((f, j) => {
    if (j !== i) return f;
    const next: FieldDef = { ...f, ...patch };
    if ('label' in patch && patch.label === undefined) delete next.label;
    if ('lang' in patch && !patch.lang) delete next.lang;
    if (next.role !== 'badge') delete next.multiSep;
    return next;
  });
}

/**
 * The draft as Save writes it: each label is trimmed, and a label that is
 * empty or the field name itself is removed (the field then shows its name).
 *
 *   { name: 'Word', label: ' Word (DE) ' } → { name: 'Word', label: 'Word (DE)' }
 *   { name: 'Word', label: 'Word' }        → { name: 'Word' }
 *   { name: 'Word', label: '   ' }         → { name: 'Word' }
 */
export function normalizeFields(fields: readonly FieldDef[]): FieldDef[] {
  return fields.map((f) => {
    if (f.label === undefined) return f;
    const label = f.label.trim();
    if (label === f.label && label !== '' && label !== f.name) return f;
    const next: FieldDef = { ...f };
    if (label === '' || label === f.name) delete next.label;
    else next.label = label;
    return next;
  });
}

/** True when two field definitions hold the same values (the key order does not matter). */
function sameField(a: FieldDef, b: FieldDef): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof FieldDef)[]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * True when Save would change the stored fields (the Save button is live).
 * Both sides are compared as Save writes them (`normalizeFields`), so a
 * label typed back to what it was is "no change".
 */
export function fieldsChanged(stored: readonly FieldDef[], draft: readonly FieldDef[]): boolean {
  const a = normalizeFields(stored);
  const b = normalizeFields(draft);
  return a.length !== b.length || a.some((f, i) => !sameField(f, b[i]));
}

/** "Also used in 2 other decks. Changes apply there too." — or '' when only this deck uses the card type. */
export function sharedTypeNote(otherDecks: number): string {
  if (otherDecks <= 0) return '';
  return otherDecks === 1
    ? 'Also used in 1 other deck. Changes apply there too.'
    : `Also used in ${otherDecks.toLocaleString('en-US')} other decks. Changes apply there too.`;
}

/* ================================================================ CSV export */

/**
 * The deck as CSV (spec §8.2 "Export as CSV"): one row per item (note), in
 * deck order; the header is the field names (of every card type of the deck,
 * in their order), then Tags and Section. When a card type has a FIELD
 * called Tags or Section, those two columns are "Item tags" / "Item section"
 * (two "Tags" headers would make the importer pick no tags column, and the
 * app never says "note": spec §1.2). Field values are written as they
 * are stored (raw), so the file imports again. No formula guard: it is meant
 * to be imported, and the apostrophe would become part of the value
 * (src/platform/csv.ts).
 */
export function deckCsv(cards: readonly Card[], index: Pick<LibraryIndex, 'noteById' | 'typeById'>): string {
  const notes: Note[] = [];
  const seen = new Set<Id>();
  for (const card of cards) {
    if (seen.has(card.noteId)) continue;
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    seen.add(card.noteId);
    notes.push(note);
  }
  notes.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const names: string[] = [];
  for (const note of notes) {
    for (const f of index.typeById.get(note.typeId)?.fields ?? []) if (!names.includes(f.name)) names.push(f.name);
  }
  if (names.length === 0) names.push('Front', 'Back');
  const tagsCol = names.includes('Tags') ? 'Item tags' : 'Tags';
  const sectionCol = names.includes('Section') ? 'Item section' : 'Section';
  const rows = notes.map((note) => {
    const type = index.typeById.get(note.typeId);
    const values = names.map((name) => {
      const at = type ? type.fields.findIndex((f) => f.name === name) : -1;
      return at === -1 ? '' : (note.fields[at] ?? '');
    });
    return [...values, note.tags.join(' '), note.section];
  });
  return toCsv([...names, tagsCol, sectionCol], rows);
}

/**
 * The export file name: the deck name made safe for a file, then the date.
 *
 *   deckCsvFileName('German: Verbs', Date of 2026-10-24) → 'German- Verbs-2026-10-24.csv'
 */
export function deckCsvFileName(name: string, now: number): string {
  const safe = name.replace(/[/\\\0:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'deck';
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${safe}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}

/* ================================================================ delete */

/** The three no-orphan choices of "Delete deck…" (spec §3.12, §8.2). */
export type DeleteMode = 'move' | 'keep' | 'all';

/** The options of the DeleteDeckSheet, with the spec's words (§7 #38). */
export function deleteOptions(opts: { canMove: boolean; canKeep: boolean; unfiledExists: boolean; unfiledName: string }) {
  const all: { id: DeleteMode; title: string; sub: string }[] = [
    { id: 'move', title: 'Move cards to another deck', sub: 'Keeps every card and its progress' },
    {
      id: 'keep',
      title: 'Keep cards, remove the deck',
      sub: opts.unfiledExists
        ? `Move cards to your '${opts.unfiledName}' deck`
        : `Move cards to a new deck called '${opts.unfiledName}'`,
    },
    { id: 'all', title: 'Delete deck and all its cards', sub: 'Permanent — their study progress is lost' },
  ];
  return all.filter((o) => (o.id !== 'move' || opts.canMove) && (o.id !== 'keep' || opts.canKeep));
}

/** The snackbar after the delete: it says where the cards went. */
export function deleteSnackText(mode: DeleteMode, cardCount: number, whereName: string): string {
  if (cardCount === 0) return 'Deck deleted';
  if (mode === 'all') return 'Deck and cards deleted';
  return `Deck deleted — cards moved to ${whereName}`;
}

/* ================================================================ status tally */

/** A status tally with every key at 0. */
export function zeroCounts(): Record<LifeKey, number> {
  const out = {} as Record<LifeKey, number>;
  for (const key of LIFE_KEYS) out[key] = 0;
  return out;
}

/** Cards per status (Not started · New · Learning · Review · Mastered · Known). */
export function lifeCounts(cards: readonly Card[]): Record<LifeKey, number> {
  const out = zeroCounts();
  for (const card of cards) out[life(card)] += 1;
  return out;
}

/* ================================================================ store helpers */

/**
 * A store selector that stops working while `live` is false: it then
 * returns its last value without computing (and computes once, if it never
 * did). The deck page stays mounted under a session it opened; without this,
 * every rating in that session would count the deck page's numbers again.
 * `useIsFocused()` gives `live`. The store never changes data in place, so the
 * value is only stale while the page cannot be seen; the first render after
 * the page comes back computes it again.
 */
export function frozenUnless<S, T>(selector: (state: S) => T, live: boolean): (state: S) => T {
  let last: { value: T } | null = null;
  return (state) => {
    if (live || last === null) last = { value: selector(state) };
    return last.value;
  };
}

/**
 * "Practice articles · {n}" (spec §8.2, §9.3): the length of the Articles
 * practice of scope `q` — modes.ts `articleCards` over the scope's PRACTICE
 * pool before the session-size cut, capped by the session size. The same
 * call the session makes, so the number is the session it opens.
 */
export function articlePracticeCount(state: ScopeState, q: Query, now: number): number {
  const ctx = matchCtxOf(state, now);
  const uncapped = buildSessionQueue({ kind: 'practice', q }, { ...state, settings: { ...state.settings, sessionLimit: 0 } }, ctx);
  const faceOf = facesFor(libraryIndexOf(state), decksById(state.decks));
  return articleCards(uncapped, faceOf, state.settings.sessionLimit).length;
}

/** Card type id → the ids of the decks that have cards of it (one pass; for "Also used in 2 other decks"). */
export function typeDecks(state: Pick<ScopeState, 'cards' | 'notes'>): Map<Id, Set<Id>> {
  const typeOfNote = new Map<Id, Id>();
  const { notes } = state;
  for (const note of notes ?? []) typeOfNote.set(note.id, note.typeId);
  const out = new Map<Id, Set<Id>>();
  for (const card of state.cards ?? []) {
    const typeId = typeOfNote.get(card.noteId);
    if (typeId === undefined) continue;
    let decks = out.get(typeId);
    if (!decks) out.set(typeId, (decks = new Set()));
    decks.add(card.deckId);
  }
  return out;
}

/** The first note of each card type among the deck's cards (the CardTypeSheet's sample). */
export function typeSamples(cards: readonly Card[], index: Pick<LibraryIndex, 'noteById'>): Map<Id, Note> {
  const out = new Map<Id, Note>();
  for (const card of cards) {
    const note = index.noteById.get(card.noteId);
    if (note && !out.has(note.typeId)) out.set(note.typeId, note);
  }
  return out;
}

/**
 * The lookups `triageItems` needs, from a state (or just its cards) and its
 * MatchCtx. The ONE builder of them: the triage screen, the deck page, the
 * session and the Library's "Choose ({n})" (libraryState.ts chooseCount)
 * all use it, so they always count the same items (M6).
 */
export function triageLookupOf(state: { readonly cards: readonly Card[] }, ctx: Pick<MatchCtx, 'decks' | 'index'>): TriageLookup {
  const { cardById, cardIdsByNote } = cardLookupOf(state.cards);
  return {
    cardById,
    cardIdsByNote,
    decks: ctx.decks,
    typeIdOf: (noteId) => ctx.index.noteById.get(noteId)?.typeId,
  };
}
