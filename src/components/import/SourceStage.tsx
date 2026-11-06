/**
 * Import wizard — the "Source" stage (spec §5.9): AnkiWeb · From a file · Backup.
 *
 *   - AnkiWeb: a debounced search of AnkiWeb's shared decks
 *     (src/domain/ankiweb.ts). A row shows the notes, the rating and
 *     "has audio / images". Tapping a row opens its details; "Download &
 *     preview" downloads and reads the deck, then the wizard continues with
 *     Sections and Fields, exactly like a file (§5.4: AnkiWeb no longer
 *     skips them). A pasted AnkiWeb link or deck id gives a direct row.
 *   - From a file: "Choose a file" opens the system picker (the screen does
 *     the reading). `.apkg`, `.csv`, `.tsv` and `.txt` (Anki text exports).
 *   - Backup: "Choose a backup file" opens the Restore flow (§8.4).
 *
 * The search state lives here; the screen gets only the chosen deck.
 * All setState of the search runs inside the debounce timer and the promise
 * callbacks — never synchronously in the effect body (React Compiler rule).
 *
 * A search that FAILED (offline, AnkiWeb down) is not "no decks match": it
 * keeps its own state (`error`) and shows "Could not reach AnkiWeb" with a
 * "Try again" button that runs the same search again. Android's back on a
 * deck's details goes back to the results (like the "Back" button), not out
 * of Import.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, Text, TextInput, View } from 'react-native';

import { Btn, CardBox, Ion, ListRow, Overline, RiseIn, Row, SegCtrl } from '@/components/ui';
import { AnkiWebDeck, AnkiWebError, parseAnkiWebId, searchSharedDecks } from '@/domain/ankiweb';
import { ankiWebDetailRows, ankiWebMeta } from '@/domain/importFile';
import { RESTORE_COPY } from '@/store/backup';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export type SourceTab = 'ankiweb' | 'file' | 'backup';

const SEARCH_DEBOUNCE_MS = 350;
/** An empty query still shows useful, widely shared decks to start from. */
const DEFAULT_QUERY = 'popular';

/** What the AnkiWeb tab says when a search failed (not "No shared decks match"). */
export const ANKIWEB_SEARCH_FAILED = {
  title: 'Could not reach AnkiWeb',
  retry: 'Try again',
  /** The body when the error has no message of its own. */
  fallback: 'Check your connection, then try again.',
} as const;

/**
 * The text a failed search shows under the title: for no connection the
 * fallback ("Check your connection…", the title already says AnkiWeb could
 * not be reached), else the AnkiWeb error's own message.
 */
export function searchErrorText(err: unknown): string {
  return err instanceof AnkiWebError && err.code !== 'network' && err.message ? err.message : ANKIWEB_SEARCH_FAILED.fallback;
}

/** A deck chosen on AnkiWeb: from a search row (with its listing), or from a pasted link (id only). */
export interface AnkiWebPick {
  id: string;
  name: string;
  deck: AnkiWebDeck | null;
}

interface SourceStageProps {
  tab: SourceTab;
  onTab: (tab: SourceTab) => void;
  /** True while the file picker is open or a file is read. */
  fileBusy: boolean;
  onChooseFile: () => void;
  /** "Download & preview" on an AnkiWeb deck. */
  onDownload: (pick: AnkiWebPick) => void;
  /** The Restore flow of the Backup tab. */
  restore: { busy: boolean; pickFile: () => void };
}

export function SourceStage({ tab, onTab, fileBusy, onChooseFile, onDownload, restore }: SourceStageProps) {
  const c = useColors();
  return (
    <>
      <SegCtrl
        label="Import from"
        value={tab}
        onChange={(id) => onTab(id as SourceTab)}
        options={[
          { id: 'ankiweb', label: 'AnkiWeb' },
          { id: 'file', label: 'From a file' },
          { id: 'backup', label: 'Backup' },
        ]}
      />

      {tab === 'ankiweb' ? <AnkiWebSearch onDownload={onDownload} /> : null}

      {tab === 'file' ? (
        <View style={{ marginTop: 18 }}>
          <Pressable
            onPress={onChooseFile}
            disabled={fileBusy}
            accessibilityRole="button"
            accessibilityLabel="Choose a file"
            style={({ pressed }) => ({
              borderWidth: 1.5,
              borderStyle: 'dashed',
              borderColor: c.hairlineStrong,
              borderRadius: 16,
              paddingVertical: 34,
              paddingHorizontal: 20,
              alignItems: 'center',
              opacity: fileBusy ? 0.55 : pressed ? 0.7 : 1,
            })}
          >
            <Ion name={fileBusy ? 'hourglass-outline' : 'document-attach-outline'} size={30} color={c.ink3} />
            <Text style={[font('sans', 700), { fontSize: 15, color: c.ink, marginTop: 10, marginBottom: 4 }]}>
              {fileBusy ? 'Reading the file…' : 'Choose a file'}
            </Text>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>.apkg, .csv, .tsv or .txt</Text>
          </Pressable>
          <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 19, color: c.ink3, marginTop: 12 }]}>
            Anki decks keep every field, both directions, your progress and images. For a spreadsheet you choose
            what each column is before anything is written.
          </Text>
        </View>
      ) : null}

      {tab === 'backup' ? (
        <View style={{ marginTop: 18 }}>
          <ListRow
            icon={restore.busy ? 'hourglass-outline' : 'refresh-circle-outline'}
            title="Choose a backup file"
            sub="A backup file from Settings → Export a backup"
            last
            onPress={restore.pickFile}
          />
          <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 19, color: c.ink3, marginTop: 12 }]}>
            {RESTORE_COPY.replaces}
          </Text>
        </View>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- AnkiWeb */

function AnkiWebSearch({ onDownload }: { onDownload: (pick: AnkiWebPick) => void }) {
  const c = useColors();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<AnkiWebDeck[]>([]);
  // Starts true: a default search runs on mount, so the empty state
  // ("No shared decks match") never flashes before the results land.
  const [searching, setSearching] = useState(true);
  // The last search failed (its message), or null. Not the same as "no match".
  const [error, setError] = useState<string | null>(null);
  // +1 on "Try again": runs the same query again.
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<AnkiWebPick | null>(null);

  // Android's back on a deck's details: back to the results (registered after
  // the screen's own handler, so it is asked first).
  useEffect(() => {
    if (!detail) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setDetail(null);
      return true;
    });
    return () => sub.remove();
  }, [detail]);

  // Never setState after unmount; abort a search in flight when the stage goes away.
  const mountedRef = useRef(true);
  const searchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      searchAbortRef.current?.abort();
    };
  }, []);

  // A pasted AnkiWeb link / numeric id skips the search: a direct row.
  const ankiId = parseAnkiWebId(q.trim());

  useEffect(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    if (parseAnkiWebId(q.trim())) return;

    const query = q.trim() === '' ? DEFAULT_QUERY : q.trim();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    const handle = setTimeout(() => {
      setSearching(true);
      setError(null);
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
          setError(searchErrorText(err));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [q, attempt]);

  const retry = () => {
    setError(null);
    setSearching(true);
    setAttempt((n) => n + 1);
  };

  if (detail) return <AnkiWebDetail pick={detail} onBack={() => setDetail(null)} onDownload={onDownload} />;

  const failed = !ankiId && !searching && error !== null;
  const caption = ankiId
    ? 'From your link'
    : failed
      ? 'AnkiWeb search'
      : searching
        ? 'Searching AnkiWeb…'
        : q.trim() === ''
          ? 'Popular decks'
          : 'Search results';
  return (
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
          accessibilityLabel="Search shared decks"
          style={[font('sans', 400), { flex: 1, fontSize: 14.5, color: c.ink, padding: 0 }]}
        />
        {searching && !ankiId ? <ActivityIndicator size="small" color={c.ink3} /> : null}
      </View>
      <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 10, marginBottom: 4, marginHorizontal: 2 }]}>
        {caption}
      </Text>

      {ankiId ? (
        <Row
          onPress={() => setDetail({ id: ankiId, name: `AnkiWeb deck #${ankiId}`, deck: null })}
          padV={13}
          last
          label={`Import from AnkiWeb, deck ${ankiId}`}
          hint="Shows the deck's details. Nothing is imported yet."
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
            <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>Import from AnkiWeb</Text>
            <Text numberOfLines={1} style={[font('mono', 400), { fontSize: 12, color: c.ink3 }]}>
              {q.trim()}
            </Text>
          </View>
          <Ion name="chevron-forward" size={16} color={c.ink3} />
        </Row>
      ) : (
        <>
          {/* While a search runs, the OLD rows are not shown under the new heading:
              a tap on one would open a deck the learner did not search for. */}
          {searching ? (
            <View style={{ alignItems: 'center', paddingVertical: 28 }}>
              <ActivityIndicator color={c.pine} accessibilityLabel="Searching AnkiWeb" />
            </View>
          ) : null}

          {(searching ? [] : results).map((r, i) => (
            <Row
              key={r.id}
              onPress={() => setDetail({ id: r.id, name: r.name, deck: r })}
              padV={13}
              last={i === results.length - 1}
              label={`${r.name}, ${ankiWebMeta(r)}`}
              hint="Shows the deck's details. Nothing is imported yet."
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
                <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>
                  {r.name}
                </Text>
                <Text numberOfLines={1} style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>
                  {ankiWebMeta(r)}
                </Text>
              </View>
              <Ion name="chevron-forward" size={16} color={c.ink3} />
            </Row>
          ))}

          {failed ? (
            <View style={{ alignItems: 'center', paddingVertical: 26, paddingHorizontal: 16 }}>
              <Ion name="cloud-offline-outline" size={26} color={c.ink3} />
              <Text style={[font('serif', 600), { fontSize: 17, color: c.ink, marginTop: 8, marginBottom: 4 }]}>
                {ANKIWEB_SEARCH_FAILED.title}
              </Text>
              <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, textAlign: 'center', marginBottom: 14 }]}>
                {error}
              </Text>
              <Btn kind="secondary" icon="refresh" onPress={retry} style={{ alignSelf: 'center' }}>
                {ANKIWEB_SEARCH_FAILED.retry}
              </Btn>
            </View>
          ) : null}

          {!searching && !failed && results.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 26, paddingHorizontal: 16 }}>
              <Text style={[font('serif', 600), { fontSize: 17, color: c.ink, marginBottom: 4 }]}>No shared decks match</Text>
              <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, textAlign: 'center' }]}>
                Try another search — or paste an AnkiWeb URL / deck ID.
              </Text>
            </View>
          ) : null}

          <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 14, textAlign: 'center' }]}>
            or paste an AnkiWeb URL / deck ID above
          </Text>
        </>
      )}
    </View>
  );
}

/** The details of one AnkiWeb deck, from its listing, and "Download & preview". */
function AnkiWebDetail({
  pick,
  onBack,
  onDownload,
}: {
  pick: AnkiWebPick;
  onBack: () => void;
  onDownload: (pick: AnkiWebPick) => void;
}) {
  const c = useColors();
  const rows = ankiWebDetailRows(pick.id, pick.deck);
  return (
    <RiseIn duration={200}>
      <View style={{ marginTop: 18 }}>
        <Overline style={{ marginBottom: 10 }}>AnkiWeb — nothing imported yet</Overline>
        <CardBox>
          <Text style={[font('serif', 600), { fontSize: 20, color: c.ink, marginBottom: 12 }]}>{pick.name}</Text>
          {rows.map(([label, value], i) => (
            <View
              key={label}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                paddingVertical: 8,
                borderBottomWidth: i < rows.length - 1 ? 1 : 0,
                borderBottomColor: c.hairlineSoft,
              }}
            >
              <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2 }]}>{label}</Text>
              <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink }]}>{value}</Text>
            </View>
          ))}
        </CardBox>
        <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 19, color: c.ink3, marginVertical: 12, marginHorizontal: 2 }]}>
          We download the deck, then you choose its sections and fields and see exactly what will be added.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={onBack}>
            Back
          </Btn>
          <Btn full style={{ flex: 1 }} icon="cloud-download-outline" onPress={() => onDownload(pick)}>
            Download & preview
          </Btn>
        </View>
      </View>
    </RiseIn>
  );
}
