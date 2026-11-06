/**
 * AddSheet — the ONE "add" menu (spec §2.3, §8.10, unit W4-1; it replaces
 * AddDeckSheet). Opened only from the Today header "+".
 *
 *   Add
 *   New card          Into {last used deck}         → /card-editor?deckId=   (hidden without decks)
 *   New deck          Start empty and type your own cards → /deck-editor
 *   Import a file     Anki .apkg or .csv            → /import?source=file
 *   Find on AnkiWeb   Search shared decks           → /import?source=ankiweb
 *   New list          Save a filter, like ‘B1 verbs’ → Library, banner "Choose filters, then tap Save as list."
 *   STARTER DECKS     (only when the build's content pack has starter decks)
 *   German vocabulary 6,845 words, A1 to C1        [ Add ]
 *   German grammar    906 questions, A1 to B2       Added ✓
 *                     ( Add again )                   ← "Already up to date."
 *   German verbs      682 verbs …                   [ Add ]
 *                     You may already have this deck: German Verbs   ← a deck from before (the fork)
 *
 * Starter decks (spec §5.10) go through the same import pipeline as a file
 * (src/domain/starterDecks.ts `addStarterDeck`). Adding is IDEMPOTENT: the
 * deck is found again by its sourceKey, and every note by its guid. A row
 * whose deck is in the library says "Added ✓" and opens the deck page; under
 * it, one button adds the deck AGAIN (the same idempotent add):
 *   - "Add again" → "Already up to date." (or what it really changed: notes
 *     deleted since come back, a missing image is written again);
 *   - "Update {title} (keeps your progress)" when the bundled file is NEWER
 *     than the one the deck came from (pack `version` bump): changed notes are
 *     updated, new notes are added, every card keeps its progress.
 *
 * WHICH version a deck came from (W5-1). The state has no field for it
 * (starterDecks.ts "Not done here"), so it is read from the notes: each note a
 * starter file adds gets `source.ref = 'pack:<pack>:<key>@<version>'`, and
 * the deck's version is the highest one among its notes
 * (`installedStarterVersions`). One limit: an update that only CHANGES notes
 * adds no note with the new version, so the notes still say the old one.
 * So the sheet also remembers each deck that an add found up to date with
 * the bundled version (`checked`), and keeps that memory ON THIS DEVICE (the
 * kv-store key `maranki.starterChecked`, `readCheckedVersions` /
 * `saveCheckedVersions`), so it lasts after a restart. It is not in a
 * backup: on another phone the row offers the update once more, and that tap
 * answers "Already up to date." (RELEASING.md). The right home for it is a
 * field of the deck, written by applyImport (a model change for later).
 * A version is remembered only when the deck is ON THE DISK: an add that
 * changed nothing still runs one flush (`withSettledSave`), because an
 * earlier add may be only in memory (its save failed). Until that flush
 * works, the tap says the save warning, never "Already up to date.".
 *
 * "HOW SHOULD NEW CARDS START?" (spec §5.9, decision D3). A NEW starter deck
 * follows the same rule as the import screen: more than 1,000 new cards →
 * they start Not started, and the snackbar offers "Choose what to learn";
 * fewer → they go into the study queue. Onboarding passes its own choice
 * (always Not started: it adds all three decks).
 *
 * ONE READ, ONE PLAN (wave 5b R5), ONE ADD (wave 5c). Knowing the number of
 * new cards BEFORE `addStarterDeck` ran meant a second read and plan of the
 * same file (the old probe: 3 MB German_Vocabulary was unzipped and planned
 * twice; that probe was deleted in wave 5d). Now the sheet gives
 * `addStarterDeck` its D3 rule (`STARTER_D3_RULE`, through `addStarterOnce`):
 * the add reads the file once, plans it once with the arrival that the
 * file's card rows predict (`likelyArrival`), and checks that guess against
 * the plan's real number of new cards. Only a wrong guess plans once more
 * (from the same read). The add steps themselves live only in
 * src/domain/starterDecks.ts, so the sheet and onboarding can never add a
 * deck in two different ways.
 *
 * A DECK FROM BEFORE (spec §9.5, fork users). The German fork made its decks
 * ("German Verbs", "German Grammar", "German Vocabulary") without a
 * sourceKey, and its cards have no Anki guid, so neither finds them: the row
 * says "Add", and an add would make a SECOND copy next to the learner's own
 * deck. So a row whose title matches a deck with no sourceKey
 * (`starterLookalikes`) says "You may already have this deck: German Verbs",
 * and "Add" asks first ("Add anyway").
 *
 * ONE starter task at a time (W5-1 review leftover). The rows, the "Try
 * again" of the images, the "Add as a new deck" and "Add anyway" of the
 * snackbar all go through `starterTaskGuard`. A snackbar button is made by
 * an EARLIER render, so a check of React state there sees an old value; the
 * guard object is the same in every render, so it always knows. A tap while
 * a task runs starts nothing and says which deck is still being added.
 *
 * The sheet stays open while a deck is added, and shows the result on its own
 * snackbar (a sheet is a native modal that covers the screen's snackbar),
 * with "Try again" when the images could not be saved, "Add as a new deck"
 * when the cards are already in another deck, and "Choose what to learn"
 * when the new cards start Not started.
 *
 * Every row does what it says: no snackbar-only row (spec §7 #16).
 */
import { type Href, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Platform, Text, View } from 'react-native';

import { TRIAGE_READY } from '@/components/import/PreviewStage';
import { Btn, ListRow, Overline, Sheet, SnackbarView } from '@/components/ui';
import { lastUsedDeckId } from '@/domain/fieldText';
import { readApkg } from '@/domain/import/apkgRead';
import { defaultArrival, saveWarning } from '@/domain/importFile';
import type {
  AnkiCollection,
  DataStateV3,
  Deck,
  Id,
  ImportChoices,
  ImportResult,
  ImportSummary,
  Query,
} from '@/domain/model';
import { matchCtxOf, scopePool } from '@/domain/scope';
import {
  addStarterDeck,
  findStarterDeck,
  loadStarterBytes,
  planStarterDeckFrom,
  type StarterArrivalRule,
  type StarterDeckOutcome,
  type StarterDeckRow,
  type StarterDeps,
  starterDeckRows,
  type StarterElsewhereDeck,
  type StarterImages,
  type StarterKind,
  type StarterPlanOptions,
  starterSourceKey,
  writeStarterImages,
} from '@/domain/starterDecks';
import { foldText, oneLine, plural } from '@/domain/text';
import { writeImportMedia } from '@/platform/media';
import type { FlushResult } from '@/store/actions';
import type { Engine } from '@/store/engine';
import { memoOnInputs, useEngine, useStateV3 } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { afterAppStorageLoad } from '@/store/storage';
import { getKvStore } from '@/store/storage/kvStoragePort';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';
import { activePack, type ContentPack, type StarterDeck } from '@/variants';

import {
  ADD_SHEET_TITLE,
  addSheetRows,
  type AddRow,
  deckRoute,
  libraryRoute,
  NEW_LIST_PARAM,
  STARTER_COPY,
  starterMessage,
  TODAY_COPY,
  triageRoute,
} from '../today/todayLogic';

/* ------------------------------------------------------- starter deck logic */

/** The words of the second button of an added starter deck (spec §5.10). */
export const STARTER_AGAIN_COPY = {
  /** The bundled file is not newer: the add runs again and says "Already up to date.". */
  again: 'Add again',
  againLabel: (title: string) => `Add ${title} again`,
  /** The bundled file is newer than the one the deck came from. */
  update: (title: string) => `Update ${title} (keeps your progress)`,
  updating: 'Updating…',
  /** A tap while another starter task runs. */
  busy: (title: string) => `Still adding ${title}. Try again when it is done.`,
} as const;

/** The words of a starter row that may already be in the library (a deck from before, see the top of the file). */
export const STARTER_LOOKALIKE_COPY = {
  /** The line under the row. */
  note: (names: string) => `You may already have this deck: ${names}`,
  /** The snackbar of "Add": it asks first. */
  ask: (names: string) => `You may already have this deck: ${names}. Add a second copy?`,
  addAnyway: 'Add anyway',
} as const;

/** The words of a new starter deck whose cards start Not started (decision D3). */
export const STARTER_CHOOSE_COPY = {
  notStarted: 'They start as Not started.',
  choose: 'Choose what to learn',
} as const;

/**
 * The bundled version each starter deck in the library came from, by starter
 * key: the highest `<version>` in the `source.ref` of the deck's notes
 * ('pack:german:vocabulary@1' → 1). null = the pack's deck is not in the
 * library, or none of its notes says (for example every note was deleted).
 * A note counts for the deck that holds its cards. PURE.
 *
 *   installedStarterVersions(germanPack, state).get('vocabulary') → 1
 */
export function installedStarterVersions(
  pack: ContentPack,
  state: Pick<DataStateV3, 'decks' | 'notes' | 'cards'>,
): Map<string, number | null> {
  // Destructured, like the other screens do: face.test.ts guards property reads named
  // like the old card text fields, and the note list has one of those names.
  const { decks, notes, cards } = state;
  const out = new Map<string, number | null>();
  // deck id → the starter it holds, and the ref prefix of that starter's notes.
  const starterOfDeck = new Map<Id, { key: string; prefix: string }>();
  for (const starter of pack.starterDecks) {
    out.set(starter.key, null);
    const deck = findStarterDeck(decks, pack.id, starter.key);
    if (deck) starterOfDeck.set(deck.id, { key: starter.key, prefix: `${starterSourceKey(pack.id, starter.key)}@` });
  }
  if (starterOfDeck.size === 0) return out;
  const deckOfNote = new Map<Id, Id>();
  for (const c of cards) {
    if (starterOfDeck.has(c.deckId) && !deckOfNote.has(c.noteId)) deckOfNote.set(c.noteId, c.deckId);
  }
  for (const n of notes) {
    const deckId = deckOfNote.get(n.id);
    const ref = n.source?.ref;
    if (deckId === undefined || typeof ref !== 'string') continue;
    const starter = starterOfDeck.get(deckId);
    if (!starter || !ref.startsWith(starter.prefix)) continue;
    const version = Number(ref.slice(starter.prefix.length));
    if (!Number.isInteger(version) || version < 1) continue;
    const was = out.get(starter.key) ?? null;
    out.set(starter.key, was === null ? version : Math.max(was, version));
  }
  return out;
}

/**
 * What a starter deck row offers (spec §5.10, §8.10):
 *   'add'    → the deck is not in the library: "Add";
 *   'update' → "Added ✓" + "Update {title} (keeps your progress)": the deck came
 *              from an OLDER bundled file than this build's;
 *   'again'  → "Added ✓" + "Add again" (the same idempotent add; it answers
 *              "Already up to date." when nothing changed).
 * `installed` = installedStarterVersions; `checked` = the version an add in
 * this sheet found up to date for this deck (see the top of the file).
 * Unknown (no version anywhere) is never an update: there is nothing to
 * compare with, and "Add again" runs the very same add.
 */
export function starterRowAction(
  row: StarterDeckRow,
  installed: number | null,
  checked: number | undefined,
): 'add' | 'update' | 'again' {
  if (row.deckId === null) return 'add';
  const known = Math.max(installed ?? 0, checked ?? 0);
  return known > 0 && known < row.starter.version ? 'update' : 'again';
}

/**
 * True when the outcome shows that the existing starter deck now holds the
 * bundled version: an add of that deck that found nothing more to change, or
 * that changed it, and is saved (or needed no save).
 *
 * The sheet gives it the SETTLED outcome (`withSettledSave`), so `saved` is
 * never null there: an add that changed nothing may still sit on top of an
 * EARLIER add that is only in memory.
 */
export function confirmsBundledVersion(outcome: Pick<StarterDeckOutcome, 'kind' | 'deckId' | 'saved'>): boolean {
  return (
    outcome.deckId !== null &&
    (outcome.kind === 'update' || outcome.kind === 'upToDate') &&
    (outcome.saved === null || outcome.saved.ok)
  );
}

/**
 * The outcome of an add, with the save that really counts (W5-1 review
 * round 2). An add that changed nothing saves nothing (`saved` null). But an
 * EARLIER add may be applied and still wait for its save (its flush failed):
 * then the deck is only in memory, and "Already up to date." or a confirmed
 * version would not be true. So when `saved` is null, this runs ONE more
 * `flush()` (it is cheap when nothing waits) and puts its answer in `saved`.
 * An outcome with its own save is given back as it is (no second flush).
 *
 *   tap "Update"  → applied, the flush fails → saved { ok: false }: the save warning, no confirm
 *   tap it again  → nothing more to change   → flush() again: { ok: false } → the save warning, no confirm
 *                                                              { ok: true }  → "Already up to date.", confirm
 */
export async function withSettledSave<T extends Pick<StarterDeckOutcome, 'saved'>>(
  outcome: T,
  flush: () => Promise<FlushResult>,
): Promise<T & { saved: FlushResult }> {
  const saved = outcome.saved ?? (await flush());
  return { ...outcome, saved };
}

/* ------------------------------------- the confirmed versions, on this device */

/** The kv-store key of the confirmed versions (the same kv file as the theme, `maranki-kv.db`). */
export const STARTER_CHECKED_KEY = 'maranki.starterChecked';

/**
 * The saved text → deck id → the bundled version an add confirmed for that
 * deck. The text is a JSON list of pairs (`[["d-1",2]]`), so a deck id is
 * never an object key. A missing or broken text, and a pair that is not
 * (text, whole number ≥ 1), give nothing. PURE.
 *
 *   parseCheckedVersions('[["d-1",2]]') → Map { 'd-1' → 2 }
 *   parseCheckedVersions('oops')        → Map {}
 */
export function parseCheckedVersions(raw: string | null): Map<Id, number> {
  const out = new Map<Id, number>();
  if (raw === null || raw === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const pair of parsed) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [deckId, version] = pair as unknown[];
    if (typeof deckId !== 'string' || deckId === '') continue;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue;
    out.set(deckId, version);
  }
  return out;
}

/** The map back as the saved text (see parseCheckedVersions). PURE. */
export function serializeCheckedVersions(map: ReadonlyMap<Id, number>): string {
  return JSON.stringify([...map]);
}

/** The confirmed versions, in memory, with a save after each change. */
export interface CheckedVersions {
  /** deck id → the bundled version an add confirmed for that deck. */
  get(): ReadonlyMap<Id, number>;
  /**
   * Remember `version` for `deckId`. Decks that are not in `liveDeckIds` any
   * more are forgotten (a deleted deck never comes back with the same id).
   * Calls `save` with the new text, and returns the new map.
   */
  confirm(deckId: Id, version: number, liveDeckIds: readonly Id[]): ReadonlyMap<Id, number>;
}

/**
 * A new memory of confirmed versions, starting at `initial` (what this device
 * saved). The sheet keeps ONE in its state, like the task guard, so an add
 * that ends after a later render still sees the newest map.
 */
export function checkedVersions(initial: ReadonlyMap<Id, number>, save: (text: string) => void): CheckedVersions {
  let current: ReadonlyMap<Id, number> = initial;
  return {
    get: () => current,
    confirm(deckId, version, liveDeckIds) {
      const live = new Set(liveDeckIds);
      const next = new Map<Id, number>();
      for (const [id, v] of current) if (id !== deckId && live.has(id)) next.set(id, v);
      next.set(deckId, version);
      current = next;
      save(serializeCheckedVersions(next));
      return next;
    },
  };
}

/** Nothing is saved on the web preview (D6), so it never opens the kv file. */
const SAVES_CHECKED = Platform.OS !== 'web';

/**
 * The confirmed versions this device saved, read synchronously from the
 * kv-store (like the theme). A failed read gives an empty map: the row may
 * then offer an update once more, and that tap answers "Already up to date.".
 */
export function readCheckedVersions(): Map<Id, number> {
  if (!SAVES_CHECKED) return new Map();
  try {
    return parseCheckedVersions(getKvStore().getItemSync(STARTER_CHECKED_KEY));
  } catch {
    return new Map();
  }
}

/** The writes, one after another (the last text always wins). Never rejects. */
let checkedWrites: Promise<void> = Promise.resolve();

/**
 * Save the text of the confirmed versions in the kv-store, AFTER the app
 * storage's first load (`afterAppStorageLoad`, the rule for every kv writer
 * outside the app port, see ThemeContext.tsx) and after every earlier write.
 * A failed write keeps the memory for this run only. Resolves when it is done
 * or failed; never rejects.
 */
export function saveCheckedVersions(text: string): Promise<void> {
  if (!SAVES_CHECKED) return Promise.resolve();
  const write = checkedWrites.then(async () => {
    await afterAppStorageLoad();
    await getKvStore().setItem(STARTER_CHECKED_KEY, text);
  });
  checkedWrites = write.catch(() => {
    // Not saved: the memory still works until the app restarts.
  });
  return checkedWrites;
}

/* ------------------------------------------------- decks from before, and D3 */

/**
 * The decks that may already BE this starter deck, from before it had a
 * sourceKey (see the top of the file): a deck with no sourceKey whose name
 * is the starter title, with case, accents and spaces ignored. A deck WITH a
 * sourceKey came from somewhere known (a file, AnkiWeb, a pack), so it is
 * never one of these. PURE.
 *
 *   starterLookalikes(germanVerbs, decks) → [the fork's "German Verbs" deck]
 */
export function starterLookalikes(starter: StarterDeck, decks: readonly Deck[]): Deck[] {
  const title = foldText(oneLine(starter.title));
  return decks.filter((d) => !d.sourceKey && foldText(oneLine(d.name)) === title);
}

/**
 * What the NEW cards of a starter deck get when the caller did not say
 * (spec §5.9, decision D3), from a plan of that deck:
 *   a new deck ('add') with more than 1,000 new cards → 'notStarted' ("Let me choose what to learn");
 *   a new deck with fewer                             → 'queued' ("Add all to my study queue");
 *   anything else (no new deck)                       → undefined: the planner's own default.
 * PURE.
 */
export function starterArrivalFor(probe: {
  kind: StarterKind;
  plan: { summary: Pick<ImportSummary, 'newCards'> };
}): ImportChoices['arrival'] | undefined {
  if (probe.kind !== 'add') return undefined;
  return defaultArrival(probe.plan.summary.newCards, TRIAGE_READY);
}

/** Reads the collection of a starter file (the import's .apkg reader, `readApkg`). Tests pass a fake. */
export type StarterReader = (bytes: Uint8Array, fileName: string) => Promise<AnkiCollection>;

/** Plans a starter deck from a collection (`planStarterDeckFrom`). Tests pass a counting wrapper. */
export type StarterPlanner = typeof planStarterDeckFrom;

/**
 * The arrival that a NEW starter deck's new cards will most likely get, from
 * the file alone: its number of card rows, with the same 1,000 rule as the
 * plan (`defaultArrival`). Only a GUESS: the real number of new cards comes
 * from the plan (directions, cards with Anki progress), and
 * `addStarterOnce` checks it. PURE.
 *
 *   likelyArrival(German_Verbs: 1,364 card rows) → 'notStarted'
 *   likelyArrival(German_Grammar: 906 card rows) → 'queued'
 */
export function likelyArrival(collection: Pick<AnkiCollection, 'cards'>): ImportChoices['arrival'] {
  return defaultArrival(collection.cards.length, TRIAGE_READY);
}

/** What one "Add" of the sheet did. */
export interface StarterAddRun {
  outcome: StarterDeckOutcome;
  /**
   * What the NEW cards got: 'notStarted' → the snackbar offers "Choose what
   * to learn" (`starterChooseQuery`). undefined = the planner's own default
   * (an existing deck keeps its own "new cards start" setting).
   */
  arrival: ImportChoices['arrival'] | undefined;
}

/**
 * D3 for a NEW starter deck (spec §5.9), as a rule for `addStarterDeck`
 * (src/domain/starterDecks.ts `StarterArrivalRule`): guess from the file's
 * card rows (`likelyArrival`), then check the guess with the plan's own
 * number of new cards (`starterArrivalFor`).
 */
export const STARTER_D3_RULE: StarterArrivalRule = { guess: likelyArrival, fromPlan: starterArrivalFor };

/**
 * "Add" in the sheet: the ONE add of a starter deck (`addStarterDeck`), with
 * D3 for a NEW deck (`STARTER_D3_RULE`) when the caller chose no arrival
 * (wave 5c). So the sheet has no copy of the add steps: a fix in
 * starterDecks.ts reaches the sheet and onboarding alike (review round 1
 * "KNOWN COST", now gone). `addStarterDeck` reads the file ONCE and plans it
 * once when the guess is right (wave 5b R5):
 *   - the caller chose the arrival, or the deck is in the library → the
 *     usual add (the deck keeps its own "new cards start" setting);
 *   - a new deck → the arrival of D3; `run.arrival` says which (the
 *     snackbar then offers "Choose what to learn" for 'notStarted');
 *   - the plan makes NO new deck after all ('elsewhere': the file's notes are
 *     in other decks) → the usual add, from the same read.
 * Throws like `addStarterDeck`: an ApkgError when the bundled file cannot be
 * loaded or read (a failed load is 'corrupt'); the library is unchanged
 * then. The sheet shows one message for every such error.
 *
 * `read` and `plan` are for tests (they count the reads and the plans). The
 * defaults are the same reader and planner `addStarterDeck` uses itself; the
 * loader is passed the same way (`loadStarterBytes` when `deps` has none).
 */
export async function addStarterOnce(
  pack: ContentPack,
  key: string,
  deps: StarterDeps,
  opts: StarterPlanOptions = {},
  read: StarterReader = readApkg,
  plan: StarterPlanner = planStarterDeckFrom,
): Promise<StarterAddRun> {
  const steps: StarterDeps = { ...deps, loadBytes: deps.loadBytes ?? loadStarterBytes, readFile: read, planDeck: plan };
  const rule = opts.arrival === undefined ? STARTER_D3_RULE : undefined;
  const outcome = await addStarterDeck(pack, key, steps, opts, rule);
  return { outcome, arrival: outcome.arrival ?? opts.arrival };
}

/**
 * "Choose what to learn" after an add (D3): the Not started cards of the NEW
 * deck, when its cards started Not started. null = nothing to choose (the
 * deck existed, or its new cards went into the study queue). The same scope
 * as Today's and onboarding's "Choose what to learn". PURE.
 */
export function starterChooseQuery(
  outcome: Pick<StarterDeckOutcome, 'kind' | 'deckId'>,
  arrival: ImportChoices['arrival'] | undefined,
): Query | null {
  if (outcome.kind !== 'add' || outcome.deckId === null || arrival !== 'notStarted') return null;
  return { decks: [outcome.deckId], life: ['notStarted'], notFlags: ['suspended'] };
}

/* ------------------------------------------------------ one task at a time */

/** Runs at most ONE starter deck task at a time (see the top of the file). */
export interface StarterTaskGuard {
  /** The key of the task that runs now, or null. */
  running(): string | null;
  /**
   * Runs `task` when no task runs, and resolves true when it is done. When a
   * task already runs, it does NOT run `task` and resolves false at once. An
   * error of `task` is passed on (after the guard is free again).
   */
  run(key: string, task: () => Promise<void>): Promise<boolean>;
}

/**
 * A new guard. `onChange` hears the running key (and null when it is done),
 * so a screen can draw "Adding…" and disable its buttons.
 *
 *   const [guard] = useState(() => starterTaskGuard(setBusy));
 *   void guard.run('vocabulary', () => add('vocabulary'));
 */
export function starterTaskGuard(onChange: (running: string | null) => void = () => {}): StarterTaskGuard {
  let current: string | null = null;
  return {
    running: () => current,
    async run(key, task) {
      if (current !== null) return false;
      current = key;
      onChange(key);
      try {
        await task();
      } finally {
        current = null;
        onChange(null);
      }
      return true;
    },
  };
}

/* ------------------------------------------- onboarding's progress list */

/**
 * The status line of one starter deck after `addStarterDeck` (the progress
 * list of onboarding's "Start with German"):
 *   'add'       → '13,690 cards added · 1,101 cards marked Known'
 *   'update'    → 'Updated · your progress is kept'
 *   'upToDate'  → 'Already up to date.'
 *   'elsewhere' → 'Already in Unfiled cards'
 * + ' · Some images were not saved.' when the images were not written.
 */
export function starterOutcomeLine(outcome: {
  kind: StarterKind;
  result: Pick<ImportResult, 'cardsAdded' | 'markedKnown'> | null;
  images: StarterImages;
  elsewhereDecks: readonly StarterElsewhereDeck[];
}): string {
  const parts: string[] = [];
  switch (outcome.kind) {
    case 'add':
      parts.push(`${plural(outcome.result?.cardsAdded ?? 0, 'card')} added`);
      break;
    case 'update':
      parts.push('Updated', 'your progress is kept');
      break;
    case 'upToDate':
      parts.push('Already up to date.');
      break;
    case 'elsewhere': {
      const names = outcome.elsewhereDecks.map((d) => d.deckName).filter((n) => n !== '');
      parts.push(`Already in ${names.length > 0 ? names.join(', ') : 'your other decks'}`);
      break;
    }
  }
  const known = outcome.result?.markedKnown ?? 0;
  if (known > 0) parts.push(`${plural(known, 'card')} marked Known`);
  if (outcome.images === 'skipped' || outcome.images === 'failed') parts.push('Some images were not saved.');
  return parts.join(' · ');
}

/** What one try of a starter deck did (onboarding's list), kept on its row until its save commits. */
export interface StarterTry {
  kind: StarterKind;
  cardsAdded: number;
  markedKnown: number;
  images: StarterImages;
  /** The decks that hold the cards now: the starter deck, or the decks of 'elsewhere'. */
  deckIds: Id[];
  elsewhereDecks: StarterElsewhereDeck[];
}

/** One starter deck in onboarding's progress list ("Start with German"). */
export interface StarterRunRow {
  starter: StarterDeck;
  status: 'waiting' | 'adding' | 'added' | 'failed';
  /** The line under the title: starterOutcomeLine, or the error. '' while waiting or adding. */
  line: string;
  /** The decks that hold the cards now (the starter deck, or the decks of 'elsewhere'). */
  deckIds: Id[];
  /** Cards marked Known by "Where do you start?". */
  markedKnown: number;
  /**
   * A try that IS applied in memory, but whose save did not commit. The next
   * try finds the deck and changes nothing, so it only saves: then the line
   * and the counts come from THIS try (what really happened to the deck).
   * null = nothing waits for a save.
   */
  unsaved: StarterTry | null;
}

/** A row that waits for its first try. `unsaved` = an earlier run's try that is not saved yet. */
export function starterRunRow(starter: StarterDeck, unsaved: StarterTry | null = null): StarterRunRow {
  return { starter, status: 'waiting', line: '', deckIds: [], markedKnown: 0, unsaved };
}

/** The try of one outcome. */
function tryOf(outcome: Pick<StarterDeckOutcome, 'kind' | 'result' | 'deckId' | 'images' | 'elsewhereDecks'>): StarterTry {
  return {
    kind: outcome.kind,
    cardsAdded: outcome.result?.cardsAdded ?? 0,
    markedKnown: outcome.result?.markedKnown ?? 0,
    images: outcome.images,
    deckIds: outcome.deckId !== null ? [outcome.deckId] : outcome.elsewhereDecks.map((d) => d.deckId),
    elsewhereDecks: outcome.elsewhereDecks,
  };
}

/**
 * Two tries of one deck: `kept` was applied but not saved; `next` saves it
 * (and normally applies nothing more). The kind of `kept` wins ('add' stays
 * 'add'), the counts add up, and the images are the ones of `next` (images
 * are written only after a save that committed).
 */
function mergeTries(kept: StarterTry, next: StarterTry): StarterTry {
  return {
    kind: kept.kind === 'upToDate' ? next.kind : kept.kind,
    cardsAdded: kept.cardsAdded + next.cardsAdded,
    markedKnown: kept.markedKnown + next.markedKnown,
    images: next.images,
    deckIds: next.deckIds.length > 0 ? next.deckIds : kept.deckIds,
    elsewhereDecks: next.elsewhereDecks.length > 0 ? next.elsewhereDecks : kept.elsewhereDecks,
  };
}

/**
 * The row after one try that did not throw. PURE.
 * `saved` = the save of this try: `outcome.saved`, or the save the screen
 * ran itself because the row was `unsaved` and this try saved nothing; null =
 * nothing needed a save.
 *   - the save did not commit → 'failed' with the save warning; the work of
 *     this try (and of the kept one) stays in `unsaved` for the next try;
 *   - else → 'added', with the line and counts of the kept try and this one.
 *
 *   first try:  add, 13,690 cards, save fails → failed, "Your cards were added, but saving failed. …"
 *   "Try again": upToDate, the save works     → added, "13,690 cards added · 1,101 cards marked Known"
 */
export function starterRunRowAfter(
  row: StarterRunRow,
  outcome: Pick<StarterDeckOutcome, 'kind' | 'result' | 'deckId' | 'images' | 'elsewhereDecks'>,
  saved: FlushResult | null,
): StarterRunRow {
  const now = tryOf(outcome);
  const merged = row.unsaved ? mergeTries(row.unsaved, now) : now;
  if (saved !== null && !saved.ok) {
    return { ...row, status: 'failed', line: saveWarning(saved), deckIds: merged.deckIds, markedKnown: 0, unsaved: merged };
  }
  const line = starterOutcomeLine({
    kind: merged.kind,
    result: { cardsAdded: merged.cardsAdded, markedKnown: merged.markedKnown },
    images: merged.images,
    elsewhereDecks: merged.elsewhereDecks,
  });
  return { ...row, status: 'added', line, deckIds: merged.deckIds, markedKnown: merged.markedKnown, unsaved: null };
}

/**
 * A row whose kept try (`unsaved`) is on the disk now: 'added', with the
 * line and counts of that try. Any other row comes back as it is. PURE.
 */
export function starterRunRowSaved(row: StarterRunRow): StarterRunRow {
  if (row.status === 'added' || row.unsaved === null) return row;
  const t = row.unsaved;
  const line = starterOutcomeLine({
    kind: t.kind,
    result: { cardsAdded: t.cardsAdded, markedKnown: t.markedKnown },
    images: t.images,
    elsewhereDecks: t.elsewhereDecks,
  });
  return { ...row, status: 'added', line, deckIds: t.deckIds, markedKnown: t.markedKnown, unsaved: null };
}

/**
 * Every row again, after ONE save of the run (wave 5b R4). A save writes the
 * WHOLE library: the engine saves the difference from the last state that
 * reached the disk, so a save that commits also writes the decks whose own
 * save failed before. So when `saved` committed, every row that waited for a
 * save (`unsaved`) is saved now: it becomes 'added'. Before, such a row kept
 * "not saved yet" although a later deck's save had already written it.
 * A save that failed, or no save (null), changes nothing. PURE.
 *
 *   [verbs: failed + unsaved try] after vocabulary's save { ok: true } → [verbs: added]
 */
export function starterRunRowsAfterSave(
  rows: readonly StarterRunRow[],
  saved: FlushResult | null,
): StarterRunRow[] {
  if (saved === null || !saved.ok) return [...rows];
  return rows.map(starterRunRowSaved);
}

/**
 * Onboarding's rows after ONE try of row `i` (wave 5b R4): that row says
 * what the try did (`starterRunRowAfter`), and then, because a save writes
 * the whole library, every row is checked again (`starterRunRowsAfterSave`).
 * `saved` is the try's save (null = nothing was saved). PURE.
 *
 *   [verbs: not saved yet, grammar: adding] + grammar's try saved { ok: true }
 *     → [verbs: added, grammar: added]
 */
export function starterRunRowsAfterTry(
  rows: readonly StarterRunRow[],
  i: number,
  outcome: Pick<StarterDeckOutcome, 'kind' | 'result' | 'deckId' | 'images' | 'elsewhereDecks'>,
  saved: FlushResult | null,
): StarterRunRow[] {
  const next = [...rows];
  next[i] = starterRunRowAfter(rows[i], outcome, saved);
  return starterRunRowsAfterSave(next, saved);
}

/** The lines of a row whose try THREW (onboarding's list, `starterRunRowThrew`). */
export const STARTER_RUN_LINE = {
  /** The deck is not in the library. */
  failed: 'Could not be added.',
  /** The deck IS in the library (an earlier try), only its save did not commit. */
  unsaved: 'Added, but not saved yet.',
} as const;

/**
 * The row after a try that THREW (for example the bundled file could not be
 * loaded), from the row as it was BEFORE that try. Nothing of the try was
 * applied. PURE.
 *   - nothing kept → 'failed', "Could not be added.": the deck is not in the
 *     library (starterRunCounts counts it as missing);
 *   - a kept try (`unsaved`) → 'failed', and the line still says what is
 *     true: the deck IS in the library, only not saved. That is the save
 *     warning the row had, or "Added, but not saved yet." in a new run (after
 *     another level the row starts with an empty line). Never "Could not be
 *     added.": starterRunCounts counts this row as "not saved yet", and the
 *     screen title says so too (W5-1 review round 2).
 */
export function starterRunRowThrew(before: StarterRunRow): StarterRunRow {
  if (before.unsaved === null) return { ...before, status: 'failed', line: STARTER_RUN_LINE.failed };
  return { ...before, status: 'failed', line: before.line !== '' ? before.line : STARTER_RUN_LINE.unsaved };
}

/** What the rows of a run add up to (onboarding's summary and its "Continue"). */
export interface StarterRunCounts {
  /** Rows that are added and saved. */
  added: number;
  /** Rows that are in the library (in memory), but not saved yet. */
  unsaved: number;
  /** Rows that are NOT in the library (a try threw, or never ran). */
  missing: number;
  /** Cards marked Known, in the added and the unsaved rows. */
  markedKnown: number;
  /** The decks that hold the cards of the added and the unsaved rows. */
  deckIds: Id[];
}

/** The counts of a run (see StarterRunCounts). PURE. */
export function starterRunCounts(rows: readonly StarterRunRow[]): StarterRunCounts {
  let added = 0;
  let unsaved = 0;
  let markedKnown = 0;
  const deckIds = new Set<Id>();
  for (const row of rows) {
    if (row.status === 'added') {
      added += 1;
      markedKnown += row.markedKnown;
      for (const id of row.deckIds) deckIds.add(id);
    } else if (row.unsaved !== null) {
      unsaved += 1;
      markedKnown += row.unsaved.markedKnown;
      for (const id of row.unsaved.deckIds) deckIds.add(id);
    }
  }
  return { added, unsaved, missing: rows.length - added - unsaved, markedKnown, deckIds: [...deckIds] };
}

/**
 * The snackbar after onboarding added the starter decks:
 *   starterRunSummary(3, 0, 1101)    → 'Added 3 starter decks. 1,101 cards marked Known (easier levels).'
 *   starterRunSummary(2, 1, 0)       → "Added 2 starter decks. 1 starter deck could not be added. Try again from Today's + button."
 *   starterRunSummary(2, 0, 0, 1)    → 'Added 2 starter decks. 1 starter deck added but not saved yet.'
 * `unsaved` = decks that ARE in the library, but whose save did not commit.
 */
export function starterRunSummary(added: number, failed: number, markedKnown: number, unsaved = 0): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`Added ${plural(added, 'starter deck')}.`);
  if (unsaved > 0) parts.push(`${plural(unsaved, 'starter deck')} added but not saved yet.`);
  if (markedKnown > 0) parts.push(`${plural(markedKnown, 'card')} marked Known (easier levels).`);
  if (failed > 0) parts.push(`${plural(failed, 'starter deck')} could not be added. Try again from Today's + button.`);
  return parts.join(' ');
}

/* ------------------------------------------------------------------ deps */

/**
 * Write the image files of a starter deck (after its save committed): the
 * media writer of the import (src/platform/media.ts). A file that could not
 * be written makes the step fail, so the caller can offer "Try again".
 */
async function writeStarterMedia(...args: Parameters<StarterDeps['writeMedia']>): Promise<void> {
  const report = writeImportMedia(...args);
  if (report.failed.length > 0) throw new Error(`${report.failed.length} images could not be written`);
}

/** The time of an "Add" (event handlers only: it reads the clock). */
function clockNow(): number {
  return Date.now();
}

/**
 * The store functions `addStarterDeck` needs: the engine's state, actions and
 * save, and the import's image writer. Onboarding uses the same ones.
 */
export function starterDepsFor(engine: Engine): StarterDeps {
  return {
    getState: () => engine.store.getState(),
    applyImport: (plan) => engine.actions.applyImport(plan),
    flush: () => engine.actions.flush(),
    writeMedia: writeStarterMedia,
    now: clockNow,
  };
}

/* ------------------------------------------------------------------ the sheet */

/** The name of the deck "New card" goes into (fieldText.ts lastUsedDeckId), or null without decks. */
function lastDeckOf(s: DataStateV3): { id: string; name: string } | null {
  const id = lastUsedDeckId(s);
  const deck = id ? s.decks.find((d) => d.id === id) : undefined;
  return deck ? { id: deck.id, name: deck.name } : null;
}
const noDeck = () => null;

/** A new Library `nonce` (event handlers only: it reads the clock; render uses useNow()). */
function freshNonce(): string {
  return String(Date.now());
}

const decksOf = (s: DataStateV3) => s.decks;

/**
 * A selector of the installed versions as ONE string ("vocabulary=1;grammar=;verbs=1"),
 * so the sheet renders again only when a version really changes (a rating
 * changes `cards`, but never a version).
 */
function installedVersionsKeyOf(pack: ContentPack): (s: DataStateV3) => string {
  if (pack.starterDecks.length === 0) return () => '';
  return memoOnInputs(
    ({ decks, notes, cards }: DataStateV3) => [decks, notes, cards],
    (s) =>
      [...installedStarterVersions(pack, s)].map(([key, version]) => `${key}=${version ?? ''}`).join(';'),
  );
}
/** The selector while the sheet is closed: no versions (it reads every note, so it runs only while open). */
const noVersionsKey = () => '';

/** The string of installedVersionsKeyOf back as a map. */
function parseVersionsKey(text: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const part of text === '' ? [] : text.split(';')) {
    const at = part.lastIndexOf('=');
    const value = part.slice(at + 1);
    out.set(part.slice(0, at), value === '' ? null : Number(value));
  }
  return out;
}

export function AddSheet({
  open,
  onClose,
  pack = activePack,
}: {
  open: boolean;
  onClose: () => void;
  /** The content pack (default: this build's). Tests pass one with starter decks. */
  pack?: ContentPack;
}) {
  const c = useColors();
  const router = useRouter();
  const engine = useEngine();
  const { show } = useSnackbar();
  // The last used deck is looked up only while the sheet is open (it reads every note).
  const lastDeck = useStateV3(open ? lastDeckOf : noDeck);
  const decks = useStateV3(decksOf);
  // The same for the installed versions: they read every note of the starter decks,
  // and `cards` changes on every rating, so they are read only while the sheet is open.
  const versionsSel = useMemo(() => installedVersionsKeyOf(pack), [pack]);
  const versionsKey = useStateV3(open ? versionsSel : noVersionsKey);
  const versions = parseVersionsKey(versionsKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [guard] = useState(() => starterTaskGuard(setBusy));
  // deck id → the bundled version an add found that deck up to date with (kept on this device).
  const [memory] = useState(() =>
    checkedVersions(pack.starterDecks.length > 0 ? readCheckedVersions() : new Map(), (text) => {
      void saveCheckedVersions(text);
    }),
  );
  const [checked, setChecked] = useState<ReadonlyMap<Id, number>>(() => memory.get());

  const rows = addSheetRows(lastDeck?.name ?? null);
  const starters = starterDeckRows(pack, decks);

  const go = (row: AddRow) => {
    onClose();
    switch (row.key) {
      case 'card':
        router.push({ pathname: '/card-editor', params: lastDeck ? { deckId: lastDeck.id } : {} });
        return;
      case 'deck':
        router.push('/deck-editor');
        return;
      case 'import':
        router.push({ pathname: '/import', params: { source: 'file' } });
        return;
      case 'ankiweb':
        router.push({ pathname: '/import', params: { source: 'ankiweb' } });
        return;
      case 'list':
        // Library route (unit W4-2): an empty query, a new nonce and `newList=1`. Library
        // shows the banner for it (newListBannerFor; the contract is at todayLogic NEW_LIST_PARAM).
        router.navigate(libraryRoute({}, freshNonce(), NEW_LIST_PARAM) as unknown as Href);
        return;
    }
  };

  /** Run one starter task, or say which deck is still being added. */
  const whenFree = (key: string, task: () => Promise<void>) => {
    void guard.run(key, task).then((ran) => {
      if (ran) return;
      const runningKey = guard.running();
      const title = pack.starterDecks.find((s) => s.key === runningKey)?.title ?? 'a starter deck';
      show(STARTER_AGAIN_COPY.busy(title));
    });
  };

  const retryImages = (starter: StarterDeck) =>
    whenFree(starter.key, async () => {
      try {
        const out = await writeStarterImages(pack, starter.key, starterDepsFor(engine));
        show(out.images === 'written' || out.images === 'none' ? 'Images saved.' : 'The images were not saved. Try again later.');
      } catch {
        show('The images were not saved. Try again later.');
      }
    });

  /** "Choose what to learn" over `q` (the sheet closes first). */
  const openTriage = (q: Query) => {
    onClose();
    // '/triage?q=' carries a query, so typed routes need the cast.
    router.push(triageRoute(q) as Href);
  };

  const add = (starter: StarterDeck, opts?: StarterPlanOptions) =>
    whenFree(starter.key, async () => {
      try {
        // D3 for a NEW deck, with ONE read and ONE plan of the file (see the top of the file).
        const deps = starterDepsFor(engine);
        const run = await addStarterOnce(pack, starter.key, deps, opts);
        // An add that changed nothing saved nothing: save now, because an earlier add may still
        // be only in memory (withSettledSave). Its answer decides the confirm and the message.
        const outcome = await withSettledSave(run.outcome, deps.flush);
        if (confirmsBundledVersion(outcome) && outcome.deckId !== null) {
          const liveIds = engine.store.getState().decks.map((d) => d.id);
          setChecked(memory.confirm(outcome.deckId, starter.version, liveIds));
        }
        // The change is only in memory: say so, not "Added" or "Already up to date.".
        if (!outcome.saved.ok) {
          show(saveWarning(outcome.saved));
          return;
        }
        const msg = starterMessage(outcome);
        const retry = msg.retry;
        if (retry) {
          show(msg.text, {
            label: retry.label,
            // A snackbar button: it goes through the guard like a row does.
            onAction: () => (retry.kind === 'copy' ? add(starter, { elsewhere: 'copy' }) : retryImages(starter)),
          });
          return;
        }
        // New cards that start Not started: the next step is "Choose what to learn".
        const q = starterChooseQuery(outcome, run.arrival);
        const state = engine.store.getState();
        if (q && scopePool(state, q, matchCtxOf(state, clockNow()), 'browse').length > 0) {
          show(`${msg.text} ${STARTER_CHOOSE_COPY.notStarted}`, {
            label: STARTER_CHOOSE_COPY.choose,
            onAction: () => openTriage(q),
          });
          return;
        }
        show(msg.text);
      } catch {
        show(`${starter.title} could not be added. Try again.`);
      }
    });

  /** "Add" on a row that may already be in the library: ask first ("Add anyway" goes through the guard). */
  const askFirst = (starter: StarterDeck, names: string) =>
    show(STARTER_LOOKALIKE_COPY.ask(names), { label: STARTER_LOOKALIKE_COPY.addAnyway, onAction: () => add(starter) });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={ADD_SHEET_TITLE}
      overlay={starters.length > 0 && open ? <AddSheetSnack /> : null}
    >
      {rows.map((row, i) => (
        <ListRow
          key={row.key}
          icon={row.icon}
          iconColor={row.key === 'import' || row.key === 'ankiweb' ? c.info : undefined}
          iconBg={row.key === 'import' || row.key === 'ankiweb' ? c.infoTint : undefined}
          title={row.title}
          sub={row.sub}
          onPress={() => go(row)}
          last={i === rows.length - 1 && starters.length === 0}
        />
      ))}

      {starters.length > 0 && (
        <View style={{ marginTop: 14 }}>
          <Overline header style={{ marginBottom: 4 }}>
            {TODAY_COPY.starterDecks}
          </Overline>
          {starters.map((row, i) => {
            const { starter, deckId } = row;
            const last = i === starters.length - 1;
            const running = busy === starter.key;
            const action = starterRowAction(row, versions.get(starter.key) ?? null, deckId ? checked.get(deckId) : undefined);
            if (action === 'add' || deckId === null) {
              const names = starterLookalikes(starter, decks)
                .map((d) => d.name)
                .join(', ');
              const addButton = (
                <Btn
                  size="sm"
                  kind="secondary"
                  disabled={busy !== null}
                  label={`${STARTER_COPY.add} ${starter.title}`}
                  onPress={() => (names !== '' ? askFirst(starter, names) : add(starter))}
                >
                  {running ? STARTER_COPY.adding : STARTER_COPY.add}
                </Btn>
              );
              const addRow = (
                <ListRow
                  key={starter.key}
                  icon="leaf-outline"
                  iconColor={c.pine}
                  iconBg={c.pineTint}
                  title={starter.title}
                  sub={starter.subtitle}
                  right={addButton}
                  last={last || names !== ''}
                />
              );
              if (names === '') return addRow;
              return (
                <View
                  key={starter.key}
                  style={{ borderBottomWidth: last ? 0 : 1, borderBottomColor: c.hairlineSoft, paddingBottom: 12 }}
                >
                  {addRow}
                  {/* 46 = the row's icon (34) + its gap (12): the line starts under the title. */}
                  <Text style={[font('sans', 400), { paddingLeft: 46, fontSize: 12.5, lineHeight: 17, color: c.ink2 }]}>
                    {STARTER_LOOKALIKE_COPY.note(names)}
                  </Text>
                </View>
              );
            }
            const update = action === 'update';
            return (
              <View
                key={starter.key}
                style={{ borderBottomWidth: last ? 0 : 1, borderBottomColor: c.hairlineSoft, paddingBottom: 12 }}
              >
                <ListRow
                  icon="leaf-outline"
                  iconColor={c.pine}
                  iconBg={c.pineTint}
                  title={starter.title}
                  sub={starter.subtitle}
                  right={<Text style={[font('sans', 700), { fontSize: 13, color: c.success }]}>{STARTER_COPY.added}</Text>}
                  hint="Opens the deck page"
                  onPress={() => {
                    onClose();
                    // Deck page route (unit W4-3).
                    router.push(deckRoute(deckId) as Href);
                  }}
                  last
                />
                {/* 46 = the row's icon (34) + its gap (12): the button starts under the title. */}
                <View style={{ paddingLeft: 46 }}>
                  <Btn
                    size="sm"
                    kind={update ? 'primary' : 'quiet'}
                    disabled={busy !== null}
                    label={update ? STARTER_AGAIN_COPY.update(starter.title) : STARTER_AGAIN_COPY.againLabel(starter.title)}
                    onPress={() => add(starter)}
                  >
                    {running
                      ? update
                        ? STARTER_AGAIN_COPY.updating
                        : STARTER_COPY.adding
                      : update
                        ? STARTER_AGAIN_COPY.update(starter.title)
                        : STARTER_AGAIN_COPY.again}
                  </Btn>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}

/**
 * The app's snackbar, drawn on the sheet's panel (Sheet `overlay`), so the
 * result of a starter deck "Add" is seen while the sheet is open. A message
 * that was already there when the sheet opened is not about this sheet: it
 * is not shown here.
 */
function AddSheetSnack() {
  const { snack, dismiss } = useSnackbar();
  const [before] = useState(snack);
  if (!snack || snack === before) return null;
  return (
    <SnackbarView
      text={snack.text}
      actionLabel={snack.actionLabel}
      onAction={
        snack.onAction
          ? () => {
              snack.onAction?.();
              dismiss();
            }
          : undefined
      }
      bottom={0}
    />
  );
}
