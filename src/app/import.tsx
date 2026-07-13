/**
 * Import hub (B6) — one destination, three sources (AnkiWeb / file / backup),
 * a shared staged flow: source → honest preview ("nothing imported yet") →
 * cancellable progress → done with a "Go study" forward action.
 *
 * The AnkiWeb source is REAL (src/domain/ankiweb.ts): a debounced search hits
 * AnkiWeb's shared-deck listing, picking previews the listing's true metadata,
 * and importing downloads the .apkg, parses it (parseApkg), dedupes against the
 * library and writes via importDeck — the same SRS-preserving path the file
 * source uses. Pasting an AnkiWeb URL / deck id surfaces a direct row (B6b).
 */
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import {
  Btn,
  CardBox,
  Ion,
  ListRow,
  Overline,
  RiseIn,
  Row,
  SegCtrl,
  SnackbarHost,
  StackBar,
} from '@/components/ui';
import { ankiDeckName } from '@/domain/anki';
import type { ImportSection } from '@/domain/anki';
import {
  AnkiWebDeck,
  AnkiWebError,
  downloadSharedDeck,
  parseAnkiWebId,
  searchSharedDecks,
} from '@/domain/ankiweb';
import { ApkgError, apkgErrorMessage, parseApkg } from '@/domain/importApkg';
import { detectImportKind, ParsedImport, parseImportCsv } from '@/domain/importFile';
import { ImportCardPayload } from '@/domain/importSamples';
import { Deck } from '@/domain/types';
import { inferLang, LANG_FLAGS } from '@/domain/words';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

type Stage = 'idle' | 'sections' | 'preview' | 'importing' | 'done';

/**
 * A pending .apkg pick that split into >1 subdeck — held while the user chooses
 * which subdecks to import (the 'sections' stage). Its flag/lang are inferred
 * once from the whole-deck name + field names; the final deck name is derived
 * from the SELECTION at Continue time via ankiDeckName().
 */
type PendingSections = {
  name: string;
  flag: string;
  lang: string;
  sections: ImportSection[];
};

/**
 * The staged item, discriminated by source. An AnkiWeb pick carries only the
 * id + listing metadata — the actual cards are downloaded + parsed at import
 * time. A file pick already holds the parsed payload in hand.
 */
type Staged =
  | { source: 'ankiweb'; id: string; name: string; deck: AnkiWebDeck | null }
  | { source: 'file'; name: string; flag: string; lang: string; payload: ImportCardPayload[] };

const SEARCH_DEBOUNCE_MS = 350;
/** German-learning app: an empty query still surfaces useful (German) decks. */
const DEFAULT_QUERY = 'german';

export default function ImportScreen() {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const { show } = useSnackbar();

  const [src, setSrc] = useState('anki');
  const [stage, setStage] = useState<Stage>('idle');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<AnkiWebDeck[]>([]);
  // Starts true: the screen kicks off a default search on mount, so this keeps
  // the empty-state ("No shared decks match") from flashing before results land.
  const [searching, setSearching] = useState(true);
  const [chosen, setChosen] = useState<Staged | null>(null);
  // The .apkg subdeck picker: the pending pick + the currently-selected deck ids
  // (default all, so "import everything" stays one tap).
  const [pending, setPending] = useState<PendingSections | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importPhase, setImportPhase] = useState<'download' | 'write' | null>(null);
  const [importedDeck, setImportedDeck] = useState<Deck | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [busy, setBusy] = useState(false);

  // Lifetime guards for the async network paths: never setState after unmount,
  // and abort an in-flight import/search when the screen goes away.
  const mountedRef = useRef(true);
  const searchAbortRef = useRef<AbortController | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      searchAbortRef.current?.abort();
      importAbortRef.current?.abort();
    };
  }, []);

  // A pasted AnkiWeb URL / numeric id short-circuits search → direct row (B6b).
  const ankiId = parseAnkiWebId(q.trim());

  /* ---------------------- real, debounced AnkiWeb search ----------------------
   * All setState lives inside the debounce timer / promise callbacks — never
   * synchronously in the effect body (the React Compiler forbids that). The
   * other tabs don't search, and a pasted id is served by the direct row, so
   * those cases just return early: their stale results/searching are hidden in
   * render and get overwritten the next time a real query runs. */
  useEffect(() => {
    // Cancel any search already in flight before scheduling the next one.
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;

    if (src !== 'anki' || parseAnkiWebId(q.trim())) return;

    const query = q.trim() === '' ? DEFAULT_QUERY : q.trim();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;

    const handle = setTimeout(() => {
      setSearching(true);
      searchSharedDecks(query, ctrl.signal)
        .then((decks) => {
          if (ctrl.signal.aborted || !mountedRef.current) return;
          setResults(decks);
          setSearching(false);
        })
        .catch((err: unknown) => {
          // An aborted fetch is normal cancellation (next keystroke / unmount).
          if (ctrl.signal.aborted || !mountedRef.current) return;
          setResults([]);
          setSearching(false);
          show(err instanceof AnkiWebError ? err.message : 'Could not search AnkiWeb. Try again.');
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [q, src, show]);

  const stageItem = (item: Staged) => {
    setChosen(item);
    setImportPhase(null);
    setStage('preview');
  };

  /**
   * Real OS file picker for the "From a file" source. A CSV is parsed inline; an
   * .apkg is unzipped + read via SQLite (parseApkg). Both paths end at the same
   * stageItem() the AnkiWeb rows use, so preview → importing → done run unchanged.
   */
  const onChooseFile = async () => {
    if (busy) return; // guard double taps / re-entrancy
    setBusy(true);
    try {
      const picked = await File.pickFileAsync({
        // Broad on purpose: Android MIME types are unreliable, so we accept
        // anything and validate AFTER the pick by extension + content.
        mimeTypes: [
          'text/*',
          'text/csv',
          'text/comma-separated-values',
          'application/vnd.ms-excel',
          'application/zip',
          '*/*',
        ],
      });
      if (picked.canceled) return; // dismissed the picker — write nothing, say nothing

      const file = picked.result; // narrowed to File by the `canceled` discriminant

      // Hand a parsed deck to the existing staged flow.
      const finish = ({ payload, name, fieldNames, sections }: ParsedImport) => {
        if (payload.length === 0) {
          show('No cards found in that file.');
          return;
        }
        // Infer the language from the deck/file name AND any column headers /
        // Anki field names, so TTS matches the words instead of forcing German
        // on every import (H6).
        const lang = inferLang([name, ...(fieldNames ?? [])]);
        const flag = LANG_FLAGS[lang] ?? '📄';
        // A multi-subdeck .apkg (German::Verbs::B1, …) → let the user pick which
        // subdecks to import. A single-deck .apkg / CSV / AnkiWeb keeps the flat
        // flow untouched (sections is undefined for those).
        if (sections && sections.length > 1) {
          setPending({ name, flag, lang, sections });
          setSelected(new Set(sections.map((s) => s.did)));
          setStage('sections');
          return;
        }
        stageItem({ source: 'file', name, flag, lang, payload });
      };

      // Read the raw bytes ONCE and classify by magic. Android SAF often returns
      // an opaque name with no .apkg extension, so we must not gate on the name —
      // nor waste a full binary→string text() decode of a large deck just to sniff.
      const bytes = await file.bytes();
      const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
      const isSqlite =
        bytes.length >= 4 &&
        bytes[0] === 0x53 &&
        bytes[1] === 0x51 &&
        bytes[2] === 0x4c &&
        bytes[3] === 0x69; // 'SQLi'

      if (/\.(apkg|colpkg)$/i.test(file.name) || isZip || isSqlite) {
        // .apkg: unzip + read its SQLite collection. Its own try/catch surfaces a
        // specific message (newer-format / empty / corrupt).
        try {
          const parsed = await parseApkg(bytes, file.name);
          finish(parsed);
        } catch (err) {
          show(apkgErrorMessage(err));
        }
        return;
      }

      // Not an Anki package → a (small) text/CSV file. file.text() decodes the
      // bytes; CSVs are KB-sized so the extra read is negligible.
      const text = await file.text();
      if (!text.trim()) {
        show('That file is empty — pick a .csv or .apkg.');
        return;
      }
      if (detectImportKind(file.name, text.slice(0, 4096)) !== 'csv') {
        show('Could not recognise that file — export a .csv or .apkg.');
        return;
      }
      finish(parseImportCsv(text, file.name));
    } catch {
      show('Could not read that file. Please try a different export.');
    } finally {
      setBusy(false); // always re-enable the picker button
    }
  };

  /**
   * Run the staged import. For an AnkiWeb item: download the .apkg, parse it,
   * then dedupe + write. A file item already holds its parsed payload, so it
   * skips straight to the write. Honest indeterminate phases; cancellable via
   * the AbortController (only the network download is interruptible — the parse
   * + write are guarded by re-checking the signal before they commit anything).
   */
  const runImport = async () => {
    if (!chosen) return;
    const ctrl = new AbortController();
    importAbortRef.current = ctrl;
    setStage('importing');
    setImportPhase(chosen.source === 'ankiweb' ? 'download' : 'write');

    try {
      let payload: ImportCardPayload[];
      let deckFields: Pick<Deck, 'name' | 'flag' | 'lang'>;

      if (chosen.source === 'ankiweb') {
        const bytes = await downloadSharedDeck(chosen.id, ctrl.signal);
        if (ctrl.signal.aborted || !mountedRef.current) return;
        setImportPhase('write');
        // The listing name is the fallback; the true deck name comes from the
        // collection inside the .apkg when present.
        const parsed = await parseApkg(bytes, chosen.name);
        if (ctrl.signal.aborted || !mountedRef.current) return;
        payload = parsed.payload;
        const lang = inferLang([parsed.name, chosen.name, ...(parsed.fieldNames ?? [])]);
        deckFields = { name: parsed.name, flag: LANG_FLAGS[lang] ?? '🇩🇪', lang };
      } else {
        payload = chosen.payload;
        deckFields = { name: chosen.name, flag: chosen.flag, lang: chosen.lang };
      }

      // Dedupe against existing library words; importDeck preserves any SRS
      // fields the payload carries (Anki fidelity). No await past this point, so
      // a late Cancel can't interleave between the check and the write.
      const have = new Set(state.cards.map((x) => x.word.toLowerCase()));
      const fresh = payload.filter((p) => !have.has(p.word.toLowerCase()));

      // Every word is already in the library — don't create a phantom 0-card deck
      // with a dead "Study the new cards" CTA. Say so and stay on the preview (M11).
      if (fresh.length === 0) {
        if (!mountedRef.current) return;
        setImportPhase(null);
        setStage('preview');
        show('Nothing new to import — every word is already in your library.');
        return;
      }

      const deck = actions.importDeck(deckFields, fresh);

      if (!mountedRef.current) return;
      setImportedDeck(deck);
      setImportedCount(fresh.length);
      setSkippedCount(payload.length - fresh.length);
      setImportPhase(null);
      setStage('done');
    } catch (err) {
      // Cancellation (aborted signal) is owned by the Cancel button — stay quiet.
      if (ctrl.signal.aborted || !mountedRef.current) return;
      const msg =
        err instanceof ApkgError
          ? apkgErrorMessage(err)
          : err instanceof AnkiWebError
            ? err.message
            : 'Could not import that deck. Please try again.';
      show(msg);
      setImportPhase(null);
      setStage('idle');
    } finally {
      if (importAbortRef.current === ctrl) importAbortRef.current = null;
    }
  };

  const cancelImport = () => {
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    setImportPhase(null);
    setStage('idle');
    show('Import cancelled — nothing was written');
  };

  const studyNew = () => {
    if (!importedDeck) return;
    router.replace({
      pathname: '/session',
      params: { kind: 'deck', deckId: importedDeck.id, label: importedDeck.name },
    });
  };

  /* ------------------------- .apkg subdeck picker tree -------------------------
   * Strip the segments the subdecks all share (same idea as ankiDeckName —
   * ['German'] for German::Vocabulary::A1 + German::Grammar::B1 …) then group the
   * remainder by its first segment: 'Vocabulary' → [A1, B1], 'Verbs' → [A1, B1],
   * so the picker reads as categories with level leaves. 1 remaining level → a
   * flat list; the stripping never consumes a section's whole path (so every row
   * keeps a label). Pure derivation — no setState here (React Compiler rule). */
  const tree = useMemo(() => {
    const secs = pending?.sections ?? [];
    if (secs.length === 0) return { mode: 'flat' as const, leaves: [], groups: [] };
    const paths = secs.map((s) => s.path);
    const first = paths[0];
    // Common leading segments, but leave every section at least one segment.
    let minLen = paths[0].length;
    for (const p of paths) if (p.length < minLen) minLen = p.length;
    let common = 0;
    for (let i = 0; i < minLen; i++) {
      const seg = first[i];
      if (seg && paths.every((p) => p[i] === seg)) common++;
      else break;
    }
    if (common >= minLen) common = minLen - 1;

    const rem = (s: ImportSection) => s.path.slice(common);
    let maxRem = 0;
    for (const s of secs) {
      const r = rem(s).length;
      if (r > maxRem) maxRem = r;
    }

    if (maxRem >= 2) {
      // Grouped: category header + level leaves.
      const order: string[] = [];
      const byKey = new Map<string, { did: string; label: string; count: number }[]>();
      for (const s of secs) {
        const r = rem(s);
        const key = r[0] || s.name;
        const label = r.length > 1 ? r.slice(1).join(' · ') : r[0] || s.name;
        if (!byKey.has(key)) {
          byKey.set(key, []);
          order.push(key);
        }
        byKey.get(key)?.push({ did: s.did, label, count: s.payload.length });
      }
      const groups = order.map((key) => {
        const leaves = byKey.get(key) ?? [];
        return { key, leaves, count: leaves.reduce((a, l) => a + l.count, 0) };
      });
      return { mode: 'grouped' as const, groups, leaves: [] };
    }

    // Flat: one row per subdeck.
    const leaves = secs.map((s) => {
      const r = rem(s);
      return { did: s.did, label: r.join(' · ') || s.name, count: s.payload.length };
    });
    return { mode: 'flat' as const, leaves, groups: [] };
  }, [pending]);

  const toggleDid = (did: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(did)) next.delete(did);
      else next.add(did);
      return next;
    });
  };

  const toggleGroup = (dids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = dids.every((d) => next.has(d));
      for (const d of dids) {
        if (allOn) next.delete(d);
        else next.add(d);
      }
      return next;
    });
  };

  const allDids = pending?.sections.map((s) => s.did) ?? [];
  const allSelected = allDids.length > 0 && allDids.every((d) => selected.has(d));
  const toggleAll = () => {
    setSelected((prev) => (allDids.every((d) => prev.has(d)) ? new Set() : new Set(allDids)));
  };

  // Live selection tally for the footer summary + Continue gating.
  const chosenSections = pending?.sections.filter((s) => selected.has(s.did)) ?? [];
  const selCardCount = chosenSections.reduce((a, s) => a + s.payload.length, 0);

  const continueSections = () => {
    if (!pending || chosenSections.length === 0) return;
    const payload = chosenSections.flatMap((s) => s.payload);
    // Name from the SELECTION: one subdeck → its full name, several → their
    // common prefix (ankiDeckName), falling back to the whole-deck pick name.
    const name = ankiDeckName(
      chosenSections.map((s) => s.name),
      pending.name,
    );
    stageItem({ source: 'file', name, flag: pending.flag, lang: pending.lang, payload });
  };

  /* Preview rows differ by source: a file item knows its exact payload (so it
   * can show a real duplicate count), an AnkiWeb item only knows the listing
   * metadata (a pre-download dupe count is impossible — that is fine). */
  const previewRows = useMemo<[string, string][]>(() => {
    if (!chosen) return [];
    if (chosen.source === 'file') {
      const have = new Set(state.cards.map((x) => x.word.toLowerCase()));
      const dupes = chosen.payload.filter((p) => have.has(p.word.toLowerCase())).length;
      const withProgress = chosen.payload.filter((p) => (p.reps ?? 0) > 0).length;
      return [
        ['Cards', chosen.payload.length.toLocaleString('en-US')],
        ['With study progress', withProgress.toLocaleString('en-US')],
        [
          'Already in your library',
          dupes > 0 ? `${dupes} duplicates — will be skipped` : 'no duplicates',
        ],
      ];
    }
    const d = chosen.deck;
    if (!d) return [['AnkiWeb deck', `#${chosen.id}`]];
    const rows: [string, string][] = [['Notes', d.notes.toLocaleString('en-US')]];
    if (d.audio > 0) rows.push(['Audio clips', d.audio.toLocaleString('en-US')]);
    if (d.images > 0) rows.push(['Images', d.images.toLocaleString('en-US')]);
    if (d.modifiedSec > 0) {
      rows.push([
        'Updated',
        new Date(d.modifiedSec * 1000).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }),
      ]);
    }
    rows.push(['Upvotes', d.upvotes.toLocaleString('en-US')]);
    return rows;
  }, [chosen, state.cards]);

  const previewNote =
    chosen?.source === 'ankiweb'
      ? 'We download the deck from AnkiWeb, then add its cards — anything already in your library is skipped.'
      : chosen && chosen.payload.some((p) => (p.reps ?? 0) > 0)
        ? 'Anki scheduling is preserved — ease, intervals and due dates come along.'
        : 'New cards are added to your library — duplicates are skipped.';

  const caption = ankiId
    ? 'From your link'
    : q.trim() === ''
      ? 'Popular for German learners'
      : 'Search results';

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar
        title="Import"
        sub="Bring your own vocabulary"
        backIcon="close"
        onBack={() => router.back()}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {stage === 'idle' && (
          <>
            <SegCtrl
              value={src}
              onChange={setSrc}
              options={[
                { id: 'anki', label: 'AnkiWeb' },
                { id: 'file', label: 'From a file' },
                { id: 'backup', label: 'Backup' },
              ]}
            />

            {src === 'anki' && (
              <View style={{ marginTop: 18 }}>
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
                  }}
                >
                  <Ion name="search" size={16} color={c.ink3} />
                  <TextInput
                    value={q}
                    onChangeText={setQ}
                    placeholder="Search shared decks…"
                    placeholderTextColor={c.ink3}
                    autoCorrect={false}
                    autoCapitalize="none"
                    style={[font('sans', 400), { flex: 1, fontSize: 14.5, color: c.ink, padding: 0 }]}
                  />
                  {searching && !ankiId ? <ActivityIndicator size="small" color={c.ink3} /> : null}
                </View>
                <Text
                  style={[
                    font('sans', 400),
                    { fontSize: 12.5, color: c.ink3, marginTop: 10, marginBottom: 4, marginHorizontal: 2 },
                  ]}
                >
                  {caption}
                </Text>

                {ankiId ? (
                  <Row
                    onPress={() =>
                      stageItem({
                        source: 'ankiweb',
                        id: ankiId,
                        name: `AnkiWeb deck #${ankiId}`,
                        deck: null,
                      })
                    }
                    padV={13}
                    last
                  >
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        backgroundColor: c.pineTint,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ion name="link-outline" size={17} color={c.pine} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>
                        Import from AnkiWeb
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={[font('mono', 400), { fontSize: 12, color: c.ink3 }]}
                      >
                        {q.trim()}
                      </Text>
                    </View>
                    <Ion name="chevron-forward" size={16} color={c.ink3} />
                  </Row>
                ) : (
                  <>
                    {searching && results.length === 0 && (
                      <View style={{ alignItems: 'center', paddingVertical: 28 }}>
                        <ActivityIndicator color={c.pine} />
                      </View>
                    )}

                    {results.map((r, i) => (
                      <Row
                        key={r.id}
                        onPress={() =>
                          stageItem({ source: 'ankiweb', id: r.id, name: r.name, deck: r })
                        }
                        padV={13}
                        last={i === results.length - 1}
                      >
                        <View
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 10,
                            backgroundColor: c.infoTint,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Ion name="albums-outline" size={17} color={c.info} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            numberOfLines={1}
                            style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}
                          >
                            {r.name}
                          </Text>
                          <View
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 }}
                          >
                            <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                              {r.notes.toLocaleString('en-US')} notes
                            </Text>
                            <Ion name="arrow-up" size={11} color={c.ink3} />
                            <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                              {r.upvotes.toLocaleString('en-US')}
                            </Text>
                            {r.audio > 0 ? (
                              <Ion name="volume-medium" size={12} color={c.ink3} />
                            ) : null}
                          </View>
                        </View>
                        <Ion name="chevron-forward" size={16} color={c.ink3} />
                      </Row>
                    ))}

                    {!searching && results.length === 0 && (
                      <View style={{ alignItems: 'center', paddingVertical: 26, paddingHorizontal: 16 }}>
                        <Text
                          style={[font('serif', 600), { fontSize: 17, color: c.ink, marginBottom: 4 }]}
                        >
                          No shared decks match
                        </Text>
                        <Text
                          style={[
                            font('sans', 400),
                            { fontSize: 13, color: c.ink3, textAlign: 'center' },
                          ]}
                        >
                          Try another search — or paste an AnkiWeb URL / deck ID.
                        </Text>
                      </View>
                    )}

                    <Text
                      style={[
                        font('sans', 400),
                        { fontSize: 12.5, color: c.ink3, marginTop: 14, textAlign: 'center' },
                      ]}
                    >
                      or paste an AnkiWeb URL / deck ID above
                    </Text>
                  </>
                )}
              </View>
            )}

            {src === 'file' && (
              <View style={{ marginTop: 18 }}>
                <Pressable
                  onPress={onChooseFile}
                  disabled={busy}
                  style={({ pressed }) => ({
                    borderWidth: 1.5,
                    borderStyle: 'dashed',
                    borderColor: c.hairlineStrong,
                    borderRadius: 16,
                    paddingVertical: 34,
                    paddingHorizontal: 20,
                    alignItems: 'center',
                    opacity: busy ? 0.55 : pressed ? 0.7 : 1,
                  })}
                >
                  <Ion
                    name={busy ? 'hourglass-outline' : 'document-attach-outline'}
                    size={30}
                    color={c.ink3}
                  />
                  <Text
                    style={[font('sans', 700), { fontSize: 15, color: c.ink, marginTop: 10, marginBottom: 4 }]}
                  >
                    {busy ? 'Reading file…' : 'Choose a file'}
                  </Text>
                  <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>
                    .csv or .apkg — we’ll detect which
                  </Text>
                </Pressable>
                <Text
                  style={[
                    font('sans', 400),
                    { fontSize: 12.5, lineHeight: 19, color: c.ink3, marginTop: 12 },
                  ]}
                >
                  CSV columns map to Word, Translation, Example, Level, Type, Pronunciation and
                  Tags — you’ll confirm the mapping before anything is written.
                </Text>
              </View>
            )}

            {src === 'backup' && (
              <View style={{ marginTop: 18 }}>
                <ListRow
                  icon="refresh-circle-outline"
                  title="Restore a Maranki backup"
                  sub="A .json file from Settings → Export"
                  last
                  onPress={() => show('Choose a backup file')}
                />
              </View>
            )}
          </>
        )}

        {stage === 'sections' && pending && (
          <RiseIn duration={250}>
            <Overline style={{ marginBottom: 10 }}>Choose subdecks — nothing imported yet</Overline>
            <Text style={[font('serif', 600), { fontSize: 20, color: c.ink, marginBottom: 4 }]}>
              {pending.name}
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 14,
              }}
            >
              <Text style={[font('sans', 400), tnum, { fontSize: 13, color: c.ink3 }]}>
                {pending.sections.length} subdecks
              </Text>
              <Pressable onPress={toggleAll} hitSlop={8}>
                <Text style={[font('sans', 700), { fontSize: 13.5, color: c.pine }]}>
                  {allSelected ? 'Clear all' : 'Select all'}
                </Text>
              </Pressable>
            </View>

            {tree.mode === 'grouped'
              ? tree.groups.map((g) => {
                  const dids = g.leaves.map((l) => l.did);
                  const allOn = dids.every((d) => selected.has(d));
                  const someOn = dids.some((d) => selected.has(d));
                  return (
                    <CardBox key={g.key} pad={0} style={{ marginBottom: 12 }}>
                      <Row
                        onPress={() => toggleGroup(dids)}
                        padV={13}
                        style={{ paddingHorizontal: 16 }}
                      >
                        <Ion
                          name={allOn ? 'checkbox' : someOn ? 'remove-circle' : 'square-outline'}
                          size={22}
                          color={allOn || someOn ? c.pine : c.ink3}
                        />
                        <Text style={[font('sans', 700), { flex: 1, fontSize: 14.5, color: c.ink }]}>
                          {g.key}
                        </Text>
                        <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                          {g.count.toLocaleString('en-US')}
                        </Text>
                      </Row>
                      {g.leaves.map((leaf, i) => {
                        const on = selected.has(leaf.did);
                        return (
                          <Row
                            key={leaf.did}
                            onPress={() => toggleDid(leaf.did)}
                            padV={11}
                            last={i === g.leaves.length - 1}
                            style={{ paddingLeft: 40, paddingRight: 16 }}
                          >
                            <Ion
                              name={on ? 'checkbox' : 'square-outline'}
                              size={20}
                              color={on ? c.pine : c.ink3}
                            />
                            <Text
                              numberOfLines={1}
                              style={[font('sans', 400), { flex: 1, fontSize: 14, color: c.ink2 }]}
                            >
                              {leaf.label}
                            </Text>
                            <Text
                              style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink }]}
                            >
                              {leaf.count.toLocaleString('en-US')}
                            </Text>
                          </Row>
                        );
                      })}
                    </CardBox>
                  );
                })
              : (
                <CardBox pad={0}>
                  {tree.leaves.map((leaf, i) => {
                    const on = selected.has(leaf.did);
                    return (
                      <Row
                        key={leaf.did}
                        onPress={() => toggleDid(leaf.did)}
                        padV={13}
                        last={i === tree.leaves.length - 1}
                        style={{ paddingHorizontal: 16 }}
                      >
                        <Ion
                          name={on ? 'checkbox' : 'square-outline'}
                          size={22}
                          color={on ? c.pine : c.ink3}
                        />
                        <Text
                          numberOfLines={1}
                          style={[font('sans', 700), { flex: 1, fontSize: 14.5, color: c.ink }]}
                        >
                          {leaf.label}
                        </Text>
                        <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                          {leaf.count.toLocaleString('en-US')}
                        </Text>
                      </Row>
                    );
                  })}
                </CardBox>
              )}

            <Text
              style={[
                font('sans', 400),
                tnum,
                { fontSize: 12.5, color: c.ink3, marginTop: 14, marginBottom: 12, marginHorizontal: 2 },
              ]}
            >
              Import {selCardCount.toLocaleString('en-US')} {selCardCount === 1 ? 'card' : 'cards'} ·{' '}
              {chosenSections.length.toLocaleString('en-US')}{' '}
              {chosenSections.length === 1 ? 'section' : 'sections'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setStage('idle')}>
                Cancel
              </Btn>
              <Btn
                full
                style={{ flex: 1 }}
                icon="arrow-forward"
                disabled={chosenSections.length === 0}
                onPress={continueSections}
              >
                Continue
              </Btn>
            </View>
          </RiseIn>
        )}

        {stage === 'preview' && chosen && (
          <RiseIn duration={250}>
            <Overline style={{ marginBottom: 10 }}>Preview — nothing imported yet</Overline>
            <CardBox>
              <Text style={[font('serif', 600), { fontSize: 20, color: c.ink, marginBottom: 12 }]}>
                {chosen.name}
              </Text>
              {previewRows.map(([l, n], i, arr) => (
                <View
                  key={l}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingVertical: 8,
                    borderBottomWidth: i < arr.length - 1 ? 1 : 0,
                    borderBottomColor: c.hairlineSoft,
                  }}
                >
                  <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2 }]}>{l}</Text>
                  <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink }]}>{n}</Text>
                </View>
              ))}
            </CardBox>
            <Text
              style={[
                font('sans', 400),
                { fontSize: 12.5, color: c.ink3, marginVertical: 12, marginHorizontal: 2 },
              ]}
            >
              {previewNote}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setStage('idle')}>
                Cancel
              </Btn>
              <Btn
                full
                style={{ flex: 1 }}
                icon={chosen.source === 'ankiweb' ? 'cloud-download-outline' : 'download-outline'}
                onPress={runImport}
              >
                Import deck
              </Btn>
            </View>
          </RiseIn>
        )}

        {stage === 'importing' && chosen && (
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
              style={[font('sans', 700), { fontSize: 15.5, color: c.ink, marginTop: 18, marginBottom: 4 }]}
            >
              {importPhase === 'download' ? 'Downloading deck…' : 'Importing…'}
            </Text>
            <Text
              style={[
                font('sans', 400),
                { fontSize: 13, color: c.ink3, marginBottom: 22, textAlign: 'center' },
              ]}
            >
              {importPhase === 'download'
                ? `Fetching “${chosen.name}” from AnkiWeb.`
                : 'Adding cards to your library.'}
            </Text>
            <Btn kind="quiet" onPress={cancelImport}>
              Cancel
            </Btn>
          </View>
        )}

        {stage === 'done' && (
          <RiseIn duration={300}>
            <View style={{ alignItems: 'center', paddingVertical: 36, paddingHorizontal: 10 }}>
              <View
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: 999,
                  backgroundColor: c.pineTint,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 16,
                }}
              >
                <Ion name="checkmark" size={30} color={c.pine} />
              </View>
              <Text style={[font('serif', 600), { fontSize: 23, color: c.ink, marginBottom: 6 }]}>
                {importedCount} cards imported
              </Text>
              <Text style={[font('sans', 400), tnum, { fontSize: 13.5, color: c.ink3, marginBottom: 24 }]}>
                {skippedCount > 0 ? `${skippedCount} duplicates skipped · ` : ''}
                ready to study now
              </Text>
              <Btn full size="lg" icon="play" onPress={studyNew}>
                Study the new deck
              </Btn>
              <Pressable onPress={() => router.back()} style={{ marginTop: 16 }} hitSlop={8}>
                <Text style={[font('sans', 700), { fontSize: 14, color: c.ink2 }]}>Done</Text>
              </Pressable>
            </View>
          </RiseIn>
        )}
      </ScrollView>
      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
