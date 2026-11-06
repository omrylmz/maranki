/**
 * The import wizard (spec §5.9, unit W3-5): one screen, three sources, and a
 * LOSSLESS import with an honest preview.
 *
 *   source ─► (sections) ─► (fields) ─► preview ─► importing ─► done
 *
 *   - source:   AnkiWeb · From a file · Backup (components/import/SourceStage).
 *               A file or an AnkiWeb download is read into an AnkiCollection
 *               (import/apkgRead.ts `readApkg`, import/csvRead.ts `readCsv`):
 *               every field, card, template, subdeck, guid, progress and image.
 *   - sections: only when the file has more than one subdeck — for a file AND
 *               for AnkiWeb (SectionsStage).
 *   - fields:   one card per source card type: Front, Back, examples, back
 *               rows, filters, directions, read-aloud languages, a sample
 *               (FieldsStage). The guess is roles.ts `suggestMapping`. When
 *               the guess is certain (Front/Back by name, nothing else), the
 *               stage collapses into one line on the Preview.
 *   - preview:  the planner (import/plan.ts `planImport`) makes the plan;
 *               every line is from `plan.summary` (PreviewStage).
 *   - importing: "Reading the file", "Planning", "Saving {n} cards"
 *               (`actions.applyImport(plan)` — one reducer step — then
 *               `await actions.flush()`), "Copying images" (written only
 *               AFTER the save committed, spec §5.8: platform/media.ts
 *               `writeAfterSave`). "Cancel" works until the save starts.
 *   - done:     from the ImportResult (DoneStage). When the save failed, the
 *               images wait: "Copy images" saves again and then writes them.
 *
 * Route params (spec §2.2): `/import?source=ankiweb|file|backup&deckId=` —
 * the first tab, and the deck to import into.
 *
 * Long steps run from event handlers (a short timer lets the progress view
 * draw first), never during render. Every long step has a run number: Cancel
 * and leaving the screen bump it, so a late result is dropped and nothing is
 * written.
 *
 * Wave-4 fixes (unit W4-3, from the wave-3 emulator run):
 *   - The file name: on Android the picker's `File.name` is a document id
 *     ("msf:96"). importApkg.ts `pickedFileName` reads the real name from the
 *     URI when it can. Then the deck's `sourceKey` is 'file:<name>' and the
 *     deck page says "Imported from <name>". Without a real name, the file
 *     gets a MADE-UP name (`fallbackFileName`: the .apkg's root deck,
 *     "German.apkg", or "Imported deck.csv") and the key adds a hash of the
 *     content (`namelessSourceKey`: 'file:German.apkg#1x2b9k'), so the same
 *     file finds its deck again. For such a key the deck page's header says
 *     only "Imported", not the made-up name (wave 5b L15). The items carry
 *     the key without 'file:' as their ref ('German.apkg#1x2b9k'), so the
 *     header never names the made-up file either (wave 5g).
 *   - A re-import starts on "Existing deck: <the deck that holds these
 *     items>" (by Anki guid, importApkg.ts `guidHomeDeck`), so every item is
 *     an update, never a second deck with the same name. Wave 5: only when
 *     that deck holds at least half of the chosen items
 *     (deckPageLogic.ts `reimportHomeDeck`) — a different file that shares 5
 *     of its 2,000 items does not start on that deck. Wave 5g: a CSV has no
 *     guids. A CSV that finds no deck by its key starts on the deck where at
 *     least half of its rows are already here (§5.6 rule 4,
 *     deckPageLogic.ts `csvHomeDeck`), not on "New deck: Imported deck" —
 *     only when the file's name was lost on one of the two picks
 *     (`maybeSameFile`: week2.csv never starts on the deck of week1.csv).
 *     Wave 5h: only a deck that came from a file (an .apkg or a CSV) can be
 *     that home; a deck made in the app, a starter pack or an AnkiWeb
 *     download never is.
 *     The whole start is one pure step: deckPageLogic.ts `importStartPlan`.
 *   - Every stage starts scrolled to the top; "Cancel" on the progress view
 *     is centred.
 *   - Android's back goes ONE stage back (preview → fields → sections →
 *     source; Cancel while it is offered) and closes Import only from the
 *     source stage (components/import/importBack.ts). Before, it closed the
 *     screen from any stage and the choices (and an AnkiWeb download) were
 *     lost.
 *   - A new deck gets its front and back languages from the card types'
 *     {{tts}} languages when they agree (importApkg.ts `agreedLanguages`).
 *   - "Open deck" opens the deck page; "Study {k} now" opens a Study session
 *     over the deck (`kind=scheduled&q={"decks":[id]}`), and {k} is
 *     readyFor({ decks: [id] }).total — the session it opens.
 *   - Opened from the deck page of the deck the cards went into
 *     (deckPageLogic.ts `importFromDeckPage`): that page is right below, so
 *     "Open deck" goes back to it, and "Choose what to learn" passes
 *     `from=deck` (its "Back to deck" goes back too). Never a second copy of
 *     the same deck page on the stack.
 *
 * Notes:
 *   - `useImportStore` is the one bridge to the v3 store types (see there).
 *   - Images: `writeImportImages` + importApkg.ts `expoMediaDisk` write the
 *     files; platform/media.ts `writeAfterSave` decides WHEN (only after a
 *     save that committed, so no image folder is left without a saved deck).
 *   - A CSV read again ("First row is a header", "Tags", "Not tags") keeps
 *     the column choices of every field that is read from the same file
 *     column (components/import/csvReread.ts `carryFieldChoices`).
 */
import { File } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, ScrollView, Text, View } from 'react-native';

import { useRestoreFlow } from '@/components/data/RestoreFlow';
import {
  chosenCountOf,
  chosenGuidsOf,
  importFromDeckPage,
  importStartPlan,
  reimportHomeDeck,
} from '@/components/deck/deckPageLogic';
import { DoneStage } from '@/components/import/DoneStage';
import { carryFieldChoices } from '@/components/import/csvReread';
import { FieldsStage, type CsvControls, type TypeEdit } from '@/components/import/FieldsStage';
import { importBackAction } from '@/components/import/importBack';
import { PreviewStage, TRIAGE_READY } from '@/components/import/PreviewStage';
import { SectionsStage } from '@/components/import/SectionsStage';
import { SourceStage, type AnkiWebPick, type SourceTab } from '@/components/import/SourceStage';
import { Btn, SnackbarHost, StackBar } from '@/components/ui';
import { AnkiWebError, downloadSharedDeck } from '@/domain/ankiweb';
import { readApkg } from '@/domain/import/apkgRead';
import { readCsv, type CsvReadOptions } from '@/domain/import/csvRead';
import {
  chosenNotesByMid,
  collectionSections,
  planImport,
  startingTypes,
  suggestDeckName,
  type CollectionSection,
} from '@/domain/import/plan';
import {
  agreedLanguages,
  ApkgError,
  apkgErrorMessage,
  expoMediaDisk,
  fallbackFileName,
  guidHomeDeck,
  missingDeckLanguages,
  namelessSourceKey,
  pickedFileName,
  withDeckLanguages,
} from '@/domain/importApkg';
import {
  choiceTypes,
  defaultTarget,
  detectImportKind,
  doneCopy,
  fieldsLine,
  filterCandidates,
  imagesWarning,
  importImagesHere,
  importMediaNamer,
  importOrigin,
  importPlanCtx,
  prefsNeedReplan,
  prefsTarget,
  saveWarning,
  sniffFileBytes,
  startingPrefs,
  writeImportImages,
  type DoneCopy,
  type ImportPrefs,
  type ImportSource,
} from '@/domain/importFile';
import { DEFAULT_DECK_ICON } from '@/domain/makeV3';
import type {
  AnkiCollection,
  DataStateV3,
  FieldDef,
  Id,
  ImportChoices,
  ImportMediaFolder,
  ImportPlan,
  ImportResult,
} from '@/domain/model';
import { serializeQuery } from '@/domain/query';
import { suggestMapping } from '@/domain/roles';
import { plural } from '@/domain/text';
import { writeAfterSave } from '@/platform/media';
import type { Actions } from '@/store/actions';
import { useData } from '@/store/DataContext';
import { readyReader, useStateV3 } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { useNow } from '@/store/useNow';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';
import { activePack } from '@/variants';

type Stage = 'source' | 'sections' | 'fields' | 'preview' | 'importing' | 'done';
type Phase = 'download' | 'read' | 'plan' | 'save' | 'images';

/** A file (or AnkiWeb deck) that was read, with everything the stages need. */
interface Loaded {
  collection: AnkiCollection;
  source: ImportSource;
  origin: ReturnType<typeof importOrigin>;
  /** A CSV's text and how it was read (read again for "First row is a header" / "Tags"). */
  csv: { text: string; opts: CsvReadOptions } | null;
  sections: CollectionSection[];
}

/** What the Done stage shows. */
interface DoneInfo {
  copy: DoneCopy;
  warnings: string[];
  deckId: Id | null;
  deckName: string;
}

/**
 * The images of an import whose save did not commit (yet). They are NOT on
 * the disk: "Copy images" on the Done stage saves again and then writes them
 * (only while this screen is open: the bytes are in the opened file).
 */
interface PendingImages {
  media: ImportMediaFolder[];
  bytesOf: AnkiCollection['mediaBytes'];
}

/** How many image files the folders of an import hold. */
function imageCount(media: readonly ImportMediaFolder[]): number {
  return media.reduce((sum, f) => sum + f.files.length, 0);
}

/** The Done line when the images were not written, because the save did not commit. */
function imagesNotCopied(count: number): string {
  return `${plural(count, 'image')} not copied, because saving failed.`;
}

/** "Open deck": the deck page (spec §5.9 Done). */
function openDeckRoute(deckId: Id) {
  return { pathname: '/deck/[id]' as const, params: { id: deckId } };
}

/**
 * "Choose what to learn": the triage screen over this deck's Not started
 * cards (spec §5.9). `fromDeck`: the deck page is right below (the import was
 * opened from it), so `from=deck` makes triage's "Back to deck" go back.
 */
function triageRoute(deckId: Id, fromDeck: boolean) {
  const params: { q: string; from?: string } = { q: serializeQuery({ decks: [deckId], life: ['notStarted'] }) };
  if (fromDeck) params.from = 'deck';
  return { pathname: '/triage' as const, params };
}

/**
 * "Study {k} now": a Study session over the new deck (spec §2.2
 * `/session?kind=scheduled&q=`). {k} is the deck's readyFor total, so the
 * number on the button is the session it opens.
 */
function studyRoute(deckId: Id, label: string) {
  return { pathname: '/session' as const, params: { kind: 'scheduled', q: serializeQuery({ decks: [deckId] }), label } };
}

/** The "Study {k} now" count before the import is done. */
const noStudy = (): number => 0;

/** A fresh id seed for a plan that will be applied (event handlers only: it reads the clock). */
function freshSeed(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * The store as the import sees it: the v3 state and the two v3 actions it
 * calls (spec §3.6). The typed names below let tsc check that the store
 * really gives them (useData().state is the v3 state since W3-1, and the
 * engine implements `applyImport` since W3-2).
 */
function useImportStore() {
  const { state, actions } = useData();
  const library: DataStateV3 = state;
  const importActions: Pick<Actions, 'applyImport' | 'flush' | 'updateDeck'> = actions;
  return { state, library, importActions };
}

/** The first tab from the route param (AnkiWeb by default). */
function initialTab(source: string | undefined): SourceTab {
  return source === 'file' || source === 'backup' ? source : 'ankiweb';
}

/** The edits of the card types that have notes in the chosen sections. */
function visibleEdits(collection: AnkiCollection, edits: readonly TypeEdit[], sections: ReadonlySet<string>): TypeEdit[] {
  const byMid = chosenNotesByMid(collection, sections);
  return edits.filter((e) => byMid.has(e.mid));
}

export default function ImportScreen() {
  const c = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; deckId?: string }>();
  const { library, importActions } = useImportStore();
  const { show } = useSnackbar();
  const now = useNow();

  const [tab, setTab] = useState<SourceTab>(() => initialTab(params.source));
  const [stage, setStage] = useState<Stage>('source');
  const [phase, setPhase] = useState<Phase>('read');
  const [downloadName, setDownloadName] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [edits, setEdits] = useState<TypeEdit[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [prefs, setPrefs] = useState<ImportPrefs | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImages | null>(null);
  const [copyingImages, setCopyingImages] = useState(false);
  // The Backup tab: restore a Maranki backup, then close this screen.
  const restore = useRestoreFlow({ onRestored: () => router.back() });

  // "Study {k} now": k = readyFor({ decks: [id] }).total of the imported deck,
  // the length of the session the button opens (spec §4.6). Counted only on
  // the Done stage.
  const doneDeckId = done?.deckId ?? null;
  const studySel = useMemo(() => {
    if (doneDeckId === null) return noStudy;
    const ready = readyReader(serializeQuery({ decks: [doneDeckId] }), now);
    return (s: DataStateV3) => ready(s).total;
  }, [doneDeckId, now]);
  const studyCount = useStateV3(studySel);

  // "Images: 57 — already here" on the Preview (wave 5i): the planned pictures that the deck
  // folders hold already, byte for byte (importFile.ts importImagesHere). One counter per read
  // file; it keeps its answers, so a new plan after a choice reads nothing twice.
  const imagesHereOf = useMemo(
    () => (loaded?.collection.mediaBytes ? importImagesHere(loaded.collection.mediaBytes, expoMediaDisk()) : null),
    [loaded],
  );
  const imagesHere = useMemo(
    () => (stage === 'preview' && plan && imagesHereOf ? imagesHereOf(plan.media) : 0),
    [stage, plan, imagesHereOf],
  );

  // Every stage starts at the top (the Fields stage opened in the middle of the page).
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [stage]);

  // Every long step gets a run number; Cancel and unmount bump it.
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  /* ------------------------------------------------------------- reading */

  /**
   * The edits a collection starts with (roles.ts guess; a library card type's
   * own roles when reused). `before` = the same file read before and its
   * edits (a CSV read again): their choices are kept for every field that is
   * read from the same file column (carryFieldChoices keeps the order, so
   * `draft.types[k]` still fits).
   */
  const startEdits = (
    collection: AnkiCollection,
    before?: { collection: AnkiCollection; edits: readonly TypeEdit[] },
  ): TypeEdit[] => {
    // The build's card-type presets win for every matching card type (spec §5.3 rule 1, §9.4).
    const draft = suggestMapping(collection, activePack.cardTypePresets);
    const fresh = startingTypes(collection, draft, library.noteTypes);
    const starts = before
      ? carryFieldChoices({ collection: before.collection, types: before.edits }, { collection, types: fresh })
      : fresh;
    return starts.map((start, k) => ({
      ...start,
      draft: draft.types[k],
      candidates: filterCandidates(collection, start.mid, start.fields),
    }));
  };

  /**
   * A file or download was read: on to Sections (more than one subdeck), else
   * Fields or Preview. `sourceKey` replaces the usual 'file:<name>' key (an
   * .apkg or text file the picker gave no name for, importApkg.ts
   * `namelessSourceKey`: the made-up name plus a hash of the content). The
   * items then carry that key as their ref ('German.apkg#1x2b9k', never the
   * made-up 'German.apkg' alone): the deck page never shows it as a file
   * name (importFile.ts `importOrigin`, wave 5g).
   */
  const begin = (collection: AnkiCollection, source: ImportSource, csv: Loaded['csv'], sourceKey?: string) => {
    const next: Loaded = {
      collection,
      source,
      origin: importOrigin(source, sourceKey),
      csv,
      sections: collectionSections(collection),
    };
    const all = new Set(next.sections.map((s) => s.did));
    const nextEdits = startEdits(collection);
    setLoaded(next);
    setSelected(all);
    setEdits(nextEdits);
    setPrefs(null);
    setPlan(null);
    if (next.sections.length > 1) setStage('sections');
    else afterSections(next, all, nextEdits);
  };

  /** After Sections: skip Fields when the guess is certain (one line on the Preview instead). */
  const afterSections = (ld: Loaded, sel: Set<string>, eds: TypeEdit[]) => {
    const visible = visibleEdits(ld.collection, eds, sel);
    const certain = visible.length > 0 && visible.every((e) => e.draft.certain);
    setCollapsed(certain);
    if (certain) startPlanning(ld, sel, eds, null);
    else setStage('fields');
  };

  const onChooseFile = async () => {
    if (fileBusy) return; // a double tap
    setFileBusy(true);
    try {
      const picked = await File.pickFileAsync({
        // Broad on purpose: Android MIME types are unreliable, so anything is
        // accepted and checked AFTER the pick, by its bytes and its name.
        mimeTypes: ['text/*', 'text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', 'application/zip', '*/*'],
      });
      if (picked.canceled) return; // the picker was closed: write nothing, say nothing
      const file = picked.result;
      // The real name ("German.apkg"), or null when Android gave only a
      // document id ("msf:96"). It becomes the deck's sourceKey 'file:<name>'.
      const realName = pickedFileName(file);
      const sniffName = realName ?? file.name;
      // Read the bytes ONCE and decide by them (Android often gives no ".apkg" name).
      const bytes = await file.bytes();
      if (sniffFileBytes(bytes, sniffName) === 'apkg') {
        const run = ++runRef.current;
        setStage('importing');
        setPhase('read');
        try {
          const read = await readApkg(bytes, sniffName);
          if (run !== runRef.current || !mountedRef.current) return;
          // No real name: name the file after its root deck ("German.apkg",
          // not "msf:96"), and key it by its items (their guids), so the same
          // file finds its deck again and another file with the same root
          // deck name ("Default") does not.
          const fileName = realName ?? fallbackFileName('apkg', suggestDeckName(read));
          const collection = fileName === read.fileName ? read : { ...read, fileName };
          const sourceKey = realName
            ? undefined
            : namelessSourceKey(fileName, read.notes.slice(0, 500).map((n) => n.guid).join('\n'));
          begin(collection, { kind: 'file', fileName, isCsv: false }, null, sourceKey);
        } catch (err) {
          if (run !== runRef.current || !mountedRef.current) return;
          show(apkgErrorMessage(err));
          setStage('source');
        }
        return;
      }
      const text = await file.text();
      if (!text.trim()) {
        show('That file is empty — pick a .csv or .apkg.');
        return;
      }
      if (detectImportKind(sniffName, text.slice(0, 4096)) !== 'csv') {
        show('Could not recognise that file — export a .csv or .apkg.');
        return;
      }
      const fileName = realName ?? fallbackFileName('csv', '');
      const collection = readCsv(text, fileName);
      if (collection.notes.length === 0) {
        show('No cards found in that file.');
        return;
      }
      // Without a real name, the key tells this file from other nameless files.
      const sourceKey = realName ? undefined : namelessSourceKey(fileName, text);
      begin(collection, { kind: 'file', fileName, isCsv: true }, { text, opts: {} }, sourceKey);
    } catch {
      show('Could not read that file. Please try a different export.');
    } finally {
      if (mountedRef.current) setFileBusy(false);
    }
  };

  const onDownload = async (pick: AnkiWebPick) => {
    const run = ++runRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setDownloadName(pick.name);
    setStage('importing');
    setPhase('download');
    try {
      const bytes = await downloadSharedDeck(pick.id, ctrl.signal);
      if (run !== runRef.current || !mountedRef.current) return;
      setPhase('read');
      const collection = await readApkg(bytes, `${pick.name}.apkg`);
      if (run !== runRef.current || !mountedRef.current) return;
      begin(collection, { kind: 'ankiweb', id: pick.id }, null);
    } catch (err) {
      // Cancellation (an aborted download) is owned by the Cancel button: stay quiet.
      if (run !== runRef.current || ctrl.signal.aborted || !mountedRef.current) return;
      show(
        err instanceof ApkgError
          ? apkgErrorMessage(err)
          : err instanceof AnkiWebError
            ? err.message
            : 'Could not download that deck. Please try again.',
      );
      setStage('source');
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  /**
   * A CSV read again ("First row is a header", "Tags", "Not tags"). Stays on
   * the Fields stage, and keeps the learner's choices for the fields that are
   * still read from the same file column (choosing a Tags column must not
   * reset the others, also in a file without a header).
   */
  const rereadCsv = (opts: CsvReadOptions) => {
    if (!loaded?.csv || loaded.source.kind !== 'file') return;
    const collection = readCsv(loaded.csv.text, loaded.source.fileName, opts);
    const next: Loaded = { ...loaded, collection, csv: { text: loaded.csv.text, opts }, sections: collectionSections(collection) };
    const dids = new Set(next.sections.map((s) => s.did));
    const sel = new Set([...selected].filter((d) => dids.has(d)));
    setLoaded(next);
    setSelected(sel.size > 0 ? sel : dids);
    setEdits(startEdits(collection, { collection: loaded.collection, edits }));
  };

  /* ------------------------------------------------------------- planning */

  /** The choices of the current stages, for the planner. */
  const choicesOf = (ld: Loaded, sel: Set<string>, eds: readonly TypeEdit[], p: ImportPrefs): ImportChoices => ({
    sections: sel,
    target: prefsTarget(p),
    types: choiceTypes(ld.collection, eds),
    progress: p.progress,
    arrival: p.arrival,
    ...(p.placement ? { placement: p.placement } : {}),
    elsewhere: p.elsewhere,
    images: p.images,
    skipOverlap: p.skipOverlap,
  });

  /**
   * The image names of one read file in the deck folders (importFile.ts
   * `importMediaNamer`): a picture whose name a deck's folder already holds
   * with OTHER bytes gets its own name, so the cards already there keep their
   * picture. One per file (it remembers what it read); event handlers only.
   */
  const namersRef = useRef(new WeakMap<AnkiCollection, (deckId: Id, name: string) => string>());
  const mediaNamerOf = (collection: AnkiCollection) => {
    let namer = namersRef.current.get(collection);
    if (!namer) {
      namer = importMediaNamer(collection.mediaBytes, expoMediaDisk());
      namersRef.current.set(collection, namer);
    }
    return namer;
  };

  /** Plan an import (pure; called from event handlers and timers only). */
  const makePlan = (ld: Loaded, sel: Set<string>, eds: readonly TypeEdit[], p: ImportPrefs, seed: string): ImportPlan =>
    planImport(
      ld.collection,
      library,
      choicesOf(ld, sel, eds, p),
      importPlanCtx({
        now: Date.now(),
        seed,
        srs: library.settings.srs,
        origin: ld.origin,
        ...(ld.collection.mediaBytes ? { mediaName: mediaNamerOf(ld.collection) } : {}),
      }),
    );

  /** "Planning": the first plan of a file (or after Fields), then the Preview. */
  const startPlanning = (ld: Loaded, sel: Set<string>, eds: TypeEdit[], earlier: ImportPrefs | null) => {
    const run = ++runRef.current;
    setStage('importing');
    setPhase('plan');
    // A short timer lets the progress view draw before the (synchronous) planner runs.
    setTimeout(() => {
      if (run !== runRef.current || !mountedRef.current) return;
      try {
        const name = suggestDeckName(ld.collection, sel);
        // The deck that already holds these items (same Anki guid): a
        // re-import goes there by default, and "Existing deck" starts on it —
        // only when it holds at least half of the chosen items (a real
        // re-import; deckPageLogic.ts reimportHomeDeck). Another file that
        // shares a few items starts on "New deck", and the shared ones are
        // updated where they are (spec §5.6 rule 3).
        // A deck the caller named (/import?deckId=) still comes first.
        const chosen = chosenNotesByMid(ld.collection, sel);
        const home = reimportHomeDeck(guidHomeDeck(ld.collection, sel, library), chosenGuidsOf(chosen), library);
        const target = defaultTarget(library.decks, ld.origin, {
          deckId: params.deckId ?? home,
          name,
          icon: DEFAULT_DECK_ICON,
        });
        const first = startingPrefs(target, { name, icon: DEFAULT_DECK_ICON, decks: library.decks });
        // The learner's own choices (back from Fields) win. Else: the guid
        // home; then a CSV — no Anki ids, and the picker may give no file
        // name (a pick from its recent files) — starts on the deck where at
        // least half of its rows are ALREADY HERE (§5.6 rule 4), not on "New
        // deck: Imported deck" (wave 5g, walkthrough E8); then the first-plan
        // changes. One pure step (deckPageLogic.ts importStartPlan), tested
        // as it runs here.
        const start = importStartPlan({
          earlier,
          first,
          home,
          csv: ld.collection.csv ? { rows: chosenCountOf(chosen), sourceKey: ld.origin.sourceKey } : null,
          decks: library.decks,
          triageReady: TRIAGE_READY,
          planWith: (prefsToPlan) => makePlan(ld, sel, eds, prefsToPlan, 'preview'),
        });
        setPrefs(start.prefs);
        setPlan(start.plan);
        setStage('preview');
      } catch {
        show('Could not prepare that import. Please try again.');
        setStage('source');
      }
    }, 30);
  };

  const onPrefs = (patch: Partial<ImportPrefs>) => {
    if (!prefs || !loaded) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    if (!prefsNeedReplan(patch)) return;
    try {
      setPlan(makePlan(loaded, selected, edits, next, 'preview'));
    } catch {
      show('Could not prepare that import. Please try again.');
    }
  };

  /* ------------------------------------------------------------- importing */

  const runImport = async () => {
    if (!loaded || !prefs) return;
    runRef.current += 1; // no Cancel from here: the save starts now
    setStage('importing');
    setPhase('save');
    let applied: ImportPlan;
    let result: ImportResult;
    try {
      // A fresh plan with fresh ids, from the library as it is NOW. A new
      // deck gets the front / back languages its card types agree on
      // ({{tts}} or the Fields stage's "Read aloud"), so read-aloud and the
      // German helpers work for cards made in the app later, too.
      const langs = agreedLanguages(visibleEdits(loaded.collection, edits, selected));
      applied = withDeckLanguages(makePlan(loaded, selected, edits, prefs, freshSeed()), langs);
      result = importActions.applyImport(applied);
      // An existing deck without languages gets them too (a language it has stays).
      const into = result.deckId ? library.decks.find((d) => d.id === result.deckId) : undefined;
      if (into && !applied.deck) {
        const missing = missingDeckLanguages(into, langs);
        if (Object.keys(missing).length > 0) importActions.updateDeck(into.id, missing);
      }
    } catch {
      show('Could not import that deck. Please try again.');
      setStage('preview');
      return;
    }
    // Images go to the disk only AFTER the save COMMITTED (spec §5.8). A
    // failed save is tried again first (writeAfterSave). When it still fails,
    // nothing is written: the files would belong to a state that is not on
    // the disk, in a folder no saved deck owns. The Done stage then offers
    // "Copy images" (save again, then write). The images are written even
    // when the learner closed the screen during the save: the cards are in
    // the library already.
    const media = result.media;
    const images = imageCount(media);
    const bytesOf = loaded.collection.mediaBytes;
    const { saved, written } = await writeAfterSave(
      () => importActions.flush(),
      async () => {
        if (images === 0) return null;
        // "Copying images" only when something is copied: after "57 — already here"
        // the files are in place, and writeImportImages does not write them again.
        const allHere = imagesHereOf !== null && imagesHereOf(media) >= images;
        if (mountedRef.current && !allHere) {
          setPhase('images');
          await new Promise((resolve) => setTimeout(resolve, 30)); // let "Copying images" draw
        }
        return writeImportImages(media, bytesOf, expoMediaDisk());
      },
      // Without images there is nothing to wait for: one save, as before.
      { tries: images > 0 ? 3 : 1 },
    );
    const warnings = [saveWarning(saved)];
    let waiting: PendingImages | null = null;
    if (images > 0) {
      if (written) {
        warnings.push(imagesWarning(written.failed.length));
      } else {
        warnings.push(imagesNotCopied(images));
        // A failed save can work later; a blocked one (C1) cannot.
        if (!saved.ok && saved.reason === 'write') waiting = { media, bytesOf };
      }
    }
    if (!mountedRef.current) return;
    const deckName = applied.deck?.name ?? library.decks.find((d) => d.id === result.deckId)?.name ?? '';
    setPendingImages(waiting);
    setDone({
      copy: doneCopy(result, { deckName, notStarted: applied.summary.notStarted, triageReady: TRIAGE_READY }),
      warnings: warnings.filter((w) => w !== ''),
      deckId: result.deckId,
      deckName,
    });
    setStage('done');
  };

  /**
   * "Copy images" on the Done stage (only after a save that failed): save
   * again, and write the images only when that save committed.
   */
  const copyImagesAgain = async () => {
    if (!pendingImages || copyingImages) return;
    const { media, bytesOf } = pendingImages;
    setCopyingImages(true);
    const { saved, written } = await writeAfterSave(
      () => importActions.flush(),
      () => writeImportImages(media, bytesOf, expoMediaDisk()),
      { tries: 1 },
    );
    if (!mountedRef.current) return;
    setCopyingImages(false);
    if (!saved.ok) {
      // Blocked (C1): no save can work now, so the button goes.
      if (saved.reason === 'blocked') setPendingImages(null);
      show(saved.reason === 'blocked' ? saveWarning(saved) : 'Saving still fails. Try again in a moment.');
      return;
    }
    setPendingImages(null);
    // Saved now: the "saving failed" lines go; only an image that could not be copied stays.
    const failed = written?.failed.length ?? 0;
    const left = imagesWarning(failed);
    setDone((d) => (d ? { ...d, warnings: left ? [left] : [] } : d));
    show(failed === 0 ? 'Saved. The images are copied.' : left);
  };

  /** Cancel a download, a read or a plan: nothing was written. */
  const cancel = () => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (phase === 'plan' && loaded && !collapsed) setStage('fields');
    else if (phase === 'plan' && loaded && loaded.sections.length > 1) setStage('sections');
    else {
      setLoaded(null);
      setStage('source');
    }
    show('Import cancelled — nothing was written');
  };

  /** Back to the start (nothing imported). */
  const reset = () => {
    runRef.current += 1;
    setLoaded(null);
    setPlan(null);
    setPrefs(null);
    setEdits([]);
    setStage('source');
  };

  /**
   * Android's back: one stage back (importBack.ts). True = handled here;
   * false = the screen closes (the source stage, Done, a running save).
   */
  const onHardwareBack = (): boolean => {
    const action = importBackAction({
      stage,
      phase,
      sectionCount: loaded?.sections.length ?? 0,
      fieldsSkipped: collapsed,
    });
    switch (action) {
      case 'close':
        return false;
      case 'cancel':
        cancel();
        return true;
      case 'source':
        reset();
        return true;
      case 'sections':
      case 'fields':
        setStage(action);
        return true;
    }
  };
  // ONE subscription for the screen's life, added when it mounts: a handler
  // added later (an AnkiWeb deck's details, SourceStage) is asked before it.
  // It always runs the newest onHardwareBack.
  const backRef = useRef<() => boolean>(() => false);
  useEffect(() => {
    backRef.current = onHardwareBack;
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => backRef.current());
    return () => sub.remove();
  }, []);

  /* ------------------------------------------------------------- render */

  const visible = loaded ? visibleEdits(loaded.collection, edits, selected) : [];
  const csvControls: CsvControls | null =
    loaded?.csv && loaded.collection.csv
      ? {
          header: loaded.collection.csv.header !== null,
          onHeader: (on) => rereadCsv({ ...loaded.csv?.opts, header: on }),
          onTagsColumn: (column) => rereadCsv({ ...loaded.csv?.opts, tagsCol: column }),
        }
      : null;
  const collapsedLine = collapsed ? visible.map((e) => fieldsLine(e.fields)).filter((l) => l !== '').join('; ') : '';
  const savingCount = plan ? plan.summary.cardsAdded || plan.summary.cardsUpdated : 0;
  const phaseCopy: Record<Phase, { title: string; sub: string }> = {
    download: { title: 'Downloading deck', sub: `Fetching “${downloadName}” from AnkiWeb.` },
    read: { title: 'Reading the file', sub: 'Every field, direction and image is kept.' },
    plan: { title: 'Planning', sub: 'Counting what is new, updated and already here.' },
    save: { title: `Saving ${plural(savingCount, 'card')}`, sub: 'Please keep the app open.' },
    images: { title: 'Copying images', sub: 'Almost done.' },
  };
  const cancellable = phase === 'download' || phase === 'read' || phase === 'plan';

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title="Import" sub="Bring your own cards" backIcon="close" onBack={() => router.back()} />
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {stage === 'source' ? (
          <SourceStage
            tab={tab}
            onTab={setTab}
            fileBusy={fileBusy}
            onChooseFile={() => void onChooseFile()}
            onDownload={(pick) => void onDownload(pick)}
            restore={restore}
          />
        ) : null}

        {stage === 'sections' && loaded ? (
          <SectionsStage
            name={suggestDeckName(loaded.collection)}
            sections={loaded.sections}
            selected={selected}
            onSelected={setSelected}
            onCancel={reset}
            onContinue={() => {
              // Other sections → another suggested deck name: the Preview starts again.
              setPrefs(null);
              afterSections(loaded, selected, edits);
            }}
          />
        ) : null}

        {stage === 'fields' && loaded ? (
          <FieldsStage
            collection={loaded.collection}
            edits={visible}
            sections={selected}
            csv={csvControls}
            onEdit={(mid, next: { fields?: FieldDef[]; ords?: number[] }) =>
              setEdits((list) => list.map((e) => (e.mid === mid ? { ...e, ...next } : e)))
            }
            onBack={() => (loaded.sections.length > 1 ? setStage('sections') : reset())}
            onContinue={() => startPlanning(loaded, selected, edits, prefs)}
          />
        ) : null}

        {stage === 'preview' && loaded && plan && prefs ? (
          <PreviewStage
            summary={plan.summary}
            prefs={prefs}
            anki={loaded.collection.csv === undefined}
            decks={library.decks.map((d) => ({ id: d.id, name: d.name, icon: d.icon }))}
            dailyNewLimit={library.settings.srs.dailyNewLimit}
            fieldsLine={collapsedLine}
            imagesHere={imagesHere}
            onChangeFields={() => {
              setCollapsed(false);
              setStage('fields');
            }}
            onPrefs={onPrefs}
            onImport={() => void runImport()}
            onCancel={reset}
            onClose={() => router.back()}
          />
        ) : null}

        {stage === 'importing' ? (
          <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 10 }}>
            <View
              style={{
                width: 86,
                height: 86,
                borderRadius: 999,
                backgroundColor: c.pineTint,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ActivityIndicator size="large" color={c.pine} />
            </View>
            <Text
              accessibilityRole="header"
              style={[font('sans', 700), { fontSize: 15.5, color: c.ink, marginTop: 18, marginBottom: 4 }]}
            >
              {phaseCopy[phase].title}
            </Text>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, marginBottom: 22, textAlign: 'center' }]}>
              {phaseCopy[phase].sub}
            </Text>
            {cancellable ? (
              <Btn kind="quiet" onPress={cancel} style={{ alignSelf: 'center' }}>
                Cancel
              </Btn>
            ) : null}
          </View>
        ) : null}

        {stage === 'done' && done ? (
          <DoneStage
            copy={done.copy}
            warnings={done.warnings}
            studyCount={studyCount}
            hasDeck={done.deckId !== null}
            imagesWaiting={pendingImages !== null}
            copyingImages={copyingImages}
            onCopyImages={() => void copyImagesAgain()}
            onStudy={() => {
              if (done.deckId === null) return;
              router.replace(studyRoute(done.deckId, done.deckName));
            }}
            onChoose={() => {
              if (done.deckId === null) return;
              router.replace(triageRoute(done.deckId, importFromDeckPage(params.deckId, done.deckId)));
            }}
            onOpenDeck={() => {
              if (done.deckId === null) return;
              // Opened from this deck's page: go back to it (a replace would put a second copy on the stack).
              if (importFromDeckPage(params.deckId, done.deckId) && router.canGoBack()) router.back();
              else router.replace(openDeckRoute(done.deckId));
            }}
            onDone={() => router.back()}
          />
        ) : null}
      </ScrollView>
      {restore.sheet}
      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
